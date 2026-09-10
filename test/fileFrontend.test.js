// fileFrontend.test.js
// public/file.js rendered in a vm with a stub DOM, like frontend.test.js - so the
// render functions can be exercised directly. The point of interest is the same:
// every string that comes from the file (tag values, filenames, the spectrogram
// data URI) is attacker-controlled and must not be able to inject markup.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function loadFile() {
  const element = () => ({
    addEventListener() {},
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    dataset: {},
    files: [],
    getContext: () => null,
  });
  const context = vm.createContext({
    document: { getElementById: () => element() },
    window: { devicePixelRatio: 1, addEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    fetch: async () => {
      throw new Error('no network in tests');
    },
    setTimeout,
    console,
  });
  for (const f of ['terms.js', 'shared.js', 'app.js', 'file.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context, { filename: f });
  }
  return context;
}

const app = loadFile();

const baseData = () => ({
  kind: 'file',
  originalName: 'song.flac',
  format: {
    container: 'flac',
    containerLongName: 'raw FLAC',
    durationSec: 183.4,
    taggedDurationSec: null,
    fileSizeBytes: 5242880,
    overallBitrateKbps: 950.2,
    encoder: 'libFLAC 1.4.2',
    tags: { title: 'A Song', artist: 'An Artist' },
    replayGain: null,
    coverArt: { codec: 'mjpeg', width: 500, height: 500 },
    chapters: [],
  },
  audio: { codec: 'flac', profile: null, sampleRate: 44100, channels: 2, channelLayout: 'stereo', bitRate: 950000, container: 'flac' },
  audioExtra: { sampleFmt: 's32', bitsPerSample: null, bitsPerRawSample: 24, initialPadding: 0 },
  loudness: {
    integratedLufs: -14.2,
    lra: 6.1,
    lraLow: -18.0,
    lraHigh: -11.9,
    truePeakDbfs: -0.8,
    truePeakIsSilent: false,
    samplePeakDbfs: -1.2,
    plr: 13.4,
    astats: {
      dcOffset: 0.0002,
      peakLevelDb: -1.2,
      rmsLevelDb: -12.5,
      rmsPeakDb: -9.0,
      rmsTroughDb: -40.0,
      flatFactor: 0,
      peakCount: 10,
      absPeakCount: 4,
      noiseFloorDb: -71.0,
      entropy: 0.9,
      bitDepthUsed: 23,
      bitDepthContainer: 24,
      numberOfSamples: 8000000,
      dynamicRange: 60,
      crestFactor: 4.6,
    },
    stereo: {
      correlation: 0.62,
      dualMono: false,
      windowSec: 600,
      windowTruncated: false,
      monoSpans: [],
      outOfPhaseSpans: [],
    },
    truncated: false,
    analyzedSeconds: 183.4,
    series: [
      { tSec: 0.1, shortTermLufs: null, truePeakDbfs: -20 },
      { tSec: 90, shortTermLufs: -14, truePeakDbfs: -1 },
      { tSec: 180, shortTermLufs: -13.5, truePeakDbfs: -0.8 },
    ],
  },
  spectrogram: {
    dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    windowSeconds: 600,
  },
  errors: {},
});

// --------------------------------------------------------------------------

test('renderFileOverview shows metadata and reports cover art', () => {
  const html = app.renderFileOverview(baseData());
  assert.match(html, /song\.flac/);
  assert.match(html, /libFLAC 1\.4\.2/);
  assert.match(html, /500×500 px/);
  assert.match(html, /24 bitar deklarerat, 23 faktiskt använda/);
  assert.match(html, /An Artist/);
});

test('renderFileOverview: TLEN row is absent without a TLEN tag', () => {
  const html = app.renderFileOverview(baseData());
  assert.ok(!html.includes('TLEN'));
});

test('renderFileOverview: TLEN close to the real duration shows as a plain readable time', () => {
  const d = baseData();
  d.format.durationSec = 199;
  d.format.taggedDurationSec = 199.2; // rounds to the same "3 min 19 s"
  const html = app.renderFileOverview(d);
  assert.match(html, /TLEN/);
  assert.match(html, /3 min 19 s/);
  assert.ok(!html.includes('skiljer sig'));
});

test('renderFileOverview: a TLEN that disagrees with the real duration is flagged visibly', () => {
  const d = baseData();
  d.format.durationSec = 199;
  d.format.taggedDurationSec = 165; // 2 min 45 s vs 3 min 19 s
  const html = app.renderFileOverview(d);
  assert.match(html, /skiljer sig från filens uppmätta längd/);
  assert.match(html, /tag-mismatch/);
});

// astats' bit-depth reading describes the decoder's output buffer. That is the file
// only for integer PCM; for anything decoded to float it is ffmpeg's own buffer, and
// the numbers are unstable as well as meaningless - a 192 kbps MP3 came back as
// "43 bitar deklarerat, 41 faktiskt använda" through this app's own filter chain.
test('renderFileOverview reports bit depth only for integer PCM', () => {
  const d = baseData();
  d.audioExtra.sampleFmt = 's16';
  d.loudness.astats.bitDepthContainer = 16;
  d.loudness.astats.bitDepthUsed = 14;
  assert.match(app.renderFileOverview(d), /16 bitar deklarerat, 14 faktiskt använda/);

  d.loudness.astats.bitDepthUsed = 16;
  assert.match(app.renderFileOverview(d), /<dd>16 bitar<\/dd>/);
});

test('renderFileOverview states that a float-decoded source has no bit depth', () => {
  const d = baseData();
  d.audioExtra.sampleFmt = 'fltp';
  d.loudness.astats.bitDepthContainer = 43; // what ffmpeg actually reports for an mp3
  d.loudness.astats.bitDepthUsed = 41;
  const html = app.renderFileOverview(d);
  assert.match(html, /gäller inte \(fltp – flyttal\)/);
  assert.ok(!/43 bitar/.test(html), 'the decoder buffer size leaked out as a bit depth');
});

test('renderFileOverview escapes hostile tag values - no markup injection', () => {
  const d = baseData();
  d.format.tags = { title: '<img src=x onerror=alert(1)>', comment: '"><script>bad()</script>' };
  d.originalName = '<b>evil</b>.mp3';
  const html = app.renderFileOverview(d);
  assert.ok(!html.includes('<img src=x'), 'raw <img> leaked');
  assert.ok(!html.includes('<script>bad'), 'raw <script> leaked');
  assert.ok(!html.includes('<b>evil</b>.mp3'), 'raw filename markup leaked');
  assert.match(html, /&lt;img src=x/);
});

test('renderFileLoudness renders the key numbers and the chart canvas', () => {
  const html = app.renderFileLoudness(baseData());
  // sv-SE toLocaleString uses U+2212 minus, not "-"
  assert.match(html, /[-−]14,2 LUFS/);
  assert.match(html, /6,1 LU/);
  assert.match(html, /[-−]0,8 dBTP/);
  assert.match(html, /13,4 LU/); // PLR
  assert.match(html, /id="file-loudness-chart"/);
});

test('renderFileLoudness shows the 130-minute truncation note only when truncated', () => {
  const d = baseData();
  assert.ok(!app.renderFileLoudness(d).includes('längre än 130 minuter'));
  d.loudness.truncated = true;
  d.loudness.analyzedSeconds = 7800;
  assert.match(app.renderFileLoudness(d), /längre än 130 minuter/);
});

test('renderFileLoudness surfaces a loudness-pass error instead of the dl', () => {
  const d = baseData();
  d.loudness = null;
  d.errors = { loudness: { message: 'ffmpeg dog', code: 'FFMPEG_FAILED' } };
  const html = app.renderFileLoudness(d);
  assert.match(html, /ffmpeg dog/);
  assert.ok(!html.includes('file-loudness-chart'));
});

test('renderFileLoudness reports digital silence as -inf, not a missing value', () => {
  const d = baseData();
  d.loudness.truePeakIsSilent = true;
  d.loudness.truePeakDbfs = null;
  d.loudness.samplePeakDbfs = null;
  assert.match(app.renderFileLoudness(d), /−∞ dBTP/);
});

test('renderFileLoudness shows the stereo correlation with a sign and a verdict', () => {
  const html = app.renderFileLoudness(baseData());
  assert.match(html, /Stereokorrelation/);
  assert.match(html, /\+0,62/);
  assert.match(html, /mono-kompatibel/);
});

test('renderFileLoudness: negative correlation gets the warning styling', () => {
  const d = baseData();
  d.loudness.stereo.correlation = -0.3;
  const html = app.renderFileLoudness(d);
  assert.match(html, /[-−]0,30/);
  assert.match(html, /stereo-warn/);
  assert.match(html, /motverkar varandra/);
});

test('renderFileLoudness: correlation null (too quiet) reads plainly, no crash', () => {
  const d = baseData();
  d.loudness.stereo.correlation = null;
  assert.match(app.renderFileLoudness(d), /för lite ljud/);
});

test('renderFileLoudness lists silence-gated out-of-phase and mono spans', () => {
  const d = baseData();
  d.loudness.stereo.outOfPhaseSpans = [{ startSec: 12, endSec: 18, durationSec: 6 }];
  d.loudness.stereo.monoSpans = [{ startSec: 40, endSec: 55, durationSec: 15 }];
  const html = app.renderFileLoudness(d);
  assert.match(html, /Ur fas/);
  assert.match(html, /Mono \(kanalerna identiska\)/);
  assert.match(html, /tystnad borträknad/);
});

test('renderFileLoudness: a mono file has no stereo row or phase table', () => {
  const d = baseData();
  d.audio.channels = 1;
  const html = app.renderFileLoudness(d);
  assert.ok(!html.includes('Stereokorrelation'));
});

test('renderFileLoudness: window-truncated correlation says so', () => {
  const d = baseData();
  d.loudness.stereo.windowTruncated = true;
  assert.match(app.renderFileLoudness(d), /uppmätt över de första/);
});

test('renderFileSpectrogram only emits the image when the data URI is a real png data URI', () => {
  const ok = app.renderFileSpectrogram(baseData());
  assert.match(ok, /<img class="spectrogram" src="data:image\/png;base64,/);

  const d = baseData();
  d.spectrogram.dataUri = 'javascript:alert(1)//data:image/png;base64,x';
  const bad = app.renderFileSpectrogram(d);
  assert.ok(!bad.includes('javascript:alert'), 'non-png URI leaked into src');
  assert.match(bad, /Ingen bild/);
});

// The spectrogram section makes no claim about the file any more - the removed
// lossy-source flag was the only one, and it was measurably wrong in both directions
// (see the note in fileAnalysis.test.js). The image and the window note are all there is.
// (The word "lossy" still appears in the heading's tooltip, which teaches the reader to
// spot a cliff themselves - that is the explanation, not a verdict about this file.)
test('renderFileSpectrogram states nothing beyond the image and the window note', () => {
  const html = app.renderFileSpectrogram(baseData());
  assert.ok(!/Möjlig lossy källa/i.test(html), 'the removed lossy-source verdict is back');
  assert.ok(!/\bgap\b/i.test(html), 'the removed gap-in-dB claim is back');
});

test('buildFileCopyText produces a plain-text report with the main sections', () => {
  const text = app.buildFileCopyText(baseData());
  assert.match(text, /^Filanalys: song\.flac/m);
  assert.match(text, /^LJUDNIVÅ OCH DYNAMIK$/m);
  assert.match(text, /Integrerad nivå: [-−]14,2 LUFS/);
  assert.match(text, /Loudness range \(LRA\): 6,1 LU/);
  assert.ok(!text.includes('TLEN')); // no TLEN tag in baseData
});

// The copy text is generated from the same field lists the page renders (see field()
// in shared.js), so every row the page shows has to be in it. These four used to be
// missing purely because the text version was written out by hand a second time.
test('buildFileCopyText carries the rows the page shows, with the same labels', () => {
  const text = app.buildFileCopyText(baseData());
  assert.match(text, /Sampleformat: s32/);
  assert.match(text, /Bitdjup: /);
  assert.match(text, /Omslagsbild: 500×500 px \(mjpeg\)/);
  // The LRA low/high range used to be dropped from the text version only.
  assert.match(text, /Loudness range \(LRA\): 6,1 LU \([-−]18,0 … [-−]11,9 LUFS\)/);
});

test('buildFileCopyText notes a TLEN mismatch', () => {
  const d = baseData();
  d.format.durationSec = 199;
  d.format.taggedDurationSec = 165;
  assert.match(app.buildFileCopyText(d), /Längd enligt tagg \(TLEN\): .*skiljer sig från filens uppmätta längd/);
});

test('buildFileCopyText carries partial-result errors', () => {
  const d = baseData();
  d.errors = { spectrogram: { message: 'inget spektrogram' } };
  d.spectrogram = null;
  assert.match(app.buildFileCopyText(d), /DELVIS RESULTAT[\s\S]*spectrogram: inget spektrogram/);
});

test('stereoVerdict reads the correlation value the way a phase meter is read', () => {
  assert.match(app.stereoVerdict({ correlation: 1, dualMono: true }), /dubbelmono/);
  assert.match(app.stereoVerdict({ correlation: 0.7 }), /mono-kompatibel/);
  assert.match(app.stereoVerdict({ correlation: 0.2 }), /bred stereobild/);
  assert.match(app.stereoVerdict({ correlation: -0.4 }), /motverkar varandra/);
  assert.equal(app.stereoVerdict({ correlation: null }), null);
  assert.equal(app.stereoVerdict(null), null);
});

test('buildFileCopyText includes the stereo correlation and gated phase spans', () => {
  const d = baseData();
  d.loudness.stereo.outOfPhaseSpans = [{ startSec: 12, endSec: 18, durationSec: 6 }];
  const text = app.buildFileCopyText(d);
  assert.match(text, /Stereokorrelation: \+0,62/);
  assert.match(text, /Fas- och monopartier/);
  assert.match(text, /Ur fas/);
});

test('drawFileLoudnessChart is a no-op without a canvas rather than throwing', () => {
  assert.doesNotThrow(() => app.drawFileLoudnessChart(baseData().loudness.series, -14.2));
});
