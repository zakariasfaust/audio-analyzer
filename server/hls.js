// hls.js
// The HLS analysis: fetching a manifest, following a master playlist down to a media
// playlist, and turning the parsed tags into the numbers the frontend shows.
//
// Everything below computeX() is a pure function of already-parsed data - no network,
// no clock except where latency genuinely needs one - which is what makes them
// testable without a stream.

import { parseM3U8 } from './parser.js';
import { InvalidManifestError } from './errors.js';
import { fetchHeaders, fetchManifestRaw, measureSegmentBitrates } from './net.js';
import { computeNetworkPath, emptyDnsResult, resolveDnsAddresses } from './networkPath.js';
import { runFfprobe } from './ffmpeg.js';

/**
 * Fetches and parses a manifest (master OR media - determined by parser.js).
 */
export async function getManifest(url, { signal } = {}) {
  const { finalUrl, text } = await fetchManifestRaw(url, { signal });

  if (!text.trim().startsWith('#EXTM3U')) {
    throw new InvalidManifestError(url, text.split(/\r?\n/).slice(0, 10).join('\n'));
  }

  const parsed = parseM3U8(text, finalUrl);
  if (parsed.type === 'unknown') {
    throw new InvalidManifestError(url, text.split(/\r?\n/).slice(0, 10).join('\n'));
  }

  return { url, finalUrl, raw: text, parsed };
}

/**
 * Follows any master playlist down to a concrete media playlist (with segments).
 * Radio streams often lack the master layer entirely - in that case media is returned directly.
 */
export async function resolveMediaPlaylist(url, { signal } = {}) {
  const manifest = await getManifest(url, { signal });

  if (manifest.parsed.type === 'media') {
    return { master: null, media: manifest, chosenVariant: null };
  }

  // type === 'master'
  const { variants } = manifest.parsed;
  if (!variants.length) {
    throw new InvalidManifestError(url, 'Master-playlist utan några #EXT-X-STREAM-INF-varianter.');
  }
  const chosenVariant = variants[0];
  if (!chosenVariant.url) {
    throw new InvalidManifestError(url, 'Kunde inte hitta någon variant-URL i master-playlistan.');
  }

  const media = await getManifest(chosenVariant.url, { signal });
  if (media.parsed.type !== 'media') {
    throw new InvalidManifestError(chosenVariant.url, 'Variant-URL:en pekade inte på en media-playlist.');
  }

  return { master: manifest, media, chosenVariant };
}

// ---------------------------------------------------------------------------
// Segments, buffer and latency
// ---------------------------------------------------------------------------

export function computeSegmentStats(mediaParsed) {
  const segments = mediaParsed.segments || [];
  const durations = segments.map((s) => s.duration || 0);
  const windowSeconds = durations.reduce((a, b) => a + b, 0);

  return {
    version: mediaParsed.version,
    targetDuration: mediaParsed.targetDuration,
    mediaSequence: mediaParsed.mediaSequence,
    playlistType: mediaParsed.playlistType,
    isLive: !mediaParsed.endlist,
    segmentCount: segments.length,
    windowSeconds,
    avgSegmentDuration: segments.length ? windowSeconds / segments.length : null,
    encrypted: Boolean(mediaParsed.key),
    keyMethod: mediaParsed.key?.method || null,
    keyUri: mediaParsed.key?.uri || null,
    fmp4: Boolean(mediaParsed.map),
    mapUri: mediaParsed.map?.uri || null,
  };
}

/**
 * Gathers everything LL-HLS-specific (EXT-X-SERVER-CONTROL, EXT-X-PART-INF,
 * EXT-X-PART, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT) into its own structure
 * for a clearly separated "Low-Latency HLS" subsection. Flags the contradiction
 * if the CDN signals LL-HLS support in headers (Akamai's x-llhls-blocked) but
 * the manifest itself lacks all LL-HLS tags.
 */
export function computeLowLatencyInfo(mediaParsed, connectionHeaders = {}) {
  const segments = mediaParsed.segments || [];
  const lastSegmentParts = segments.length ? segments[segments.length - 1].parts || [] : [];
  const trailingParts = mediaParsed.trailingParts || [];
  const renditionReports = mediaParsed.renditionReports || [];

  const present = Boolean(
    mediaParsed.serverControl ||
    mediaParsed.partTargetDuration ||
    lastSegmentParts.length ||
    trailingParts.length ||
    mediaParsed.preloadHint ||
    renditionReports.length
  );

  const llhlsBlockedHeader = connectionHeaders['x-llhls-blocked'];
  const contradiction =
    !present && llhlsBlockedHeader !== undefined && String(llhlsBlockedHeader).toLowerCase() === 'false';

  return {
    present,
    serverControl: mediaParsed.serverControl || null,
    partTargetDuration: mediaParsed.partTargetDuration || null,
    lastSegmentParts,
    trailingParts,
    preloadHint: mediaParsed.preloadHint || null,
    renditionReports,
    contradiction: contradiction ? { header: 'x-llhls-blocked', value: llhlsBlockedHeader } : null,
  };
}

/**
 * Gathers EXT-X-DISCONTINUITY-SEQUENCE, where in the window EXT-X-DISCONTINUITY
 * actually occurs (as absolute media sequence numbers, not just an index into the
 * list), and EXT-X-START. The wording for EXT-X-START lives in the frontend - this
 * returns the sign and magnitude and lets the UI phrase it.
 */
export function computeContinuityInfo(mediaParsed) {
  const segments = mediaParsed.segments || [];
  const baseSequence = mediaParsed.mediaSequence ?? 0;

  const discontinuityPositions = [];
  segments.forEach((seg, index) => {
    if (seg.discontinuity) discontinuityPositions.push(baseSequence + index);
  });

  return {
    discontinuitySequence: mediaParsed.discontinuitySequence,
    discontinuityCount: discontinuityPositions.length,
    discontinuityPositions,
    startInfo: mediaParsed.startInfo || null,
  };
}

/**
 * Calculates latency from PROGRAM-DATE-TIME tags. Older HLS (e.g. version 3)
 * often sets the tag only once, on the first segment in the window, not
 * on every segment. Comparing that same timestamp against the wall clock as if
 * it belonged to the newest segment would then give a badly underestimated delay.
 *
 * We find all segments that actually have their own timestamp ("anchor").
 * If there are two or more anchors we trust them directly (as most
 * modern packagers do - each segment has its own PROGRAM-DATE-TIME).
 * If there's only ONE anchor, we extrapolate the timestamp for the first and
 * last segment by adding/subtracting the EXTINF durations between
 * the anchor and the respective segment - and flag the result as calculated,
 * not measured, so the user knows the number is less certain.
 */
export function computeLatency(mediaParsed) {
  const segments = mediaParsed.segments || [];
  const anchors = [];
  segments.forEach((seg, index) => {
    if (!seg.programDateTime) return;
    const t = new Date(seg.programDateTime).getTime();
    if (!Number.isNaN(t)) anchors.push({ index, time: t });
  });

  if (!anchors.length) {
    return { available: false };
  }

  // Sums EXTINF durations (in ms) between two segment indices - positive sum
  // going forward in the list, negative going backward, so it can be added directly to the anchor's time.
  function msBetween(fromIndex, toIndex) {
    let sum = 0;
    if (toIndex > fromIndex) {
      for (let i = fromIndex; i < toIndex; i++) sum += (segments[i].duration || 0) * 1000;
    } else {
      for (let i = toIndex; i < fromIndex; i++) sum -= (segments[i].duration || 0) * 1000;
    }
    return sum;
  }

  let method;
  let oldestTime;
  let newestTime;

  if (anchors.length >= 2) {
    method = 'measured';
    oldestTime = anchors[0].time;
    newestTime = anchors[anchors.length - 1].time;
  } else {
    method = 'estimated';
    const anchor = anchors[0];
    oldestTime = anchor.time + msBetween(anchor.index, 0);
    newestTime = anchor.time + msBetween(anchor.index, segments.length - 1);
  }

  const now = Date.now();

  return {
    available: true,
    method,
    taggedSegmentCount: anchors.length,
    // "Tagged", not "oldest segment": with two or more anchors these are the first
    // and last segment that carry their own PROGRAM-DATE-TIME, which is only the
    // first and last segment of the window when every segment is tagged.
    allSegmentsTagged: anchors.length === segments.length,
    oldestProgramDateTime: new Date(oldestTime).toISOString(),
    newestProgramDateTime: new Date(newestTime).toISOString(),
    delaySecondsFromOldest: (now - oldestTime) / 1000,
    delaySecondsFromNewest: (now - newestTime) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Combined analysis
// ---------------------------------------------------------------------------

export async function analyzeHls(url, { signal, connection: prefetched } = {}) {
  const errors = {};

  // analyze() already fetched this URL once to sniff its kind; reuse that response
  // rather than opening an identical second connection.
  const connection = prefetched || (await fetchHeaders(url, { signal }));

  const { master, media, chosenVariant } = await resolveMediaPlaylist(url, { signal });

  const segments = computeSegmentStats(media.parsed);
  const latency = computeLatency(media.parsed);
  const lowLatency = computeLowLatencyInfo(media.parsed, connection.allHeaders);
  const continuity = computeContinuityInfo(media.parsed);

  let bitrate = { samples: [], averageMeasuredBitrateKbps: null };
  try {
    bitrate = await measureSegmentBitrates(media.parsed, 12, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.bitrate = { message: err.message, code: err.code || 'UNKNOWN' };
  }
  bitrate.declaredBandwidthKbps = chosenVariant?.bandwidth ? chosenVariant.bandwidth / 1000 : null;

  let audio = null;
  try {
    const probe = await runFfprobe(media.finalUrl, { signal });
    audio = probe.audio;
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.ffprobe = { message: err.message, code: err.code || 'UNKNOWN', details: err.details };
  }

  const networkPath = computeNetworkPath(connection.allHeaders);
  try {
    networkPath.dns = await resolveDnsAddresses(new URL(media.finalUrl).hostname);
  } catch (err) {
    networkPath.dns = emptyDnsResult(err.message);
  }

  const variants = master?.parsed.variants || [];
  const chosenVariantUrl = chosenVariant?.url || media.finalUrl;

  return {
    streamKind: 'hls',
    requestedUrl: url,
    sampleUrl: chosenVariantUrl,
    connection,
    variants: {
      hasMasterPlaylist: Boolean(master),
      list: variants,
      singleVariantNote: !master || variants.length <= 1,
      chosenVariantUrl,
    },
    audio,
    segments,
    lowLatency,
    continuity,
    latency,
    bitrate,
    networkPath,
    manifests: {
      master: master ? { url: master.finalUrl, raw: master.raw } : null,
      media: { url: media.finalUrl, raw: media.raw },
    },
    errors,
  };
}
