#!/usr/bin/env node
/**
 * Stub-loader smoke test for `client.js`.
 *
 * The browser bundle is a `window.__ModuleLoader__.load({ id, factory })`
 * artifact; this evaluates it under a minimal DOM sandbox with a recording
 * context, then checks that `apply`:
 *
 *   - registered the provider card on the `llm-pi-ai` settings namespace;
 *   - injected its stylesheet;
 *   - placed the allowance row INSIDE the usage-stats block's `<button>`,
 *     before the `unifiedMain` (today) row — the bug this test exists for is a
 *     row appended to the block's wrapper instead of the block itself.
 *
 * It does not render React components — the sandbox React is a stub. It
 * catches syntax errors, bad imports, and a wrong slot name/key before the
 * browser sees them.
 *
 * Usage: node tools/smoke-client.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Minimal DOM element the footer-row installer can build, query, and move. */
function element(tagName = 'span') {
  return {
    tagName,
    className: '',
    textContent: '',
    title: '',
    style: {},
    parentNode: null,
    children: [],
    setAttribute() {},
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = this;
        this.children.push(node);
      }
    },
    appendChild(node) {
      node.parentNode = this;
      this.children.push(node);
      return node;
    },
    insertBefore(node, reference) {
      node.parentNode = this;
      const at = this.children.indexOf(reference);
      if (at === -1) this.children.push(node);
      else this.children.splice(at, 0, node);
      return node;
    },
    removeChild(node) {
      node.parentNode = null;
      this.children = this.children.filter((child) => child !== node);
      return node;
    },
    remove() {
      if (this.parentNode !== null) this.parentNode.removeChild(this);
    },
    contains(node) {
      return this.children.includes(node);
    },
    querySelector(selector) {
      const matches = (node) => {
        if (selector === 'button') return node.tagName === 'button';
        const attribute = selector.match(/^\[class\*="(.+)"\]$/);
        if (attribute !== null) return String(node.className).includes(attribute[1]);
        return false;
      };
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child)) return child;
          const hit = walk(child);
          if (hit !== null) return hit;
        }
        return null;
      };
      return walk(this);
    },
  };
}

// Simulate the usage-stats footer: a wrapper carrying the marker attribute and
// the visible block as its <button> child, with the Go row and the today row.
const usageRoot = element('div');
usageRoot.className = 'UR1xtW_root';
usageRoot.setAttribute('data-usage-stats-footer', '');
const usageBlock = element('button');
usageBlock.className = 'UR1xtW_unified';
const goRow = element('span');
goRow.className = 'UR1xtW_unifiedGoRow';
const todayRow = element('span');
todayRow.className = 'UR1xtW_unifiedMain';
usageBlock.append(goRow, todayRow);
usageRoot.appendChild(usageBlock);

const documentStub = {
  head: element('head'),
  body: element('body'),
  createElement: (tagName) => element(tagName),
  querySelector: (selector) => (selector === '[data-usage-stats-footer]' ? usageRoot : null),
};

class MutationObserverStub {
  observe() {}
  disconnect() {}
}

/** Permissive callable proxy for anything the bundle requires but we do not provide. */
function anything() {
  const target = function () {};
  return new Proxy(target, {
    get: () => anything(),
    apply: () => anything(),
    construct: () => anything(),
  });
}

/** React stub: the bundle only defines components here, it does not render them. */
const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useSyncExternalStore: () => ({}),
};

const requireShim = (id) => (id === 'react' ? reactStub : anything());

let spec;
const sandbox = {
  window: { __ModuleLoader__: { load(value) { spec = value; } } },
  document: documentStub,
  MutationObserver: MutationObserverStub,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  AbortController,
  AbortSignal,
  URL,
  Promise,
  Object,
  Array,
  Math,
  JSON,
  Date,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Error,
  TypeError,
  RangeError,
  String,
  Number,
  Boolean,
  RegExp,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'dsh-nanogpt/client.js' });

if (spec === undefined) {
  console.error('smoke: client.js did not call window.__ModuleLoader__.load');
  process.exit(1);
}
if (spec.id !== 'dsh-nanogpt') {
  console.error(`smoke: unexpected module id ${String(spec.id)}`);
  process.exit(1);
}

const exports = spec.factory(requireShim);
const registrations = [];
const disposers = [];
const ctx = {
  effect(fn) {
    if (typeof fn === 'function') {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    }
    return () => {};
  },
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  configForms: {
    get: () => ({
      getSnapshot: () => ({ value: undefined, revision: 0, writable: true, status: 'ready' }),
      subscribe: () => () => {},
      mutate: async () => true,
    }),
  },
  slots: {
    inject(_name, fn) {
      if (typeof fn === 'function') fn();
    },
    register(description, component) {
      registrations.push({ description, component });
      return () => {};
    },
  },
};

exports.apply(ctx);

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const card = registrations.find(
  (entry) => entry.description.name === 'settings.models.provider-card' && entry.description.key === 'llm-pi-ai',
);
check('provider card registered on llm-pi-ai', card !== undefined && typeof card.component === 'function');
check('stylesheet injected', documentStub.head.children.length > 0);

const row = usageBlock.children.find((child) => String(child.className).includes('dsh-ng-footerRow'));
check('allowance row is inside the usage-stats block', row !== undefined);
check('row sits before the today row', row !== undefined && usageBlock.children.indexOf(row) < usageBlock.children.indexOf(todayRow));
check('row is not a sibling of the block', usageRoot.children.length === 1, String(usageRoot.children.length));
check('row has two chips', row !== undefined && row.children.length === 3, String(row?.children.length));

for (const dispose of disposers) dispose();
check('disposer removes the row', row !== undefined && row.parentNode === null);

if (failures > 0) {
  console.error(`smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('smoke: ok');
