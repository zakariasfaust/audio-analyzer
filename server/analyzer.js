// analyzer.js
// All logic for fetching, parsing and measuring an HLS stream:
// HTTP requests to the CDN, running ffprobe/ffmpeg as child processes,
// and assembling the data the frontend displays per card.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import geoip from 'geoip-lite';
import ipaddr from 'ipaddr.js';
import { Agent, buildConnector } from 'undici';
import { parseM3U8, resolveUrl } from './parser.js';
import { parseMpd } from './dashParser.js';

const dnsLookupAsync = promisify(dnsLookup);

export const TIMEOUT_MS = 10_000;
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Audio-Analyzer/1.0';

// ---------------------------------------------------------------------------
// Error classes - each carries enough information for index.js to be able
// to respond with a clear error message without having to guess.
// ---------------------------------------------------------------------------

export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class TimeoutError extends AppError {
  constructor(url) {
    super('TIMEOUT', `Timeout - servern svarade inte inom ${TIMEOUT_MS / 1000} sekunder.`, { url });
  }
}

export class UpstreamHttpError extends AppError {
  constructor(url, status, statusText, bodySnippet) {
    const geoblockGuess = status === 403 && (!bodySnippet || bodySnippet.trim() === '');
    super('UPSTREAM_HTTP_ERROR', `Servern svarade ${status} ${statusText}.`, {
      url,
      status,
      statusText,
      bodySnippet,
      geoblockGuess,
    });
  }
}

export class InvalidManifestError extends AppError {
  constructor(url, preview) {
    super('INVALID_MANIFEST', 'Svaret ser inte ut som en giltig M3U8-fil (saknar #EXTM3U).', {
      url,
      preview,
    });
  }
}

export class InvalidMpdError extends AppError {
  constructor(url, preview) {
    super('INVALID_MPD', 'Svaret ser inte ut som ett giltigt MPD-manifest (DASH).', {
      url,
      preview,
    });
  }
}

// A real M3U8/MPD is at most a few MB. Anything past this is a mistake or an
// attack (a URL pointing at a large file), and an unbounded response.text()
// on it is a memory-exhaustion vector - so we refuse it instead.
export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export class ManifestTooLargeError extends AppError {
  constructor(url) {
    super(
      'MANIFEST_TOO_LARGE',
      `Svaret är större än ${Math.round(MAX_MANIFEST_BYTES / 1024 / 1024)} MB - det är inte ett rimligt manifest och hämtas inte.`,
      { url, limitBytes: MAX_MANIFEST_BYTES }
    );
  }
}

export class RequestAbortedError extends AppError {
  constructor(message = 'Begäran avbröts.') {
    super('REQUEST_ABORTED', message, {});
  }
}

export class BinaryMissingError extends AppError {
  constructor(binary) {
    const mac = `brew install ffmpeg`;
    const linux = `sudo apt install ffmpeg   (eller: sudo dnf install ffmpeg)`;
    super('BINARY_MISSING', `Hittar inte "${binary}" i PATH. Är ffmpeg installerat?`, {
      binary,
      installHelp: { macOS: mac, linux },
    });
  }
}

export class FfprobeError extends AppError {
  constructor(stderr) {
    super('FFPROBE_FAILED', 'ffprobe kunde inte analysera strömmen.', { stderr: stderr?.slice(0, 2000) });
  }
}

export class FfmpegError extends AppError {
  constructor(stderr) {
    super('FFMPEG_FAILED', 'ffmpeg kunde inte spela in strömmen.', { stderr: stderr?.slice(0, 2000) });
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super('VALIDATION_ERROR', message, {});
  }
}

export class HostBlockedError extends AppError {
  constructor(hostname) {
    super('HOST_BLOCKED', `"${hostname}" pekar mot ett internt/privat nätverk och kan inte analyseras.`, {
      hostname,
    });
  }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export function validateUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new ValidationError('Parametern "url" saknas.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`"${raw}" är inte en giltig URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Endast http- och https-URL:er stöds.');
  }
  return parsed.toString();
}

// Non-public IP ranges we refuse to connect to now that this server can be
// reached from the internet - blocks the obvious SSRF targets (loopback,
// RFC1918/link-local, the private *.railway.internal-style network of whatever
// host runs this, cloud metadata endpoints like 169.254.169.254).
//
// assertPublicHost() below is the up-front name/IP check. For fetch()-based
// traffic it is backed by ssrfSafeAgent, which re-validates the real remote IP
// of every connection - including each redirect hop - the instant the socket
// opens. That catches what the up-front check cannot see on its own: a bare-IP
// URL, a redirect into a private range, and DNS rebinding after the name check.
// ffprobe/ffmpeg resolve and connect on their own, outside Node, so for those
// two the up-front check is the only layer.
const PUBLIC_IP_RANGES = new Set(['unicast']);

function isPublicAddress(ip) {
  let range;
  try {
    range = ipaddr.process(ip).range();
  } catch {
    return false;
  }
  return PUBLIC_IP_RANGES.has(range);
}

export async function assertPublicHost(urlString) {
  const { hostname } = new URL(urlString);
  const lowerHost = hostname.toLowerCase();

  if (lowerHost === 'localhost' || lowerHost.endsWith('.railway.internal')) {
    throw new HostBlockedError(hostname);
  }

  let addresses;
  try {
    addresses = await dnsLookupAsync(hostname, { all: true });
  } catch {
    return; // DNS failure isn't an SSRF case - let the caller's own fetch/spawn fail naturally.
  }

  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new HostBlockedError(hostname);
    }
  }
}

// undici dispatcher used for every fetch() below. Its connector runs the base
// TCP/TLS connect, then checks the socket's actual remote IP before handing the
// connection back - so a redirect hop or a rebound DNS name that lands on a
// private address is dropped before a single request byte is written.
const baseConnector = buildConnector({});
const ssrfSafeAgent = new Agent({
  connect(opts, callback) {
    baseConnector(opts, (err, socket) => {
      if (err) {
        callback(err);
        return;
      }
      if (!isPublicAddress(socket.remoteAddress)) {
        socket.destroy();
        callback(new HostBlockedError(opts.hostname || socket.remoteAddress));
        return;
      }
      callback(null, socket);
    });
  },
});

// ---------------------------------------------------------------------------
// HTTP fetching with timeout and a realistic User-Agent
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const { signal: externalSignal, ...rest } = options;
  externalSignal?.throwIfAborted?.();
  await assertPublicHost(url);

  // AbortSignal.timeout fires TIMEOUT_MS after this call and stays live for the
  // whole lifetime of the returned body stream - so a slow-drip body read is
  // now bounded too, not just the initial response. Combined with the caller's
  // request-scoped signal (client disconnect / hard deadline) when present.
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;

  try {
    return await fetch(url, {
      redirect: 'follow',
      dispatcher: ssrfSafeAgent,
      ...rest,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...rest.headers,
      },
      signal,
    });
  } catch (err) {
    // fetch() rejects with the abort *reason* itself. A request-scoped abort
    // carries our AppError (REQUEST_ABORTED / REQUEST_TIMEOUT) - pass it through.
    if (err instanceof AppError) throw err;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') throw new TimeoutError(url);
    // undici wraps a connector rejection as TypeError('fetch failed', { cause }).
    // Surface our own HostBlockedError (from ssrfSafeAgent rejecting a redirect
    // hop into a private range) rather than the opaque wrapper.
    if (err?.cause instanceof AppError) throw err.cause;
    throw err;
  }
}

function headersToObject(headers) {
  const obj = {};
  for (const [key, value] of headers.entries()) {
    obj[key.toLowerCase()] = value;
  }
  return obj;
}

/**
 * Fetches only the HTTP headers for a URL (for the connection card).
 * Never reads out the whole body unnecessarily.
 */
export async function fetchHeaders(url, { signal } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', signal });
  // We don't want to keep an open socket alive just for the headers' sake.
  await response.body?.cancel().catch(() => {});

  const headers = headersToObject(response.headers);
  const extraHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    // icy-* (Icecast/SHOUTcast/RSAS station info) and Icecast's ice-audio-info
    // ride along on the same card - no extra UI, just a wider filter.
    if (key.startsWith('x-') || key.startsWith('akamai') || key.startsWith('icy-') || key === 'ice-audio-info') {
      extraHeaders[key] = value;
    }
  }

  return {
    requestedUrl: url,
    finalUrl: response.url || url,
    redirected: response.redirected,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    contentType: headers['content-type'] || null,
    server: headers['server'] || null,
    cacheControl: headers['cache-control'] || null,
    expires: headers['expires'] || null,
    cors: {
      present: Boolean(headers['access-control-allow-origin']),
      allowOrigin: headers['access-control-allow-origin'] || null,
      allowMethods: headers['access-control-allow-methods'] || null,
      allowHeaders: headers['access-control-allow-headers'] || null,
      exposeHeaders: headers['access-control-expose-headers'] || null,
    },
    extraHeaders,
    allHeaders: headers,
  };
}

// ---------------------------------------------------------------------------
// Stream-type sniffing - the dispatch point for analyze()
// ---------------------------------------------------------------------------

/**
 * Reads at most `maxBytes` off the response body, then cancels the rest of the
 * stream. cancel(), never drain: a live Icecast/SHOUTcast body never ends, so
 * reading it to completion would hang. A wall-clock deadline guards against a
 * server that dribbles bytes slowly.
 */
async function readBodyPrefix(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      let result;
      try {
        // response.body is bound to the fetch signal (TIMEOUT_MS + any
        // request-scoped signal), so a stalled or aborted read rejects here.
        result = await reader.read();
      } catch {
        break; // timed out / aborted mid-peek - a partial guess is fine here
      }
      if (result.done || !result.value) break;
      chunks.push(Buffer.from(result.value));
      total += result.value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/**
 * One GET, then decide what kind of stream the URL is:
 *  - Level 1: Content-Type alone (dash+xml / mpegurl) - body cancelled immediately.
 *  - Icecast/SHOUTcast/RSAS: an icy-* response header (strongest signal) or a
 *    bare audio/* content-type - body cancelled, it's an endless audio stream.
 *  - Level 2: unclear Content-Type - peek at up to ~4 KB and look for #EXTM3U or
 *    <MPD; a body that is raw bytes (NUL / invalid UTF-8) and matched no marker
 *    is treated as icecast (a mount with neither icy headers nor an audio type).
 *  - Neither: 'unknown' (the caller falls back to the HLS path, which fails
 *    with a readable INVALID_MANIFEST if it really isn't HLS).
 *
 * A deliberate extra GET: analyzeHls()/analyzeDash() then do their own fetches.
 * Keeping the paths independent (each testable in isolation) is worth one more
 * round-trip - see plan.md.
 */
export async function sniffStreamKind(url, { signal } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', signal });
  const headers = headersToObject(response.headers);
  const contentType = (headers['content-type'] || '').toLowerCase();
  const finalUrl = response.url || url;

  const isDashType = contentType.includes('dash+xml') || contentType.includes('vnd.mpeg.dash.mpd');
  const isHlsType =
    contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl') || contentType.includes('x-mpegurl');

  if (isDashType || isHlsType) {
    await response.body?.cancel().catch(() => {});
    return { kind: isDashType ? 'dash' : 'hls', contentType, finalUrl, matchedOn: 'content-type' };
  }

  const hasIcyHeader = Object.keys(headers).some((k) => k.startsWith('icy-'));
  // audio/* covers a mount with no icy metadata and plain progressive HTTP
  // audio; application/ogg is how Icecast labels Ogg/Opus/Vorbis mounts.
  const isRawAudioType = /^(?:audio\/|application\/ogg\b)/.test(contentType);
  if (hasIcyHeader || isRawAudioType) {
    await response.body?.cancel().catch(() => {});
    return {
      kind: 'icecast',
      contentType,
      finalUrl,
      matchedOn: hasIcyHeader ? 'icy-header' : 'content-type',
    };
  }

  const peek = await readBodyPrefix(response, 4096);
  const trimmed = peek.replace(/^\uFEFF/, '').trimStart(); // strip a leading BOM
  if (trimmed.startsWith('#EXTM3U')) {
    return { kind: 'hls', contentType, finalUrl, matchedOn: 'body' };
  }
  if (/<(?:[\w-]+:)?MPD[\s/>]/.test(peek)) {
    return { kind: 'dash', contentType, finalUrl, matchedOn: 'body' };
  }
  // NUL bytes or a UTF-8 replacement char mean the body isn't text at all -
  // almost certainly raw audio frames from a stream server that sent neither an
  // icy-* header nor an audio/* content-type.
  if (/[\u0000\uFFFD]/.test(peek)) {
    return { kind: 'icecast', contentType, finalUrl, matchedOn: 'binary-body' };
  }
  return { kind: 'unknown', contentType, finalUrl, matchedOn: 'none', peek: peek.slice(0, 500) };
}

// Generic patterns for headers that reveal which CDN node/edge server
// responded - covers Akamai, Cloudflare (cf-*), CloudFront (x-amz-cf-*) and
// common generic cache/edge conventions, rather than hardcoding a specific CDN.
const NETWORK_PATH_PATTERNS = [/^x-cache/i, /^x-served/i, /^x-edge/i, /^via$/i, /^x-amz-cf/i, /^cf-/i, /^x-akamai/i];

function isNetworkPathHeader(key) {
  return NETWORK_PATH_PATTERNS.some((re) => re.test(key));
}

// Best-effort: many CDN nodes are named with an airport code (e.g.
// "ARN52" for Stockholm Arlanda) followed by digits. We only extract the
// pattern raw - we do NOT translate the code into a city, that would be guessing.
const GEO_HINT_RE = /\b([A-Z]{3})\d{1,4}\b/;

function extractGeoHint(headerValues) {
  for (const value of headerValues) {
    const m = GEO_HINT_RE.exec(value);
    if (m) return { raw: m[0], code: m[1], sourceValue: value };
  }
  return null;
}

/**
 * Filters out headers that reveal CDN routing (cache status, which node
 * responded, etc.) from the full header list, plus a best-effort
 * guess at a geographic hint in the node name.
 */
export function computeNetworkPath(allHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(allHeaders || {})) {
    if (isNetworkPathHeader(key)) headers[key] = value;
  }
  return {
    headers,
    geoHint: extractGeoHint(Object.values(headers)),
  };
}

/**
 * Best-effort city/country lookup for a single IP address, from the local
 * (offline, bundled) geoip-lite database - no external network call, but the
 * database itself is a snapshot and can be stale, and is well-known to be
 * inaccurate for CDN anycast addresses (which often geolocate to the CDN
 * operator's registered address rather than the physical edge node). Shown
 * as a separate, clearly-labelled complement to the header-based geoHint
 * above, never as a replacement for it.
 */
function lookupIpGeo(ip) {
  const result = geoip.lookup(ip);
  if (!result) return null;
  return {
    ip,
    country: result.country || null,
    region: result.region || null,
    city: result.city || null,
    ll: result.ll || null,
  };
}

/**
 * Looks up the IP addresses a hostname currently points to. Only one of several
 * possible nodes behind DNS-based load balancing - not necessarily
 * the same node that actually responded to the HTTP request we already made.
 */
export async function resolveDnsAddresses(hostname) {
  try {
    const addresses = await dns.resolve4(hostname);
    return { hostname, addresses, family: 4, error: null, ipGeo: addresses.map(lookupIpGeo) };
  } catch (err4) {
    try {
      const addresses6 = await dns.resolve6(hostname);
      return { hostname, addresses: addresses6, family: 6, error: null, ipGeo: addresses6.map(lookupIpGeo) };
    } catch {
      return { hostname, addresses: [], family: null, error: err4.message, ipGeo: [] };
    }
  }
}

/**
 * Reads a response body as text but aborts past `limitBytes` instead of
 * buffering the whole thing - see MAX_MANIFEST_BYTES.
 */
async function readBodyTextCapped(response, limitBytes, url) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new TimeoutError(url); // stalled or aborted read
      }
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > limitBytes) throw new ManifestTooLargeError(url);
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches the raw manifest text. Throws UpstreamHttpError on a non-OK status
 * (with a body excerpt for debugging, e.g. Akamai's error pages), or
 * ManifestTooLargeError if the body blows past MAX_MANIFEST_BYTES.
 */
async function fetchManifestRaw(url, { signal } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', signal });
  const text = await readBodyTextCapped(response, MAX_MANIFEST_BYTES, url);
  if (!response.ok) {
    throw new UpstreamHttpError(url, response.status, response.statusText, text.slice(0, 500));
  }
  return { finalUrl: response.url || url, status: response.status, text };
}

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
 * Fetches and parses an MPD (DASH manifest). Analogous to getManifest():
 * throws InvalidMpdError if the body doesn't parse as an MPD with at least
 * one Period.
 */
export async function getMpd(url, { signal } = {}) {
  const { finalUrl, text } = await fetchManifestRaw(url, { signal });

  const parsed = parseMpd(text, finalUrl);
  if (parsed.type !== 'dash' || !parsed.periods.length) {
    throw new InvalidMpdError(url, text.split(/\r?\n/).slice(0, 12).join('\n'));
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
 * actually occurs (as absolute media sequence numbers, not just an
 * index into the list), and EXT-X-START, into its own structure for the
 * "Continuity and start point" subsection.
 */
export function computeContinuityInfo(mediaParsed) {
  const segments = mediaParsed.segments || [];
  const baseSequence = mediaParsed.mediaSequence ?? 0;

  const discontinuityPositions = [];
  segments.forEach((seg, index) => {
    if (seg.discontinuity) discontinuityPositions.push(baseSequence + index);
  });

  let startExplanation = null;
  if (mediaParsed.startInfo && mediaParsed.startInfo.timeOffset !== null) {
    const offset = mediaParsed.startInfo.timeOffset;
    startExplanation =
      offset < 0
        ? `Spelaren startar ${Math.abs(offset)} sekunder bakom livekanten.`
        : `Spelaren startar ${offset} sekunder efter fönstrets början.`;
  }

  return {
    discontinuitySequence: mediaParsed.discontinuitySequence,
    discontinuityCount: discontinuityPositions.length,
    discontinuityPositions,
    startInfo: mediaParsed.startInfo || null,
    startExplanation,
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
    oldestProgramDateTime: new Date(oldestTime).toISOString(),
    newestProgramDateTime: new Date(newestTime).toISOString(),
    delaySecondsFromOldest: (now - oldestTime) / 1000,
    delaySecondsFromNewest: (now - newestTime) / 1000,
  };
}

/**
 * Measures actual bitrate for the N most recent segments via HEAD requests
 * (Content-Length / EXTINF duration = kbit/s). Individual segment failures
 * never abort the whole analysis - they're just marked as failed.
 */
export async function measureSegmentBitrates(mediaParsed, count = 12, { signal } = {}) {
  const segments = mediaParsed.segments || [];
  const sample = segments.slice(-count);

  const results = await Promise.all(
    sample.map(async (seg) => {
      try {
        const response = await fetchWithTimeout(seg.uri, { method: 'HEAD', signal });
        await response.body?.cancel().catch(() => {});
        const len = Number(response.headers.get('content-length'));
        if (!response.ok || !Number.isFinite(len) || !seg.duration) {
          return { uri: seg.uri, duration: seg.duration, bytes: null, bitrateKbps: null, ok: false };
        }
        return {
          uri: seg.uri,
          duration: seg.duration,
          programDateTime: seg.programDateTime,
          bytes: len,
          bitrateKbps: (len * 8) / 1000 / seg.duration,
          ok: true,
        };
      } catch (err) {
        if (signal?.aborted) throw err; // stop the whole measurement, don't mask it as a failed segment
        return { uri: seg.uri, duration: seg.duration, bytes: null, bitrateKbps: null, ok: false };
      }
    })
  );

  const ok = results.filter((r) => r.ok);
  const averageMeasuredBitrateKbps = ok.length
    ? ok.reduce((a, r) => a + r.bitrateKbps, 0) / ok.length
    : null;

  return { samples: results, averageMeasuredBitrateKbps };
}

// ---------------------------------------------------------------------------
// ffprobe / ffmpeg as child processes
// ---------------------------------------------------------------------------

// SIGTERM on timeout/abort, then SIGKILL this long after if the process is
// still alive (ffmpeg stuck in a network read may not act on SIGTERM promptly).
const CHILD_SIGKILL_GRACE_MS = 3000;
// Hard cap on captured stdout/stderr so a pathological input that makes ffprobe
// emit a huge JSON (or ffmpeg spew to stderr) can't grow the string unbounded.
const MAX_CHILD_OUTPUT_BYTES = 24 * 1024 * 1024;

function runChildProcess(command, args, { timeoutMs = TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof AppError ? signal.reason : new RequestAbortedError());
      return;
    }

    let child;
    try {
      // No spawn `timeout` option - we manage it ourselves so we can escalate
      // SIGTERM -> SIGKILL rather than sending a single signal that may be ignored.
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    let aborted = false;
    let sigkillTimer = null;

    const escalateKill = () => {
      child.kill('SIGTERM');
      if (!sigkillTimer) {
        sigkillTimer = setTimeout(() => child.kill('SIGKILL'), CHILD_SIGKILL_GRACE_MS);
        sigkillTimer.unref?.();
      }
    };

    const deadline = setTimeout(() => { timedOut = true; escalateKill(); }, timeoutMs);
    deadline.unref?.();

    const onAbort = () => { aborted = true; escalateKill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(deadline);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new BinaryMissingError(command) : err);
    });

    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length <= MAX_CHILD_OUTPUT_BYTES) stdout += chunk;
      else stdoutCapped = true;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length + chunk.length <= MAX_CHILD_OUTPUT_BYTES) stderr += chunk;
      else stderrCapped = true;
    });

    child.on('close', (code, sig) => {
      cleanup();
      if (aborted && signal?.aborted) {
        reject(signal.reason instanceof AppError ? signal.reason : new RequestAbortedError());
        return;
      }
      if ((sig === 'SIGTERM' || sig === 'SIGKILL') && code === null) timedOut = true;
      resolve({ code, signal: sig, stdout, stderr, timedOut, stdoutCapped, stderrCapped });
    });
  });
}

function simplifyProbeResult(probeJson) {
  const streams = probeJson.streams || [];
  const format = probeJson.format || {};
  const audioStream = streams.find((s) => s.codec_type === 'audio') || null;

  return {
    codec: audioStream?.codec_name || null,
    codecLongName: audioStream?.codec_long_name || null,
    profile: audioStream?.profile || null,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    channels: audioStream?.channels ?? null,
    channelLayout: audioStream?.channel_layout || null,
    bitRate: Number(audioStream?.bit_rate || format.bit_rate) || null,
    container: format.format_name || null,
    containerLongName: format.format_long_name || null,
  };
}

/**
 * Runs ffprobe against a URL (master or media - ffmpeg's HLS demuxer handles both)
 * and returns both the raw data and a simplified summary of the audio track.
 */
export async function runFfprobe(url, { signal } = {}) {
  signal?.throwIfAborted?.();
  await assertPublicHost(url);

  const args = [
    '-v', 'quiet',
    '-user_agent', USER_AGENT,
    // Give up on a stalled network read instead of letting ffprobe sit there
    // downloading/waiting until it's force-killed (in microseconds).
    '-rw_timeout', String(TIMEOUT_MS * 1000),
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    url,
  ];

  const { code, stdout, stderr, timedOut } = await runChildProcess('ffprobe', args, { signal });

  if (timedOut) throw new TimeoutError(url);
  if (code !== 0) throw new FfprobeError(stderr);

  let probeJson;
  try {
    probeJson = JSON.parse(stdout);
  } catch {
    throw new FfprobeError(`Kunde inte tolka ffprobes JSON-utdata.\n${stderr}`);
  }

  return { raw: probeJson, audio: simplifyProbeResult(probeJson) };
}

/**
 * Records N seconds of the stream to a temporary file and analyzes it:
 * - measured bitrate = file size * 8 / actual playback duration
 * - ID3/timed metadata in any data streams (best-effort; not all
 *   streams carry "now playing" metadata in the HLS segments).
 *
 * Only audio and data (ID3) streams are recorded - never video - and the
 * capture is capped at 15s, so one call can't be steered into pulling a large
 * video rendition down through the server.
 */
export const MAX_SAMPLE_FILE_BYTES = 50 * 1024 * 1024;

export async function sampleStream(url, requestedSeconds = 8, { signal } = {}) {
  signal?.throwIfAborted?.();
  await assertPublicHost(url);

  const secs = Math.min(15, Math.max(1, Number(requestedSeconds) || 8));
  const tempFile = path.join(os.tmpdir(), `audio-analyzer-${randomUUID()}.ts`);

  const ffmpegArgs = [
    '-y',
    '-user_agent', USER_AGENT,
    '-rw_timeout', String(TIMEOUT_MS * 1000), // µs; bail on a read that stalls >10s
    '-i', url,
    '-t', String(secs),
    '-fs', String(MAX_SAMPLE_FILE_BYTES), // hard cap the temp file regardless of claimed bitrate
    '-map', '0:a',
    '-map', '0:d?',
    '-c', 'copy',
    '-f', 'mpegts',
    tempFile,
  ];

  try {
    const recordStartMs = Date.now();
    const rec = await runChildProcess('ffmpeg', ffmpegArgs, { timeoutMs: secs * 1000 + TIMEOUT_MS, signal });
    const recordWallSec = (Date.now() - recordStartMs) / 1000;
    if (rec.timedOut) throw new TimeoutError(url);

    let stat;
    try {
      stat = await fs.stat(tempFile);
    } catch {
      stat = null;
    }

    if ((!stat || stat.size === 0) && rec.code !== 0) {
      throw new FfmpegError(rec.stderr);
    }

    // Format/stream info + any ID3/timed-metadata frames in data streams.
    const probeArgs = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', tempFile];
    const framesArgs = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-select_streams', 'd',
      '-show_frames',
      tempFile,
    ];

    const [probeRes, framesRes] = await Promise.all([
      runChildProcess('ffprobe', probeArgs, { signal }),
      runChildProcess('ffprobe', framesArgs, { signal }),
    ]);

    let probeJson = {};
    try { probeJson = JSON.parse(probeRes.stdout); } catch { /* leave empty object */ }

    let framesJson = {};
    try { framesJson = JSON.parse(framesRes.stdout); } catch { /* leave empty object */ }

    const format = probeJson.format || {};
    const actualDurationSec = Number(format.duration) || secs;
    const fileSizeBytes = Number(format.size) || stat?.size || 0;
    const measuredBitrateKbps = actualDurationSec > 0 ? (fileSizeBytes * 8) / 1000 / actualDurationSec : null;

    // Continuous streams (Icecast/SHOUTcast/RSAS, plain progressive HTTP) hand a
    // fresh client a "burst" of already-buffered audio the instant it connects,
    // then throttle to real time. If we captured actualDurationSec of audio in
    // noticeably less wall-clock time, that gap is audio the server had sitting
    // in its buffer - a lower bound on how far behind live a new listener starts.
    // Rough: ffmpeg connect/startup overhead inflates recordWallSec (so this
    // under-reports), and network speed plus any relay/CDN hop blur it further.
    // burstIsLowerBound = nearly the whole sample drained faster than real time,
    // so the real burst is larger than our sample window. Only meaningful for a
    // continuous stream; the frontend renders it for Icecast only.
    const connectBurstSec = Math.max(0, actualDurationSec - recordWallSec);
    const burstIsLowerBound = connectBurstSec >= actualDurationSec * 0.75;

    const frames = (framesJson.frames || []).map((f) => ({
      ptsTime: f.pts_time ? Number(f.pts_time) : null,
      tags: f.tags || null,
    }));

    return {
      requestedSeconds: secs,
      actualDurationSec,
      recordWallSec,
      connectBurstSec,
      burstIsLowerBound,
      fileSizeBytes,
      measuredBitrateKbps,
      streams: simplifyProbeResult(probeJson),
      id3: {
        available: frames.length > 0,
        frames,
      },
    };
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

export async function checkBinaryAvailable(binary) {
  try {
    await runChildProcess(binary, ['-version'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Combined analysis for POST /api/analyze
//
// analyze() sniffs the stream type once and dispatches. Each stream kind gets
// its own top-level function that owns its fetches and returns a shape tagged
// with `streamKind` for the frontend to branch on. HLS is the original path,
// renamed; DASH is analyzeDash(); Icecast/SHOUTcast/RSAS is analyzeIcecast().
// ---------------------------------------------------------------------------

export async function analyze(url, { signal } = {}) {
  const kind = await sniffStreamKind(url, { signal });
  if (kind.kind === 'dash') return analyzeDash(url, { signal });
  if (kind.kind === 'icecast') return analyzeIcecast(url, { signal });
  return analyzeHls(url, { signal });
}

export async function analyzeHls(url, { signal } = {}) {
  const errors = {};

  const connection = await fetchHeaders(url, { signal });

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
    networkPath.dns = { hostname: null, addresses: [], family: null, error: err.message };
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

// ---------------------------------------------------------------------------
// DASH analysis - same depth as the HLS path, but a genuinely different shape.
// ---------------------------------------------------------------------------

/**
 * Picks the Representation to analyse: FIRST Period -> first AdaptationSet whose
 * contentType is 'audio' (or mimeType audio/*) -> FIRST Representation in it.
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

  return { period, adaptationSet: set, representation: set.representations[0] };
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
 * The most substantial new piece. Turns a Representation's segment addressing
 * into concrete, fetchable URLs in EXACTLY the { segments: [{ uri, duration }] }
 * shape measureSegmentBitrates() already consumes (that function is reused
 * unchanged). Handles the three DASH addressing modes:
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
    return { segments: all, initUri, mode: 'SegmentTimeline' };
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
    return { segments: all, initUri, mode: 'SegmentTemplate' };
  }

  // --- SegmentList ---
  if (sl && Array.isArray(sl.segmentUrls) && sl.segmentUrls.length) {
    const timescale = sl.timescale || 1;
    const segSec = sl.duration ? sl.duration / timescale : null;
    const segments = sl.segmentUrls.map((u) => ({ uri: resolveUrl(sl.baseUrl, u.media), duration: segSec }));
    if (sl.initialization) initUri = resolveUrl(sl.baseUrl, sl.initialization);
    return { segments: segments.slice(-count), initUri, mode: 'SegmentList' };
  }

  // --- Single-file Representation (plain BaseURL / SegmentBase) ---
  if (representation.baseUrl) {
    return {
      segments: [{ uri: representation.baseUrl, duration: period.durationSec || mpdInfo.mediaPresentationDurationSec || null }],
      initUri: null,
      mode: 'BaseURL',
    };
  }

  return { segments: [], initUri: null, mode: 'none' };
}

/**
 * Analogous to computeSegmentStats(): segment length, count, window in seconds,
 * isLive (from presentationType), encrypted (from contentProtection), fMP4.
 */
export function computeDashSegmentStats(parsedMpd, chosen) {
  const { period, representation } = chosen;
  const st = representation.segmentTemplate;
  const sl = representation.segmentList;

  let segmentDurationSec = null;
  let segmentCount = null;
  let windowSeconds = null;
  let addressing = 'okänd';

  if (st && Array.isArray(st.timeline) && st.timeline.length) {
    addressing = 'SegmentTimeline';
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
    addressing = 'SegmentTemplate ($Number$)';
    segmentDurationSec = st.duration / (st.timescale || 1);
    if (parsedMpd.presentationType === 'static') {
      windowSeconds = period.durationSec || parsedMpd.mediaPresentationDurationSec || null;
      segmentCount = windowSeconds ? Math.ceil(windowSeconds / segmentDurationSec) : null;
    } else {
      windowSeconds = parsedMpd.timeShiftBufferDepthSec || null;
      segmentCount = windowSeconds ? Math.round(windowSeconds / segmentDurationSec) : null;
    }
  } else if (sl && Array.isArray(sl.segmentUrls) && sl.segmentUrls.length) {
    addressing = 'SegmentList';
    segmentCount = sl.segmentUrls.length;
    segmentDurationSec = sl.duration ? sl.duration / (sl.timescale || 1) : null;
    windowSeconds = segmentDurationSec ? segmentDurationSec * segmentCount : null;
  } else if (representation.baseUrl) {
    addressing = 'Enkel fil (BaseURL/SegmentBase)';
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
 * For a static (VOD) MPD -> { available: false }.
 */
export function computeDashLatency(parsedMpd, chosen) {
  if (parsedMpd.presentationType !== 'dynamic') {
    return { available: false, reason: 'VOD (static MPD) - ingen live-fördröjning att beräkna.' };
  }
  const astMs = parsedMpd.availabilityStartTime ? Date.parse(parsedMpd.availabilityStartTime) : NaN;
  if (Number.isNaN(astMs)) {
    return { available: false, reason: 'availabilityStartTime saknas eller kunde inte tolkas.' };
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
// in the analysed Period, with the chosen one flagged.
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
    multiPeriodNote:
      parsedMpd.periodCount > 1
        ? `MPD:n har ${parsedMpd.periodCount} perioder. Endast Period ${period.index + 1} (id "${period.id}") analyseras i v1 - övriga perioders data blandas inte in.`
        : null,
    xlinkNote: period.hasXlink ? 'Den analyserade perioden refererar en extern (xlink) period - utanför scope i v1.' : null,
  };
}

/**
 * Combined DASH analysis. Reuses fetchHeaders, measureSegmentBitrates,
 * runFfprobe, computeNetworkPath and resolveDnsAddresses unchanged; each in its
 * own isolated try/catch so one failure degrades to a warning, same as
 * analyzeHls().
 */
export async function analyzeDash(url, { signal } = {}) {
  const errors = {};

  const connection = await fetchHeaders(url, { signal });

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
    networkPath.dns = { hostname: null, addresses: [], family: null, error: err.message };
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

// ---------------------------------------------------------------------------
// Icecast / SHOUTcast / RSAS - no manifest, no segments, no variant model.
// Station info comes from the icy-* response headers; "now playing" comes from
// an in-stream metadata block the server injects every `icy-metaint` bytes,
// and only when the request carries `Icy-MetaData: 1`. RSAS (Rocket Streaming
// Audio Server) is an Icecast-compatible drop-in and needs nothing special
// here; its own HLS endpoints are sniffed as 'hls' and take the HLS path.
// ---------------------------------------------------------------------------

// Safety cap on how far into the audio body we'll read hunting for the first
// metadata block. icy-metaint is typically 8-16 KB, so this covers a couple of
// intervals even on a low-bitrate stream while bounding memory hard.
export const ICY_MAX_READ_BYTES = 512 * 1024;
// The current title is normally in the very first metadata block; sometimes the
// first block is empty and the next carries it. Past this many blocks we stop
// (metadata is "supported", we just report no title).
const ICY_MAX_INTERVALS = 2;

/**
 * Requests the stream with `Icy-MetaData: 1`, reads just far enough into the
 * body to pull out the first in-stream metadata block, and extracts
 * `StreamTitle`. Network chunk boundaries never line up with the icy-metaint
 * boundaries, so bytes are accumulated and indexed absolutely.
 *
 * Best-effort throughout: a stream that advertises no `icy-metaint`, sends only
 * empty metadata blocks, or ends early yields `{ streamTitle: null }` with
 * `icyMetadataSupported` reflecting whether the mechanism exists at all - none
 * of that is an error. StreamTitle is decoded as UTF-8 (modern Icecast/RSAS);
 * older Latin-1 stations may render mojibake - a documented known limitation.
 */
export async function fetchIcyMetadata(url, { signal } = {}) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'Icy-MetaData': '1' },
    signal,
  });

  const headers = headersToObject(response.headers);
  const icyHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith('icy-') || key === 'ice-audio-info') icyHeaders[key] = value;
  }
  const metaInt = Number(headers['icy-metaint']) > 0 ? Number(headers['icy-metaint']) : null;

  const result = {
    icyHeaders,
    metaInt,
    icyMetadataSupported: Boolean(metaInt),
    streamTitle: null,
    rawMetaBlock: null,
  };

  const reader = response.body?.getReader();
  if (!metaInt || !reader) {
    if (reader) await reader.cancel().catch(() => {});
    else await response.body?.cancel().catch(() => {});
    return result;
  }

  const chunks = [];
  let size = 0;
  let merged = null;
  const bytes = () => {
    if (!merged || merged.length !== size) merged = Buffer.concat(chunks);
    return merged;
  };
  const readUntil = async (n) => {
    while (size < n && size < ICY_MAX_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) return false;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    return size >= n;
  };

  try {
    let intervalStart = 0;
    for (let i = 0; i < ICY_MAX_INTERVALS; i++) {
      const lenPos = intervalStart + metaInt;
      if (!(await readUntil(lenPos + 1))) break;
      const metaLen = bytes()[lenPos] * 16;
      if (metaLen === 0) {
        intervalStart = lenPos + 1; // next audio interval starts right after the zero byte
        continue;
      }
      const metaEnd = lenPos + 1 + metaLen;
      if (!(await readUntil(metaEnd))) break;
      const rawBlock = bytes()
        .subarray(lenPos + 1, metaEnd)
        .toString('utf8')
        .replace(/\u0000+$/, ''); // NUL-padded out to a 16-byte multiple
      result.rawMetaBlock = rawBlock;
      // The block is `Key='value';Key='value';...`. ICY doesn't escape a single
      // quote inside a value, so match up to the `';` that is followed by another
      // `Key='` or the end - not just the first quote (titles like "Nobody Knows
      // You When You're Down" contain one).
      const m =
        /StreamTitle='(.*?)';(?=\w+='|\s*$)/s.exec(rawBlock) ||
        /StreamTitle='([^']*)';?/.exec(rawBlock);
      if (m) result.streamTitle = m[1] || null;
      break;
    }
  } catch {
    // keep the headers + whatever parsed; the isolated caller logs nothing as an error
  } finally {
    await reader.cancel().catch(() => {});
  }
  return result;
}

/**
 * Combined Icecast/SHOUTcast/RSAS analysis. Deliberately a smaller shape than
 * HLS or DASH - there is genuinely no manifest/variant/segment/latency model
 * for a raw stream. Reuses fetchHeaders, computeNetworkPath, resolveDnsAddresses
 * and runFfprobe unchanged; each fallible step in its own try/catch so one
 * failure degrades to a warning, same as analyzeHls()/analyzeDash().
 */
export async function analyzeIcecast(url, { signal } = {}) {
  const errors = {};

  const connection = await fetchHeaders(url, { signal });

  const networkPath = computeNetworkPath(connection.allHeaders);
  try {
    networkPath.dns = await resolveDnsAddresses(new URL(connection.finalUrl).hostname);
  } catch (err) {
    networkPath.dns = { hostname: null, addresses: [], family: null, error: err.message };
  }

  let audio = null;
  try {
    const probe = await runFfprobe(url, { signal });
    audio = probe.audio;
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.ffprobe = { message: err.message, code: err.code || 'UNKNOWN', details: err.details };
  }

  let icy = null;
  try {
    icy = await fetchIcyMetadata(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.icyMetadata = { message: err.message, code: err.code || 'UNKNOWN' };
  }

  const h = icy?.icyHeaders || {};
  const numOrNull = (v) => {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : null;
  };

  return {
    streamKind: 'icecast',
    requestedUrl: url,
    sampleUrl: url,
    connection,
    networkPath,
    audio,
    station: {
      name: h['icy-name'] || null,
      genre: h['icy-genre'] || null,
      description: h['icy-description'] || null,
      homepageUrl: h['icy-url'] || null,
      declaredBitrateKbps: numOrNull(h['icy-br']),
      declaredSampleRateHz: numOrNull(h['icy-sr'] ?? h['icy-samplerate']),
      audioInfo: h['ice-audio-info'] || null,
      isPublic: h['icy-pub'] === '1',
      serverSoftware: connection.server || null,
      contentType: connection.contentType || null,
      icyMetadataSupported: icy ? icy.icyMetadataSupported : false,
      metaIntBytes: icy?.metaInt ?? null,
      nowPlaying: icy?.streamTitle || null,
      rawMetaBlock: icy?.rawMetaBlock || null,
    },
    errors,
  };
}
