// i18nBootstrap.test.js
// Regression test for a real bug: i18n.js's own <script> tag executes before
// i18n/sv.js and i18n/en.js have run (they're loaded right after it in index.html),
// so applying translations to the DOM at that point would run against empty catalogs
// and leave every data-i18n element showing its raw key. None of the other frontend
// tests catch this because their document stubs don't implement querySelectorAll, so
// i18n.js's DOM-wiring block never runs there at all - this test builds just enough of
// a fake DOM to actually exercise it, in the same script order the browser uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function makeElement(attrs = {}) {
  return {
    _attrs: { ...attrs },
    textContent: '',
    innerHTML: '',
    value: '',
    getAttribute(name) {
      return name in this._attrs ? this._attrs[name] : null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    addEventListener() {},
  };
}

// Builds just the handful of elements i18n.js's bootstrap block touches: one of each
// data-i18n* variant (mirroring real elements in index.html), plus the switcher.
function makeFakeDocument() {
  const analyzeBtn = makeElement({ 'data-i18n': 'nav.analyzeBtn' });
  const urlInput = makeElement({ 'data-i18n-placeholder': 'nav.urlPlaceholder' });
  const logBtn = makeElement({ 'data-i18n-title': 'nav.logBtnTitle' });
  const faqIntro = makeElement({ 'data-i18n-html': 'faq.intro' });
  const switcher = makeElement({ id: 'lang-switcher' });

  const byId = { 'lang-switcher': switcher };
  const all = [analyzeBtn, urlInput, logBtn, faqIntro, switcher];

  const domContentLoadedListeners = [];

  return {
    elements: { analyzeBtn, urlInput, logBtn, faqIntro, switcher },
    document: {
      documentElement: { lang: '' },
      readyState: 'loading',
      getElementById: (id) => byId[id] || null,
      querySelectorAll: (selector) => {
        const attr = selector.slice(1, -1); // '[data-i18n]' -> 'data-i18n'
        return all.filter((el) => el.getAttribute(attr) !== null);
      },
      addEventListener(type, fn) {
        if (type === 'DOMContentLoaded') domContentLoadedListeners.push(fn);
      },
      _fireDOMContentLoaded() {
        this.readyState = 'complete';
        domContentLoadedListeners.forEach((fn) => fn());
      },
    },
  };
}

test('translations are not applied before DOMContentLoaded, and are applied once it fires', () => {
  const { document, elements } = makeFakeDocument();
  const context = vm.createContext({
    document,
    navigator: { language: 'sv', languages: ['sv'] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  });

  // Loaded in the exact order index.html uses: i18n.js first, catalogs after.
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'i18n.js'), 'utf8'), context, { filename: 'i18n.js' });

  // i18n.js has now fully executed (matching the moment its own <script> tag finishes
  // in a real page load) - i18n/sv.js and i18n/en.js have not run yet, so the catalogs
  // are still empty. If the bootstrap applied translations synchronously here (the
  // bug), these elements would already show their raw, unresolved key.
  assert.equal(elements.analyzeBtn.textContent, '', 'must not translate before catalogs exist');
  assert.equal(elements.faqIntro.innerHTML, '', 'must not translate before catalogs exist');

  vm.runInContext(fs.readFileSync(path.join(publicDir, 'i18n', 'sv.js'), 'utf8'), context, { filename: 'i18n/sv.js' });
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'i18n', 'en.js'), 'utf8'), context, { filename: 'i18n/en.js' });

  // Still not applied - only DOMContentLoaded triggers the first pass.
  assert.equal(elements.analyzeBtn.textContent, '');

  document._fireDOMContentLoaded();

  assert.equal(elements.analyzeBtn.textContent, 'Analysera');
  assert.equal(elements.urlInput.getAttribute('placeholder'), 'Ström-URL – HLS, DASH eller Icecast/radio');
  assert.equal(elements.logBtn.getAttribute('title'), 'Följ strömmen över tid i stället för att ta en ögonblicksbild');
  assert.match(elements.faqIntro.innerHTML, /Audio analyzer hämtar och analyserar en ljudström/);
});

test('switching language re-applies every data-i18n* variant, including data-i18n-html', () => {
  const { document, elements } = makeFakeDocument();
  const context = vm.createContext({
    document,
    navigator: { language: 'sv', languages: ['sv'] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  });
  for (const file of ['i18n.js', 'i18n/sv.js', 'i18n/en.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context, { filename: file });
  }
  document._fireDOMContentLoaded();
  assert.equal(elements.analyzeBtn.textContent, 'Analysera');

  context.setLocale('en');

  assert.equal(elements.analyzeBtn.textContent, 'Analyze');
  assert.equal(elements.urlInput.getAttribute('placeholder'), 'Stream URL – HLS, DASH or Icecast/radio');
  assert.equal(elements.logBtn.getAttribute('title'), 'Follow the stream over time instead of taking a snapshot');
  assert.match(elements.faqIntro.innerHTML, /Audio analyzer fetches and analyzes an audio stream/);
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(elements.switcher.value, 'en');
});
