// index.js
// Express app: static frontend files + a JSON API that fetches from CDNs
// and runs ffprobe/ffmpeg. Binds to 127.0.0.1 by default - this tool is
// meant to run locally - set HOST=0.0.0.0 explicitly to expose it on the
// network (e.g. behind a reverse proxy).

import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMaxListeners } from 'node:events';

import { AppError } from './errors.js';
import { validateUrl } from './net.js';
import { sampleStream, checkBinaryAvailable } from './ffmpeg.js';
import { analyze } from './analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8877;
const HOST = process.env.HOST || '127.0.0.1';
// Number of reverse-proxy hops to trust for X-Forwarded-For. Off unless set - see
// where it is applied below for why the default matters.
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || false;
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
// Trusting X-Forwarded-For means believing whoever sent it. Behind the deployment's
// reverse proxy that is right (TRUST_PROXY=1 - trust exactly one hop, so the rate
// limiter keys on the real client IP). With nothing in front, it hands every caller
// a free rate-limit bypass: send a random X-Forwarded-For per request and the per-IP
// window never fills. So it is opt-in, and off by default.
app.set('trust proxy', TRUST_PROXY);
// The page loads no external scripts, styles, fonts or images, so a strict CSP costs
// nothing here - and it is the second layer under safeHttpUrl() in public/app.js,
// since this UI renders remote-controlled strings through innerHTML throughout.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use(
  '/api',
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX, // `max` is the deprecated spelling in express-rate-limit v7+

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
  UPSTREAM_UNREACHABLE: 502,
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

// A single stray rejection anywhere in the analysis chain would otherwise take the
// whole process down and drop every in-flight request with it. Log and keep serving;
// an uncaught *exception* leaves unknown state, so that one still exits - but
// deliberately, after the reason has been written somewhere.
process.on('unhandledRejection', (reason) => {
  console.error('Ohanterad promise-rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Ohanterat undantag - avslutar:', err);
  process.exit(1);
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
