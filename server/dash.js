// dash.js
// The DASH analysis. Same depth as the HLS path, but a genuinely different shape:
// no variants, no per-segment list to read - segment URLs have to be *generated*
// from the addressing scheme the MPD declares.
//
// Anything the user reads as a sentence is produced in the frontend. This module
// returns codes ('timeline', 'vod', ...) and numbers, so the wording lives in one
// place instead of two.

import { MAX_TIMELINE_ENTRIES, MAX_MPD_BYTES } from './config.js';
import { InvalidMpdError } from './errors.js';
import { parseMpd } from './dashParser.js';
import { resolveUrl } from './parser.js';
import { fetchHeaders, fetchManifestRaw, measureSegmentBitrates } from './net.js';
import { computeNetworkPath, emptyDnsResult, resolveDnsAddresses } from './networkPath.js';
import { runFfprobe } from './ffmpeg.js';

/**
 * Fetches and parses an MPD. Analogous to getManifest(): throws InvalidMpdError if
 * the body doesn't parse as an MPD with at least one Period.
 */
export async function getMpd(url, { signal } = {}) {
  const { finalUrl, text } = await fetchManifestRaw(url, { signal, limitBytes: MAX_MPD_BYTES });

  const parsed = parseMpd(text, finalUrl);
  if (parsed.type !== 'dash' || !parsed.periods.length) {
    throw new InvalidMpdError(url, text.split(/\r?\n/).slice(0, 12).join('\n'));
  }
  assertTimelinesBounded(parsed, url);

  return { url, finalUrl, raw: text, parsed };
}

// MAX_MPD_BYTES bounds the input, but the *parsed* graph is what costs memory
// downstream, so it gets its own explicit ceiling. We refuse rather than truncate on
// purpose: dropping leading <S> rows would silently shift the $Number$ arithmetic in
// generateDashSegmentUrls and hand back segment URLs that look fine and point nowhere.
function assertTimelinesBounded(parsed, url) {
  for (const period of parsed.periods) {
    for (const adaptationSet of period.adaptationSets) {
      for (const representation of adaptationSet.representations) {
        const entries = representation.segmentTemplate?.timeline?.length ?? 0;
        if (entries > MAX_TIMELINE_ENTRIES) {
          throw new InvalidMpdError(
            url,
            `SegmentTimeline för representation "${representation.id}" har ${entries} <S>-poster (tak: ${MAX_TIMELINE_ENTRIES}).`
          );
        }
      }
    }
  }
}

/**
 * Picks the Representation to analyse: FIRST Period -> first AdaptationSet whose
 * contentType is 'audio' (or mimeType audio/*) -> its first audio Representation.
 * Deliberately "first", not "highest bandwidth" - mirrors the HLS path's
 * chosenVariant = variants[0] convention. Falls back to the first Representation
 * of any kind so an audio-only MPD that omits contentType still analyses.
 */
export function chooseDashAudioRepresentation(parsedMpd) {
  const period = parsedMpd.periods[0];
  if (!period) return null;

  const audioSet =
    period.adaptationSets.find((as) => as.contentType === 'audio') ||
    period.adaptationSets.find((as) => (as.mimeType || '').startsWith('audio/')) ||
    period.adaptationSets.find((as) => as.representations.some((r) => (r.mimeType || '').startsWith('audio/')));

  const set = audioSet || period.adaptationSets.find((as) => as.representations.length);
  if (!set || !set.representations.length) return null;

  // The third match above picks a set because *some* representation in it is audio,
  // which is not the same as its first representation being audio - a mixed set
  // would otherwise hand back the video track to analyse as "the audio".
  const representation =
    set.representations.find((r) => (r.mimeType || '').startsWith('audio/')) || set.representations[0];

  return { period, adaptationSet: set, representation };
}

// $Number$, $Number%05d$, $Time$, $RepresentationID$, $Bandwidth$, $$ -> literal
function substituteTemplate(template, { representationId, bandwidth, number, time } = {}) {
  if (!template) return template;
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth)(%0\d+d)?\$|\$\$/g, (match, token, fmt) => {
    if (match === '$$') return '$';
    let value;
    if (token === 'RepresentationID') value = representationId ?? '';
    else if (token === 'Bandwidth') value = bandwidth ?? '';
    else if (token === 'Number') value = number ?? '';
    else if (token === 'Time') value = time ?? '';
    else return match;
    if (fmt) return String(value).padStart(Number(fmt.slice(2, -1)), '0');
    return String(value);
  });
}

/**
 * Turns a Representation's segment addressing into concrete, fetchable URLs in
 * EXACTLY the { segments: [{ uri, duration }] } shape measureSegmentBitrates()
 * consumes, so that function is reused unchanged. Handles the three DASH
 * addressing modes:
 *   - SegmentTemplate + $Number$ (fixed duration)  -> compute the number window
 *   - SegmentTemplate + SegmentTimeline (<S t d r>) -> enumerate directly
 *   - SegmentList (<SegmentURL media>)              -> enumerate directly
 * Also returns the init segment URI and which mode was used.
 */
export function generateDashSegmentUrls(period, adaptationSet, representation, mpdInfo, count = 12) {
  const st = representation.segmentTemplate;
  const sl = representation.segmentList;
  const repId = representation.id;
  const bw = representation.bandwidth;
  let initUri = null;

  // --- SegmentTemplate + SegmentTimeline ---
  if (st && Array.isArray(st.timeline) && st.timeline.length) {
    const timescale = st.timescale || 1;
    const startNumber = st.startNumber ?? 1;

    // Pass 1: bounded arithmetic only - the running (number, time) at the start
    // of each <S> block and the grand total, without materialising any URLs.
    // r < 0 ("repeat until the next <S> or the Period end") can't be resolved
    // from the manifest alone at a live edge, so it counts as no repeat. This
    // pass never loops over `r`, so a hostile <S d="1" r="999999999"> is just
    // one addition, not a billion iterations.
    let runNumber = startNumber;
    let runTime = st.timeline[0].t ?? 0;
    let totalSegments = 0;
    const blocks = st.timeline.map((s) => {
      if (s.t != null) runTime = s.t;
      const segs = s.r != null && s.r > 0 ? s.r + 1 : 1;
      const block = { startNumber: runNumber, startTime: runTime, d: s.d, segs };
      runNumber += segs;
      runTime += (s.d || 0) * segs;
      totalSegments += segs;
      return block;
    });

    // Pass 2: materialise only the last `count` segments; skip whole blocks that
    // fall entirely before the window (so the inner loop runs <= `count` times).
    const firstWanted = Math.max(0, totalSegments - count);
    const all = [];
    let seen = 0;
    for (const b of blocks) {
      if (seen + b.segs <= firstWanted) {
        seen += b.segs;
        continue;
      }
      for (let k = Math.max(0, firstWanted - seen); k < b.segs; k++) {
        all.push({
          uri: resolveUrl(
            st.baseUrl,
            substituteTemplate(st.media, {
              representationId: repId,
              bandwidth: bw,
              number: b.startNumber + k,
              time: b.startTime + (b.d || 0) * k,
            })
          ),
          duration: b.d != null ? b.d / timescale : null,
        });
      }
      seen += b.segs;
    }
    if (st.initialization) {
      initUri = resolveUrl(st.baseUrl, substituteTemplate(st.initialization, { representationId: repId, bandwidth: bw }));
    }
    return { segments: all, initUri, mode: 'timeline' };
  }

  // --- SegmentTemplate + $Number$ with a fixed duration ---
  if (st && st.media && st.duration) {
    const timescale = st.timescale || 1;
    const segSec = st.duration / timescale;
    const startNumber = st.startNumber ?? 1;
    let firstNumber = startNumber;
    let lastNumber = startNumber + count - 1;

    if (mpdInfo.presentationType === 'dynamic' && mpdInfo.availabilityStartTime) {
      const astMs = Date.parse(mpdInfo.availabilityStartTime);
      if (!Number.isNaN(astMs)) {
        const elapsedSec = (Date.now() - astMs) / 1000 - (period.startSec || 0);
        const liveIndex = Math.floor(elapsedSec / segSec);
        lastNumber = startNumber + Math.max(0, liveIndex - 1); // newest fully-available segment
        firstNumber = Math.max(startNumber, lastNumber - count + 1);
      }
    } else {
      const totalSec = period.durationSec || mpdInfo.mediaPresentationDurationSec || null;
      if (totalSec) {
        const totalSegments = Math.ceil(totalSec / segSec);
        lastNumber = startNumber + Math.max(0, totalSegments - 1);
        firstNumber = Math.max(startNumber, lastNumber - count + 1);
      }
    }

    const all = [];
    for (let n = firstNumber; n <= lastNumber; n++) {
      all.push({
        uri: resolveUrl(st.baseUrl, substituteTemplate(st.media, { representationId: repId, bandwidth: bw, number: n })),
        duration: segSec,
      });
    }
    if (st.initialization) {
      initUri = resolveUrl(st.baseUrl, substituteTemplate(st.initialization, { representationId: repId, bandwidth: bw }));
    }
    return { segments: all, initUri, mode: 'template-number' };
  }

  // --- SegmentList ---
  if (sl && Array.isArray(sl.segmentUrls) && sl.segmentUrls.length) {
    const timescale = sl.timescale || 1;
    const segSec = sl.duration ? sl.duration / timescale : null;
    const segments = sl.segmentUrls.map((u) => ({ uri: resolveUrl(sl.baseUrl, u.media), duration: segSec }));
    if (sl.initialization) initUri = resolveUrl(sl.baseUrl, sl.initialization);
    return { segments: segments.slice(-count), initUri, mode: 'segment-list' };
  }

  // --- Single-file Representation (plain BaseURL / SegmentBase) ---
  if (representation.baseUrl) {
    return {
      segments: [{ uri: representation.baseUrl, duration: period.durationSec || mpdInfo.mediaPresentationDurationSec || null }],
      initUri: null,
      mode: 'base-url',
    };
  }

  return { segments: [], initUri: null, mode: 'none' };
}

/**
 * Analogous to computeSegmentStats(): segment length, count, window in seconds,
 * isLive (from presentationType), encrypted (from contentProtection), fMP4.
 * `segmentAddressing` is a code, not a label - see the module comment.
 */
export function computeDashSegmentStats(parsedMpd, chosen) {
  const { period, representation } = chosen;
  const st = representation.segmentTemplate;
  const sl = representation.segmentList;

  let segmentDurationSec = null;
  let segmentCount = null;
  let windowSeconds = null;
  let addressing = 'unknown';

  if (st && Array.isArray(st.timeline) && st.timeline.length) {
    addressing = 'timeline';
    const timescale = st.timescale || 1;
    let total = 0;
    let cnt = 0;
    for (const s of st.timeline) {
      const times = (s.r != null && s.r > 0 ? s.r : 0) + 1;
      if (s.d != null) total += (s.d / timescale) * times;
      cnt += times;
    }
    windowSeconds = total || null;
    segmentCount = cnt || null;
    segmentDurationSec = cnt ? total / cnt : null;
  } else if (st && st.duration) {
    addressing = 'template-number';
    segmentDurationSec = st.duration / (st.timescale || 1);
    if (parsedMpd.presentationType === 'static') {
      windowSeconds = period.durationSec || parsedMpd.mediaPresentationDurationSec || null;
      segmentCount = windowSeconds ? Math.ceil(windowSeconds / segmentDurationSec) : null;
    } else {
      windowSeconds = parsedMpd.timeShiftBufferDepthSec || null;
      segmentCount = windowSeconds ? Math.round(windowSeconds / segmentDurationSec) : null;
    }
  } else if (sl && Array.isArray(sl.segmentUrls) && sl.segmentUrls.length) {
    addressing = 'segment-list';
    segmentCount = sl.segmentUrls.length;
    segmentDurationSec = sl.duration ? sl.duration / (sl.timescale || 1) : null;
    windowSeconds = segmentDurationSec ? segmentDurationSec * segmentCount : null;
  } else if (representation.baseUrl) {
    addressing = 'base-url';
    windowSeconds = period.durationSec || parsedMpd.mediaPresentationDurationSec || null;
    segmentCount = 1;
  }

  const hasInit = Boolean(st?.initialization || sl?.initialization);

  return {
    presentationType: parsedMpd.presentationType,
    isLive: parsedMpd.presentationType === 'dynamic',
    segmentAddressing: addressing,
    segmentDurationSec,
    segmentCount,
    windowSeconds,
    minBufferTimeSec: parsedMpd.minBufferTimeSec,
    timeShiftBufferDepthSec: parsedMpd.timeShiftBufferDepthSec,
    minimumUpdatePeriodSec: parsedMpd.minimumUpdatePeriodSec,
    suggestedPresentationDelaySec: parsedMpd.suggestedPresentationDelaySec,
    mediaPresentationDurationSec: parsedMpd.mediaPresentationDurationSec,
    encrypted: representation.contentProtection.length > 0,
    contentProtection: representation.contentProtection,
    fmp4: hasInit,
    initUri: null, // filled in by analyzeDash from generateDashSegmentUrls
    periodCount: parsedMpd.periodCount,
    periodId: period.id,
    periodIndex: period.index,
  };
}

/**
 * Analogous to computeLatency(). For a dynamic MPD: availabilityStartTime +
 * period start vs. the wall clock, plus the manifest's own age (publishTime).
 * For a static (VOD) MPD -> { available: false } with a reason code.
 */
export function computeDashLatency(parsedMpd, chosen) {
  if (parsedMpd.presentationType !== 'dynamic') {
    return { available: false, reason: 'vod' };
  }
  const astMs = parsedMpd.availabilityStartTime ? Date.parse(parsedMpd.availabilityStartTime) : NaN;
  if (Number.isNaN(astMs)) {
    return { available: false, reason: 'no-availability-start-time' };
  }

  const { period, representation } = chosen;
  const st = representation.segmentTemplate;
  const nowSec = Date.now() / 1000;
  const periodStartSec = period.startSec || 0;

  let segDurationSec = null;
  if (st && Array.isArray(st.timeline) && st.timeline.length) {
    const last = st.timeline[st.timeline.length - 1];
    if (last.d != null) segDurationSec = last.d / (st.timescale || 1);
  } else if (st && st.duration) {
    segDurationSec = st.duration / (st.timescale || 1);
  }

  const result = {
    available: true,
    method: parsedMpd.suggestedPresentationDelaySec != null ? 'declared' : 'estimated',
    availabilityStartTime: parsedMpd.availabilityStartTime,
    publishTime: parsedMpd.publishTime || null,
    periodStartSec,
    segmentDurationSec: segDurationSec,
    suggestedPresentationDelaySec: parsedMpd.suggestedPresentationDelaySec,
    minBufferTimeSec: parsedMpd.minBufferTimeSec,
    timeShiftBufferDepthSec: parsedMpd.timeShiftBufferDepthSec,
    minimumUpdatePeriodSec: parsedMpd.minimumUpdatePeriodSec,
    manifestAgeSec: null,
    epochAnchored: astMs < Date.parse('2000-01-01T00:00:00Z'),
  };

  // Rough target latency a player would sit at: the declared
  // suggestedPresentationDelay if present, otherwise ~3 segments of buffer.
  result.estimatedLiveDelaySec =
    parsedMpd.suggestedPresentationDelaySec ?? (segDurationSec ? segDurationSec * 3 : parsedMpd.minBufferTimeSec);

  // Manifest age = now - publishTime, but only when it lands in a plausible
  // range. Simulated-live sources (dashif livesim, etc.) anchor publishTime to
  // the epoch, which would otherwise read as a 50-year-old manifest.
  if (parsedMpd.publishTime) {
    const ptMs = Date.parse(parsedMpd.publishTime);
    if (!Number.isNaN(ptMs)) {
      const ageSec = nowSec - ptMs / 1000;
      if (ageSec >= -60 && ageSec < 86400) result.manifestAgeSec = ageSec;
    }
  }
  return result;
}

// Flat Representation list for the "Representations" card - every Representation
// in the analysed Period, with the chosen one flagged. The two caveats are returned
// as data; the frontend turns them into sentences.
function buildDashRepresentationList(parsedMpd, chosen) {
  const { period } = chosen;
  const list = [];
  for (const as of period.adaptationSets) {
    for (const r of as.representations) {
      list.push({
        id: r.id,
        adaptationSetId: as.id,
        contentType: as.contentType,
        mimeType: r.mimeType || as.mimeType,
        lang: as.lang,
        bandwidthKbps: r.bandwidth ? r.bandwidth / 1000 : null,
        codecs: r.codecs,
        audioSamplingRate: r.audioSamplingRate,
        width: r.width,
        height: r.height,
        chosen: r === chosen.representation,
      });
    }
  }
  return {
    list,
    chosenId: chosen.representation.id,
    periodCount: parsedMpd.periodCount,
    periodId: period.id,
    periodIndex: period.index,
    // Only the first Period is analysed, and remote (xlink) Periods are out of
    // scope - both are surfaced in the UI rather than hidden.
    multiPeriod: parsedMpd.periodCount > 1,
    hasXlink: Boolean(period.hasXlink),
  };
}

/**
 * Combined DASH analysis. Reuses fetchHeaders, measureSegmentBitrates, runFfprobe,
 * computeNetworkPath and resolveDnsAddresses unchanged; each fallible step in its
 * own isolated try/catch so one failure degrades to a warning, same as analyzeHls().
 */
export async function analyzeDash(url, { signal, connection: prefetched } = {}) {
  const errors = {};

  // See analyzeHls(): the sniff already paid for this round-trip.
  const connection = prefetched || (await fetchHeaders(url, { signal }));

  const mpd = await getMpd(url, { signal }); // fatal on an invalid MPD, like getManifest() for HLS

  const chosen = chooseDashAudioRepresentation(mpd.parsed);
  if (!chosen) {
    throw new InvalidMpdError(url, 'MPD:ns första Period innehåller ingen Representation att analysera.');
  }

  const segments = computeDashSegmentStats(mpd.parsed, chosen);
  const latency = computeDashLatency(mpd.parsed, chosen);

  const generated = generateDashSegmentUrls(chosen.period, chosen.adaptationSet, chosen.representation, mpd.parsed, 12);
  segments.initUri = generated.initUri;
  segments.generatedSegmentMode = generated.mode;

  let bitrate = { samples: [], averageMeasuredBitrateKbps: null };
  try {
    bitrate = await measureSegmentBitrates(generated, 12, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.bitrate = { message: err.message, code: err.code || 'UNKNOWN' };
  }
  bitrate.declaredBandwidthKbps = chosen.representation.bandwidth ? chosen.representation.bandwidth / 1000 : null;

  let audio = null;
  try {
    const probe = await runFfprobe(mpd.finalUrl, { signal });
    audio = probe.audio;
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.ffprobe = { message: err.message, code: err.code || 'UNKNOWN', details: err.details };
  }

  const networkPath = computeNetworkPath(connection.allHeaders);
  try {
    networkPath.dns = await resolveDnsAddresses(new URL(mpd.finalUrl).hostname);
  } catch (err) {
    networkPath.dns = emptyDnsResult(err.message);
  }

  return {
    streamKind: 'dash',
    requestedUrl: url,
    sampleUrl: mpd.finalUrl,
    connection,
    representations: buildDashRepresentationList(mpd.parsed, chosen),
    audio,
    segments,
    latency,
    bitrate,
    networkPath,
    manifests: {
      mpd: { url: mpd.finalUrl, raw: mpd.raw },
    },
    errors,
  };
}
