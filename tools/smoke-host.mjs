#!/usr/bin/env node
/**
 * Offline smoke test for the Host half.
 *
 * Stubs `fetch` with fixtures, mounts `apply` on a recording context, and
 * exercises every route plus the outbound request rewriter:
 *
 *   GET  /dsh-nanogpt/models
 *   GET  /dsh-nanogpt/all-models
 *   GET  /dsh-nanogpt/providers?model=…
 *   GET  /dsh-nanogpt/usage
 *   GET  /dsh-nanogpt/keys
 *   GET  /dsh-nanogpt/balance
 *   the balance-key swap and provider injection on chat completions
 *
 * No network, no DSH, no inference.
 *
 * Usage: node plugins/dsh-nanogpt/tools/smoke-host.mjs
 */
import { apply } from '../index.js';

const SUBSCRIPTION_MODELS = {
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

const ALL_MODELS = {
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
      pricing: { prompt: 0.1, completion: 0.6, unit: 'per_million_tokens' },
      subscription: { included: true, inputTokenMultiplier: 1 },
    },
    {
      id: 'openai/gpt-6.1-sol',
      name: 'GPT 6.1 Sol',
      context_length: 1050000,
      max_output_tokens: 128000,
      architecture: { input_modalities: ['text', 'image'] },
      capabilities: { tool_calling: true, vision: true, reasoning: true },
      reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      pricing: { prompt: 2, completion: 10, unit: 'per_million_tokens' },
      subscription: { included: false, inputTokenMultiplier: 1 },
    },
  ],
};

const PROVIDERS = {
  canonicalId: 'deepseek/deepseek-v4.1-flash',
  displayName: 'DeepSeek V4.1 Flash',
  supportsProviderSelection: true,
  defaultPrice: { inputPer1kTokens: 0.0001, outputPer1kTokens: 0.0006 },
  providers: [
    {
      provider: 'novita',
      displayName: 'Novita',
      available: true,
      pricing: { inputPer1kTokens: 0.0001575, outputPer1kTokens: 0.00063 },
      maxInputTokens: 1048560,
      maxOutputTokens: 393216,
      features: { toolCalling: true, reasoningEfforts: ['none', 'low', 'high', 'max'] },
    },
    {
      provider: 'moonshot',
      displayName: 'Moonshot',
      available: false,
      pricing: { inputPer1kTokens: 0.0009975, outputPer1kTokens: 0.0042 },
      features: { toolCalling: true },
    },
  ],
};

const USAGE = {
  active: true,
  state: 'active',
  weeklyInputTokens: { used: 1000, remaining: 59999000, percentUsed: 0.0017, resetAt: 1794182400000 },
  dailyImages: { used: 3, remaining: 97, percentUsed: 0.03, resetAt: 1794096000000 },
  period: { currentPeriodEnd: '2026-12-07T17:29:27.166Z' },
  routing: { billingMode: 'subscription_only', recommendedMode: 'subscription', paidSpendPolicyAllowsBalance: false },
};

const BALANCE = { usd_balance: '0.10245934', nano_balance: '0.00000000' };

/** One fake response object a route handler writes into. */
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

const realFetch = globalThis.fetch;

/** Fixture router; `override` lets a test replace one call outcome. */
function fixtureFetch(override) {
  return async (url, init = {}) => {
    const text = String(url);
    const method = init.method ?? 'GET';
    if (override !== undefined) {
      const answer = override(text, method, init);
      if (answer !== undefined) return answer;
    }
    const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
    if (text.includes('/subscription/v1/models')) return json(SUBSCRIPTION_MODELS);
    if (text.includes('/v1/models')) return json(ALL_MODELS);
    if (/\/models\/[^/]+\/providers/.test(text)) return json(PROVIDERS);
    if (text.includes('/subscription/v1/usage')) return json(USAGE);
    if (text.includes('/check-balance') && method === 'POST') return json(BALANCE);
    return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
  };
}

/**
 * Mount `apply` and return the registered route handlers plus a disposer.
 * @param {object} config - raw plugin config (plain values are accepted by `readConfig`).
 * @param {object} [options] - credential stubs.
 */
function mount(config, options = {}) {
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    if (typeof fn !== 'function') return () => {};
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  };
  const credentials = {
    resolve: options.resolve ?? (async () => ({ value: 'test-key' })),
    describe: options.describe ?? (async () => ({ configured: true, writable: true, masked: 'sk-nano-…9377' })),
  };
  const ctx = {
    inject(_deps, callback) {
      callback({
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => {};
          },
        },
        credentials,
        effect,
      });
    },
    effect,
  };
  apply(ctx, config);
  return {
    routes,
    dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // a stub disposer must not mask the assertion result
        }
      }
    },
  };
}

/** Call one route handler and return its fake response. */
async function call(handler, method = 'GET', url = 'http://127.0.0.1/') {
  const res = response();
  await handler({ method, url }, res);
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

globalThis.fetch = fixtureFetch();

try {
  console.log('models route');
  {
    const { routes, dispose } = mount({ apiKeyEnv: 'NANOGPT_API_KEY' });
    try {
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
    } finally {
      dispose();
    }
  }

  console.log('all-models route');
  {
    const { routes, dispose } = mount({});
    try {
      const res = await call(routes.get('/dsh-nanogpt/all-models'));
      const body = JSON.parse(res.body);
      check('status 200', res.status === 200, String(res.status));
      check('two canonical models', body.models?.length === 2, JSON.stringify(body.models?.length));
      check('subscription flag kept', body.models?.[0]?.included === true && body.models?.[1]?.included === false);
      check('paid model has price', body.models?.[1]?.price?.prompt === 2, JSON.stringify(body.models?.[1]?.price));
      check('paid model has no rate', body.models?.[1]?.rate === undefined, JSON.stringify(body.models?.[1]?.rate));
    } finally {
      dispose();
    }
  }

  console.log('providers route');
  {
    const { routes, dispose } = mount({});
    try {
      const missing = await call(routes.get('/dsh-nanogpt/providers'));
      check('missing model → 400', missing.status === 400, String(missing.status));
      const res = await call(
        routes.get('/dsh-nanogpt/providers'),
        'GET',
        'http://127.0.0.1/dsh-nanogpt/providers?model=deepseek%2Fdeepseek-v4.1-flash',
      );
      const body = JSON.parse(res.body);
      check('status 200', res.status === 200, String(res.status));
      check('provider selection supported', body.supportsProviderSelection === true);
      check('two providers', body.providers?.length === 2, JSON.stringify(body.providers?.length));
      check('per-1k price converted to per-1M', body.providers?.[0]?.inputPer1M === 0.1575, String(body.providers?.[0]?.inputPer1M));
      check('available=false kept', body.providers?.[1]?.available === false, JSON.stringify(body.providers?.[1]?.available));
      check('default price normalized', body.defaultPrice?.outputPer1M === 0.6, String(body.defaultPrice?.outputPer1M));
    } finally {
      dispose();
    }
  }

  console.log('usage route');
  {
    const { routes, dispose } = mount({});
    try {
      const res = await call(routes.get('/dsh-nanogpt/usage'));
      const body = JSON.parse(res.body);
      check('status 200', res.status === 200, String(res.status));
      check('weekly remaining', body.weekly?.remaining === 59999000, String(body.weekly?.remaining));
      check('period end', body.periodEnd === '2026-12-07T17:29:27.166Z', String(body.periodEnd));
      check('routing billing mode', body.routing?.billingMode === 'subscription_only', JSON.stringify(body.routing));
    } finally {
      dispose();
    }
  }

  console.log('keys route');
  {
    const { routes, dispose } = mount(
      {},
      {
        resolve: async (ref) => ({ value: ref === 'NANOGPT_PAYGO_API_KEY' ? 'paygo-key' : 'sub-key' }),
        describe: async (ref) => ({
          configured: ref === 'NANOGPT_API_KEY',
          writable: true,
          masked: ref === 'NANOGPT_API_KEY' ? 'sk-nano-…9377' : undefined,
          source: 'file',
        }),
      },
    );
    try {
      const res = await call(routes.get('/dsh-nanogpt/keys'));
      const body = JSON.parse(res.body);
      check('status 200', res.status === 200, String(res.status));
      check('subscription configured', body.subscription?.configured === true);
      check('balance not configured', body.balance?.configured === false, JSON.stringify(body.balance));
      check('subscription billing mode', body.subscription?.billingMode === 'subscription_only', String(body.subscription?.billingMode));
    } finally {
      dispose();
    }
  }

  console.log('balance route');
  {
    const { routes, dispose } = mount({});
    try {
      const res = await call(routes.get('/dsh-nanogpt/balance'));
      const body = JSON.parse(res.body);
      check('status 200', res.status === 200, String(res.status));
      check('usd balance parsed', body.usdBalance === 0.10245934, String(body.usdBalance));
    } finally {
      dispose();
    }
  }

  console.log('request rewriter');
  {
    const seen = [];
    const capture = async (url, init) => {
      seen.push({ url: String(url), init });
      return { ok: true, status: 200, headers: new Map(), json: async () => ({}) };
    };
    const previous = globalThis.fetch;
    globalThis.fetch = capture;
    const { dispose } = mount({
      apiKeyEnv: 'NANOGPT_API_KEY',
      paygoKeyEnv: 'NANOGPT_PAYGO_API_KEY',
      baseURL: 'https://api.nano-gpt.com/api',
      balanceModels: ['deepseek/deepseek-v4.1-flash'],
      modelProviders: { 'deepseek/deepseek-v4.1-flash': 'novita' },
    }, {
      resolve: async (ref) => ({ value: ref === 'NANOGPT_PAYGO_API_KEY' ? 'paygo-key' : 'sub-key' }),
    });
    try {
      await globalThis.fetch('https://api.nano-gpt.com/api/v1legacy/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sub-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }),
      });
      const balanceCall = seen.at(-1);
      const headers = new Headers(balanceCall.init.headers);
      check('balance model uses the paygo key', headers.get('authorization') === 'Bearer paygo-key', headers.get('authorization'));
      check('provider injected as X-Provider', headers.get('x-provider') === 'novita', headers.get('x-provider'));

      await globalThis.fetch('https://api.nano-gpt.com/api/v1legacy/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sub-key' },
        body: JSON.stringify({ model: 'deepseek/deepseek-v4-pro', messages: [] }),
      });
      const subscriptionCall = seen.at(-1);
      const subHeaders = new Headers(subscriptionCall.init.headers);
      check('subscription model keeps the route key', subHeaders.get('authorization') === 'Bearer sub-key', subHeaders.get('authorization'));
      check(
        'subscription model has no provider header',
        new Headers(subscriptionCall.init.headers).get('x-provider') === null,
      );

      await globalThis.fetch('https://api.nano-gpt.com/api/v1legacy/models?detailed=true', { method: 'GET' });
      check('discovery request untouched', seen.at(-1).init.method === 'GET' && seen.at(-1).init.headers === undefined);
    } finally {
      dispose();
      globalThis.fetch = previous;
    }
  }

  console.log('request rewriter without balance key');
  {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}) });
    let reached = false;
    const { dispose } = mount({
      apiKeyEnv: 'NANOGPT_API_KEY',
      paygoKeyEnv: 'NANOGPT_PAYGO_API_KEY',
      baseURL: 'https://api.nano-gpt.com/api',
      balanceModels: ['deepseek/deepseek-v4.1-flash'],
    }, {
      resolve: async (ref) => (ref === 'NANOGPT_PAYGO_API_KEY' ? undefined : { value: 'sub-key' }),
    });
    try {
      let thrown = null;
      try {
        await globalThis.fetch('https://api.nano-gpt.com/api/v1legacy/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer sub-key' },
          body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }),
        });
        reached = true;
      } catch (error) {
        thrown = String(error?.message ?? error);
      }
      check('balance model without the key fails before the request', reached === false);
      check('failure names the balance key', thrown !== null && thrown.includes('NANOGPT_PAYGO_API_KEY'), String(thrown));
    } finally {
      dispose();
      globalThis.fetch = previous;
    }
  }

  console.log('no key');
  {
    const { routes, dispose } = mount({ apiKeyEnv: 'NANOGPT_API_KEY' }, { resolve: async () => undefined });
    try {
      const res = await call(routes.get('/dsh-nanogpt/models'));
      const body = JSON.parse(res.body);
      check('status 401', res.status === 401, String(res.status));
      check('error no-key', body.error === 'no-key', String(body.error));
    } finally {
      dispose();
    }
  }

  console.log('upstream 401');
  {
    globalThis.fetch = fixtureFetch((text) =>
      text.includes('/subscription/v1/models')
        ? { ok: false, status: 401, headers: new Map(), json: async () => ({}) }
        : undefined,
    );
    const { routes, dispose } = mount({ apiKeyEnv: 'NANOGPT_API_KEY' });
    try {
      const res = await call(routes.get('/dsh-nanogpt/models'));
      const body = JSON.parse(res.body);
      check('status 502', res.status === 502, String(res.status));
      check('error unauthorized', body.error === 'unauthorized', String(body.error));
    } finally {
      dispose();
      globalThis.fetch = fixtureFetch();
    }
  }

  console.log('upstream 429');
  {
    globalThis.fetch = fixtureFetch((text) =>
      text.includes('/subscription/v1/usage')
        ? { ok: false, status: 429, headers: new Map([['retry-after', '30']]), json: async () => ({}) }
        : undefined,
    );
    const { routes, dispose } = mount({ apiKeyEnv: 'NANOGPT_API_KEY' });
    try {
      const res = await call(routes.get('/dsh-nanogpt/usage'));
      const body = JSON.parse(res.body);
      check('status 429', res.status === 429, String(res.status));
      check('error rate-limited', body.error === 'rate-limited', String(body.error));
      check('retryAfter forwarded', body.retryAfter === '30', String(body.retryAfter));
    } finally {
      dispose();
      globalThis.fetch = fixtureFetch();
    }
  }

  console.log('method guard');
  {
    const { routes, dispose } = mount({});
    try {
      const res = await call(routes.get('/dsh-nanogpt/models'), 'POST');
      check('status 405', res.status === 405, String(res.status));
    } finally {
      dispose();
    }
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.error(`smoke-host: ${failures} failure(s)`);
  process.exit(1);
}
console.log('smoke-host: ok');