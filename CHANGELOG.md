# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-07

### Added

- **Provider card on the Models page** for the `llm-pi-ai` route `nanogpt`: the
  subscription catalog with search, a “tool calling only” filter, ×1/×2 rate
  column, reasoning-level chips, and an **Apply** action that writes the chosen
  models into `llm-pi-ai.providers.nanogpt.models`.
- **Fill from catalog** action for models added through the built-in editor: it
  supplies the missing context window, output cap, input types and reasoning
  levels without touching values the user already set.
- **×2 rate** as a ` ×2` suffix in the model name (the multiplier is not exposed
  by the NanoGPT API; the documented 12-id set is local and `extraRate2` extends
  it).
- **Reasoning levels** from each model's `reasoning_efforts` (`none → off`).
- **Quota row** inside the usage-stats footer block: text-model percentage and
  image percentage, in the same design as the Go/DeepSeek rows.
- **Host routes** `GET /dsh-nanogpt/models` and `GET /dsh-nanogpt/usage` with
  caching, stale-on-error, and typed failures (`no-key`, `unauthorized`,
  `rate-limited`, `upstream`). The plugin never calls `/chat/completions`.
- **Verification tools**: `tools/probe.mjs` (live, GET-only), `tools/smoke-host.mjs`
  and `tools/smoke-client.mjs` (offline).
