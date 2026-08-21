// app.js
// Vanilla JS - no build step, no import/export. Runs directly in the browser.
// Clicking Analyze: POST /api/analyze (status snapshot) followed by
// GET /api/sample (ID3/"now playing") - the result is rendered into #results.

const form = document.getElementById('analyze-form');
const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const copyBtn = document.getElementById('copy-btn');

// Latest analysis result - kept in memory so the Copy button can build
// the text excerpt without redoing any network requests.
let lastAnalyzeData = null;
let lastSampleData = null;
let lastSampleError = null;

// ---------------------------------------------------------------------
// Formatting: Swedish convention (decimal comma, space as
// thousands separator, YYYY-MM-DD HH:MM:SS) - keeps the numbers readable
// for the (Swedish-speaking) audience the UI targets.
// ---------------------------------------------------------------------

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNumber(n, decimals = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Math.round(n).toLocaleString('sv-SE');
}

// Seconds as "12,3 s" under a minute, otherwise "X min Y s" or "X h Y min"
// - so large delay/duration values (e.g. 10 000 s) stay easy to read.
function fmtDuration(totalSeconds, decimals = 1) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '–';
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(totalSeconds);
  if (abs < 60) return `${sign}${fmtNumber(abs, decimals)} s`;
  const whole = Math.round(abs);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${sign}${h} h ${m} min` : `${sign}${m} min ${s} s`;
}

function fmtDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Heading/value name with a hover explanation from HLS_TERMS (terms.js), as a
// native title tooltip. Elements without a matching key get no title attribute.
function withHint(tag, label, key) {
  const text = HLS_TERMS[key];
  const titleAttr = text ? ` title="${esc(text)}"` : '';
  return `<${tag}${titleAttr}>${esc(label)}</${tag}>`;
}

// ---------------------------------------------------------------------
// Rendering - one function per section. Builds HTML strings with esc()
// around everything that comes from an external source (headers, manifest text, URLs).
// ---------------------------------------------------------------------

function renderConnection(c) {
  const corsLine = c.cors.present
    ? `<dd>Ja (${esc(c.cors.allowOrigin)})</dd>`
    : `<dd class="error">Nej - CORS-headers saknas. hls.js/webbläsaren kan inte hämta direkt från CDN:en.</dd>`;

  const extra = Object.entries(c.extraHeaders || {});
  const extraHtml = extra.length
    ? `<table><thead><tr><th>Header</th><th>Värde</th></tr></thead><tbody>${extra
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="note">Inga x- eller akamai-headers.</p>';

  return `
    <section id="sec-connection">
      ${withHint('h2', 'Anslutning', 'anslutning')}
      <dl>
        ${withHint('dt', 'Status', 'status')}<dd>${c.status} ${esc(c.statusText)}</dd>
        ${withHint('dt', 'Begärd URL', 'begard-url')}<dd>${esc(c.requestedUrl)}</dd>
        ${withHint('dt', 'Slutlig URL', 'slutlig-url')}<dd>${esc(c.finalUrl)}${c.redirected ? ' (omdirigerad)' : ''}</dd>
        ${withHint('dt', 'Content-Type', 'content-type')}<dd>${esc(c.contentType) || '–'}</dd>
        ${withHint('dt', 'Server', 'server')}<dd>${esc(c.server) || '–'}</dd>
        ${withHint('dt', 'Cache-Control', 'cache-control')}<dd>${esc(c.cacheControl) || '–'}</dd>
        ${withHint('dt', 'Expires', 'expires')}<dd>${esc(c.expires) || '–'}</dd>
        ${withHint('dt', 'CORS', 'cors')}${corsLine}
      </dl>
      ${withHint('h3', 'x- / akamai-headers', 'extra-headers')}
      ${extraHtml}
    </section>`;
}

function renderVariants(v, activeUrl) {
  if (v.singleVariantNote) {
    return `
      <section id="sec-variants">
        ${withHint('h2', 'Varianter', 'varianter')}
        <p class="note">Endast en variant tillgänglig (vanligt för radio) - URL:en pekar direkt på media-playlistan.</p>
      </section>`;
  }
  const rows = v.list
    .map((variant) => {
      const isActive = variant.url === activeUrl;
      return `
      <tr class="variant-row${isActive ? ' variant-active' : ''}" data-variant-url="${esc(variant.url)}" tabindex="0" title="Klicka för att analysera den här varianten">
        <td>${fmtInt(variant.bandwidth ? variant.bandwidth / 1000 : null)}</td>
        <td>${fmtInt(variant.averageBandwidth ? variant.averageBandwidth / 1000 : null)}</td>
        <td>${esc(variant.codecs) || '–'}</td>
        <td>${esc(variant.resolution) || '–'}</td>
        <td>${esc(variant.url)}</td>
      </tr>`;
    })
    .join('');
  return `
    <section id="sec-variants">
      ${withHint('h2', 'Varianter', 'varianter')}
      <p class="note">Klicka på en rad för att analysera just den varianten.</p>
      <table>
        <thead><tr>${withHint('th', 'Bandbredd (kbit/s)', 'variant-bandbredd')}${withHint('th', 'Snitt (kbit/s)', 'variant-snitt')}${withHint('th', 'Codecs', 'codecs')}${withHint('th', 'Upplösning', 'upplosning')}${withHint('th', 'URL', 'variant-url')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderAudio(a) {
  if (!a) {
    return `
      <section id="sec-audio">
        ${withHint('h2', 'Ljudspåret', 'ljud')}
        <p class="note">Kunde inte hämtas (se varningar ovan).</p>
      </section>`;
  }
  return `
    <section id="sec-audio">
      ${withHint('h2', 'Ljudspåret', 'ljud')}
      <dl>
        ${withHint('dt', 'Codec', 'codec')}<dd>${esc(a.codec) || '–'}${a.profile ? ' (' + esc(a.profile) + ')' : ''}</dd>
        ${withHint('dt', 'Samplingsfrekvens', 'samplingsfrekvens')}<dd>${a.sampleRate ? fmtInt(a.sampleRate) + ' Hz' : '–'}</dd>
        ${withHint('dt', 'Kanaler', 'kanaler')}<dd>${a.channels ?? '–'}${a.channelLayout ? ' (' + esc(a.channelLayout) + ')' : ''}</dd>
        ${withHint('dt', 'Bitrate', 'audio-bitrate')}<dd>${a.bitRate ? fmtNumber(a.bitRate / 1000) + ' kbit/s' : 'okänd (se uppmätt bitrate nedan)'}</dd>
        ${withHint('dt', 'Container', 'container')}<dd>${esc(a.container) || '–'}</dd>
      </dl>
    </section>`;
}

function renderSegments(s, continuity) {
  return `
    <section id="sec-segments">
      ${withHint('h2', 'Segment och buffert', 'segment')}
      <dl>
        ${withHint('dt', 'Version', 'version')}<dd>${s.version ?? '–'}</dd>
        ${withHint('dt', 'Target duration', 'targetduration')}<dd>${fmtDuration(s.targetDuration, 0)}</dd>
        ${withHint('dt', 'Media sequence', 'mediasequence')}<dd>${fmtInt(s.mediaSequence)}</dd>
        ${withHint('dt', 'Typ', 'typ')}<dd>${s.isLive ? 'Live' : 'VOD'}${s.playlistType ? ' (' + esc(s.playlistType) + ')' : ''}</dd>
        ${withHint('dt', 'Antal segment i fönstret', 'antal-segment')}<dd>${s.segmentCount}</dd>
        ${withHint('dt', 'Fönsterlängd', 'fonsterlangd')}<dd>${fmtDuration(s.windowSeconds)}</dd>
        ${withHint('dt', 'Snittlängd/segment', 'snittlangd')}<dd>${fmtDuration(s.avgSegmentDuration)}</dd>
        ${withHint('dt', 'Kryptering', 'krypterat')}<dd>${s.encrypted ? esc(s.keyMethod) : 'Av'}</dd>
        ${withHint('dt', 'Segmentformat', 'fmp4')}<dd>${s.fmp4 ? 'Fragmenterad MP4 (fMP4)' : 'Ej fragmenterat (MPEG-TS)'}</dd>
      </dl>
      ${renderContinuity(continuity)}
    </section>`;
}

// "Continuity and start point" subsection: EXT-X-DISCONTINUITY-SEQUENCE,
// where EXT-X-DISCONTINUITY actually sits (as absolute sequence numbers),
// and EXT-X-START converted into a readable sentence.
function renderContinuity(c) {
  const discontinuityLine =
    c.discontinuityCount === 0
      ? 'Inga i det aktuella fönstret.'
      : `${c.discontinuityCount} st - vid sekvensnummer ${c.discontinuityPositions.map((n) => fmtInt(n)).join(', ')}.`;

  const startLine = c.startInfo
    ? `TIME-OFFSET=${c.startInfo.timeOffset}${c.startInfo.precise ? ' (PRECISE)' : ''} - ${c.startExplanation}`
    : 'Hittades inte.';

  return `
    <div class="subsection">
      ${withHint('h3', 'Kontinuitet och startpunkt', 'kontinuitet')}
      <dl>
        ${withHint('dt', 'EXT-X-DISCONTINUITY-SEQUENCE', 'discontinuity-sequence')}<dd>${
          c.discontinuitySequence !== null ? fmtInt(c.discontinuitySequence) : 'Hittades inte (standard: 0)'
        }</dd>
        ${withHint('dt', 'Discontinuities', 'discontinuities')}<dd>${discontinuityLine}</dd>
        ${withHint('dt', 'EXT-X-START', 'ext-x-start')}<dd>${startLine}</dd>
      </dl>
    </div>`;
}

// "Low-Latency HLS" subsection: EXT-X-SERVER-CONTROL, EXT-X-PART-INF,
// EXT-X-PART, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT. Shows "Not
// found" per field instead of hiding rows - and flags the interesting
// contradiction if the CDN signals LL-HLS (e.g. Akamai's x-llhls-blocked:
// false) but the manifest itself lacks all the tags.
function renderLowLatency(ll) {
  const contradictionNote = ll.contradiction
    ? `<p class="note error">Motsägelse: CDN-headern <code>${esc(ll.contradiction.header)}: ${esc(
        ll.contradiction.value
      )}</code> antyder LL-HLS-stöd, men inga LL-HLS-taggar hittades i manifestet.</p>`
    : '';

  if (!ll.present) {
    return `
      <div class="subsection">
        ${withHint('h3', 'Low-Latency HLS', 'llhls')}
        <p class="note">Inga LL-HLS-taggar hittades i manifestet.</p>
        ${contradictionNote}
      </div>`;
  }

  const sc = ll.serverControl;

  const partsTable = (parts) =>
    parts.length
      ? `<table><thead><tr><th>#</th><th>Längd</th><th>Oberoende (INDEPENDENT)</th><th>URI</th></tr></thead><tbody>${parts
          .map(
            (p, i) =>
              `<tr><td>${i + 1}</td><td>${fmtDuration(p.duration)}</td><td>${p.independent ? 'Ja' : 'Nej'}</td><td>${esc(
                p.uri
              )}</td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p class="note">Hittades inte.</p>';

  const renditionTable = ll.renditionReports.length
    ? `<table><thead><tr><th>Rendition</th><th>Senaste media-sequence</th><th>Senaste part</th></tr></thead><tbody>${ll.renditionReports
        .map((r) => `<tr><td>${esc(r.uri)}</td><td>${r.lastMsn ?? '–'}</td><td>${r.lastPart ?? '–'}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="note">Hittades inte.</p>';

  return `
    <div class="subsection">
      ${withHint('h3', 'Low-Latency HLS', 'llhls')}
      ${contradictionNote}
      <dl>
        ${withHint('dt', 'CAN-BLOCK-RELOAD', 'll-can-block-reload')}<dd>${sc ? (sc.canBlockReload ? 'Ja' : 'Nej') : 'Hittades inte'}</dd>
        ${withHint('dt', 'HOLD-BACK', 'll-hold-back')}<dd>${sc && sc.holdBack !== null ? fmtDuration(sc.holdBack) : 'Hittades inte'}</dd>
        ${withHint('dt', 'PART-HOLD-BACK', 'll-part-hold-back')}<dd>${
          sc && sc.partHoldBack !== null ? fmtDuration(sc.partHoldBack) : 'Hittades inte'
        }</dd>
        ${withHint('dt', 'CAN-SKIP-UNTIL', 'll-can-skip-until')}<dd>${
          sc && sc.canSkipUntil !== null ? fmtDuration(sc.canSkipUntil) : 'Hittades inte'
        }</dd>
        ${withHint('dt', 'CAN-SKIP-DATERANGES', 'll-can-skip-dateranges')}<dd>${sc ? (sc.canSkipDateranges ? 'Ja' : 'Nej') : 'Hittades inte'}</dd>
        ${withHint('dt', 'PART-TARGET', 'll-part-target')}<dd>${ll.partTargetDuration ? fmtDuration(ll.partTargetDuration) : 'Hittades inte'}</dd>
      </dl>
      <p class="note">Delsegment (EXT-X-PART) i senaste färdiga segmentet:</p>
      ${partsTable(ll.lastSegmentParts)}
      ${
        ll.trailingParts.length
          ? `<p class="note">Delsegment för nästa, ännu ej färdiga segment:</p>${partsTable(ll.trailingParts)}`
          : ''
      }
      <dl>
        ${withHint('dt', 'PRELOAD-HINT', 'll-preload-hint')}<dd>${
          ll.preloadHint ? `${esc(ll.preloadHint.type)}: ${esc(ll.preloadHint.uri)}` : 'Hittades inte'
        }</dd>
      </dl>
      <p class="note">RENDITION-REPORT (status för andra renditions):</p>
      ${renditionTable}
    </div>`;
}

function renderLatency(l, lowLatency) {
  if (!l.available) {
    return `
      <section id="sec-latency">
        ${withHint('h2', 'Latens', 'latens')}
        <p class="note">Latens kan inte beräknas (ingen PROGRAM-DATE-TIME-tidsstämpel i manifestet).</p>
        ${renderLowLatency(lowLatency)}
      </section>`;
  }
  const methodLabel = l.method === 'measured' ? 'Uppmätt direkt' : 'Beräknad från segmentsumma';
  return `
    <section id="sec-latency">
      ${withHint('h2', 'Latens', 'latens')}
      <dl>
        ${withHint('dt', 'Beräkningsmetod', 'latens-metod')}<dd>${methodLabel} (${l.taggedSegmentCount} taggat${l.taggedSegmentCount === 1 ? '' : 'a'} segment)</dd>
        ${withHint('dt', 'Äldsta segmentets tidsstämpel', 'aldsta-ts')}<dd>${fmtDateTime(l.oldestProgramDateTime)}</dd>
        ${withHint('dt', 'Nyaste segmentets tidsstämpel', 'nyaste-ts')}<dd>${fmtDateTime(l.newestProgramDateTime)}</dd>
        ${withHint('dt', 'Fördröjning (från äldsta)', 'fordrojning-aldsta')}<dd>${fmtDuration(l.delaySecondsFromOldest)}</dd>
        ${withHint('dt', 'Fördröjning (från nyaste, live-kant)', 'fordrojning-nyaste')}<dd>${fmtDuration(l.delaySecondsFromNewest)}</dd>
      </dl>
      ${renderLowLatency(lowLatency)}
    </section>`;
}

function renderBitrate(b) {
  const rows = (b.samples || [])
    .map(
      (s) => `
      <tr>
        <td>${fmtDateTime(s.programDateTime)}</td>
        <td>${s.ok ? fmtInt(s.bytes) : '–'}</td>
        <td>${s.ok ? fmtNumber(s.bitrateKbps) : 'misslyckades'}</td>
      </tr>`
    )
    .join('');
  return `
    <section id="sec-bitrate">
      ${withHint('h2', 'Uppmätt bitrate', 'bitrate')}
      <dl>
        ${withHint('dt', 'Snitt (uppmätt)', 'snitt-uppmatt')}<dd>${b.averageMeasuredBitrateKbps ? fmtNumber(b.averageMeasuredBitrateKbps) + ' kbit/s' : '–'}</dd>
        ${withHint('dt', 'Deklarerad bandbredd', 'deklarerad-bandbredd')}<dd>${b.declaredBandwidthKbps ? fmtNumber(b.declaredBandwidthKbps) + ' kbit/s' : 'okänd (ingen BANDWIDTH-uppgift)'}</dd>
      </dl>
      <table>
        <thead><tr>${withHint('th', 'Tidsstämpel', 'tidsstampel')}${withHint('th', 'Bytes', 'bytes')}${withHint('th', 'Bitrate (kbit/s)', 'bitrate-kolumn')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderId3Placeholder() {
  return `<section id="sec-id3">${withHint('h2', 'Nu spelas (ID3)', 'id3')}<p class="note">Hämtar…</p></section>`;
}

function renderId3(sample, error) {
  if (error) {
    return `${withHint('h2', 'Nu spelas (ID3)', 'id3')}<p class="error">${esc(error.message)}</p>`;
  }
  if (!sample.id3.available) {
    return `${withHint('h2', 'Nu spelas (ID3)', 'id3')}<p class="note">Ingen ID3-metadata hittades i den här strömmen (inspelning: ${fmtDuration(
      sample.actualDurationSec
    )}, uppmätt ${fmtNumber(sample.measuredBitrateKbps)} kbit/s).</p>`;
  }
  const rows = sample.id3.frames
    .map(
      (f) => `
      <tr>
        <td>${fmtDuration(f.ptsTime)}</td>
        <td>${esc(JSON.stringify(f.tags))}</td>
      </tr>`
    )
    .join('');
  return `
    ${withHint('h2', 'Nu spelas (ID3)', 'id3')}
    <table>
      <thead><tr>${withHint('th', 'Tid i segment', 'tid-i-segment')}${withHint('th', 'Taggar', 'taggar')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// "Network path": generically matched CDN/edge routing headers, a
// best-effort guess at a geographic hint in the node name, and a
// server-side DNS lookup of the media playlist's hostname.
function renderNetworkPath(np) {
  const headerRows = Object.entries(np.headers || {});
  const headerTable = headerRows.length
    ? `<table><thead><tr><th>Header</th><th>Värde</th></tr></thead><tbody>${headerRows
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="note">Inga headrar som matchar routing-mönstren (x-cache*, x-served*, x-edge*, via, x-amz-cf*, cf-*, x-akamai*) hittades.</p>';

  const dnsInfo = np.dns || {};
  const dnsResult = dnsInfo.error
    ? `Kunde inte slås upp: ${esc(dnsInfo.error)}`
    : dnsInfo.addresses?.length
    ? esc(dnsInfo.addresses.join(', '))
    : 'Inga adresser hittades';

  const ipGeoResult = (dnsInfo.ipGeo || []).some((g) => g)
    ? dnsInfo.ipGeo
        .map((g, i) => `${esc(dnsInfo.addresses[i])}: ${g ? `${esc(g.city || '–')}, ${esc(g.country || '–')}` : 'okänd'}`)
        .join('; ')
    : 'Hittades inte';

  return `
    <section id="sec-network">
      ${withHint('h2', 'Nätverksväg', 'natverksvag')}
      ${headerTable}
      <dl>
        ${withHint('dt', 'Möjlig geografisk ledtråd', 'geo-hint')}<dd>${
          np.geoHint
            ? `${esc(np.geoHint.raw)} (gissning baserad på ett vanligt nodnamnsmönster, inte bekräftad)`
            : 'Hittades inte'
        }</dd>
        ${withHint('dt', 'DNS-uppslagning', 'dns-lookup')}<dd>${esc(dnsInfo.hostname) || '–'} → ${dnsResult}</dd>
        ${withHint('dt', 'Geografisk uppskattning (IP-databas)', 'ip-geo')}<dd>${ipGeoResult} (ograskad, lokal databas - kan vara inaktuell eller fel för CDN-adresser)</dd>
      </dl>
      <p class="note">DNS-baserad lastbalansering kan ge olika svar mellan anrop - detta är inte nödvändigtvis samma nod som faktiskt svarade på HTTP-anropet i Anslutning-kortet.</p>
    </section>`;
}

function renderManifests(m) {
  const masterBlock = m.master
    ? `<h3>Master (${esc(m.master.url)})</h3><pre>${esc(m.master.raw)}</pre>`
    : '';
  return `
    <section id="sec-manifest">
      ${withHint('h2', 'Råmanifest', 'manifest')}
      ${masterBlock}
      <h3>Media (${esc(m.media.url)})</h3>
      <pre>${esc(m.media.raw)}</pre>
    </section>`;
}

function renderWarnings(errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return '';
  const items = entries.map(([key, e]) => `<li><strong>${esc(key)}:</strong> ${esc(e.message)}</li>`).join('');
  return `
    <section id="sec-warnings">
      <h2>Varningar (delvis resultat)</h2>
      <ul>${items}</ul>
    </section>`;
}

function renderFatalError(err) {
  const d = err.details || {};
  let extra = '';
  if (d.status) extra += `<dt>HTTP-status</dt><dd>${d.status} ${esc(d.statusText || '')}</dd>`;
  if (d.bodySnippet) extra += `<dt>Svarskropp (utdrag)</dt><dd><pre>${esc(d.bodySnippet)}</pre></dd>`;
  if (d.geoblockGuess) extra += `<dt>Trolig orsak</dt><dd>Geoblockering (403 med tomt svar)</dd>`;
  if (d.preview) extra += `<dt>Vad som kom tillbaka</dt><dd><pre>${esc(d.preview)}</pre></dd>`;
  if (d.installHelp) {
    extra += `<dt>Installation</dt><dd>macOS: <code>${esc(d.installHelp.macOS)}</code><br />Linux: <code>${esc(
      d.installHelp.linux
    )}</code></dd>`;
  }
  if (d.stderr) extra += `<dt>Felutdata</dt><dd><pre>${esc(d.stderr)}</pre></dd>`;
  if (d.url) extra += `<dt>URL</dt><dd>${esc(d.url)}</dd>`;

  return `
    <section id="sec-error">
      <h2 class="error">Fel</h2>
      <p class="error">${esc(err.message)}</p>
      <dl>${extra}</dl>
    </section>`;
}

// ---------------------------------------------------------------------
// Text excerpt for the Copy button - the same data that's rendered on the
// page, but as plain text without the raw manifest (which is just a long
// segment list and adds nothing for an AI analysis of the stream's properties).
// ---------------------------------------------------------------------

function buildCopyText(data, sample, sampleError, variantsOverride) {
  const lines = [];
  const add = (line = '') => lines.push(line);

  add(`HLS-analys: ${data.requestedUrl}`);
  if (currentMasterUrl && currentAnalyzedUrl && currentAnalyzedUrl !== currentMasterUrl) {
    add(`(Variant vald från master: ${currentMasterUrl})`);
  }
  add(`Genererad: ${fmtDateTime(new Date().toISOString())}`);
  add('');

  const c = data.connection;
  add('ANSLUTNING');
  add(`Status: ${c.status} ${c.statusText}`);
  add(`Begärd URL: ${c.requestedUrl}`);
  add(`Slutlig URL: ${c.finalUrl}${c.redirected ? ' (omdirigerad)' : ''}`);
  add(`Content-Type: ${c.contentType || '–'}`);
  add(`Server: ${c.server || '–'}`);
  add(`Cache-Control: ${c.cacheControl || '–'}`);
  add(`Expires: ${c.expires || '–'}`);
  add(`CORS: ${c.cors.present ? `Ja (${c.cors.allowOrigin})` : 'Nej - saknas'}`);
  const extraHeaders = Object.entries(c.extraHeaders || {});
  if (extraHeaders.length) {
    add('x-/akamai-headers:');
    extraHeaders.forEach(([k, v]) => add(`  ${k}: ${v}`));
  }
  add('');

  const v = variantsOverride || data.variants;
  add('VARIANTER');
  if (v.singleVariantNote) {
    add('Endast en variant tillgänglig (vanligt för radio) - URL:en pekar direkt på media-playlistan.');
  } else {
    v.list.forEach((variant) => {
      add(
        `- ${fmtInt(variant.bandwidth ? variant.bandwidth / 1000 : null)} kbit/s (snitt ${fmtInt(
          variant.averageBandwidth ? variant.averageBandwidth / 1000 : null
        )}), ${variant.codecs || 'okänd codec'}, ${variant.resolution || 'ingen video'}, ${variant.url}`
      );
    });
  }
  add('');

  const a = data.audio;
  add('LJUDSPÅRET');
  if (a) {
    add(`Codec: ${a.codec || '–'}${a.profile ? ' (' + a.profile + ')' : ''}`);
    add(`Samplingsfrekvens: ${a.sampleRate ? fmtInt(a.sampleRate) + ' Hz' : '–'}`);
    add(`Kanaler: ${a.channels ?? '–'}${a.channelLayout ? ' (' + a.channelLayout + ')' : ''}`);
    add(`Bitrate: ${a.bitRate ? fmtNumber(a.bitRate / 1000) + ' kbit/s' : 'okänd'}`);
    add(`Container: ${a.container || '–'}`);
  } else {
    add('Kunde inte hämtas.');
  }
  add('');

  const s = data.segments;
  add('SEGMENT OCH BUFFERT');
  add(`Version: ${s.version ?? '–'}`);
  add(`Target duration: ${fmtDuration(s.targetDuration, 0)}`);
  add(`Media sequence: ${fmtInt(s.mediaSequence)}`);
  add(`Typ: ${s.isLive ? 'Live' : 'VOD'}${s.playlistType ? ' (' + s.playlistType + ')' : ''}`);
  add(`Antal segment i fönstret: ${s.segmentCount}`);
  add(`Fönsterlängd: ${fmtDuration(s.windowSeconds)}`);
  add(`Snittlängd/segment: ${fmtDuration(s.avgSegmentDuration)}`);
  add(`Kryptering: ${s.encrypted ? s.keyMethod : 'Av'}`);
  add(`Segmentformat: ${s.fmp4 ? 'Fragmenterad MP4 (fMP4)' : 'Ej fragmenterat (MPEG-TS)'}`);
  add('');

  const cont = data.continuity;
  add('KONTINUITET OCH STARTPUNKT');
  add(`EXT-X-DISCONTINUITY-SEQUENCE: ${cont.discontinuitySequence !== null ? fmtInt(cont.discontinuitySequence) : 'Hittades inte (standard: 0)'}`);
  add(
    cont.discontinuityCount === 0
      ? 'Discontinuities: inga i det aktuella fönstret.'
      : `Discontinuities: ${cont.discontinuityCount} st - vid sekvensnummer ${cont.discontinuityPositions.join(', ')}.`
  );
  add(`EXT-X-START: ${cont.startInfo ? `TIME-OFFSET=${cont.startInfo.timeOffset} - ${cont.startExplanation}` : 'Hittades inte.'}`);
  add('');

  const np = data.networkPath;
  add('NÄTVERKSVÄG');
  const npHeaders = Object.entries(np.headers || {});
  if (npHeaders.length) {
    npHeaders.forEach(([k, v]) => add(`  ${k}: ${v}`));
  } else {
    add('Inga matchande routing-headrar hittades.');
  }
  add(`Möjlig geografisk ledtråd: ${np.geoHint ? `${np.geoHint.raw} (ogranskad gissning)` : 'Hittades inte'}`);
  const dnsInfo = np.dns || {};
  add(
    `DNS-uppslagning (${dnsInfo.hostname || '–'}): ${
      dnsInfo.error ? `kunde inte slås upp (${dnsInfo.error})` : dnsInfo.addresses?.join(', ') || 'inga adresser'
    }`
  );
  const ipGeoList = dnsInfo.ipGeo || [];
  add(
    `Geografisk uppskattning (IP-databas, ogranskad): ${
      ipGeoList.some((g) => g)
        ? ipGeoList.map((g, i) => `${dnsInfo.addresses[i]}: ${g ? `${g.city || '–'}, ${g.country || '–'}` : 'okänd'}`).join('; ')
        : 'Hittades inte'
    }`
  );
  add('');

  const l = data.latency;
  add('LATENS');
  if (l.available) {
    const methodLabel = l.method === 'measured' ? 'Uppmätt direkt' : 'Beräknad från segmentsumma';
    add(`Beräkningsmetod: ${methodLabel} (${l.taggedSegmentCount} taggade segment)`);
    add(`Äldsta segmentets tidsstämpel: ${fmtDateTime(l.oldestProgramDateTime)}`);
    add(`Nyaste segmentets tidsstämpel: ${fmtDateTime(l.newestProgramDateTime)}`);
    add(`Fördröjning (från äldsta): ${fmtDuration(l.delaySecondsFromOldest)}`);
    add(`Fördröjning (från nyaste, live-kant): ${fmtDuration(l.delaySecondsFromNewest)}`);
  } else {
    add('Latens kan inte beräknas (ingen PROGRAM-DATE-TIME-tidsstämpel i manifestet).');
  }
  add('');

  const ll = data.lowLatency;
  add('LOW-LATENCY HLS');
  if (!ll.present) {
    add('Inga LL-HLS-taggar hittades i manifestet.');
    if (ll.contradiction) {
      add(`Motsägelse: headern ${ll.contradiction.header}: ${ll.contradiction.value} antyder LL-HLS-stöd, men inga LL-HLS-taggar hittades.`);
    }
  } else {
    const sc = ll.serverControl;
    add(`CAN-BLOCK-RELOAD: ${sc ? (sc.canBlockReload ? 'Ja' : 'Nej') : 'Hittades inte'}`);
    add(`HOLD-BACK: ${sc && sc.holdBack !== null ? fmtDuration(sc.holdBack) : 'Hittades inte'}`);
    add(`PART-HOLD-BACK: ${sc && sc.partHoldBack !== null ? fmtDuration(sc.partHoldBack) : 'Hittades inte'}`);
    add(`CAN-SKIP-UNTIL: ${sc && sc.canSkipUntil !== null ? fmtDuration(sc.canSkipUntil) : 'Hittades inte'}`);
    add(`CAN-SKIP-DATERANGES: ${sc ? (sc.canSkipDateranges ? 'Ja' : 'Nej') : 'Hittades inte'}`);
    add(`PART-TARGET: ${ll.partTargetDuration ? fmtDuration(ll.partTargetDuration) : 'Hittades inte'}`);
    add(`Delsegment i senaste segmentet: ${ll.lastSegmentParts.length || 'Hittades inte'}`);
    if (ll.trailingParts.length) add(`Delsegment för nästa segment: ${ll.trailingParts.length}`);
    add(`PRELOAD-HINT: ${ll.preloadHint ? `${ll.preloadHint.type}: ${ll.preloadHint.uri}` : 'Hittades inte'}`);
    add(`RENDITION-REPORT: ${ll.renditionReports.length ? ll.renditionReports.map((r) => `${r.uri} (msn ${r.lastMsn}, part ${r.lastPart})`).join('; ') : 'Hittades inte'}`);
  }
  add('');

  const b = data.bitrate;
  add('UPPMÄTT BITRATE');
  add(`Snitt (uppmätt): ${b.averageMeasuredBitrateKbps ? fmtNumber(b.averageMeasuredBitrateKbps) + ' kbit/s' : '–'}`);
  add(`Deklarerad bandbredd: ${b.declaredBandwidthKbps ? fmtNumber(b.declaredBandwidthKbps) + ' kbit/s' : 'okänd'}`);
  if (b.samples?.length) {
    add('Uppmätta segmentprov (tidsstämpel, storlek, bitrate):');
    b.samples.forEach((samp) => {
      add(
        `  ${fmtDateTime(samp.programDateTime)}  ${samp.ok ? fmtInt(samp.bytes) + ' B' : 'misslyckades'}  ${
          samp.ok ? fmtNumber(samp.bitrateKbps) + ' kbit/s' : ''
        }`
      );
    });
  }
  add('');

  add('NU SPELAS (ID3)');
  if (sampleError) {
    add(`Kunde inte hämtas: ${sampleError.message}`);
  } else if (sample) {
    if (!sample.id3.available) {
      add(
        `Ingen ID3-metadata hittades (inspelning: ${fmtDuration(sample.actualDurationSec)}, uppmätt ${fmtNumber(
          sample.measuredBitrateKbps
        )} kbit/s).`
      );
    } else {
      sample.id3.frames.forEach((f) => add(`  ${fmtDuration(f.ptsTime)}: ${JSON.stringify(f.tags)}`));
    }
  } else {
    add('Hämtades inte (analysen avbröts eller väntar fortfarande).');
  }

  const errorEntries = Object.entries(data.errors || {});
  if (errorEntries.length) {
    add('');
    add('VARNINGAR (delvis resultat)');
    errorEntries.forEach(([key, e]) => add(`- ${key}: ${e.message}`));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Main flow: the Analyze button runs /api/analyze and then /api/sample
// in sequence, and renders everything into #results. Clicking a variant row (see
// renderVariants) reruns the same chain against the variant's own URL, without
// touching the main URL field - see the variant click handler at the bottom.
// ---------------------------------------------------------------------

const analyzedUrlInfoEl = document.getElementById('analyzed-url-info');

// currentMasterUrl = the URL the user typed in and clicked Analyze on.
// baseVariantsInfo = the variant list from THAT analysis - shown unchanged in
// the Variants card even when a single variant has been re-analyzed, since
// a variant's own media playlist has no variant list of its own.
let currentMasterUrl = null;
let currentAnalyzedUrl = null;
let baseVariantsInfo = null;

async function runAnalysis(targetUrl, { isVariantSwitch = false } = {}) {
  analyzeBtn.disabled = true;
  copyBtn.disabled = true;
  lastAnalyzeData = null;
  lastSampleData = null;
  lastSampleError = null;
  statusEl.textContent = 'Analyserar…';
  resultsEl.innerHTML = '';

  currentAnalyzedUrl = targetUrl;
  if (isVariantSwitch) {
    analyzedUrlInfoEl.innerHTML = `Master: <span class="mono">${esc(currentMasterUrl)}</span> → Analyserar: <span class="mono">${esc(targetUrl)}</span>`;
    analyzedUrlInfoEl.hidden = false;
  } else {
    analyzedUrlInfoEl.textContent = '';
    analyzedUrlInfoEl.hidden = true;
  }

  let data;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });
    const body = await res.json();
    if (!res.ok) {
      resultsEl.innerHTML = renderFatalError(body.error);
      statusEl.textContent = '';
      analyzeBtn.disabled = false;
      return;
    }
    data = body;
  } catch (err) {
    resultsEl.innerHTML = renderFatalError({ message: 'Kunde inte nå servern: ' + err.message, details: {} });
    statusEl.textContent = '';
    analyzeBtn.disabled = false;
    return;
  }

  if (!isVariantSwitch) {
    baseVariantsInfo = data.variants;
  }

  resultsEl.innerHTML =
    renderWarnings(data.errors) +
    renderConnection(data.connection) +
    renderNetworkPath(data.networkPath) +
    renderVariants(baseVariantsInfo, currentAnalyzedUrl) +
    renderAudio(data.audio) +
    renderSegments(data.segments, data.continuity) +
    renderLatency(data.latency, data.lowLatency) +
    renderBitrate(data.bitrate) +
    renderId3Placeholder() +
    renderManifests(data.manifests);

  lastAnalyzeData = data;
  copyBtn.disabled = false;

  statusEl.textContent = 'Hämtar nu spelas…';
  const id3Section = document.getElementById('sec-id3');
  try {
    const sampleUrl = '/api/sample?url=' + encodeURIComponent(data.variants.chosenVariantUrl) + '&secs=8';
    const res = await fetch(sampleUrl);
    const body = await res.json();
    if (res.ok) {
      id3Section.innerHTML = renderId3(body, null);
      lastSampleData = body;
    } else {
      id3Section.innerHTML = renderId3(null, body.error);
      lastSampleError = body.error;
    }
  } catch (err) {
    const fetchError = { message: 'Kunde inte nå servern: ' + err.message };
    id3Section.innerHTML = renderId3(null, fetchError);
    lastSampleError = fetchError;
  }

  statusEl.textContent = '';
  analyzeBtn.disabled = false;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    statusEl.textContent = 'Ange en URL först.';
    return;
  }
  currentMasterUrl = url;
  baseVariantsInfo = null;
  runAnalysis(url, { isVariantSwitch: false });
});

// Clicking a variant row in the Variants table (see renderVariants) - reruns
// the analysis against that specific variant's URL, but doesn't touch the main URL field.
resultsEl.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-variant-url]');
  if (!row) return;
  const variantUrl = row.dataset.variantUrl;
  if (variantUrl === currentAnalyzedUrl) return;
  runAnalysis(variantUrl, { isVariantSwitch: true });
});

copyBtn.addEventListener('click', async () => {
  if (!lastAnalyzeData) return;
  const text = buildCopyText(lastAnalyzeData, lastSampleData, lastSampleError, baseVariantsInfo);
  const originalLabel = copyBtn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = 'Kopierat!';
  } catch (err) {
    copyBtn.textContent = 'Kunde inte kopiera';
  }
  setTimeout(() => { copyBtn.textContent = originalLabel; }, 1500);
});
