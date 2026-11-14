# dsh-nanogpt

English · [Русский](README.ru.md) · [中文](README.zh.md)

Subscription and paid NanoGPT models in DSH: two pickers (subscription and all text models),
a "charged to subscription / charged to balance" switch on every model, two API keys with their
billing mode, upstream provider selection for a model, and the remaining weekly quota in the card
and in the usage-stats block.

## Why

NanoGPT serves **298** subscription and **618** text models (318 of them are paid, outside the
subscription), and the built-in DSH selector would show everything at once. The plugin provides:

* **only the marked models** — the picker writes the selected ids into
  `llm-pi-ai.providers.nanogpt.models`, and the selector shows exactly them;
* **two pickers** — "Subscription" (only models included in PRO) and "All models" (the
  canonical NanoGPT list: subscription + paid). Paid models in the picker are tagged with the
  price `$/1M in/out` and are forcibly charged to the balance;
* **a spend mode on every model** — "Subscription" (key `NANOGPT_API_KEY`, weekly limit)
  or "Balance" (key `NANOGPT_PAYGO_API_KEY`, money on the account);
* **two key fields** in the card — subscription and balance, with a masked preview and the
  key's actual billing mode (`subscription only` / `subscription first` / `paygo only`);
* **provider selection** for a model in "Balance" mode — from
  `GET /api/models/:id/providers`: name, `$/1M` price, unavailable ones in grey; "Auto" is
  the default. An explicit provider is always paid from the balance at the provider's price,
  so the list is shown only for balance models;
* **×1/×2 rate** — a column in the subscription picker and a ` ×2` suffix in the subscription
  model name;
* **reasoning levels** — from the model's `reasoning_efforts` to `reasoningEfforts` of
  `llm-pi-ai` (`none → off`, the rest keep their names);
* **quota and balance** — the weekly subscription limit bar, `$X.XX` of balance and the
  counter "N models · subscription X · balance Y" in the card; the line
  "NanoGPT · Text N% · Images N%" inside the usage-stats block and a bar in the card;
* **three interface languages** — the provider card, the quota chips and the plugin card in
  the plugin list are translated into English, Russian and Simplified Chinese; the language
  follows the DSH "Settings → General → Language" setting.

If a model was added with the **built-in** Models editor (its "Fetch available models" reads
`{baseURL}/models` without `?detailed=true`, so it gets only the id), the NanoGPT card
shows the warning "N model(s) are missing settings from the catalog" and the **"Fill from
catalog"** button: it fills in `contextWindow`, `maxTokens`, `input` and `reasoningEfforts`,
without touching values the user has already set.

## Two keys and spend mode

NanoGPT lets you create several API keys and set a policy for each in the dashboard
(API keys → key → Billing): `subscription first`, `subscription only` or
`pay-as-you-go only`. The plugin expects two keys:

| Field in the card | Credential reference | Charged to |
|---|---|---|
| Subscription key | `NANOGPT_API_KEY` | weekly input-token limit |
| Balance key | `NANOGPT_PAYGO_API_KEY` | money on the NanoGPT balance |

The keys are written through `ctx.remote.credentials.set` (write-only; the value is never
returned to the browser — the host returns only a masked preview). Next to the field the card
shows the key's actual billing mode from its `/subscription/v1/usage` and warns
if the balance key is in fact `subscription only` — balance models would then fail.

**How the key is switched.** In `llm-pi-ai` the key is set for the whole route, while the mode
is set per model, so the plugin's host half intercepts outgoing requests to
`api.nano-gpt.com` in `globalThis.fetch` (the same technique as in `dsh-llm-request-routing`).
For a model marked "Balance", the request gets `Authorization: Bearer <balance key>`;
for "Subscription" the header is left untouched. If a balance model is present but the balance
key is not saved, the request fails with an explicit error instead of spending the subscription.

**Provider.** For a balance model, `X-Provider: <provider-id>` is added to the request.
An explicit provider at NanoGPT is always pay-as-you-go and costs more than the model's base
price (provider-selection markup), so provider selection is available only in "Balance" mode.
Switching a model back to "Subscription" resets the pinned provider.

**Paid models.** In the "All models" picker, entries with `subscription.included: false`
are forcibly balance models (the switch is locked). They need **Enable paid models on API**
turned on in the NanoGPT dashboard; the card warns if the balance key
reports that paid charges are disabled.

**Important about the balance.** On pay-as-you-go, NanoGPT reserves balance for the whole
`max_completion_tokens` of the request. The plugin keeps `maxTokens = max_output_tokens` of the
model (as decided for the subscription), so a small balance can produce `402
insufficient_balance` — top up the balance or lower `maxTokens` in the built-in editor.

## Requirements

1. NanoGPT keys in `~/.dsh/.credentials.yaml` → `refs.NANOGPT_API_KEY` and
   `refs.NANOGPT_PAYGO_API_KEY` (or in the two card fields on the Models page).
   The subscription key is always required: it is the credential of the `llm-pi-ai` route
   itself; the balance key is needed only when there are models in "Balance" mode — the
   interceptor substitutes it in place of the route key.
2. The `nanogpt` route in `llm-pi-ai` (in the profile patch layer):

```yaml
      nanogpt:
        displayName: NanoGPT
        apiKeyEnv: NANOGPT_API_KEY
        api: openai-completions
        baseURL: https://api.nano-gpt.com/api/v1legacy
        models: [ ... ]
```

`baseURL` is `v1legacy`: reasoning arrives in `reasoning_content`, as NanoGPT's official
guide for DSH recommends. The balance key does not need to be set in `apiKeyEnv`:
the host interceptor substitutes it per model.

## Install

Published: [github.com/taxah92/dsh-nanogpt](https://github.com/taxah92/dsh-nanogpt),
npm `dsh-nanogpt@0.2.0`.

```
dsh plugin --profile web add dsh-nanogpt
```

Local development from a checkout:

```
dsh plugin --profile web add link:/path/to/dsh-nanogpt
```

Since 0.2.0 the host half intercepts `fetch` and adds routes, so after an update a
**DSH restart** is required (a client-side change is picked up without a restart).

### ⚠️ Symlink for `schemastery`

The plugin declares `@deepseek-ai/schemastery` in `dependencies`, but pnpm does not expand the
dependencies of a `link:` package. Node resolves imports from the real path, so a
symlink is needed (the `node_modules/` directory is not tracked in git):

```bash
cd /path/to/dsh-nanogpt
mkdir -p node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery \
  node_modules/@deepseek-ai/schemastery
```

Check that the schema is "native" (otherwise DSH shows the plugin as "Problem" and does not
render the settings form):

```bash
# from the same package directory
node -e "import('./index.js')
  .then(m => console.log(Reflect.get(m.Config, Symbol.for('schemastery')) === true))"
```

It must be `true`.

## Plugin settings

Plugins page → the `nanogpt` row:

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `NANOGPT_API_KEY` | credential reference for the subscription key |
| `paygoKeyEnv` | `NANOGPT_PAYGO_API_KEY` | credential reference for the balance key |
| `baseURL` | `https://api.nano-gpt.com/api` | API base |
| `modelsCacheTtlMs` | `600000` | cache of catalogs and provider lists |
| `usageCacheTtlMs` | `60000` | cache of the quota, the balance and the keys' billing mode |
| `extraRate2` | `''` | extra ×2 ids, comma-separated |
| `balanceModels` | `[]` | ids of models charged to the balance (written by the card) |
| `modelProviders` | `{}` | `{ "<model-id>": "<provider-id>" }` (written by the card) |

## Host routes

| Route | What it returns |
|---|---|
| `GET /dsh-nanogpt/models` | subscription catalog (Latin: `models[]` with rate/efforts) |
| `GET /dsh-nanogpt/all-models` | canonical catalog of 618 models (anonymous, without account filters) |
| `GET /dsh-nanogpt/providers?model=<id>` | `supportsProviderSelection`, providers, `$/1M` prices |
| `GET /dsh-nanogpt/usage` | weekly quota, images, `routing.billingMode` |
| `GET /dsh-nanogpt/keys` | state of both keys: configured/masked/billing mode |
| `GET /dsh-nanogpt/balance` | balance in USD (`POST /check-balance`, without generation or charges) |

## Check the API without spending

```bash
node plugins/dsh-nanogpt/tools/probe.mjs          # summary
node plugins/dsh-nanogpt/tools/probe.mjs --json   # machine-readable output
```

The script reads the catalogs, usage, the provider list for the first suitable model and the
balance. No inference is called; the balance is read through `POST /check-balance`, which does
not spend tokens.

## How it works

```
index.js          host: Config, six GET routes, fetch interception
                  (balance key + X-Provider for balance models)
client.js         client: settings.models.provider-card (quota, balance, two keys,
                  two pickers, per-model switch, provider dropdown),
                  quota row inside the usage-stats block
lib/normalize.js  pure normalization functions (tested without DSH)
tools/probe.mjs   API check without spending
tools/smoke-*.mjs offline tests for the host and the client bundle
```

The host resolves keys through `ctx.credentials` on every request, caches responses and, on an
upstream error, serves the stale cache. The client writes the selected models through
`ctx.configForms.get('llm-pi-ai').mutate(...)` — the same path as the built-in editor;
the balance and provider flags go to the plugin's own `nanogpt` section (volatile fields), so
the selector and the interceptor see the edit without a DSH restart.

## Limitations

* The ×2 rate is a local map (plus `subscription.inputTokenMultiplier` in the canonical
  catalog); if NanoGPT changes it, `extraRate2` is edited.
* `maxTokens` is taken from the model's `max_output_tokens` (`null → 65536`) and for balance
  models too — see the warning about the balance reserve.
* If the subscription key is not saved, `llm-pi-ai` rejects the request before the interceptor
  (`MISSING_CREDENTIAL`), so balance models will not work either until the route gets
  its own key.
* The canonical catalog for the "All models" picker is requested **anonymously**: with a
  subscription-only key NanoGPT narrows it down to the subscription set, while the anonymous
  list is always complete.
* The provider list is available only for `supportsProviderSelection: true`; for other
  models the card has an explanation, and NanoGPT ignores `X-Provider`.
* The quota row is inserted into the usage-stats block through the DOM: a third-party bundle
  has no extension point for a fourth source, and patching an npm package that updates itself
  was not done. The contract is `data-usage-stats-footer` + `unifiedMain`; if usage-stats
  changes it, the row will fall back to a separate row (revisit the question: fork or ask the author).