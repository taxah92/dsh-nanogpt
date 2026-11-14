#!/usr/bin/env node
/**
 * Locale check for `dsh-nanogpt`: the client dictionaries and the plugin-card
 * metadata the panel paints before activation.
 *
 * Two independent surfaces feed the three languages:
 *
 *   1. `client.js` carries the `EN`, `RU` and `ZH` dictionaries the Client
 *      locale service binds to the `nanogpt` namespace. A key missing from one
 *      language silently falls back through the locale chain, and a wrong
 *      `{placeholder}` renders the brace text to the user, so both are checked
 *      here.
 *   2. `locale/<language>.json` carries the card text of the plugin inventory.
 *      `readPluginMeta` (dsh-app-boot) reads it ONLY from a top-level `meta`
 *      object: a flat `{title, description}` file — what 0.1.0 shipped — is
 *      dropped without a word and the card falls back to the package name.
 *      That silent downgrade is what this check catches, through the installed
 *      harness itself.
 *
 * Run from the plugin directory: `node tools/check-locale.mjs`.
 * Exit code 1 lists every problem; 0 means every language agrees.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import process from 'node:process';

/**
 * Where the harness packages live. Run from inside a profile, the bare import
 * resolves through the profile module tree; DSH_PACKAGES covers a bare checkout.
 */
const DSH_PACKAGES =
  process.env.DSH_PACKAGES ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const LANGUAGES = ['en', 'ru', 'zh'];
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

const problems = [];
const note = (message) => problems.push(message);
const ok = (message) => console.log(`  ok   ${message}`);

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** The `const NAME = { ... }` object literal from the bundle, evaluated as data. */
function dictionary(name) {
  const marker = `const ${name} = {`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`client.js: ${marker} not found — did the bundle change shape?`);
  let depth = 0;
  let quote = null;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(source.indexOf('{', start), index + 1);
        return vm.runInNewContext(`(${body})`, Object.create(null), { timeout: 1000 });
      }
    }
  }
  throw new Error(`client.js: ${marker} is not closed`);
}

/** `{name}` placeholders of one template. */
function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

const dictionaries = new Map();
try {
  for (const language of LANGUAGES) dictionaries.set(language, dictionary(language.toUpperCase()));
} catch (error) {
  note(String(error?.message ?? error));
}

if (dictionaries.size === LANGUAGES.length) {
  const english = dictionaries.get('en');
  const keys = Object.keys(english);
  ok(`client dictionaries: ${LANGUAGES.join('/')} loaded, ${keys.length} keys in en`);

  if (!/\blocale\.register\(NS,\s*\{[^}]*\ben:\s*EN\b[^}]*\bru:\s*RU\b[^}]*\bzh:\s*ZH\b/u.test(source)) {
    note('client.js does not register all three dictionaries: expected locale.register(NS, { en: EN, ru: RU, zh: ZH })');
  } else {
    ok('client.js registers en, ru and zh dictionaries on the `nanogpt` namespace');
  }

  const cyrillic = /[\u0400-\u04FF]/u;
  for (const language of LANGUAGES) {
    const dictionaryOf = dictionaries.get(language);
    const foreign = Object.keys(dictionaryOf).filter((key) => !keys.includes(key));
    if (foreign.length > 0) note(`client: ${language} has keys absent from en — ${foreign.join(', ')}`);
    for (const key of keys) {
      const value = dictionaryOf[key];
      if (typeof value !== 'string' || value.trim() === '') {
        note(`client: ${language} "${key}" is not a non-empty string`);
        continue;
      }
      if (language !== 'ru' && cyrillic.test(value)) note(`client: ${language} "${key}" contains Cyrillic text`);
      const englishValue = english[key];
      if (typeof englishValue !== 'string') continue;
      const expected = placeholders(englishValue);
      const actual = placeholders(value);
      if (expected.join(',') !== actual.join(',')) {
        note(`client: ${language} "${key}" placeholders differ from en — {${expected.join('} {')}} vs {${actual.join('} {')}}`);
      }
    }
    const missing = keys.filter((key) => dictionaryOf[key] === undefined);
    if (missing.length > 0) note(`client: ${language} misses keys — ${missing.join(', ')}`);
  }
  if (problems.length === 0) ok('client dictionaries share every key and every {placeholder}');
}

// ── Plugin-card metadata: locale/<language>.json ────────────────────────────
const localeDir = new URL('../locale/', import.meta.url);
const localeFiles = fs
  .readdirSync(localeDir)
  .filter((name) => name.endsWith('.json'))
  .sort();
if (localeFiles.length === 0) note('locale/: no display metadata — the panel card falls back to the package name');

const localeFields = new Map();
for (const name of localeFiles) {
  const language = name.slice(0, -'.json'.length);
  if (!LANGUAGE_ID.test(language)) note(`locale/${name}: the filename must be a language id`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(new URL(name, localeDir), 'utf8'));
  } catch (error) {
    note(`locale/${name}: not valid JSON — ${error.message}`);
    continue;
  }
  const extra = Object.keys(parsed).filter((key) => key !== 'meta');
  if (extra.length > 0) {
    note(`locale/${name}: unexpected top-level ${extra.join('/')} — only "meta" is read, a flat file is dropped`);
  }
  const meta = parsed?.meta;
  if (meta === undefined) {
    note(`locale/${name}: no top-level "meta" — readPluginMeta drops the file and the card shows the package name`);
  }
  for (const field of ['title', 'description']) {
    const value = meta?.[field];
    if (typeof value !== 'string' || value.trim() === '') note(`locale/${name}: meta.${field} must be a non-empty string`);
    if (language !== 'ru' && typeof value === 'string' && /[\u0400-\u04FF]/u.test(value)) {
      note(`locale/${name}: meta.${field} contains Cyrillic text`);
    }
  }
  localeFields.set(language, Object.keys(meta ?? {}).sort().join(','));
}
for (const language of LANGUAGES) {
  if (!localeFiles.includes(`${language}.json`)) note(`locale/${language}.json is required for a ${LANGUAGES.join('/')} card`);
}
if (!localeFields.has('en')) note('locale/en.json is required — the reader keys every other language off it');
const shapes = new Set(localeFields.values());
if (shapes.size > 1) {
  const seen = [...localeFields].map(([language, fields]) => `${language}: ${fields || '(no fields)'}`).join('; ');
  note(`locale/: the files disagree on fields — ${seen}`);
}
if (problems.length === 0) ok(`locale/: ${localeFiles.join(', ')} carry meta.title and meta.description`);

// ── Packaging: the panel can only read exported resources ────────────────────
try {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const exports = manifest.exports ?? {};
  if (exports['./locale/*.json'] === undefined) note('package.json: exports is missing "./locale/*.json"');
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.includes('locale') && !files.includes('locale/*.json')) {
    note('package.json: files does not package the locale directory');
  }
} catch (error) {
  note(`package.json: cannot be read — ${error?.message ?? error}`);
}

// ── The reader itself, through the installed harness ────────────────────────
// It must answer with a translation map per language, not with the
// package-name fallback a flat locale file produces.
try {
  const { readPluginMeta } = await import(`${DSH_PACKAGES}/dsh-app-boot/lib/index.js`);
  if (typeof readPluginMeta !== 'function') {
    note('this dsh has no readPluginMeta — the card metadata cannot be verified');
  } else {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
    const meta = readPluginMeta(manifest.name, manifestUrl.href);
    if (meta === undefined) note('readPluginMeta returned nothing — the panel sees no card text at all');
    else {
      for (const field of ['title', 'description']) {
        const value = meta[field];
        if (typeof value === 'string') {
          note(`readPluginMeta fell back to ${field} "${value}" — the locale files are not being read`);
          continue;
        }
        for (const language of localeFields.keys()) {
          if (value?.[language] === undefined) note(`readPluginMeta has no "${language}" ${field} — locale/${language}.json was not read`);
        }
        if (value?.en === undefined) note(`readPluginMeta has no English fallback ${field}`);
      }
      if (problems.length === 0) ok(`readPluginMeta returns en/ru/zh ${'title'} and ${'description'} maps`);
    }
  }
} catch (error) {
  note(`the live metadata check could not run: ${error?.message ?? error}`);
}

if (problems.length > 0) {
  console.error(`check-locale: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  FAIL ${problem}`);
  process.exit(1);
}
console.log('check-locale: en, ru and zh agree on the client strings and the plugin card');