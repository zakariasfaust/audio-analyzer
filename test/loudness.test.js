// loudness.test.js
// The two stderr parsers behind the loudness section. ffmpeg reports EBU R128 and
// silencedetect through av_log rather than as JSON, so these strings are the actual
// interface - every fixture here is real output captured from
// `ffmpeg -af "silencedetect=noise=-50dB:d=2,ebur128=peak=true:framelog=quiet" -f null -`.
//
// Pure strings in, plain objects out: nothing here spawns a process.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SILENCE_NOISE_DB,
  SILENCE_MIN_DURATION_SEC,
  parseSilenceDetect,
  parseEbur128Summary,
} from '../server/ffmpeg.js';

// A tone / 3 s of silence / tone file, measured end to end.
const NORMAL_STDERR = [
  '[Parsed_silencedetect_0 @ 0000016a1d6e5f80] silence_start: 2.023197',
  '[Parsed_silencedetect_0 @ 0000016a1d6e5f80] silence_end: 5.023265 | silence_duration: 3.000068',
  '[Parsed_ebur128_1 @ 0000016a1d6e4c80] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -21.4 LUFS',
  '    Threshold: -31.5 LUFS',
  '',
  '  Loudness range:',
  '    LRA:         2.8 LU',
  '    Threshold: -44.5 LUFS',
  '    LRA low:   -25.8 LUFS',
  '    LRA high:  -23.1 LUFS',
  '',
  '  True peak:',
  '    Peak:      -18.1 dBFS',
  '',
].join('\n');

// --------------------------------------------------------------------------
// parseEbur128Summary
// --------------------------------------------------------------------------

test('parseEbur128Summary reads every value out of a normal summary', () => {
  const summary = parseEbur128Summary(NORMAL_STDERR);

  assert.deepEqual(summary, {
    available: true,
    integratedLufs: -21.4,
    truePeakDbfs: -18.1,
    truePeakIsSilent: false,
  });
});

test('parseEbur128Summary ignores the loudness range block entirely', () => {
  // ebur128 always prints LRA and has no flag to stop it, so the fixture still
  // contains it. Nothing may pick it up - and in particular "LRA low: -25.8 LUFS"
  // must never be mistaken for the integrated loudness, which has its own "I:" line.
  const summary = parseEbur128Summary(NORMAL_STDERR);

  assert.equal(summary.loudnessRangeLu, undefined);
  assert.equal(summary.lraLowLufs, undefined);
  assert.equal(summary.integratedLufs, -21.4);
});

test('parseEbur128Summary does not read the "True peak:" heading as the peak value', () => {
  assert.equal(parseEbur128Summary(NORMAL_STDERR).truePeakDbfs, -18.1);
});

test('parseEbur128Summary reports unavailable when there is no summary at all', () => {
  const summary = parseEbur128Summary('[aac @ 0x1] Error while decoding stream #0:0\n');

  assert.equal(summary.available, false);
  assert.equal(summary.integratedLufs, null);
  assert.equal(summary.truePeakDbfs, null);
  assert.equal(summary.truePeakIsSilent, false);
});

test('parseEbur128Summary handles empty and missing input without throwing', () => {
  for (const input of ['', null, undefined]) {
    assert.equal(parseEbur128Summary(input).available, false);
  }
});

test('parseEbur128Summary maps -inf to null and flags it as digital silence', () => {
  // Real output from a fully silent file: the integrated loudness bottoms out at a
  // real number (-70.0) while the true peak is reported as -inf.
  const silentStderr = [
    '[Parsed_ebur128_1 @ 000002462b927780] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -70.0 LUFS',
    '    Threshold: -80.0 LUFS',
    '',
    '  Loudness range:',
    '    LRA:         0.0 LU',
    '    LRA low:     0.0 LUFS',
    '    LRA high:    0.0 LUFS',
    '',
    '  True peak:',
    '    Peak:       -inf dBFS',
    '',
  ].join('\n');
  const summary = parseEbur128Summary(silentStderr);

  assert.equal(summary.integratedLufs, -70);
  // -Infinity must never reach JSON.stringify, which turns it into null silently and
  // makes "no signal at all" look identical to "never measured".
  assert.equal(summary.truePeakDbfs, null);
  assert.equal(summary.truePeakIsSilent, true);
  assert.equal(JSON.parse(JSON.stringify(summary)).truePeakDbfs, null);
});

test('parseEbur128Summary maps nan to null without flagging silence', () => {
  const summary = parseEbur128Summary(
    ['[Parsed_ebur128_1 @ 0x1] Summary:', '', '    I:           nan LUFS', '    Peak:        nan dBFS', ''].join('\n')
  );

  assert.equal(summary.available, true);
  assert.equal(summary.integratedLufs, null);
  assert.equal(summary.truePeakDbfs, null);
  assert.equal(summary.truePeakIsSilent, false);
});

test('parseEbur128Summary ignores a "Summary:" that is not ebur128s own', () => {
  // ffmpeg echoes stream metadata before the filters report, and a station is free
  // to put anything in a title tag - including this word.
  const summary = parseEbur128Summary(
    [
      '  Metadata:',
      '    title           : Summary: I: -99.9 LUFS',
      '[Parsed_ebur128_1 @ 0x1] Summary:',
      '',
      '    I:         -14.2 LUFS',
      '',
    ].join('\n')
  );

  assert.equal(summary.integratedLufs, -14.2);
});

// --------------------------------------------------------------------------
// parseSilenceDetect
// --------------------------------------------------------------------------

test('parseSilenceDetect pairs a start with its end', () => {
  assert.deepEqual(parseSilenceDetect(NORMAL_STDERR), [
    { startSec: 2.023197, endSec: 5.023265, durationSec: 3.000068 },
  ]);
});

test('parseSilenceDetect returns an empty list when nothing was silent', () => {
  assert.deepEqual(parseSilenceDetect('[Parsed_ebur128_1 @ 0x1] Summary:\n    I: -14.0 LUFS\n'), []);
});

test('parseSilenceDetect handles several silences in one window', () => {
  const stderr = [
    '[Parsed_silencedetect_0 @ 0x1] silence_start: 0',
    '[Parsed_silencedetect_0 @ 0x1] silence_end: 2.5 | silence_duration: 2.5',
    '[Parsed_silencedetect_0 @ 0x1] silence_start: 6.1',
    '[Parsed_silencedetect_0 @ 0x1] silence_end: 9.2 | silence_duration: 3.1',
    '',
  ].join('\n');

  assert.deepEqual(parseSilenceDetect(stderr), [
    { startSec: 0, endSec: 2.5, durationSec: 2.5 },
    { startSec: 6.1, endSec: 9.2, durationSec: 3.1 },
  ]);
});

test('parseSilenceDetect pairs by index even when the summary is spliced in between', () => {
  // Not hypothetical: the filtergraph's EOF ordering can put the whole ebur128
  // summary between a silence_start and its silence_end. A parser that paired by
  // textual proximity would drop or mis-pair this one.
  const interleaved = [
    '[Parsed_silencedetect_0 @ 0x1] silence_start: 1.5',
    '[Parsed_ebur128_1 @ 0x2] Summary:',
    '',
    '    I:         -30.0 LUFS',
    '    Peak:      -25.0 dBFS',
    '[Parsed_silencedetect_0 @ 0x1] silence_end: 7.5 | silence_duration: 6.0',
    '',
  ].join('\n');

  assert.deepEqual(parseSilenceDetect(interleaved), [{ startSec: 1.5, endSec: 7.5, durationSec: 6 }]);
  assert.equal(parseEbur128Summary(interleaved).integratedLufs, -30);
});

test('parseSilenceDetect reports an unfinished silence as null rather than guessing', () => {
  // The sample window ended while the stream was still silent: there is a start and
  // no end. "Still silent when we stopped listening" is not a measured length.
  const stderr = [
    '[Parsed_silencedetect_0 @ 0x1] silence_start: 0',
    '[Parsed_silencedetect_0 @ 0x1] silence_end: 2.0 | silence_duration: 2.0',
    '[Parsed_silencedetect_0 @ 0x1] silence_start: 5.4',
    '',
  ].join('\n');

  assert.deepEqual(parseSilenceDetect(stderr), [
    { startSec: 0, endSec: 2, durationSec: 2 },
    { startSec: 5.4, endSec: null, durationSec: null },
  ]);
});

test('parseSilenceDetect handles empty and missing input without throwing', () => {
  for (const input of ['', null, undefined]) {
    assert.deepEqual(parseSilenceDetect(input), []);
  }
});

// --------------------------------------------------------------------------
// Thresholds
// --------------------------------------------------------------------------

test('silence thresholds are the ones the filter is actually built with', () => {
  // These two are echoed to the frontend so the page can state what it measured
  // against; if they drift apart from the filter string the UI starts lying.
  assert.equal(SILENCE_NOISE_DB, -50);
  // 0.5 s, not something comfortable like 2 s: the stream log stitches silence across
  // consecutive recordings, and a fragment shorter than this minimum is never reported
  // at all - so a long silence straddling a recording boundary loses that fragment and
  // measures short. Raising this again would silently break the stitch.
  assert.equal(SILENCE_MIN_DURATION_SEC, 0.5);
});
