// net.js
// Everything that talks HTTP to a server we do not control: the SSRF guard, the
// fetch wrapper all outbound traffic goes through, and the helpers that read a
// bounded amount of a response body.
//
// The rule this module exists to enforce: no request leaves this process without
// having had its destination checked, and no response body is read without a byte
// ceiling and a deadline.

import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import ipaddr from 'ipaddr.js';
import { Agent, buildConnector } from 'undici';

import { MAX_MANIFEST_BYTES, TIMEOUT_MS, USER_AGENT } from './config.js';
import {
  AppError,
  HostBlockedError,
  ManifestTooLargeError,
  TimeoutError,
  UpstreamHttpError,
  UpstreamUnreachableError,
  ValidationError,
} from './errors.js';

const dnsLookupAsync = promisify(dnsLookup);

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
  // Credentials in the URL would be forwarded to the target and echoed back in every
  // "requested URL" field we render. Nothing here needs them, so drop them.
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

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
// two the up-front check is the only layer - which is why they pass failClosed.
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

/**
 * Up-front name/IP check. `failClosed` decides what a DNS failure means:
 *  - false (fetch traffic): fall through. ssrfSafeAgent still re-checks the real
 *    remote IP when the socket opens, so nothing is unguarded, and letting the
 *    fetch fail on its own produces a much better error than "host blocked".
 *  - true (ffprobe/ffmpeg): refuse. Those two resolve and connect outside Node,
 *    so this check is their ONLY layer - falling through would mean a DNS hiccup
 *    silently turns the guard off on exactly the calls that spawn a process.
 */
export async function assertPublicHost(urlString, { failClosed = false } = {}) {
  const { hostname } = new URL(urlString);
  const lowerHost = hostname.toLowerCase();

  if (lowerHost === 'localhost' || lowerHost.endsWith('.railway.internal')) {
    throw new HostBlockedError(hostname);
  }

  let addresses;
  try {
    addresses = await dnsLookupAsync(hostname, { all: true });
  } catch (err) {
    console.warn(`DNS-uppslagning misslyckades för "${hostname}": ${err.message}`);
    if (failClosed) throw new HostBlockedError(hostname);
    return;
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

export async function fetchWithTimeout(url, options = {}) {
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
    // Same wrapper, but the cause is a socket-level errno (ENOTFOUND, ECONNREFUSED,
    // an expired certificate...). That is the upstream being unreachable, not an
    // internal fault - say which, instead of letting it become a bare 500.
    if (err?.cause?.code) throw new UpstreamUnreachableError(url, err.cause);
    throw err;
  }
}

export function headersToObject(headers) {
  const obj = {};
  for (const [key, value] of headers.entries()) {
    obj[key.toLowerCase()] = value;
  }
  return obj;
}

/**
 * Builds the "connection" card from a response we already have. Split out of
 * fetchHeaders() so sniffStreamKind() can hand its response straight over instead
 * of making the analysers open a second identical connection - which matters for
 * Icecast, where every connection occupies a listener slot the station pays for.
 */
export function buildConnectionInfo(response, url) {
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

/**
 * Fetches only the HTTP headers for a URL (for the connection card).
 * A GET rather than a HEAD - plenty of stream servers answer HEAD with 405 - but
 * the body is cancelled the moment the headers are in, never read.
 */
export async function fetchHeaders(url, { signal } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', signal });
  // We don't want to keep an open socket alive just for the headers' sake.
  await response.body?.cancel().catch(() => {});
  return buildConnectionInfo(response, url);
}

// ---------------------------------------------------------------------------
// Bounded body reads
// ---------------------------------------------------------------------------

/**
 * Reads at most `maxBytes` off the response body, then cancels the rest of the
 * stream. cancel(), never drain: a live Icecast/SHOUTcast body never ends, so
 * reading it to completion would hang. A wall-clock deadline guards against a
 * server that dribbles bytes slowly.
 */
export async function readBodyPrefix(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
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
  // Returns bytes, not a string. Decoding here used to cut the buffer at a fixed
  // byte offset, which lands mid-sequence on any multi-byte character and produces
  // a U+FFFD that the caller's binary-content test then read as "raw audio".
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/**
 * Reads a response body as text but aborts past `limitBytes` instead of
 * buffering the whole thing - see MAX_MANIFEST_BYTES / MAX_MPD_BYTES.
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
      if (total > limitBytes) throw new ManifestTooLargeError(url, limitBytes);
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
 * ManifestTooLargeError if the body blows past the caller's byte limit.
 */
export async function fetchManifestRaw(url, { signal, limitBytes = MAX_MANIFEST_BYTES } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', signal });
  const text = await readBodyTextCapped(response, limitBytes, url);
  if (!response.ok) {
    throw new UpstreamHttpError(url, response.status, response.statusText, text.slice(0, 500));
  }
  return { finalUrl: response.url || url, status: response.status, text };
}

// ---------------------------------------------------------------------------
// Stream-type sniffing - the dispatch point for analyze()
// ---------------------------------------------------------------------------

/**
 * One GET, then decide what kind of stream the URL is:
 *  - Level 1: Content-Type alone (dash+xml / mpegurl) - body cancelled immediately.
 *  - Icecast/SHOUTcast/RSAS: an icy-* response header (strongest signal) or a
 *    bare audio/* content-type - body cancelled, it's an endless audio stream.
 *  - Level 2: unclear Content-Type - peek at up to ~4 KB and look for #EXTM3U or
 *    <MPD; a body whose leading bytes contain a NUL is treated as icecast (a mount
 *    with neither icy headers nor an audio type).
 *  - Neither: 'unknown' (the caller falls back to the HLS path, which fails
 *    with a readable INVALID_MANIFEST if it really isn't HLS).
 *
 * Also returns the fully-built `connection` card for this response, so the analyser
 * this dispatches to does not have to open a second identical connection just to
 * read the same headers again.
 */
export async function sniffStreamKind(url, { signal } = {}) {
  const response = await fetchWithTimeout(url, { method: 'GET', signal });
  const headers = headersToObject(response.headers);
  const contentType = (headers['content-type'] || '').toLowerCase();
  const finalUrl = response.url || url;
  const connection = buildConnectionInfo(response, url);

  const isDashType = contentType.includes('dash+xml') || contentType.includes('vnd.mpeg.dash.mpd');
  const isHlsType =
    contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl') || contentType.includes('x-mpegurl');

  if (isDashType || isHlsType) {
    await response.body?.cancel().catch(() => {});
    return { kind: isDashType ? 'dash' : 'hls', contentType, finalUrl, connection, matchedOn: 'content-type' };
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
      connection,
      matchedOn: hasIcyHeader ? 'icy-header' : 'content-type',
    };
  }

  const peekBytes = await readBodyPrefix(response, 4096);
  const peek = peekBytes.toString('utf8');
  const trimmed = peek.replace(/^\uFEFF/, '').trimStart(); // strip a leading BOM
  if (trimmed.startsWith('#EXTM3U')) {
    return { kind: 'hls', contentType, finalUrl, connection, matchedOn: 'body' };
  }
  if (/<(?:[\w-]+:)?MPD[\s/>]/.test(peek)) {
    return { kind: 'dash', contentType, finalUrl, connection, matchedOn: 'body' };
  }
  // A NUL byte means the body isn't text at all - almost certainly raw audio frames
  // from a stream server that sent neither an icy-* header nor an audio/* type.
  // Tested on the BYTES, and only the leading ones: the previous test also counted
  // U+FFFD as binary, so every Latin-1 error page - and every valid UTF-8 document
  // whose 4096-byte cut happened to fall mid-character - looked like audio and got
  // routed to the Icecast path instead of reporting what it actually was.
  if (peekBytes.subarray(0, 1024).includes(0)) {
    return { kind: 'icecast', contentType, finalUrl, connection, matchedOn: 'binary-body' };
  }
  return { kind: 'unknown', contentType, finalUrl, connection, matchedOn: 'none', peek: peek.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Measured bitrate
// ---------------------------------------------------------------------------

/**
 * Measures actual bitrate for the N most recent segments (Content-Length / EXTINF
 * duration = kbit/s). Takes anything with a `segments: [{ uri, duration }]` shape,
 * which is why both the HLS parser output and the DASH URL generator can feed it.
 * Individual segment failures never abort the whole analysis - they're just marked
 * as failed, with the reason kept so the UI can say more than "misslyckades".
 */
export async function measureSegmentBitrates(segmentSource, count = 12, { signal } = {}) {
  const segments = segmentSource.segments || [];
  const sample = segments.slice(-count);

  const results = await Promise.all(
    sample.map(async (seg) => {
      const failed = (reason) => ({
        uri: seg.uri,
        duration: seg.duration,
        bytes: null,
        bitrateKbps: null,
        ok: false,
        reason,
      });
      try {
        // HEAD first: it is one round trip and no body. Plenty of CDNs answer 405
        // to HEAD on segments though, so that case falls back to a ranged GET
        // rather than reporting a perfectly healthy segment as a failure.
        let response = await fetchWithTimeout(seg.uri, { method: 'HEAD', signal });
        await response.body?.cancel().catch(() => {});
        let len = Number(response.headers.get('content-length'));

        if (!response.ok || !Number.isFinite(len)) {
          response = await fetchWithTimeout(seg.uri, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            signal,
          });
          await response.body?.cancel().catch(() => {});
          // 206 answers with Content-Range: bytes 0-0/<total>; the total is what we want.
          const contentRange = response.headers.get('content-range');
          const total = contentRange ? Number(contentRange.split('/')[1]) : NaN;
          len = Number.isFinite(total) ? total : Number(response.headers.get('content-length'));
        }

        if (!response.ok) return failed(`HTTP ${response.status}`);
        if (!Number.isFinite(len)) return failed('ingen Content-Length');
        if (!seg.duration) return failed('okänd segmentlängd');

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
        return failed(err.message);
      }
    })
  );

  const ok = results.filter((r) => r.ok);
  const averageMeasuredBitrateKbps = ok.length ? ok.reduce((a, r) => a + r.bitrateKbps, 0) / ok.length : null;

  return { samples: results, averageMeasuredBitrateKbps };
}
