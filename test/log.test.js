// log.test.js
// The pure half of public/log.js: turning an /api/sample response into a log entry,
// placing silence on the wall clock, stitching it across recording boundaries, and
// getting the export formats right.
//
// The stitching is the part that carries real weight. The log hears the stream in
// 15-second recordings, so a stretch of dead air is nearly always split across two of
// them; if the halves are not rejoined, a 20-second silence is reported as two 10-second
// ones - or, at the old thresholds, not at all.
//
// Loaded in a vm like frontend.test.js, with getElementById returning null so the page
// wiring never runs. Note: assert.deepEqual compares prototypes, and arrays built
// inside the vm have a different Array.prototype than this realm - so assertions here
// check fields and lengths rather than whole objects.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function loadLog() {
  const context = vm.createContext({
    document: { getElementById: () => null },
    window: { addEventListener() {} },
    URL,
    URLSearchParams,
    setTimeout,
    console,
  });

  for (const file of ['terms.js', 'shared.js', 'log.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context, { filename: file });
  }
  return context;
}

const log = loadLog();

// Wall clock anchor for the fixtures: recordings start at T+0, T+15, T+30...
const T0 = Date.UTC(2026, 8, 8, 10, 0, 0);
const at = (sec) => T0 + sec * 1000;
const iso = (sec) => new Date(at(sec)).toISOString();

// One /api/sample body, recorded at `startSec`, with the given silence stretches
// expressed as offsets into the recording.
function sampleAt(startSec, silence = [], extra = {}) {
  return {
    recordedAt: iso(startSec),
    actualDurationSec: 15,
    measuredBitrateKbps: 128.4,
    streams: { codec: 'aac', sampleRate: 44100, channels: 2 },
    loudness: {
      available: true,
      integratedLufs: -15.2,
      truePeakDbfs: -1.4,
      truePeakIsSilent: false,
      silence,
      noiseThresholdDb: -50,
      minSilenceDurationSec: 0.5,
    },
    id3: { available: false, frames: [] },
    errors: {},
    ...extra,
  };
}

const entryAt = (startSec, silence = [], extra = {}) =>
  log.toLogEntry(sampleAt(startSec, silence, extra), { t: iso(startSec), ok: true, attemptedAtMs: at(startSec) });

const failedAt = (startSec, message = 'Kunde inte ansluta.') =>
  log.toLogEntry(null, { t: iso(startSec), ok: false, attemptedAtMs: at(startSec), errorMessage: message });

// A capacity rejection (503 BUSY) - a fact about our own server load, not the stream.
const busyAt = (startSec, message = 'Servern kör redan så många analyser den tar samtidigt.') =>
  log.toLogEntry(null, { t: iso(startSec), ok: false, status: 'busy', attemptedAtMs: at(startSec), errorMessage: message });

// ---------------------------------------------------------------------------
// Placing silence on the clock
// ---------------------------------------------------------------------------

test('absoluteSilences turns an offset into a recording into a wall-clock span', () => {
  const [stretch] = log.absoluteSilences({ silence: [{ startSec: 4, endSec: 9, durationSec: 5 }] }, at(0), 15);

  assert.equal(stretch.startMs, at(4));
  assert.equal(stretch.endMs, at(9));
  // Well inside the recording on both sides, so it cannot continue into a neighbour.
  assert.equal(stretch.touchesStart, false);
  assert.equal(stretch.touchesEnd, false);
});

test('absoluteSilences marks the edges that make a stitch legal', () => {
  const stretches = log.absoluteSilences(
    { silence: [{ startSec: 0, endSec: 3 }, { startSec: 12, endSec: 15 }] },
    at(0),
    15
  );

  assert.equal(stretches[0].touchesStart, true);
  assert.equal(stretches[0].touchesEnd, false);
  assert.equal(stretches[1].touchesStart, false);
  assert.equal(stretches[1].touchesEnd, true);
});

test('absoluteSilences treats an unfinished stretch as running to the end of the recording', () => {
  // silencedetect reports no end when the recording stopped mid-silence. That is
  // exactly the case that has to stitch onto the next recording.
  const [stretch] = log.absoluteSilences({ silence: [{ startSec: 11, endSec: null, durationSec: null }] }, at(0), 15);

  assert.equal(stretch.endMs, at(15));
  assert.equal(stretch.touchesEnd, true);
});

// ---------------------------------------------------------------------------
// toLogEntry
// ---------------------------------------------------------------------------

test('toLogEntry anchors the entry on the server clock, not the request time', () => {
  // The client fires the request, the server connects and only then starts recording.
  // Using the request time would smear every silence by the connect delay.
  const entry = log.toLogEntry(sampleAt(30, [{ startSec: 2, endSec: 6, durationSec: 4 }]), {
    t: iso(28),
    ok: true,
    attemptedAtMs: at(28),
  });

  assert.equal(entry.recordedAtMs, at(30));
  assert.equal(entry.silences[0].startMs, at(32));
  assert.equal(entry.silenceSec, 4);
});

test('toLogEntry records a failed poll without inventing measurements', () => {
  const entry = failedAt(15, 'Servern svarade 502.');

  assert.equal(entry.ok, false);
  assert.equal(entry.lufsI, null);
  assert.equal(entry.silenceSec, null);
  assert.equal(entry.silences.length, 0);
  assert.equal(entry.errorMessage, 'Servern svarade 502.');
});

test('toLogEntry prefers the ICY title, which is where radio actually keeps it', () => {
  // The recorded audio is re-muxed and carries no ICY block, so for Icecast this is
  // the only source - the reason /api/sample takes ?icy=1 at all.
  const entry = entryAt(0, [], {
    station: { nowPlaying: 'Artist - Låt', icyMetadataSupported: true },
    id3: { available: true, frames: [{ tags: { StreamTitle: 'Gammal ID3-titel' } }] },
  });

  assert.equal(entry.nowPlaying, 'Artist - Låt');
});

test('toLogEntry falls back to ID3 frames when there is no ICY block', () => {
  const entry = entryAt(0, [], { id3: { available: true, frames: [{ tags: { StreamTitle: 'HLS - Titel' } }] } });
  assert.equal(entry.nowPlaying, 'HLS - Titel');

  assert.equal(entryAt(0).nowPlaying, null);
});

test('toLogEntry marks a capacity rejection as busy, not failed', () => {
  const entry = busyAt(0, 'Servern kör redan så många analyser den tar samtidigt.');

  assert.equal(entry.ok, false);
  assert.equal(entry.status, 'busy');
  assert.equal(entry.errorMessage, 'Servern kör redan så många analyser den tar samtidigt.');
});

test('toLogEntry stays backward compatible when only ok is given', () => {
  // Older callers (and the existing entryAt/failedAt fixtures above) never pass
  // `status` - the field must still resolve correctly from `ok` alone.
  assert.equal(entryAt(0).status, 'ok');
  assert.equal(failedAt(0).status, 'failed');
});

// ---------------------------------------------------------------------------
// reachableEntries - what feeds mergeSilences/deriveOutages once a busy poll exists
// ---------------------------------------------------------------------------

test('reachableEntries drops only busy polls, keeping ok and genuinely failed ones', () => {
  const entries = [entryAt(0), busyAt(15), failedAt(30), entryAt(45)];
  const reachable = log.reachableEntries(entries);

  assert.equal(reachable.length, 3);
  assert.equal(reachable[0].status, 'ok');
  assert.equal(reachable[1].status, 'failed');
  assert.equal(reachable[2].status, 'ok');
});

test('an isolated busy poll must not read as a stream outage on its own', () => {
  // The bug filtering exists to fix: deriveOutages groups any consecutive run of
  // `!entry.ok` into an outage, with no idea *why* an entry failed - so a single
  // busy poll between two healthy ones would otherwise become a full 15 s
  // "strömmen nere" gap, exactly the misclassification that must never happen.
  const entries = [entryAt(0), busyAt(15), entryAt(30)];

  // Demonstrated directly: unfiltered, this is misread as a real outage...
  assert.equal(log.deriveOutages(entries, at(45)).length, 1);
  // ...filtered first, there is no outage at all - both neighbours were fine, the
  // server just never checked in between.
  assert.equal(log.deriveOutages(log.reachableEntries(entries)).length, 0);
});

test('a busy poll in the middle of a real outage does not inflate its poll count', () => {
  // [ok, failed, busy, failed, ok] still reads as one continuous outage even
  // unfiltered (any !entry.ok breaks/extends the same run) - but its pollCount
  // would wrongly include the busy poll as if it were a real failed attempt.
  // Filtering keeps the span (same start/end either way) but reports only the
  // two actual failures.
  const entries = [entryAt(0), failedAt(15), busyAt(30), failedAt(45), entryAt(60)];
  const outages = log.deriveOutages(log.reachableEntries(entries), at(75));

  assert.equal(outages.length, 1);
  assert.equal(outages[0].pollCount, 2);
  assert.equal(outages[0].startMs, at(15));
  assert.equal(outages[0].endMs, at(60));
});

test('a busy poll does not bridge a silence run across the gap it leaves', () => {
  // mergeSilences already refuses to bridge across any `!entry.ok` entry, busy
  // included, so this holds regardless of filtering - confirming the fix does not
  // accidentally change already-correct behaviour on the silence side.
  const entries = [
    entryAt(0, [{ startSec: 8, endSec: 15, durationSec: 7 }]),
    busyAt(15),
    entryAt(30, [{ startSec: 0, endSec: 13, durationSec: 13 }]),
  ];

  assert.equal(log.mergeSilences(entries).length, 2);
  assert.equal(log.mergeSilences(log.reachableEntries(entries)).length, 2);
});

// ---------------------------------------------------------------------------
// mergeSilences - the requirement: 20 s must be detectable, with real clock times
// ---------------------------------------------------------------------------

test('mergeSilences rejoins a 20 s silence split across two recordings', () => {
  // Dead air from T+8 to T+28. Recording 1 [0,15] hears the first 7 s of it, recording
  // 2 [15,30] hears the remaining 13 s. Neither half is 20 s; the truth is.
  const entries = [
    entryAt(0, [{ startSec: 8, endSec: 15, durationSec: 7 }]),
    entryAt(15, [{ startSec: 0, endSec: 13, durationSec: 13 }]),
  ];
  const merged = log.mergeSilences(entries);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].durationSec, 20);
  assert.equal(merged[0].startMs, at(8));
  assert.equal(merged[0].endMs, at(28));
  assert.equal(merged[0].pollCount, 2);
});

test('mergeSilences bridges the unheard gap between two recordings', () => {
  // Reconnecting takes a moment, so recording 2 starts at T+17 rather than T+15. Both
  // sides of that 2 s hole were silent, so counting it as silent is the honest reading
  // - and not doing so would under-report every stretch that crosses a boundary.
  const entries = [
    entryAt(0, [{ startSec: 8, endSec: 15, durationSec: 7 }]),
    entryAt(17, [{ startSec: 0, endSec: 13, durationSec: 13 }]),
  ];
  const merged = log.mergeSilences(entries);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].durationSec, 22);
});

test('mergeSilences spans three recordings for a long stretch of dead air', () => {
  const entries = [
    entryAt(0, [{ startSec: 10, endSec: 15, durationSec: 5 }]),
    entryAt(15, [{ startSec: 0, endSec: 15, durationSec: 15 }]),
    entryAt(30, [{ startSec: 0, endSec: 9, durationSec: 9 }]),
  ];
  const merged = log.mergeSilences(entries);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].durationSec, 29);
  assert.equal(merged[0].pollCount, 3);
});

test('mergeSilences never bridges a gap inside one recording', () => {
  // Two silences 7 seconds apart in the same recording means we heard audio between
  // them. Merging those would fabricate dead air out of a normal pause.
  const entries = [
    entryAt(0, [
      { startSec: 0, endSec: 3, durationSec: 3 },
      { startSec: 10, endSec: 15, durationSec: 5 },
    ]),
  ];
  const merged = log.mergeSilences(entries);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].durationSec, 3);
  assert.equal(merged[1].durationSec, 5);
});

test('mergeSilences does not join stretches that both sit mid-recording', () => {
  // Neither touches an edge, so there is no reason to think they are the same stretch
  // - we heard audio at the end of the first recording and at the start of the second.
  const entries = [
    entryAt(0, [{ startSec: 4, endSec: 9, durationSec: 5 }]),
    entryAt(15, [{ startSec: 4, endSec: 9, durationSec: 5 }]),
  ];

  assert.equal(log.mergeSilences(entries).length, 2);
});

test('mergeSilences stops a run at a failed poll', () => {
  // Silence and outage are different findings. Running them together would report one
  // long "silence" over a period when the stream was in fact unreachable.
  const entries = [
    entryAt(0, [{ startSec: 8, endSec: 15, durationSec: 7 }]),
    failedAt(15),
    entryAt(30, [{ startSec: 0, endSec: 13, durationSec: 13 }]),
  ];
  const merged = log.mergeSilences(entries);

  assert.equal(merged.length, 2);
});

test('mergeSilences returns nothing for a healthy log', () => {
  assert.equal(log.mergeSilences([entryAt(0), entryAt(15), entryAt(30)]).length, 0);
  assert.equal(log.mergeSilences([]).length, 0);
});

// ---------------------------------------------------------------------------
// deriveOutages
// ---------------------------------------------------------------------------

test('deriveOutages measures from the end of the last good recording to the start of the next', () => {
  // That span is what nobody heard. Counting failed attempts instead would report an
  // outage shorter than the hole it left.
  const entries = [entryAt(0), failedAt(15), failedAt(30), entryAt(45)];
  const outages = log.deriveOutages(entries, at(60));

  assert.equal(outages.length, 1);
  assert.equal(outages[0].startMs, at(15)); // recording 1 ended here
  assert.equal(outages[0].endMs, at(45)); // recording 4 began here
  assert.equal(outages[0].durationSec, 30);
  assert.equal(outages[0].pollCount, 2);
  assert.equal(outages[0].ongoing, false);
});

test('deriveOutages leaves an unfinished outage open, running to now', () => {
  const entries = [entryAt(0), failedAt(15)];
  const outages = log.deriveOutages(entries, at(40));

  assert.equal(outages[0].ongoing, true);
  assert.equal(outages[0].durationSec, 25);
});

test('deriveOutages returns nothing when every poll worked', () => {
  assert.equal(log.deriveOutages([entryAt(0), entryAt(15)], at(30)).length, 0);
});

// ---------------------------------------------------------------------------
// filterGaps
// ---------------------------------------------------------------------------

test('filterGaps lists a 20 s silence at a 20 s threshold', () => {
  const entries = [
    entryAt(0, [{ startSec: 8, endSec: 15, durationSec: 7 }]),
    entryAt(15, [{ startSec: 0, endSec: 13, durationSec: 13 }]),
  ];
  const listed = log.filterGaps(log.allGaps(entries, at(30)), 20);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].type, 'silence');
});

test('filterGaps still lists a stretch that measured a hair short', () => {
  // A stretch can lose an unreported fragment at each edge, so a true 20 s silence can
  // measure ~19 s. This list exists to catch dead air, so the slack errs towards
  // showing it rather than being pedantic about the length.
  const entries = [
    entryAt(0, [{ startSec: 9, endSec: 15, durationSec: 6 }]),
    entryAt(15, [{ startSec: 0, endSec: 13.4, durationSec: 13.4 }]),
  ];
  const gaps = log.allGaps(entries, at(30));

  assert.ok(gaps[0].durationSec < 20, `expected a short measurement, got ${gaps[0].durationSec}`);
  assert.equal(log.filterGaps(gaps, 20).length, 1);
});

test('filterGaps hides a short pause', () => {
  const entries = [entryAt(0, [{ startSec: 4, endSec: 9, durationSec: 5 }])];

  assert.equal(log.filterGaps(log.allGaps(entries, at(30)), 20).length, 0);
});

test('filterGaps never hides an outage, however brief', () => {
  // A silence under the threshold is noise the user asked to not see anywhere. An
  // outage is a different finding - the stream itself failed - and matters even if it
  // only lasted one poll, so its duration must never gate whether it is shown.
  const entries = [entryAt(0), failedAt(15), entryAt(30)];
  const gaps = log.allGaps(entries, at(45));

  assert.equal(gaps[0].type, 'outage');
  assert.equal(gaps[0].durationSec, 15);
  assert.equal(log.filterGaps(gaps, 20).length, 1);
  assert.equal(log.filterGaps(gaps, 3600).length, 1);
});

// ---------------------------------------------------------------------------
// derivePointEvents
// ---------------------------------------------------------------------------

test('derivePointEvents reports a track change only when the title actually changes', () => {
  const a = { t: iso(0), ok: true, nowPlaying: 'Låt A', codec: 'aac' };
  const b = { t: iso(15), ok: true, nowPlaying: 'Låt A', codec: 'aac' };
  const c = { t: iso(30), ok: true, nowPlaying: 'Låt B', codec: 'aac' };

  assert.equal(log.derivePointEvents(null, a).filter((e) => e.type === 'metadata-change').length, 1);
  assert.equal(log.derivePointEvents(a, b).filter((e) => e.type === 'metadata-change').length, 0);
  assert.equal(log.derivePointEvents(b, c).filter((e) => e.type === 'metadata-change')[0].text, 'Låt B');
});

test('derivePointEvents catches a failover to a different encoder', () => {
  const before = { t: iso(0), ok: true, codec: 'aac', sampleRate: 44100, channels: 2 };
  const after = { t: iso(15), ok: true, codec: 'mp3', sampleRate: 44100, channels: 2 };

  assert.equal(log.derivePointEvents(before, after).filter((e) => e.type === 'format-change').length, 1);
});

test('derivePointEvents flags true peak only above 0.1 dBTP', () => {
  const peak = (v) => log.derivePointEvents(null, { t: iso(0), ok: true, truePeak: v }).some((e) => e.type === 'clipping');

  assert.equal(peak(0.4), true);
  assert.equal(peak(0.1), false);
  // A stream mastered right up to full scale is normal and must not fill the feed.
  assert.equal(peak(-0.5), false);
  assert.equal(peak(-1.2), false);
});

test('derivePointEvents stays quiet about loudness drift until it is switched on', () => {
  const entry = { t: iso(0), ok: true, lufsI: -9 };

  assert.equal(log.derivePointEvents(null, entry, { targetLufs: -16, toleranceLu: 2 }).length, 0);
  assert.equal(
    log.derivePointEvents(null, entry, { driftEnabled: true, targetLufs: -16, toleranceLu: 2 }).length,
    1
  );
});

test('derivePointEvents respects the tolerance band when drift is on', () => {
  const session = { driftEnabled: true, targetLufs: -16, toleranceLu: 2 };
  const drift = (lufs) =>
    log.derivePointEvents(null, { t: iso(0), ok: true, lufsI: lufs }, session).some((e) => e.type === 'loudness-drift');

  assert.equal(drift(-16), false);
  assert.equal(drift(-14), false);
  assert.equal(drift(-18), false);
  assert.equal(drift(-13.9), true);
  assert.equal(drift(-18.1), true);
});

test('derivePointEvents says nothing about a failed poll', () => {
  assert.equal(log.derivePointEvents(entryAt(0), failedAt(15)).length, 0);
});

// ---------------------------------------------------------------------------
// summarize / warning
// ---------------------------------------------------------------------------

test('summarize counts polls, success rate and the worst stretches', () => {
  const entries = [
    entryAt(0),
    entryAt(15, [{ startSec: 0, endSec: 15, durationSec: 15 }]),
    entryAt(30, [{ startSec: 0, endSec: 15, durationSec: 15 }]),
    failedAt(45),
    entryAt(60),
  ];
  const stats = log.summarize(entries, log.allGaps(entries, at(75)));

  assert.equal(stats.pollCount, 5);
  assert.equal(stats.okCount, 4);
  assert.equal(stats.okPercent, 80);
  assert.equal(stats.meanBitrateKbps, 128.4);
  assert.equal(stats.longestSilenceSec, 30);
  assert.equal(stats.longestOutageSec, 15);
  assert.equal(stats.silenceCount, 1);
  assert.equal(stats.outageCount, 1);
});

test('summarize handles an empty log without dividing by zero', () => {
  const stats = log.summarize([], []);

  assert.equal(stats.pollCount, 0);
  assert.equal(stats.busyCount, 0);
  assert.equal(stats.okPercent, null);
  assert.equal(stats.meanLufs, null);
  assert.equal(stats.meanBitrateKbps, null);
  assert.equal(stats.longestSilenceSec, 0);
});

test('summarize excludes busy polls from both sides of the success rate', () => {
  // A capacity rejection is not information about the stream - it must not drag
  // down okPercent (as it would if counted as a plain failure) nor inflate the
  // poll count with cycles the server never actually attempted.
  const entries = [entryAt(0), busyAt(15), entryAt(30), busyAt(45), entryAt(60)];
  const stats = log.summarize(entries, []);

  assert.equal(stats.busyCount, 2);
  assert.equal(stats.pollCount, 3); // the 3 real attempts only
  assert.equal(stats.okCount, 3);
  assert.equal(stats.okPercent, 100); // not 60% - busy is not a failure
});

test('summarize keeps session length keyed on every attempt, busy included', () => {
  // sessionSec is wall-clock elapsed time, which is true regardless of how many
  // cycles the server was too busy to run - unlike the success-rate stats above.
  const entries = [entryAt(0), busyAt(15), busyAt(30), entryAt(45)];
  const stats = log.summarize(entries, []);

  assert.equal(stats.sessionSec, 45);
});

// ---------------------------------------------------------------------------
// lastMeasuredEntry
// ---------------------------------------------------------------------------

test('lastMeasuredEntry skips trailing busy/failed polls to find what was last actually heard', () => {
  // appendEntry uses this as `prev` for derivePointEvents - comparing a
  // metadata-change against a failed/busy entry's always-null nowPlaying would
  // otherwise fire a spurious "spårbyte" event purely because the stream recovered,
  // not because the title changed.
  const entries = [entryAt(0), failedAt(15), busyAt(30)];

  assert.equal(log.lastMeasuredEntry(entries).t, entries[0].t);
});

test('lastMeasuredEntry returns null when nothing has ever been measured', () => {
  assert.equal(log.lastMeasuredEntry([failedAt(0), busyAt(15)]), null);
  assert.equal(log.lastMeasuredEntry([]), null);
});

test('recovering from an outage does not fire a spurious track-change event', () => {
  // The bug this fixes, demonstrated directly: naively using the previous array
  // entry as `prev` (its nowPlaying is always null after a failure) reports a
  // change even when the title never actually changed on either side.
  const before = entryAt(0, [], { id3: { available: true, frames: [{ tags: { StreamTitle: 'Samma låt' } }] } });
  const afterOutage = entryAt(30, [], { id3: { available: true, frames: [{ tags: { StreamTitle: 'Samma låt' } }] } });

  const naive = log.derivePointEvents(failedAt(15), afterOutage);
  assert.ok(naive.some((e) => e.type === 'metadata-change'), 'expected the naive comparison to show the bug');

  const fixed = log.derivePointEvents(log.lastMeasuredEntry([before, failedAt(15)]), afterOutage);
  assert.equal(fixed.filter((e) => e.type === 'metadata-change').length, 0);
});

test('shouldWarnLongSession triggers only after the threshold has passed', () => {
  const start = '2026-09-08T00:00:00.000Z';
  const hours = (n) => Date.parse(start) + n * 3600 * 1000;

  assert.equal(log.shouldWarnLongSession(start, hours(23), 24), false);
  assert.equal(log.shouldWarnLongSession(start, hours(24), 24), true);
  assert.equal(log.shouldWarnLongSession('inte ett datum', hours(30), 24), false);
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

test('toCsv writes a semicolon-separated file with dot decimals', () => {
  const csv = log.toCsv([entryAt(0)]);
  const [header, row] = csv.split('\n');

  assert.equal(header.split(';')[0], 'tid');
  assert.ok(header.includes('strom_ok'), header);
  assert.ok(row.includes(';-15.2;'), row);
  assert.ok(row.includes('128.4'), row);
});

test('toCsv quotes a title that would otherwise break the column layout', () => {
  const csv = log.toCsv([{ ...entryAt(0), nowPlaying: 'Artist; med "citat"' }]);

  assert.ok(csv.includes('"Artist; med ""citat"""'), csv);
});

test('toCsv defuses a station title that Excel would run as a formula', () => {
  // A station controls its own StreamTitle and the user opens this file in Excel, where
  // a leading = / + / - / @ makes the cell a formula.
  for (const hostile of ['=1+1', '+1', '-1+1', '@SUM(A1)']) {
    const csv = log.toCsv([{ ...entryAt(0), nowPlaying: hostile }]);
    const cellText = csv.split('\n')[1].split(';').slice(-2)[0];
    assert.ok(cellText.startsWith("'"), `not neutralised: ${hostile} -> ${cellText}`);
  }
});

test('toCsv does not mangle the negative numbers it writes itself', () => {
  const csv = log.toCsv([entryAt(0)]);

  assert.ok(csv.includes(';-15.2;-1.4;'), csv);
});

test('toCsv writes a header even with nothing logged', () => {
  assert.equal(log.toCsv([]).split('\n').length, 1);
  assert.equal(log.toCsv(null).split('\n').length, 1);
});

test('toCsv carries the ok/busy/failed distinction in its own column', () => {
  // strom_ok alone is just 0/1 - it cannot tell "server too busy to try" apart
  // from "the stream itself failed", which is exactly the distinction a
  // programmatic reader of the export needs and the UI already makes.
  const csv = log.toCsv([entryAt(0), busyAt(15), failedAt(30)]);
  const header = csv.split('\n')[0].split(';');
  const statusCol = header.indexOf('status');

  assert.ok(statusCol > header.indexOf('strom_ok'));
  const rows = csv.split('\n').slice(1);
  assert.equal(rows[0].split(';')[statusCol], 'ok');
  assert.equal(rows[1].split(';')[statusCol], 'busy');
  assert.equal(rows[2].split(';')[statusCol], 'failed');
});
