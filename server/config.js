// config.js
// The tunables, in one place. Everything here bounds either how long we are willing
// to wait or how much memory/disk a single request can cost - the two things that
// decide whether this survives being reachable from the internet.

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
