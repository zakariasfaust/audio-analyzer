// resourceGuard.test.js
// evaluateJobCapacity() is the pure decision jobGuard delegates to: given a job
// count and a memory reading, allow or reject. No filesystem, no real memory
// pressure required - every case here is a hand-built snapshot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateJobCapacity, readMemorySnapshot } from '../server/resourceGuard.js';

const BASE = { activeJobs: 0, maxConcurrentJobs: 12, memoryRatioThreshold: 0.8, maxRssBytes: 450 * 1024 * 1024 };

// --------------------------------------------------------------------------
// Count check - short-circuits before memory is ever considered
// --------------------------------------------------------------------------

test('rejects on concurrency before memory is even considered', () => {
  const decision = evaluateJobCapacity({ ...BASE, activeJobs: 12, memorySnapshot: null });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'concurrency');
});

test('allows when under the job-count ceiling and no memory snapshot was taken', () => {
  // jobGuard skips the memory read entirely once the count check already passes
  // it through for further evaluation - null must be a legal, cheap "no news" input.
  const decision = evaluateJobCapacity({ ...BASE, activeJobs: 5, memorySnapshot: null });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, null);
});

// --------------------------------------------------------------------------
// cgroup ratio
// --------------------------------------------------------------------------

test('allows a cgroup snapshot comfortably under the ratio threshold', () => {
  const decision = evaluateJobCapacity({
    ...BASE,
    memorySnapshot: { source: 'cgroupv2', usedBytes: 200 * 1024 * 1024, limitBytes: 1000 * 1024 * 1024 },
  });

  assert.equal(decision.allowed, true);
});

test('rejects a cgroup snapshot right at the ratio threshold', () => {
  const decision = evaluateJobCapacity({
    ...BASE,
    memorySnapshot: { source: 'cgroupv1', usedBytes: 800 * 1024 * 1024, limitBytes: 1000 * 1024 * 1024 },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'memory');
  assert.equal(decision.detail.ratio, 0.8);
});

test('allows a cgroup snapshot just under the ratio threshold', () => {
  const decision = evaluateJobCapacity({
    ...BASE,
    memorySnapshot: { source: 'cgroupv2', usedBytes: 799 * 1024 * 1024, limitBytes: 1000 * 1024 * 1024 },
  });

  assert.equal(decision.allowed, true);
});

test('skips the memory check on a cgroup host that reports no limit at all', () => {
  // A genuinely uncapped container leaves nothing to divide by - the job-count
  // ceiling is the only gate left, and it must not be treated as an RSS reading
  // (a cgroup usedBytes figure includes every ffmpeg/ffprobe child, a different
  // unit than the Node-only RSS ceiling).
  const decision = evaluateJobCapacity({
    ...BASE,
    memorySnapshot: { source: 'cgroupv2', usedBytes: 5 * 1024 * 1024 * 1024, limitBytes: null },
  });

  assert.equal(decision.allowed, true);
});

// --------------------------------------------------------------------------
// RSS fallback (local dev, no cgroup readable)
// --------------------------------------------------------------------------

test('rejects an RSS snapshot at or over the absolute ceiling', () => {
  const decision = evaluateJobCapacity({
    ...BASE,
    memorySnapshot: { source: 'rss', usedBytes: 500 * 1024 * 1024, limitBytes: null },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'memory');
  assert.equal(decision.detail.source, 'rss');
});

test('allows an RSS snapshot comfortably under the absolute ceiling', () => {
  const decision = evaluateJobCapacity({
    ...BASE,
    memorySnapshot: { source: 'rss', usedBytes: 150 * 1024 * 1024, limitBytes: null },
  });

  assert.equal(decision.allowed, true);
});

// --------------------------------------------------------------------------
// readMemorySnapshot - smoke test only; the real behaviour is environment-dependent
// --------------------------------------------------------------------------

test('readMemorySnapshot returns a well-shaped snapshot on this machine', () => {
  const snapshot = readMemorySnapshot();

  assert.ok(['cgroupv2', 'cgroupv1', 'rss'].includes(snapshot.source));
  assert.equal(typeof snapshot.usedBytes, 'number');
  assert.ok(snapshot.usedBytes > 0);
  assert.ok(snapshot.limitBytes === null || typeof snapshot.limitBytes === 'number');
  // No /sys/fs/cgroup on Windows dev/CI - this is the expected, exercised path here.
  if (process.platform === 'win32') assert.equal(snapshot.source, 'rss');
});
