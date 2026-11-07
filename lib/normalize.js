/**
 * Pure normalization of NanoGPT API payloads into the shapes `dsh-nanogpt`
 * serves to the browser.
 *
 * No I/O lives here: the host routes fetch, these functions map. Keeping them
 * pure is what makes the mapping testable without a DSH context or a network.
 *
 * Contract sources (read, not guessed):
 *   - `GET /api/subscription/v1/models?detailed=true` — fields `id`, `name`,
 *     `context_length`, `max_output_tokens`, `architecture.input_modalities`,
 *     `capabilities.tool_calling/vision`, `reasoning_efforts`.
 *   - `GET /api/subscription/v1/usage` — `weeklyInputTokens`, `dailyImages`,
 *     `period.currentPeriodEnd`, `active`, `state`.
 *   - DSH `llm-pi-ai` model profile — `id`, `name`, `contextWindow`,
 *     `maxTokens`, `input`, `reasoningEfforts` (`off` maps to the wire value).
 */

/**
 * Model ids billed at ×2 input-token units.
 *
 * The multiplier is server-side accounting: no NanoGPT endpoint returns it
 * (checked `/models`, `/usage` and the OpenAPI document on 2026-11-07). This
 * list is transcribed from https://nano-gpt.com/subscription, which states
 * that regular and thinking variants of the same family count the same.
 * The plugin's `extraRate2` config field appends ids without a code change.
 */
export const RATE_2 = new Set([
  'z-ai/glm-5',
  'z-ai/glm-5:thinking',
  'z-ai/glm-5.1',
  'z-ai/glm-5.1:thinking',
  'z-ai/glm-5.2',
  'z-ai/glm-5.2:thinking',
  'moonshotai/kimi-k2.7-code',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-pro:thinking',
  'deepseek/deepseek-v4-pro-0813',
  'deepseek/deepseek-v4-pro-0813:thinking',
  'deepseek/deepseek-latest',
]);

/** Context capacity assumed when the catalog does not disclose one. */
export const DEFAULT_CONTEXT_WINDOW = 262144;

/** Output capability assumed when the catalog does not disclose one. */
export const DEFAULT_MAX_TOKENS = 65536;

/**
 * Parse the comma-separated `extraRate2` config field.
 * @param {unknown} text - raw config value.
 * @returns {Set<string>} model ids to bill at ×2 in addition to {@link RATE_2}.
 */
export function parseExtraRate2(text) {
  const out = new Set();
  for (const part of String(text ?? '').split(',')) {
    const id = part.trim();
    if (id.length > 0) out.add(id);
  }
  return out;
}

/**
 * Map NanoGPT `reasoning_efforts` to DSH `reasoningEfforts`.
 *
 * `none` becomes the DSH `off` level whose wire value is `none`; every other
 * level keeps its own name. An empty or absent list means the model declares
 * no selectable levels, so the picker shows no Effort menu for it.
 * @param {unknown} efforts - `reasoning_efforts` array from the catalog.
 * @returns {Record<string, string>|undefined} level → wire value, or undefined.
 */
export function mapEfforts(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  const out = {};
  for (const level of efforts) {
    if (typeof level !== 'string' || level.length === 0) continue;
    out[level === 'none' ? 'off' : level] = level;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A positive integer field, or undefined when absent or unusable. */
function positiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A finite number field, or null when absent or unusable. */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one catalog record into the plugin's model shape.
 * @param {unknown} raw - one entry of the subscription catalog.
 * @param {Set<string>} [extraRate2] - additional ×2 ids from configuration.
 * @returns {object|undefined} normalized model, or undefined for a record with no id.
 */
export function normalizeModel(raw, extraRate2 = new Set()) {
  const id = typeof raw?.id === 'string' ? raw.id : '';
  if (id.length === 0) return undefined;
  const capabilities = raw.capabilities ?? {};
  const modalities = Array.isArray(raw.architecture?.input_modalities)
    ? raw.architecture.input_modalities
    : ['text'];
  const reasoningEfforts = mapEfforts(raw.reasoning_efforts);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
    contextWindow: positiveInt(raw.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: positiveInt(raw.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
    input: modalities.includes('image') ? ['text', 'image'] : ['text'],
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    rate: RATE_2.has(id) || extraRate2.has(id) ? 2 : 1,
    toolCalling: capabilities.tool_calling === true,
    vision: capabilities.vision === true,
  };
}

/**
 * Normalize the whole subscription catalog payload.
 * @param {unknown} payload - parsed `/api/subscription/v1/models` body.
 * @param {Set<string>} [extraRate2] - additional ×2 ids from configuration.
 * @returns {Array<object>} normalized models in catalog order.
 */
export function normalizeModels(payload, extraRate2 = new Set()) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  for (const raw of data) {
    const model = normalizeModel(raw, extraRate2);
    if (model !== undefined) models.push(model);
  }
  return models;
}

/**
 * Keep the ` ×2` suffix in a display name in sync with the model's rate.
 *
 * The selector shows the rate through the name because `llm-pi-ai` has no
 * per-model badge field; the picker owns the suffix so a rate change does not
 * require hand-editing every entry.
 * @param {unknown} name - current display name.
 * @param {number} rate - 1 or 2.
 * @returns {string} name with the suffix present exactly when the rate is 2.
 */
export function withRateSuffix(name, rate) {
  const base = String(name ?? '').replace(/\s*\(?×2\)?\s*$/u, '').trim();
  return rate === 2 ? `${base} ×2` : base;
}

/**
 * Normalize the subscription usage payload.
 * @param {unknown} raw - parsed `/api/subscription/v1/usage` body.
 * @returns {object} quota windows and subscription state.
 */
export function normalizeUsage(raw) {
  const window = (value) => {
    if (value === null || typeof value !== 'object') return null;
    return {
      used: numberOrNull(value.used),
      remaining: numberOrNull(value.remaining),
      percentUsed: numberOrNull(value.percentUsed),
      resetAt: numberOrNull(value.resetAt),
    };
  };
  return {
    active: raw?.active === true,
    state: typeof raw?.state === 'string' ? raw.state : null,
    weekly: window(raw?.weeklyInputTokens),
    dailyImages: window(raw?.dailyImages),
    periodEnd: typeof raw?.period?.currentPeriodEnd === 'string' ? raw.period.currentPeriodEnd : null,
  };
}
