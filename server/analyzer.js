// analyzer.js
// The dispatcher, and nothing else.
//
// One sniff decides which of the three analysis modules owns the URL. Each of them
// owns its own fetches and returns a shape tagged with `streamKind` for the frontend
// to branch on - the shapes differ because the formats genuinely differ, not by
// accident. See hls.js, dash.js and icecast.js.

import { sniffStreamKind } from './net.js';
import { analyzeHls } from './hls.js';
import { analyzeDash } from './dash.js';
import { analyzeIcecast } from './icecast.js';

export async function analyze(url, { signal } = {}) {
  const sniff = await sniffStreamKind(url, { signal });
  // The sniff already fetched this URL and built the connection card from that
  // response - hand it on so the analyser does not open an identical second
  // connection. That is one fewer listener slot held on an Icecast mount.
  const opts = { signal, connection: sniff.connection };

  if (sniff.kind === 'dash') return analyzeDash(url, opts);
  if (sniff.kind === 'icecast') return analyzeIcecast(url, opts);
  // 'unknown' falls back to the HLS path deliberately: it fails with a readable
  // INVALID_MANIFEST that shows what came back, which beats a generic "unsupported".
  return analyzeHls(url, opts);
}
