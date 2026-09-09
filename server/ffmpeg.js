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

// ---------------------------------------------------------------------------
// Loudness: EBU R128 integrated loudness and true peak, plus silence detection.
//
// One extra ffmpeg pass over the sample file sampleStream() has already recorded,
// run before that file is cleaned up. Deliberately a separate pass rather than
// filters bolted onto the recording itself, so "the recording failed" and "the
// measurement failed" stay two different answers.
// ---------------------------------------------------------------------------

// Anything quieter than this, for at least this long, counts as silence. -50 dB is
// below the noise floor of a real broadcast chain but well above digital zero, so a
// dead source still feeding hiss or encoder noise is caught too - which is the case
// that matters, since a listener hears both as dead air.
export const SILENCE_NOISE_DB = -50;
// Deliberately short. The stream log stitches silence across consecutive recordings,
// and a stretch that starts 0.6 s before a recording ends has to be reported for that
// stitch to work - with the old 2 s minimum it was dropped, and a true 20 s silence
// measured as 18. Short musical gaps still get reported now, but they are filtered by
// total length where the user sets the threshold, not silently here.
export const SILENCE_MIN_DURATION_SEC = 0.5;

/**
 * silencedetect writes one line per event and does not pair them up:
 *
 *   [Parsed_silencedetect_0 @ ...] silence_start: 2.023197
 *   [Parsed_silencedetect_0 @ ...] silence_end: 5.023265 | silence_duration: 3.000068
 *
 * The two filters interleave unpredictably - the ebur128 summary can land between a
 * start and its own end - so each pattern is matched globally over the whole string
 * and the lists are paired by index, never by how close two lines happen to sit.
 *
 * A silence still running when the sample window ends has a start and no end. That
 * is reported as endSec/durationSec = null rather than guessed at, because "still
 * silent when we stopped listening" is a different fact from a measured length.
 */
export function parseSilenceDetect(stderr) {
  const text = String(stderr || '');
  const starts = [...text.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*(-?[\d.]+)/g)].map((m) => ({
    endSec: Number(m[1]),
    durationSec: Number(m[2]),
  }));

  return starts.map((startSec, i) => ({
    startSec,
    endSec: i < ends.length ? ends[i].endSec : null,
    durationSec: i < ends.length ? ends[i].durationSec : null,
  }));
}

// The summary block, written once at EOF because of framelog=quiet:
//
//   [Parsed_ebur128_1 @ ...] Summary:
//
//     Integrated loudness:
//       I:         -21.4 LUFS
//     ...
//     True peak:
//       Peak:      -18.1 dBFS
//
// Only the two values this tool reports are pulled out. ebur128 prints the loudness
// range too and there is no way to turn it off - it is ignored on purpose: LRA over a
// few seconds says little, and the stream log graphs level and peak only.
//
// Each value is matched from the start of its own line, so the "True peak:" heading
// cannot be mistaken for the "Peak:" value below it.
const EBUR128_FIELD_PATTERNS = {
  integratedLufs: /^[ \t]*I:[ \t]*(-?[\d.]+|-?inf|-?nan)[ \t]*LUFS/im,
  truePeakDbfs: /^[ \t]*Peak:[ \t]*(-?[\d.]+|-?inf|-?nan)[ \t]*dBFS/im,
};

// "-inf" and "nan" are not numbers and must not reach JSON: JSON.stringify(-Infinity)
// is null, so an unmapped -Infinity would arrive at the frontend indistinguishable
// from "we never measured this". Mapped to null here on purpose - the -inf case is
// kept separately as truePeakIsSilent below.
function toFiniteNumber(raw) {
  if (raw === null) return null;
  if (raw === 'inf' || raw === '-inf' || raw === 'nan' || raw === '-nan') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Anchor on the filter's own log prefix rather than a bare "Summary:", which a
// stream title or a metadata line echoed by ffmpeg could also contain.
function findEbur128SummaryIndex(text) {
  const tagged = text.match(/\[Parsed_ebur128[^\]]*\][ \t]*Summary:/);
  return tagged ? tagged.index : text.indexOf('Summary:');
}

export function parseEbur128Summary(stderr) {
  const text = String(stderr || '');
  const summaryAt = findEbur128SummaryIndex(text);

  if (summaryAt === -1) {
    return {
      available: false,
      integratedLufs: null,
      truePeakDbfs: null,
      truePeakIsSilent: false,
    };
  }

  const block = text.slice(summaryAt);
  const raw = {};
  for (const [field, pattern] of Object.entries(EBUR128_FIELD_PATTERNS)) {
    const match = block.match(pattern);
    raw[field] = match ? match[1].toLowerCase() : null;
  }

  return {
    available: true,
    integratedLufs: toFiniteNumber(raw.integratedLufs),
    truePeakDbfs: toFiniteNumber(raw.truePeakDbfs),
    // Digital silence reports "Peak: -inf dBFS". That is "no signal at all", not
    // "not measured", and both are null above - so the difference is kept here.
    truePeakIsSilent: raw.truePeakDbfs === '-inf',
  };
}

/**
 * Measures EBU R128 loudness and finds silent stretches in an already-recorded
 * local file.
 *
 * Only ever point this at a file we wrote ourselves: the input is pinned to the
 * `file` protocol, which is both what a local path needs and what stops a crafted
 * recording from steering ffmpeg back out onto the network.
 */
export async function measureLoudness(filePath, { signal } = {}) {
  const filterChain =
    `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DURATION_SEC},` +
    'ebur128=peak=true:framelog=quiet';

  const args = [
    '-hide_banner',
    '-nostats',
    '-protocol_whitelist', 'file',
    '-i', filePath,
    // framelog=quiet is load-bearing: without it ebur128 logs a line every ~100 ms
    // and only the closing summary is of any use to us.
    '-af', filterChain,
    '-f', 'null', // measure only; nothing is written back out
    '-',
  ];

  // Every other ffprobe/ffmpeg call here runs quiet and reads JSON from stdout. This
  // one must not: both filters report through av_log on *stderr* and have no JSON
  // form at all, so the log level is left alone and stderr is what gets parsed.
  const { code, stderr, timedOut } = await runChildProcess('ffmpeg', args, { timeoutMs: TIMEOUT_MS, signal });

  if (timedOut) {
    throw new FfmpegError(stderr, `Ljudnivåmätningen blev inte klar inom ${TIMEOUT_MS / 1000} sekunder.`);
  }

  const summary = parseEbur128Summary(stderr);
  const silence = parseSilenceDetect(stderr);

  // A partial result is still worth having: silence data without an ebur128 summary
  // answers "was there dead air", which is the question this feature exists for.
  // Only when neither filter said anything at all is this a failed measurement.
  if (!summary.available && silence.length === 0) {
    // Not the exit code: ffmpeg returns its errors negative, which Node surfaces on
    // Windows as numbers like 4294967294 - noise in a sentence a user reads. The
    // actual reason is ffmpeg's own stderr, which FfmpegError carries in details.
    throw new FfmpegError(stderr, 'ffmpeg kunde inte mäta ljudnivån på det inspelade provet.');
  }

  return {
    ...summary,
    silence,
    // Echoed back so the frontend can state the thresholds it is reporting against
    // instead of the user having to take "silence" on faith.
    noiseThresholdDb: SILENCE_NOISE_DB,
    minSilenceDurationSec: SILENCE_MIN_DURATION_SEC,
  };
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

    const [probeRes, framesRes, loudnessOutcome] = await Promise.all([
      runChildProcess('ffprobe', probeArgs, { signal }),
      runChildProcess('ffprobe', framesArgs, { signal }),
      // Isolated on purpose: a failed loudness pass must not take the recording's
      // own numbers (bitrate, container, ID3) down with it - the same split
      // analyze() already uses for its per-step errors.
      measureLoudness(tempFile, { signal }).then(
        (value) => ({ ok: true, value }),
        (err) => ({ ok: false, err })
      ),
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

    // Reported next to the result rather than as a failure of the whole sample:
    // loudness is one of several things this response carries, and the rest of it
    // is still true when the measurement is the part that broke.
    const errors = {};
    let loudness = null;
    if (loudnessOutcome.ok) {
      loudness = loudnessOutcome.value;
    } else if (signal?.aborted) {
      // The two ffprobes usually finish first and carry an abort out of Promise.all
      // on their own - but if the measurement is the last one still running, the
      // abort would land here and be filed as "loudness failed". It is the opposite:
      // the whole sample is moot, so it propagates (REQUEST_TIMEOUT or the client
      // having gone away, whichever aborted the request).
      throw loudnessOutcome.err;
    } else {
      errors.loudness = {
        message: loudnessOutcome.err.message,
        code: loudnessOutcome.err.code || 'UNKNOWN',
        details: loudnessOutcome.err.details,
      };
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
      // When this recording started, by the server's clock. The log maps silence
      // offsets onto it, so it is the difference between "silent somewhere in this
      // poll" and "silent from 10:03:14 to 10:03:37". Note this is when we started
      // connecting: a live stream is inherently some seconds behind the broadcast,
      // so these are the times we *heard* it, not the times it was transmitted.
      recordedAt: new Date(recordStartMs).toISOString(),
      actualDurationSec,
      recordWallSec,
      connectBurstSec,
      burstIsLowerBound,
      fileSizeBytes,
      measuredBitrateKbps,
      streams: simplifyProbeResult(probeJson),
      loudness,
      id3: {
        // `available: false` means "we looked and found none". `warnings` says
        // whether we were actually able to look - the frontend renders both.
        available: frames.length > 0,
        frames,
      },
      warnings,
      errors,
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
