// dashParser.js
// Parses an MPD (DASH manifest) into JavaScript objects.
//
// Unlike M3U8 (line-based, parsed by hand in parser.js), MPD is real nested
// XML - namespaces, attributes, self-closing tags, SegmentTimeline repeat
// counters - so this module leans on fast-xml-parser rather than regex.
// The output is its OWN normalised shape; it deliberately does not reuse the
// HLS {variants, segments} form because the structure is genuinely different.

import { XMLParser } from 'fast-xml-parser';

// Tags that must always be arrays even when the manifest has exactly one of
// them - otherwise "one Period" and "many Periods" would need different code.
const ALWAYS_ARRAY = new Set([
  'Period',
  'AdaptationSet',
  'Representation',
  'ContentProtection',
  'Role',
  'S',
  'SegmentURL',
  'BaseURL',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: false, // keep BaseURL text etc. as verbatim strings
  parseAttributeValue: false, // we coerce numbers ourselves via numAttr()
  trimValues: true,
  removeNSPrefix: true, // <dash:MPD>, xsi:*, xlink:* -> bare names
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

// ---------------------------------------------------------------------------
// Small helpers for reading the parser's {"@_attr": ..., "#text": ...} shape
// ---------------------------------------------------------------------------

function attr(node, name) {
  const v = node && node[`@_${name}`];
  return v == null || v === '' ? null : String(v);
}

function numAttr(node, name) {
  const v = node && node[`@_${name}`];
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(x) {
  if (x == null) return null;
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'number') return String(x);
  if (typeof x === 'object' && x['#text'] != null) return String(x['#text']).trim();
  return null;
}

function firstBaseUrl(node) {
  if (!node || node.BaseURL == null) return null;
  const first = Array.isArray(node.BaseURL) ? node.BaseURL[0] : node.BaseURL;
  return textOf(first);
}

// BaseURL compounds down the MPD -> Period -> AdaptationSet -> Representation
// chain; each level's (possibly relative) BaseURL is resolved against the one
// above it.
function resolveBase(parentBase, childBase) {
  if (!childBase) return parentBase;
  try {
    return new URL(childBase, parentBase).toString();
  } catch {
    return parentBase;
  }
}

function inferContentType(mimeType) {
  if (!mimeType) return null;
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/') || mimeType.startsWith('application/ttml')) return 'text';
  return null;
}

// Fallback when neither contentType nor mimeType is present at any level
// (some packagers only put mimeType on the Representation, or omit it entirely
// and leave just the codec string).
function inferContentTypeFromCodecs(codecs) {
  if (!codecs) return null;
  const c = codecs.toLowerCase();
  if (/^(mp4a|ac-3|ec-3|ac-4|opus|vorbis|flac|dtsc|dtse|alac|speex)/.test(c)) return 'audio';
  if (/^(avc[13]|hev1|hvc1|vp0?[89]|av01|dvh)/.test(c)) return 'video';
  if (/^(wvtt|stpp|ttml)/.test(c)) return 'text';
  return null;
}

// ---------------------------------------------------------------------------
// ISO 8601 duration ("PT1H30M15.5S", "P1DT2H", "PT0S") -> seconds, or null.
// Shared helper - MPD expresses every duration/offset this way.
// ---------------------------------------------------------------------------

export function parseIsoDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const m = /^(-)?P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
    str.trim()
  );
  if (!m) return null;
  const [, sign, years, months, weeks, days, hours, minutes, seconds] = m;
  if ([years, months, weeks, days, hours, minutes, seconds].every((v) => v === undefined)) {
    return null; // bare "P" / "PT" - not a real duration
  }
  // Years/months are calendar-ambiguous; MPD almost never uses them, and an
  // approximation is fine for the display this feeds.
  const total =
    (Number(years) || 0) * 365.25 * 86400 +
    (Number(months) || 0) * 30 * 86400 +
    (Number(weeks) || 0) * 7 * 86400 +
    (Number(days) || 0) * 86400 +
    (Number(hours) || 0) * 3600 +
    (Number(minutes) || 0) * 60 +
    (Number(seconds) || 0);
  if (!Number.isFinite(total)) return null;
  return sign ? -total : total;
}

// ---------------------------------------------------------------------------
// Per-level parsing
// ---------------------------------------------------------------------------

function parseSegmentTemplate(node, repBaseUrl) {
  if (!node) return null;
  const timelineNode = node.SegmentTimeline;
  const timeline = timelineNode
    ? asArray(timelineNode.S).map((s) => ({
        t: numAttr(s, 't'),
        d: numAttr(s, 'd'),
        r: numAttr(s, 'r') ?? 0,
      }))
    : null;
  return {
    timescale: numAttr(node, 'timescale') ?? 1,
    duration: numAttr(node, 'duration'),
    startNumber: numAttr(node, 'startNumber') ?? 1,
    presentationTimeOffset: numAttr(node, 'presentationTimeOffset') ?? 0,
    media: attr(node, 'media'),
    initialization: attr(node, 'initialization'),
    timeline,
    baseUrl: repBaseUrl,
  };
}

function parseSegmentList(node, repBaseUrl) {
  if (!node) return null;
  const init = node.Initialization ? attr(node.Initialization, 'sourceURL') : null;
  return {
    timescale: numAttr(node, 'timescale') ?? 1,
    duration: numAttr(node, 'duration'),
    initialization: init,
    segmentUrls: asArray(node.SegmentURL).map((u) => ({
      media: attr(u, 'media'),
      mediaRange: attr(u, 'mediaRange'),
    })),
    baseUrl: repBaseUrl,
  };
}

function parseContentProtection(nodes) {
  return asArray(nodes).map((cp) => ({
    schemeIdUri: attr(cp, 'schemeIdUri'),
    value: attr(cp, 'value'),
  }));
}

function parseRepresentation(r, adaptationSet, period, parentBaseUrl) {
  const repBaseUrl = resolveBase(parentBaseUrl, firstBaseUrl(r));

  // SegmentTemplate / SegmentList can sit on the Representation, or be inherited
  // from the AdaptationSet or Period. URL substitution always resolves against
  // the Representation's own effective BaseURL.
  const templateNode = r.SegmentTemplate || adaptationSet.SegmentTemplate || period.SegmentTemplate || null;
  const listNode = r.SegmentList || adaptationSet.SegmentList || period.SegmentList || null;

  return {
    id: attr(r, 'id'),
    bandwidth: numAttr(r, 'bandwidth'),
    codecs: attr(r, 'codecs') || attr(adaptationSet, 'codecs'),
    audioSamplingRate: numAttr(r, 'audioSamplingRate') ?? numAttr(adaptationSet, 'audioSamplingRate'),
    width: numAttr(r, 'width') ?? numAttr(adaptationSet, 'width'),
    height: numAttr(r, 'height') ?? numAttr(adaptationSet, 'height'),
    mimeType: attr(r, 'mimeType') || attr(adaptationSet, 'mimeType'),
    baseUrl: repBaseUrl,
    segmentTemplate: parseSegmentTemplate(templateNode, repBaseUrl),
    segmentList: parseSegmentList(listNode, repBaseUrl),
    contentProtection: parseContentProtection([
      ...asArray(adaptationSet.ContentProtection),
      ...asArray(r.ContentProtection),
    ]),
  };
}

function parseAdaptationSet(as, index, period, parentBaseUrl) {
  const asBaseUrl = resolveBase(parentBaseUrl, firstBaseUrl(as));
  const mimeType = attr(as, 'mimeType');
  const representations = asArray(as.Representation).map((r) => parseRepresentation(r, as, period, asBaseUrl));
  const first = representations[0];

  return {
    id: attr(as, 'id') ?? String(index),
    // contentType can be declared, or inferred from mimeType at either level,
    // or last-resort from the codec string.
    contentType:
      attr(as, 'contentType') ||
      inferContentType(mimeType) ||
      inferContentType(first?.mimeType) ||
      inferContentTypeFromCodecs(first?.codecs),
    mimeType: mimeType || first?.mimeType || null,
    lang: attr(as, 'lang'),
    roles: asArray(as.Role)
      .map((role) => attr(role, 'value'))
      .filter(Boolean),
    representations,
  };
}

function parsePeriod(p, index, parentBaseUrl) {
  const periodBaseUrl = resolveBase(parentBaseUrl, firstBaseUrl(p));
  return {
    id: attr(p, 'id') ?? String(index),
    index,
    startSec: parseIsoDuration(attr(p, 'start')),
    durationSec: parseIsoDuration(attr(p, 'duration')),
    hasXlink: Boolean(attr(p, 'href')), // remote/xlink Period - out of scope for v1
    adaptationSets: asArray(p.AdaptationSet).map((as, i) => parseAdaptationSet(as, i, p, periodBaseUrl)),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses MPD text into a normalised structure. Returns { type: 'unknown' }
 * (never throws) when the text does not parse as an MPD - the caller decides
 * whether that is fatal.
 */
export function parseMpd(xmlText, baseUrl) {
  let doc;
  try {
    doc = parser.parse(xmlText);
  } catch (err) {
    return { type: 'unknown', error: err.message };
  }

  const mpd = doc && doc.MPD;
  if (!mpd || typeof mpd !== 'object') {
    return { type: 'unknown' };
  }

  const mpdBaseUrl = resolveBase(baseUrl, firstBaseUrl(mpd));
  const periods = asArray(mpd.Period).map((p, i) => parsePeriod(p, i, mpdBaseUrl));

  return {
    type: 'dash',
    presentationType: attr(mpd, 'type') === 'dynamic' ? 'dynamic' : 'static',
    profiles: attr(mpd, 'profiles'),
    mediaPresentationDurationSec: parseIsoDuration(attr(mpd, 'mediaPresentationDuration')),
    minBufferTimeSec: parseIsoDuration(attr(mpd, 'minBufferTime')),
    minimumUpdatePeriodSec: parseIsoDuration(attr(mpd, 'minimumUpdatePeriod')),
    suggestedPresentationDelaySec: parseIsoDuration(attr(mpd, 'suggestedPresentationDelay')),
    timeShiftBufferDepthSec: parseIsoDuration(attr(mpd, 'timeShiftBufferDepth')),
    maxSegmentDurationSec: parseIsoDuration(attr(mpd, 'maxSegmentDuration')),
    availabilityStartTime: attr(mpd, 'availabilityStartTime'),
    publishTime: attr(mpd, 'publishTime'),
    periodCount: periods.length,
    periods,
  };
}
