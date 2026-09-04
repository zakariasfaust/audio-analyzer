// analyzer.test.js
// Covers the pure computation and URL-handling parts of the analysis modules.
// Nothing here touches the network or spawns a process - the functions under test
// all take already-parsed data and return the shapes the frontend renders.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateUrl } from '../server/net.js';
import {
  computeSegmentStats,
  computeContinuityInfo,
  computeLatency,
  computeLowLatencyInfo,
} from '../server/hls.js';
import { computeNetworkPath } from '../server/networkPath.js';
import {
  chooseDashAudioRepresentation,
  generateDashSegmentUrls,
  computeDashSegmentStats,
  computeDashLatency,
} from '../server/dash.js';
import { parseMpd } from '../server/dashParser.js';

// --------------------------------------------------------------------------
// validateUrl
// --------------------------------------------------------------------------

test('validateUrl accepts http(s) and rejects everything else', () => {
  assert.equal(validateUrl('https://example.com/a.m3u8'), 'https://example.com/a.m3u8');
  assert.equal(validateUrl('http://example.com:8000/stream'), 'http://example.com:8000/stream');

  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/plain,x']) {
    assert.throws(() => validateUrl(bad), /Endast http- och https/, `should reject ${bad}`);
  }
});

test('validateUrl rejects a missing or unparseable url', () => {
  assert.throws(() => validateUrl(undefined), /saknas/);
  assert.throws(() => validateUrl(''), /saknas/);
  assert.throws(() => validateUrl(123), /saknas/);
  assert.throws(() => validateUrl('not a url'), /inte en giltig URL/);
});

test('validateUrl strips credentials so they are never forwarded or echoed back', () => {
  const cleaned = validateUrl('https://user:secret@example.com/stream');

  assert.ok(!cleaned.includes('secret'), cleaned);
  assert.ok(!cleaned.includes('user@'), cleaned);
  assert.equal(cleaned, 'https://example.com/stream');
});

// --------------------------------------------------------------------------
// Segment / continuity stats
// --------------------------------------------------------------------------

test('computeSegmentStats sums the window and averages segment length', () => {
  const stats = computeSegmentStats({
    version: 3,
    targetDuration: 6,
    mediaSequence: 10,
    endlist: false,
    segments: [{ duration: 6 }, { duration: 6 }, { duration: 4 }],
  });

  assert.equal(stats.segmentCount, 3);
  assert.equal(stats.windowSeconds, 16);
  assert.equal(stats.avgSegmentDuration, 16 / 3);
  assert.equal(stats.isLive, true);
  assert.equal(stats.encrypted, false);
  assert.equal(stats.fmp4, false);
});

test('computeSegmentStats: ENDLIST means VOD, and an empty window does not divide by zero', () => {
  assert.equal(computeSegmentStats({ endlist: true, segments: [{ duration: 4 }] }).isLive, false);

  const empty = computeSegmentStats({ segments: [] });
  assert.equal(empty.segmentCount, 0);
  assert.equal(empty.windowSeconds, 0);
  assert.equal(empty.avgSegmentDuration, null);
});

test('computeContinuityInfo reports discontinuities as absolute sequence numbers', () => {
  const info = computeContinuityInfo({
    mediaSequence: 100,
    discontinuitySequence: 3,
    segments: [{}, { discontinuity: true }, {}, { discontinuity: true }],
  });

  // Index 1 and 3 within a window starting at media sequence 100.
  assert.deepEqual(info.discontinuityPositions, [101, 103]);
  assert.equal(info.discontinuityCount, 2);
  assert.equal(info.discontinuitySequence, 3);
});

test('computeContinuityInfo passes EXT-X-START through as data, not prose', () => {
  // The wording lives in the frontend; the server reports sign and magnitude.
  const behind = computeContinuityInfo({ segments: [], startInfo: { timeOffset: -12, precise: false } });
  assert.deepEqual(behind.startInfo, { timeOffset: -12, precise: false });

  const ahead = computeContinuityInfo({ segments: [], startInfo: { timeOffset: 5, precise: true } });
  assert.deepEqual(ahead.startInfo, { timeOffset: 5, precise: true });

  assert.equal(computeContinuityInfo({ segments: [] }).startInfo, null);
});

// --------------------------------------------------------------------------
// Latency
// --------------------------------------------------------------------------

test('computeLatency: two or more PDT anchors are trusted directly', () => {
  const oldest = '2026-01-01T12:00:00.000Z';
  const newest = '2026-01-01T12:00:08.000Z';

  const latency = computeLatency({
    segments: [
      { duration: 4, programDateTime: oldest },
      { duration: 4, programDateTime: '2026-01-01T12:00:04.000Z' },
      { duration: 4, programDateTime: newest },
    ],
  });

  assert.equal(latency.available, true);
  assert.equal(latency.method, 'measured');
  assert.equal(latency.taggedSegmentCount, 3);
  assert.equal(latency.oldestProgramDateTime, oldest);
  assert.equal(latency.newestProgramDateTime, newest);
});

test('computeLatency: a single anchor is extrapolated across the window', () => {
  // Only the middle segment is tagged. The first segment starts 4 s earlier and the
  // last starts 4 s later - comparing the lone tag against the clock as if it were
  // the newest segment is what this branch exists to avoid.
  const latency = computeLatency({
    segments: [
      { duration: 4 },
      { duration: 4, programDateTime: '2026-01-01T12:00:04.000Z' },
      { duration: 4 },
    ],
  });

  assert.equal(latency.method, 'estimated');
  assert.equal(latency.taggedSegmentCount, 1);
  assert.equal(latency.oldestProgramDateTime, '2026-01-01T12:00:00.000Z');
  assert.equal(latency.newestProgramDateTime, '2026-01-01T12:00:08.000Z');
});

test('computeLatency: no usable timestamp means unavailable, not a wrong number', () => {
  assert.equal(computeLatency({ segments: [{ duration: 4 }] }).available, false);
  assert.equal(computeLatency({ segments: [] }).available, false);
  // An unparseable PDT must not become NaN-based output.
  assert.equal(computeLatency({ segments: [{ duration: 4, programDateTime: 'nonsense' }] }).available, false);
});

// --------------------------------------------------------------------------
// Low latency + network path
// --------------------------------------------------------------------------

test('computeLowLatencyInfo flags the CDN-says-yes / manifest-says-no contradiction', () => {
  const bare = { segments: [{ duration: 4 }] };

  const withoutHeader = computeLowLatencyInfo(bare, {});
  assert.equal(withoutHeader.present, false);
  assert.equal(withoutHeader.contradiction, null);

  const withHeader = computeLowLatencyInfo(bare, { 'x-llhls-blocked': 'false' });
  assert.equal(withHeader.present, false);
  assert.deepEqual(withHeader.contradiction, { header: 'x-llhls-blocked', value: 'false' });

  // When the manifest does carry LL-HLS tags there is no contradiction to report.
  const real = computeLowLatencyInfo({ segments: [], partTargetDuration: 0.5 }, { 'x-llhls-blocked': 'false' });
  assert.equal(real.present, true);
  assert.equal(real.contradiction, null);
});

test('computeNetworkPath keeps only routing headers and extracts an airport-code hint', () => {
  const result = computeNetworkPath({
    'x-cache': 'TCP_HIT from ARN52',
    'cf-ray': 'abc123-ARN',
    via: '1.1 varnish',
    'content-type': 'application/x-mpegURL',
    server: 'nginx',
  });

  assert.deepEqual(Object.keys(result.headers).sort(), ['cf-ray', 'via', 'x-cache']);
  assert.equal(result.geoHint.code, 'ARN');
  assert.equal(result.geoHint.raw, 'ARN52');

  assert.equal(computeNetworkPath({ server: 'nginx' }).geoHint, null);
  assert.deepEqual(computeNetworkPath(null).headers, {});
});

// --------------------------------------------------------------------------
// DASH representation choice and segment URL generation
// --------------------------------------------------------------------------

const mpdWith = (body) => parseMpd(`<MPD type="static">${body}</MPD>`, 'https://cdn.example.com/dash/m.mpd');

test('chooseDashAudioRepresentation prefers a declared audio AdaptationSet', () => {
  const parsed = mpdWith(`
    <Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <Representation id="v1" bandwidth="2000000"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000"/>
      </AdaptationSet>
    </Period>`);

  assert.equal(chooseDashAudioRepresentation(parsed).representation.id, 'a1');
});

test('regression: a mixed AdaptationSet yields its audio Representation, not its first', () => {
  // The set matches only because *some* representation inside it is audio. Returning
  // representations[0] blindly handed back the video track as "the audio track".
  const parsed = mpdWith(`
    <Period>
      <AdaptationSet>
        <Representation id="v1" bandwidth="2000000" mimeType="video/mp4"/>
        <Representation id="a1" bandwidth="128000" mimeType="audio/mp4"/>
      </AdaptationSet>
    </Period>`);

  assert.equal(chooseDashAudioRepresentation(parsed).representation.id, 'a1');
});

test('chooseDashAudioRepresentation returns null when there is nothing to analyse', () => {
  assert.equal(chooseDashAudioRepresentation({ periods: [] }), null);
  assert.equal(chooseDashAudioRepresentation(mpdWith('<Period></Period>')), null);
});

test('generateDashSegmentUrls: SegmentTimeline expands r-repeats and substitutes $Time$', () => {
  const parsed = mpdWith(`
    <Period>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000">
          <SegmentTemplate timescale="1000" media="seg-$Time$.m4s" initialization="init.mp4">
            <SegmentTimeline><S t="0" d="2000" r="3"/></SegmentTimeline>
          </SegmentTemplate>
        </Representation>
      </AdaptationSet>
    </Period>`);

  const chosen = chooseDashAudioRepresentation(parsed);
  const generated = generateDashSegmentUrls(chosen.period, chosen.adaptationSet, chosen.representation, parsed, 12);

  assert.equal(generated.mode, 'timeline');
  // r="3" is three repeats on top of the first segment: four in total.
  assert.equal(generated.segments.length, 4);
  assert.deepEqual(
    generated.segments.map((s) => s.uri),
    [
      'https://cdn.example.com/dash/seg-0.m4s',
      'https://cdn.example.com/dash/seg-2000.m4s',
      'https://cdn.example.com/dash/seg-4000.m4s',
      'https://cdn.example.com/dash/seg-6000.m4s',
    ]
  );
  // Durations are reported in seconds, converted through the timescale.
  assert.equal(generated.segments[0].duration, 2);
  assert.equal(generated.initUri, 'https://cdn.example.com/dash/init.mp4');
});

test('generateDashSegmentUrls: only the last `count` segments are materialised', () => {
  const parsed = mpdWith(`
    <Period>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000">
          <SegmentTemplate timescale="1" media="s$Number$.m4s" startNumber="1">
            <SegmentTimeline><S t="0" d="1" r="999"/></SegmentTimeline>
          </SegmentTemplate>
        </Representation>
      </AdaptationSet>
    </Period>`);

  const chosen = chooseDashAudioRepresentation(parsed);
  const generated = generateDashSegmentUrls(chosen.period, chosen.adaptationSet, chosen.representation, parsed, 5);

  // 1000 segments in the timeline, but a large r must not materialise 1000 URLs.
  assert.equal(generated.segments.length, 5);
  assert.equal(generated.segments.at(-1).uri, 'https://cdn.example.com/dash/s1000.m4s');
  assert.equal(generated.segments[0].uri, 'https://cdn.example.com/dash/s996.m4s');
});

test('generateDashSegmentUrls: $Number$ with a fixed duration, zero-padded', () => {
  const parsed = mpdWith(`
    <Period duration="PT20S">
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000">
          <SegmentTemplate timescale="1" duration="4" startNumber="1"
                           media="chunk-$RepresentationID$-$Number%04d$.m4s"
                           initialization="init-$Bandwidth$.mp4"/>
        </Representation>
      </AdaptationSet>
    </Period>`);

  const chosen = chooseDashAudioRepresentation(parsed);
  const generated = generateDashSegmentUrls(chosen.period, chosen.adaptationSet, chosen.representation, parsed, 12);

  assert.equal(generated.mode, 'template-number');
  // 20 s / 4 s = 5 segments.
  assert.equal(generated.segments.length, 5);
  assert.equal(generated.segments[0].uri, 'https://cdn.example.com/dash/chunk-a1-0001.m4s');
  assert.equal(generated.segments.at(-1).uri, 'https://cdn.example.com/dash/chunk-a1-0005.m4s');
  assert.equal(generated.segments[0].duration, 4);
  assert.equal(generated.initUri, 'https://cdn.example.com/dash/init-128000.mp4');
});

test('generateDashSegmentUrls: SegmentList enumerates its SegmentURLs', () => {
  const parsed = mpdWith(`
    <Period>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000">
          <SegmentList timescale="1" duration="4">
            <Initialization sourceURL="init.mp4"/>
            <SegmentURL media="s1.m4s"/>
            <SegmentURL media="s2.m4s"/>
          </SegmentList>
        </Representation>
      </AdaptationSet>
    </Period>`);

  const chosen = chooseDashAudioRepresentation(parsed);
  const generated = generateDashSegmentUrls(chosen.period, chosen.adaptationSet, chosen.representation, parsed, 12);

  assert.equal(generated.mode, 'segment-list');
  assert.deepEqual(
    generated.segments.map((s) => s.uri),
    ['https://cdn.example.com/dash/s1.m4s', 'https://cdn.example.com/dash/s2.m4s']
  );
  assert.equal(generated.initUri, 'https://cdn.example.com/dash/init.mp4');
});

test('generateDashSegmentUrls: a plain BaseURL representation is one single file', () => {
  const parsed = mpdWith(`
    <Period duration="PT2M">
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000"><BaseURL>whole.mp4</BaseURL></Representation>
      </AdaptationSet>
    </Period>`);

  const chosen = chooseDashAudioRepresentation(parsed);
  const generated = generateDashSegmentUrls(chosen.period, chosen.adaptationSet, chosen.representation, parsed, 12);

  assert.equal(generated.mode, 'base-url');
  assert.equal(generated.segments.length, 1);
  assert.equal(generated.segments[0].uri, 'https://cdn.example.com/dash/whole.mp4');
  assert.equal(generated.segments[0].duration, 120);
});

test('computeDashLatency reports a reason code, not a Swedish sentence', () => {
  // The UI owns the wording; a static MPD and a dynamic one missing its anchor are
  // two different situations and the frontend needs to tell them apart.
  const staticMpd = mpdWith(`
    <Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"/></AdaptationSet></Period>`);
  const staticResult = computeDashLatency(staticMpd, chooseDashAudioRepresentation(staticMpd));
  assert.equal(staticResult.available, false);
  assert.equal(staticResult.reason, 'vod');

  const dynamicNoAst = parseMpd(
    `<MPD type="dynamic"><Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"/></AdaptationSet></Period></MPD>`,
    'https://cdn.example.com/dash/m.mpd'
  );
  const dynamicResult = computeDashLatency(dynamicNoAst, chooseDashAudioRepresentation(dynamicNoAst));
  assert.equal(dynamicResult.available, false);
  assert.equal(dynamicResult.reason, 'no-availability-start-time');
});

test('computeDashLatency: a dynamic MPD with an anchor produces a live delay estimate', () => {
  const parsed = parseMpd(
    `<MPD type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" minBufferTime="PT4S">
       <Period start="PT0S"><AdaptationSet mimeType="audio/mp4">
         <Representation id="a" bandwidth="1">
           <SegmentTemplate timescale="1" duration="6" media="$Number$.m4s"/>
         </Representation>
       </AdaptationSet></Period>
     </MPD>`,
    'https://cdn.example.com/dash/m.mpd'
  );
  const result = computeDashLatency(parsed, chooseDashAudioRepresentation(parsed));

  assert.equal(result.available, true);
  // No suggestedPresentationDelay in the manifest, so it falls back to ~3 segments.
  assert.equal(result.method, 'estimated');
  assert.equal(result.segmentDurationSec, 6);
  assert.equal(result.estimatedLiveDelaySec, 18);
  assert.equal(result.epochAnchored, false);
});

test('computeDashSegmentStats describes the addressing mode it found', () => {
  const parsed = mpdWith(`
    <Period duration="PT20S">
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a1" bandwidth="128000">
          <SegmentTemplate timescale="1" duration="4" startNumber="1" media="s$Number$.m4s" initialization="i.mp4"/>
        </Representation>
      </AdaptationSet>
    </Period>`);

  const chosen = chooseDashAudioRepresentation(parsed);
  const stats = computeDashSegmentStats(parsed, chosen);

  assert.equal(stats.isLive, false);
  assert.equal(stats.segmentAddressing, 'template-number'); // a code, not a label
  assert.equal(stats.segmentDurationSec, 4);
  assert.equal(stats.windowSeconds, 20);
  assert.equal(stats.segmentCount, 5);
  assert.equal(stats.fmp4, true);
  assert.equal(stats.encrypted, false);
});
