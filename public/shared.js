// shared.js
// Helpers both pages need: the snapshot page (app.js) and the stream log (log.js).
// A classic script, loaded after i18n.js and the locale catalogs so t()/tPlural()/
// getLocale() are available here, and before app.js/log.js/file.js so everything below
// lands in the same global scope and both callers use it unchanged.
//
// esc() and safeHttpUrl() are the XSS defences for everything a remote stream server
// sends us - station names, titles, homepage URLs. They are regression-tested in
// test/frontend.test.js and must not be changed casually.

// ---------------------------------------------------------------------
// Formatting: number/date formatting follows the active UI language (see i18n.js).
// Each catalog's meta.numberLocale picks the convention (decimal comma vs point,
// thousands separator) - sv-SE by default, matching the tool's original audience.
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

function numberLocaleTag() {
  return getCatalog(getLocale())?.meta?.numberLocale || 'en-GB';
}

function fmtNumber(n, decimals = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString(numberLocaleTag(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Math.round(n).toLocaleString(numberLocaleTag());
}

// Seconds as "12.3 s" under a minute, otherwise "X min Y s" or "X h Y min"
// - so large delay/duration values (e.g. 10 000 s) stay easy to read. Unit words
// come from the active locale's catalog (units.second/minute/hour).
function fmtDuration(totalSeconds, decimals = 1) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '–';
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(totalSeconds);
  if (abs < 60) return `${sign}${fmtNumber(abs, decimals)} ${t('units.second')}`;
  const whole = Math.round(abs);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0
    ? `${sign}${h} ${t('units.hour')} ${m} ${t('units.minute')}`
    : `${sign}${m} ${t('units.minute')} ${s} ${t('units.second')}`;
}

function fmtDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Heading/value name with a hover explanation from the active catalog's terms.*
// namespace (formerly terms.js's STREAM_TERMS), as a native title tooltip. Elements
// without a matching key get no title attribute - t()'s "return the raw key on miss"
// fallback doubles as that check.
function withHint(tag, label, key) {
  const termKey = 'terms.' + key;
  const text = t(termKey);
  const titleAttr = text !== termKey ? ` title="${esc(text)}"` : '';
  return `<${tag}${titleAttr}>${esc(label)}</${tag}>`;
}

// Turns a server AppError (or an ffmpeg.js warning object of the same shape) into
// localized, display-ready text. err.i18nKey/err.params are what the server sends for
// anything it wants the user to read; err.message is an English, developer-facing
// fallback (logs, non-browser API consumers, or an older server that predates a given
// key) used whenever no i18nKey is present or the key isn't recognised here.
function errorText(err) {
  if (!err) return '';
  if (!err.i18nKey) return err.message || t('errors.unknown');
  const params = { ...err.params };
  // The one case where a param needs a second, code-keyed lookup before
  // interpolation (the DNS/TLS cause code -> a human reason phrase). Extend this
  // dispatch, don't build a generic one, if a second case ever needs it.
  if (err.i18nKey === 'errors.upstreamUnreachable') {
    params.reason = t(`errors.upstreamUnreachableReasons.${params.causeCode}`);
  }
  const translated = t(err.i18nKey, params);
  return translated !== err.i18nKey ? translated : err.message || t('errors.unknown');
}

// ---------------------------------------------------------------------
// Fields: one description, two outputs
// ---------------------------------------------------------------------
//
// Every value on this page is shown twice - as a <dl> row, and as a line in the text
// the Copy button produces - and they were written out separately in each place. They
// drifted, as duplicated lists do: the HLS copy text grew an Expires line the other two
// silently lacked, and the file view's copy text quietly omitted rows the page showed.
//
// A field is described once and both outputs are derived from it. `text` is the plain
// value, already formatted (fmtNumber/fmtDuration/…); `html` is only supplied when the
// page shows something richer than that plain text - a warning span, a link - and its
// producer is responsible for escaping it, like every other HTML fragment here.
// A falsy entry in a field list is skipped, so a conditional row can be written inline.
function field(label, termKey, text, html = null) {
  return { label, termKey, text, html };
}

function renderDl(fields) {
  const rows = fields
    .filter(Boolean)
    .map((f) => {
      const dt = f.termKey ? withHint('dt', f.label, f.termKey) : `<dt>${esc(f.label)}</dt>`;
      return `${dt}<dd>${f.html ?? esc(f.text)}</dd>`;
    })
    .join('');
  return `<dl>${rows}</dl>`;
}

function copyFields(add, fields) {
  for (const f of fields.filter(Boolean)) add(`${f.label}: ${f.text}`);
}

// ---------------------------------------------------------------------
// Who owns #results
// ---------------------------------------------------------------------
//
// Three views write into the same results area - the snapshot (app.js), the stream
// log (log.js) and the uploaded-file view (file.js) - and each of them awaits a
// request before it renders. Whoever is about to write takes the token first; anyone
// holding an older one stops touching shared state instead of overwriting the newer
// view's output.
//
// One token, not three: with a counter per view, "did someone else take over?" had no
// single answer, and each view could only invalidate itself. That left two real bugs -
// a log still starting up would wipe a finished analysis (its own stopStreamLog() is a
// no-op before the first poll), and an analysis cancelled by the file view left the
// Analysera button disabled with nothing left to re-enable it.
//
// Claiming also resets the chrome shared by all three (the button, the status line,
// the master→variant note), so no view can strand it in its own state. The new owner
// sets whatever it needs immediately after claiming.
//
// `owner` ('analyze'/'log'/'file') is a second, smaller piece of the same idea: a
// language switch (see i18n.js's onLocaleChange) needs to know which view currently
// holds #results so it can re-render just that one from cached data, without a page
// reload. It rides along on the same claim instead of being a separate mechanism.
let viewToken = 0;
let viewOwner = null;

function claimResults(owner = null) {
  viewToken++;
  viewOwner = owner;
  const btn = document.getElementById('analyze-btn');
  if (btn) btn.disabled = false;
  const status = document.getElementById('status');
  if (status) status.textContent = '';
  const info = document.getElementById('analyzed-url-info');
  if (info) {
    info.textContent = '';
    info.hidden = true;
  }
  return viewToken;
}

function ownsResults(token) {
  return token === viewToken;
}

function currentResultsOwner() {
  return viewOwner;
}

