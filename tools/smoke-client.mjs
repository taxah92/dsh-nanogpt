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
 * The first pass evaluates the bundle under a minimal React stub and checks
 * `apply`; the second pass renders the provider card through a small React
 * stand-in and checks key fields, both pickers, the per-model toggle, the
 * provider select, and the two-namespace Apply write.
 *
 * The bundle requires only `react`, so this test carries its own shim and does
 * not depend on another checkout's sandbox loader (which keeps the published
 * package self-contained).
 *
 * Usage: node plugins/dsh-nanogpt/tools/smoke-client.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** Minimal `require` for the bundle: it asks only for `react`. */
function requireShim(id) {
  if (id !== 'react') return {};
  return {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
  };
}

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
    get: (ns) => ({
      getSnapshot: () => ({
        value:
          ns === 'llm-pi-ai'
            ? { providers: { nanogpt: { models: [] } } }
            : { balanceModels: [], modelProviders: {} },
        revision: 0,
        writable: true,
        status: 'ready',
      }),
      subscribe: () => () => {},
      mutate: async () => true,
    }),
  },
  remote: {
    credentials: {
      set: async () => ({ ok: true }),
      unset: async () => ({ ok: true }),
    },
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

// ---------------------------------------------------------------------------
// Component render check with a minimal React stub. The bundle closes over the
// loader's React stub, so it is evaluated a second time with a React whose
// createElement builds a tree, whose hooks return values, and whose handlers we
// can invoke from the tree. This catches render-time errors (a malformed hook
// order, a missing translation, a stale binding) that `apply` alone cannot.
// ---------------------------------------------------------------------------

let hookOverrides = [];
const ReactMock = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  },
  useState(initial) {
    const value = hookOverrides.length > 0 ? hookOverrides.shift() : (typeof initial === 'function' ? initial() : initial);
    return [value, () => {}];
  },
  useEffect(fn) {
    fn();
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
  Fragment: Symbol('Fragment'),
};

let spec2;
const sandbox2 = {
  window: { __ModuleLoader__: { load(value) { spec2 = value; } } },
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
vm.createContext(sandbox2);
vm.runInContext(source, sandbox2, { filename: 'dsh-nanogpt/client.js' });
const bundled = spec2.factory((id) => (id === 'react' ? ReactMock : requireShim(id)));

const providerRequests = [];
const storeSnapshot = {
  models: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      rate: 1,
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['text', 'image'],
      reasoningEfforts: { off: 'none', high: 'high' },
      toolCalling: true,
    },
    {
      id: 'z-ai/glm-5',
      name: 'GLM 5',
      rate: 2,
      contextWindow: 1000000,
      maxTokens: 131072,
      input: ['text'],
      toolCalling: true,
    },
  ],
  allModels: [
    {
      id: 'openai/gpt-6.1-sol',
      name: 'GPT 6.1 Sol',
      included: false,
      price: { prompt: 2, completion: 10 },
      contextWindow: 1050000,
      maxTokens: 128000,
      input: ['text', 'image'],
      toolCalling: true,
    },
  ],
  usage: { weekly: { used: 1000, remaining: 59999000, percentUsed: 0.0017, resetAt: 1794182400000 }, dailyImages: null },
  usageError: null,
  loadingUsage: false,
  modelsError: null,
  modelsStale: false,
  loadingModels: false,
  allModelsError: null,
  allModelsStale: false,
  loadingAllModels: false,
  keys: {
    subscription: { configured: true, billingMode: 'subscription_only', paidSpendPolicyAllowsBalance: false, writable: true, masked: 'sk-nano-…9377' },
    balance: { configured: false, billingMode: null, paidSpendPolicyAllowsBalance: null, writable: true, masked: null },
  },
  keysError: null,
  loadingKeys: false,
  balance: { usdBalance: 0.10245934 },
  balanceError: null,
  loadingBalance: false,
  providers: {
    'z-ai/glm-5': {
      status: 'ready',
      data: {
        supportsProviderSelection: true,
        providers: [
          { id: 'novita', displayName: 'Novita', available: true, inputPer1M: 0.1575, outputPer1M: 0.63 },
          { id: 'moonshot', displayName: 'Moonshot', available: false, inputPer1M: 0.99, outputPer1M: 4.2 },
        ],
      },
    },
  },
};
const storeStub = {
  subscribe: () => () => {},
  getSnapshot: () => storeSnapshot,
  loadModels: () => {},
  loadAllModels: () => {},
  loadUsage: () => {},
  loadKeys: () => {},
  loadBalance: () => {},
  loadProviders: (id) => {
    providerRequests.push(id);
  },
};
const formMutates = [];
const ownMutates = [];
const formStub = {
  subscribe: () => () => {},
  getSnapshot: () => ({
    status: 'ready',
    revision: 4,
    writable: true,
    value: {
      providers: {
        nanogpt: {
          models: [
            {
              id: 'deepseek/deepseek-v4.1-flash',
              name: 'DeepSeek V4.1 Flash',
              contextWindow: 1000000,
              maxTokens: 384000,
              input: ['text', 'image'],
            },
            { id: 'z-ai/glm-5', name: 'GLM 5', contextWindow: 1000000, maxTokens: 131072, input: ['text'] },
          ],
        },
      },
    },
  }),
  mutate: async (ops) => {
    formMutates.push(ops);
    return true;
  },
};
const ownStub = {
  subscribe: () => () => {},
  getSnapshot: () => ({
    status: 'ready',
    revision: 7,
    writable: true,
    value: {
      apiKeyEnv: 'NANOGPT_API_KEY',
      paygoKeyEnv: 'NANOGPT_PAYGO_API_KEY',
      balanceModels: [],
      modelProviders: {},
    },
  }),
  mutate: async (ops) => {
    ownMutates.push(ops);
    return true;
  },
};

const rendered = [];
const renderCtx = {
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') rendered.push(dispose);
    return () => {};
  },
  locale: { bind: () => (key) => key, register: () => () => {} },
  configForms: { get: (ns) => (ns === 'llm-pi-ai' ? formStub : ownStub) },
  remote: { credentials: { set: async () => ({ ok: true }), unset: async () => ({ ok: true }) } },
  slots: {
    inject(_name, fn) {
      fn();
    },
    register(description, component) {
      rendered.push({ description, component });
      return () => {};
    },
  },
};
bundled.apply(renderCtx);
const renderCard = rendered.find(
  (entry) => entry.description?.name === 'settings.models.provider-card' && entry.description?.key === 'llm-pi-ai',
);
check('second bundle registered the card', renderCard !== undefined && typeof renderCard.component === 'function');

/** Render one element tree, unwrapping function components (the card wrapper). */
function renderComponent(component, props) {
  let out = component(props);
  while (out !== null && typeof out.type === 'function') out = out.type(out.props);
  return out;
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  visit(node);
  const children = node.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) walk(child, visit);
}

function hasText(node, needle) {
  let found = false;
  walk(node, (current) => {
    const children = current.props?.children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === 'string' && child.includes(needle)) found = true;
    }
  });
  return found;
}

function findElement(root, predicate) {
  let found;
  walk(root, (node) => {
    if (found === undefined && predicate(node)) found = node;
  });
  return found;
}

function findButton(root, text) {
  return findElement(root, (node) => node.type === 'button' && typeof node.props?.onClick === 'function' && hasText(node, text));
}

const cardProps = {
  provider: { provider: 'nanogpt' },
  keyConfigured: true,
  t: (key) => key,
  form: formStub,
  ownForm: ownStub,
  remote: { credentials: { set: async () => ({ ok: true }), unset: async () => ({ ok: true }) } },
  store: storeStub,
};

console.log('card render');
{
  hookOverrides = [];
  const tree = renderComponent(renderCard.component, cardProps);
  check('card renders', tree !== null && tree !== undefined);
  check('two key fields', hasText(tree, 'card.subscriptionKey') && hasText(tree, 'card.paygoKey'));
  check('key billing mode visible', hasText(tree, 'card.keyBilling'));
  check('balance row', hasText(tree, 'card.balance'));
  check('model counter', hasText(tree, 'card.counts'));
  check('both pickers offered', hasText(tree, 'card.subscriptionPicker') && hasText(tree, 'card.allPicker'));
}

console.log('subscription picker render');
{
  hookOverrides = ['subscription'];
  const tree = renderComponent(renderCard.component, cardProps);
  check('configured model row rendered', hasText(tree, 'DeepSeek V4.1 Flash'));
  check('rate ×2 badge rendered', hasText(tree, '×2'));
  const before = providerRequests.length;
  const balanceButton = findButton(tree, 'card.spendBalance');
  check('balance toggle button rendered', balanceButton !== undefined);
  if (balanceButton !== undefined) balanceButton.props.onClick();
  check('turning balance on requests providers', providerRequests.length > before);
}

console.log('balance row with provider select');
{
  hookOverrides = [
    'subscription',
    '',
    true,
    {
      selected: new Set(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5']),
      billing: new Map([['deepseek/deepseek-v4.1-flash', 'subscription'], ['z-ai/glm-5', 'balance']]),
      provider: new Map([['z-ai/glm-5', 'novita']]),
    },
  ];
  const tree = renderComponent(renderCard.component, cardProps);
  const select = findElement(tree, (node) => node.type === 'select');
  check('provider select rendered on the balance row', select !== undefined);
  check('provider options include Auto and Novita', select !== undefined && hasText(select, 'card.providerAuto') && hasText(select, 'Novita'));
  const auto = select === undefined ? undefined : findElement(select, (node) => node.type === 'option');
  check('auto is the first option', auto !== undefined && auto.props.children === 'card.providerAuto');
  check('missing balance key warning', hasText(tree, 'card.warnNoPaygo'));

  const applyButton = findButton(tree, 'card.apply');
  check('apply button rendered', applyButton !== undefined);
  if (applyButton !== undefined) {
    await applyButton.props.onClick();
    check('models written to llm-pi-ai', formMutates.length === 1, String(formMutates.length));
    const ownOps = ownMutates.at(-1) ?? [];
    const balanceOp = ownOps.find((op) => op.path?.join('.') === 'balanceModels');
    check('balance ids written to the plugin config', Array.isArray(balanceOp?.value) && balanceOp.value.includes('z-ai/glm-5'), JSON.stringify(balanceOp));
    const providerOp = ownOps.find((op) => op.path?.join('.') === 'modelProviders');
    check('pinned provider written to the plugin config', providerOp?.value?.['z-ai/glm-5'] === 'novita', JSON.stringify(providerOp));
  }
}

for (const dispose of rendered.splice(0).reverse()) {
  if (typeof dispose === 'function') dispose();
}

if (failures > 0) {
  console.error(`smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('smoke: ok');
