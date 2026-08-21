// analyzer.js
// All logik för att hämta, tolka och mäta en HLS-ström:
// HTTP-anrop mot CDN:en, körning av ffprobe/ffmpeg som barnprocesser,
// samt sammanställning av de data som frontend visar per kort.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { parseM3U8 } from './parser.js';

export const TIMEOUT_MS = 10_000;
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Audio-Analysator/1.0';

// ---------------------------------------------------------------------------
// Felklasser - varje bär tillräckligt med information för att index.js ska
// kunna svara med ett begripligt, svenskt felmeddelande utan att gissa.
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

// ---------------------------------------------------------------------------
// URL-validering
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

// ---------------------------------------------------------------------------
// HTTP-hämtning med timeout och realistisk User-Agent
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...options.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new TimeoutError(url);
    throw err;
  } finally {
    clearTimeout(timer);
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
 * Hämtar enbart HTTP-headrar för en URL (för /api/headers och anslutningskortet).
 * Läser aldrig ut hela kroppen i onödan.
 */
export async function fetchHeaders(url) {
  const response = await fetchWithTimeout(url, { method: 'GET' });
  // Vi vill inte hålla kvar en öppen socket bara för headrarnas skull.
  await response.body?.cancel().catch(() => {});

  const headers = headersToObject(response.headers);
  const extraHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith('x-') || key.startsWith('akamai')) {
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

// Generiska mönster för headrar som avslöjar vilken CDN-nod/edge-server som
// svarade - täcker Akamai, Cloudflare (cf-*), CloudFront (x-amz-cf-*) och
// vanliga generiska cache-/edge-konventioner, snarare än att hårdkoda en CDN.
const NETWORK_PATH_PATTERNS = [/^x-cache/i, /^x-served/i, /^x-edge/i, /^via$/i, /^x-amz-cf/i, /^cf-/i, /^x-akamai/i];

function isNetworkPathHeader(key) {
  return NETWORK_PATH_PATTERNS.some((re) => re.test(key));
}

// Bäst-ansträngning: många CDN-noder namnges med en flygplatskod (t.ex.
// "ARN52" för Stockholm Arlanda) följt av siffror. Vi extraherar bara
// mönstret rått - vi översätter INTE koden till en stad, det vore att gissa.
const GEO_HINT_RE = /\b([A-Z]{3})\d{1,4}\b/;

function extractGeoHint(headerValues) {
  for (const value of headerValues) {
    const m = GEO_HINT_RE.exec(value);
    if (m) return { raw: m[0], code: m[1], sourceValue: value };
  }
  return null;
}

/**
 * Filtrerar fram headrar som avslöjar CDN-routing (cache-status, vilken nod
 * som svarade osv.) ur den fullständiga headerlistan, samt en bäst-
 * ansträngning-gissning på en geografisk ledtråd i nodnamnet.
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
 * Slår upp IP-adresserna ett värdnamn pekar mot just nu. Endast en av flera
 * möjliga noder bakom DNS-baserad lastbalansering - inte nödvändigtvis
 * samma nod som faktiskt svarade på det HTTP-anrop vi redan gjort.
 */
export async function resolveDnsAddresses(hostname) {
  try {
    const addresses = await dns.resolve4(hostname);
    return { hostname, addresses, family: 4, error: null };
  } catch (err4) {
    try {
      const addresses6 = await dns.resolve6(hostname);
      return { hostname, addresses: addresses6, family: 6, error: null };
    } catch {
      return { hostname, addresses: [], family: null, error: err4.message };
    }
  }
}

/**
 * Hämtar rå manifesttext. Kastar UpstreamHttpError vid icke-OK status
 * (med kroppsutdrag för felsökning, t.ex. Akamais felsidor).
 */
async function fetchManifestRaw(url) {
  const response = await fetchWithTimeout(url, { method: 'GET' });
  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamHttpError(url, response.status, response.statusText, text.slice(0, 500));
  }
  return { finalUrl: response.url || url, status: response.status, text };
}

/**
 * Hämtar och tolkar ett manifest (master ELLER media - avgörs av parser.js).
 */
export async function getManifest(url) {
  const { finalUrl, text } = await fetchManifestRaw(url);

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
 * Följer ev. master-playlist ner till en konkret media-playlist (med segment).
 * Radio-strömmar saknar ofta master-lagret helt - då returneras media direkt.
 */
export async function resolveMediaPlaylist(url) {
  const manifest = await getManifest(url);

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

  const media = await getManifest(chosenVariant.url);
  if (media.parsed.type !== 'media') {
    throw new InvalidManifestError(chosenVariant.url, 'Variant-URL:en pekade inte på en media-playlist.');
  }

  return { master: manifest, media, chosenVariant };
}

// ---------------------------------------------------------------------------
// Segment, buffert och latens
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
 * Samlar allt LL-HLS-specifikt (EXT-X-SERVER-CONTROL, EXT-X-PART-INF,
 * EXT-X-PART, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT) i en egen struktur
 * för ett tydligt avskilt "Low-Latency HLS"-underavsnitt. Flaggar motsägelsen
 * om CDN:et signalerar LL-HLS-stöd i headers (Akamais x-llhls-blocked) men
 * manifestet självt saknar alla LL-HLS-taggar.
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
 * Samlar EXT-X-DISCONTINUITY-SEQUENCE, var i fönstret EXT-X-DISCONTINUITY
 * faktiskt förekommer (som absoluta media-sequence-nummer, inte bara ett
 * index i listan) och EXT-X-START, i en egen struktur för underavsnittet
 * "Kontinuitet och startpunkt".
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
 * Beräknar latens från PROGRAM-DATE-TIME-taggar. Äldre HLS (t.ex. version 3)
 * sätter ofta bara taggen en gång, på det första segmentet i fönstret, inte
 * på varje segment. Att då jämföra samma tidsstämpel mot väggklockan som om
 * den vore det senaste segmentets ger en kraftigt underskattad fördröjning.
 *
 * Vi hittar alla segment som faktiskt har en egen tidsstämpel ("ankare").
 * Finns två eller fler ankare litar vi på dem direkt (så gör de flesta
 * moderna paketerare - varje segment har sin egen PROGRAM-DATE-TIME).
 * Finns bara ETT ankare extrapolerar vi fram tidsstämpeln för första och
 * sista segmentet genom att addera/subtrahera EXTINF-längderna mellan
 * ankaret och respektive segment - och flaggar resultatet som beräknat,
 * inte uppmätt, så användaren vet att siffran är mer osäker.
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

  // Summerar EXTINF-längder (i ms) mellan två segmentindex - positiv summa
  // framåt i listan, negativ bakåt, så den kan adderas direkt till ankarets tid.
  function msBetween(fromIndex, toIndex) {
    let sum = 0;
    if (toIndex > fromIndex) {
      for (let i = fromIndex + 1; i <= toIndex; i++) sum += (segments[i].duration || 0) * 1000;
    } else {
      for (let i = toIndex + 1; i <= fromIndex; i++) sum -= (segments[i].duration || 0) * 1000;
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
 * Mäter faktisk bitrate för de N senaste segmenten via HEAD-anrop
 * (Content-Length / EXTINF-duration = kbit/s). Enskilda segmentfel
 * kastar aldrig hela analysen - de markeras bara som misslyckade.
 */
export async function measureSegmentBitrates(mediaParsed, count = 12) {
  const segments = mediaParsed.segments || [];
  const sample = segments.slice(-count);

  const results = await Promise.all(
    sample.map(async (seg) => {
      try {
        const response = await fetchWithTimeout(seg.uri, { method: 'HEAD' });
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
      } catch {
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
// ffprobe / ffmpeg som barnprocesser
// ---------------------------------------------------------------------------

function runChildProcess(command, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { timeout: timeoutMs, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new BinaryMissingError(command));
      } else {
        reject(err);
      }
    });

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' && code === null) timedOut = true;
      resolve({ code, signal, stdout, stderr, timedOut });
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
 * Kör ffprobe mot en URL (master eller media - ffmpegs HLS-demuxer klarar båda)
 * och returnerar både rådata och en förenklad sammanfattning av ljudspåret.
 */
export async function runFfprobe(url) {
  const args = [
    '-v', 'quiet',
    '-user_agent', USER_AGENT,
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    url,
  ];

  const { code, stdout, stderr, timedOut } = await runChildProcess('ffprobe', args);

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
 * Spelar in N sekunder av strömmen till en temporär fil och analyserar den:
 * - uppmätt bitrate = filstorlek * 8 / faktisk speltid
 * - ID3/timed metadata i ev. dataspår (bäst-ansträngning; inte alla
 *   strömmar bär "nu spelas"-metadata i HLS-segmenten).
 */
export async function sampleStream(url, requestedSeconds = 8) {
  const secs = Math.min(30, Math.max(1, Number(requestedSeconds) || 8));
  const tempFile = path.join(os.tmpdir(), `audio-analysator-${randomUUID()}.ts`);

  const ffmpegArgs = [
    '-y',
    '-user_agent', USER_AGENT,
    '-i', url,
    '-t', String(secs),
    '-map', '0',
    '-c', 'copy',
    '-f', 'mpegts',
    tempFile,
  ];

  try {
    const rec = await runChildProcess('ffmpeg', ffmpegArgs, { timeoutMs: secs * 1000 + TIMEOUT_MS });

    let stat;
    try {
      stat = await fs.stat(tempFile);
    } catch {
      stat = null;
    }

    if ((!stat || stat.size === 0) && rec.code !== 0) {
      throw new FfmpegError(rec.stderr);
    }

    // Format/ström-info + eventuella ID3/timed-metadata-frames i dataspår.
    const probeArgs = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', tempFile];
    const framesArgs = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-select_streams', 'd',
      '-show_frames',
      tempFile,
    ];

    const [probeRes, framesRes] = await Promise.all([
      runChildProcess('ffprobe', probeArgs),
      runChildProcess('ffprobe', framesArgs),
    ]);

    let probeJson = {};
    try { probeJson = JSON.parse(probeRes.stdout); } catch { /* lämna tomt objekt */ }

    let framesJson = {};
    try { framesJson = JSON.parse(framesRes.stdout); } catch { /* lämna tomt objekt */ }

    const format = probeJson.format || {};
    const actualDurationSec = Number(format.duration) || secs;
    const fileSizeBytes = Number(format.size) || stat?.size || 0;
    const measuredBitrateKbps = actualDurationSec > 0 ? (fileSizeBytes * 8) / 1000 / actualDurationSec : null;

    const frames = (framesJson.frames || []).map((f) => ({
      ptsTime: f.pts_time ? Number(f.pts_time) : null,
      tags: f.tags || null,
    }));

    return {
      requestedSeconds: secs,
      actualDurationSec,
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
// Samlad analys för POST /api/analyze
// ---------------------------------------------------------------------------

export async function analyze(url) {
  const errors = {};

  const connection = await fetchHeaders(url);

  const { master, media, chosenVariant } = await resolveMediaPlaylist(url);

  const segments = computeSegmentStats(media.parsed);
  const latency = computeLatency(media.parsed);
  const lowLatency = computeLowLatencyInfo(media.parsed, connection.allHeaders);
  const continuity = computeContinuityInfo(media.parsed);

  let bitrate = { samples: [], averageMeasuredBitrateKbps: null };
  try {
    bitrate = await measureSegmentBitrates(media.parsed);
  } catch (err) {
    errors.bitrate = { message: err.message, code: err.code || 'UNKNOWN' };
  }
  bitrate.declaredBandwidthKbps = chosenVariant?.bandwidth ? chosenVariant.bandwidth / 1000 : null;

  let audio = null;
  try {
    const probe = await runFfprobe(media.finalUrl);
    audio = probe.audio;
  } catch (err) {
    errors.ffprobe = { message: err.message, code: err.code || 'UNKNOWN', details: err.details };
  }

  const networkPath = computeNetworkPath(connection.allHeaders);
  try {
    networkPath.dns = await resolveDnsAddresses(new URL(media.finalUrl).hostname);
  } catch (err) {
    networkPath.dns = { hostname: null, addresses: [], family: null, error: err.message };
  }

  const variants = master?.parsed.variants || [];

  return {
    requestedUrl: url,
    connection,
    variants: {
      hasMasterPlaylist: Boolean(master),
      list: variants,
      singleVariantNote: !master || variants.length <= 1,
      chosenVariantUrl: chosenVariant?.url || media.finalUrl,
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
