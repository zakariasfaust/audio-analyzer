// log.js
// The stream log: follow one stream over time instead of taking a single snapshot.
// Loaded by index.html alongside app.js - same page, same URL field, same results
// area. app.js calls startStreamLog() when "Logga" is clicked and stopStreamLog()
// before it runs an analysis, so the two views never fight over #results.
//
// Everything lives in this browser tab. No server-side job, no database, no schedule:
// the page records a slice of the stream on a timer, measures it, and keeps the
// results in memory (mirrored to localStorage). Close the tab without exporting and
// the log is gone - hence the export buttons and the beforeunload guard.

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

// Record for as long as the server allows, and start the next recording as soon as the
// previous cycle is done. Back-to-back recordings are what make silence measurable:
// with a gap between them, dead air can hide in the part nobody listened to.
const LOG_SAMPLE_SEC = 15;
const LOG_INTERVAL_SEC = 15;

// A silence stretch reaching this close to the edge of a recording almost certainly
// continues into the recording next door. Matches SILENCE_MIN_DURATION_SEC on the
// server: shorter fragments than that are never reported, so this is the resolution
// limit at a boundary.
const EDGE_TOLERANCE_SEC = 0.75;

// How much unheard wall-clock time between two recordings may be treated as silent
// when the audio on both sides of it was silent. This only ever bridges the reconnect
// gap between consecutive recordings - never a gap inside one, where we did hear audio.
const MAX_BRIDGE_MS = 4000;

// Measurement slack when comparing against the user's threshold. A stretch can lose up
// to one unreported fragment at each end (see EDGE_TOLERANCE_SEC), so a true 20 s
// silence can measure ~19 s. Erring towards listing it is the right way to be wrong:
// this list exists to catch dead air, not to be pedantic about its length.
const THRESHOLD_SLACK_SEC = 1;

// True peak above this gets an event. Digital full scale is 0 dBTP; anything over is
// an intersample overshoot that some players will audibly distort.
const CLIPPING_DBTP = 0.1;

const WARN_AFTER_HOURS = 24;
const MAX_TABLE_ROWS = 200;
const STORAGE_KEY = 'audio-analyzer-log-v1';

const CHART_COLORS = {
  lufs: '#0b6bcb',
  truePeak: '#c2410c',
  silence: 'rgba(234, 179, 8, 0.22)',
  outage: 'rgba(176, 0, 32, 0.16)',
  grid: '#e5e5e5',
  axis: '#999',
};

const GAP_LABELS = {
  silence: 'Tystnad',
  outage: 'Strömmen nere',
};

const EVENT_LABELS = {
  'metadata-change': 'Spårbyte',
  'format-change': 'Formatändring',
  clipping: 'Klippning',
  'loudness-drift': 'Nivåavvikelse',
  note: 'Anteckning',
  silence: 'Tystnad',
  outage: 'Strömmen nere',
};

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let logRunning = false;
let logEntries = [];
let logEvents = []; // point events + manual notes; gaps are derived, never stored
let logDirty = false;
let logPollTimer = null;
let logAbort = null;
let logSession = null;
let logShellBuilt = false;
let warningDismissed = false;

// ---------------------------------------------------------------------
// Pure helpers - this is what test/log.test.js covers
// ---------------------------------------------------------------------

// Silence stretches placed on the wall clock instead of on "somewhere in this poll".
// This is the whole reason the server returns recordedAt: an offset of 4.2 s into a
// recording is useless on its own, and exact once anchored.
function absoluteSilences(loudness, recordedAtMs, windowSec) {
  if (!loudness || !Array.isArray(loudness.silence) || typeof recordedAtMs !== 'number') return [];

  return loudness.silence
    .filter((s) => typeof s.startSec === 'number')
    .map((s) => {
      const openEnded = typeof s.endSec !== 'number';
      const endSec = openEnded ? windowSec : s.endSec;
      return {
        startMs: recordedAtMs + s.startSec * 1000,
        endMs: recordedAtMs + endSec * 1000,
        // Touching an edge is what makes a stitch to the neighbouring recording legal:
        // it means the stretch was cut off by the recording ending, not by audio.
        touchesStart: s.startSec <= EDGE_TOLERANCE_SEC,
        touchesEnd: openEnded || endSec >= windowSec - EDGE_TOLERANCE_SEC,
      };
    });
}

function sumSilenceSec(silences) {
  return (silences || []).reduce((total, s) => total + (s.endMs - s.startMs) / 1000, 0);
}

// "Now playing", wherever this stream kind keeps it: an ICY metadata block for
// Icecast/SHOUTcast (fetched by the server when asked with ?icy=1), or ID3 frames
// inside the segments for HLS/DASH.
function nowPlayingFromSample(sampleBody) {
  const icy = sampleBody?.station?.nowPlaying;
  if (icy) return String(icy);

  for (const frame of sampleBody?.id3?.frames || []) {
    const tags = frame.tags || {};
    const title = tags.StreamTitle || tags.title || tags.TITLE;
    if (title) return String(title);
  }
  return null;
}

function toLogEntry(sampleBody, { t, ok, status, attemptedAtMs, errorMessage = null } = {}) {
  const attempted = typeof attemptedAtMs === 'number' ? attemptedAtMs : Date.parse(t);
  // `status` is the richer classification; `ok` stays the primary boolean every
  // other function already checks. Callers that only ever knew about ok/failed
  // (existing tests included) get exactly the old behaviour for free.
  const resolvedStatus = status || (ok ? 'ok' : 'failed');

  if (resolvedStatus !== 'ok' || !sampleBody) {
    return {
      t,
      attemptedAtMs: attempted,
      recordedAtMs: null,
      ok: false,
      status: resolvedStatus,
      lufsI: null,
      truePeak: null,
      truePeakIsSilent: false,
      windowSec: null,
      silences: [],
      silenceSec: null,
      bitrateKbps: null,
      codec: null,
      sampleRate: null,
      channels: null,
      nowPlaying: null,
      errorMessage: errorMessage || (resolvedStatus === 'busy' ? 'Servern upptagen.' : 'Okänt fel'),
    };
  }

  const loudness = sampleBody.loudness || null;
  const streams = sampleBody.streams || {};
  const windowSec = typeof sampleBody.actualDurationSec === 'number' ? sampleBody.actualDurationSec : LOG_SAMPLE_SEC;
  // The server's own clock reading for when the recording started. Falling back to the
  // client's attempt time keeps old exports readable, at lower precision.
  const recordedAtMs = Date.parse(sampleBody.recordedAt);
  const anchorMs = Number.isNaN(recordedAtMs) ? attempted : recordedAtMs;
  const silences = absoluteSilences(loudness, anchorMs, windowSec);

  return {
    t: sampleBody.recordedAt || t,
    attemptedAtMs: attempted,
    recordedAtMs: anchorMs,
    ok: true,
    status: 'ok',
    lufsI: loudness && loudness.available ? loudness.integratedLufs : null,
    truePeak: loudness && loudness.available ? loudness.truePeakDbfs : null,
    truePeakIsSilent: Boolean(loudness && loudness.truePeakIsSilent),
    windowSec,
    silences,
    silenceSec: loudness ? sumSilenceSec(silences) : null,
    bitrateKbps: typeof sampleBody.measuredBitrateKbps === 'number' ? sampleBody.measuredBitrateKbps : null,
    codec: streams.codec || null,
    sampleRate: streams.sampleRate ?? null,
    channels: streams.channels ?? null,
    nowPlaying: nowPlayingFromSample(sampleBody),
    // A loudness pass that failed on its own is not a failed poll - the recording
    // worked, so bitrate and metadata are still true. It is a note, not an outage.
    errorMessage: sampleBody.errors?.loudness ? sampleBody.errors.loudness.message : null,
  };
}

// Silence stretches joined across recording boundaries into real, clock-anchored
// stretches of dead air.
//
// Two stretches are joined only when the first ran to the end of its recording, the
// second started at the beginning of the next one, and the unheard time between them
// is small. A gap *inside* one recording is never bridged - we heard audio there.
function mergeSilences(entries) {
  const runs = [];
  let current = null;

  for (const entry of entries) {
    if (!entry.ok) {
      current = null; // an outage is a different finding; it never extends a silence
      continue;
    }
    const stretches = entry.silences || [];
    if (!stretches.length) {
      current = null;
      continue;
    }

    for (const stretch of stretches) {
      const bridges =
        current &&
        current.lastEntry !== entry &&
        current.touchesEnd &&
        stretch.touchesStart &&
        stretch.startMs - current.endMs <= MAX_BRIDGE_MS;

      if (bridges) {
        current.endMs = stretch.endMs;
        current.touchesEnd = stretch.touchesEnd;
        current.pollCount += 1;
        current.lastEntry = entry;
      } else {
        current = {
          type: 'silence',
          startMs: stretch.startMs,
          endMs: stretch.endMs,
          touchesStart: stretch.touchesStart,
          touchesEnd: stretch.touchesEnd,
          pollCount: 1,
          lastEntry: entry,
        };
        runs.push(current);
      }
    }

    // Only a stretch that reached the end of this recording can continue into the next.
    if (current && !current.touchesEnd) current = null;
  }

  return runs.map(({ lastEntry, ...run }) => ({ ...run, durationSec: (run.endMs - run.startMs) / 1000 }));
}

// An outage is measured from the end of the last recording that worked to the start of
// the next one that did - the span during which nothing was heard at all. That is a
// real wall-clock window, unlike counting failed attempts.
function deriveOutages(entries, nowMs = Date.now()) {
  const runs = [];
  let run = null;

  entries.forEach((entry, index) => {
    if (!entry.ok) {
      if (run) {
        run.lastIndex = index;
        run.pollCount += 1;
      } else {
        run = { firstIndex: index, lastIndex: index, pollCount: 1 };
      }
      return;
    }
    if (run) {
      runs.push(run);
      run = null;
    }
  });
  if (run) runs.push(run);

  return runs.map((item) => {
    const before = entries[item.firstIndex - 1];
    const after = entries[item.lastIndex + 1];
    const startMs =
      before && before.ok && typeof before.recordedAtMs === 'number'
        ? before.recordedAtMs + (before.windowSec || LOG_SAMPLE_SEC) * 1000
        : entries[item.firstIndex].attemptedAtMs;
    const endMs = after && after.ok && typeof after.recordedAtMs === 'number' ? after.recordedAtMs : nowMs;

    return {
      type: 'outage',
      startMs,
      endMs,
      durationSec: Math.max(0, (endMs - startMs) / 1000),
      pollCount: item.pollCount,
      ongoing: !after,
    };
  });
}

// Drops polls the server refused to even attempt (a local capacity limit, not a
// fact about the stream) before anything derives silence or outage from them.
// Filtering the array - rather than teaching mergeSilences/deriveOutages a third
// branch - keeps their delicate boundary arithmetic untouched, and gets the right
// behaviour in both directions for free: consecutive real failures either side of
// a busy poll become one continuous outage (a busy cycle is not "the stream came
// back"), while a silence run does NOT bridge across the same gap, because a busy
// cycle typically spans close to the full interval - well past MAX_BRIDGE_MS - so
// there is no basis for assuming the stream stayed silent through it, unlike an
// outage, where "still down" is the safe assumption.
function reachableEntries(entries) {
  return (entries || []).filter((e) => e.status !== 'busy');
}

function allGaps(entries, nowMs = Date.now()) {
  return [...mergeSilences(entries), ...deriveOutages(entries, nowMs)].sort((a, b) => a.startMs - b.startMs);
}

function filterGaps(gaps, minSec) {
  const threshold = (typeof minSec === 'number' ? minSec : 20) - THRESHOLD_SLACK_SEC;
  return (gaps || []).filter((gap) => gap.type === 'outage' || gap.durationSec >= threshold);
}

// Events that are true of a single measurement, judged against the one before it.
function derivePointEvents(prev, entry, session = {}) {
  const events = [];
  if (!entry || !entry.ok) return events;

  if (entry.nowPlaying && (!prev || prev.nowPlaying !== entry.nowPlaying)) {
    events.push({ type: 'metadata-change', t: entry.t, text: entry.nowPlaying });
  }

  if (prev && prev.ok && entry.codec) {
    const changed =
      (prev.codec && prev.codec !== entry.codec) ||
      (prev.sampleRate && prev.sampleRate !== entry.sampleRate) ||
      (prev.channels && prev.channels !== entry.channels);
    if (changed) {
      events.push({
        type: 'format-change',
        t: entry.t,
        text: `${prev.codec} ${prev.sampleRate} Hz ${prev.channels} kanal(er) → ${entry.codec} ${entry.sampleRate} Hz ${entry.channels} kanal(er)`,
      });
    }
  }

  if (typeof entry.truePeak === 'number' && entry.truePeak > CLIPPING_DBTP) {
    events.push({ type: 'clipping', t: entry.t, text: `True peak ${entry.truePeak.toFixed(1)} dBTP` });
  }

  // Off unless the user turned it on: most streams sit outside any given target most
  // of the time, so this fires constantly and buries the events that matter.
  if (session.driftEnabled && typeof entry.lufsI === 'number') {
    const { targetLufs, toleranceLu } = session;
    if (typeof targetLufs === 'number' && typeof toleranceLu === 'number') {
      if (entry.lufsI < targetLufs - toleranceLu || entry.lufsI > targetLufs + toleranceLu) {
        events.push({
          type: 'loudness-drift',
          t: entry.t,
          text: `${entry.lufsI.toFixed(1)} LUFS (mål ${targetLufs} ±${toleranceLu} LU)`,
        });
      }
    }
  }

  return events;
}

function summarize(entries, gaps) {
  // A busy poll is not information about the stream - it counts neither as a
  // success nor a failure, so it is excluded from both sides of the success rate
  // rather than silently dragging it down. sessionSec below stays keyed off the
  // full, unfiltered entries: wall-clock logging time is true regardless of how
  // many cycles the server was too busy to actually run.
  const busyCount = entries.filter((e) => e.status === 'busy').length;
  const reachable = reachableEntries(entries);
  const total = reachable.length;
  const okEntries = reachable.filter((e) => e.ok);
  const lufsValues = okEntries.map((e) => e.lufsI).filter((v) => typeof v === 'number');
  const bitrates = okEntries.map((e) => e.bitrateKbps).filter((v) => typeof v === 'number');
  const longest = (type) =>
    (gaps || []).filter((g) => g.type === type).reduce((max, g) => Math.max(max, g.durationSec), 0);

  const first = entries[0] ? entries[0].attemptedAtMs : null;
  const last = entries[entries.length - 1] ? entries[entries.length - 1].attemptedAtMs : null;
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  return {
    pollCount: total,
    busyCount,
    okCount: okEntries.length,
    okPercent: total ? (okEntries.length / total) * 100 : null,
    sessionSec: first && last ? (last - first) / 1000 : 0,
    // Mean of per-window integrated readings, not a true integrated loudness for the
    // session - EBU R128 gating does not average like that. Labelled as such in the UI.
    meanLufs: mean(lufsValues),
    meanBitrateKbps: mean(bitrates),
    longestSilenceSec: longest('silence'),
    longestOutageSec: longest('outage'),
    silenceCount: (gaps || []).filter((g) => g.type === 'silence').length,
    outageCount: (gaps || []).filter((g) => g.type === 'outage').length,
    clippingPolls: okEntries.filter((e) => typeof e.truePeak === 'number' && e.truePeak > CLIPPING_DBTP).length,
  };
}

function shouldWarnLongSession(startedAt, now, thresholdHours = WARN_AFTER_HOURS) {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return false;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (Number.isNaN(nowMs)) return false;
  return nowMs - start >= thresholdHours * 3600 * 1000;
}

// Semicolon-separated with a dot decimal: opens straight into Swedish Excel without
// the import wizard, while staying machine-readable everywhere else.
function toCsv(entries) {
  const header = [
    'tid',
    'strom_ok',
    'status',
    'lufs_i',
    'true_peak_dbtp',
    'tystnad_sek',
    'fonster_sek',
    'bitrate_kbps',
    'codec',
    'samplingsfrekvens',
    'kanaler',
    'nu_spelas',
    'anmarkning',
  ];
  const quote = (text) => (/[";\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text);
  const cell = (value) => (value === null || value === undefined ? '' : quote(String(value)));

  // Anything the stream supplied goes through here instead. Excel and LibreOffice
  // execute a cell starting with =, +, - or @, and a station controls its own
  // StreamTitle - remote input landing in the user's spreadsheet. The apostrophe makes
  // it inert text. Numbers never take this path, so negatives are not mangled.
  const textCell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return quote(/^[=+\-@\t\r]/.test(text) ? "'" + text : text);
  };

  const rows = (entries || []).map((e) =>
    [
      cell(e.t),
      e.ok ? '1' : '0',
      // A raw 0/1 in strom_ok can't tell "server too busy to try" apart from "the
      // stream itself failed" - this column can, without anyone having to guess
      // from the free-text anmarkning column.
      cell(e.status || (e.ok ? 'ok' : 'failed')),
      cell(e.lufsI),
      cell(e.truePeak),
      cell(typeof e.silenceSec === 'number' ? e.silenceSec.toFixed(2) : null),
      cell(e.windowSec),
      cell(typeof e.bitrateKbps === 'number' ? e.bitrateKbps.toFixed(1) : null),
      textCell(e.codec),
      cell(e.sampleRate),
      cell(e.channels),
      textCell(e.nowPlaying),
      textCell(e.errorMessage),
    ].join(';')
  );
  return [header.join(';'), ...rows].join('\n');
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function fmtClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '–';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderSummary(stats) {
  const container = el('log-summary');
  if (!container) return;
  if (!stats.pollCount && !stats.busyCount) {
    container.innerHTML = '';
    return;
  }

  // Only mentioned when it actually happened - otherwise this is silent, invisible
  // data loss: without it, a run of busy-skipped cycles just makes the poll count
  // look smaller than the session length would suggest, with no explanation why.
  const busyNote = stats.busyCount ? ` (${fmtInt(stats.busyCount)} hoppade över p.g.a. serverbelastning)` : '';

  container.innerHTML = `
    <section>
      <h2>Sammanfattning</h2>
      <dl>
        <dt>Loggat sedan</dt><dd>${fmtDuration(stats.sessionSec)}${logRunning ? '' : ' (stoppad)'}</dd>
        <dt>Mätningar</dt><dd>${fmtInt(stats.pollCount)} st, ${fmtNumber(stats.okPercent, 0)} % lyckade${busyNote}</dd>
        ${withHint('dt', 'Medel-LUFS', 'medel-lufs')}<dd>${
          stats.meanLufs === null ? '–' : fmtNumber(stats.meanLufs) + ' LUFS'
        }</dd>
        <dt>Medelbitrate</dt><dd>${
          stats.meanBitrateKbps === null ? '–' : fmtNumber(stats.meanBitrateKbps) + ' kbit/s'
        }</dd>
        ${withHint('dt', 'Längsta tystnad', 'verklig-tystnad')}<dd>${
          stats.longestSilenceSec ? fmtDuration(stats.longestSilenceSec) + ` (${stats.silenceCount} st totalt)` : 'ingen'
        }</dd>
        ${withHint('dt', 'Längsta avbrott', 'strommen-nere')}<dd>${
          stats.longestOutageSec ? fmtDuration(stats.longestOutageSec) + ` (${stats.outageCount} st totalt)` : 'inga'
        }</dd>
        <dt>Mätningar över ${fmtNumber(CLIPPING_DBTP)} dBTP</dt><dd>${fmtInt(stats.clippingPolls)}</dd>
      </dl>
    </section>`;
}

function renderSilenceList(visible) {
  const container = el('log-silence-table');
  if (!container) return;

  const listed = visible;
  if (!listed.length) {
    container.innerHTML = '';
    return;
  }

  const rows = listed
    .map((gap) => {
      const cls = gap.type === 'outage' ? ' class="error"' : '';
      return `<tr>
        <td${cls}>${esc(GAP_LABELS[gap.type] || gap.type)}</td>
        <td>${fmtClock(gap.startMs)}</td>
        <td>${gap.ongoing ? 'pågår' : fmtClock(gap.endMs)}</td>
        <td>${fmtDuration(gap.durationSec)}</td>
      </tr>`;
    })
    .reverse()
    .join('');

  container.innerHTML = `
    <section>
      ${withHint('h2', 'Tystnad och avbrott', 'tystnad-avbrott')}
      <table>
        <thead><tr>
          ${withHint('th', 'Typ', 'tystnad-typ')}
          ${withHint('th', 'Start', 'tystnad-start')}
          ${withHint('th', 'Slut', 'tystnad-slut')}
          ${withHint('th', 'Längd', 'tystnad-langd')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderEvents(gaps) {
  const container = el('log-events');
  if (!container) return;

  const gapEvents = (gaps || []).map((gap) => ({
    type: gap.type,
    t: new Date(gap.startMs).toISOString(),
    text: fmtDuration(gap.durationSec),
  }));
  const all = [...logEvents, ...gapEvents].sort((a, b) => Date.parse(b.t) - Date.parse(a.t));

  if (!all.length) {
    container.innerHTML = '';
    return;
  }

  const items = all
    .slice(0, MAX_TABLE_ROWS)
    .map(
      (event) =>
        `<li><span class="event-dot event-${esc(event.type)}"></span>
          <span class="mono">${fmtClock(event.t)}</span>
          <strong>${esc(EVENT_LABELS[event.type] || event.type)}</strong> ${esc(event.text)}</li>`
    )
    .join('');

  container.innerHTML = `<section><h2>Händelser</h2><ul id="event-feed">${items}</ul></section>`;
}

function renderTable() {
  const container = el('log-table');
  if (!container) return;
  if (!logEntries.length) {
    container.innerHTML = '';
    return;
  }

  const rows = logEntries
    .slice(-MAX_TABLE_ROWS)
    .reverse()
    .map(
      (e) => `<tr>
        <td>${fmtClock(e.t)}</td>
        <td>${e.lufsI === null ? '–' : fmtNumber(e.lufsI)}</td>
        <td>${e.truePeakIsSilent ? '−∞' : e.truePeak === null ? '–' : fmtNumber(e.truePeak)}</td>
        <td>${e.silenceSec === null ? '–' : fmtNumber(e.silenceSec)}</td>
        <td>${e.bitrateKbps === null ? '–' : fmtNumber(e.bitrateKbps)}</td>
        <td>${esc(e.nowPlaying) || '–'}</td>
        <td${e.status === 'busy' ? ' class="busy"' : e.ok ? '' : ' class="error"'}>${
          // The column reports the stream, not the measurement: a failed loudness pass
          // still means the stream delivered audio, so it stays OK - but silently so
          // would leave the empty LUFS and peak cells on this row unexplained. "Busy"
          // is neither OK nor a stream failure - the server never even checked - so it
          // gets its own colour, distinct from the red used for a genuine stream error.
          e.status === 'busy' ? esc(e.errorMessage) : e.ok ? (e.errorMessage ? 'OK (nivå ej mätt)' : 'OK') : esc(e.errorMessage)
        }</td>
      </tr>`
    )
    .join('');

  container.innerHTML = `
    <section>
      <h2>Mätningar</h2>
      <p class="note">Senaste ${Math.min(logEntries.length, MAX_TABLE_ROWS)} av ${fmtInt(
        logEntries.length
      )}. Exporten innehåller alla.</p>
      <table>
        <thead><tr>
          <th>Tid</th>
          ${withHint('th', 'LUFS', 'integrated-lufs')}
          ${withHint('th', 'True peak', 'true-peak')}
          <th>Tystnad (s)</th>
          <th>kbit/s</th>
          <th>Nu spelas</th>
          ${withHint('th', 'Status ström', 'status-strom')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

// Hand-rolled canvas, no charting library. The whole chart is redrawn per new point -
// at a few hundred points that is far cheaper than getting an incremental scheme right.
function drawChart(gaps) {
  const canvas = el('log-chart');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = 200;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 44, right: 10, top: 12, bottom: 22 };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  const values = [];
  for (const e of logEntries) {
    if (typeof e.lufsI === 'number') values.push(e.lufsI);
    if (typeof e.truePeak === 'number') values.push(e.truePeak);
  }
  let min = values.length ? Math.min(...values) : -40;
  let max = values.length ? Math.max(...values) : 0;
  if (max - min < 6) {
    const mid = (max + min) / 2;
    min = mid - 3;
    max = mid + 3;
  }
  min = Math.max(-70, min - 2);
  max = Math.min(6, max + 2);

  const n = logEntries.length;
  const xAt = (i) => (n <= 1 ? pad.left + plotW / 2 : pad.left + (i / (n - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - ((v - min) / (max - min)) * plotH;

  // Bands first, so the lines draw over them. A gap is a wall-clock span, so it is
  // mapped back onto whichever measurements it overlaps.
  for (const gap of gaps || []) {
    let from = -1;
    let to = -1;
    logEntries.forEach((entry, i) => {
      const startMs = typeof entry.recordedAtMs === 'number' ? entry.recordedAtMs : entry.attemptedAtMs;
      const endMs = startMs + (entry.windowSec || LOG_SAMPLE_SEC) * 1000;
      if (endMs >= gap.startMs && startMs <= gap.endMs) {
        if (from === -1) from = i;
        to = i;
      }
    });
    if (from === -1) continue;
    const x1 = xAt(from);
    const x2 = xAt(to);
    ctx.fillStyle = gap.type === 'outage' ? CHART_COLORS.outage : CHART_COLORS.silence;
    ctx.fillRect(x1, pad.top, Math.max(2, x2 - x1), plotH);
  }

  ctx.strokeStyle = CHART_COLORS.grid;
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

  ctx.strokeStyle = CHART_COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(pad.left + 0.5, pad.top);
  ctx.lineTo(pad.left + 0.5, pad.top + plotH);
  ctx.stroke();

  // Iterating by index, not by value, keeps holes in place: a missing reading leaves a
  // gap in the line instead of shifting everything after it to the left.
  const drawSeries = (pick, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    logEntries.forEach((entry, i) => {
      const v = pick(entry);
      if (typeof v !== 'number') {
        pen = false;
        return;
      }
      const x = xAt(i);
      const y = yAt(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    });
    ctx.stroke();
  };

  drawSeries((e) => e.lufsI, CHART_COLORS.lufs);
  drawSeries((e) => e.truePeak, CHART_COLORS.truePeak);

  if (n) {
    ctx.fillStyle = '#666';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtClock(logEntries[0].t), pad.left, pad.top + plotH + 6);
    if (n > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(fmtClock(logEntries[n - 1].t), pad.left + plotW, pad.top + plotH + 6);
    }
  }

  // Classes, not inline style: the page runs under a CSP with styleSrc 'self' and no
  // 'unsafe-inline', so a style="" attribute is dropped and the legend would render as
  // four blank squares. The colours are duplicated in style.css.
  const legend = el('chart-legend');
  if (legend) {
    legend.innerHTML = n
      ? `<span class="swatch swatch-lufs"></span> Integrerad ljudnivå (LUFS)
         <span class="swatch swatch-truepeak"></span> True peak (dBTP)
         <span class="swatch swatch-silence"></span> Tystnad
         <span class="swatch swatch-outage"></span> Strömmen nere`
      : '';
  }
}

function renderWarningBanner() {
  const banner = el('log-warning');
  if (!banner) return;
  const show = !warningDismissed && logSession && shouldWarnLongSession(logSession.startedAt, Date.now());
  banner.hidden = !show;
  if (show) {
    banner.innerHTML = `<p class="note error">Du har loggat i över ${WARN_AFTER_HOURS} timmar (${fmtInt(
      logEntries.length
    )} mätningar). Överväg att exportera och rensa — allt ligger i den här fliken.
      <button type="button" id="log-warning-dismiss">Stäng</button></p>`;
    el('log-warning-dismiss')?.addEventListener('click', () => {
      warningDismissed = true;
      renderWarningBanner();
    });
  }
}

function updateButtons() {
  const set = (id, disabled) => {
    const node = el(id);
    if (node) node.disabled = disabled;
  };
  set('log-stop-btn', !logRunning);
  set('log-note-btn', !logEntries.length);
  set('log-export-json-btn', !logEntries.length);
  set('log-export-csv-btn', !logEntries.length);
  set('log-clear-btn', !logEntries.length);
}

function readSilenceMin() {
  const raw = Number(el('log-silence-min')?.value);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

function renderAll() {
  // A busy poll (server too busy to even attempt the recording) is excluded before
  // gaps are derived at all - see reachableEntries(). A short silence is filtered
  // out here, once, so it cannot appear anywhere - not in the summary stats, not as
  // a shaded band on the chart, not in the event feed, and not in the dedicated
  // table. An outage is unaffected: it is a different finding (the stream itself
  // failed) and matters regardless of how brief it was.
  const visible = filterGaps(allGaps(reachableEntries(logEntries)), readSilenceMin());
  renderSummary(summarize(logEntries, visible));
  drawChart(visible);
  renderSilenceList(visible);
  renderEvents(visible);
  renderTable();
  renderWarningBanner();
  updateButtons();
}

// ---------------------------------------------------------------------
// Persistence - a mirror, never an autoloader
// ---------------------------------------------------------------------

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), session: logSession, entries: logEntries, events: logEvents })
    );
  } catch {
    // Quota exceeded or storage disabled. The in-memory log still works and saying so
    // on every append would be noise - export is the real safety net.
  }
}

function clearPersisted() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

// ---------------------------------------------------------------------
// The log view, rendered into the shared results area
// ---------------------------------------------------------------------

// Built once per session, not per cycle: re-rendering the controls every 15 seconds
// would yank focus out of the number fields while the user is typing in them.
function buildShell(resultsEl) {
  resultsEl.innerHTML = `
    <div id="log-shell">
      <div id="log-controls">
        <button type="button" id="log-stop-btn">Stoppa loggning</button>
        <label for="log-silence-min">Logga tystnad från
          <input type="number" id="log-silence-min" value="20" min="5" max="3600" step="5" /> s
        </label>
        <label for="log-drift-toggle">
          <input type="checkbox" id="log-drift-toggle" /> Logga nivåavvikelse
        </label>
        <span id="log-drift-fields" hidden>
          mål <input type="number" id="log-target-lufs" value="-16" min="-40" max="0" step="1" /> LUFS
          ± <input type="number" id="log-tolerance" value="2" min="0" max="20" step="0.5" /> LU
        </span>
        <span id="log-actions">
          <button type="button" id="log-note-btn">Anteckning</button>
          <button type="button" id="log-export-json-btn">Exportera JSON</button>
          <button type="button" id="log-export-csv-btn">Exportera CSV</button>
          <button type="button" id="log-clear-btn">Rensa</button>
        </span>
      </div>
      <p id="log-drift-help" class="note" hidden></p>
      <div id="log-warning" hidden></div>
      <p id="log-error"></p>
      <div id="log-summary"></div>
      <section id="sec-log-chart">
        <h2>Ljudnivå över tid</h2>
        <canvas id="log-chart" height="200"></canvas>
        <p class="note" id="chart-legend"></p>
      </section>
      <div id="log-silence-table"></div>
      <div id="log-events"></div>
      <div id="log-table"></div>
    </div>`;

  const help = el('log-drift-help');
  if (help) {
    // Written out rather than hidden in a tooltip because the checkbox is meaningless
    // without it - including what LU is, which is the part people trip on.
    help.innerHTML =
      'Flaggar varje mätning som ligger utanför ett mål du sätter, så att du ser om kanalen driver i ljudnivå över tid. ' +
      'Målet anges i <strong>LUFS</strong> — den absoluta ljudnivån. Toleransen anges i <strong>LU</strong> (Loudness Units), ' +
      'som är samma skala men används för <em>skillnader</em>: 1 LU = 1 dB. Mål −16 LUFS ±2 LU betyder alltså att allt mellan ' +
      '−18 och −14 LUFS räknas som normalt. Riktvärden: −23 LUFS för broadcast enligt EBU R128, −14 till −16 LUFS för ' +
      'streamingtjänster. Av som standard, eftersom de flesta strömmar ligger utanför ett godtyckligt mål större delen av tiden.';
  }

  el('log-stop-btn')?.addEventListener('click', () => stopStreamLog());
  el('log-silence-min')?.addEventListener('change', renderAll);

  const toggle = el('log-drift-toggle');
  toggle?.addEventListener('change', () => {
    const fields = el('log-drift-fields');
    if (fields) fields.hidden = !toggle.checked;
    if (help) help.hidden = !toggle.checked;
    if (logSession) logSession.driftEnabled = toggle.checked;
    readDriftSettings();
  });
  el('log-target-lufs')?.addEventListener('change', readDriftSettings);
  el('log-tolerance')?.addEventListener('change', readDriftSettings);

  el('log-note-btn')?.addEventListener('click', () => {
    const text = window.prompt('Anteckning:');
    if (!text) return;
    logEvents.push({ type: 'note', t: new Date().toISOString(), text });
    logDirty = true;
    persist();
    renderAll();
  });

  el('log-export-json-btn')?.addEventListener('click', () => {
    download(
      `stromlogg-${exportStamp()}.json`,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          session: logSession,
          sampleSeconds: LOG_SAMPLE_SEC,
          // The full record, busy polls included, for transparency - but the
          // derived gaps match what the page itself shows, which excludes them.
          entries: logEntries,
          events: logEvents,
          gaps: allGaps(reachableEntries(logEntries)),
        },
        null,
        2
      ),
      'application/json'
    );
  });

  el('log-export-csv-btn')?.addEventListener('click', () => {
    download(`stromlogg-${exportStamp()}.csv`, toCsv(logEntries), 'text/csv;charset=utf-8');
  });

  el('log-clear-btn')?.addEventListener('click', () => {
    if (logDirty && !window.confirm('Loggen är inte exporterad. Rensa ändå?')) return;
    logEntries = [];
    logEvents = [];
    logDirty = false;
    warningDismissed = false;
    clearPersisted();
    renderAll();
  });

  logShellBuilt = true;
}

function readDriftSettings() {
  if (!logSession) return;
  const num = (id, fallback) => {
    const raw = Number(el(id)?.value);
    return Number.isFinite(raw) ? raw : fallback;
  };
  logSession.driftEnabled = Boolean(el('log-drift-toggle')?.checked);
  logSession.targetLufs = num('log-target-lufs', -16);
  logSession.toleranceLu = num('log-tolerance', 2);
}

function showLogError(message) {
  const node = el('log-error');
  if (node) node.innerHTML = message ? `<span class="error">${esc(message)}</span>` : '';
}

// ---------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------

// The last entry that actually measured something, skipping over any trailing
// busy/failed polls. Used as "prev" for derivePointEvents: comparing against a
// failed poll's always-null nowPlaying/codec would otherwise fire a spurious
// metadata-change/format-change event on recovery even when nothing changed -
// a pre-existing bug for real outages, not just the new busy case, fixed here
// because both need the same answer to "what did we last actually hear".
function lastMeasuredEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].ok) return entries[i];
  }
  return null;
}

function appendEntry(entry) {
  const prev = lastMeasuredEntry(logEntries);
  logEntries.push(entry);
  logEvents.push(...derivePointEvents(prev, entry, logSession || {}));
  logDirty = true;
  persist();
  renderAll();
}

async function pollOnce() {
  const attemptedAtMs = Date.now();
  const t = new Date(attemptedAtMs).toISOString();
  logAbort = new AbortController();

  // ?icy=1 only where it can pay off: Icecast/SHOUTcast keep "now playing" in an
  // in-stream metadata block that the recorded audio does not carry.
  const icyParam = logSession.streamKind === 'icecast' ? '&icy=1' : '';
  const url = `/api/sample?url=${encodeURIComponent(logSession.sampleUrl)}&secs=${LOG_SAMPLE_SEC}${icyParam}`;

  try {
    const res = await fetch(url, { signal: logAbort.signal });
    const body = await res.json();
    if (res.ok) return toLogEntry(body, { t, ok: true, attemptedAtMs });
    // A capacity rejection is a fact about our own server load, not the stream -
    // it must not be bookkept as an outage (see reachableEntries()).
    const status = body?.error?.code === 'BUSY' ? 'busy' : 'failed';
    return toLogEntry(null, {
      t,
      ok: false,
      status,
      attemptedAtMs,
      errorMessage: body.error?.message || `Servern svarade ${res.status}.`,
    });
  } catch (err) {
    // Aborting is us stopping, not the stream failing - it must not become a data point.
    if (err.name === 'AbortError') return null;
    return toLogEntry(null, { t, ok: false, attemptedAtMs, errorMessage: 'Kunde inte nå servern: ' + err.message });
  } finally {
    logAbort = null;
  }
}

// Recursive setTimeout, not setInterval: setInterval would start the next recording
// while the previous one is still running. The wait is what is left of the interval
// after the cycle - which is normally nothing, so the next recording starts right
// away and the recordings sit back to back.
function scheduleNext(elapsedMs) {
  if (!logRunning) return;
  logPollTimer = setTimeout(runCycle, Math.max(0, LOG_INTERVAL_SEC * 1000 - elapsedMs));
}

async function runCycle() {
  if (!logRunning) return;
  const startedMs = Date.now();
  try {
    const entry = await pollOnce();
    if (entry) appendEntry(entry);
  } finally {
    scheduleNext(Date.now() - startedMs);
  }
}

// ---------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  logDirty = false;
}

function exportStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ---------------------------------------------------------------------
// Entry points used by app.js
// ---------------------------------------------------------------------

// Starting always starts fresh. There is no pause: a log with a hole in the middle
// would show as one continuous timeline and quietly misrepresent what happened.
async function startStreamLog(targetUrl, { statusEl, resultsEl } = {}) {
  stopStreamLog();

  logEntries = [];
  logEvents = [];
  logDirty = false;
  warningDismissed = false;
  logShellBuilt = false;
  clearPersisted();

  const results = resultsEl || el('results');
  if (!results) return;

  if (statusEl) statusEl.textContent = 'Kontrollerar strömmen…';
  results.innerHTML = '';

  // One /api/analyze up front: it resolves which URL to actually record from (an HLS
  // master is not a media playlist), tells us whether this is Icecast, and fails
  // loudly on a bad URL before a loop starts hammering it.
  let data;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });
    data = await res.json();
    if (!res.ok) {
      if (statusEl) statusEl.textContent = '';
      results.innerHTML = `<section><h2 class="error">Fel</h2><p class="error">${esc(
        data.error?.message || 'Analysen misslyckades.'
      )}</p></section>`;
      return;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '';
    results.innerHTML = `<section><h2 class="error">Fel</h2><p class="error">${esc(
      'Kunde inte nå servern: ' + err.message
    )}</p></section>`;
    return;
  }

  logSession = {
    sourceUrl: targetUrl,
    sampleUrl: data.sampleUrl || data.variants?.chosenVariantUrl || targetUrl,
    streamKind: data.streamKind || 'hls',
    startedAt: new Date().toISOString(),
    sampleSeconds: LOG_SAMPLE_SEC,
    intervalSeconds: LOG_INTERVAL_SEC,
  };

  buildShell(results);
  readDriftSettings();
  if (statusEl) statusEl.textContent = '';

  logRunning = true;
  renderAll();
  runCycle();
}

function stopStreamLog() {
  if (!logRunning && !logPollTimer) return;
  logRunning = false;
  if (logPollTimer) clearTimeout(logPollTimer);
  logPollTimer = null;
  if (logAbort) logAbort.abort();
  if (logShellBuilt) renderAll();
}

function isStreamLogRunning() {
  return logRunning;
}

if (typeof window !== 'undefined') {
  window.addEventListener?.('beforeunload', (event) => {
    if (!logEntries.length || !logDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
