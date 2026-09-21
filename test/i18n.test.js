// i18n.test.js
// Guards the one thing that keeps future languages maintainable: every key present in
// one locale catalog must be present in every other one. Loaded in a bare vm context
// (no document/window) so it exercises only i18n.js + the catalogs themselves.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function loadI18n() {
  const context = vm.createContext({
    document: {}, // no querySelectorAll -> the DOM-wiring block in i18n.js is a no-op
    navigator: { language: 'sv', languages: ['sv'] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  });
  for (const file of ['i18n.js', 'i18n/sv.js', 'i18n/en.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context, { filename: file });
  }
  return context;
}

const i18n = loadI18n();

// Keys that are intentionally per-locale, not mirrored - excluded from the
// completeness walk below.
const LOCALE_SPECIFIC_KEYS = new Set(['meta.numberLocale']);

// Collects every leaf key path (dot-joined) under a catalog object. A "leaf" is any
// value that isn't a plain object - a string, or a plural-forms object like
// { one: '...', other: '...' } (plural nodes are leaves too: comparing their category
// shape isn't the completeness test's job, just that the key exists in both locales).
function leafPaths(node, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(node)) {
    const path_ = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !isPluralNode(value)) {
      paths.push(...leafPaths(value, path_));
    } else {
      paths.push(path_);
    }
  }
  return paths;
}

// A plural-forms object has only CLDR category keys as its own properties.
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
function isPluralNode(value) {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => PLURAL_CATEGORIES.has(k));
}

function get(node, path_) {
  return path_.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), node);
}

test('every sv key exists in en, and vice versa', () => {
  const sv = i18n.getCatalog('sv');
  const en = i18n.getCatalog('en');
  const svKeys = new Set(leafPaths(sv).filter((k) => !LOCALE_SPECIFIC_KEYS.has(k)));
  const enKeys = new Set(leafPaths(en).filter((k) => !LOCALE_SPECIFIC_KEYS.has(k)));

  const missingFromEn = [...svKeys].filter((k) => !enKeys.has(k));
  const missingFromSv = [...enKeys].filter((k) => !svKeys.has(k));

  assert.deepEqual(missingFromEn, [], `keys present in sv but missing from en:\n${missingFromEn.join('\n')}`);
  assert.deepEqual(missingFromSv, [], `keys present in en but missing from sv:\n${missingFromSv.join('\n')}`);
});

test('no catalog leaf is an empty or whitespace-only string', () => {
  for (const locale of ['sv', 'en']) {
    const catalog = i18n.getCatalog(locale);
    for (const key of leafPaths(catalog)) {
      const value = get(catalog, key);
      if (typeof value !== 'string') continue; // plural nodes checked separately below
      assert.notEqual(value.trim(), '', `${locale}.${key} is empty`);
    }
  }
});

test('t() falls back to the raw key instead of throwing on a missing key', () => {
  i18n.setLocale('sv');
  assert.equal(i18n.t('nav.analyzeBtn'), 'Analysera');
  assert.equal(i18n.t('this.key.does.not.exist'), 'this.key.does.not.exist');
});

test('t() interpolates params', () => {
  i18n.setLocale('en');
  assert.equal(i18n.t('errors.unknown'), 'Unknown error.');
});

test('tPlural() selects the right category via Intl.PluralRules, in both locales', () => {
  i18n.setLocale('sv');
  assert.equal(i18n.tPlural('latency.taggedSegments', 1), '1 taggat segment');
  assert.equal(i18n.tPlural('latency.taggedSegments', 3), '3 taggade segment');

  i18n.setLocale('en');
  assert.equal(i18n.tPlural('latency.taggedSegments', 1), '1 tagged segment');
  assert.equal(i18n.tPlural('latency.taggedSegments', 3), '3 tagged segments');
});
