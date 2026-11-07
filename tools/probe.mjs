#!/usr/bin/env node
/**
 * GET-only probe for the NanoGPT API used by `dsh-nanogpt`.
 *
 * Reads the key from `NANOGPT_API_KEY` or from `~/.dsh/.credentials.yaml`
 * (`refs:` block), then checks the two endpoints the plugin serves:
 *
 *   GET /api/subscription/v1/models?detailed=true
 *   GET /api/subscription/v1/usage
 *
 * It never calls `/chat/completions`, so running it does not spend the
 * subscription allowance. Exit code 0 means both endpoints answered and the
 * normalization produced a usable catalog.
 *
 * Usage: node plugins/dsh-nanogpt/tools/probe.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { normalizeModels, normalizeUsage, RATE_2 } from '../lib/normalize.js';

const BASE = 'https://api.nano-gpt.com/api';
const TIMEOUT_MS = 30000;

/** Read `refs.NANOGPT_API_KEY` from the DSH credentials file without a YAML dependency. */
function keyFromCredentials() {
  const path = join(homedir(), '.dsh', '.credentials.yaml');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const match = text.match(/^\s*NANOGPT_API_KEY:\s*["']?([^"'\s#]+)["']?\s*$/m);
  return match?.[1];
}

/** Fetch one endpoint as JSON. */
async function getJson(path, key) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

const key = process.env.NANOGPT_API_KEY ?? keyFromCredentials();
if (key === undefined || key.length === 0) {
  console.error('probe: NANOGPT_API_KEY is not set and not found in ~/.dsh/.credentials.yaml');
  process.exit(2);
}

const [modelsPayload, usagePayload] = await Promise.all([
  getJson('/subscription/v1/models?detailed=true', key),
  getJson('/subscription/v1/usage', key),
]);

const models = normalizeModels(modelsPayload);
const usage = normalizeUsage(usagePayload);
const toolCalling = models.filter((model) => model.toolCalling).length;
const reasoning = models.filter((model) => model.reasoningEfforts !== undefined).length;
const rate2 = models.filter((model) => model.rate === 2).length;
const unknownRate2 = models.filter((model) => model.rate === 2 && !RATE_2.has(model.id)).map((model) => model.id);

const report = {
  models: models.length,
  toolCalling,
  reasoning,
  rate2,
  rate2Ids: models.filter((model) => model.rate === 2).map((model) => model.id),
  unknownRate2,
  weekly: usage.weekly,
  dailyImages: usage.dailyImages,
  active: usage.active,
  state: usage.state,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`models: ${report.models} (tool calling ${toolCalling}, reasoning ${reasoning})`);
  console.log(`rate ×2: ${rate2}${unknownRate2.length > 0 ? ` (extra: ${unknownRate2.join(', ')})` : ''}`);
  console.log(
    `weekly: used ${usage.weekly?.used ?? '—'} / remaining ${usage.weekly?.remaining ?? '—'} (${usage.weekly?.percentUsed ?? '—'}%)`,
  );
  console.log(`images: used ${usage.dailyImages?.used ?? '—'} / remaining ${usage.dailyImages?.remaining ?? '—'}`);
  console.log(`subscription: ${usage.active ? 'active' : 'inactive'} (${usage.state ?? 'unknown'})`);
}

if (models.length === 0) {
  console.error('probe: the subscription catalog normalized to zero models');
  process.exit(1);
}
