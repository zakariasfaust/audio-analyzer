// index.js
// Express app: static frontend files + a JSON API that fetches from CDNs
// and runs ffprobe/ffmpeg. Binds to 127.0.0.1 by default - this tool is
// meant to run locally - set HOST=0.0.0.0 explicitly to expose it on the
// network (e.g. behind a reverse proxy).

import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setMaxListeners } from 'node:events';

import { AppError } from './errors.js';
import { validateUrl } from './net.js';
import { sampleStream, checkBinaryAvailable } from './ffmpeg.js';
import { analyze } from './analyzer.js';
import { analyzeAudioFile, sanitizeUploadName, saveRequestBodyToFile } from './file.js';
import { fetchIcyMetadata } from './icecast.js';
import { readMemorySnapshot, evaluateJobCapacity } from './resourceGuard.js';
import {
  envNumber,
  MAX_CONCURRENT_FILE_JOBS,
  MAX_CONCURRENT_JOBS,
  MAX_UPLOAD_BYTES,
  REQUEST_DEADLINE_MS,
  FILE_REQUEST_DEADLINE_MS,
  MEMORY_RATIO_THRESHOLD,
  MAX_RSS_BYTES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
} from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// envNumber, not `Number(x) || default`: the latter treats an explicit "0" as unset,
// which would silently ignore PORT=0 - the standard way to ask the OS for a free
// ephemeral port (used by test/index.test.js so it never collides with anything).
const PORT = envNumber('PORT', 8877);
const HOST = process.env.HOST || '127.0.0.1';
// Number of reverse-proxy hops to trust for X-Forwarded-For. Off unless set - see
// where it is applied below for why the default matters.
const TRUST_PROXY = envNumber('TRUST_PROXY', false);

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
// The only JSON body this app takes is {url}, so the limit is deliberately tiny. It is
// spelled out rather than left at the 100 KB default because express answers an oversize
// body through its own error handler, in its own shape - see the JSON-parse branch in
// sendError(), which converts that back into this app's envelope.
app.use(express.json({ limit: '16kb' }));
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
// the pile-up. Two independent reasons to reject: too many jobs already running
// (a flat backstop against runaway fan-out), or too little memory headroom left
// right now (the adaptive check - a stream log holds a slot for nearly its whole
// lifetime, so "legitimate use never approaches the limit" stopped being true the
// day continuous logging shipped; several concurrent logs is the expected case).
let activeJobs = 0;
// File analyses are counted a second time, against their own much smaller ceiling. A
// stream job costs a 15-second recording; a file job holds up to MAX_UPLOAD_BYTES of
// temp disk for minutes, so the 12 slots sized for stream logs are the wrong budget for
// it - see MAX_CONCURRENT_FILE_JOBS.
let activeFileJobs = 0;

function makeJobGuard({ isFileJob = false } = {}) {
  return function jobGuard(req, res, next) {
    // Reading memory is a virtual-procfs read (or a no-op RSS lookup) - cheap, but
    // pointless when a count alone would already reject, so it only runs when the
    // count checks would otherwise let the request through.
    const countWouldPass = activeJobs < MAX_CONCURRENT_JOBS && !(isFileJob && activeFileJobs >= MAX_CONCURRENT_FILE_JOBS);
    const memorySnapshot = countWouldPass ? readMemorySnapshot() : null;
    const decision =
      isFileJob && activeFileJobs >= MAX_CONCURRENT_FILE_JOBS
        ? {
            allowed: false,
            reason: 'file-concurrency',
            detail: { activeFileJobs, maxConcurrentFileJobs: MAX_CONCURRENT_FILE_JOBS },
          }
        : evaluateJobCapacity({
            activeJobs,
            maxConcurrentJobs: MAX_CONCURRENT_JOBS,
            memorySnapshot,
            memoryRatioThreshold: MEMORY_RATIO_THRESHOLD,
            maxRssBytes: MAX_RSS_BYTES,
          });

    if (!decision.allowed) {
      // The one piece of observability the 2026-09-03 OOM postmortem flagged as
      // wanted and never built: exactly why a request was turned away, on demand
      // rather than as a constant-noise timer.
      console.warn(`jobGuard: avvisade begäran (${decision.reason})`, decision.detail);
      res.set('Retry-After', '10');
      res.status(503).json({
        error: {
          code: 'BUSY',
          message: 'Servern kör redan så många analyser den tar samtidigt. Försök igen om en liten stund.',
          // Not read by the client - it only branches on the code above - but worth
          // having in the response for anyone debugging with the network tab open.
          details: { reason: decision.reason },
        },
      });
      return;
    }
    activeJobs++;
    if (isFileJob) activeFileJobs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeJobs--;
      if (isFileJob) activeFileJobs--;
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

const jobGuard = makeJobGuard();
const fileJobGuard = makeJobGuard({ isFileJob: true });

// -----------------------------------------------------------------------
// Error responses: maps our own error classes (see analyzer.js) to HTTP status
// codes and a uniform JSON error format that the frontend can display directly.
// -----------------------------------------------------------------------

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
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
  UPLOAD_REJECTED: 413,
  NOT_AUDIO_FILE: 415,
};

function sendError(res, err) {
  // body-parser rejects a malformed or oversize JSON body with its own error, which
  // would otherwise reach the client as express's HTML error page - the frontend calls
  // res.json() on every response, so it would read as "could not reach the server"
  // rather than as the validation failure it is.
  if (err?.type === 'entity.too.large' || err?.type === 'entity.parse.failed') {
    const tooLarge = err.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? 'UPLOAD_REJECTED' : 'VALIDATION_ERROR',
        message: tooLarge ? 'Förfrågan är för stor.' : 'Förfrågans JSON gick inte att tolka.',
        details: {},
      },
    });
    return;
  }
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
function withRequestAbort(handler, { deadlineMs = REQUEST_DEADLINE_MS } = {}) {
  return async (req, res) => {
    const controller = new AbortController();
    // One analysis makes ~15 fetches, each briefly composing this signal via
    // AbortSignal.any(); raise the ceiling so that never logs a warning.
    setMaxListeners(50, controller.signal);
    const deadline = setTimeout(() => {
      controller.abort(new AppError('REQUEST_TIMEOUT', `Analysen översteg ${Math.round(deadlineMs / 1000)} s och avbröts.`));
    }, deadlineMs);
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

    // Icecast/SHOUTcast carry "now playing" in an in-stream ICY block, not in the
    // audio. The sample is re-muxed to MPEG-TS by ffmpeg and the block does not
    // survive that, so the stream log asks for it explicitly with ?icy=1. It is one
    // extra cheap GET run alongside the recording, not after it, so it costs no
    // wall-clock time and no second job slot.
    const wantIcy = req.query.icy === '1';
    const [sample, icy] = await Promise.all([
      sampleStream(url, req.query.secs, { signal }),
      // A missing title is not an error - plenty of stations send none. An abort
      // still surfaces, because the recording running beside this rejects on it too.
      wantIcy ? fetchIcyMetadata(url, { signal }).catch(() => null) : Promise.resolve(null),
    ]);

    if (icy) {
      sample.station = {
        nowPlaying: icy.streamTitle || null,
        icyMetadataSupported: Boolean(icy.icyMetadataSupported),
      };
    }
    res.json(sample);
  })
);

// Analyse an uploaded audio file. The file arrives as the raw request body (the
// client sets Content-Type: application/octet-stream), streamed straight to a temp
// file with a size cap - no multipart parser, nothing buffered in memory. `?name=`
// is the original filename, for display only. Same jobGuard as the two stream
// routes (it spawns ffprobe/ffmpeg); its own, much longer deadline because
// decoding a full track is minutes, not the ~90 s a stream analysis needs.
app.post(
  '/api/analyze-file',
  fileJobGuard,
  withRequestAbort(
    async (req, res, signal) => {
      const tempFile = path.join(os.tmpdir(), `audio-analyzer-upload-${randomUUID()}`);
      try {
        await saveRequestBodyToFile(req, tempFile, MAX_UPLOAD_BYTES, signal);
        res.json(await analyzeAudioFile(tempFile, sanitizeUploadName(req.query.name), { signal }));
      } finally {
        await fs.unlink(tempFile).catch(() => {});
      }
    },
    { deadlineMs: FILE_REQUEST_DEADLINE_MS }
  )
);

app.use('/api', (req, res) => {
  // Through sendError like every other error response, rather than a hand-built
  // envelope - same {error:{code,message}} shape, one place that decides it.
  sendError(res, new AppError('NOT_FOUND', `Okänd API-route: ${req.path}`));
});

// Anything that reaches express's own error path rather than a route's try/catch -
// in practice a body-parser rejection, which happens before any handler runs. Without
// this it would be answered with express's HTML error page, and the frontend (which
// calls res.json() on every response) would report it as the server being unreachable.
// eslint-disable-next-line no-unused-vars -- express identifies an error handler by arity
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  sendError(res, err);
});

// Every temp file this app writes is deleted in a `finally` - which does not run when
// the process is killed outright, and this one has been OOM-killed before. Without a
// sweep those files stay in the system temp directory for good: uploaded masters and
// recorded stream samples, on disk, indefinitely. An hour is far past any live job
// (the longest deadline is 11 minutes), so nothing in flight is ever caught by this.
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

async function sweepStaleTempFiles() {
  const dir = os.tmpdir();
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
  let removed = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith('audio-analyzer-')) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(full);
          removed++;
        }
      } catch {
        // Gone already, or owned by another instance sharing this tmpdir - skip it.
      }
    }
  } catch (err) {
    console.warn(`Kunde inte städa temporärfiler i ${dir}: ${err.message}`);
    return;
  }
  if (removed) console.log(`Städade ${removed} kvarglömd(a) temporärfil(er) från ${dir}.`);
}

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

const server = app.listen(PORT, HOST, async () => {
  // server.address().port, not the PORT constant: with PORT=0 (ask the OS for a
  // free ephemeral port - what test/index.test.js does, to never collide with
  // anything already running) PORT is still literally 0 here, and logging that
  // instead of the port actually bound would be actively misleading.
  const boundPort = server.address().port;
  console.log(`Audio-analyzer körs på http://${HOST}:${boundPort}`);

  // Which memory source jobGuard actually resolved to is not obvious from the
  // outside (Railway's cgroup version isn't documented anywhere), and it decides
  // which of MEMORY_RATIO_THRESHOLD/MAX_RSS_BYTES is even in effect - worth
  // knowing at a glance in the deploy log rather than inferred from behaviour.
  const boot = readMemorySnapshot();
  const memoryLine =
    boot.source === 'rss'
      ? `minneskälla=rss, gräns=${MAX_CONCURRENT_JOBS} jobb, RSS-tak=${Math.round(MAX_RSS_BYTES / 1024 / 1024)} MB`
      : `minneskälla=${boot.source}, gräns=${MAX_CONCURRENT_JOBS} jobb, minneströskel=${Math.round(MEMORY_RATIO_THRESHOLD * 100)}%`;
  console.log(`Resursvakt: ${memoryLine}, varav ${MAX_CONCURRENT_FILE_JOBS} filanalyser`);

  await sweepStaleTempFiles();

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
