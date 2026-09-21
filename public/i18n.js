// i18n.js
// Runtime only - no translated strings live here. Catalogs register themselves via
// registerCatalog() from i18n/<locale>.js, loaded right after this file and before
// shared.js/app.js/log.js/file.js so t()/tPlural() are available everywhere.
//
// Adding a language is additive: a new i18n/<locale>.js file, one entry in
// SUPPORTED_LOCALES, one <script> tag, one <option> in the switcher. See docs/i18n.md.

const SUPPORTED_LOCALES = ['sv', 'en']; // add 'de' here once i18n/de.js exists
const DEFAULT_LOCALE = 'sv';
const STORAGE_KEY = 'audioAnalyzer.locale';

const CATALOGS = {};
let currentLocale = null;
const localeChangeListeners = new Set();

function registerCatalog(locale, catalog) {
  CATALOGS[locale] = catalog;
}

// Test-facing accessor - `const CATALOGS` itself isn't reflected as a property on a
// vm context the way `function` declarations are, so tests reach it through this.
function getCatalog(locale) {
  return CATALOGS[locale];
}

function getSupportedLocales() {
  return SUPPORTED_LOCALES.slice();
}

function detectBrowserLocale() {
  const raw = (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [typeof navigator !== 'undefined' ? navigator.language : null];
  for (const candidate of raw) {
    const short = String(candidate || '').slice(0, 2).toLowerCase();
    if (SUPPORTED_LOCALES.includes(short)) return short;
  }
  return DEFAULT_LOCALE;
}

function initLocale() {
  let stored = null;
  try {
    stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    /* storage disabled (private browsing, test stub without one) - fall through */
  }
  currentLocale = SUPPORTED_LOCALES.includes(stored) ? stored : detectBrowserLocale();
  return currentLocale;
}

function getLocale() {
  return currentLocale || initLocale();
}

function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale) || locale === currentLocale) return;
  currentLocale = locale;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage disabled - the choice still applies for this session */
  }
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = locale;
  localeChangeListeners.forEach((fn) => fn(locale));
}

// Views call this at module load time to re-render themselves (from cached data) when
// the language changes, instead of the page reloading - see claimResults()/
// currentResultsOwner() in shared.js for which view is currently allowed to act.
function onLocaleChange(fn) {
  localeChangeListeners.add(fn);
  return () => localeChangeListeners.delete(fn);
}

function resolveEntry(locale, key) {
  let node = CATALOGS[locale];
  for (const part of key.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

// t(key, params?) - plain/parametrised string lookup. Falls back to DEFAULT_LOCALE if
// the active locale is missing the key (should never happen for a complete catalog -
// see test/i18n.test.js), then to the raw key as a last resort so a genuinely missing
// key is visibly wrong in the UI rather than throwing mid-render.
function t(key, params) {
  const locale = getLocale();
  let entry = resolveEntry(locale, key);
  if (entry === undefined) entry = resolveEntry(DEFAULT_LOCALE, key);
  if (entry === undefined || typeof entry === 'object') return key;
  return interpolate(entry, params);
}

// tPlural(key, count, params?) - key must resolve to an object of CLDR plural
// categories (e.g. { one: '...', other: '...' }). Intl.PluralRules picks the category
// per the active locale's actual plural rules - correct for languages with more than
// two categories too, at zero extra cost.
function tPlural(key, count, params = {}) {
  const locale = getLocale();
  let entry = resolveEntry(locale, key);
  if (entry === undefined) entry = resolveEntry(DEFAULT_LOCALE, key);
  if (entry === undefined || typeof entry !== 'object') return key;
  const category = new Intl.PluralRules(locale).select(count);
  const template = entry[category] ?? entry.other;
  return interpolate(template, { count, ...params });
}

// Declarative static-text wiring for index.html:
//   data-i18n            -> el.textContent = t(key)
//   data-i18n-html        -> el.innerHTML = t(key)   (trusted, developer-authored copy only - e.g. FAQ paragraphs with inline <code>/<strong>)
//   data-i18n-placeholder -> el.placeholder
//   data-i18n-title       -> el.title
// Guarded so it's a no-op under the test vm stubs (none of which implement
// querySelectorAll) and only ever runs in a real browser.
function applyStaticTranslations(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
}

if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
  document.documentElement.lang = getLocale();

  // This script runs before i18n/sv.js and i18n/en.js have executed (they're loaded
  // right after it, in index.html) - so calling applyStaticTranslations() straight
  // away would run against empty catalogs, and every data-i18n element would show its
  // raw key (e.g. "nav.analyzeBtn") instead of real text. DOMContentLoaded fires only
  // once the parser has finished the whole document, which - since none of these
  // <script> tags are async/defer - means every catalog has already registered by
  // then. document.readyState is 'loading' at the point this file runs for real (the
  // parser is paused mid-body fetching it), so the branch below is always taken in a
  // browser; the readState/addEventListener guards just keep this safe to no-op under
  // the DOM stubs test/*.test.js use, which lack querySelectorAll and never reach here.
  const applyInitialTranslations = () => applyStaticTranslations();
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', applyInitialTranslations);
  } else {
    applyInitialTranslations();
  }
  onLocaleChange(() => applyStaticTranslations());

  const switcher = document.getElementById('lang-switcher');
  if (switcher) {
    switcher.value = getLocale();
    switcher.addEventListener('change', () => setLocale(switcher.value));
    onLocaleChange((locale) => { switcher.value = locale; });
  }
}
