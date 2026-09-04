// networkPath.js
// "Which machine actually served this?" - answered from CDN routing headers, a DNS
// lookup of the host, and (opt-in) an offline IP-to-city database.
//
// Everything here is a hint, and is labelled as one. The headers are conventions,
// not a standard; the DNS answer is one of several nodes behind load balancing and
// not necessarily the one that replied; the IP database is a stale snapshot.

import dns from 'node:dns/promises';

// Generic patterns for headers that reveal which CDN node/edge server responded -
// covers Akamai, Cloudflare (cf-*), CloudFront (x-amz-cf-*) and common generic
// cache/edge conventions, rather than hardcoding a specific CDN.
const NETWORK_PATH_PATTERNS = [/^x-cache/i, /^x-served/i, /^x-edge/i, /^via$/i, /^x-amz-cf/i, /^cf-/i, /^x-akamai/i];

function isNetworkPathHeader(key) {
  return NETWORK_PATH_PATTERNS.some((re) => re.test(key));
}

// Best-effort: many CDN nodes are named with an airport code (e.g. "ARN52" for
// Stockholm Arlanda) followed by digits. We only extract the pattern raw - we do
// NOT translate the code into a city, that would be guessing.
const GEO_HINT_RE = /\b([A-Z]{3})\d{1,4}\b/;

function extractGeoHint(headerValues) {
  for (const value of headerValues) {
    const m = GEO_HINT_RE.exec(value);
    if (m) return { raw: m[0], code: m[1], sourceValue: value };
  }
  return null;
}

/**
 * Filters out headers that reveal CDN routing (cache status, which node
 * responded, etc.) from the full header list, plus a best-effort
 * guess at a geographic hint in the node name.
 */
export function computeNetworkPath(allHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(allHeaders || {})) {
    if (isNetworkPathHeader(key)) headers[key] = value;
  }
  return {
    headers,
    geoHint: extractGeoHint(Object.values(headers)),
  };
}

// ---------------------------------------------------------------------------
// Optional IP geolocation
// ---------------------------------------------------------------------------

// geoip-lite ships a ~110 MB database and its module scope calls preload() on
// import, so a plain `import geoip from 'geoip-lite'` costs ~105 MB of resident
// memory on every boot, before a single request arrives - by far the largest single
// allocation in this process, and it is spent on a lookup that is well-known to be
// inaccurate for exactly the CDN anycast addresses this tool mostly sees (they
// geolocate to the operator's registered address, not the physical edge node).
// So it is opt-in: set ENABLE_IP_GEO=1 to pay for it. Off, the network-path card
// says the estimate is disabled; the header-based geoHint is unaffected either way.
const IP_GEO_ENABLED = process.env.ENABLE_IP_GEO === '1';
let geoipPromise = null;

function loadGeoip() {
  if (!IP_GEO_ENABLED) return null;
  if (!geoipPromise) {
    geoipPromise = import('geoip-lite')
      .then((m) => m.default)
      .catch((err) => {
        console.warn(`Kunde inte ladda geoip-lite: ${err.message}`);
        return null;
      });
  }
  return geoipPromise;
}

/**
 * Best-effort city/country lookup for a single IP address, from the local
 * (offline, bundled) geoip-lite database - no external network call, but the
 * database itself is a snapshot and can be stale.
 */
function lookupIpGeo(geoip, ip) {
  const result = geoip.lookup(ip);
  if (!result) return null;
  return {
    ip,
    country: result.country || null,
    region: result.region || null,
    city: result.city || null,
    ll: result.ll || null,
  };
}

/**
 * Looks up the IP addresses a hostname currently points to. Only one of several
 * possible nodes behind DNS-based load balancing - not necessarily
 * the same node that actually responded to the HTTP request we already made.
 */
export async function resolveDnsAddresses(hostname) {
  const geoip = await loadGeoip();
  const geoFor = (addresses) => (geoip ? addresses.map((ip) => lookupIpGeo(geoip, ip)) : []);
  const base = { hostname, ipGeoEnabled: IP_GEO_ENABLED };

  try {
    const addresses = await dns.resolve4(hostname);
    return { ...base, addresses, family: 4, error: null, ipGeo: geoFor(addresses) };
  } catch (err4) {
    try {
      const addresses6 = await dns.resolve6(hostname);
      return { ...base, addresses: addresses6, family: 6, error: null, ipGeo: geoFor(addresses6) };
    } catch {
      return { ...base, addresses: [], family: null, error: err4.message, ipGeo: [] };
    }
  }
}

/**
 * The shape resolveDnsAddresses() would have returned, for when the lookup could not
 * even be attempted (an unparseable final URL). Keeps the frontend on one code path.
 */
export function emptyDnsResult(errorMessage) {
  return {
    hostname: null,
    addresses: [],
    family: null,
    error: errorMessage,
    ipGeoEnabled: IP_GEO_ENABLED,
    ipGeo: [],
  };
}
