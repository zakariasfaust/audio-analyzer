// resourceGuard.js
// The other half of jobGuard's decision: whether the host has room for one more
// analysis. Split in two on purpose - reading memory touches the filesystem and
// the current process, deciding is pure - so the decision itself is testable with
// hand-built numbers, no container or real memory pressure required.

import { readFileSync } from 'node:fs';

// A cgroup limit reported as this large (or the literal "max" in cgroup v2) means
// "no limit set" - not a real ceiling to divide by. 1 PiB is far past any real
// container allocation, so treating it as "unknown" rather than as a genuine
// multi-petabyte budget is the safe reading.
const UNLIMITED_BYTES = 1024 ** 5;

function readIntFile(path) {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text === 'max') return null; // cgroup v2's own spelling of "no limit"
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined; // file missing, unreadable, or not a cgroup host at all
  }
}

function normalizeLimit(bytes) {
  if (bytes === null || bytes === undefined) return null;
  return bytes >= UNLIMITED_BYTES ? null : bytes;
}

/**
 * Reads how much memory is actually in play right now, preferring the number the
 * kernel itself will act on (the container's cgroup) over the Node process's own
 * view of itself - `process.memoryUsage().rss` never includes the ffmpeg/ffprobe
 * child processes this app spawns, which is exactly what a swarm of concurrent
 * stream logs multiplies. Falls back to that RSS-only view when no cgroup is
 * readable at all (local dev, in particular Windows, has none).
 */
export function readMemorySnapshot() {
  const v2Used = readIntFile('/sys/fs/cgroup/memory.current');
  if (v2Used !== undefined) {
    return { source: 'cgroupv2', usedBytes: v2Used, limitBytes: normalizeLimit(readIntFile('/sys/fs/cgroup/memory.max')) };
  }

  const v1Used = readIntFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1Used !== undefined) {
    return {
      source: 'cgroupv1',
      usedBytes: v1Used,
      limitBytes: normalizeLimit(readIntFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')),
    };
  }

  return { source: 'rss', usedBytes: process.memoryUsage().rss, limitBytes: null };
}

/**
 * Decides whether one more job can be admitted right now. Two independent reasons
 * to say no: the job-count ceiling (a flat backstop against runaway fan-out,
 * e.g. dozens of tabs at once) and live memory pressure (the adaptive check the
 * count alone can't be, since it has no idea how much headroom is actually left).
 *
 * The count check runs first and needs no snapshot at all - `memorySnapshot: null`
 * is a valid, cheap way to skip the memory check entirely (jobGuard only bothers
 * reading memory when the count check would otherwise pass).
 */
export function evaluateJobCapacity({
  activeJobs,
  maxConcurrentJobs,
  memorySnapshot,
  memoryRatioThreshold,
  maxRssBytes,
}) {
  if (activeJobs >= maxConcurrentJobs) {
    return { allowed: false, reason: 'concurrency', detail: { activeJobs, maxConcurrentJobs } };
  }

  if (!memorySnapshot) return { allowed: true, reason: null, detail: null };

  const { source, usedBytes, limitBytes } = memorySnapshot;

  // A cgroup limit is a whole-container figure (Node + every child process it has
  // spawned) - the right number to gate on, and comparable to a ratio threshold.
  // RSS is Node-alone, a different unit, so it is compared against its own
  // absolute ceiling instead - never against a cgroup-shaped ratio.
  if (source === 'rss') {
    if (usedBytes >= maxRssBytes) {
      return { allowed: false, reason: 'memory', detail: { source, usedBytes, maxRssBytes } };
    }
    return { allowed: true, reason: null, detail: null };
  }

  // A cgroup that reports no limit (a genuinely uncapped host) leaves nothing to
  // divide by - the job-count ceiling above is the only gate in that case.
  if (limitBytes === null) return { allowed: true, reason: null, detail: null };

  const ratio = usedBytes / limitBytes;
  if (ratio >= memoryRatioThreshold) {
    return { allowed: false, reason: 'memory', detail: { source, usedBytes, limitBytes, ratio, memoryRatioThreshold } };
  }
  return { allowed: true, reason: null, detail: null };
}
