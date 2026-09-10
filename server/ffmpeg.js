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
  FILE_ANALYSIS_MAX_SECONDS,
  FILE_ANALYSIS_MAX_STDERR_BYTES,
  FILE_ANALYSIS_TIMEOUT_MS,
  MAX_CHILD_OUTPUT_BYTES,
  MAX_SAMPLE_FILE_BYTES,
  SPECTROGRAM_MAX_SECONDS,
  TIMEOUT_MS,
  USER_AGENT,
} from './config.js';
import { AppError, BinaryMissingError, FfmpegError, FfprobeError, RequestAbortedError, TimeoutError } from './errors.js';
import { assertPublicHost } from './net.js';

function runChildProcess(command, args, { timeoutMs = TIMEOUT_MS, signal, maxOutputBytes = MAX_CHILD_OUTPUT_BYTES } = {}) {
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
      if (stdout.length + chunk.length <= maxOutputBytes) stdout += chunk;
      else stdoutCapped = true;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length + chunk.length <= maxOutputBytes) stderr += chunk;
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
 * ffprobe against a local file we wrote ourselves (an upload). Same JSON as
 * runFfprobe but: no assertPublicHost (there is no host), `file` is the only
 * protocol allowed, and it asks for chapters + disposition + tags too - the
 * things the uploaded-file view surfaces that a stream analysis never needed.
 */
export async function runFfprobeFile(filePath, { signal } = {}) {
  signal?.throwIfAborted?.();

  const args = [
    '-v', 'error',
    '-protocol_whitelist', 'file',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-show_entries', 'stream_disposition:stream_tags:format_tags',
    filePath,
  ];

  const { code, stdout, stderr, timedOut } = await runChildProcess('ffprobe', args, { signal });

  if (timedOut) throw new TimeoutError(filePath);
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

// The summary block, written once at EOF (framelog=quiet), or after the last frame
// line (framelog=info):
//
//   [Parsed_ebur128_1 @ ...] Summary:
//
//     Integrated loudness:
//       I:         -21.4 LUFS
//     Loudness range:
//       LRA:        21.6 LU
//       LRA low:   -47.8 LUFS
//       LRA high:  -26.2 LUFS
//     Sample peak:            <- only present with peak=sample; comes BEFORE True peak
//       Peak:      -25.5 dBFS
//     True peak:
//       Peak:      -18.1 dBFS
//
// The stream path (measureLoudness, peak=true only) wants just integrated + true
// peak and gets exactly that shape. The file path passes { extended:true } for LRA
// and sample peak too. Either way `truePeakDbfs` is anchored to the "True peak:"
// heading, never "the first Peak: line" - which would be the sample peak.
const NUM = '(-?[\\d.]+|-?inf|-?nan)';
const RE_INTEGRATED = new RegExp(`^[ \\t]*I:[ \\t]*${NUM}[ \\t]*LUFS`, 'im');
const RE_LRA = new RegExp(`^[ \\t]*LRA:[ \\t]*${NUM}[ \\t]*LU\\b`, 'im');
const RE_LRA_LOW = new RegExp(`^[ \\t]*LRA low:[ \\t]*${NUM}[ \\t]*LUFS`, 'im');
const RE_LRA_HIGH = new RegExp(`^[ \\t]*LRA high:[ \\t]*${NUM}[ \\t]*LUFS`, 'im');
const RE_PEAK_VALUE = new RegExp(`^[ \\t]*Peak:[ \\t]*${NUM}[ \\t]*dBFS`, 'im');

// "-inf" and "nan" are not numbers and must not reach JSON: JSON.stringify(-Infinity)
// is null, so an unmapped -Infinity would arrive at the frontend indistinguishable
// from "we never measured this". Mapped to null here on purpose - the -inf case is
// kept separately as *IsSilent flags below.
function toFiniteNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const lower = String(raw).toLowerCase();
  if (lower === 'inf' || lower === '-inf' || lower === 'nan' || lower === '-nan') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Anchor on the filter's own log prefix rather than a bare "Summary:", which a
// stream title or a metadata line echoed by ffmpeg could also contain.
function findEbur128SummaryIndex(text) {
  const tagged = text.match(/\[Parsed_ebur128[^\]]*\][ \t]*Summary:/);
  return tagged ? tagged.index : text.indexOf('Summary:');
}

// The raw "Peak:" token under a given "<name> peak:" heading, or null. Slices the
// block at the heading so a later heading's Peak: line is out of reach.
function peakUnderHeading(block, heading) {
  const at = block.search(new RegExp(`^[ \\t]*${heading}:[ \\t\\r]*$`, 'im'));
  if (at === -1) return null;
  const m = block.slice(at).match(RE_PEAK_VALUE);
  return m ? m[1].toLowerCase() : null;
}

export function parseEbur128Summary(stderr, { extended = false } = {}) {
  const text = String(stderr || '');
  const summaryAt = findEbur128SummaryIndex(text);

  if (summaryAt === -1) {
    const base = { available: false, integratedLufs: null, truePeakDbfs: null, truePeakIsSilent: false };
    return extended
      ? { ...base, lra: null, lraLow: null, lraHigh: null, samplePeakDbfs: null, samplePeakIsSilent: false }
      : base;
  }

  const block = text.slice(summaryAt);
  const integratedRaw = block.match(RE_INTEGRATED)?.[1]?.toLowerCase() ?? null;
  const truePeakRaw = peakUnderHeading(block, 'True peak');

  const base = {
    available: true,
    integratedLufs: toFiniteNumber(integratedRaw),
    truePeakDbfs: toFiniteNumber(truePeakRaw),
    // Digital silence reports "Peak: -inf dBFS". That is "no signal at all", not
    // "not measured", and both are null above - so the difference is kept here.
    truePeakIsSilent: truePeakRaw === '-inf',
  };

  if (!extended) return base;

  const samplePeakRaw = peakUnderHeading(block, 'Sample peak');
  return {
    ...base,
    // LRA over a 15s stream window is noise, which is why the stream path ignores
    // it - but over a whole uploaded track it is exactly the "how dynamic is this"
    // number, so the file path keeps it.
    lra: toFiniteNumber(block.match(RE_LRA)?.[1] ?? null),
    lraLow: toFiniteNumber(block.match(RE_LRA_LOW)?.[1] ?? null),
    lraHigh: toFiniteNumber(block.match(RE_LRA_HIGH)?.[1] ?? null),
    samplePeakDbfs: toFiniteNumber(samplePeakRaw),
    samplePeakIsSilent: samplePeakRaw === '-inf',
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

// ---------------------------------------------------------------------------
// Uploaded-file analysis (Fas 4).
//
// A stream gets a 15s sample; an uploaded file is finite, so it gets measured
// whole (up to FILE_ANALYSIS_MAX_SECONDS). Two decode passes, run in parallel by
// server/file.js: measureFileLoudness (loudness curve + astats + phase) and
// renderSpectrogram (the image + the lossy-source band check). Everything is
// parsed from stderr, the same way Fas 3 reads ebur128 - these filters have no
// JSON form.
// ---------------------------------------------------------------------------

// astats prints a block per channel then an "Overall" block. Crest factor and
// dynamic range are per-channel only (not in Overall), so those come from the
// first channel; everything else from Overall. `tag` pins which astats filter in
// a multi-astats graph (the spectrogram pass has more than one).
function astatsFieldsForTag(text, tag) {
  const lines = text.split('\n').filter((l) => l.includes(tag));
  if (!lines.length) return null;

  const overallAt = lines.findIndex((l) => /\]\s*Overall\s*$/.test(l));
  const readFrom = (slice, label) => {
    const re = new RegExp(`\\]\\s*${label}:\\s*(-?[\\d.]+|-?inf|-?nan)`, 'i');
    for (const line of slice) {
      const m = line.match(re);
      if (m) return toFiniteNumber(m[1]);
    }
    return null;
  };
  // "Bit depth: 10/16/16/16" - first value is bits actually exercised by the data.
  const readBitDepth = (slice) => {
    for (const line of slice) {
      const m = line.match(/\]\s*Bit depth:\s*(\d+)\/(\d+)\/(\d+)\/(\d+)/i);
      if (m) return { used: Number(m[1]), container: Number(m[4]) };
    }
    return { used: null, container: null };
  };

  const perChannel = overallAt === -1 ? lines : lines.slice(0, overallAt);
  const overall = overallAt === -1 ? lines : lines.slice(overallAt);

  const peakLevelDb = readFrom(overall, 'Peak level dB');
  const rmsLevelDb = readFrom(overall, 'RMS level dB');
  const bitDepth = readBitDepth(overall);

  return {
    dcOffset: readFrom(overall, 'DC offset'),
    peakLevelDb,
    rmsLevelDb,
    rmsPeakDb: readFrom(overall, 'RMS peak dB'),
    // ffmpeg's own label is "RMS through dB" (sic, for "trough") - match both.
    rmsTroughDb: readFrom(overall, 'RMS (?:through|trough) dB'),
    flatFactor: readFrom(overall, 'Flat factor'),
    peakCount: readFrom(overall, 'Peak count'),
    absPeakCount: readFrom(overall, 'Abs Peak count'),
    noiseFloorDb: readFrom(overall, 'Noise floor dB'),
    entropy: readFrom(overall, 'Entropy'),
    bitDepthUsed: bitDepth.used,
    bitDepthContainer: bitDepth.container,
    numberOfSamples: readFrom(overall, 'Number of samples'),
    dynamicRange: readFrom(perChannel, 'Dynamic range'),
    // Not printed in Overall; peak/RMS give it directly. crest = 10^((peak-rms)/20).
    crestFactor:
      typeof peakLevelDb === 'number' && typeof rmsLevelDb === 'number'
        ? Number(Math.pow(10, (peakLevelDb - rmsLevelDb) / 20).toFixed(3))
        : null,
  };
}

/**
 * The Overall astats of the first (or only) astats filter in a pass.
 * → { dcOffset, peakLevelDb, rmsLevelDb, rmsPeakDb, rmsTroughDb, flatFactor,
 *     peakCount, absPeakCount, noiseFloorDb, entropy, bitDepthUsed,
 *     bitDepthContainer, numberOfSamples, dynamicRange, crestFactor } | null
 */
export function parseAstats(stderr) {
  const text = String(stderr || '');
  const firstTag = text.match(/\[(Parsed_astats_\d+) @/);
  if (!firstTag) return null;
  return astatsFieldsForTag(text, firstTag[1]);
}

/**
 * The per-frame ebur128 lines (framelog=info), one every ~100ms:
 *   t: 5.999977  TARGET:-23 LUFS  M: -33.8 S: -33.8  I: -33.8 LUFS  LRA: 0.0 LU
 *   SPK: -33.1 -33.1 dBFS  FTPK: -33.1 -33.1 dBFS  TPK: -33.1 -33.1 dBFS
 * Momentary/short-term below this floor are "no signal in the window", not a real
 * quiet passage, so they become null (the chart line breaks rather than dives).
 * Downsampled to at most `maxPoints` buckets: short-term averaged, true peak maxed.
 */
export function parseEbur128Timeline(stderr, { maxPoints = 500 } = {}) {
  const text = String(stderr || '');
  const FLOOR_LUFS = -100;
  const re =
    /\bt:\s*([\d.]+)\s+TARGET:\s*-?[\d.]+\s*LUFS\s+M:\s*(-?[\d.]+|-?inf|-?nan)\s+S:\s*(-?[\d.]+|-?inf|-?nan)\s+I:\s*(-?[\d.]+|-?inf|-?nan)\s*LUFS\s+LRA:\s*(-?[\d.]+|-?inf|-?nan)\s*LU\b.*?FTPK:\s*([-\d.inf ]+?)\s*dBFS/gi;

  const raw = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const shortTerm = toFiniteNumber(m[3]);
    const ftpkParts = m[6].trim().split(/\s+/).map(toFiniteNumber).filter((v) => v !== null);
    raw.push({
      tSec: Number(Number(m[1]).toFixed(2)),
      shortTermLufs: shortTerm !== null && shortTerm > FLOOR_LUFS ? Number(shortTerm.toFixed(1)) : null,
      truePeakDbfs: ftpkParts.length ? Number(Math.max(...ftpkParts).toFixed(1)) : null,
    });
  }

  if (raw.length <= maxPoints) return raw;

  // Even-width time buckets. average() ignores nulls; a bucket with no reading at
  // all stays null so the gap survives downsampling.
  const span = raw[raw.length - 1].tSec - raw[0].tSec || 1;
  const t0 = raw[0].tSec;
  const buckets = new Array(maxPoints);
  for (const point of raw) {
    const idx = Math.min(maxPoints - 1, Math.floor(((point.tSec - t0) / span) * maxPoints));
    (buckets[idx] ||= []).push(point);
  }
  return buckets
    .map((group, idx) => {
      if (!group || !group.length) return null;
      const st = group.map((p) => p.shortTermLufs).filter((v) => v !== null);
      const tp = group.map((p) => p.truePeakDbfs).filter((v) => v !== null);
      return {
        tSec: Number((t0 + (span * (idx + 0.5)) / maxPoints).toFixed(2)),
        shortTermLufs: st.length ? Number((st.reduce((a, b) => a + b, 0) / st.length).toFixed(1)) : null,
        truePeakDbfs: tp.length ? Number(Math.max(...tp).toFixed(1)) : null,
      };
    })
    .filter((p) => p !== null);
}

/**
 * aphasemeter phasing=1 writes one line per event, unpaired, like silencedetect:
 *   [Parsed_aphasemeter_2 @ ...] mono_start: 0
 *   [Parsed_aphasemeter_2 @ ...] mono_end: 6 | mono_duration: 6
 *   [Parsed_aphasemeter_0 @ ...] out_phase_start: 0
 *   [Parsed_aphasemeter_0 @ ...] out_phase_end: 5 | out_phase_duration: 5
 * → { monoSpans: [{startSec,endSec,durationSec}], outOfPhaseSpans: [...] }
 * An open span (file ended mid-event) has endSec/durationSec = null.
 */
export function parsePhasing(stderr) {
  const text = String(stderr || '');
  const spansFor = (kind) => {
    const starts = [...text.matchAll(new RegExp(`${kind}_start:\\s*(-?[\\d.]+)`, 'g'))].map((x) => Number(x[1]));
    const ends = [...text.matchAll(new RegExp(`${kind}_end:\\s*(-?[\\d.]+)\\s*\\|\\s*${kind}_duration:\\s*(-?[\\d.]+)`, 'g'))].map((x) => ({
      endSec: Number(x[1]),
      durationSec: Number(x[2]),
    }));
    return starts.map((startSec, i) => ({
      startSec,
      endSec: i < ends.length ? ends[i].endSec : null,
      durationSec: i < ends.length ? ends[i].durationSec : null,
    }));
  };
  return { monoSpans: spansFor('mono'), outOfPhaseSpans: spansFor('out_phase') };
}

// A phase span shorter than this, once silence has been carved out of it, is not
// worth reporting to a person - the stereo image being centred for under a second
// tells you nothing.
export const MIN_PHASE_SPAN_SEC = 1;

// Remove `cuts` from `[span.start, span.end]`, returning 0+ leftover pieces.
// Infinity is a valid end (an event still open when analysis stopped).
export function subtractIntervals(span, cuts) {
  let pieces = [{ start: span.start, end: span.end }];
  for (const cut of cuts) {
    const next = [];
    for (const p of pieces) {
      if (cut.end <= p.start || cut.start >= p.end) {
        next.push(p);
        continue;
      }
      if (cut.start > p.start) next.push({ start: p.start, end: cut.start });
      if (cut.end < p.end) next.push({ start: cut.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

/**
 * aphasemeter reports the channels as "mono" whenever their correlation is exactly
 * 1.0 - which digital silence satisfies (0 == 0). So a 2 s silent lead-in reads as
 * a mono span, and an out-of-phase stretch that happens to butt against silence
 * gets reported longer than it really is. This carves the detected silent regions
 * out of every phase span and drops what's left if it is too short to matter, so
 * the phase table only ever shows stretches where there was actually audio.
 */
export function gatePhasingBySilence(phasing, silences, { minSpanSec = MIN_PHASE_SPAN_SEC } = {}) {
  const cuts = (silences || []).map((s) => ({
    start: s.startSec,
    end: s.endSec == null ? Infinity : s.endSec,
  }));

  const gate = (spans) =>
    (spans || []).flatMap((span) => {
      const end = span.endSec == null ? Infinity : span.endSec;
      return subtractIntervals({ start: span.startSec, end }, cuts)
        .filter((p) => p.end - p.start >= minSpanSec)
        .map((p) => ({
          startSec: Number(p.start.toFixed(3)),
          endSec: Number.isFinite(p.end) ? Number(p.end.toFixed(3)) : null,
          durationSec: Number.isFinite(p.end) ? Number((p.end - p.start).toFixed(3)) : null,
        }));
    });

  return {
    monoSpans: gate(phasing?.monoSpans),
    outOfPhaseSpans: gate(phasing?.outOfPhaseSpans),
  };
}

// Inter-channel correlation estimated from the mid (L+R) and side (L-R) RMS
// levels: rho = (mid^2 - side^2) / (mid^2 + side^2), which equals the true
// correlation coefficient when the two channels carry equal power (they nearly
// always do in mastered music). +1 = mono, 0 = fully decorrelated / very wide,
// negative = the channels partly cancel when summed to mono. Silence contributes
// zero energy to both mid and side, so it drops out of the ratio on its own - no
// gating needed here. Returns null when there is too little signal to judge.
export function estimateCorrelation(midRmsDb, sideRmsDb) {
  if (typeof midRmsDb !== 'number' && typeof sideRmsDb !== 'number') return null;
  // -inf (null) on one side is meaningful: side null = identical channels (+1),
  // mid null = perfect anti-phase (-1).
  const midPow = typeof midRmsDb === 'number' ? 10 ** (midRmsDb / 10) : 0;
  const sidePow = typeof sideRmsDb === 'number' ? 10 ** (sideRmsDb / 10) : 0;
  const total = midPow + sidePow;
  if (total < 1e-12) return null; // both essentially silent over the whole window
  return Number(((midPow - sidePow) / total).toFixed(2));
}

/**
 * The main file-analysis decode pass: silencedetect (gate) + astats + ebur128
 * (curve + summary) + aphasemeter, one linear chain (deterministic filter
 * indices). Bounded to FILE_ANALYSIS_MAX_SECONDS. Only ever run against a file we
 * wrote (upload) - input pinned to `file`.
 *
 * silencedetect is here only to carve silence out of the phase spans - a silent
 * lead-in otherwise reads as a "mono" stretch (correlation 1.0 == identical == what
 * 0 == 0 gives). Its own output is not reported for a file; dead-air detection is a
 * stream concern.
 *
 * → { integratedLufs, lra, lraLow, lraHigh, truePeakDbfs, truePeakIsSilent,
 *     samplePeakDbfs, plr, series, astats, phase, truncated, analyzedSeconds }
 */
export async function measureFileLoudness(filePath, { signal, durationSec = null } = {}) {
  const truncated = typeof durationSec === 'number' && durationSec > FILE_ANALYSIS_MAX_SECONDS;
  const analyzedSeconds = truncated ? FILE_ANALYSIS_MAX_SECONDS : durationSec;

  const args = [
    '-hide_banner',
    '-nostats',
    '-protocol_whitelist', 'file',
    '-t', String(FILE_ANALYSIS_MAX_SECONDS),
    '-i', filePath,
    // framelog=info (not quiet): we want the ~100ms lines for the curve. peak has
    // both sample and true so parseEbur128Summary's anchoring matters.
    '-af',
    `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DURATION_SEC},` +
      'astats=metadata=0,ebur128=peak=true+sample:framelog=info,aphasemeter=video=0:phasing=1',
    '-f', 'null',
    '-',
  ];

  const { stderr, timedOut } = await runChildProcess('ffmpeg', args, {
    timeoutMs: FILE_ANALYSIS_TIMEOUT_MS,
    signal,
    maxOutputBytes: FILE_ANALYSIS_MAX_STDERR_BYTES,
  });

  if (timedOut) {
    throw new FfmpegError(stderr, `Ljudanalysen blev inte klar inom ${Math.round(FILE_ANALYSIS_TIMEOUT_MS / 1000)} sekunder.`);
  }

  const summary = parseEbur128Summary(stderr, { extended: true });
  const astats = parseAstats(stderr);
  const series = parseEbur128Timeline(stderr);

  if (!summary.available && !astats) {
    throw new FfmpegError(stderr, 'ffmpeg kunde inte mäta ljudet i filen.');
  }

  const phase = gatePhasingBySilence(parsePhasing(stderr), parseSilenceDetect(stderr));
  const effectiveDuration = analyzedSeconds ?? (series.length ? series[series.length - 1].tSec : 0);

  return {
    integratedLufs: summary.integratedLufs,
    lra: summary.lra,
    lraLow: summary.lraLow,
    lraHigh: summary.lraHigh,
    truePeakDbfs: summary.truePeakDbfs,
    truePeakIsSilent: summary.truePeakIsSilent,
    samplePeakDbfs: summary.samplePeakDbfs,
    // Peak-to-loudness ratio: big = punchy/dynamic, near 0 = loudness-war squashed.
    plr:
      typeof summary.truePeakDbfs === 'number' && typeof summary.integratedLufs === 'number'
        ? Number((summary.truePeakDbfs - summary.integratedLufs).toFixed(1))
        : null,
    series,
    astats,
    phase,
    truncated,
    analyzedSeconds: effectiveDuration || null,
  };
}

// The gap between full-band RMS and the RMS of everything above 16 kHz. A large
// gap means almost nothing lives up there - a hard ceiling typical of a lossy
// encode (MP3 at 128 kbps cuts near 16 kHz). Real 44.1 kHz content rolls off near
// 20-22 kHz on its own, so a gap alone at that edge is not enough - only a cliff
// this low is called, and only ever "suspected", never certain.
export const LOSSY_CLIFF_GAP_DB = 45;
export function detectLossyCliff(fullBandRmsDb, highBandRmsDb) {
  if (typeof fullBandRmsDb !== 'number' || typeof highBandRmsDb !== 'number') {
    return { suspected: false, cliffHz: null, gapDb: null };
  }
  const gapDb = Number((fullBandRmsDb - highBandRmsDb).toFixed(1));
  const suspected = gapDb >= LOSSY_CLIFF_GAP_DB;
  return { suspected, cliffHz: suspected ? 16000 : null, gapDb };
}

// Given the astats RMS levels from analyzeSpectrum's four branches in declaration
// order [full, high-pass, mid, side], sanity-check the ordering and, if it holds,
// return the mid & side levels for a correlation estimate. The check: the
// full-band branch must be the loudest - it carries all the energy, while the
// high-pass is filtered and mid/side are each a component of it. If ffmpeg emitted
// the astats blocks in some other order, that no longer holds, and we return nulls
// rather than a correlation with a possibly-flipped sign.
function midSideFromBranchLevels([full, hp, mid, side]) {
  // full must be present, and at least one of mid/side (the other being -inf/null
  // is meaningful: mid null = perfect anti-phase, side null = identical channels).
  if (typeof full !== 'number' || (typeof mid !== 'number' && typeof side !== 'number')) {
    return { midRmsDb: null, sideRmsDb: null };
  }
  const others = [hp, mid, side].filter((v) => typeof v === 'number');
  if (others.length && full < Math.max(...others) - 0.5) return { midRmsDb: null, sideRmsDb: null };
  return {
    midRmsDb: typeof mid === 'number' ? mid : null,
    sideRmsDb: typeof side === 'number' ? side : null,
  };
}

/**
 * The second decode pass, over a short representative window: a spectrogram PNG,
 * the high-frequency band check behind the "consistent with a lossy source" flag,
 * and the mid/side levels for the stereo-correlation estimate. One decode, since
 * an encoder's frequency ceiling and a mix's overall width are both near-constant
 * across a track.
 *
 * → { dataUri, windowSeconds, lossySourceGuess, midRmsDb, sideRmsDb } | null
 */
export async function analyzeSpectrum(filePath, { signal } = {}) {
  const tempPng = path.join(os.tmpdir(), `audio-analyzer-spec-${randomUUID()}.png`);
  try {
    const args = [
      '-hide_banner',
      '-nostats',
      '-y',
      '-protocol_whitelist', 'file',
      '-ss', '0',
      '-t', String(SPECTROGRAM_MAX_SECONDS),
      '-i', filePath,
      '-filter_complex',
      // Branch order here is the contract midSideFromBranchLevels() relies on.
      // The spectrogram branch must NOT convert to mono in-place - asplit shares
      // the frame and `aformat=channel_layouts=mono` there silently corrupts the
      // pan branches below it. showspectrumpic renders stereo directly (channels
      // stacked), which is more useful anyway.
      '[0:a]asplit=5[img][full][hp][mid][side];' +
        '[img]showspectrumpic=s=1024x512:legend=1:scale=log:color=intensity[pic];' +
        '[full]astats=metadata=0,anullsink;' +
        '[hp]highpass=f=16000:poles=2,astats=metadata=0,anullsink;' +
        '[mid]pan=mono|c0=0.5*c0+0.5*c1,astats=metadata=0,anullsink;' +
        '[side]pan=mono|c0=0.5*c0-0.5*c1,astats=metadata=0,anullsink',
      '-map', '[pic]',
      '-frames:v', '1',
      tempPng,
    ];

    const { code, stderr, timedOut } = await runChildProcess('ffmpeg', args, {
      timeoutMs: FILE_ANALYSIS_TIMEOUT_MS,
      signal,
      maxOutputBytes: FILE_ANALYSIS_MAX_STDERR_BYTES,
    });

    if (timedOut) throw new FfmpegError(stderr, 'Spektrogrammet blev inte klart i tid.');

    let dataUri = null;
    try {
      const png = await fs.readFile(tempPng);
      if (png.length) dataUri = `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      /* no image - fall through, code check below decides if that's fatal */
    }
    if (!dataUri && code !== 0) throw new FfmpegError(stderr, 'ffmpeg kunde inte rendera ett spektrogram.');

    // ffmpeg prints the filter summaries in reverse of declaration order, so the
    // stderr blocks appear [side, mid, hp, full]; reverse back to declaration order.
    const tagsInStderrOrder = [...new Set([...String(stderr).matchAll(/\[(Parsed_astats_\d+) @/g)].map((x) => x[1]))];
    const branchLevels = tagsInStderrOrder
      .reverse()
      .map((tag) => astatsFieldsForTag(stderr, tag)?.rmsLevelDb ?? null); // [full, hp, mid, side]

    const [fullRms, hpRms] = branchLevels;
    const { midRmsDb, sideRmsDb } = midSideFromBranchLevels(branchLevels);

    return {
      dataUri,
      windowSeconds: SPECTROGRAM_MAX_SECONDS,
      lossySourceGuess: detectLossyCliff(fullRms, hpRms),
      midRmsDb,
      sideRmsDb,
    };
  } finally {
    await fs.unlink(tempPng).catch(() => {});
  }
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
