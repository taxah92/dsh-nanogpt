/**
 * Host half of `dsh-nanogpt`.
 *
 * Jobs:
 *   1. Serve the NanoGPT PRO subscription catalog to the browser
 *      (`GET /dsh-nanogpt/models`) and the canonical text catalog that also
 *      contains paid models (`GET /dsh-nanogpt/all-models`).
 *   2. Serve provider discovery for one model (`GET /dsh-nanogpt/providers`),
 *      proxying `GET /api/models/:id/providers`.
 *   3. Serve the remaining weekly allowance (`GET /dsh-nanogpt/usage`), the
 *      API-key states with their billing policy (`GET /dsh-nanogpt/keys`), and
 *      the account balance (`GET /dsh-nanogpt/balance`).
 *   4. Rewrite outbound NanoGPT chat-completion requests made by `llm-pi-ai`:
 *      a model configured for balance spending gets the `NANOGPT_PAYGO_API_KEY`
 *      credential instead of the route's subscription key, and a pinned
 *      provider is sent as the `X-Provider` header. NanoGPT has one
 *      key per route but a request can select a different key only per call,
 *      so the per-model toggle lives here rather than in the route profile.
 *
 * All reads are GET except the balance lookup, which is a POST to
 * `/check-balance` that does not run a model and does not spend balance.
 * The request rewriter never triggers inference; it only shapes a request the
 * adapter was already sending.
 *
 * The API keys are resolved per request through `ctx.credentials`, so a key
 * changed on the Models page reaches the next poll without a plugin restart.
 * The credential references are the config fields `apiKeyEnv` (subscription)
 * and `paygoKeyEnv` (balance); values never enter this module's output.
 *
 * `schemastery` is a declared dependency rather than an import of a bundled
 * DSH package because this package is a local directory symlinked into the
 * profile: Node resolves imports from the REAL path, which never reaches the
 * profile's `node_modules`, so an undeclared import fails at activation with
 * ERR_MODULE_NOT_FOUND.
 */
import z from '@deepseek-ai/schemastery';

import {
  normalizeAllModels,
  normalizeModels,
  normalizeProviders,
  normalizeUsage,
  parseBalanceModels,
  parseExtraRate2,
  parseModelProviders,
} from './lib/normalize.js';

/** Subscription catalog (only models included in the PRO subscription). */
export const MODELS_ROUTE = '/dsh-nanogpt/models';

/** Canonical text catalog (subscription + paid models), fetched anonymously. */
export const ALL_MODELS_ROUTE = '/dsh-nanogpt/all-models';

/** Provider discovery for one model (`?model=<id>`). */
export const PROVIDERS_ROUTE = '/dsh-nanogpt/providers';

/** Remaining subscription allowance. */
export const USAGE_ROUTE = '/dsh-nanogpt/usage';

/** Presence and billing policy of both API-key references. */
export const KEYS_ROUTE = '/dsh-nanogpt/keys';

/** NanoGPT account balance in USD. */
export const BALANCE_ROUTE = '/dsh-nanogpt/balance';

/** Upstream request bound; a hung NanoGPT must not pin a browser request forever. */
const FETCH_TIMEOUT_MS = 30000;

/** Path suffix every chat-completions request ends with (v1, v1legacy, v1thinking). */
const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';

/**
 * Hosts the rewriter may touch: the configured API host plus NanoGPT's direct
 * and web hosts. A deployment whose `llm-pi-ai` route uses the web host still
 * gets the per-model balance key because the route and this plugin's `baseURL`
 * are configured independently.
 */
const NANOGPT_HOSTS = new Set(['api.nano-gpt.com', 'nano-gpt.com']);

/**
 * Declared shape of this plugin's row `config`.
 *
 * Every field is `.volatile()`: that is what makes it writable through the
 * settings pipeline (`volatileForm()` in `dsh-settings` collects only fields
 * whose `meta.volatile` is set), and what makes `apply` receive live
 * references instead of plain values — hence {@link readConfig}.
 */
export const Config = z.object({
  apiKeyEnv: z
    .string()
    .default('NANOGPT_API_KEY')
    .description('Credential reference holding the NanoGPT subscription key (refs in ~/.dsh/.credentials.yaml).')
    .volatile(),
  paygoKeyEnv: z
    .string()
    .default('NANOGPT_PAYGO_API_KEY')
    .description('Credential reference holding the NanoGPT balance key for pay-as-you-go spending.')
    .volatile(),
  baseURL: z
    .string()
    .default('https://api.nano-gpt.com/api')
    .description('NanoGPT API base. Direct host without IPv6; the web host is https://nano-gpt.com/api.')
    .volatile(),
  modelsCacheTtlMs: z
    .number()
    .step(1)
    .min(1000)
    .default(600000)
    .description('How long to cache the model catalogs, ms (10 minutes by default).')
    .volatile(),
  usageCacheTtlMs: z
    .number()
    .step(1)
    .min(1000)
    .default(60000)
    .description('How long to cache the quota, balance and key policies, ms (1 minute by default).')
    .volatile(),
  extraRate2: z
    .string()
    .default('')
    .description('Extra model ids with the ×2 rate, comma-separated (the API does not expose the multiplier).')
    .volatile(),
  balanceModels: z
    .array(z.string())
    .default([])
    .description('Model ids charged to the balance (paygoKeyEnv credential) rather than the subscription.')
    .volatile(),
  modelProviders: z
    .dict(z.string())
    .default({})
    .description('Pinned provider per model id: { "<model-id>": "<provider-id>" }. Balance mode only.')
    .volatile(),
});

/**
 * Unwrap the live config references `apply` receives.
 *
 * A volatile field arrives as a reference (`{ get() }`) rather than as the
 * plain value, so every read goes through here. Called per request, which is
 * what makes a settings edit reach the next poll or request without a restart.
 * @param {Record<string, unknown>} live - config object handed to `apply`.
 * @returns {{apiKeyEnv: string, paygoKeyEnv: string, baseURL: string, host: string, modelsCacheTtlMs: number, usageCacheTtlMs: number, extraRate2: Set<string>, balanceModels: Set<string>, modelProviders: Record<string, string>}} resolved config.
 */
export function readConfig(live) {
  const field = (key, fallback) => {
    const value = live?.[key];
    const raw = typeof value?.get === 'function' ? value.get() : value;
    return raw === undefined || raw === null ? fallback : raw;
  };
  const baseURL = String(field('baseURL', 'https://api.nano-gpt.com/api')).replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(baseURL).host;
  } catch {
    host = '';
  }
  return {
    apiKeyEnv: String(field('apiKeyEnv', 'NANOGPT_API_KEY')),
    paygoKeyEnv: String(field('paygoKeyEnv', 'NANOGPT_PAYGO_API_KEY')),
    baseURL,
    host,
    modelsCacheTtlMs: Number(field('modelsCacheTtlMs', 600000)),
    usageCacheTtlMs: Number(field('usageCacheTtlMs', 60000)),
    extraRate2: parseExtraRate2(field('extraRate2', '')),
    balanceModels: parseBalanceModels(field('balanceModels', [])),
    modelProviders: parseModelProviders(field('modelProviders', {})),
  };
}

/** Write one JSON response with no-store caching. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** An upstream failure carrying the status and retry hint the route reports. */
class UpstreamError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Read one query parameter from a bare node request. */
function queryParam(req, name) {
  try {
    const url = new URL(req?.url ?? '', 'http://127.0.0.1');
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

/**
 * Resolve one credential reference to a non-empty value.
 * @param {{resolve: (ref: string) => Promise<{value?: string}|undefined>}} credentials - credential seam.
 * @param {string} ref - environment-variable-style reference.
 * @returns {Promise<string|undefined>} the secret value, or undefined when unset.
 */
async function resolveSecret(credentials, ref) {
  try {
    const hit = await credentials.resolve(ref);
    return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite one outbound request when the model is configured for balance spending.
 *
 * Matching is intentionally narrow: exact configured host, a pathname ending
 * in `/chat/completions`, and a JSON string body whose `model` is a balance
 * model. Everything else — discovery, embeddings, another gateway, a
 * pre-serialized stream — passes through untouched.
 *
 * The subscription key stays on the `llm-pi-ai` route; this function swaps in
 * the balance credential for the models the user toggled to balance. The
 * provider pin travels as the `X-Provider` header, NanoGPT's recommended
 * explicit per-request selector (it always bills as pay-as-you-go, the reason
 * the picker only offers it for balance models).
 * @param {RequestInfo|URL|string} input - fetch input.
 * @param {RequestInit|undefined} init - fetch init.
 * @param {ReturnType<typeof readConfig>} cfg - resolved plugin config.
 * @param {object} credentials - credential seam (`ctx.credentials`).
 * @returns {Promise<{input: any, init: RequestInit|undefined}>} the request to send.
 */
async function rewriteRequest(input, init, cfg, credentials) {
  if (typeof input !== 'string' || typeof init?.body !== 'string') return { input, init };
  let url;
  try {
    url = new URL(input);
  } catch {
    return { input, init };
  }
  if (url.host !== cfg.host && !NANOGPT_HOSTS.has(url.hostname)) return { input, init };
  if (!url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) return { input, init };

  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return { input, init };
  }
  const model = typeof body?.model === 'string' ? body.model : '';
  if (model.length === 0 || !cfg.balanceModels.has(model)) return { input, init };

  const key = await resolveSecret(credentials, cfg.paygoKeyEnv);
  if (key === undefined) {
    // Failing loudly is deliberate: falling back to the route's subscription
    // key would spend the resource the user explicitly did not select.
    throw new Error(
      `NanoGPT: model ${model} is set to balance billing, but the ${cfg.paygoKeyEnv} credential is not saved.`,
    );
  }

  const headers = new Headers(init.headers ?? undefined);
  headers.set('authorization', `Bearer ${key}`);
  headers.delete('x-api-key');

  // `X-Provider` is NanoGPT's recommended explicit provider selector (the
  // body string is a secondary form); the header also survives any endpoint
  // alias, so it is what this rewriter sets.
  const provider = cfg.modelProviders[model];
  if (typeof provider === 'string' && provider.length > 0) headers.set('x-provider', provider);

  return { input, init: { ...init, headers } };
}

/**
 * Install the request rewriter on `globalThis.fetch` for the life of the fiber.
 *
 * pi-ai's OpenAI-compatible client calls `globalThis.fetch` at request time, so
 * wrapping it is the seam `llm-pi-ai` leaves for per-request shaping (the same
 * seam `dsh-llm-request-routing` uses). The wrapper chains whatever fetch was
 * installed before it and removes itself on disposal only while it is still the
 * current global — a later plugin wrapping fetch keeps its own wrapper.
 * @param {import('@deepseek-ai/cordis').Context} scope - injected context with `credentials`.
 * @param {Record<string, unknown>} config - live row config.
 * @returns {() => void} disposer restoring the previous fetch.
 */
export function installRequestRewriter(scope, config) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return () => {};
  const wrapper = async (input, init) => {
    const cfg = readConfig(config);
    if (cfg.balanceModels.size === 0) return original(input, init);
    const rewritten = await rewriteRequest(input, init, cfg, scope.credentials);
    return original(rewritten.input, rewritten.init);
  };
  globalThis.fetch = wrapper;
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = original;
  };
}

/**
 * Host plugin body: register the read routes and the request rewriter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Loader context.
 * @param {Record<string, unknown>} [config] - validated row config (volatile references).
 */
export function apply(ctx, config = {}) {
  const ready = () => readConfig(config);

  // Wrapping fetch needs only credentials; it must also work in a profile
  // without the browser routes.
  ctx.inject(['credentials'], (scope) => {
    scope.effect(() => installRequestRewriter(scope, config));
  });

  // The web server may be absent (headless profile); the plugin then simply
  // has no routes, and the client half is not loaded either.
  ctx.inject(['webServer', 'credentials'], (scope) => {
    /** Last successful payloads, keyed by route, with their fetch time. */
    const cache = { models: null, allModels: null, usage: null, balance: null, providers: new Map() };

    /** Fetch one NanoGPT endpoint as JSON, mapping failures to {@link UpstreamError}. */
    const fetchJson = async (url, key, options = {}) => {
      const headers = { accept: 'application/json' };
      if (key !== undefined) headers.authorization = `Bearer ${key}`;
      if (options.apiKeyHeader === true && key !== undefined) headers['x-api-key'] = key;
      let response;
      try {
        response = await fetch(url, {
          method: options.method ?? 'GET',
          headers,
          ...(options.body === undefined ? {} : { body: options.body }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        throw new UpstreamError(String(error?.message ?? error), 0);
      }
      if (!response.ok) {
        throw new UpstreamError(
          `NanoGPT answered ${response.status}`,
          response.status,
          response.headers.get('retry-after') ?? undefined,
        );
      }
      try {
        return await response.json();
      } catch (error) {
        throw new UpstreamError(`NanoGPT returned invalid JSON: ${String(error?.message ?? error)}`, 0);
      }
    };

    /** Report a failed read: stale cache when one exists, otherwise a typed error. */
    const fail = (res, error, cached) => {
      if (cached !== null && cached !== undefined) {
        sendJson(res, 200, { ...cached.value, fetchedAt: cached.at, stale: true });
        return;
      }
      if (error instanceof UpstreamError && error.status === 401) {
        sendJson(res, 502, { error: 'unauthorized', message: error.message });
        return;
      }
      if (error instanceof UpstreamError && error.status === 429) {
        sendJson(res, 429, {
          error: 'rate-limited',
          message: error.message,
          ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
        });
        return;
      }
      if (error instanceof UpstreamError && error.status === 404) {
        sendJson(res, 404, { error: 'not-found', message: error.message });
        return;
      }
      sendJson(res, 502, { error: 'upstream', message: String(error?.message ?? error) });
    };

    /** Resolve the subscription key, then the balance key, for read-only requests. */
    const anyKey = async () => {
      const cfg = ready();
      return {
        cfg,
        subscription: await resolveSecret(scope.credentials, cfg.apiKeyEnv),
        balance: await resolveSecret(scope.credentials, cfg.paygoKeyEnv),
      };
    };

    /** GET /dsh-nanogpt/models — subscription catalog with rate and reasoning levels. */
    const modelsHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const { cfg, subscription, balance } = await anyKey();
      const key = subscription ?? balance;
      if (key === undefined) {
        sendJson(res, 401, { error: 'no-key', apiKeyEnv: cfg.apiKeyEnv });
        return;
      }
      const now = Date.now();
      if (cache.models !== null && now - cache.models.at < cfg.modelsCacheTtlMs) {
        sendJson(res, 200, { ...cache.models.value, fetchedAt: cache.models.at, stale: false });
        return;
      }
      try {
        const payload = await fetchJson(`${cfg.baseURL}/subscription/v1/models?detailed=true`, key);
        const value = { models: normalizeModels(payload, cfg.extraRate2) };
        cache.models = { at: now, value };
        sendJson(res, 200, { ...value, fetchedAt: now, stale: false });
      } catch (error) {
        fail(res, error, cache.models);
      }
    };

    /**
     * GET /dsh-nanogpt/all-models — canonical text catalog, fetched anonymously.
     *
     * An authenticated canonical list shrinks to the subscription set while the
     * account hides paid models; the anonymous list is the full 600+ record
     * superset the "all models" picker needs. Records carry their own
     * `subscription.included` flag, so the client can force balance billing for
     * paid entries.
     */
    const allModelsHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const cfg = ready();
      const now = Date.now();
      if (cache.allModels !== null && now - cache.allModels.at < cfg.modelsCacheTtlMs) {
        sendJson(res, 200, { ...cache.allModels.value, fetchedAt: cache.allModels.at, stale: false });
        return;
      }
      try {
        const payload = await fetchJson(`${cfg.baseURL}/v1/models?detailed=true`, undefined);
        const value = { models: normalizeAllModels(payload, cfg.extraRate2) };
        cache.allModels = { at: now, value };
        sendJson(res, 200, { ...value, fetchedAt: now, stale: false });
      } catch (error) {
        fail(res, error, cache.allModels);
      }
    };

    /**
     * GET /dsh-nanogpt/providers?model=<id> — provider discovery for one model.
     *
     * Uses the balance key when one is stored (the picker asks about providers
     * for balance models only), then the subscription key, then anonymous:
     * discovery is a plain GET and changes which key is used only for
     * consistency. The upstream path sits outside `/api/v1`, so the model id is
     * URL-encoded as one segment.
     */
    const providersHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const model = queryParam(req, 'model');
      if (model === null || model.length === 0) {
        sendJson(res, 400, { error: 'model', message: 'query parameter "model" is required' });
        return;
      }
      const { cfg, subscription, balance } = await anyKey();
      const key = balance ?? subscription;
      const now = Date.now();
      const cached = cache.providers.get(model) ?? null;
      if (cached !== null && now - cached.at < cfg.modelsCacheTtlMs) {
        sendJson(res, 200, { ...cached.value, fetchedAt: cached.at, stale: false });
        return;
      }
      try {
        const payload = await fetchJson(`${cfg.baseURL}/models/${encodeURIComponent(model)}/providers`, key);
        const value = normalizeProviders(payload);
        cache.providers.set(model, { at: now, value });
        sendJson(res, 200, { ...value, fetchedAt: now, stale: false });
      } catch (error) {
        fail(res, error, cached);
      }
    };

    /** GET /dsh-nanogpt/usage — remaining weekly allowance and image quota. */
    const usageHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const { cfg, subscription, balance } = await anyKey();
      const key = subscription ?? balance;
      if (key === undefined) {
        sendJson(res, 401, { error: 'no-key', apiKeyEnv: cfg.apiKeyEnv });
        return;
      }
      const now = Date.now();
      if (cache.usage !== null && now - cache.usage.at < cfg.usageCacheTtlMs) {
        sendJson(res, 200, { ...cache.usage.value, fetchedAt: cache.usage.at, stale: false });
        return;
      }
      try {
        const payload = await fetchJson(`${cfg.baseURL}/subscription/v1/usage`, key);
        const value = normalizeUsage(payload);
        cache.usage = { at: now, value };
        sendJson(res, 200, { ...value, fetchedAt: now, stale: false });
      } catch (error) {
        fail(res, error, cache.usage);
      }
    };

    /**
     * GET /dsh-nanogpt/keys — presence, mask, and billing policy of each key.
     *
     * `credentials.describe` supplies configured/writable/masked without the
     * value. The billing policy comes from that key's own usage response:
     * `routing.billingMode` states whether the key may spend the subscription,
     * the balance, or both, which is what the card shows beside the field.
     */
    const keysHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const cfg = ready();
      const describeKey = async (ref) => {
        let info = null;
        try {
          info = await scope.credentials.describe(ref);
        } catch (error) {
          return { ref, error: String(error?.message ?? error) };
        }
        const value = info?.configured === true ? await resolveSecret(scope.credentials, ref) : undefined;
        let usage = null;
        let usageError = null;
        if (value !== undefined) {
          try {
            usage = normalizeUsage(await fetchJson(`${cfg.baseURL}/subscription/v1/usage`, value));
          } catch (error) {
            usageError = String(error?.message ?? error);
          }
        }
        return {
          ref,
          configured: info?.configured === true,
          writable: info?.writable === true,
          masked: typeof info?.masked === 'string' ? info.masked : null,
          source: typeof info?.source === 'string' ? info.source : null,
          billingMode: usage?.routing?.billingMode ?? null,
          recommendedMode: usage?.routing?.recommendedMode ?? null,
          paidSpendPolicyAllowsBalance: usage?.routing?.paidSpendPolicyAllowsBalance ?? null,
          active: usage?.active ?? null,
          state: usage?.state ?? null,
          ...(usageError === null ? {} : { usageError }),
        };
      };
      try {
        const [subscription, balance] = await Promise.all([describeKey(cfg.apiKeyEnv), describeKey(cfg.paygoKeyEnv)]);
        sendJson(res, 200, { subscription, balance });
      } catch (error) {
        sendJson(res, 502, { error: 'upstream', message: String(error?.message ?? error) });
      }
    };

    /**
     * GET /dsh-nanogpt/balance — account balance in USD.
     *
     * `/check-balance` is a POST that does not generate tokens, so it spends
     * nothing; the balance key is preferred because a subscription-only key
     * still reports the same account balance.
     */
    const balanceHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const { cfg, subscription, balance } = await anyKey();
      const key = balance ?? subscription;
      if (key === undefined) {
        sendJson(res, 401, { error: 'no-key', apiKeyEnv: cfg.paygoKeyEnv });
        return;
      }
      const now = Date.now();
      if (cache.balance !== null && now - cache.balance.at < cfg.usageCacheTtlMs) {
        sendJson(res, 200, { ...cache.balance.value, fetchedAt: cache.balance.at, stale: false });
        return;
      }
      try {
        const payload = await fetchJson(`${cfg.baseURL}/check-balance`, key, {
          method: 'POST',
          apiKeyHeader: true,
        });
        const usd = Number.parseFloat(String(payload?.usd_balance ?? ''));
        const value = { usdBalance: Number.isFinite(usd) ? usd : null };
        cache.balance = { at: now, value };
        sendJson(res, 200, { ...value, fetchedAt: now, stale: false });
      } catch (error) {
        fail(res, error, cache.balance);
      }
    };

    // Registered as effects so a disabled or reloaded row leaves no stale route.
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: MODELS_ROUTE, handler: modelsHandler }));
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: ALL_MODELS_ROUTE, handler: allModelsHandler }));
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: PROVIDERS_ROUTE, handler: providersHandler }));
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: USAGE_ROUTE, handler: usageHandler }));
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: KEYS_ROUTE, handler: keysHandler }));
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: BALANCE_ROUTE, handler: balanceHandler }));
  });
}