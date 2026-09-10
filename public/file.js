// file.js
// The uploaded-file view: pick a file, POST it to /api/analyze-file, render the
// result into the same #results area the analyze and log views use. Loaded after
// app.js and log.js, so esc/fmt*/withHint/renderWarnings/renderFatalError from
// shared.js and app.js are all in scope and reused unchanged.
//
// The file goes up as the raw request body (Content-Type: application/octet-stream)
// - no multipart, no FormData - which is what the server's streamed size-capped
// reader expects.

const fileForm = document.getElementById('file-form');
const fileInput = document.getElementById('file-input');
const fileBtn = document.getElementById('file-btn');

let lastFileData = null;
let fileRunToken = 0;

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function renderFileControls() {
  return `
    <div id="analysis-controls">
      <button type="button" id="file-copy-btn" title="Kopiera all filanalys som text" disabled>Kopiera analys</button>
    </div>`;
}

function tagLabel(key) {
  // ID3/Vorbis keys are lowercase machine names; give the common ones a Swedish label.
  const map = {
    title: 'Titel',
    artist: 'Artist',
    album: 'Album',
    album_artist: 'Albumartist',
    date: 'År',
    track: 'Spår',
    genre: 'Genre',
    composer: 'Kompositör',
    comment: 'Kommentar',
    publisher: 'Utgivare',
    copyright: 'Copyright',
    language: 'Språk',
  };
  return map[key] || key;
}

function renderFileOverview(data) {
  const f = data.format || {};
  const x = data.audioExtra || {};

  const tagRows = Object.entries(f.tags || {})
    .map(([k, v]) => `<tr><td>${esc(tagLabel(k))}</td><td>${esc(v)}</td></tr>`)
    .join('');
  const tagBlock = tagRows
    ? `<table><thead><tr><th>Tagg</th><th>Värde</th></tr></thead><tbody>${tagRows}</tbody></table>`
    : '<p class="note">Inga taggar (artist/titel/album …) i filen.</p>';

  const replayRows = Object.entries(f.replayGain || {})
    .map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>${esc(v)}</td></tr>`)
    .join('');
  const replayBlock = replayRows
    ? `<p class="note">${withHint('span', 'ReplayGain-taggar', 'replaygain')} (satta av ett tidigare verktyg, inte av oss):</p>
       <table><tbody>${replayRows}</tbody></table>`
    : '';

  const chapterRows = (f.chapters || [])
    .map(
      (c) =>
        `<tr><td>${fmtDuration(c.startSec, 0)}</td><td>${fmtDuration(c.endSec, 0)}</td><td>${esc(c.title) || '–'}</td></tr>`
    )
    .join('');
  const chapterBlock = chapterRows
    ? `<p class="note">${withHint('span', 'Kapitel', 'kapitel')}:</p>
       <table><thead><tr><th>Från</th><th>Till</th><th>Titel</th></tr></thead><tbody>${chapterRows}</tbody></table>`
    : '';

  const cover = f.coverArt
    ? `${f.coverArt.width && f.coverArt.height ? esc(f.coverArt.width + '×' + f.coverArt.height) + ' px' : 'ja'} (${esc(f.coverArt.codec) || 'okänt format'})`
    : 'nej';

  // TLEN is the file's own claim about its length. Show it as a readable time, and
  // when it disagrees with the real duration (a trimmed or re-encoded file), say so.
  const tlenMismatch =
    f.taggedDurationSec != null &&
    f.durationSec != null &&
    fmtDuration(f.taggedDurationSec) !== fmtDuration(f.durationSec);
  const tlenRow =
    f.taggedDurationSec != null
      ? `${withHint('dt', 'Längd enligt tagg (TLEN)', 'tlen')}<dd>${fmtDuration(f.taggedDurationSec)}${
          tlenMismatch
            ? ` <span class="tag-mismatch">skiljer sig från filens uppmätta längd (${fmtDuration(f.durationSec)})</span>`
            : ''
        }</dd>`
      : '';

  const bitDepth = data.loudness?.astats
    ? data.loudness.astats.bitDepthUsed === data.loudness.astats.bitDepthContainer
      ? `${fmtInt(data.loudness.astats.bitDepthContainer)} bitar`
      : `${fmtInt(data.loudness.astats.bitDepthContainer)} bitar deklarerat, ${fmtInt(data.loudness.astats.bitDepthUsed)} faktiskt använda`
    : x.bitsPerRawSample
    ? `${fmtInt(x.bitsPerRawSample)} bitar`
    : x.bitsPerSample
    ? `${fmtInt(x.bitsPerSample)} bitar`
    : '–';

  return `
    <section id="sec-file-overview">
      ${withHint('h2', 'Filen', 'fil-oversikt')}
      <dl>
        <dt>Filnamn</dt><dd>${esc(data.originalName) || '–'}</dd>
        ${withHint('dt', 'Container', 'fil-container')}<dd>${esc(f.container) || '–'}${
    f.containerLongName ? ' (' + esc(f.containerLongName) + ')' : ''
  }</dd>
        ${withHint('dt', 'Längd', 'fil-langd')}<dd>${fmtDuration(f.durationSec)}</dd>
        ${tlenRow}
        <dt>Filstorlek</dt><dd>${f.fileSizeBytes ? fmtInt(f.fileSizeBytes) + ' byte' : '–'}</dd>
        ${withHint('dt', 'Bitrate (snitt)', 'audio-bitrate')}<dd>${
    f.overallBitrateKbps ? fmtNumber(f.overallBitrateKbps) + ' kbit/s' : '–'
  }</dd>
        ${withHint('dt', 'Sampleformat', 'sampleformat')}<dd>${esc(x.sampleFmt) || '–'}</dd>
        ${withHint('dt', 'Bitdjup', 'bitdjup')}<dd>${bitDepth}</dd>
        ${withHint('dt', 'Encoder', 'encoder')}<dd>${esc(f.encoder) || '–'}</dd>
        ${withHint('dt', 'Omslagsbild', 'omslagsbild')}<dd>${cover}</dd>
      </dl>
      ${replayBlock}
      <div class="subsection"><h3>Taggar</h3>${tagBlock}</div>
      ${chapterBlock}
    </section>`;
}

// The silence-gated mono / out-of-phase stretches (see gatePhasingBySilence on the
// server). Only real, audible ones reach here - a silent lead-in no longer shows.
function renderFilePhase(stereo) {
  if (!stereo) return '';
  const spans = [
    ...(stereo.outOfPhaseSpans || []).map((s) => ({ ...s, kind: 'Ur fas (motverkar sig i mono)' })),
    ...(stereo.dualMono ? [] : (stereo.monoSpans || []).map((s) => ({ ...s, kind: 'Mono (kanalerna identiska)' }))),
  ].sort((a, b) => a.startSec - b.startSec);
  if (!spans.length) return '';
  const rows = spans
    .map(
      (s) =>
        `<tr><td>${esc(s.kind)}</td><td>${fmtDuration(s.startSec, 0)}</td><td>${
          s.endSec === null ? 'till slutet' : fmtDuration(s.endSec, 0)
        }</td><td>${s.durationSec === null ? '–' : fmtDuration(s.durationSec, 0)}</td></tr>`
    )
    .join('');
  return `
    <p class="note">${withHint('span', 'Fas- och monopartier', 'fas')} (tystnad borträknad):</p>
    <table><thead><tr><th>Typ</th><th>Från</th><th>Till</th><th>Längd</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fmtCorrelation(r) {
  if (typeof r !== 'number') return '–';
  return (r > 0 ? '+' : '') + fmtNumber(r, 2);
}

// A one-line reading of the correlation value, in the terms a correlation meter is
// normally read: +1 mono, ~+0.5..+1 the "safe" mono-compatible zone, 0 very wide,
// below 0 the channels partly cancel when summed to mono.
function stereoVerdict(stereo) {
  const r = stereo && stereo.correlation;
  if (typeof r !== 'number') return null;
  if (stereo.dualMono || r >= 0.999) return 'identiska kanaler (dubbelmono – ingen stereobild)';
  if (r >= 0.9) return 'mycket smal stereobild, nästan mono';
  if (r >= 0.5) return 'normal stereobild, mono-kompatibel';
  if (r >= 0.1) return 'bred stereobild';
  if (r >= -0.1) return 'mycket bred / dekorrelerad – kontrollera i mono';
  return 'kanalerna motverkar varandra – energi går förlorad vid mono-summering';
}

function renderStereoRow(stereo) {
  const dt = withHint('dt', 'Stereokorrelation', 'stereokorrelation');
  if (!stereo) return `${dt}<dd>– (kunde inte mätas)</dd>`;
  if (stereo.correlation === null || stereo.correlation === undefined) {
    return `${dt}<dd>– (för lite ljud för att mäta)</dd>`;
  }
  const verdict = stereoVerdict(stereo);
  const windowNote = stereo.windowTruncated
    ? ` <span class="note">(uppmätt över de första ${fmtDuration(stereo.windowSec, 0)})</span>`
    : '';
  const verdictHtml = !verdict
    ? ''
    : stereo.correlation < 0
    ? ` · <span class="stereo-warn">${esc(verdict)}</span>`
    : ` · ${esc(verdict)}`;
  return `${dt}<dd>${fmtCorrelation(stereo.correlation)}${verdictHtml}${windowNote}</dd>`;
}

function renderFileLoudness(data) {
  const head = withHint('h2', 'Ljudnivå och dynamik', 'loudness');
  const err = data.errors?.loudness;
  if (err) return `<section id="sec-file-loudness">${head}<p class="error">${esc(err.message)}</p></section>`;
  const l = data.loudness;
  if (!l) return `<section id="sec-file-loudness">${head}<p class="note">Kunde inte mätas.</p></section>`;

  const a = l.astats || {};
  const isStereo = (data.audio?.channels || 0) >= 2;
  const truePeak = l.truePeakIsSilent
    ? '−∞ dBTP (helt digitalt tyst)'
    : l.truePeakDbfs === null
    ? '–'
    : fmtNumber(l.truePeakDbfs) + ' dBTP';

  const truncNote = l.truncated
    ? `<p class="note">Filen är längre än 130 minuter – analysen nedan gäller de första ${fmtDuration(
        l.analyzedSeconds
      )}.</p>`
    : '';

  return `
    <section id="sec-file-loudness">
      ${head}
      ${truncNote}
      <dl>
        ${withHint('dt', 'Integrerad nivå', 'integrated-lufs')}<dd>${
    l.integratedLufs === null ? '–' : fmtNumber(l.integratedLufs) + ' LUFS'
  }</dd>
        ${withHint('dt', 'Loudness range (LRA)', 'lra')}<dd>${
    l.lra === null ? '–' : fmtNumber(l.lra) + ' LU' + (l.lraLow !== null && l.lraHigh !== null ? ` (${fmtNumber(l.lraLow)} … ${fmtNumber(l.lraHigh)} LUFS)` : '')
  }</dd>
        ${withHint('dt', 'True peak', 'true-peak')}<dd>${truePeak}</dd>
        ${withHint('dt', 'Sample peak', 'sample-peak')}<dd>${
    l.samplePeakDbfs === null ? (l.truePeakIsSilent ? '−∞ dBFS' : '–') : fmtNumber(l.samplePeakDbfs) + ' dBFS'
  }</dd>
        ${withHint('dt', 'PLR (peak − nivå)', 'plr')}<dd>${l.plr === null ? '–' : fmtNumber(l.plr) + ' LU'}</dd>
        ${withHint('dt', 'Crest factor', 'crest-factor')}<dd>${a.crestFactor === null || a.crestFactor === undefined ? '–' : fmtNumber(a.crestFactor, 2)}</dd>
        ${withHint('dt', 'DC-offset', 'dc-offset')}<dd>${a.dcOffset === null || a.dcOffset === undefined ? '–' : fmtNumber(a.dcOffset, 4)}</dd>
        ${withHint('dt', 'RMS-nivå', 'rms-niva')}<dd>${a.rmsLevelDb === null || a.rmsLevelDb === undefined ? '–' : fmtNumber(a.rmsLevelDb) + ' dB'}</dd>
        ${withHint('dt', 'Brusgolv', 'brusgolv')}<dd>${a.noiseFloorDb === null || a.noiseFloorDb === undefined ? '–' : fmtNumber(a.noiseFloorDb) + ' dB'}</dd>
        ${withHint('dt', 'Samplingar i digitalt max', 'klippning')}<dd>${
    a.absPeakCount === null || a.absPeakCount === undefined ? '–' : fmtInt(a.absPeakCount)
  }${a.absPeakCount ? ' (kan betyda klippning eller hård limitering)' : ''}</dd>
        ${isStereo ? renderStereoRow(l.stereo) : ''}
      </dl>
      ${isStereo ? renderFilePhase(l.stereo) : ''}
      <div class="subsection">
        <h3>Ljudnivå</h3>
        <canvas class="analysis-chart" id="file-loudness-chart" height="220"></canvas>
        <p class="note" id="file-chart-legend"></p>
      </div>
    </section>`;
}

function renderFileSpectrogram(data) {
  const head = withHint('h2', 'Spektrogram', 'spektrogram');
  const err = data.errors?.spectrogram;
  if (err) return `<section id="sec-file-spectrogram">${head}<p class="error">${esc(err.message)}</p></section>`;
  const s = data.spectrogram;
  if (!s) return '';

  // Only ever a data:image/png URI we built ourselves; check the shape anyway
  // before it becomes an <img src>.
  const safeImg =
    typeof s.dataUri === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.dataUri) ? s.dataUri : null;

  const guess = s.lossySourceGuess || {};
  // Only the actionable finding stays as text - a suspected lossy source. The
  // spectrogram itself, plus the heading tooltip, cover the rest.
  const lossyNote = guess.suspected
    ? `<p class="note">${withHint('span', 'Möjlig lossy källa', 'lossy-kalla')}: frekvenserna kapas tvärt vid ~${fmtInt(
        guess.cliffHz
      )} Hz (${fmtNumber(guess.gapDb)} dB under fullbandsnivån) – typiskt för MP3/AAC. Ingen säker dom.</p>`
    : '';

  // A long file's spectrogram only covers the analysed window; say so, but stay quiet
  // for a normal-length track where the window is the whole thing.
  const windowNote =
    s.windowSeconds && data.format?.durationSec && data.format.durationSec > s.windowSeconds + 1
      ? `<p class="note">Visar de första ${fmtDuration(s.windowSeconds, 0)}.</p>`
      : '';

  return `
    <section id="sec-file-spectrogram">
      ${head}
      ${windowNote}
      ${safeImg ? `<img class="spectrogram" src="${safeImg}" alt="Spektrogram av filen" />` : '<p class="note">Ingen bild kunde skapas.</p>'}
      ${lossyNote}
    </section>`;
}

// --------------------------------------------------------------------------
// Chart - hand-rolled canvas, x = time into the file (see log.js drawChart for
// the same technique on a poll-indexed x axis).
// --------------------------------------------------------------------------

function drawFileLoudnessChart(series, integratedLufs) {
  const canvas = document.getElementById('file-loudness-chart');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const points = series || [];
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = 220;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 44, right: 10, top: 12, bottom: 22 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  const values = [];
  for (const p of points) {
    if (typeof p.shortTermLufs === 'number') values.push(p.shortTermLufs);
    if (typeof p.truePeakDbfs === 'number') values.push(p.truePeakDbfs);
  }
  if (typeof integratedLufs === 'number') values.push(integratedLufs);
  let min = values.length ? Math.min(...values) : -40;
  let max = values.length ? Math.max(...values) : 0;
  if (max - min < 6) {
    const mid = (max + min) / 2;
    min = mid - 3;
    max = mid + 3;
  }
  min = Math.max(-70, min - 2);
  max = Math.min(6, max + 2);

  const tMax = points.length ? points[points.length - 1].tSec : 1;
  const tMin = points.length ? points[0].tSec : 0;
  const span = tMax - tMin || 1;
  const xAt = (t) => pad.left + ((t - tMin) / span) * plotW;
  const yAt = (v) => pad.top + plotH - ((v - min) / (max - min)) * plotH;

  // Horizontal gridlines + labels every 10 units.
  ctx.strokeStyle = '#e5e5e5';
  ctx.fillStyle = '#666';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let v = Math.ceil(min / 10) * 10; v <= max; v += 10) {
    const y = Math.round(yAt(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(String(v), pad.left - 6, y);
  }

  ctx.strokeStyle = '#999';
  ctx.beginPath();
  ctx.moveTo(pad.left + 0.5, pad.top);
  ctx.lineTo(pad.left + 0.5, pad.top + plotH);
  ctx.stroke();

  // Integrated-loudness reference line (dashed).
  if (typeof integratedLufs === 'number') {
    ctx.save();
    ctx.strokeStyle = '#15803d';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const y = Math.round(yAt(integratedLufs)) + 0.5;
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.restore();
  }

  const drawSeries = (pick, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    for (const p of points) {
      const v = pick(p);
      if (typeof v !== 'number') {
        pen = false;
        continue;
      }
      const x = xAt(p.tSec);
      const y = yAt(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  };
  drawSeries((p) => p.shortTermLufs, '#0b6bcb');
  drawSeries((p) => p.truePeakDbfs, '#c2410c');

  if (points.length) {
    ctx.fillStyle = '#666';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDuration(tMin, 0), pad.left, pad.top + plotH + 6);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDuration(tMax, 0), pad.left + plotW, pad.top + plotH + 6);
  }

  const legend = document.getElementById('file-chart-legend');
  if (legend) {
    legend.innerHTML =
      '<span class="swatch swatch-lufs"></span> Short-term ljudnivå (LUFS)' +
      ' <span class="swatch swatch-truepeak"></span> True peak (dBTP)' +
      (typeof integratedLufs === 'number' ? ' <span class="swatch swatch-integrated"></span> Integrerad nivå' : '');
  }
}

// --------------------------------------------------------------------------
// Copy text
// --------------------------------------------------------------------------

function buildFileCopyText(data) {
  const lines = [];
  const add = (s = '') => lines.push(s);
  const f = data.format || {};
  const l = data.loudness;
  const a = l?.astats || {};

  add(`Filanalys: ${data.originalName || '(namnlös)'}`);
  add(`Genererad: ${fmtDateTime(new Date().toISOString())}`);
  add('');
  add('FIL');
  add(`Container: ${f.container || '–'}`);
  add(`Längd: ${fmtDuration(f.durationSec)}`);
  if (f.taggedDurationSec != null) {
    const diff = f.durationSec != null && fmtDuration(f.taggedDurationSec) !== fmtDuration(f.durationSec);
    add(`Längd enligt TLEN-tagg: ${fmtDuration(f.taggedDurationSec)}${diff ? ' (skiljer sig från uppmätt)' : ''}`);
  }
  add(`Filstorlek: ${f.fileSizeBytes ? fmtInt(f.fileSizeBytes) + ' byte' : '–'}`);
  add(`Bitrate (snitt): ${f.overallBitrateKbps ? fmtNumber(f.overallBitrateKbps) + ' kbit/s' : '–'}`);
  add(`Encoder: ${f.encoder || '–'}`);
  add('');
  add('LJUDSPÅRET');
  add(`Codec: ${data.audio?.codec || '–'}${data.audio?.profile ? ' (' + data.audio.profile + ')' : ''}`);
  add(`Samplingsfrekvens: ${data.audio?.sampleRate ? fmtInt(data.audio.sampleRate) + ' Hz' : '–'}`);
  add(`Kanaler: ${data.audio?.channels ?? '–'}`);
  add(`Sampleformat: ${data.audioExtra?.sampleFmt || '–'}`);
  if (a.bitDepthUsed != null) add(`Bitdjup: ${a.bitDepthContainer} deklarerat / ${a.bitDepthUsed} använda`);
  add('');
  if (Object.keys(f.tags || {}).length) {
    add('TAGGAR');
    Object.entries(f.tags).forEach(([k, v]) => add(`  ${tagLabel(k)}: ${v}`));
    add('');
  }
  if (l) {
    add('LJUDNIVÅ OCH DYNAMIK');
    if (l.truncated) add(`(första ${fmtDuration(l.analyzedSeconds)} av filen)`);
    add(`Integrerad nivå: ${l.integratedLufs === null ? '–' : fmtNumber(l.integratedLufs) + ' LUFS'}`);
    add(`LRA: ${l.lra === null ? '–' : fmtNumber(l.lra) + ' LU'}`);
    add(`True peak: ${l.truePeakIsSilent ? '−∞ dBTP' : l.truePeakDbfs === null ? '–' : fmtNumber(l.truePeakDbfs) + ' dBTP'}`);
    add(`Sample peak: ${l.samplePeakDbfs === null ? '–' : fmtNumber(l.samplePeakDbfs) + ' dBFS'}`);
    add(`PLR: ${l.plr === null ? '–' : fmtNumber(l.plr) + ' LU'}`);
    add(`Crest factor: ${a.crestFactor == null ? '–' : fmtNumber(a.crestFactor, 2)}`);
    add(`DC-offset: ${a.dcOffset == null ? '–' : fmtNumber(a.dcOffset, 4)}`);
    add(`RMS-nivå: ${a.rmsLevelDb == null ? '–' : fmtNumber(a.rmsLevelDb) + ' dB'}`);
    add(`Brusgolv: ${a.noiseFloorDb == null ? '–' : fmtNumber(a.noiseFloorDb) + ' dB'}`);
    add(`Samplingar i digitalt max: ${a.absPeakCount == null ? '–' : fmtInt(a.absPeakCount)}`);
    if ((data.audio?.channels || 0) >= 2 && l.stereo) {
      const s = l.stereo;
      const v = stereoVerdict(s);
      add(
        s.correlation == null
          ? 'Stereokorrelation: – (för lite ljud för att mäta)'
          : `Stereokorrelation: ${fmtCorrelation(s.correlation)}${v ? ' – ' + v : ''}${
              s.windowTruncated ? ` (första ${fmtDuration(s.windowSec, 0)})` : ''
            }`
      );
      const spans = [
        ...(s.outOfPhaseSpans || []).map((x) => `  Ur fas ${fmtDuration(x.startSec, 0)}–${x.endSec == null ? 'slutet' : fmtDuration(x.endSec, 0)}`),
        ...(s.dualMono ? [] : (s.monoSpans || []).map((x) => `  Mono ${fmtDuration(x.startSec, 0)}–${x.endSec == null ? 'slutet' : fmtDuration(x.endSec, 0)}`)),
      ];
      if (spans.length) {
        add('Fas- och monopartier (tystnad borträknad):');
        spans.forEach(add);
      }
    }
    add('');
  }
  if (data.spectrogram?.lossySourceGuess) {
    const g = data.spectrogram.lossySourceGuess;
    add('SPEKTRUM');
    add(
      g.suspected
        ? `Möjlig lossy källa: frekvensavskärning runt ${fmtInt(g.cliffHz)} Hz (${fmtNumber(g.gapDb)} dB gap).`
        : `Ingen tydlig frekvensavskärning (${g.gapDb === null ? '–' : fmtNumber(g.gapDb) + ' dB gap'}).`
    );
    add('');
  }
  const errKeys = Object.keys(data.errors || {});
  if (errKeys.length) {
    add('DELVIS RESULTAT');
    errKeys.forEach((k) => add(`  ${k}: ${data.errors[k].message}`));
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Flow
// --------------------------------------------------------------------------

function renderFileResult(data) {
  const resultsEl = document.getElementById('results');
  resultsEl.innerHTML =
    renderFileControls() +
    renderWarnings(data.errors) +
    renderFileOverview(data) +
    renderAudio(data.audio) +
    renderFileLoudness(data) +
    renderFileSpectrogram(data);

  if (data.loudness && !data.errors?.loudness) {
    drawFileLoudnessChart(data.loudness.series, data.loudness.integratedLufs);
  }
  const copyBtn = document.getElementById('file-copy-btn');
  if (copyBtn) copyBtn.disabled = false;
}

async function analyzeFile(file) {
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');

  // Take over #results from whatever was there.
  if (typeof stopStreamLog === 'function') stopStreamLog();
  if (typeof cancelAnalysis === 'function') cancelAnalysis();
  const myToken = ++fileRunToken;

  lastFileData = null;
  fileBtn.disabled = true;
  resultsEl.innerHTML = '';
  document.getElementById('analyzed-url-info').hidden = true;
  statusEl.textContent = `Analyserar ${file.name} …`;

  try {
    const res = await fetch('/api/analyze-file?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = await res.json();
    if (myToken !== fileRunToken) return;
    if (!res.ok) {
      resultsEl.innerHTML = renderFatalError(body.error || { message: 'Analysen misslyckades.', details: {} });
      return;
    }
    lastFileData = body;
    renderFileResult(body);
  } catch (err) {
    if (myToken !== fileRunToken) return;
    resultsEl.innerHTML = renderFatalError({ message: 'Kunde inte nå servern: ' + err.message, details: {} });
  } finally {
    if (myToken === fileRunToken) {
      statusEl.textContent = '';
      fileBtn.disabled = false;
    }
  }
}

if (fileForm) {
  fileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      document.getElementById('status').textContent = 'Välj en fil först.';
      return;
    }
    analyzeFile(file);
  });
}

// The copy button lives inside #results and is recreated on every render, so catch
// it by delegation on the stable ancestor - same pattern app.js uses for its own.
document.getElementById('results')?.addEventListener('click', async (event) => {
  const btn = event.target.closest('#file-copy-btn');
  if (!btn || btn.disabled || !lastFileData) return;
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(buildFileCopyText(lastFileData));
    btn.textContent = 'Kopierat!';
  } catch {
    btn.textContent = 'Kunde inte kopiera';
  }
  setTimeout(() => {
    btn.textContent = original;
  }, 1500);
});
