# Audio Analyzer

A small local tool for analyzing audio streams (currently HLS/`.m3u8`) -
designed especially for radio streams behind CDNs like Akamai.
Paste in a manifest URL and get a combined status snapshot: connection/CORS,
variants, audio codec, segments and buffer, latency, measured bitrate,
"now playing" ID3, and the raw manifest.

## Why a backend?

Most CDNs (e.g. Akamai) don't send CORS headers on their manifests,
so `fetch()` directly from the browser is blocked. The tool also needs
`ffprobe`/`ffmpeg`, which are binaries and can't run in the browser. That's why
there's a Node/Express backend that proxies the HTTP calls and runs ffprobe/ffmpeg
as child processes. The frontend is plain HTML/CSS/JS with no build step or framework.

## Prerequisites

- Node.js 18 or later
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

The server explicitly binds to `127.0.0.1` (not `0.0.0.0`) and listens on
port `8877` by default (override with `PORT=xxxx npm start`). Open
`http://127.0.0.1:8877/` in your browser, paste in a `.m3u8` URL, and click
Analyze.

## Testing

There are no automated tests. Manual verification:
1. `npm start`, open the page, click Analyze on the prefilled example URL.
2. Test a failure case by pasting in a URL that returns 404 or points to
   a page that isn't an M3U8 - the error should display readably, the page should never
   go blank.

## Good to know

- **Status snapshot, not live** - each click on Analyze makes a new request.
  The page doesn't poll or update automatically.
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
  unverified complement to the header-based hint, not a replacement, and
  adds a fairly large dependency (~115 MB unpacked) to `npm install`.

## License

[MIT](LICENSE)
