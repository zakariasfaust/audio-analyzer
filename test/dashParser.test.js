// dashParser.test.js
// Covers the MPD parser and the ISO 8601 duration helper. Pure functions, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMpd, parseIsoDuration } from '../server/dashParser.js';

const BASE = 'https://cdn.example.com/dash/manifest.mpd';

test('parseIsoDuration handles the forms an MPD actually uses', () => {
  assert.equal(parseIsoDuration('PT0S'), 0);
  assert.equal(parseIsoDuration('PT30S'), 30);
  assert.equal(parseIsoDuration('PT1M30S'), 90);
  assert.equal(parseIsoDuration('PT1H30M15.5S'), 5415.5);
  assert.equal(parseIsoDuration('P1DT2H'), 93600);
  assert.equal(parseIsoDuration('-PT10S'), -10);
});

test('parseIsoDuration rejects what is not a duration', () => {
  // A bare "P"/"PT" carries no components - treating it as 0 would silently become
  // "this VOD is 0 seconds long" rather than "the manifest did not say".
  assert.equal(parseIsoDuration('P'), null);
  assert.equal(parseIsoDuration('PT'), null);
  assert.equal(parseIsoDuration('not a duration'), null);
  assert.equal(parseIsoDuration(''), null);
  assert.equal(parseIsoDuration(null), null);
  assert.equal(parseIsoDuration(undefined), null);
});

test('a document that is not an MPD comes back as unknown instead of throwing', () => {
  assert.equal(parseMpd('<html><body>Not here</body></html>', BASE).type, 'unknown');
  assert.equal(parseMpd('', BASE).type, 'unknown');
  assert.equal(parseMpd('#EXTM3U\n#EXTINF:4,\nseg.ts', BASE).type, 'unknown');
});

test('dynamic MPD with SegmentTemplate + SegmentTimeline', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     availabilityStartTime="2026-01-01T00:00:00Z" publishTime="2026-01-01T12:00:00Z"
     minimumUpdatePeriod="PT2S" minBufferTime="PT4S" timeShiftBufferDepth="PT1M"
     suggestedPresentationDelay="PT8S">
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="sv">
      <Role value="main"/>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000">
        <SegmentTemplate timescale="48000" startNumber="1"
                         media="chunk-$RepresentationID$-$Number%05d$.m4s"
                         initialization="init-$RepresentationID$.mp4">
          <SegmentTimeline>
            <S t="0" d="96000" r="2"/>
            <S d="48000"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const parsed = parseMpd(xml, BASE);

  assert.equal(parsed.type, 'dash');
  assert.equal(parsed.presentationType, 'dynamic');
  assert.equal(parsed.minimumUpdatePeriodSec, 2);
  assert.equal(parsed.timeShiftBufferDepthSec, 60);
  assert.equal(parsed.suggestedPresentationDelaySec, 8);
  assert.equal(parsed.periodCount, 1);

  const period = parsed.periods[0];
  assert.equal(period.id, 'p0');
  assert.equal(period.startSec, 0);

  const set = period.adaptationSets[0];
  assert.equal(set.contentType, 'audio');
  assert.equal(set.lang, 'sv');
  assert.deepEqual(set.roles, ['main']);

  const rep = set.representations[0];
  assert.equal(rep.id, 'a1');
  assert.equal(rep.bandwidth, 128000);
  assert.equal(rep.audioSamplingRate, 48000);

  // r is a *repeat* count, so r="2" means three segments in that block; a missing r
  // must read as 0 repeats, not as null propagating into the arithmetic.
  assert.deepEqual(rep.segmentTemplate.timeline, [
    { t: 0, d: 96000, r: 2 },
    { t: null, d: 48000, r: 0 },
  ]);
  assert.equal(rep.segmentTemplate.timescale, 48000);
  assert.equal(rep.segmentTemplate.startNumber, 1);
});

test('static MPD: single Representation is found even with only a mimeType on it', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT10M">
  <Period>
    <AdaptationSet>
      <Representation id="only" bandwidth="96000" mimeType="audio/mp4" codecs="mp4a.40.2">
        <BaseURL>audio.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const parsed = parseMpd(xml, BASE);

  assert.equal(parsed.presentationType, 'static');
  assert.equal(parsed.mediaPresentationDurationSec, 600);
  // No id on Period/AdaptationSet: they fall back to their index as a string.
  assert.equal(parsed.periods[0].id, '0');
  assert.equal(parsed.periods[0].adaptationSets[0].id, '0');
  // contentType is absent at every level and must be inferred from the mimeType.
  assert.equal(parsed.periods[0].adaptationSets[0].contentType, 'audio');
  assert.equal(parsed.periods[0].adaptationSets[0].representations[0].baseUrl, 'https://cdn.example.com/dash/audio.mp4');
});

test('contentType falls back to the codec string when no mimeType exists anywhere', () => {
  const xml = `<MPD type="static">
  <Period>
    <AdaptationSet>
      <Representation id="r" bandwidth="1" codecs="opus"/>
    </AdaptationSet>
    <AdaptationSet>
      <Representation id="v" bandwidth="1" codecs="avc1.4d401f"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const sets = parseMpd(xml, BASE).periods[0].adaptationSets;

  assert.equal(sets[0].contentType, 'audio');
  assert.equal(sets[1].contentType, 'video');
});

test('BaseURL compounds down MPD -> Period -> AdaptationSet -> Representation', () => {
  const xml = `<MPD type="static">
  <BaseURL>https://origin.example.net/root/</BaseURL>
  <Period>
    <BaseURL>period1/</BaseURL>
    <AdaptationSet mimeType="audio/mp4">
      <BaseURL>audio/</BaseURL>
      <Representation id="a" bandwidth="1">
        <BaseURL>hi/</BaseURL>
        <SegmentTemplate media="$Number$.m4s" duration="4" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const rep = parseMpd(xml, BASE).periods[0].adaptationSets[0].representations[0];

  assert.equal(rep.baseUrl, 'https://origin.example.net/root/period1/audio/hi/');
  assert.equal(rep.segmentTemplate.baseUrl, 'https://origin.example.net/root/period1/audio/hi/');
});

test('SegmentTemplate and ContentProtection are inherited from the AdaptationSet', () => {
  const xml = `<MPD type="static">
  <Period>
    <AdaptationSet mimeType="audio/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <SegmentTemplate media="$Number$.m4s" duration="4" timescale="1" startNumber="7"/>
      <Representation id="a" bandwidth="1"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const rep = parseMpd(xml, BASE).periods[0].adaptationSets[0].representations[0];

  assert.equal(rep.segmentTemplate.media, '$Number$.m4s');
  assert.equal(rep.segmentTemplate.startNumber, 7);
  assert.equal(rep.contentProtection.length, 1);
  assert.equal(rep.contentProtection[0].value, 'cenc');
});

test('namespace prefixes are stripped so <dash:MPD> parses like <MPD>', () => {
  const xml = `<dash:MPD xmlns:dash="urn:mpeg:dash:schema:mpd:2011" type="static">
  <dash:Period>
    <dash:AdaptationSet mimeType="audio/mp4">
      <dash:Representation id="a" bandwidth="1"/>
    </dash:AdaptationSet>
  </dash:Period>
</dash:MPD>`;

  const parsed = parseMpd(xml, BASE);

  assert.equal(parsed.type, 'dash');
  assert.equal(parsed.periods[0].adaptationSets[0].representations[0].id, 'a');
});

test('regression: DOCTYPE entities are not expanded', () => {
  // processEntities is off - an MPD never needs custom entities, and expansion on an
  // attacker-supplied body is an amplification path. The entity must survive as text
  // (or not resolve at all), never expand into its replacement.
  const xml = `<?xml version="1.0"?>
<!DOCTYPE MPD [<!ENTITY boom "AAAAAAAAAA">]>
<MPD type="static">
  <Period>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="&boom;" bandwidth="1"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const parsed = parseMpd(xml, BASE);

  if (parsed.type === 'dash') {
    const id = parsed.periods[0]?.adaptationSets[0]?.representations[0]?.id ?? '';
    assert.ok(!id.includes('AAAAAAAAAA'), `entity was expanded: ${id}`);
  }
});

test('multiple Periods are all parsed and counted', () => {
  const xml = `<MPD type="static">
  <Period id="one" duration="PT30S"><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"/></AdaptationSet></Period>
  <Period id="two" duration="PT45S"><AdaptationSet mimeType="audio/mp4"><Representation id="b" bandwidth="1"/></AdaptationSet></Period>
</MPD>`;

  const parsed = parseMpd(xml, BASE);

  assert.equal(parsed.periodCount, 2);
  assert.equal(parsed.periods[1].id, 'two');
  assert.equal(parsed.periods[1].index, 1);
  assert.equal(parsed.periods[1].durationSec, 45);
});
