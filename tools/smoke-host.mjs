#!/usr/bin/env node
/**
 * Offline smoke test for the Host half's route wiring.
 *
 * Stubs `fetch` with a tiny fixture, mounts `apply` on a recording context,
 * and exercises the two routes plus the three failure shapes (no key, upstream
 * 401, upstream 429). No network, no DSH, no inference.
 *
 * Usage: node plugins/dsh-nanogpt/tools/smoke-host.mjs
 */
import { apply } from '../index.js';

const MODELS_FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      context_length: 1000000,
      max_output_tokens: 384000,
      architecture: { input_modalities: ['text', 'image'] },
      capabilities: { tool_calling: true, vision: true, reasoning: true },
      reasoning_efforts: ['none', 'low', 'high', 'max'],
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      context_length: 1048576,
      max_output_tokens: 384000,
      architecture: { input_modalities: ['text'] },
      capabilities: { tool_calling: true, vision: false, reasoning: true },
      reasoning_efforts: ['none', 'high', 'max'],
    },
  ],
};

const USAGE_FIXTURE = {
  active: true,
  state: 'active',
  weeklyInputTokens: { used: 1000, remaining: 59999000, percentUsed: 0.0017, resetAt: 1794182400000 },
  dailyImages: { used: 3, remaining: 97, percentUsed: 0.03, resetAt: 1794096000000 },
  period: { currentPeriodEnd: '2026-12-07T17:29:27.166Z' },
};

/** One fake response object the route handler writes into. */
function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

/** Mount `apply` and return the registered route handlers. */
function mount(config, resolveKey) {
  const routes = new Map();
  const ctx = {
    inject(_deps, callback) {
      callback({
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => {};
          },
        },
        credentials: { resolve: async () => resolveKey() },
        effect(fn) {
          fn();
          return () => {};
        },
      });
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };
  apply(ctx, config);
  return routes;
}

/** Call one route handler and return its fake response. */
async function call(handler, method = 'GET') {
  const res = response();
  await handler({ method }, res);
  return res;
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const text = String(url);
  if (text.includes('/subscription/v1/models')) {
    return { ok: true, status: 200, headers: new Map(), json: async () => MODELS_FIXTURE };
  }
  if (text.includes('/subscription/v1/usage')) {
    return { ok: true, status: 200, headers: new Map(), json: async () => USAGE_FIXTURE };
  }
  return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
};

try {
  console.log('models route');
  {
    const routes = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, () => ({ value: 'test-key' }));
    const res = await call(routes.get('/dsh-nanogpt/models'));
    const body = JSON.parse(res.body);
    check('status 200', res.status === 200, String(res.status));
    check('two models', body.models?.length === 2, JSON.stringify(body.models?.length));
    check('rate ×2 on deepseek-v4-pro', body.models?.[1]?.rate === 2, JSON.stringify(body.models?.[1]?.rate));
    check(
      'reasoningEfforts maps none → off',
      body.models?.[0]?.reasoningEfforts?.off === 'none',
      JSON.stringify(body.models?.[0]?.reasoningEfforts),
    );
    check('maxTokens from max_output_tokens', body.models?.[0]?.maxTokens === 384000, String(body.models?.[0]?.maxTokens));
    check('input keeps image', body.models?.[0]?.input?.includes('image') === true, JSON.stringify(body.models?.[0]?.input));
  }

  console.log('usage route');
  {
    const routes = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, () => ({ value: 'test-key' }));
    const res = await call(routes.get('/dsh-nanogpt/usage'));
    const body = JSON.parse(res.body);
    check('status 200', res.status === 200, String(res.status));
    check('weekly remaining', body.weekly?.remaining === 59999000, String(body.weekly?.remaining));
    check('period end', body.periodEnd === '2026-12-07T17:29:27.166Z', String(body.periodEnd));
  }

  console.log('no key');
  {
    const routes = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, () => undefined);
    const res = await call(routes.get('/dsh-nanogpt/models'));
    const body = JSON.parse(res.body);
    check('status 401', res.status === 401, String(res.status));
    check('error no-key', body.error === 'no-key', String(body.error));
  }

  console.log('upstream 401');
  {
    globalThis.fetch = async () => ({ ok: false, status: 401, headers: new Map(), json: async () => ({}) });
    const routes = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, () => ({ value: 'bad-key' }));
    const res = await call(routes.get('/dsh-nanogpt/models'));
    const body = JSON.parse(res.body);
    check('status 502', res.status === 502, String(res.status));
    check('error unauthorized', body.error === 'unauthorized', String(body.error));
  }

  console.log('upstream 429');
  {
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '30']]),
      json: async () => ({}),
    });
    const routes = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, () => ({ value: 'test-key' }));
    const res = await call(routes.get('/dsh-nanogpt/usage'));
    const body = JSON.parse(res.body);
    check('status 429', res.status === 429, String(res.status));
    check('error rate-limited', body.error === 'rate-limited', String(body.error));
    check('retryAfter forwarded', body.retryAfter === '30', String(body.retryAfter));
  }

  console.log('method guard');
  {
    const routes = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, () => ({ value: 'test-key' }));
    const res = await call(routes.get('/dsh-nanogpt/models'), 'POST');
    check('status 405', res.status === 405, String(res.status));
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.error(`smoke-host: ${failures} failure(s)`);
  process.exit(1);
}
console.log('smoke-host: ok');
