# Audio Analyzer

A small tool for analyzing audio streams (HLS/`.m3u8` and MPEG-DASH/`.mpd`) -
designed especially for radio streams behind CDNs like Akamai.
Paste in a manifest URL and get a combined status snapshot: connection/CORS,
variants (HLS) or representations (DASH), audio codec, segments and buffer,
latency, measured bitrate, "now playing" ID3, and the raw manifest.

The stream type is detected automatically from the response (Content-Type,
then a small body peek), so the same URL field takes either format.

## Why a backend?

Most CDNs (e.g. Akamai) don't send CORS headers on their manifests,
so `fetch()` directly from the browser is blocked. The tool also needs
`ffprobe`/`ffmpeg`, which are binaries and can't run in the browser. That's why
there's a Node/Express backend that proxies the HTTP calls and runs ffprobe/ffmpeg
as child processes. The frontend is plain HTML/CSS/JS with no build step or framework.

## Prerequisites

- Node.js 18.17 or later
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
port `8877` by default (override with `PORT=xxxx npm start`; override the bind
address with `HOST=xxxx npm start` - see [Security posture](#security-posture)
below before exposing it). Open `http://127.0.0.1:8877/` in your browser, paste
in a `.m3u8` URL, and click Analyze.

## Testing

There are no automated tests. Manual verification:
1. `npm start`, open the page, analyze a known HLS `.m3u8` URL and a known
   DASH `.mpd` URL - both should render the full set of section cards.
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
- **"Only one variant"** - many radio streams lack a separate
  master playlist; the URL then points directly at the media playlist. This is flagged
  in the UI instead of showing an empty variant table.
- **ID3/"Now playing" is best-effort** - requires the stream to actually
  carry timed metadata in the segments. Many streams don't, in which case
  "No ID3 metadata found" is shown - that's expected, not an error.
- **Timeout** on all external HTTP calls and ffprobe runs is 10 seconds
  (`TIMEOUT_MS` in `server/analyzer.js`).
- **IP-based geo estimate** on the network path card uses the bundled
  `geoip-lite` database (offline, no external calls) - it's a rough, 
  complement to the header-based hint, not a replacement.

## Security posture

The tool is built to run locally and binds to `127.0.0.1` for that reason.
Setting `HOST=0.0.0.0` exposes it on the network; if you do that, these are the
protections in place - and their limits:

- **No login.** Anyone who can reach the URL can use it. A TLS certificate publishes the hostname in public
  Certificate Transparency logs the moment it's issued.
- **Per-IP rate limit** on `/api/*` - `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`
  in `server/index.js` (60 requests per 5 minutes). Tune to taste.
- **Global concurrency cap** - `MAX_CONCURRENT_JOBS` in `server/index.js` (3).
  The two endpoints that spawn `ffprobe`/`ffmpeg` reject with 503 past this,
  regardless of source IP.
- **SSRF guard** - `assertPublicHost` in `server/analyzer.js` blocks outbound
  requests to `localhost`, private/link-local ranges, and cloud-metadata
  addresses. For `fetch`-based traffic (manifests, headers, segment probes) it's
  backed by an undici dispatcher that re-checks the real remote IP of every
  connection, including each redirect hop, so bare-IP URLs, redirects into
  private space, and DNS rebinding are all caught. `ffprobe`/`ffmpeg` do their
  own DNS and socket work outside Node, so for those two the up-front check is
  the only layer - a determined rebinding attack there is not fully closed.
- **Recording is capped** - `/api/sample` records audio only (no video), 15s max.

## License

[MIT](LICENSE)
