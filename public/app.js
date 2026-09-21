// app.js
// Vanilla JS - no build step, no import/export. Runs directly in the browser.
// Clicking Analyze: POST /api/analyze (status snapshot) followed by
// GET /api/sample (ID3/"now playing") - the result is rendered into #results.
//
// Every user-facing string here goes through t()/tPlural() (see i18n.js and
// i18n/sv.js, i18n/en.js) instead of being a literal. Section headings are defined
// once in Title Case and reused for the "Copy analysis" text's uppercase headings via
// .toUpperCase(), so there is one translated string per heading, not two.

const form = document.getElementById('analyze-form');
const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const faqEl = document.getElementById('faq');

// The copy button only exists while an analysis is actually showing - it is part
// of the rendered result (see renderAnalysisControls()), not a fixture in the
// header, so it disappears entirely for the log view and before the first
// analysis rather than sitting there disabled. Its node is destroyed and
// recreated on every render, so it is looked up fresh here instead of cached.
function setCopyEnabled(enabled) {
  const btn = document.getElementById('copy-btn');
  if (btn) btn.disabled = !enabled;
}

// Latest analysis result - kept in memory so the Copy button can build the text
// excerpt without redoing any network requests, and so a language switch (see the
// onLocaleChange hook near the bottom of this file) can re-render without one either.
let lastAnalyzeData = null;
let lastSampleData = null;
let lastSampleError = null;

// ---------------------------------------------------------------------
// Wording for the codes the server returns. The server reports what it found
// ('timeline', 'vod', a signed TIME-OFFSET); every sentence the user reads is
// built here, from the catalog, so the phrasing lives in one place instead of two.
// ---------------------------------------------------------------------

function dashAddressingLabel(code) {
  return t(`dash.addressingLabels.${code}`) !== `dash.addressingLabels.${code}`
    ? t(`dash.addressingLabels.${code}`)
    : t('dash.addressingLabels.unknown');
}

// EXT-X-START: a negative TIME-OFFSET is measured back from the live edge, a
// positive one forward from the start of the window.
function startPointExplanation(startInfo) {
  if (!startInfo || startInfo.timeOffset === null || startInfo.timeOffset === undefined) return null;
  const offset = startInfo.timeOffset;
  return offset < 0
    ? t('continuity.startBehind', { offset: fmtNumber(Math.abs(offset)) })
    : t('continuity.startAfterWindow', { offset: fmtNumber(offset) });
}

// Small shared phrases used by both a render function and its copy-text twin, so a
// translation lives once even where the two outputs aren't otherwise built from a
// shared field() list (see shared.js). Mirrors the pattern startPointExplanation()
// and dashRepresentationNotes() already used before this migration.
function yesNo(value) {
  return value ? t('common.yes') : t('common.no');
}

function corsSummaryHtml(c) {
  return c.cors.present
    ? `<dd>${t('connection.corsPresent', { allowOrigin: esc(c.cors.allowOrigin) })}</dd>`
    : `<dd class="error">${esc(t('connection.corsMissing'))}</dd>`;
}

function corsSummaryCopy(c) {
  return c.cors.present ? t('connection.corsPresent', { allowOrigin: c.cors.allowOrigin }) : t('connection.corsMissingShort');
}

// ---------------------------------------------------------------------
// Rendering - one function per section. Builds HTML strings with esc()
// around everything that comes from an external source (headers, manifest text, URLs).
// ---------------------------------------------------------------------

function renderConnection(c) {
  const extra = Object.entries(c.extraHeaders || {});
  const extraHtml = extra.length
    ? `<table><thead><tr><th>${esc(t('connection.headerTableName'))}</th><th>${esc(t('connection.headerTableValue'))}</th></tr></thead><tbody>${extra
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="note">${esc(t('connection.extraHeadersMissing'))}</p>`;

  return `
    <section id="sec-connection">
      ${withHint('h2', t('connection.heading'), 'anslutning')}
      <dl>
        ${withHint('dt', t('connection.status'), 'status')}<dd>${c.status} ${esc(c.statusText)}</dd>
        ${withHint('dt', t('connection.requestedUrl'), 'begard-url')}<dd>${esc(c.requestedUrl)}</dd>
        ${withHint('dt', t('connection.finalUrl'), 'slutlig-url')}<dd>${esc(c.finalUrl)}${c.redirected ? ` (${esc(t('connection.redirectedSuffix'))})` : ''}</dd>
        ${withHint('dt', t('connection.contentType'), 'content-type')}<dd>${esc(c.contentType) || '–'}</dd>
        ${withHint('dt', t('connection.server'), 'server')}<dd>${esc(c.server) || '–'}</dd>
        ${withHint('dt', t('connection.cacheControl'), 'cache-control')}<dd>${esc(c.cacheControl) || '–'}</dd>
        ${withHint('dt', t('connection.expires'), 'expires')}<dd>${esc(c.expires) || '–'}</dd>
        ${withHint('dt', t('connection.cors'), 'cors')}${corsSummaryHtml(c)}
      </dl>
      ${withHint('h3', t('connection.extraHeadersHeading'), 'extra-headers')}
      ${extraHtml}
    </section>`;
}

function renderVariants(v, activeUrl) {
  if (v.singleVariantNote) {
    return `
      <section id="sec-variants">
        ${withHint('h2', t('variants.heading'), 'varianter')}
        <p class="note">${esc(t('variants.singleVariantNote'))}</p>
      </section>`;
  }
  const rows = v.list
    .map((variant) => {
      const isActive = variant.url === activeUrl;
      return `
      <tr class="variant-row${isActive ? ' variant-active' : ''}" data-variant-url="${esc(variant.url)}" tabindex="0" title="${esc(t('variants.rowTitle'))}">
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
      ${withHint('h2', t('variants.heading'), 'varianter')}
      <p class="note">${esc(t('variants.clickHint'))}</p>
      <table>
        <thead><tr>${withHint('th', t('variants.bandwidthHeader'), 'variant-bandbredd')}${withHint('th', t('variants.averageHeader'), 'variant-snitt')}${withHint('th', t('variants.codecsHeader'), 'codecs')}${withHint('th', t('variants.resolutionHeader'), 'upplosning')}${withHint('th', t('variants.urlHeader'), 'variant-url')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

// The audio-track rows, described once - renderAudio() lays them out and addAudio()
// writes them as text, for all four views. See field() in shared.js.
function audioFields(a) {
  return [
    field(t('audio.codec'), 'codec', (a.codec || '–') + (a.profile ? ` (${a.profile})` : '')),
    field(t('audio.sampleRate'), 'samplingsfrekvens', a.sampleRate ? fmtInt(a.sampleRate) + ' Hz' : '–'),
    field(t('audio.channels'), 'kanaler', `${a.channels ?? '–'}${a.channelLayout ? ` (${a.channelLayout})` : ''}`),
    field(t('audio.bitrate'), 'audio-bitrate', a.bitRate ? fmtNumber(a.bitRate / 1000) + ' kbit/s' : t('audio.bitrateUnknown')),
    field(t('audio.container'), 'container', a.container || '–'),
  ];
}

function renderAudio(a) {
  const head = withHint('h2', t('audio.heading'), 'ljud');
  const body = a ? renderDl(audioFields(a)) : `<p class="note">${esc(t('audio.unavailable'))}</p>`;
  return `<section id="sec-audio">${head}${body}</section>`;
}

function renderSegments(s, continuity) {
  return `
    <section id="sec-segments">
      ${withHint('h2', t('segments.heading'), 'segment')}
      <dl>
        ${withHint('dt', t('segments.version'), 'version')}<dd>${s.version ?? '–'}</dd>
        ${withHint('dt', t('segments.targetDuration'), 'targetduration')}<dd>${fmtDuration(s.targetDuration, 0)}</dd>
        ${withHint('dt', t('segments.mediaSequence'), 'mediasequence')}<dd>${fmtInt(s.mediaSequence)}</dd>
        ${withHint('dt', t('segments.type'), 'typ')}<dd>${s.isLive ? t('segments.live') : t('segments.vod')}${s.playlistType ? ' (' + esc(s.playlistType) + ')' : ''}</dd>
        ${withHint('dt', t('segments.segmentCount'), 'antal-segment')}<dd>${s.segmentCount}</dd>
        ${withHint('dt', t('segments.windowLength'), 'fonsterlangd')}<dd>${fmtDuration(s.windowSeconds)}</dd>
        ${withHint('dt', t('segments.avgLength'), 'snittlangd')}<dd>${fmtDuration(s.avgSegmentDuration)}</dd>
        ${withHint('dt', t('segments.encryption'), 'krypterat')}<dd>${s.encrypted ? esc(s.keyMethod) : t('segments.off')}</dd>
        ${withHint('dt', t('segments.format'), 'fmp4')}<dd>${s.fmp4 ? t('segments.fmp4') : t('segments.mpegts')}</dd>
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
      ? t('continuity.discontinuitiesNone')
      : t('continuity.discontinuitiesCount', {
          count: c.discontinuityCount,
          positions: c.discontinuityPositions.map((n) => fmtInt(n)).join(', '),
        });

  const startLine = c.startInfo
    ? `TIME-OFFSET=${esc(c.startInfo.timeOffset)}${c.startInfo.precise ? ' (PRECISE)' : ''} - ${esc(
        startPointExplanation(c.startInfo)
      )}`
    : esc(t('continuity.startNotFound'));

  return `
    <div class="subsection">
      ${withHint('h3', t('continuity.heading'), 'kontinuitet')}
      <dl>
        ${withHint('dt', t('continuity.discontinuitySeqLabel'), 'discontinuity-sequence')}<dd>${
          c.discontinuitySequence !== null ? fmtInt(c.discontinuitySequence) : esc(t('continuity.discontinuitySeqNotFound'))
        }</dd>
        ${withHint('dt', t('continuity.discontinuitiesLabel'), 'discontinuities')}<dd>${discontinuityLine}</dd>
        ${withHint('dt', t('continuity.startLabel'), 'ext-x-start')}<dd>${startLine}</dd>
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
    ? `<p class="note error">${t('lowLatency.contradiction', { header: esc(ll.contradiction.header), value: esc(ll.contradiction.value) })}</p>`
    : '';

  if (!ll.present) {
    return `
      <div class="subsection">
        ${withHint('h3', t('lowLatency.heading'), 'llhls')}
        <p class="note">${esc(t('lowLatency.notPresent'))}</p>
        ${contradictionNote}
      </div>`;
  }

  const sc = ll.serverControl;
  const notFound = esc(t('common.notFound'));

  const partsTable = (parts) =>
    parts.length
      ? `<table><thead><tr><th>${esc(t('lowLatency.partsIndexHeader'))}</th><th>${esc(t('lowLatency.partsDurationHeader'))}</th><th>${esc(t('lowLatency.partsIndependentHeader'))}</th><th>${esc(t('lowLatency.partsUriHeader'))}</th></tr></thead><tbody>${parts
          .map(
            (p, i) =>
              `<tr><td>${i + 1}</td><td>${fmtDuration(p.duration)}</td><td>${esc(yesNo(p.independent))}</td><td>${esc(
                p.uri
              )}</td></tr>`
          )
          .join('')}</tbody></table>`
      : `<p class="note">${notFound}</p>`;

  const renditionTable = ll.renditionReports.length
    ? `<table><thead><tr><th>${esc(t('lowLatency.renditionHeader'))}</th><th>${esc(t('lowLatency.renditionLastMsnHeader'))}</th><th>${esc(t('lowLatency.renditionLastPartHeader'))}</th></tr></thead><tbody>${ll.renditionReports
        .map((r) => `<tr><td>${esc(r.uri)}</td><td>${r.lastMsn ?? '–'}</td><td>${r.lastPart ?? '–'}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="note">${notFound}</p>`;

  return `
    <div class="subsection">
      ${withHint('h3', t('lowLatency.heading'), 'llhls')}
      ${contradictionNote}
      <dl>
        ${withHint('dt', t('lowLatency.canBlockReload'), 'll-can-block-reload')}<dd>${sc ? esc(yesNo(sc.canBlockReload)) : notFound}</dd>
        ${withHint('dt', t('lowLatency.holdBack'), 'll-hold-back')}<dd>${sc && sc.holdBack !== null ? fmtDuration(sc.holdBack) : notFound}</dd>
        ${withHint('dt', t('lowLatency.partHoldBack'), 'll-part-hold-back')}<dd>${
          sc && sc.partHoldBack !== null ? fmtDuration(sc.partHoldBack) : notFound
        }</dd>
        ${withHint('dt', t('lowLatency.canSkipUntil'), 'll-can-skip-until')}<dd>${
          sc && sc.canSkipUntil !== null ? fmtDuration(sc.canSkipUntil) : notFound
        }</dd>
        ${withHint('dt', t('lowLatency.canSkipDateranges'), 'll-can-skip-dateranges')}<dd>${sc ? esc(yesNo(sc.canSkipDateranges)) : notFound}</dd>
        ${withHint('dt', t('lowLatency.partTarget'), 'll-part-target')}<dd>${ll.partTargetDuration ? fmtDuration(ll.partTargetDuration) : notFound}</dd>
      </dl>
      <p class="note">${esc(t('lowLatency.partsIntro'))}</p>
      ${partsTable(ll.lastSegmentParts)}
      ${
        ll.trailingParts.length
          ? `<p class="note">${esc(t('lowLatency.nextPartsIntro'))}</p>${partsTable(ll.trailingParts)}`
          : ''
      }
      <dl>
        ${withHint('dt', t('lowLatency.preloadHint'), 'll-preload-hint')}<dd>${
          ll.preloadHint ? `${esc(ll.preloadHint.type)}: ${esc(ll.preloadHint.uri)}` : notFound
        }</dd>
      </dl>
      <p class="note">${esc(t('lowLatency.renditionReportIntro'))}</p>
      ${renditionTable}
    </div>`;
}

function renderLatency(l, lowLatency) {
  if (!l.available) {
    return `
      <section id="sec-latency">
        ${withHint('h2', t('latency.heading'), 'latens')}
        <p class="note">${esc(t('latency.unavailable'))}</p>
        ${renderLowLatency(lowLatency)}
      </section>`;
  }
  const methodLabel = l.method === 'measured' ? t('latency.methodMeasured') : t('latency.methodCalculated');
  return `
    <section id="sec-latency">
      ${withHint('h2', t('latency.heading'), 'latens')}
      <dl>
        ${withHint('dt', t('latency.method'), 'latens-metod')}<dd>${esc(methodLabel)} (${esc(tPlural('latency.taggedSegments', l.taggedSegmentCount))})</dd>
        ${withHint('dt', t('latency.oldestTs'), 'aldsta-ts')}<dd>${fmtDateTime(l.oldestProgramDateTime)}</dd>
        ${withHint('dt', t('latency.newestTs'), 'nyaste-ts')}<dd>${fmtDateTime(l.newestProgramDateTime)}</dd>
        ${withHint('dt', t('latency.delayFromOldest'), 'fordrojning-aldsta')}<dd>${fmtDuration(l.delaySecondsFromOldest)}</dd>
        ${withHint('dt', t('latency.delayFromNewest'), 'fordrojning-nyaste')}<dd>${fmtDuration(l.delaySecondsFromNewest)}</dd>
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
        <td>${s.ok ? fmtNumber(s.bitrateKbps) : esc(t('bitrate.failed'))}</td>
      </tr>`
    )
    .join('');
  return `
    <section id="sec-bitrate">
      ${withHint('h2', t('bitrate.heading'), 'bitrate')}
      <dl>
        ${withHint('dt', t('bitrate.average'), 'snitt-uppmatt')}<dd>${b.averageMeasuredBitrateKbps ? fmtNumber(b.averageMeasuredBitrateKbps) + ' kbit/s' : '–'}</dd>
        ${withHint('dt', t('bitrate.declared'), 'deklarerad-bandbredd')}<dd>${b.declaredBandwidthKbps ? fmtNumber(b.declaredBandwidthKbps) + ' kbit/s' : esc(t('bitrate.declaredUnknown'))}</dd>
      </dl>
      <table>
        <thead><tr>${withHint('th', t('bitrate.timestampHeader'), 'tidsstampel')}${withHint('th', t('bitrate.bytesHeader'), 'bytes')}${withHint('th', t('bitrate.bitrateHeader'), 'bitrate-kolumn')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderId3Placeholder() {
  return `<section id="sec-id3">${withHint('h2', t('id3.heading'), 'id3')}<p class="note">${esc(t('id3.loading'))}</p></section>`;
}

// Warnings from /api/sample. "No metadata found" is a claim about the stream;
// it is only honest when the tools that looked actually ran, so when one of them
// failed that gets said out loud next to the result rather than folded into it.
function renderSampleWarnings(sample) {
  const warnings = sample?.warnings || [];
  if (!warnings.length) return '';
  return `<p class="note error">${warnings.map((w) => esc(errorText(w))).join('<br />')}</p>`;
}

function renderId3(sample, error) {
  const head = withHint('h2', t('id3.heading'), 'id3');
  if (error) {
    return `${head}<p class="error">${esc(errorText(error))}</p>`;
  }
  if (!sample.id3.available) {
    return `${head}${renderSampleWarnings(sample)}<p class="note">${esc(t('id3.noneFound', {
      duration: fmtDuration(sample.actualDurationSec),
      bitrate: fmtNumber(sample.measuredBitrateKbps),
    }))}</p>`;
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
    ${head}
    ${renderSampleWarnings(sample)}
    <table>
      <thead><tr>${withHint('th', t('id3.timeInSegmentHeader'), 'tid-i-segment')}${withHint('th', t('id3.tagsHeader'), 'taggar')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// "Network path": generically matched CDN/edge routing headers, a
// best-effort guess at a geographic hint in the node name, and a
// server-side DNS lookup of the media playlist's hostname.
function renderNetworkPath(np) {
  const headerRows = Object.entries(np.headers || {});
  const headerTable = headerRows.length
    ? `<table><thead><tr><th>${esc(t('networkPath.headerTableName'))}</th><th>${esc(t('networkPath.headerTableValue'))}</th></tr></thead><tbody>${headerRows
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="note">${esc(t('networkPath.noHeaders'))}</p>`;

  const dnsInfo = np.dns || {};
  const dnsResult = dnsInfo.error
    ? t('networkPath.dnsLookupFailed', { error: esc(dnsInfo.error) })
    : dnsInfo.addresses?.length
    ? esc(dnsInfo.addresses.join(', '))
    : esc(t('networkPath.dnsNoAddresses'));

  // The IP-geo row itself (not just its value) is left out entirely when the server
  // has it turned off (ENABLE_IP_GEO unset) - a permanently "disabled" row is clutter,
  // not information, and the header-based geo hint above already covers the same
  // "roughly where did this answer come from" question without the ~110 MB database.
  const ipGeoRow =
    dnsInfo.ipGeoEnabled === false
      ? ''
      : `${withHint('dt', t('networkPath.ipGeo'), 'ip-geo')}<dd>${
          (dnsInfo.ipGeo || []).some((g) => g)
            ? dnsInfo.ipGeo
                .map((g, i) => `${esc(dnsInfo.addresses[i])}: ${g ? `${esc(g.city || '–')}, ${esc(g.country || '–')}` : esc(t('networkPath.ipGeoUnknown'))}`)
                .join('; ')
            : esc(t('networkPath.ipGeoNotFound'))
        }</dd>`;

  return `
    <section id="sec-network">
      ${withHint('h2', t('networkPath.heading'), 'natverksvag')}
      ${headerTable}
      <dl>
        ${withHint('dt', t('networkPath.geoHint'), 'geo-hint')}<dd>${
          np.geoHint ? t('networkPath.geoHintFound', { raw: esc(np.geoHint.raw) }) : esc(t('networkPath.ipGeoNotFound'))
        }</dd>
        ${withHint('dt', t('networkPath.dnsLookup'), 'dns-lookup')}<dd>${esc(dnsInfo.hostname) || '–'} → ${dnsResult}</dd>
        ${ipGeoRow}
      </dl>
    </section>`;
}

// A media playlist for a long DVR window runs to thousands of lines, and the server
// accepts one up to MAX_MANIFEST_BYTES. Escaping all of that into a <pre> is what
// actually locks the tab up, so only the head is rendered and the rest is summarised.
const MAX_MANIFEST_LINES_SHOWN = 500;

function renderRawManifest(label, url, raw) {
  const lines = String(raw ?? '').split('\n');
  const shown = lines.slice(0, MAX_MANIFEST_LINES_SHOWN).join('\n');
  const hidden = lines.length - MAX_MANIFEST_LINES_SHOWN;
  const more =
    hidden > 0
      ? `<p class="note">${t('manifest.truncatedNote', { shown: fmtInt(MAX_MANIFEST_LINES_SHOWN), total: fmtInt(lines.length) })}</p>`
      : '';
  return `<h3>${esc(label)} (${esc(url)})</h3><pre>${esc(shown)}</pre>${more}`;
}

function renderManifests(m) {
  return `
    <section id="sec-manifest">
      ${withHint('h2', t('manifest.headingHls'), 'manifest')}
      ${m.master ? renderRawManifest(t('manifest.master'), m.master.url, m.master.raw) : ''}
      ${renderRawManifest(t('manifest.media'), m.media.url, m.media.raw)}
    </section>`;
}

function renderDashManifest(m) {
  return `
    <section id="sec-manifest">
      ${withHint('h2', t('manifest.headingDash'), 'mpd')}
      ${renderRawManifest(t('manifest.mpd'), m.mpd.url, m.mpd.raw)}
    </section>`;
}

// ---------------------------------------------------------------------
// DASH-specific sections. Genuinely new shapes - they do NOT reuse
// renderVariants/renderSegments/renderLatency, but renderAudio, renderBitrate,
// renderNetworkPath, renderConnection, renderWarnings and renderFatalError are
// reused unchanged.
// ---------------------------------------------------------------------

// Unlike HLS variant rows, DASH representation rows are NOT click-to-reanalyse:
// the whole MPD is already fetched, there is no separate URL per representation
// to re-request. A genuine UX difference, not a missing feature.
// The two v1 scope limits, phrased once and used by both the card and the copy text.
function dashRepresentationNotes(reps) {
  return [
    reps.multiPeriod
      ? t('dashRepr.multiPeriodNote', { periodCount: fmtInt(reps.periodCount), period: reps.periodIndex + 1, periodId: reps.periodId })
      : null,
    reps.hasXlink ? t('dashRepr.xlinkNote') : null,
  ].filter(Boolean);
}

function renderDashRepresentations(reps) {
  const notes = dashRepresentationNotes(reps)
    .map((n) => `<p class="note error">${esc(n)}</p>`)
    .join('');

  const rows = reps.list
    .map((r) => {
      const resOrRate = r.width && r.height
        ? `${r.width}×${r.height}`
        : r.audioSamplingRate
        ? `${fmtInt(r.audioSamplingRate)} Hz`
        : '–';
      return `
      <tr class="${r.chosen ? 'variant-active' : ''}">
        <td>${esc(r.contentType || '–')}${r.lang ? ' (' + esc(r.lang) + ')' : ''}</td>
        <td>${esc(r.id || '–')}${r.chosen ? ' ✓' : ''}</td>
        <td>${fmtInt(r.bandwidthKbps)}</td>
        <td>${esc(r.codecs || '–')}</td>
        <td>${resOrRate}</td>
      </tr>`;
    })
    .join('');

  return `
    <section id="sec-representations">
      ${withHint('h2', t('dashRepr.heading'), 'representation')}
      <p class="note">${t('dashRepr.analyzed', { id: esc(reps.chosenId || '–'), period: reps.periodIndex + 1 })}</p>
      ${notes}
      <table>
        <thead><tr>${withHint('th', t('dashRepr.typeHeader'), 'adaptationset')}${withHint('th', t('dashRepr.idHeader'), 'representation')}${withHint('th', t('dashRepr.bandwidthHeader'), 'variant-bandbredd')}${withHint('th', t('dashRepr.codecsHeader'), 'codecs')}${withHint('th', t('dashRepr.resolutionHeader'), 'upplosning')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderDashSegments(s) {
  const cp = (s.contentProtection || []).length
    ? s.contentProtection
        .map((c) => esc(c.schemeIdUri || '?') + (c.value ? ` (${esc(c.value)})` : ''))
        .join(', ')
    : null;

  return `
    <section id="sec-segments">
      ${withHint('h2', t('segments.heading'), 'segment')}
      <dl>
        ${withHint('dt', t('dashSegments.presentationType'), 'presentationtype')}<dd>${s.isLive ? t('dashSegments.live') : t('dashSegments.vod')}</dd>
        ${withHint('dt', t('dashSegments.addressing'), 'segmenttemplate')}<dd>${esc(dashAddressingLabel(s.segmentAddressing))}</dd>
        ${withHint('dt', t('dashSegments.length'), 'snittlangd')}<dd>${fmtDuration(s.segmentDurationSec)}</dd>
        ${withHint('dt', t('dashSegments.count'), 'antal-segment')}<dd>${s.segmentCount != null ? fmtInt(s.segmentCount) : '–'}${s.isLive ? esc(t('dashSegments.estimated')) : ''}</dd>
        ${withHint('dt', t('dashSegments.window'), 'timeshiftbufferdepth')}<dd>${fmtDuration(s.windowSeconds)}</dd>
        ${withHint('dt', t('dashSegments.minBufferTime'), 'minbuffertime')}<dd>${fmtDuration(s.minBufferTimeSec)}</dd>
        ${withHint('dt', t('dashSegments.minimumUpdatePeriod'), 'minimumupdateperiod')}<dd>${s.minimumUpdatePeriodSec != null ? fmtDuration(s.minimumUpdatePeriodSec) : '–'}</dd>
        ${withHint('dt', t('dashSegments.mediaPresentationDuration'), 'mediapresentationduration')}<dd>${fmtDuration(s.mediaPresentationDurationSec)}</dd>
        ${withHint('dt', t('dashSegments.encryption'), 'contentprotection')}<dd>${cp ? cp : t('dashSegments.off')}</dd>
        ${withHint('dt', t('dashSegments.format'), 'fmp4')}<dd>${s.fmp4 ? t('dashSegments.fmp4') : t('dashSegments.noInit')}</dd>
        ${withHint('dt', t('dashSegments.initSegment'), 'init-segment')}<dd>${s.initUri ? `<span class="mono">${esc(s.initUri)}</span>` : '–'}</dd>
      </dl>
    </section>`;
}

function renderDashLatency(l) {
  if (!l.available) {
    const reasonKey = `dash.noLatencyReasons.${l.reason}`;
    const reason = t(reasonKey) !== reasonKey ? t(reasonKey) : t('dashLatency.unavailable');
    return `
      <section id="sec-latency">
        ${withHint('h2', t('latency.heading'), 'latens')}
        <p class="note">${esc(reason)}</p>
      </section>`;
  }
  const methodLabel = l.method === 'declared' ? t('dashLatency.methodDeclared') : t('dashLatency.methodEstimated');
  const ageLine = l.manifestAgeSec != null
    ? fmtDuration(l.manifestAgeSec)
    : l.epochAnchored
    ? t('dashLatency.manifestAgeUnavailable')
    : '–';
  return `
    <section id="sec-latency">
      ${withHint('h2', t('latency.heading'), 'latens')}
      <dl>
        ${withHint('dt', t('dashLatency.method'), 'latens-metod')}<dd>${esc(methodLabel)}</dd>
        ${withHint('dt', t('dashLatency.availabilityStartTime'), 'availabilitystarttime')}<dd>${fmtDateTime(l.availabilityStartTime)}${l.epochAnchored ? esc(t('dashLatency.epochAnchored')) : ''}</dd>
        ${withHint('dt', t('dashLatency.publishTime'), 'publishtime')}<dd>${fmtDateTime(l.publishTime)}</dd>
        ${withHint('dt', t('dashLatency.manifestAge'), 'manifest-age')}<dd>${esc(ageLine)}</dd>
        ${withHint('dt', t('dashLatency.suggestedDelay'), 'suggestedpresentationdelay')}<dd>${l.suggestedPresentationDelaySec != null ? fmtDuration(l.suggestedPresentationDelaySec) : esc(t('common.notFound'))}</dd>
        ${withHint('dt', t('dashLatency.estimatedDelay'), 'dash-est-delay')}<dd>${fmtDuration(l.estimatedLiveDelaySec)}${l.method === 'estimated' ? esc(t('dashLatency.estimatedSuffix')) : ''}</dd>
        ${withHint('dt', t('dashLatency.minimumUpdatePeriod'), 'minimumupdateperiod')}<dd>${l.minimumUpdatePeriodSec != null ? fmtDuration(l.minimumUpdatePeriodSec) : '–'}</dd>
        ${withHint('dt', t('dashLatency.timeShiftBufferDepth'), 'timeshiftbufferdepth')}<dd>${fmtDuration(l.timeShiftBufferDepthSec)}</dd>
      </dl>
    </section>`;
}

// ---------------------------------------------------------------------
// Icecast / SHOUTcast / RSAS sections. The smallest of the three shapes -
// a raw stream has no variant/segment/latency model. renderConnection,
// renderNetworkPath, renderAudio, renderWarnings and renderFatalError are
// reused unchanged; "now playing" comes from ICY in-stream metadata rather
// than ID3, so it gets its own section instead of renderId3.
// ---------------------------------------------------------------------

function renderIcecastStation(st) {
  if (!st) {
    return `
      <section id="sec-station">
        ${withHint('h2', t('icecastStation.heading'), 'icecast')}
        <p class="note">${esc(t('icecastStation.unavailable'))}</p>
      </section>`;
  }

  const nowPlaying = st.icyMetadataSupported
    ? st.nowPlaying
      ? esc(st.nowPlaying)
      : `<span class="note">${esc(t('icecastStation.metadataPending', { metaInt: fmtInt(st.metaIntBytes) }))}</span>`
    : `<span class="note">${esc(t('icecastStation.metadataOff'))}</span>`;

  // Not linkified unless it is a real http(s) URL - see safeHttpUrl(). A station
  // that sends something else still gets its value shown, just as inert text.
  const homepageUrl = safeHttpUrl(st.homepageUrl);
  const homepage = homepageUrl
    ? `<a href="${esc(homepageUrl)}" target="_blank" rel="noopener">${esc(homepageUrl)}</a>`
    : esc(st.homepageUrl) || '–';

  return `
    <section id="sec-station">
      ${withHint('h2', t('icecastStation.heading'), 'icecast')}
      <dl>
        ${withHint('dt', t('icecastStation.name'), 'station-name')}<dd>${esc(st.name) || '–'}</dd>
        ${withHint('dt', t('icecastStation.nowPlaying'), 'now-playing-icy')}<dd>${nowPlaying}</dd>
        ${withHint('dt', t('icecastStation.genre'), 'station-genre')}<dd>${esc(st.genre) || '–'}</dd>
        ${withHint('dt', t('icecastStation.description'), 'station-description')}<dd>${esc(st.description) || '–'}</dd>
        ${withHint('dt', t('icecastStation.homepage'), 'station-homepage')}<dd>${homepage}</dd>
        ${withHint('dt', t('icecastStation.declaredBitrate'), 'declared-bitrate-icy')}<dd>${st.declaredBitrateKbps ? fmtInt(st.declaredBitrateKbps) + ' kbit/s' : '–'}</dd>
        ${withHint('dt', t('icecastStation.declaredSampleRate'), 'declared-samplerate-icy')}<dd>${st.declaredSampleRateHz ? fmtInt(st.declaredSampleRateHz) + ' Hz' : '–'}</dd>
        ${st.audioInfo ? `${withHint('dt', 'ice-audio-info', 'declared-samplerate-icy')}<dd>${esc(st.audioInfo)}</dd>` : ''}
        ${withHint('dt', t('icecastStation.serverSoftware'), 'server-software')}<dd>${esc(st.serverSoftware) || '–'}</dd>
        ${withHint('dt', t('icecastStation.publiclyListed'), 'icy-public')}<dd>${st.isPublic ? esc(t('icecastStation.publiclyListedYes')) : esc(t('common.no'))}</dd>
        ${withHint('dt', t('icecastStation.inStreamMetadata'), 'icy-metaint')}<dd>${st.icyMetadataSupported ? esc(t('icecastStation.inStreamMetadataYes', { metaInt: fmtInt(st.metaIntBytes) })) : esc(t('common.no'))}</dd>
      </dl>
      ${st.rawMetaBlock ? `<p class="note">${esc(t('icecastStation.rawMetaBlock'))}</p><pre>${esc(st.rawMetaBlock)}</pre>` : ''}
    </section>`;
}

function renderIcecastSamplePlaceholder() {
  return `<section id="sec-icecast-sample">${withHint('h2', t('icecastSample.heading'), 'icecast-sample')}<p class="note">${esc(t('icecastSample.recording'))}</p></section>`;
}

function renderIcecastSample(sample, error) {
  const head = withHint('h2', t('icecastSample.heading'), 'icecast-sample');
  if (error) return `${head}<p class="error">${esc(errorText(error))}</p>`;
  if (!sample) return `${head}<p class="note">${esc(t('icecastSample.notFetched'))}</p>`;

  const s = sample.streams || {};
  const id3Block = sample.id3 && sample.id3.available
    ? `<p class="note">${esc(t('icecastSample.id3Intro'))}</p>
       <table><thead><tr>${withHint('th', t('icecastSample.timeInSampleHeader'), 'tid-i-segment')}${withHint('th', t('icecastSample.tagsHeader'), 'taggar')}</tr></thead>
       <tbody>${sample.id3.frames
         .map((f) => `<tr><td>${fmtDuration(f.ptsTime)}</td><td>${esc(JSON.stringify(f.tags))}</td></tr>`)
         .join('')}</tbody></table>`
    : '';

  const burst =
    typeof sample.connectBurstSec !== 'number' || sample.connectBurstSec < 1
      ? t('icecastSample.burstNone')
      : `${t(sample.burstIsLowerBound ? 'icecastSample.burstAtLeast' : 'icecastSample.burstApprox', { seconds: fmtDuration(sample.connectBurstSec) })}${
          sample.burstIsLowerBound ? t('icecastSample.burstAtLeastSuffix') : ''
        }`;

  return `
    ${head}
    ${renderSampleWarnings(sample)}
    <dl>
      ${withHint('dt', t('icecastSample.average'), 'snitt-uppmatt')}<dd>${sample.measuredBitrateKbps ? fmtNumber(sample.measuredBitrateKbps) + ' kbit/s' : '–'}</dd>
      ${withHint('dt', t('icecastSample.recordedLength'), 'inspelad-langd')}<dd>${fmtDuration(sample.actualDurationSec)}</dd>
      ${withHint('dt', t('icecastSample.connectBurst'), 'connect-burst')}<dd>${esc(burst)}</dd>
      ${withHint('dt', t('icecastSample.sampleSize'), 'bytes')}<dd>${sample.fileSizeBytes ? fmtInt(sample.fileSizeBytes) + ' byte' : '–'}</dd>
      ${withHint('dt', t('icecastSample.container'), 'container')}<dd>${esc(s.container) || '–'}</dd>
    </dl>
    ${id3Block}`;
}

// A small controls bar at the top of the results, in the same spot the log view
// puts its own controls (#log-controls/"Stoppa loggning") - prepended to every
// successful analysis render so the Copy button only ever exists alongside an
// actual result, never as a permanently-visible-but-disabled fixture.
function renderAnalysisControls() {
  return `
    <div id="analysis-controls">
      <button type="button" id="copy-btn" title="${esc(t('controls.copyBtnTitle'))}" disabled>${esc(t('controls.copyBtn'))}</button>
    </div>`;
}

function renderWarnings(errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return '';
  const items = entries.map(([key, e]) => `<li><strong>${esc(key)}:</strong> ${esc(errorText(e))}</li>`).join('');
  return `
    <section id="sec-warnings">
      <h2>${esc(t('warnings.heading'))}</h2>
      <ul>${items}</ul>
    </section>`;
}

function renderFatalError(err) {
  const d = err.details || {};
  let extra = '';
  if (d.status) extra += `<dt>${esc(t('error.httpStatus'))}</dt><dd>${d.status} ${esc(d.statusText || '')}</dd>`;
  if (d.bodySnippet) extra += `<dt>${esc(t('error.responseBody'))}</dt><dd><pre>${esc(d.bodySnippet)}</pre></dd>`;
  if (d.geoblockGuess) extra += `<dt>${esc(t('error.likelyCause'))}</dt><dd>${esc(t('error.likelyCauseGeoblock'))}</dd>`;
  if (d.preview) extra += `<dt>${esc(t('error.whatCameBack'))}</dt><dd><pre>${esc(d.preview)}</pre></dd>`;
  if (d.installHelp) {
    extra += `<dt>${esc(t('error.installation'))}</dt><dd>macOS: <code>${esc(d.installHelp.macOS)}</code><br />Linux: <code>${esc(
      d.installHelp.linux
    )}</code></dd>`;
  }
  if (d.stderr) extra += `<dt>${esc(t('error.stderr'))}</dt><dd><pre>${esc(d.stderr)}</pre></dd>`;
  if (d.url) extra += `<dt>${esc(t('error.url'))}</dt><dd>${esc(d.url)}</dd>`;

  return `
    <section id="sec-error">
      <h2 class="error">${esc(t('error.heading'))}</h2>
      <p class="error">${esc(errorText(err))}</p>
      <dl>${extra}</dl>
    </section>`;
}

// ---------------------------------------------------------------------
// Text excerpt for the Copy button - the same data that's rendered on the
// page, but as plain text without the raw manifest (which is just a long
// segment list and adds nothing for an AI analysis of the stream's properties).
// Section headings reuse the same catalog key as their card via .toUpperCase(),
// so the wording can't drift between the two outputs.
// ---------------------------------------------------------------------

// Sections that are identical across all three stream kinds. They used to be
// copy-pasted into each of the three builders below, which is how the HLS version
// ended up with an Expires line the other two silently lacked.

function addConnection(add, c) {
  add(t('connection.heading').toUpperCase());
  add(`${t('connection.status')}: ${c.status} ${c.statusText}`);
  add(`${t('connection.requestedUrl')}: ${c.requestedUrl}`);
  add(`${t('connection.finalUrl')}: ${c.finalUrl}${c.redirected ? ` (${t('connection.redirectedSuffix')})` : ''}`);
  add(`${t('connection.contentType')}: ${c.contentType || '–'}`);
  add(`${t('connection.server')}: ${c.server || '–'}`);
  add(`${t('connection.cacheControl')}: ${c.cacheControl || '–'}`);
  add(`${t('connection.expires')}: ${c.expires || '–'}`);
  add(`${t('connection.cors')}: ${corsSummaryCopy(c)}`);
  const extraHeaders = Object.entries(c.extraHeaders || {});
  if (extraHeaders.length) {
    add(`${t('connection.extraHeadersHeading')}:`);
    extraHeaders.forEach(([k, v]) => add(`  ${k}: ${v}`));
  }
  add('');
}

function addAudio(add, a) {
  add(t('audio.heading').toUpperCase());
  if (a) copyFields(add, audioFields(a));
  else add(t('audio.unavailableCopy'));
  add('');
}

function addNetworkPath(add, np) {
  add(t('networkPath.heading').toUpperCase());
  const npHeaders = Object.entries(np.headers || {});
  if (npHeaders.length) npHeaders.forEach(([k, v]) => add(`  ${k}: ${v}`));
  else add(t('networkPath.noMatchingHeadersCopy'));
  add(`${t('networkPath.geoHint')}: ${np.geoHint ? t('networkPath.geoHintFoundCopy', { raw: np.geoHint.raw }) : t('common.notFound')}`);

  const dnsInfo = np.dns || {};
  add(
    `${t('networkPath.dnsLabel', { hostname: dnsInfo.hostname || '–' })}: ${
      dnsInfo.error ? t('networkPath.dnsLookupFailedCopy', { error: dnsInfo.error }) : dnsInfo.addresses?.join(', ') || t('networkPath.dnsNoAddressesCopy')
    }`
  );

  // Mirrors renderNetworkPath(): the row is left out entirely when IP geo is off on
  // the server, not printed as a permanent "disabled" line.
  if (dnsInfo.ipGeoEnabled !== false) {
    const ipGeoList = dnsInfo.ipGeo || [];
    const ipGeoText = ipGeoList.some((g) => g)
      ? ipGeoList.map((g, i) => `${dnsInfo.addresses[i]}: ${g ? `${g.city || '–'}, ${g.country || '–'}` : t('networkPath.ipGeoUnknown')}`).join('; ')
      : t('common.notFound');
    add(`${t('networkPath.ipGeoCopy')}: ${ipGeoText}`);
  }
  add('');
}

function addSample(add, sample, sampleError, heading) {
  add(heading);
  if (sampleError) {
    add(t('id3.fetchFailed', { message: sampleError.message }));
    return;
  }
  if (!sample) {
    add(t('id3.notFetched'));
    return;
  }
  (sample.warnings || []).forEach((w) => add(t('warnings.prefix', { message: errorText(w) })));
  if (!sample.id3?.available) {
    add(
      t('id3.noneFoundCopy', {
        duration: fmtDuration(sample.actualDurationSec),
        bitrate: fmtNumber(sample.measuredBitrateKbps),
      })
    );
    return;
  }
  sample.id3.frames.forEach((f) => add(`  ${fmtDuration(f.ptsTime)}: ${JSON.stringify(f.tags)}`));
}

function addWarnings(add, errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return;
  add('');
  add(t('warnings.heading').toUpperCase());
  entries.forEach(([key, e]) => add(`- ${key}: ${errorText(e)}`));
}

function buildCopyText(data, sample, sampleError, variantsOverride) {
  if (data.streamKind === 'dash') return buildDashCopyText(data, sample, sampleError);
  if (data.streamKind === 'icecast') return buildIcecastCopyText(data, sample, sampleError);

  const lines = [];
  const add = (line = '') => lines.push(line);

  add(t('flow.streamAnalysisHls', { url: data.requestedUrl }));
  if (currentMasterUrl && currentAnalyzedUrl && currentAnalyzedUrl !== currentMasterUrl) {
    add(t('flow.variantFromMaster', { master: currentMasterUrl }));
  }
  add(t('flow.generated', { timestamp: fmtDateTime(new Date().toISOString()) }));
  add('');

  addConnection(add, data.connection);

  const v = variantsOverride || data.variants;
  add(t('variants.heading').toUpperCase());
  if (v.singleVariantNote) {
    add(t('variants.singleVariantNoteCopy'));
  } else {
    v.list.forEach((variant) => {
      add(
        t('variants.copyLine', {
          bandwidth: fmtInt(variant.bandwidth ? variant.bandwidth / 1000 : null),
          average: fmtInt(variant.averageBandwidth ? variant.averageBandwidth / 1000 : null),
          codecs: variant.codecs || t('variants.unknownCodec'),
          resolution: variant.resolution || t('variants.noVideo'),
          url: variant.url,
        })
      );
    });
  }
  add('');

  addAudio(add, data.audio);

  const s = data.segments;
  add(t('segments.heading').toUpperCase());
  add(`${t('segments.version')}: ${s.version ?? '–'}`);
  add(`${t('segments.targetDuration')}: ${fmtDuration(s.targetDuration, 0)}`);
  add(`${t('segments.mediaSequence')}: ${fmtInt(s.mediaSequence)}`);
  add(`${t('segments.type')}: ${s.isLive ? t('segments.live') : t('segments.vod')}${s.playlistType ? ' (' + s.playlistType + ')' : ''}`);
  add(`${t('segments.segmentCount')}: ${s.segmentCount}`);
  add(`${t('segments.windowLength')}: ${fmtDuration(s.windowSeconds)}`);
  add(`${t('segments.avgLength')}: ${fmtDuration(s.avgSegmentDuration)}`);
  add(`${t('segments.encryption')}: ${s.encrypted ? s.keyMethod : t('segments.off')}`);
  add(`${t('segments.format')}: ${s.fmp4 ? t('segments.fmp4') : t('segments.mpegts')}`);
  add('');

  const cont = data.continuity;
  add(t('continuity.heading').toUpperCase());
  add(`${t('continuity.discontinuitySeqLabel')}: ${cont.discontinuitySequence !== null ? fmtInt(cont.discontinuitySequence) : t('continuity.discontinuitySeqNotFound')}`);
  add(
    `${t('continuity.discontinuitiesLabel')}: ${
      cont.discontinuityCount === 0
        ? t('continuity.discontinuitiesNone')
        : t('continuity.discontinuitiesCount', { count: cont.discontinuityCount, positions: cont.discontinuityPositions.join(', ') })
    }`
  );
  add(
    `${t('continuity.startLabel')}: ${
      cont.startInfo
        ? `TIME-OFFSET=${cont.startInfo.timeOffset} - ${startPointExplanation(cont.startInfo)}`
        : t('continuity.startNotFound')
    }`
  );
  add('');

  addNetworkPath(add, data.networkPath);

  const l = data.latency;
  add(t('latency.heading').toUpperCase());
  if (l.available) {
    const methodLabel = l.method === 'measured' ? t('latency.methodMeasured') : t('latency.methodCalculated');
    add(`${t('latency.method')}: ${methodLabel} (${tPlural('latency.taggedSegments', l.taggedSegmentCount)})`);
    add(`${t('latency.oldestTs')}: ${fmtDateTime(l.oldestProgramDateTime)}`);
    add(`${t('latency.newestTs')}: ${fmtDateTime(l.newestProgramDateTime)}`);
    add(`${t('latency.delayFromOldest')}: ${fmtDuration(l.delaySecondsFromOldest)}`);
    add(`${t('latency.delayFromNewest')}: ${fmtDuration(l.delaySecondsFromNewest)}`);
  } else {
    add(t('latency.unavailable'));
  }
  add('');

  const ll = data.lowLatency;
  add(t('lowLatency.heading').toUpperCase());
  if (!ll.present) {
    add(t('lowLatency.notPresent'));
    if (ll.contradiction) {
      add(t('lowLatency.contradictionCopy', { header: ll.contradiction.header, value: ll.contradiction.value }));
    }
  } else {
    const sc = ll.serverControl;
    add(`${t('lowLatency.canBlockReload')}: ${sc ? yesNo(sc.canBlockReload) : t('common.notFound')}`);
    add(`${t('lowLatency.holdBack')}: ${sc && sc.holdBack !== null ? fmtDuration(sc.holdBack) : t('common.notFound')}`);
    add(`${t('lowLatency.partHoldBack')}: ${sc && sc.partHoldBack !== null ? fmtDuration(sc.partHoldBack) : t('common.notFound')}`);
    add(`${t('lowLatency.canSkipUntil')}: ${sc && sc.canSkipUntil !== null ? fmtDuration(sc.canSkipUntil) : t('common.notFound')}`);
    add(`${t('lowLatency.canSkipDateranges')}: ${sc ? yesNo(sc.canSkipDateranges) : t('common.notFound')}`);
    add(`${t('lowLatency.partTarget')}: ${ll.partTargetDuration ? fmtDuration(ll.partTargetDuration) : t('common.notFound')}`);
    add(t('lowLatency.partsCopyLine', { countOrNotFound: ll.lastSegmentParts.length || t('common.notFound') }));
    if (ll.trailingParts.length) add(t('lowLatency.nextPartsCopyLine', { count: ll.trailingParts.length }));
    add(`${t('lowLatency.preloadHint')}: ${ll.preloadHint ? `${ll.preloadHint.type}: ${ll.preloadHint.uri}` : t('common.notFound')}`);
    add(`${t('lowLatency.renditionReportIntro').replace(/:$/, '')}: ${ll.renditionReports.length ? ll.renditionReports.map((r) => t('lowLatency.renditionCopyEntry', { uri: r.uri, lastMsn: r.lastMsn, lastPart: r.lastPart })).join('; ') : t('common.notFound')}`);
  }
  add('');

  const b = data.bitrate;
  add(t('bitrate.heading').toUpperCase());
  add(`${t('bitrate.average')}: ${b.averageMeasuredBitrateKbps ? fmtNumber(b.averageMeasuredBitrateKbps) + ' kbit/s' : '–'}`);
  add(`${t('bitrate.declared')}: ${b.declaredBandwidthKbps ? fmtNumber(b.declaredBandwidthKbps) + ' kbit/s' : t('bitrate.declaredUnknownCopy')}`);
  if (b.samples?.length) {
    add(t('bitrate.samplesIntro'));
    b.samples.forEach((samp) => {
      add(
        `  ${fmtDateTime(samp.programDateTime)}  ${samp.ok ? fmtInt(samp.bytes) + ' B' : t('bitrate.failed')}  ${
          samp.ok ? fmtNumber(samp.bitrateKbps) + ' kbit/s' : ''
        }`
      );
    });
  }
  add('');

  addSample(add, sample, sampleError, t('id3.heading').toUpperCase());
  addWarnings(add, data.errors);

  return lines.join('\n');
}

// Parallel DASH branch of buildCopyText - the same sections the DASH render
// chain shows, minus the raw MPD.
function buildDashCopyText(data, sample, sampleError) {
  const lines = [];
  const add = (line = '') => lines.push(line);

  add(t('flow.streamAnalysisDash', { url: data.requestedUrl }));
  add(t('flow.generated', { timestamp: fmtDateTime(new Date().toISOString()) }));
  add('');

  addConnection(add, data.connection);
  addNetworkPath(add, data.networkPath);

  const r = data.representations;
  add(t('dashRepr.heading').toUpperCase());
  add(t('dashRepr.analyzedCopy', { id: r.chosenId || '–', period: r.periodIndex + 1, periodCount: r.periodCount }));
  dashRepresentationNotes(r).forEach((note) => add(note));
  r.list.forEach((rep) => {
    const size = rep.width && rep.height ? `${rep.width}×${rep.height}` : rep.audioSamplingRate ? `${rep.audioSamplingRate} Hz` : '–';
    add(
      t('dashRepr.copyLine', {
        type: `${rep.contentType || '?'}${rep.lang ? ' ' + rep.lang : ''}`,
        id: rep.id || '?',
        chosenSuffix: rep.chosen ? t('dashRepr.chosenSuffix') : '',
        bandwidth: fmtInt(rep.bandwidthKbps),
        codecs: rep.codecs || t('dashRepr.unknownCodec'),
        size,
      })
    );
  });
  add('');

  addAudio(add, data.audio);

  const s = data.segments;
  add(t('segments.heading').toUpperCase());
  add(`${t('dashSegments.presentationType')}: ${s.isLive ? t('dashSegments.live') : t('dashSegments.vod')}`);
  add(`${t('dashSegments.addressing')}: ${dashAddressingLabel(s.segmentAddressing)}`);
  add(`${t('dashSegments.length')}: ${fmtDuration(s.segmentDurationSec)}`);
  add(`${t('dashSegments.count')}: ${s.segmentCount != null ? fmtInt(s.segmentCount) : '–'}${s.isLive ? t('dashSegments.estimated') : ''}`);
  add(`${t('dashSegments.window')}: ${fmtDuration(s.windowSeconds)}`);
  add(`${t('dashSegments.minBufferTime')}: ${fmtDuration(s.minBufferTimeSec)}`);
  add(`${t('dashSegments.minimumUpdatePeriod')}: ${s.minimumUpdatePeriodSec != null ? fmtDuration(s.minimumUpdatePeriodSec) : '–'}`);
  add(`${t('dashSegments.mediaPresentationDuration')}: ${fmtDuration(s.mediaPresentationDurationSec)}`);
  add(
    `${t('dashSegments.encryption')}: ${
      (s.contentProtection || []).length
        ? s.contentProtection.map((cp) => `${cp.schemeIdUri || '?'}${cp.value ? ` (${cp.value})` : ''}`).join(', ')
        : t('dashSegments.off')
    }`
  );
  add(`${t('dashSegments.format')}: ${s.fmp4 ? t('dashSegments.fmp4') : t('dashSegments.noInit')}`);
  if (s.initUri) add(`${t('dashSegments.initSegment')}: ${s.initUri}`);
  add('');

  const l = data.latency;
  add(t('latency.heading').toUpperCase());
  if (!l.available) {
    const reasonKey = `dash.noLatencyReasons.${l.reason}`;
    add(t(reasonKey) !== reasonKey ? t(reasonKey) : t('dashLatency.unavailable'));
  } else {
    add(`${t('dashLatency.method')}: ${l.method === 'declared' ? t('dashLatency.methodDeclared') : t('dashLatency.methodEstimated')}`);
    add(`${t('dashLatency.availabilityStartTime')}: ${fmtDateTime(l.availabilityStartTime)}${l.epochAnchored ? t('dashLatency.epochAnchored') : ''}`);
    add(`${t('dashLatency.publishTime')}: ${fmtDateTime(l.publishTime)}`);
    add(
      `${t('dashLatency.manifestAge')}: ${
        l.manifestAgeSec != null ? fmtDuration(l.manifestAgeSec) : l.epochAnchored ? t('dashLatency.manifestAgeUnavailableCopy') : '–'
      }`
    );
    add(`${t('dashLatency.suggestedDelay')}: ${l.suggestedPresentationDelaySec != null ? fmtDuration(l.suggestedPresentationDelaySec) : t('common.notFound')}`);
    add(`${t('dashLatency.estimatedDelay')}: ${fmtDuration(l.estimatedLiveDelaySec)}${l.method === 'estimated' ? t('dashLatency.estimatedSuffix') : ''}`);
    add(`${t('dashLatency.timeShiftBufferDepth')}: ${fmtDuration(l.timeShiftBufferDepthSec)}`);
  }
  add('');

  const b = data.bitrate;
  add(t('bitrate.heading').toUpperCase());
  add(`${t('bitrate.average')}: ${b.averageMeasuredBitrateKbps ? fmtNumber(b.averageMeasuredBitrateKbps) + ' kbit/s' : '–'}`);
  add(`${t('bitrate.declared')}: ${b.declaredBandwidthKbps ? fmtNumber(b.declaredBandwidthKbps) + ' kbit/s' : t('bitrate.declaredUnknownCopy')}`);
  if (b.samples?.length) {
    add(t('bitrate.samplesIntroDash'));
    b.samples.forEach((samp) => {
      add(`  ${samp.ok ? fmtInt(samp.bytes) + ' B  ' + fmtNumber(samp.bitrateKbps) + ' kbit/s' : t('bitrate.failed')}  ${samp.uri}`);
    });
  }
  add('');

  addSample(add, sample, sampleError, t('id3.heading').toUpperCase());
  addWarnings(add, data.errors);

  return lines.join('\n');
}

// Parallel Icecast/RSAS branch of buildCopyText - the sections the Icecast
// render chain shows, as plain text.
function buildIcecastCopyText(data, sample, sampleError) {
  const lines = [];
  const add = (line = '') => lines.push(line);

  add(t('flow.streamAnalysisIcecast', { url: data.requestedUrl }));
  add(t('flow.generated', { timestamp: fmtDateTime(new Date().toISOString()) }));
  add('');

  addConnection(add, data.connection);

  const st = data.station || {};
  add(t('icecastStation.heading').toUpperCase());
  add(`${t('icecastStation.name')}: ${st.name || '–'}`);
  add(
    `${t('icecastStation.nowPlaying')}: ${
      st.nowPlaying || (st.icyMetadataSupported ? t('icecastStation.metadataPendingCopy') : t('icecastStation.metadataOffCopy'))
    }`
  );
  add(`${t('icecastStation.genre')}: ${st.genre || '–'}`);
  add(`${t('icecastStation.description')}: ${st.description || '–'}`);
  add(`${t('icecastStation.homepage')}: ${st.homepageUrl || '–'}`);
  add(`${t('icecastStation.declaredBitrate')}: ${st.declaredBitrateKbps ? fmtInt(st.declaredBitrateKbps) + ' kbit/s' : '–'}`);
  add(`${t('icecastStation.declaredSampleRate')}: ${st.declaredSampleRateHz ? fmtInt(st.declaredSampleRateHz) + ' Hz' : '–'}`);
  if (st.audioInfo) add(`ice-audio-info: ${st.audioInfo}`);
  add(`${t('icecastStation.serverSoftware')}: ${st.serverSoftware || '–'}`);
  add(`${t('icecastStation.publiclyListed')}: ${yesNo(st.isPublic)}`);
  add(`${t('icecastStation.inStreamMetadata')}: ${st.icyMetadataSupported ? t('icecastStation.inStreamMetadataYesCopy', { metaInt: fmtInt(st.metaIntBytes) }) : t('common.no')}`);
  if (st.rawMetaBlock) add(`${t('icecastStation.rawMetaBlock').replace(/:$/, '')}: ${st.rawMetaBlock}`);
  add('');

  addAudio(add, data.audio);
  addNetworkPath(add, data.networkPath);

  add(t('icecastSample.heading').toUpperCase());
  if (sampleError) {
    add(t('id3.fetchFailed', { message: sampleError.message }));
  } else if (sample) {
    (sample.warnings || []).forEach((w) => add(t('warnings.prefix', { message: errorText(w) })));
    add(`${t('icecastSample.average')}: ${sample.measuredBitrateKbps ? fmtNumber(sample.measuredBitrateKbps) + ' kbit/s' : '–'}`);
    add(`${t('icecastSample.recordedLength')}: ${fmtDuration(sample.actualDurationSec)}`);
    add(
      `${t('icecastSample.connectBurst')}: ${
        typeof sample.connectBurstSec !== 'number' || sample.connectBurstSec < 1
          ? t('icecastSample.burstNoneCopy')
          : t(sample.burstIsLowerBound ? 'icecastSample.burstAtLeast' : 'icecastSample.burstApprox', { seconds: fmtDuration(sample.connectBurstSec) })
      }`
    );
    add(`${t('icecastSample.sampleSize')}: ${sample.fileSizeBytes ? fmtInt(sample.fileSizeBytes) + ' byte' : '–'}`);
    if (sample.id3 && sample.id3.available) {
      sample.id3.frames.forEach((f) => add(`  ID3 ${fmtDuration(f.ptsTime)}: ${JSON.stringify(f.tags)}`));
    }
  } else {
    add(t('icecastSample.notFetched'));
  }

  addWarnings(add, data.errors);

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

// The streamKind dispatch, extracted so both runAnalysis() and the onLocaleChange
// handler below can re-render the same result without redoing any network requests.
function renderResults(data) {
  if (data.streamKind === 'dash') {
    resultsEl.innerHTML =
      renderAnalysisControls() +
      renderWarnings(data.errors) +
      renderConnection(data.connection) +
      renderNetworkPath(data.networkPath) +
      renderDashRepresentations(data.representations) +
      renderAudio(data.audio) +
      renderDashSegments(data.segments) +
      renderDashLatency(data.latency) +
      renderBitrate(data.bitrate) +
      renderId3Placeholder() +
      renderDashManifest(data.manifests);
  } else if (data.streamKind === 'icecast') {
    resultsEl.innerHTML =
      renderAnalysisControls() +
      renderWarnings(data.errors) +
      renderConnection(data.connection) +
      renderNetworkPath(data.networkPath) +
      renderIcecastStation(data.station) +
      renderAudio(data.audio) +
      renderIcecastSamplePlaceholder();
  } else {
    resultsEl.innerHTML =
      renderAnalysisControls() +
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
  }
}

async function runAnalysis(targetUrl, { isVariantSwitch = false } = {}) {
  // A running log owns #results and keeps writing to it every 15 seconds. Analysing
  // without stopping it first would have the two overwrite each other. claimResults()
  // below handles a log that is still *starting*; this stops one already polling.
  if (typeof stopStreamLog === 'function') stopStreamLog();

  // Disabling the Analyze button does not stop a variant row from being clicked, and
  // the sample phase alone runs 8-20 s - so two runs could overlap, and the log and
  // file views can take over mid-flight too. See claimResults() in shared.js.
  const myToken = claimResults('analyze');
  const isStale = () => !ownsResults(myToken);

  if (faqEl) faqEl.open = false; // collapse the FAQ so it never buries the results
  analyzeBtn.disabled = true;
  lastAnalyzeData = null;
  lastSampleData = null;
  lastSampleError = null;
  statusEl.textContent = t('flow.analyzing');
  resultsEl.innerHTML = '';

  currentAnalyzedUrl = targetUrl;
  // The non-variant case needs nothing: claimResults() already cleared and hid this.
  if (isVariantSwitch) {
    analyzedUrlInfoEl.innerHTML = t('flow.analyzedFrom', { master: esc(currentMasterUrl), target: esc(targetUrl) });
    analyzedUrlInfoEl.hidden = false;
  }

  let data;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });
    const body = await res.json();
    if (isStale()) return;
    if (!res.ok) {
      resultsEl.innerHTML = renderFatalError(body.error);
      statusEl.textContent = '';
      analyzeBtn.disabled = false;
      return;
    }
    data = body;
  } catch (err) {
    if (isStale()) return;
    resultsEl.innerHTML = renderFatalError({ message: t('error.serverUnreachable', { message: err.message }), details: {} });
    statusEl.textContent = '';
    analyzeBtn.disabled = false;
    return;
  }

  if (data.streamKind !== 'dash' && data.streamKind !== 'icecast' && !isVariantSwitch) {
    baseVariantsInfo = data.variants;
  }
  renderResults(data);

  lastAnalyzeData = data;
  setCopyEnabled(true);

  const isIcecast = data.streamKind === 'icecast';
  statusEl.textContent = isIcecast ? t('flow.recordingSample') : t('flow.fetchingNowPlaying');
  const sampleSection = document.getElementById(isIcecast ? 'sec-icecast-sample' : 'sec-id3');
  const renderSample = (body, error) =>
    isIcecast ? renderIcecastSample(body, error) : renderId3(body, error);
  const sampleTarget = data.sampleUrl || data.variants?.chosenVariantUrl;
  if (!sampleTarget) {
    sampleSection.innerHTML = renderSample(null, { message: t('id3.noUrl') });
  } else {
    try {
      const sampleUrl = '/api/sample?url=' + encodeURIComponent(sampleTarget) + '&secs=8';
      const res = await fetch(sampleUrl);
      const body = await res.json();
      if (isStale()) return;
      if (res.ok) {
        sampleSection.innerHTML = renderSample(body, null);
        lastSampleData = body;
      } else {
        sampleSection.innerHTML = renderSample(null, body.error);
        lastSampleError = body.error;
      }
    } catch (err) {
      if (isStale()) return;
      const fetchError = { message: t('error.serverUnreachable', { message: err.message }) };
      sampleSection.innerHTML = renderSample(null, fetchError);
      lastSampleError = fetchError;
    }
  }

  // Only if this run still owns the area: a newer view has already reset the chrome
  // to suit itself (see claimResults()), and clearing its status line here would be
  // this run reaching past the end of its own turn.
  if (isStale()) return;
  statusEl.textContent = '';
  analyzeBtn.disabled = false;
}

// Analysera and Logga are two answers to the same URL and share one results area, so
// starting one has to stop the other.
const logBtn = document.getElementById('log-btn');
if (logBtn) {
  logBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
      statusEl.textContent = t('controls.enterUrlFirst');
      return;
    }
    // Same page, same results area as Analysera - the log takes over #results and
    // owns it until the user analyses or logs again. That takeover (see
    // startStreamLog -> resultsEl.innerHTML = '') already removes the copy button
    // along with the rest of the previous analysis, so there is nothing to disable
    // here - it simply stops existing.
    lastAnalyzeData = null;
    lastSampleData = null;
    lastSampleError = null;
    currentAnalyzedUrl = url;
    // startStreamLog claims #results itself, which clears the master→variant note.
    startStreamLog(url, { statusEl, resultsEl });
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    statusEl.textContent = t('controls.enterUrlFirst');
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

// The button lives inside #results (see renderAnalysisControls()) and its node is
// replaced on every render, so it is caught here via delegation on the ancestor -
// the same pattern the variant-row handler above already uses - rather than a
// direct binding that would go stale the moment a new analysis re-renders it.
resultsEl.addEventListener('click', async (event) => {
  const btn = event.target.closest('#copy-btn');
  if (!btn || btn.disabled || !lastAnalyzeData) return;
  const text = buildCopyText(lastAnalyzeData, lastSampleData, lastSampleError, baseVariantsInfo);
  const originalLabel = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('controls.copied');
  } catch (err) {
    btn.textContent = t('controls.copyFailed');
  }
  setTimeout(() => { btn.textContent = originalLabel; }, 1500);
});

// A language switch re-renders this view in place from cached data instead of
// reloading the page - see setLocale()/onLocaleChange() in i18n.js and
// claimResults(owner)/currentResultsOwner() in shared.js. No-op if this view
// doesn't currently own #results, or there's nothing rendered yet to redo.
onLocaleChange(() => {
  if (currentResultsOwner() !== 'analyze' || !lastAnalyzeData) return;
  renderResults(lastAnalyzeData);
  setCopyEnabled(true);
  const isIcecast = lastAnalyzeData.streamKind === 'icecast';
  const sampleSection = document.getElementById(isIcecast ? 'sec-icecast-sample' : 'sec-id3');
  if (sampleSection) {
    sampleSection.innerHTML = isIcecast
      ? renderIcecastSample(lastSampleData, lastSampleError)
      : renderId3(lastSampleData, lastSampleError);
  }
});
