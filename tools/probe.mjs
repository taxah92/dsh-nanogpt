#!/usr/bin/env node
/**
 * Read-only probe for the NanoGPT API used by `dsh-nanogpt`.
 *
 * Reads both credential references from `~/.dsh/.credentials.yaml`
 * (`NANOGPT_API_KEY`, `NANOGPT_PAYGO_API_KEY`) or the matching environment
 * variables, then checks:
 *
 *   GET  /api/subscription/v1/models?detailed=true   (subscription catalog)
 *   GET  /api/v1/models?detailed=true                (canonical, anonymous)
 *   GET  /api/models/:id/providers                   (provider discovery)
 *   GET  /api/subscription/v1/usage                  (quota + key billing mode)
 *   POST /api/check-balance                          (balance, no tokens)
 *
 * The balance call is the only POST: it answers with account balances and does
 * not run a model. Nothing here calls `/chat/completions`, so running it does
 * not spend the subscription allowance or the balance.
 *
 * Usage: node plugins/dsh-nanogpt/tools/probe.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { normalizeAllModels, normalizeModels, normalizeProviders, normalizeUsage, RATE_2 } from '../lib/normalize.js';

const BASE = 'https://api.nano-gpt.com/api';
const TIMEOUT_MS = 30000;

/** Read one `refs.<name>` value from the DSH credentials file without a YAML dependency. */
function keyFromCredentials(name) {
  const path = join(homedir(), '.dsh', '.credentials.yaml');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}:\\s*["']?([^"'\\s#]+)["']?\\s*$`, 'm'));
  return match?.[1];
}

/** Fetch one endpoint as JSON. */
async function call(path, { key, method = 'GET', apiKeyHeader = false } = {}) {
  const headers = { accept: 'application/json' };
  if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
    if (apiKeyHeader) headers['x-api-key'] = key;
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/** Describe one credential without failing the whole probe. */
async function keyState(ref, key) {
  if (key === undefined) return { ref, configured: false };
  try {
    const usage = normalizeUsage(await call('/subscription/v1/usage', { key }));
    return {
      ref,
      configured: true,
      active: usage.active,
      state: usage.state,
      billingMode: usage.routing?.billingMode ?? null,
      recommendedMode: usage.routing?.recommendedMode ?? null,
      paidSpendPolicyAllowsBalance: usage.routing?.paidSpendPolicyAllowsBalance ?? null,
    };
  } catch (error) {
    return { ref, configured: true, error: String(error?.message ?? error) };
  }
}

const subscriptionKey = process.env.NANOGPT_API_KEY ?? keyFromCredentials('NANOGPT_API_KEY');
const paygoKey = process.env.NANOGPT_PAYGO_API_KEY ?? keyFromCredentials('NANOGPT_PAYGO_API_KEY');

if (subscriptionKey === undefined && paygoKey === undefined) {
  console.error('probe: neither NANOGPT_API_KEY nor NANOGPT_PAYGO_API_KEY is set');
  process.exit(2);
}

const [subscriptionPayload, allPayload, balancePayload] = await Promise.all([
  call('/subscription/v1/models?detailed=true', { key: subscriptionKey ?? paygoKey }),
  call('/v1/models?detailed=true'),
  call('/check-balance', { key: paygoKey ?? subscriptionKey, method: 'POST', apiKeyHeader: true }),
]);

const models = normalizeModels(subscriptionPayload);
const allModels = normalizeAllModels(allPayload);
const paidModels = allModels.filter((model) => model.included === false);

// Find a subscription model that supports provider selection. The flag exists
// only on the per-model endpoint, so a few models are probed GET-only.
let providerSample = null;
for (const model of models.slice(0, 40)) {
  if (normalizeProviders(await call(`/models/${encodeURIComponent(model.id)}/providers`, {
    key: paygoKey ?? subscriptionKey,
  })).supportsProviderSelection) {
    providerSample = model;
    break;
  }
}
const providerPayload = providerSample === null
  ? null
  : normalizeProviders(await call(`/models/${encodeURIComponent(providerSample.id)}/providers`, {
      key: paygoKey ?? subscriptionKey,
    }));

const usage = normalizeUsage(await call('/subscription/v1/usage', { key: subscriptionKey ?? paygoKey }));
const balance = Number.parseFloat(String(balancePayload?.usd_balance ?? ''));

const report = {
  models: models.length,
  toolCalling: models.filter((model) => model.toolCalling).length,
  reasoning: models.filter((model) => model.reasoningEfforts !== undefined).length,
  rate2: models.filter((model) => model.rate === 2).length,
  rate2Ids: models.filter((model) => model.rate === 2).map((model) => model.id),
  unknownRate2: models.filter((model) => model.rate === 2 && !RATE_2.has(model.id)).map((model) => model.id),
  allModels: allModels.length,
  paidModels: paidModels.length,
  providerSample: providerSample === null
    ? null
    : {
        id: providerSample.id,
        providers: providerPayload.providers.map((row) => `${row.id}${row.available ? '' : ' (unavailable)'}`),
      },
  keys: {
    subscription: await keyState('NANOGPT_API_KEY', subscriptionKey),
    paygo: await keyState('NANOGPT_PAYGO_API_KEY', paygoKey),
  },
  balanceUsd: Number.isFinite(balance) ? balance : null,
  weekly: usage.weekly,
  dailyImages: usage.dailyImages,
  active: usage.active,
  state: usage.state,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`models: ${report.models} (tool calling ${report.toolCalling}, reasoning ${report.reasoning})`);
  console.log(`all models: ${report.allModels} (paid outside subscription ${report.paidModels})`);
  console.log(`rate ×2: ${report.rate2}${report.unknownRate2.length > 0 ? ` (extra: ${report.unknownRate2.join(', ')})` : ''}`);
  console.log(
    `provider sample: ${
      report.providerSample === null
        ? 'none of the first 40 subscription models supports provider selection'
        : `${report.providerSample.id} → ${report.providerSample.providers.join(', ')}`
    }`,
  );
  console.log(`balance: ${report.balanceUsd === null ? '—' : `$${report.balanceUsd.toFixed(2)}`}`);
  console.log(
    `weekly: used ${usage.weekly?.used ?? '—'} / remaining ${usage.weekly?.remaining ?? '—'} (${usage.weekly?.percentUsed ?? '—'}%)`,
  );
  console.log(`images: used ${usage.dailyImages?.used ?? '—'} / remaining ${usage.dailyImages?.remaining ?? '—'}`);
  console.log(`subscription: ${usage.active ? 'active' : 'inactive'} (${usage.state ?? 'unknown'})`);
  console.log(`subscription key: ${JSON.stringify(report.keys.subscription)}`);
  console.log(`balance key: ${JSON.stringify(report.keys.paygo)}`);
}

if (models.length === 0) {
  console.error('probe: the subscription catalog normalized to zero models');
  process.exit(1);
}
if (allModels.length < models.length) {
  console.error('probe: the canonical catalog is smaller than the subscription catalog');
  process.exit(1);
}