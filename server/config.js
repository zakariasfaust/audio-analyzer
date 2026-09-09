// config.js
// The tunables, in one place. Everything here bounds either how long we are willing
// to wait or how much memory/disk a single request can cost - the two things that
// decide whether this survives being reachable from the internet.

// Numeric env var with a fallback that survives an explicit "0" - the once-common
// `Number(process.env.X) || fallback` idiom treats 0 as falsy, so a real, intentional
// zero (PORT=0 to ask the OS for an ephemeral port, or an operator trying to disable
// a limit) silently becomes the default instead of the value that was actually set.
// Exported so server/index.js's own PORT/TRUST_PROXY parsing can use the same rule.
export function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const TIMEOUT_MS = 10_000;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Audio-Analyzer/1.0';

// A real M3U8 is at most a few MB. Anything past this is a mistake or an attack
// (a URL pointing at a large file), and an unbounded response.text() on it is a
// memory-exhaustion vector - so we refuse it instead.
export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

// An MPD gets its own, far tighter cap, because for XML a *byte* limit is not a
// memory limit: fast-xml-parser materialises an object per element, so a few MB of
// <S t= d= r=/> rows expand into an object graph an order of magnitude larger, and
// MAX_CONCURRENT_JOBS of those at once is how this process ran out of memory before.
// Real MPDs are small - a large live one is tens of KB - so 1 MB is already generous.
export const MAX_MPD_BYTES = 1 * 1024 * 1024;

// A SegmentTimeline this long is not a real stream - at 2 s segments, 50 000 rows is
// a ~28 hour DVR window. MAX_MPD_BYTES already bounds the input, but the *parsed*
// graph is what costs memory downstream, so it gets its own explicit ceiling.
export const MAX_TIMELINE_ENTRIES = 50_000;

// Hard cap on the recorded sample regardless of the bitrate the stream claims.
export const MAX_SAMPLE_FILE_BYTES = 50 * 1024 * 1024;

// Safety cap on how far into the audio body we'll read hunting for the first ICY
// metadata block. icy-metaint is typically 8-16 KB, so this covers a couple of
// intervals even on a low-bitrate stream while bounding memory hard.
export const ICY_MAX_READ_BYTES = 512 * 1024;

// SIGTERM on timeout/abort, then SIGKILL this long after if the process is still
// alive (ffmpeg stuck in a network read may not act on SIGTERM promptly).
export const CHILD_SIGKILL_GRACE_MS = 3000;

// Hard cap on captured stdout/stderr so a pathological input that makes ffprobe emit
// a huge JSON (or ffmpeg spew to stderr) can't grow the string unbounded.
export const MAX_CHILD_OUTPUT_BYTES = 24 * 1024 * 1024;

// Hard ceiling on analyses running at once, across all callers. Raised from the
// original 3 once the stream log started holding a slot for nearly its whole
// lifetime (one /api/sample every ~15s, back to back) - a handful of concurrent
// logs used to leave no room for even one more. 12 comfortably covers the target
// of 6-10 concurrent logs plus a spare analysis, while still bounding runaway
// fan-out (dozens of tabs at once). The live memory check below is the adaptive
// half of this gate; this number is the static backstop, not the primary defence.
export const MAX_CONCURRENT_JOBS = envNumber('MAX_CONCURRENT_JOBS', 12);

// Absolute wall-clock ceiling per job. Every internal step already has its own
// 10s timeout and a fully-degraded analyze (every step timing out in sequence)
// still lands under this; it only catches a request that wedges anyway - and,
// crucially, it aborts the work (in-flight fetches + ffmpeg/ffprobe) rather than
// letting it keep consuming memory/bandwidth after we've stopped waiting.
export const REQUEST_DEADLINE_MS = envNumber('REQUEST_DEADLINE_MS', 90_000);

// Reject a new job once the container's cgroup memory usage reaches this fraction
// of its limit. This is the number the OOM incident (2026-09-03, container killed
// at ~900MB) should have been gated on from the start - a cgroup limit counts the
// Node process *and* every ffmpeg/ffprobe child it has spawned, unlike RSS below.
// 20% headroom below the kernel's own kill threshold accounts for the lag between
// admitting a job and its children reaching their own peak memory.
export const MEMORY_RATIO_THRESHOLD = envNumber('MEMORY_RATIO_THRESHOLD', 0.8);

// Fallback ceiling for when no cgroup is readable at all (local dev - Windows in
// particular has no /sys/fs/cgroup). This reflects only the Node process's own
// memory, never its spawned children, so it is deliberately generous: the 2026
// incident was killed around 900MB container-wide; 450MB is half that, with the
// geoip-lite baseline (~100MB) now opt-in rather than always paid.
export const MAX_RSS_BYTES = envNumber('MAX_RSS_BYTES', 450 * 1024 * 1024);

// Per-IP request budget. Raised alongside MAX_CONCURRENT_JOBS: a single running
// log makes ~20 requests per 5-minute window on its own (one poll every 15s), so
// the old ceiling of 60 blocked as few as 3-4 concurrent logs from one browser
// regardless of the concurrency gate above. 300 covers every one of the 12 job
// slots being held by a single IP (~240) with room to spare, while still cutting
// off a genuine rapid-fire script (which would blow through 300 in well under the
// 5-minute window, unlike paced, legitimate polling).
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const RATE_LIMIT_MAX = envNumber('RATE_LIMIT_MAX', 300);
