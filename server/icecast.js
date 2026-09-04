// icecast.js
// Icecast / SHOUTcast / RSAS - no manifest, no segments, no variant model.
// Station info comes from the icy-* response headers; "now playing" comes from
// an in-stream metadata block the server injects every `icy-metaint` bytes,
// and only when the request carries `Icy-MetaData: 1`. RSAS (Rocket Streaming
// Audio Server) is an Icecast-compatible drop-in and needs nothing special
// here; its own HLS endpoints are sniffed as 'hls' and take the HLS path.

import { ICY_MAX_READ_BYTES } from './config.js';
import { AppError, UpstreamHttpError } from './errors.js';
import { fetchHeaders, fetchWithTimeout, headersToObject } from './net.js';
import { computeNetworkPath, emptyDnsResult, resolveDnsAddresses } from './networkPath.js';
import { runFfprobe } from './ffmpeg.js';

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
  } catch (err) {
    // A failed metadata peek is not an error - keep the headers and whatever parsed.
    // But an AppError here is the request-scoped signal firing (client gone, or the
    // hard deadline), and swallowing that would leave us working for nobody.
    if (err instanceof AppError) throw err;
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
export async function analyzeIcecast(url, { signal, connection: prefetched } = {}) {
  const errors = {};

  // Reusing the sniff's response matters most here: every connection to an Icecast
  // mount takes a listener slot, and this path opens two more (ffprobe and the ICY
  // metadata read) before it is done.
  const connection = prefetched || (await fetchHeaders(url, { signal }));
  // A geoblocked or missing mount often answers 403/404 while still carrying an
  // audio/* content-type, which is exactly what sniffs as icecast. Without this the
  // user got a Station card with every field empty instead of the readable upstream
  // error the HLS path produces for the same situation.
  if (!connection.ok) {
    throw new UpstreamHttpError(url, connection.status, connection.statusText, null);
  }

  // Redirects are already resolved here; hand ffprobe/ICY the final URL so they do
  // not run their own redirect chain outside the SSRF check.
  const streamUrl = connection.finalUrl || url;

  const networkPath = computeNetworkPath(connection.allHeaders);
  try {
    networkPath.dns = await resolveDnsAddresses(new URL(streamUrl).hostname);
  } catch (err) {
    networkPath.dns = emptyDnsResult(err.message);
  }

  let audio = null;
  try {
    const probe = await runFfprobe(streamUrl, { signal });
    audio = probe.audio;
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.ffprobe = { message: err.message, code: err.code || 'UNKNOWN', details: err.details };
  }

  let icy = null;
  try {
    icy = await fetchIcyMetadata(streamUrl, { signal });
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
    sampleUrl: streamUrl,
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
