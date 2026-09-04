// parser.test.js
// Covers the M3U8 parser. No network: parseM3U8 is a pure text -> object function,
// which is exactly why it is worth pinning down here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseM3U8 } from '../server/parser.js';

const BASE = 'https://cdn.example.com/live/master.m3u8';

test('master playlist: variants, codecs with a comma, and audio renditions', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Svenska",LANGUAGE="sv",DEFAULT=YES,URI="audio/sv.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,AVERAGE-BANDWIDTH=120000,CODECS="mp4a.40.2,avc1.4d401f",RESOLUTION=1920x1080,AUDIO="aac"',
    'variant-128.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
    'variant-64.m3u8',
  ].join('\n');

  const parsed = parseM3U8(text, BASE);

  assert.equal(parsed.type, 'master');
  assert.equal(parsed.version, 4);
  assert.equal(parsed.variants.length, 2);

  const [first, second] = parsed.variants;
  assert.equal(first.bandwidth, 128000);
  assert.equal(first.averageBandwidth, 120000);
  // The quoted CODECS value contains a comma; splitting on it naively would truncate.
  assert.equal(first.codecs, 'mp4a.40.2,avc1.4d401f');
  assert.equal(first.resolution, '1920x1080');
  assert.equal(first.audioGroup, 'aac');
  assert.equal(first.url, 'https://cdn.example.com/live/variant-128.m3u8');
  assert.equal(second.url, 'https://cdn.example.com/live/variant-64.m3u8');

  assert.equal(parsed.audioRenditions.length, 1);
  assert.deepEqual(
    {
      groupId: parsed.audioRenditions[0].groupId,
      language: parsed.audioRenditions[0].language,
      isDefault: parsed.audioRenditions[0].isDefault,
      uri: parsed.audioRenditions[0].uri,
    },
    { groupId: 'aac', language: 'sv', isDefault: true, uri: 'https://cdn.example.com/live/audio/sv.m3u8' }
  );
});

test('media playlist: segments carry their pending duration, title, PDT and discontinuity', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:42',
    '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T12:00:00.000Z',
    '#EXTINF:6.0,first',
    'seg1.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5.5,',
    'seg2.ts',
  ].join('\n');

  const parsed = parseM3U8(text, BASE);

  assert.equal(parsed.type, 'media');
  assert.equal(parsed.targetDuration, 6);
  assert.equal(parsed.mediaSequence, 42);
  assert.equal(parsed.endlist, false);
  assert.equal(parsed.segments.length, 2);

  assert.equal(parsed.segments[0].uri, 'https://cdn.example.com/live/seg1.ts');
  assert.equal(parsed.segments[0].duration, 6);
  assert.equal(parsed.segments[0].title, 'first');
  assert.equal(parsed.segments[0].programDateTime, '2026-01-01T12:00:00.000Z');
  assert.equal(parsed.segments[0].discontinuity, false);

  // Pending values must reset after each segment, and the discontinuity applies to
  // the segment that follows the tag - not the one before it.
  assert.equal(parsed.segments[1].duration, 5.5);
  assert.equal(parsed.segments[1].programDateTime, null);
  assert.equal(parsed.segments[1].discontinuity, true);
});

test('regression: MEDIA-SEQUENCE 0 stays 0 rather than becoming null', () => {
  // `Number(x) || null` mapped a legitimate 0 to null, so a stream that had just
  // started rendered its sequence number as "-".
  const text = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:4.0,', 'seg.ts'].join('\n');

  const parsed = parseM3U8(text, BASE);

  assert.equal(parsed.mediaSequence, 0);
  assert.notEqual(parsed.mediaSequence, null);
});

test('media playlist: a non-numeric tag value is null, not NaN', () => {
  const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:abc', '#EXTINF:4.0,', 'seg.ts'].join('\n');

  assert.equal(parseM3U8(text, BASE).targetDuration, null);
});

test('EXT-X-KEY: an encrypted playlist reports its key, METHOD=NONE clears it', () => {
  const encrypted = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000',
    '#EXTINF:4.0,',
    'seg.ts',
  ].join('\n');

  const key = parseM3U8(encrypted, BASE).key;
  assert.equal(key.method, 'AES-128');
  assert.equal(key.uri, 'https://cdn.example.com/live/key.bin');
  assert.equal(key.ivPresent, true);

  // A later METHOD=NONE means the stream stopped being encrypted.
  const cleared = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:4.0,',
    'seg1.ts',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4.0,',
    'seg2.ts',
  ].join('\n');

  assert.equal(parseM3U8(cleared, BASE).key, null);
});

test('LL-HLS: parts attach to their segment, and trailing parts are kept separately', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5,HOLD-BACK=6',
    '#EXT-X-PART-INF:PART-TARGET=0.5',
    '#EXT-X-PART:DURATION=0.5,URI="p1.mp4",INDEPENDENT=YES',
    '#EXT-X-PART:DURATION=0.5,URI="p2.mp4"',
    '#EXTINF:1.0,',
    'seg1.mp4',
    // Parts for the segment that has not finished yet - no EXTINF/URI line follows.
    '#EXT-X-PART:DURATION=0.5,URI="p3.mp4"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="p4.mp4"',
    '#EXT-X-RENDITION-REPORT:URI="../low/media.m3u8",LAST-MSN=99,LAST-PART=1',
  ].join('\n');

  const parsed = parseM3U8(text, BASE);

  assert.equal(parsed.serverControl.canBlockReload, true);
  assert.equal(parsed.serverControl.partHoldBack, 1.5);
  assert.equal(parsed.partTargetDuration, 0.5);

  assert.equal(parsed.segments[0].parts.length, 2);
  assert.equal(parsed.segments[0].parts[0].independent, true);
  assert.equal(parsed.segments[0].parts[1].independent, false);

  assert.equal(parsed.trailingParts.length, 1);
  assert.equal(parsed.trailingParts[0].uri, 'https://cdn.example.com/live/p3.mp4');

  assert.equal(parsed.preloadHint.type, 'PART');
  assert.equal(parsed.renditionReports[0].lastMsn, 99);
  assert.equal(parsed.renditionReports[0].uri, 'https://cdn.example.com/low/media.m3u8');
});

test('DISCONTINUITY-SEQUENCE is matched before the shorter DISCONTINUITY tag', () => {
  const text = ['#EXTM3U', '#EXT-X-DISCONTINUITY-SEQUENCE:7', '#EXTINF:4.0,', 'seg.ts'].join('\n');

  const parsed = parseM3U8(text, BASE);

  assert.equal(parsed.discontinuitySequence, 7);
  // The prefix check must not also have flagged the segment as a discontinuity.
  assert.equal(parsed.segments[0].discontinuity, false);
});

test('a playlist with neither variant nor segment tags is "unknown"', () => {
  assert.equal(parseM3U8('#EXTM3U\n#EXT-X-VERSION:3\n', BASE).type, 'unknown');
});

test('absolute segment URIs are left alone, relative ones resolve against the manifest', () => {
  const text = [
    '#EXTM3U',
    '#EXTINF:4.0,',
    'https://other.example.net/abs.ts',
    '#EXTINF:4.0,',
    '../up/rel.ts',
  ].join('\n');

  const segments = parseM3U8(text, BASE).segments;

  assert.equal(segments[0].uri, 'https://other.example.net/abs.ts');
  assert.equal(segments[1].uri, 'https://cdn.example.com/up/rel.ts');
});
