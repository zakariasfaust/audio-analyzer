// ffmpeg.js
// Running ffprobe/ffmpeg as child processes: the spawn wrapper that owns timeouts,
// abort handling and output caps, plus the two things we actually ask them to do
// (probe a stream, record a short sample).
//
// These two are the reason this app needs a backend at all, and also its sharpest
// edge: they are handed URLs from the internet, they resolve and connect outside
// Node, and they follow the manifests they are given. Hence the protocol whitelist
// and the failClosed SSRF check below.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CHILD_SIGKILL_GRACE_MS,
  MAX_CHILD_OUTPUT_BYTES,
  MAX_SAMPLE_FILE_BYTES,
  TIMEOUT_MS,
  USER_AGENT,
} from './config.js';
import { AppError, BinaryMissingError, FfmpegError, FfprobeError, RequestAbortedError, TimeoutError } from './errors.js';
import { assertPublicHost } from './net.js';

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

export function simplifyProbeResult(probeJson) {
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

// ffprobe/ffmpeg are pointed at manifests we do not control, and both demuxers
// resolve the URIs *inside* those manifests themselves, outside anything Node can
// see. Pinning the whitelist keeps that resolution on the protocols we meant to
// allow - note the absence of `file`, which is what a hostile manifest pointing its
// segments at a local path would need. `crypto` stays for AES-128 HLS, `data` for
// inline DASH init segments.
const FFMPEG_PROTOCOL_ARGS = ['-protocol_whitelist', 'http,https,tcp,tls,crypto,data'];

/**
 * Runs ffprobe against a URL (master or media - ffmpeg's HLS demuxer handles both)
 * and returns both the raw data and a simplified summary of the audio track.
 */
export async function runFfprobe(url, { signal } = {}) {
  signal?.throwIfAborted?.();
  await assertPublicHost(url, { failClosed: true });

  const args = [
    '-v', 'quiet',
    '-user_agent', USER_AGENT,
    ...FFMPEG_PROTOCOL_ARGS,
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
export async function sampleStream(url, requestedSeconds = 8, { signal } = {}) {
  signal?.throwIfAborted?.();
  await assertPublicHost(url, { failClosed: true });

  const secs = Math.min(15, Math.max(1, Number(requestedSeconds) || 8));
  const tempFile = path.join(os.tmpdir(), `audio-analyzer-${randomUUID()}.ts`);

  const ffmpegArgs = [
    '-y',
    '-user_agent', USER_AGENT,
    ...FFMPEG_PROTOCOL_ARGS,
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
    // -v error, not -v quiet: stdout stays clean JSON either way, but when one of
    // these fails we want a reason to put in `warnings` below rather than silence.
    const probeArgs = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', tempFile];
    const framesArgs = [
      '-v', 'error',
      '-print_format', 'json',
      '-select_streams', 'd',
      '-show_frames',
      tempFile,
    ];

    const [probeRes, framesRes] = await Promise.all([
      runChildProcess('ffprobe', probeArgs, { signal }),
      runChildProcess('ffprobe', framesArgs, { signal }),
    ]);

    // A tool failure must not silently become a statement about the stream: without
    // these warnings, unparseable ffprobe output rendered as "no ID3 metadata found
    // in this stream", which is a claim we have no basis for.
    const warnings = [];

    let probeJson = {};
    try {
      probeJson = JSON.parse(probeRes.stdout);
    } catch {
      warnings.push({
        step: 'probe',
        message: `ffprobe svarade inte med tolkbar JSON (slutkod ${probeRes.code}). ${(probeRes.stderr || '').slice(0, 300)}`.trim(),
      });
    }

    let framesJson = {};
    try {
      framesJson = JSON.parse(framesRes.stdout);
    } catch {
      warnings.push({
        step: 'frames',
        message: `Metadataramarna kunde inte läsas (slutkod ${framesRes.code}). ${(framesRes.stderr || '').slice(0, 300)}`.trim(),
      });
    }

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
        // `available: false` means "we looked and found none". `warnings` says
        // whether we were actually able to look - the frontend renders both.
        available: frames.length > 0,
        frames,
      },
      warnings,
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
