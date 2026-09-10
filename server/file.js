// file.js
// Analyse an uploaded audio file. The parallel of hls.js / dash.js / icecast.js,
// but for a finite local file instead of a stream: index.js streams the upload to
// a temp file, calls analyzeAudioFile(), and deletes the temp file afterwards.
//
// One ffprobe (all the metadata the file declares) plus two decode passes run in
// parallel (loudness curve + astats + phase; spectrogram + mid/side levels) -
// see measureFileLoudness / analyzeSpectrum in ffmpeg.js. Each pass is isolated:
// a failure in one lands in errors.<step> and the rest of the result still stands,
// the same degradation pattern analyze() uses.

import { createWriteStream } from 'node:fs';

import { MAX_UPLOAD_BYTES, UPLOAD_IDLE_TIMEOUT_MS } from './config.js';
import { FfprobeError, NotAudioFileError, RequestAbortedError, UploadRejectedError } from './errors.js';
import { analyzeSpectrum, estimateCorrelation, measureFileLoudness, runFfprobeFile, simplifyProbeResult } from './ffmpeg.js';

const CONTROL_CHAR_MAX = 0x1f;
const DEL_CHAR = 0x7f;

// The upload's own filename, for display only. Never used to build a path (the
// temp file gets a server-generated name), so this only has to be safe to escape
// and render: drop directory parts and control characters, cap the length.
export function sanitizeUploadName(raw) {
  if (raw === undefined || raw === null) return null;
  const stripped = String(raw)
    .replace(/[\\/]+/g, '/')
    .split('/')
    .pop()
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > CONTROL_CHAR_MAX && code !== DEL_CHAR;
    })
    .join('')
    .trim()
    .slice(0, 200);
  return stripped || null;
}

/**
 * Streams the request body to `filePath`, rejecting once more than `maxBytes` have
 * arrived. Nothing is held in memory - a hostile 10 GB upload costs one aborted
 * connection and a partial temp file (which the route deletes), not the process.
 *
 * Also rejects an upload that goes quiet for `idleMs`. The route holds a job slot for
 * the whole upload, and its deadline is sized for the decode that follows (minutes), so
 * without this a few deliberately stalled connections could occupy every file slot for
 * that entire window. The timer is reset by each chunk, so a slow-but-progressing
 * upload of a large master is never the thing this catches.
 */
export function saveRequestBodyToFile(req, filePath, maxBytes = MAX_UPLOAD_BYTES, signal, idleMs = UPLOAD_IDLE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new RequestAbortedError());
      return;
    }

    let written = 0;
    let settled = false;
    let idleTimer = null;
    const out = createWriteStream(filePath);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(arg);
    };
    // On a size/parse failure: stop writing and stop reading the body, but do NOT
    // destroy the request socket - the route still has to send the error response
    // on it. Node discards the unread request body once that response finishes.
    // On an abort it is the whole request going away, so tearing the socket down
    // is fine (and what RequestAbortedError already means downstream).
    const fail = (err, { destroyRequest = false } = {}) => {
      req.unpipe?.(out);
      req.pause?.();
      out.destroy();
      if (destroyRequest) req.destroy?.();
      finish(reject, err);
    };
    const onAbort = () =>
      fail(signal?.reason instanceof Error ? signal.reason : new RequestAbortedError(), { destroyRequest: true });

    signal?.addEventListener?.('abort', onAbort, { once: true });

    // A stalled upload is the client's doing, so the socket goes with it - unlike the
    // size and empty-body rejections below, which still need it open to answer on.
    const armIdleTimer = () => {
      if (!idleMs || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          fail(
            new UploadRejectedError(`Uppladdningen stannade av i mer än ${Math.round(idleMs / 1000)} sekunder.`, {
              idleMs,
            }),
            { destroyRequest: true }
          ),
        idleMs
      );
      idleTimer.unref?.();
    };
    armIdleTimer();

    req.on('data', (chunk) => {
      written += chunk.length;
      armIdleTimer();
      if (written > maxBytes) {
        fail(
          new UploadRejectedError(
            `Filen är större än ${Math.round(maxBytes / 1024 / 1024)} MB och analyseras inte.`,
            { limitBytes: maxBytes }
          )
        );
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (written === 0) {
        finish(reject, new UploadRejectedError('Ingen fil togs emot. Skicka filens innehåll som förfråganskropp.'));
        return;
      }
      finish(resolve, written);
    });

    req.pipe(out);
  });
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A tag value worth showing a person. Rejects anything ffmpeg could only hex-escape
// (`\x00` style) and anything carrying raw control characters - which is what the
// binary `id3v2_priv` frames (WMP identifiers, WM volume-leveling blobs) come back
// as. Tab/newline/CR are allowed so multi-line comments and lyrics survive.
function isDisplayableTagValue(value) {
  const s = String(value);
  if (/\\x[0-9a-fA-F]{2}/.test(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false;
  }
  return true;
}

// Split format/stream tags into the fields the UI treats specially (encoder,
// ReplayGain, TLEN) and a plain map of the rest - lowercased keys, first wins,
// binary/application-private frames dropped entirely.
function splitTags(...tagObjects) {
  const merged = {};
  for (const obj of tagObjects) {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = k.toLowerCase();
      if (!(key in merged)) merged[key] = String(v);
    }
  }
  const replayGain = {};
  const tags = {};
  let encoder = null;
  let taggedLengthMs = null;
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith('replaygain_') || k === 'r128_track_gain' || k === 'r128_album_gain') replayGain[k] = v;
    else if (k === 'encoder' || k === 'encoded_by') encoder = encoder || v;
    else if (k === 'tlen') {
      // ID3 TLEN: the track length in milliseconds, as claimed by whatever tagged
      // the file. Kept, but rendered as a duration and cross-checked against the
      // real length - not shown as a bare "198506".
      const ms = Number(v);
      if (Number.isFinite(ms) && ms > 0) taggedLengthMs = ms;
    } else if (k.startsWith('id3v2_priv') || !isDisplayableTagValue(v)) {
      // Application-private / binary - nothing a person reads. Dropped.
    } else {
      tags[k] = v;
    }
  }
  return { tags, replayGain: Object.keys(replayGain).length ? replayGain : null, encoder, taggedLengthMs };
}

export function buildFileFormat(raw) {
  const format = raw.format || {};
  const streams = raw.streams || [];
  const audioStream = streams.find((s) => s.codec_type === 'audio') || {};
  const cover = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic);

  const { tags, replayGain, encoder, taggedLengthMs } = splitTags(format.tags, audioStream.tags);

  return {
    container: format.format_name || null,
    containerLongName: format.format_long_name || null,
    durationSec: num(format.duration),
    taggedDurationSec: taggedLengthMs != null ? taggedLengthMs / 1000 : null,
    fileSizeBytes: num(format.size),
    overallBitrateKbps: num(format.bit_rate) ? num(format.bit_rate) / 1000 : null,
    encoder,
    tags,
    replayGain,
    coverArt: cover
      ? { codec: cover.codec_name || null, width: num(cover.width), height: num(cover.height) }
      : null,
    chapters: (raw.chapters || []).map((c) => ({
      startSec: num(c.start_time),
      endSec: num(c.end_time),
      title: c.tags?.title ? String(c.tags.title) : null,
    })),
  };
}

// The audio-track facts renderAudio() does not cover: sample format, and the two
// bit-depth readings (what the container declares vs what the samples actually use
// - see astats.bitDepthUsed).
export function buildAudioExtra(raw) {
  const audioStream = (raw.streams || []).find((s) => s.codec_type === 'audio') || {};
  return {
    sampleFmt: audioStream.sample_fmt || null,
    bitsPerSample: num(audioStream.bits_per_sample) || null,
    bitsPerRawSample: num(audioStream.bits_per_raw_sample) || null,
    initialPadding: num(audioStream.initial_padding),
  };
}

const toErr = (err) => ({
  message: err.message,
  code: err.code || 'UNKNOWN',
  details: err.details,
});

/**
 * → { kind:'file', originalName, format, audio, audioExtra, loudness, spectrogram, errors }
 * Throws NotAudioFileError when ffprobe cannot find an audio track (or read the
 * file as media at all).
 */
export async function analyzeAudioFile(filePath, originalName, { signal } = {}) {
  let probe;
  try {
    probe = await runFfprobeFile(filePath, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof FfprobeError) {
      throw new NotAudioFileError('Filen kunde inte läsas som ljud eller media. Är det verkligen en ljudfil?');
    }
    throw err;
  }

  if (!(probe.raw.streams || []).some((s) => s.codec_type === 'audio')) {
    throw new NotAudioFileError('Filen innehåller inget ljudspår.');
  }

  const format = buildFileFormat(probe.raw);
  const audio = simplifyProbeResult(probe.raw);
  const errors = {};

  const [loudness, spectrum] = await Promise.all([
    measureFileLoudness(filePath, { signal, durationSec: format.durationSec }).then(
      (v) => v,
      (err) => {
        if (signal?.aborted) throw err;
        errors.loudness = toErr(err);
        return null;
      }
    ),
    analyzeSpectrum(filePath, { signal }).then(
      (v) => v,
      (err) => {
        if (signal?.aborted) throw err;
        errors.spectrogram = toErr(err);
        return null;
      }
    ),
  ]);

  return {
    kind: 'file',
    originalName: originalName || null,
    format,
    audio,
    audioExtra: buildAudioExtra(probe.raw),
    // Composed rather than assigned onto the object measureFileLoudness returned, so
    // the shape of `loudness` is described in one place instead of grown in two.
    loudness: loudness ? { ...loudness, stereo: buildStereo(audio, format, loudness, spectrum) } : null,
    spectrogram: spectrum ? { dataUri: spectrum.dataUri, windowSeconds: spectrum.windowSeconds } : null,
    errors,
  };
}

/**
 * The stereo picture, or null for a mono file. The correlation number comes from
 * analyzeSpectrum's mid/side levels (window-limited, silence-immune - see
 * estimateCorrelation); the phase spans from measureFileLoudness's whole-file,
 * silence-gated aphasemeter run.
 */
function buildStereo(audio, format, loudness, spectrum) {
  if (!(audio.channels >= 2)) return null;
  const correlation = spectrum ? estimateCorrelation(spectrum.midRmsDb, spectrum.sideRmsDb) : null;
  return {
    correlation,
    // "identical channels" - side at -inf, or a correlation that has locked to +1.
    dualMono: correlation !== null && correlation >= 0.999,
    windowSec: spectrum?.windowSeconds ?? null,
    windowTruncated: Boolean(spectrum && format.durationSec != null && format.durationSec > spectrum.windowSeconds),
    monoSpans: loudness.phase?.monoSpans ?? [],
    outOfPhaseSpans: loudness.phase?.outOfPhaseSpans ?? [],
  };
}
