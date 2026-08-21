// index.js
// Express app: static frontend files + JSON API that proxies to CDNs
// and runs ffprobe/ffmpeg. Explicitly listens on 127.0.0.1 - this
// tool is meant to run locally, not be exposed on the network.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import {
  AppError,
  TIMEOUT_MS,
  USER_AGENT,
  validateUrl,
  fetchHeaders,
  getManifest,
  runFfprobe,
  sampleStream,
  analyze,
  checkBinaryAvailable,
} from './analyzer.js';
import { rewriteManifestForProxy } from './parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8877;
const HOST = '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// -----------------------------------------------------------------------
// Error responses: maps our own error classes (see analyzer.js) to HTTP status
// codes and a uniform JSON error format that the frontend can display directly.
// -----------------------------------------------------------------------

const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  TIMEOUT: 504,
  UPSTREAM_HTTP_ERROR: 502,
  INVALID_MANIFEST: 502,
  BINARY_MISSING: 500,
  FFPROBE_FAILED: 500,
  FFMPEG_FAILED: 500,
};

function sendError(res, err) {
  if (err instanceof AppError) {
    const status = STATUS_BY_CODE[err.code] || 500;
    res.status(status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  console.error(err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: err.message || 'Okänt serverfel.' },
  });
}

// -----------------------------------------------------------------------
// API routes
// -----------------------------------------------------------------------

app.post('/api/analyze', async (req, res) => {
  try {
    const url = validateUrl(req.body?.url ?? req.query.url);
    res.json(await analyze(url));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/headers', async (req, res) => {
  try {
    const url = validateUrl(req.query.url);
    res.json(await fetchHeaders(url));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/manifest', async (req, res) => {
  try {
    const url = validateUrl(req.query.url);
    res.json(await getManifest(url));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/probe', async (req, res) => {
  try {
    const url = validateUrl(req.query.url);
    res.json(await runFfprobe(url));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/sample', async (req, res) => {
  try {
    const url = validateUrl(req.query.url);
    res.json(await sampleStream(url, req.query.secs));
  } catch (err) {
    sendError(res, err);
  }
});

// Pass-through of manifest and segments to hls.js in the browser. The CDN
// denies CORS for its own responses, but our own /api/proxy response is served on
// the same origin as the page - so the browser has no objections.
app.get('/api/proxy', async (req, res) => {
  let target;
  try {
    target = validateUrl(req.query.url);
  } catch (err) {
    sendError(res, err);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstreamHeaders = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    const response = await fetch(target, {
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const looksLikeManifest =
      contentType.includes('mpegurl') ||
      contentType.includes('vnd.apple') ||
      new URL(target).pathname.endsWith('.m3u8');

    res.set('Access-Control-Allow-Origin', '*');
    res.status(response.status);

    if (looksLikeManifest) {
      const text = await response.text();
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteManifestForProxy(text, response.url || target));
      return;
    }

    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = response.headers.get(h);
      if (v) res.set(h, v);
    }

    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    const mapped = err.name === 'AbortError'
      ? { code: 'TIMEOUT', message: `Timeout mot ${target} (${TIMEOUT_MS / 1000}s).` }
      : null;
    if (mapped) {
      res.status(504).json({ error: mapped });
    } else {
      sendError(res, err);
    }
  } finally {
    clearTimeout(timer);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Okänd API-route: ${req.path}` } });
});

app.listen(PORT, HOST, async () => {
  console.log(`Audio-analyzer körs på http://${HOST}:${PORT}`);

  const [hasFfmpeg, hasFfprobe] = await Promise.all([
    checkBinaryAvailable('ffmpeg'),
    checkBinaryAvailable('ffprobe'),
  ]);
  if (!hasFfmpeg || !hasFfprobe) {
    console.warn(
      '\nVARNING: ffmpeg/ffprobe hittades inte i PATH. Ljud-, buffert- och ' +
      'inspelningsanalys kommer att misslyckas (manifestanalysen fungerar ändå).\n' +
      '  macOS:  brew install ffmpeg\n' +
      '  Linux:  sudo apt install ffmpeg   (eller: sudo dnf install ffmpeg)\n'
    );
  }
});
