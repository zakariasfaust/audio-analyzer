// shared.js
// Helpers both pages need: the snapshot page (app.js) and the stream log (log.js).
// A classic script like the other two, loaded first, so everything here lands in the
// same global scope and both callers use it unchanged.
//
// esc() and safeHttpUrl() are the XSS defences for everything a remote stream server
// sends us - station names, titles, homepage URLs. They are regression-tested in
// test/frontend.test.js and must not be changed casually.

// ---------------------------------------------------------------------
// Formatting: Swedish convention (decimal comma, space as
// thousands separator, YYYY-MM-DD HH:MM:SS) - keeps the numbers readable
// for the (Swedish-speaking) audience the UI targets.
// ---------------------------------------------------------------------

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// esc() stops an attacker breaking out of an attribute, but says nothing about the
// URL's *scheme* - and every URL we put in an href comes from the remote server
// (station homepage from the icy-url header, and so on). "javascript:..." survives
// escaping untouched and would run in this page's origin on a click, so anything
// that isn't plain http/https is rendered as text instead of as a link.
function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function fmtNumber(n, decimals = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Math.round(n).toLocaleString('sv-SE');
}

// Seconds as "12,3 s" under a minute, otherwise "X min Y s" or "X h Y min"
// - so large delay/duration values (e.g. 10 000 s) stay easy to read.
function fmtDuration(totalSeconds, decimals = 1) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '–';
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(totalSeconds);
  if (abs < 60) return `${sign}${fmtNumber(abs, decimals)} s`;
  const whole = Math.round(abs);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${sign}${h} h ${m} min` : `${sign}${m} min ${s} s`;
}

function fmtDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Heading/value name with a hover explanation from STREAM_TERMS (terms.js), as a
// native title tooltip. Elements without a matching key get no title attribute.
function withHint(tag, label, key) {
  const text = STREAM_TERMS[key];
  const titleAttr = text ? ` title="${esc(text)}"` : '';
  return `<${tag}${titleAttr}>${esc(label)}</${tag}>`;
}

