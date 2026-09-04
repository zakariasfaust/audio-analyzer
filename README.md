# Audio Analyzer

A small tool for analyzing audio streams - HLS (`.m3u8`), MPEG-DASH (`.mpd`)
and Icecast/SHOUTcast/RSAS - designed especially for radio streams behind CDNs
like Akamai. Paste in a stream URL and get a combined status snapshot:
connection/CORS, variants (HLS) / representations (DASH) / station metadata
(Icecast), audio codec, segments and buffer, latency, measured bitrate,
"now playing", and the raw manifest.

The stream type is detected automatically from the response (Content-Type and
`icy-*` headers, then a small body peek), so the same URL field takes any of them.

## Why a backend?

Most CDNs (e.g. Akamai) don't send CORS headers on their manifests,
so `fetch()` directly from the browser is blocked. The tool also needs
`ffprobe`/`ffmpeg`, which are binaries and can't run in the browser. That's why
there's a Node/Express backend that proxies the HTTP calls and runs ffprobe/ffmpeg
as child processes. The frontend is plain HTML/CSS/JS with no build step or framework.

## Prerequisites

- Node.js 20 or later
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

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8877` | Listening port. |
| `HOST` | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0`. See [Security posture](#security-posture). |
| `TRUST_PROXY` | unset (off) | Number of reverse-proxy hops to trust for `X-Forwarded-For`. Set it **only** when something really does sit in front, otherwise any caller can forge the header and walk past the per-IP rate limit. |
| `ENABLE_IP_GEO` | unset (off) | Turns on the IP-to-city estimate. Costs ~105 MB of resident memory, because `geoip-lite` loads its whole database on import. |

## Testing

```bash
npm test        # node --test, no network, no ffmpeg needed
```

The suite covers the parsers and every pure computation (segment stats, latency,
DASH segment-URL generation), plus the frontend's escaping rules - including a
regression test for a `javascript:` station homepage, which `esc()` alone did not
stop. Anything that would need a real stream is left to manual verification:

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
- **Timeout** on all external HTTP calls and ffprobe runs is 10 seconds
  (`TIMEOUT_MS` in `server/analyzer.js`).
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
  in `server/index.js` (60 requests per 5 minutes). It keys on `X-Forwarded-For`
  only when `TRUST_PROXY` is set; without a proxy in front, trusting that header
  would let any caller forge a fresh IP per request and bypass the limit entirely.
- **Global concurrency cap** - `MAX_CONCURRENT_JOBS` in `server/index.js` (3).
  The two endpoints that spawn `ffprobe`/`ffmpeg` reject with 503 past this,
  regardless of source IP.
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
- **The container** runs as the non-root `node` user and is built with `npm ci`, so
  the deployed image gets exactly the versions in `package-lock.json`.

## License

[MIT](LICENSE)
