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

## [0.2.0] - 2026-11-14

### Added

- **Two pickers** in the provider card: **Subscription** (the PRO catalog) and
  **All models** (the canonical NanoGPT text catalog, paid models outside the
  subscription included). Paid entries show `$ / 1M` pricing and are locked to
  balance billing.
- **Per-model spending toggle** `Subscription | Balance`. The balance key is
  swapped in on the outbound request, so one `llm-pi-ai` route serves both
  modes while the toggle stays per model.
- **Two API-key fields** (subscription / balance) with write-only storage,
  masked preview, remove action, and the key's actual billing policy
  (`subscription only` / `subscription first` / `paygo only`) read from its
  usage response.
- **Provider selection** for balance models: `GET /api/models/:id/providers`
  through the host, `auto` plus available providers with per-million prices and
  availability; the chosen provider is sent as `X-Provider`.
- **Balance row** in the card (`$X.XX`) and a `models · subscription · balance`
  counter.
- **Host routes** `GET /dsh-nanogpt/all-models`, `/providers`, `/keys`,
  `/balance`; balance is read through `POST /check-balance`, which spends
  nothing.
- **Request rewriter**: for a model marked balance, the outbound
  chat-completion request gets the balance credential; a pinned provider adds
  `X-Provider`. A missing balance key fails the request explicitly instead of
  falling back to the subscription key.
- **Localization**: the provider card, the quota chips and the plugin card are
  available in English, Russian and Simplified Chinese. `locale/en.json`,
  `locale/ru.json` and `locale/zh.json` carry the card title and description;
  `client.js` registers the matching client dictionaries for the `nanogpt`
  namespace. This README ships in English, [Russian](README.ru.md) and
  [Simplified Chinese](README.zh.md).

### Changed

- `tools/probe.mjs` now also checks the canonical catalog, provider discovery,
  both key billing modes and the account balance.
- `smoke-host` covers every route and the request rewriter; `smoke-client`
  stubs the credential Remote and the second settings namespace.
- `npm test` now runs `tools/check-locale.mjs` first: it compares the three
  client dictionaries (every key, every `{placeholder}`) and verifies, through
  the installed harness, that `readPluginMeta` resolves the card text in all
  three languages.

### Fixed

- **Plugin card metadata**: `locale/*.json` moved from a flat
  `{title, description}` shape to `{ "meta": { "title", "description" } }`.
  `readPluginMeta` reads display text only from a top-level `meta` object and
  silently drops a flat file, so the card fell back to the package name
  `dsh-nanogpt` and never showed a localized description.
- **Saving an API key** failed with `cannot get property
  "remote.credentials" without inject`: every Remote namespace is a Cordis
  service of its own, so the client bundle now injects `remote.credentials`
  alongside `remote`.
