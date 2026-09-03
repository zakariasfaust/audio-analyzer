// index.js
// Express app: static frontend files + a JSON API that fetches from CDNs
// and runs ffprobe/ffmpeg. Binds to 127.0.0.1 by default - this tool is
// meant to run locally - set HOST=0.0.0.0 explicitly to expose it on the
// network (e.g. behind a reverse proxy).

import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMaxListeners } from 'node:events';

import {
  AppError,
  validateUrl,
  sampleStream,
  analyze,
  checkBinaryAvailable,
} from './analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8877;
const HOST = process.env.HOST || '127.0.0.1';
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 60; // per IP, per window - roomy for interactive use (a full Analyze is 2 calls), still a brake on scripted hammering
// Hard ceiling on analyses running at once, across all callers. A per-IP rate
// limit does nothing against many IPs; this is what actually bounds CPU, memory,
// disk and bandwidth on the host no matter how the requests arrive.
const MAX_CONCURRENT_JOBS = 3;
// Absolute wall-clock ceiling per job. Every internal step already has its own
// 10s timeout and a fully-degraded analyze (every step timing out in sequence)
// still lands under this; it only catches a request that wedges anyway - and,
// crucially, it aborts the work (in-flight fetches + ffmpeg/ffprobe) rather than
// letting it keep consuming memory/bandwidth after we've stopped waiting.
const REQUEST_DEADLINE_MS = 90_000;

const app = express();
// When deployed, a reverse proxy sits in front; trust exactly one hop so the
// rate limiter keys on the real client IP from X-Forwarded-For rather than the
// proxy's. Harmless for local `npm start` (there is no forwarded header to read).
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use(
  '/api',
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Concurrency gate for the two endpoints that spawn ffprobe/ffmpeg. Rejects
// immediately with 503 rather than queueing - a queue under abuse just defers
// the pile-up. Legitimate use (the UI runs analyze then sample in sequence)
// never approaches the limit.
let activeJobs = 0;
function jobGuard(req, res, next) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    res.set('Retry-After', '10');
    res.status(503).json({
      error: { code: 'BUSY', message: 'Servern kör redan så många analyser den tar samtidigt. Försök igen om en liten stund.' },
    });
    return;
  }
  activeJobs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeJobs--;
  };
  res.on('finish', release);
  res.on('close', release);
  next();
}

// -----------------------------------------------------------------------
// Error responses: maps our own error classes (see analyzer.js) to HTTP status
// codes and a uniform JSON error format that the frontend can display directly.
// -----------------------------------------------------------------------

const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  HOST_BLOCKED: 400,
  TIMEOUT: 504,
  REQUEST_TIMEOUT: 504,
  REQUEST_ABORTED: 499, // client went away; response is never actually sent
  UPSTREAM_HTTP_ERROR: 502,
  INVALID_MANIFEST: 502,
  INVALID_MPD: 502,
  MANIFEST_TOO_LARGE: 502,
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

// Wraps a route handler with a per-request AbortController:
//  - abort if the client disconnects before we've responded
//  - abort after REQUEST_DEADLINE_MS as a hard ceiling
// The handler gets (req, res, signal) and must thread `signal` into analyze() /
// sampleStream() so in-flight fetches and child processes are actually killed -
// otherwise "we stopped waiting" doesn't mean "the work stopped".
function withRequestAbort(handler) {
  return async (req, res) => {
    const controller = new AbortController();
    // One analysis makes ~15 fetches, each briefly composing this signal via
    // AbortSignal.any(); raise the ceiling so that never logs a warning.
    setMaxListeners(50, controller.signal);
    const deadline = setTimeout(() => {
      controller.abort(new AppError('REQUEST_TIMEOUT', `Analysen översteg ${REQUEST_DEADLINE_MS / 1000} s och avbröts.`));
    }, REQUEST_DEADLINE_MS);
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new AppError('REQUEST_ABORTED', 'Klienten avbröt anslutningen.'));
    };
    res.once('close', onClose);
    try {
      await handler(req, res, controller.signal);
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      sendError(res, controller.signal.aborted && controller.signal.reason instanceof AppError ? controller.signal.reason : err);
    } finally {
      clearTimeout(deadline);
      res.off('close', onClose);
    }
  };
}

// -----------------------------------------------------------------------
// API routes
// -----------------------------------------------------------------------

app.post(
  '/api/analyze',
  jobGuard,
  withRequestAbort(async (req, res, signal) => {
    const url = validateUrl(req.body?.url ?? req.query.url);
    res.json(await analyze(url, { signal }));
  })
);

app.get(
  '/api/sample',
  jobGuard,
  withRequestAbort(async (req, res, signal) => {
    const url = validateUrl(req.query.url);
    res.json(await sampleStream(url, req.query.secs, { signal }));
  })
);

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
