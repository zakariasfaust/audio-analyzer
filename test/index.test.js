// index.test.js
// The one thing nothing else in this suite exercises: server/index.js itself -
// actual HTTP requests against the real Express app (routing, validation wiring,
// the SSRF guard, jobGuard, the error-code→status mapping). Every other test file
// covers the pure functions these routes call; this is the wiring between them.
//
// Deliberately thin, and deliberately offline-safe: no test here depends on a real
// stream being reachable (this sandbox and CI both have no outbound network), and
// nothing spawns real ffmpeg/ffprobe (the server itself only warns, never refuses to
// boot, when they're missing - confirmed by reading server/index.js's startup log).
// The server runs as a real child process (`node server/index.js`), not an import -
// plain fetch() against it, no new test-framework dependency.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let child;
let baseUrl;

before(async () => {
  child = spawn('node', ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // 0: ask the OS for a free ephemeral port, so this test never collides with
      // anything else already running (see envNumber() in server/config.js - PORT=0
      // used to be silently ignored by the old `Number(x) || 8877` parsing).
      PORT: '0',
      HOST: '127.0.0.1',
      // Low on purpose: the jobGuard test below needs a ceiling small enough to
      // trip with a handful of concurrent requests, not the production default.
      MAX_CONCURRENT_JOBS: '2',
      // Small enough that a tiny test body trips the upload size limit.
      MAX_UPLOAD_BYTES: '64',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseUrl = await new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk.toString();
      // Printed synchronously at the top of the listen callback, before the async
      // ffmpeg/ffprobe availability check - the server is already accepting
      // connections by the time this line appears, regardless of whether those
      // binaries are installed on the machine running the test.
      const match = buffered.match(/Audio-analyzer körs på (http:\/\/[^\s]+)/);
      if (match) {
        child.stdout.off('data', onData);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited early (code ${code}): ${buffered}`)));
    setTimeout(() => reject(new Error('server did not start within 5s: ' + buffered)), 5000).unref();
  });
});

after(() => {
  child?.kill();
});

async function postAnalyze(url) {
  const res = await fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: await res.json() };
}

async function postFile(body, name = 'x.wav') {
  const res = await fetch(`${baseUrl}/api/analyze-file?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    duplex: 'half',
  });
  return { status: res.status, body: await res.json() };
}

// --------------------------------------------------------------------------
// Validation - the route wiring in front of validateUrl()
// --------------------------------------------------------------------------

test('POST /api/analyze rejects a missing url with 400 VALIDATION_ERROR', async () => {
  const { status, body } = await postAnalyze(undefined);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.match(body.error.message, /saknas/);
});

test('POST /api/analyze rejects an unparseable url with 400 VALIDATION_ERROR', async () => {
  const { status, body } = await postAnalyze('not a url');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('POST /api/analyze rejects a non-http(s) scheme with 400', async () => {
  const { status, body } = await postAnalyze('file:///etc/passwd');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.match(body.error.message, /http/);
});

test('GET /api/sample rejects a missing url the same way', async () => {
  const res = await fetch(`${baseUrl}/api/sample`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

// --------------------------------------------------------------------------
// SSRF guard, wired into the live route (not just unit-tested in isolation)
// --------------------------------------------------------------------------

test('POST /api/analyze blocks a localhost target with 400 HOST_BLOCKED', async () => {
  // The literal-hostname check in assertPublicHost() - no DNS lookup needed, so
  // this resolves fast and deterministically, unlike a private-IP-via-DNS case.
  const { status, body } = await postAnalyze('http://localhost/stream.m3u8');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'HOST_BLOCKED');
});

// --------------------------------------------------------------------------
// Every error response shares one envelope shape
// --------------------------------------------------------------------------

test('every error response has the {error:{code,message,details}} shape', async () => {
  const { body } = await postAnalyze(undefined);

  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.details, 'object');
});

// --------------------------------------------------------------------------
// 404 catch-all
// --------------------------------------------------------------------------

test('an unknown /api/* route returns 404 NOT_FOUND', async () => {
  const res = await fetch(`${baseUrl}/api/does-not-exist`);
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

// --------------------------------------------------------------------------
// jobGuard - the concurrency ceiling, tripped for real
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// /api/analyze-file - the upload route's guards, without ffmpeg
// --------------------------------------------------------------------------

test('POST /api/analyze-file rejects a body over MAX_UPLOAD_BYTES with 413 UPLOAD_REJECTED', async () => {
  const { status, body } = await postFile(Buffer.alloc(4096, 1)); // 4 KB > the 64 B test cap

  assert.equal(status, 413);
  assert.equal(body.error.code, 'UPLOAD_REJECTED');
});

test('POST /api/analyze-file rejects an empty body readably', async () => {
  const { status, body } = await postFile('');

  assert.equal(status, 413);
  assert.equal(body.error.code, 'UPLOAD_REJECTED');
  assert.equal(typeof body.error.message, 'string');
});

test('jobGuard returns 503 BUSY with Retry-After once the concurrency ceiling is hit', async () => {
  // .invalid is a reserved TLD (RFC 2606) that never resolves - each request holds
  // its jobGuard slot for the DNS-failure window, the same technique used to
  // verify this by hand earlier in the project (against MAX_CONCURRENT_JOBS=2).
  const results = await Promise.all([
    postAnalyze('https://one.invalid/stream.m3u8'),
    postAnalyze('https://two.invalid/stream.m3u8'),
    postAnalyze('https://three.invalid/stream.m3u8'),
  ]);

  const busy = results.filter((r) => r.status === 503);
  assert.equal(busy.length, 1, `expected exactly one 503, got statuses: ${results.map((r) => r.status)}`);
  assert.equal(busy[0].body.error.code, 'BUSY');
  assert.equal(busy[0].retryAfter, '10');
});
