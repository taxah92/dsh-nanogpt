/**
 * Host half of `dsh-nanogpt`.
 *
 * Two jobs:
 *   1. Serve the NanoGPT PRO subscription catalog to the browser
 *      (`GET /dsh-nanogpt/models`) — only subscription-included models, with
 *      the ×1/×2 rate, context/output capacities and reasoning levels already
 *      normalized for `llm-pi-ai`.
 *   2. Serve the remaining weekly allowance (`GET /dsh-nanogpt/usage`).
 *
 * Both routes are GET-only and never call `/chat/completions`: the plugin must
 * not spend the subscription allowance it reports.
 *
 * The API key is resolved per request through `ctx.credentials`, so a key
 * changed on the Models page reaches the next poll without a plugin restart.
 * The credential reference is the row's `apiKeyEnv` (default
 * `NANOGPT_API_KEY`); the value itself never enters this module.
 *
 * `schemastery` is a declared dependency rather than an import of a bundled
 * DSH package because this package is a local directory symlinked into the
 * profile: Node resolves imports from the REAL path, which never reaches the
 * profile's `node_modules`, so an undeclared import fails at activation with
 * ERR_MODULE_NOT_FOUND.
 */
import z from '@deepseek-ai/schemastery';

import { normalizeModels, normalizeUsage, parseExtraRate2 } from './lib/normalize.js';

/** Route the browser reads the subscription catalog from. */
export const MODELS_ROUTE = '/dsh-nanogpt/models';

/** Route the browser reads the remaining allowance from. */
export const USAGE_ROUTE = '/dsh-nanogpt/usage';

/** Upstream request bound; a hung NanoGPT must not pin a browser request forever. */
const FETCH_TIMEOUT_MS = 30000;

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
    .description('Имя credential-ссылки с ключом NanoGPT (refs в ~/.dsh/.credentials.yaml).')
    .volatile(),
  baseURL: z
    .string()
    .default('https://api.nano-gpt.com/api')
    .description('База API NanoGPT. Прямой хост без IPv6; веб-хост — https://nano-gpt.com/api.')
    .volatile(),
  modelsCacheTtlMs: z
    .number()
    .step(1)
    .min(1000)
    .default(600000)
    .description('Сколько держать каталог моделей в кэше, мс (по умолчанию 10 минут).')
    .volatile(),
  usageCacheTtlMs: z
    .number()
    .step(1)
    .min(1000)
    .default(60000)
    .description('Сколько держать квоту в кэше, мс (по умолчанию 1 минута).')
    .volatile(),
  extraRate2: z
    .string()
    .default('')
    .description('Дополнительные id моделей с рейтом ×2, через запятую (API множитель не отдаёт).')
    .volatile(),
});

/**
 * Unwrap the live config references `apply` receives.
 *
 * A volatile field arrives as a reference (`{ get() }`) rather than as the
 * plain value, so every read goes through here. Called per request, which is
 * what makes a settings edit reach the next poll without a restart.
 * @param {Record<string, unknown>} live - config object handed to `apply`.
 * @returns {{apiKeyEnv: string, baseURL: string, modelsCacheTtlMs: number, usageCacheTtlMs: number, extraRate2: Set<string>}} resolved config.
 */
export function readConfig(live) {
  const field = (key, fallback) => {
    const value = live?.[key];
    const raw = typeof value?.get === 'function' ? value.get() : value;
    return raw === undefined || raw === null ? fallback : raw;
  };
  return {
    apiKeyEnv: String(field('apiKeyEnv', 'NANOGPT_API_KEY')),
    baseURL: String(field('baseURL', 'https://api.nano-gpt.com/api')).replace(/\/+$/, ''),
    modelsCacheTtlMs: Number(field('modelsCacheTtlMs', 600000)),
    usageCacheTtlMs: Number(field('usageCacheTtlMs', 60000)),
    extraRate2: parseExtraRate2(field('extraRate2', '')),
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

/**
 * Host plugin body: register the two read-only routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Loader context.
 * @param {Record<string, unknown>} [config] - validated row config (volatile references).
 */
export function apply(ctx, config = {}) {
  // The web server may be absent (headless profile); the plugin then simply
  // has no routes, and the client half is not loaded either.
  ctx.inject(['webServer', 'credentials'], (scope) => {
    /** Last successful payloads, keyed by route, with their fetch time. */
    const cache = { models: null, usage: null };

    /** Resolve the configured credential reference for one request. */
    const resolveKey = async () => {
      const cfg = readConfig(config);
      const hit = await scope.credentials.resolve(cfg.apiKeyEnv);
      return { cfg, key: typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined };
    };

    /** Fetch one NanoGPT endpoint as JSON, mapping failures to {@link UpstreamError}. */
    const fetchJson = async (url, key) => {
      let response;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
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
      if (cached !== null) {
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
      sendJson(res, 502, { error: 'upstream', message: String(error?.message ?? error) });
    };

    /** GET /dsh-nanogpt/models — subscription catalog with rate and reasoning levels. */
    const modelsHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const { cfg, key } = await resolveKey();
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

    /** GET /dsh-nanogpt/usage — remaining weekly allowance and image quota. */
    const usageHandler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method' });
        return;
      }
      const { cfg, key } = await resolveKey();
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

    // Registered as effects so a disabled or reloaded row leaves no stale route.
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: MODELS_ROUTE, handler: modelsHandler }));
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: USAGE_ROUTE, handler: usageHandler }));
  });
}
