// healthcheck.js
// The Docker HEALTHCHECK probe. Confirms the process is not just alive but
// actually answering HTTP requests - a process that's running but wedged (the
// OOM-adjacent failure mode this project has already hit once, see the
// 2026-09-03 incident in the project history) would otherwise look "healthy" to
// Docker forever, since the process itself never exits. Plain node:http, no
// extra OS package (curl/wget) needed in the Alpine image just for this.
//
// Run directly by the Dockerfile's HEALTHCHECK instruction, not imported by
// anything else - a standalone script that exits 0 (healthy) or 1 (unhealthy).

import http from 'node:http';
import { envNumber } from './config.js';

const port = envNumber('PORT', 8877);

const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
  // Any response the static file server manages to send back proves the HTTP
  // server itself is alive and answering - this deliberately does not exercise
  // /api/analyze or ffmpeg, which need a real target stream and would make the
  // healthcheck itself a source of load and false negatives.
  res.resume(); // drain the response so the socket can close cleanly
  process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
req.on('error', () => process.exit(1));
