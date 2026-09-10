// fileAnalysis.test.js
// The pure parsers and shapers behind uploaded-file analysis (Fas 4). Like
// loudness.test.js: every fixture is real output captured from ffmpeg 9.0
// (astats / ebur128 peak=true+sample framelog=info / aphasemeter phasing=1),
// strings in, plain objects out, nothing spawns a process.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAstats,
  parseEbur128Summary,
  parseEbur128Timeline,
  parsePhasing,
  gatePhasingBySilence,
  subtractIntervals,
  estimateCorrelation,
  detectLossyCliff,
  LOSSY_CLIFF_GAP_DB,
} from '../server/ffmpeg.js';
import { sanitizeUploadName, buildFileFormat, buildAudioExtra } from '../server/file.js';

// --------------------------------------------------------------------------
// parseAstats
// --------------------------------------------------------------------------

const ASTATS_STDERR = [
  '[Parsed_astats_0 @ 0x1] Channel: 1',
  '[Parsed_astats_0 @ 0x1] DC offset: 0.000004',
  '[Parsed_astats_0 @ 0x1] Peak level dB: -0.100000',
  '[Parsed_astats_0 @ 0x1] RMS level dB: -9.500000',
  '[Parsed_astats_0 @ 0x1] Crest factor: 2.985383',
  '[Parsed_astats_0 @ 0x1] Dynamic range: 40.100000',
  '[Parsed_astats_0 @ 0x1] Bit depth: 16/16/16/16',
  '[Parsed_astats_0 @ 0x1] Overall',
  '[Parsed_astats_0 @ 0x1] DC offset: -0.000001',
  '[Parsed_astats_0 @ 0x1] Min level: -32768.000000',
  '[Parsed_astats_0 @ 0x1] Peak level dB: -25.511186',
  '[Parsed_astats_0 @ 0x1] RMS level dB: -31.514923',
  '[Parsed_astats_0 @ 0x1] RMS peak dB: -28.505563',
  '[Parsed_astats_0 @ 0x1] RMS through dB: -52.109136',
  '[Parsed_astats_0 @ 0x1] Flat factor: 0.000000',
  '[Parsed_astats_0 @ 0x1] Peak count: 2393.000000',
  '[Parsed_astats_0 @ 0x1] Abs Peak count: 1197.000000',
  '[Parsed_astats_0 @ 0x1] Noise floor dB: -47.094752',
  '[Parsed_astats_0 @ 0x1] Entropy: 0.579939',
  '[Parsed_astats_0 @ 0x1] Bit depth: 19/24/24/24',
  '[Parsed_astats_0 @ 0x1] Number of samples: 441000',
].join('\n');

test('parseAstats reads the Overall block, not the per-channel one', () => {
  const a = parseAstats(ASTATS_STDERR);
  assert.equal(a.dcOffset, -0.000001);
  assert.equal(a.peakLevelDb, -25.511186);
  assert.equal(a.rmsLevelDb, -31.514923);
  assert.equal(a.rmsPeakDb, -28.505563);
  // ffmpeg's own (mis)spelling
  assert.equal(a.rmsTroughDb, -52.109136);
  assert.equal(a.flatFactor, 0);
  assert.equal(a.peakCount, 2393);
  assert.equal(a.absPeakCount, 1197);
  assert.equal(a.noiseFloorDb, -47.094752);
  assert.equal(a.numberOfSamples, 441000);
});

test('parseAstats splits "Bit depth: used/.../container" into used vs container', () => {
  const a = parseAstats(ASTATS_STDERR);
  assert.equal(a.bitDepthUsed, 19);
  assert.equal(a.bitDepthContainer, 24);
});

test('parseAstats computes crest factor from Overall peak/RMS (not printed in Overall)', () => {
  const a = parseAstats(ASTATS_STDERR);
  // 10^((-25.511186 - -31.514923)/20) ~= 1.996
  assert.ok(Math.abs(a.crestFactor - 1.996) < 0.01, `crest was ${a.crestFactor}`);
});

test('parseAstats takes dynamic range from the per-channel block (absent from Overall)', () => {
  assert.equal(parseAstats(ASTATS_STDERR).dynamicRange, 40.1);
});

test('parseAstats returns null when there is no astats output', () => {
  assert.equal(parseAstats('[Parsed_ebur128_0 @ 0x1] Summary:\n'), null);
  assert.equal(parseAstats(''), null);
});

// --------------------------------------------------------------------------
// parseEbur128Summary — extended mode (peak=true+sample)
// --------------------------------------------------------------------------

const SUMMARY_SAMPLE_AND_TRUE = [
  '[Parsed_ebur128_1 @ 0x1] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -26.3 LUFS',
  '    Threshold: -39.2 LUFS',
  '',
  '  Loudness range:',
  '    LRA:        21.6 LU',
  '    Threshold: -49.2 LUFS',
  '    LRA low:   -47.8 LUFS',
  '    LRA high:  -26.2 LUFS',
  '',
  '  Sample peak:',
  '    Peak:      -25.5 dBFS',
  '',
  '  True peak:',
  '    Peak:      -18.1 dBFS',
  '',
].join('\n');

test('parseEbur128Summary({extended}) does not mistake the sample peak for the true peak', () => {
  const s = parseEbur128Summary(SUMMARY_SAMPLE_AND_TRUE, { extended: true });
  assert.equal(s.truePeakDbfs, -18.1);
  assert.equal(s.samplePeakDbfs, -25.5);
  assert.equal(s.integratedLufs, -26.3);
  assert.equal(s.lra, 21.6);
  assert.equal(s.lraLow, -47.8);
  assert.equal(s.lraHigh, -26.2);
});

test('parseEbur128Summary() default shape is unchanged even with a Sample peak block present', () => {
  // The stream path (peak=true only) never sees Sample peak, but the anchoring must
  // still pick True peak if it ever did - and the return shape stays Fas 3's four keys.
  const s = parseEbur128Summary(SUMMARY_SAMPLE_AND_TRUE);
  assert.deepEqual(s, {
    available: true,
    integratedLufs: -26.3,
    truePeakDbfs: -18.1,
    truePeakIsSilent: false,
  });
});

test('parseEbur128Summary({extended}) maps -inf to null and flags silence on both peaks', () => {
  const silent = [
    '[Parsed_ebur128_0 @ 0x1] Summary:',
    '  Integrated loudness:',
    '    I:         -70.0 LUFS',
    '  Loudness range:',
    '    LRA:         0.0 LU',
    '  Sample peak:',
    '    Peak:       -inf dBFS',
    '  True peak:',
    '    Peak:       -inf dBFS',
  ].join('\n');
  const s = parseEbur128Summary(silent, { extended: true });
  assert.equal(s.truePeakDbfs, null);
  assert.equal(s.truePeakIsSilent, true);
  assert.equal(s.samplePeakDbfs, null);
  assert.equal(s.samplePeakIsSilent, true);
  assert.equal(JSON.parse(JSON.stringify(s)).truePeakDbfs, null);
});

test('parseEbur128Summary({extended}) reports unavailable with the extended keys still present', () => {
  const s = parseEbur128Summary('nothing here', { extended: true });
  assert.equal(s.available, false);
  assert.equal(s.lra, null);
  assert.equal(s.samplePeakDbfs, null);
  assert.equal(s.samplePeakIsSilent, false);
});

// --------------------------------------------------------------------------
// parseEbur128Timeline
// --------------------------------------------------------------------------

const FRAME = (t, m, s, tp) =>
  `[Parsed_ebur128_1 @ 0x1] t: ${t}   TARGET:-23 LUFS    M: ${m} S: ${s}     I: -20.0 LUFS       LRA:   3.0 LU  SPK: ${tp} ${tp} dBFS  FTPK: ${tp} ${tp} dBFS  TPK: ${tp} ${tp} dBFS`;

test('parseEbur128Timeline reads short-term LUFS and per-frame true peak per line', () => {
  const stderr = [FRAME('0.1', '-120.7', '-120.7', '-25.5'), FRAME('1.1', '-18.0', '-19.2', '-3.1'), FRAME('2.1', '-17.5', '-18.0', '-2.9')].join('\n');
  const series = parseEbur128Timeline(stderr);
  assert.equal(series.length, 3);
  // first frame: M/S at the -120.7 floor -> null (line breaks, not a dive)
  assert.equal(series[0].shortTermLufs, null);
  assert.equal(series[0].truePeakDbfs, -25.5);
  assert.equal(series[1].shortTermLufs, -19.2);
  assert.equal(series[1].truePeakDbfs, -3.1);
});

test('parseEbur128Timeline downsamples to at most maxPoints buckets', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(FRAME((i * 0.1).toFixed(1), '-18.0', '-18.0', '-3.0'));
  const series = parseEbur128Timeline(lines.join('\n'), { maxPoints: 50 });
  assert.ok(series.length <= 50, `got ${series.length}`);
  assert.ok(series.length > 0);
  assert.equal(series[0].shortTermLufs, -18);
});

test('parseEbur128Timeline returns [] for stderr with no frame lines', () => {
  assert.deepEqual(parseEbur128Timeline('[Parsed_ebur128_1 @ 0x1] Summary:\n'), []);
});

// --------------------------------------------------------------------------
// parsePhasing
// --------------------------------------------------------------------------

test('parsePhasing pairs mono and out-of-phase spans by index', () => {
  const stderr = [
    '[Parsed_aphasemeter_2 @ 0x1] mono_start: 0',
    '[Parsed_aphasemeter_2 @ 0x1] mono_end: 6 | mono_duration: 6',
    '[Parsed_aphasemeter_2 @ 0x1] out_phase_start: 12.5',
    '[Parsed_aphasemeter_2 @ 0x1] out_phase_end: 15.5 | out_phase_duration: 3',
  ].join('\n');
  const p = parsePhasing(stderr);
  assert.deepEqual(p.monoSpans, [{ startSec: 0, endSec: 6, durationSec: 6 }]);
  assert.deepEqual(p.outOfPhaseSpans, [{ startSec: 12.5, endSec: 15.5, durationSec: 3 }]);
});

test('parsePhasing reports an unfinished span as null rather than guessing', () => {
  const stderr = ['[Parsed_aphasemeter_0 @ 0x1] out_phase_start: 40'].join('\n');
  const p = parsePhasing(stderr);
  assert.deepEqual(p.outOfPhaseSpans, [{ startSec: 40, endSec: null, durationSec: null }]);
  assert.deepEqual(p.monoSpans, []);
});

// --------------------------------------------------------------------------
// gatePhasingBySilence — carve silence out of the phase spans
// --------------------------------------------------------------------------

test('gatePhasingBySilence removes the silent portion of a span', () => {
  // aphasemeter reported mono 5-10; silence 5-7 was really just the gap.
  const gated = gatePhasingBySilence(
    { monoSpans: [{ startSec: 5, endSec: 10, durationSec: 5 }], outOfPhaseSpans: [] },
    [{ startSec: 5, endSec: 7, durationSec: 2 }]
  );
  assert.deepEqual(gated.monoSpans, [{ startSec: 7, endSec: 10, durationSec: 3 }]);
});

test('gatePhasingBySilence drops a span that was entirely silence', () => {
  const gated = gatePhasingBySilence(
    { monoSpans: [{ startSec: 2, endSec: 5, durationSec: 3 }], outOfPhaseSpans: [] },
    [{ startSec: 0, endSec: 6, durationSec: 6 }]
  );
  assert.deepEqual(gated.monoSpans, []);
});

test('gatePhasingBySilence splits a span around a silent gap in the middle', () => {
  const gated = gatePhasingBySilence(
    { monoSpans: [], outOfPhaseSpans: [{ startSec: 0, endSec: 20, durationSec: 20 }] },
    [{ startSec: 8, endSec: 12, durationSec: 4 }]
  );
  assert.equal(gated.outOfPhaseSpans.length, 2);
  assert.deepEqual(gated.outOfPhaseSpans[0], { startSec: 0, endSec: 8, durationSec: 8 });
  assert.deepEqual(gated.outOfPhaseSpans[1], { startSec: 12, endSec: 20, durationSec: 8 });
});

test('gatePhasingBySilence drops leftovers shorter than MIN_PHASE_SPAN_SEC', () => {
  const gated = gatePhasingBySilence(
    { monoSpans: [{ startSec: 5, endSec: 10, durationSec: 5 }], outOfPhaseSpans: [] },
    [{ startSec: 5, endSec: 9.5, durationSec: 4.5 }] // leaves 0.5 s
  );
  assert.deepEqual(gated.monoSpans, []);
});

test('gatePhasingBySilence keeps an open (endSec null) span open after gating', () => {
  const gated = gatePhasingBySilence(
    { monoSpans: [{ startSec: 30, endSec: null, durationSec: null }], outOfPhaseSpans: [] },
    [{ startSec: 30, endSec: 33, durationSec: 3 }]
  );
  assert.deepEqual(gated.monoSpans, [{ startSec: 33, endSec: null, durationSec: null }]);
});

test('subtractIntervals with no cuts returns the span unchanged', () => {
  assert.deepEqual(subtractIntervals({ start: 1, end: 5 }, []), [{ start: 1, end: 5 }]);
});

// --------------------------------------------------------------------------
// estimateCorrelation — from mid / side RMS
// --------------------------------------------------------------------------

test('estimateCorrelation: identical channels (side at -inf) -> +1', () => {
  assert.equal(estimateCorrelation(-20, null), 1);
});

test('estimateCorrelation: perfect anti-phase (mid at -inf) -> -1', () => {
  assert.equal(estimateCorrelation(null, -20), -1);
});

test('estimateCorrelation: equal mid and side power -> 0 (fully decorrelated)', () => {
  assert.equal(estimateCorrelation(-24, -24), 0);
});

test('estimateCorrelation: mid 6 dB over side -> a positive, mono-safe value', () => {
  const r = estimateCorrelation(-18, -24);
  assert.ok(r > 0.5 && r < 0.8, `got ${r}`);
});

test('estimateCorrelation: nothing to measure -> null', () => {
  assert.equal(estimateCorrelation(null, null), null);
});

// --------------------------------------------------------------------------
// detectLossyCliff
// --------------------------------------------------------------------------

test('detectLossyCliff flags a wide gap between full-band and >16kHz RMS', () => {
  const guess = detectLossyCliff(-28.5, -91.0);
  assert.equal(guess.suspected, true);
  assert.equal(guess.cliffHz, 16000);
  assert.equal(guess.gapDb, 62.5);
});

test('detectLossyCliff does not flag a modest gap (real broadband content)', () => {
  const guess = detectLossyCliff(-20.0, -34.3);
  assert.equal(guess.suspected, false);
  assert.equal(guess.cliffHz, null);
  assert.equal(guess.gapDb, 14.3);
});

test('detectLossyCliff is inconclusive without both band readings', () => {
  assert.deepEqual(detectLossyCliff(-20.0, null), { suspected: false, cliffHz: null, gapDb: null });
  assert.deepEqual(detectLossyCliff(null, null), { suspected: false, cliffHz: null, gapDb: null });
});

test('LOSSY_CLIFF_GAP_DB is the threshold detectLossyCliff actually uses', () => {
  assert.equal(detectLossyCliff(0, -LOSSY_CLIFF_GAP_DB).suspected, true);
  assert.equal(detectLossyCliff(0, -(LOSSY_CLIFF_GAP_DB - 0.1)).suspected, false);
});

// --------------------------------------------------------------------------
// sanitizeUploadName
// --------------------------------------------------------------------------

test('sanitizeUploadName strips directory parts - it is display-only, never a path', () => {
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName('C:\\Users\\me\\song.mp3'), 'song.mp3');
  assert.equal(sanitizeUploadName('a/b/c/track.flac'), 'track.flac');
});

test('sanitizeUploadName removes control characters and caps the length', () => {
  assert.equal(sanitizeUploadName('na\u0000me\u001f.wav'), 'name.wav');
  assert.equal(sanitizeUploadName('x'.repeat(500)).length, 200);
});

test('sanitizeUploadName returns null for nothing usable', () => {
  assert.equal(sanitizeUploadName(null), null);
  assert.equal(sanitizeUploadName(undefined), null);
  assert.equal(sanitizeUploadName('   '), null);
  assert.equal(sanitizeUploadName('/'), null);
});

// --------------------------------------------------------------------------
// buildFileFormat / buildAudioExtra
// --------------------------------------------------------------------------

const PROBE = {
  format: {
    format_name: 'flac',
    format_long_name: 'raw FLAC',
    duration: '183.4',
    size: '5242880',
    bit_rate: '228000',
    tags: {
      TITLE: 'Song <b>One</b>',
      ARTIST: 'A & B',
      encoder: 'libFLAC 1.4.2',
      REPLAYGAIN_TRACK_GAIN: '-6.35 dB',
      replaygain_track_peak: '0.98',
    },
  },
  streams: [
    {
      codec_type: 'audio',
      sample_fmt: 's32',
      bits_per_sample: 0,
      bits_per_raw_sample: '24',
      initial_padding: 0,
      tags: { comment: 'ripped' },
    },
    {
      codec_type: 'video',
      codec_name: 'mjpeg',
      width: 500,
      height: 500,
      disposition: { attached_pic: 1 },
    },
  ],
  chapters: [{ start_time: '0.000000', end_time: '60.000000', tags: { title: 'Intro' } }],
};

test('buildFileFormat separates encoder and ReplayGain from the plain tag map', () => {
  const f = buildFileFormat(PROBE);
  assert.equal(f.encoder, 'libFLAC 1.4.2');
  assert.deepEqual(f.replayGain, { replaygain_track_gain: '-6.35 dB', replaygain_track_peak: '0.98' });
  assert.equal(f.tags.title, 'Song <b>One</b>'); // raw here; the frontend escapes it
  assert.equal(f.tags.artist, 'A & B');
  assert.equal(f.tags.encoder, undefined);
  assert.equal(f.tags.replaygain_track_gain, undefined);
});

test('buildFileFormat reports cover art presence + dimensions and chapters', () => {
  const f = buildFileFormat(PROBE);
  assert.deepEqual(f.coverArt, { codec: 'mjpeg', width: 500, height: 500 });
  assert.deepEqual(f.chapters, [{ startSec: 0, endSec: 60, title: 'Intro' }]);
  assert.equal(f.durationSec, 183.4);
  assert.equal(f.overallBitrateKbps, 228);
});

test('buildFileFormat: no cover art / no chapters is empty, not undefined', () => {
  const f = buildFileFormat({ format: {}, streams: [{ codec_type: 'audio' }] });
  assert.equal(f.coverArt, null);
  assert.deepEqual(f.chapters, []);
  assert.equal(f.replayGain, null);
});

test('buildAudioExtra pulls sample format and both bit-depth readings', () => {
  const e = buildAudioExtra(PROBE);
  assert.equal(e.sampleFmt, 's32');
  assert.equal(e.bitsPerSample, null); // 0 -> null
  assert.equal(e.bitsPerRawSample, 24);
});

// --------------------------------------------------------------------------
// Tag filtering (id3v2_priv / binary / TLEN)
// --------------------------------------------------------------------------

const JUNKY_PROBE = {
  format: {
    tags: {
      TITLE: 'Devil May Care',
      ARTIST: 'Jamie Cullum',
      TLEN: '198506',
      'id3v2_priv.wm/wmcontentid': 'anything',
      'id3v2_priv.wm/provider': 'AMG',
      // ffprobe hex-escaped non-printable bytes, under a non-priv key (String.raw
      // so the source really contains backslash-x, not a NUL)
      weird: String.raw`A\x00M\x00G`,
      // a real control character (BEL) in the value, under a non-priv key
      broken: `ok${String.fromCharCode(7)}bell`,
    },
  },
  streams: [{ codec_type: 'audio' }],
};

test('buildFileFormat drops id3v2_priv frames and binary/hex-escaped tag values', () => {
  const f = buildFileFormat(JUNKY_PROBE);
  assert.equal(f.tags.title, 'Devil May Care');
  assert.equal(f.tags.artist, 'Jamie Cullum');
  assert.equal(f.tags['id3v2_priv.wm/wmcontentid'], undefined);
  assert.equal(f.tags['id3v2_priv.wm/provider'], undefined);
  assert.equal(f.tags.weird, undefined);
  assert.equal(f.tags.broken, undefined);
  // TLEN is pulled out, not left in the plain map
  assert.equal(f.tags.tlen, undefined);
});

test('buildFileFormat surfaces TLEN as taggedDurationSec (ms -> s)', () => {
  assert.equal(buildFileFormat(JUNKY_PROBE).taggedDurationSec, 198.506);
});

test('buildFileFormat: no TLEN -> taggedDurationSec is null', () => {
  assert.equal(buildFileFormat(PROBE).taggedDurationSec, null);
});

test('isDisplayableTagValue keeps multi-line comments and lyrics', () => {
  // tab/newline/CR are allowed; the value survives as a normal tag
  const f = buildFileFormat({
    format: { tags: { lyrics: 'line one\nline two\r\nline three' } },
    streams: [{ codec_type: 'audio' }],
  });
  assert.match(f.tags.lyrics, /line one\nline two/);
});
