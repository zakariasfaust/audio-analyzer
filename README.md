# Audio Analyzer

A small tool for analyzing audio streams - HLS (`.m3u8`), MPEG-DASH (`.mpd`)
and Icecast/SHOUTcast/RSAS - designed especially for radio streams behind CDNs
like Akamai. Paste in a stream URL and get a combined status snapshot:
connection/CORS, variants (HLS) / representations (DASH) / station metadata
(Icecast), audio codec, segments and buffer, latency, measured bitrate,
"now playing", and the raw manifest.

Paste a URL and pick one of two things: **Analysera** for that snapshot, or
**Logga** to follow the stream over time instead. Both render into the same
place below the URL field. The log plots integrated loudness (LUFS) and true
peak as they are measured and lists silence and outages as they happen; it runs
entirely in the browser tab.

The stream type is detected automatically from the response (Content-Type and
`icy-*` headers, then a small body peek), so the same URL field takes any of them.

## Why a backend?

Most CDNs (e.g. Akamai) don't send CORS headers on their manifests,
so `fetch()` directly from the browser is blocked. The tool also needs
`ffprobe`/`ffmpeg`, which are binaries and can't run in the browser. That's why
there's a Node/Express backend that proxies the HTTP calls and runs ffprobe/ffmpeg
as child processes. The frontend is plain HTML/CSS/JS with no build step or framework.

## Prerequisites

- Node.js 22 or later
- `ffmpeg` (including `ffprobe`) installed and available in PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (or `sudo dnf install ffmpeg`)
  - Windows: `winget install Gyan.FFmpeg`

If ffmpeg/ffprobe is missing, the server still starts, but the audio/buffer/
recording analysis will fail (manifest analysis works as usual).

## Installation and running

```bash
npm install
npm start
```

The server binds to `127.0.0.1` by default (not `0.0.0.0`) and listens on
port `8877` by default. Open `http://127.0.0.1:8877/` in your browser, paste
in a `.m3u8` URL, and click Analyze.

### Running with Docker

The bundled [`Dockerfile`](Dockerfile) is what the production deployment actually
builds from - `node:24-alpine` plus `ffmpeg`, running as the non-root `node` user.

```bash
docker build -t audio-analyzer .
docker run --rm -p 8877:8877 audio-analyzer
```

Unlike the bare `npm start` default, the image sets `HOST=0.0.0.0` (so the
container is reachable from outside itself) and `TRUST_PROXY=1` (correct behind
a reverse proxy; see the `TRUST_PROXY` note below before using this image
without one in front of it). The image also ships a `HEALTHCHECK` that polls
the app's own root path every 30s.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8877` | Listening port. |
| `HOST` | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0`. See [Security posture](#security-posture). |
| `TRUST_PROXY` | unset (off) | Number of reverse-proxy hops to trust for `X-Forwarded-For`. Set it **only** when something really does sit in front, otherwise any caller can forge the header and walk past the per-IP rate limit. |
| `ENABLE_IP_GEO` | unset (off) | Turns on the IP-to-city estimate. Costs ~105 MB of resident memory, because `geoip-lite` loads its whole database on import. |
| `MAX_CONCURRENT_JOBS` | `12` | Global cap on analyses/samples running at once. See [Security posture](#security-posture). |
| `RATE_LIMIT_MAX` | `300` | Per-IP request budget per 5-minute window on `/api/*`. |
| `MEMORY_RATIO_THRESHOLD` | `0.8` | Reject a new job once cgroup memory usage reaches this fraction of the container's limit (Linux/Docker only). |
| `MAX_RSS_BYTES` | `450 * 1024 * 1024` | Fallback memory ceiling (Node process RSS only) when no cgroup is readable, e.g. local dev. |
| `REQUEST_DEADLINE_MS` | `90000` | Hard wall-clock ceiling per request; aborts in-flight work past this. |

## Testing

```bash
npm test        # node --test, no network, no ffmpeg needed
```

The suite covers the parsers and every pure computation (segment stats, latency,
DASH segment-URL generation), plus the frontend's escaping rules - including a
regression test for a `javascript:` station homepage, which `esc()` alone did not
stop. `test/index.test.js` runs the real Express app as a child process and hits
it with plain `fetch()` - request validation, the SSRF guard, and `jobGuard`'s
concurrency limit, all exercised end to end rather than only unit-tested in
isolation; still offline-safe, no real stream is ever reachable in it. Anything
that needs a real stream is left to manual verification:

1. `npm start`, open the page, analyze a known HLS `.m3u8` URL, a known
   DASH `.mpd` URL, and a public Icecast/radio stream URL - each should render
   its own set of section cards.
2. Test a failure case by pasting in a URL that returns 404 or points to
   a page that is neither an M3U8 nor an MPD - the error should display readably,
   the page should never go blank.

## Good to know

- **Status snapshot, not live** - each click on Analyze makes a new request.
  The page doesn't poll or update automatically.
- **DASH support** analyses the first audio representation of the first
  Period, the same "first, not best" choice the HLS path makes for variants.
  Known v1 limitations, surfaced in the UI rather than hidden: only the first
  Period is analysed (a note is shown when there are more), remote/`xlink`
  Periods are out of scope, and DRM-protected streams show the protection
  scheme but the audio section then fails predictably (ffprobe can't decrypt).
  Segment counts for live DASH are estimated from the manifest, not listed.
- **Icecast / SHOUTcast / RSAS** streams are detected from the `icy-*` response
  headers (or a bare `audio/*` content-type) and analysed for what a raw stream
  actually exposes: station name/genre/description, declared vs. measured
  bitrate, server software, and "now playing" from the in-stream ICY metadata
  block. RSAS is Icecast-compatible and needs nothing extra; RSAS's own HLS
  endpoints go through the HLS path. Legacy SHOUTcast v1 servers that answer
  with a non-HTTP `ICY 200 OK` status line are not supported (v2/DNAS is).
- **"Only one variant"** - many radio streams lack a separate
  master playlist; the URL then points directly at the media playlist. This is flagged
  in the UI instead of showing an empty variant table.
- **ID3/"Now playing" is best-effort** - requires the stream to actually
  carry timed metadata in the segments. Many streams don't, in which case
  "No ID3 metadata found" is shown - that's expected, not an error.
- **The stream log records back to back.** Each cycle records 15 seconds - the
  server's hard cap - and the next recording starts as soon as the previous cycle
  finishes, so the only unheard time is the moment it takes to reconnect. Silence
  is timestamped against the server's own recording clock (`recordedAt`) and
  stitched across recording boundaries, so a stretch of dead air split over two
  recordings is reported once, with real start and end times, accurate to about a
  second. That accuracy is why `SILENCE_MIN_DURATION_SEC` is 0.5 s: a fragment
  shorter than the detector's minimum is never reported at all, and at the old 2 s
  a 20-second silence straddling a boundary measured as 18 - or vanished. Two
  stretches are only joined across the reconnect gap; a gap *inside* one recording
  means audio was actually heard and is never bridged.
- **Silence and outage are different findings** and are listed separately. Silence
  means the stream answered and the audio arrived but was quiet - the broadcast
  lost its content while the server kept working. Outage means the request itself
  failed. Silence means audio below -50 dB for at least 2 seconds; a stream can be
  inaudibly quiet without crossing that line, and true digital silence reports a
  true peak of -inf, shown as "no signal at all" rather than as a missing value.
- **The log lives in the browser tab.** No database, no server-side scheduler, no
  account. It is mirrored to `localStorage` so a reload can offer to restore it
  (never silently), warns before you close an unexported log, and nags after 24
  hours - but the only durable copy is the JSON or CSV you export.
- **LRA (loudness range) is not measured.** It is only meaningful over long,
  varied material, and `ebur128` prints it whether we ask or not - so it is
  parsed out and ignored rather than displayed as a number that would not mean
  what it looks like.
- **Loudness drift logging is off by default.** Most streams sit outside any given
  target most of the time, so flagging every deviation buries the events that
  matter. Switch it on and set the target in LUFS and the tolerance in LU (the
  same scale, used for differences: 1 LU = 1 dB).
- **"Now playing" comes from two different places.** HLS and DASH may carry ID3
  frames in the segments; Icecast/SHOUTcast keep the title in an in-stream ICY
  block that the recorded audio does not carry at all, so the log asks for it
  separately with `/api/sample?icy=1`. Plenty of streams send neither.
- **Timeout** on all external HTTP calls and ffprobe runs is 10 seconds
  (`TIMEOUT_MS` in `server/config.js`).
- **IP-based geo estimate** on the network path card is **off by default**. The
  bundled `geoip-lite` database is offline (no external calls) but costs ~105 MB of
  resident memory the moment it is imported, for a lookup that is well-known to be
  wrong for CDN anycast addresses. Set `ENABLE_IP_GEO=1` if you want it; the
  header-based hint next to it works either way.

## Security posture

`npm start` binds to `127.0.0.1`, but the Docker image sets `HOST=0.0.0.0` and this
tool is deployed publicly - so treat internet exposure as the normal case, not the
exception. What is in place, and where it stops:

- **No login.** Anyone who can reach the URL can use it. A TLS certificate publishes
  the hostname in public Certificate Transparency logs the moment it's issued.
- **Per-IP rate limit** on `/api/*` - `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`
  in `server/config.js` (300 requests per 5 minutes; a single running stream log
  makes ~20 of those on its own, polling every 15s). It keys on `X-Forwarded-For`
  only when `TRUST_PROXY` is set; without a proxy in front, trusting that header
  would let any caller forge a fresh IP per request and bypass the limit entirely.
- **Global concurrency cap** - `MAX_CONCURRENT_JOBS` in `server/config.js` (12).
  The two endpoints that spawn `ffprobe`/`ffmpeg` reject with 503 past this,
  regardless of source IP. Backed by a live memory check (`server/resourceGuard.js`):
  a job is also refused once the container's cgroup memory usage crosses
  `MEMORY_RATIO_THRESHOLD` (80% of its limit) - or, when no cgroup is readable (local
  dev), once the Node process's own RSS crosses `MAX_RSS_BYTES`. Both rejection
  reasons return the same `BUSY` error to the client; the stream log treats a `BUSY`
  response as neither a success nor a stream outage, and excludes it from both.
- **SSRF guard** - `assertPublicHost` in `server/net.js` blocks outbound requests to
  `localhost`, private/link-local ranges, and cloud-metadata addresses. For `fetch`
  traffic (manifests, headers, segment probes) it's backed by an undici dispatcher
  that re-checks the real remote IP of every connection, including each redirect
  hop, so bare-IP URLs, redirects into private space, and DNS rebinding are all
  caught. `ffprobe`/`ffmpeg` do their own DNS and socket work outside Node, so for
  those two the up-front check is the only layer - which is why it is called with
  `failClosed` there: a DNS failure refuses the request rather than waving it
  through. They also run with an explicit `-protocol_whitelist` that excludes
  `file`, so a hostile manifest cannot point its segments at a local path. A
  determined DNS-rebinding attack against ffmpeg is still not fully closed.
- **Response size limits** - manifests are capped at 10 MB, MPDs at 1 MB (XML parses
  into an object graph far larger than its byte size), and a SegmentTimeline at
  50 000 `<S>` rows.
- **Recording is capped** - `/api/sample` records audio only (no video), 15s max,
  50 MB max.
- **Browser-side** - a strict Content-Security-Policy (`default-src 'self'`) plus the
  rest of helmet's defaults. The page renders remote-controlled strings, so every URL
  that becomes a link is scheme-checked first; escaping alone does not stop
  `javascript:`.
- **The container** runs as the non-root `node` user, is built with `npm ci` (so the
  deployed image gets exactly the versions in `package-lock.json`), and ships a
  `HEALTHCHECK` that polls the app's own root path - so a process that's running but
  wedged doesn't look "healthy" to Docker forever.
- **Dependency advisories are reviewed, not just counted.** `npm audit` currently
  reports one moderate finding, in `fast-xml-parser`'s `XMLBuilder` (unescaped-delimiter
  injection in generated XML). This app only ever imports `XMLParser` (`server/dashParser.js`,
  to read DASH manifests) and never `XMLBuilder` - the vulnerable code path is not
  reachable through this app's usage. Left at the current major version rather than
  forcing a breaking upgrade for an unreachable finding; revisit at the next routine
  dependency bump.

## License

[MIT](LICENSE)
