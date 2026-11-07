# dsh-nanogpt

**NanoGPT PRO subscription models for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a curated model picker, ×2 rate badges, reasoning levels and the remaining weekly quota — without spending the subscription allowance.**

NanoGPT exposes **302** subscription-included text models through one OpenAI-compatible API. Pointing
DeepSeek Harness at it directly works, but the model picker then shows all 302, the ×1/×2 billing
multiplier is invisible, and the remaining weekly allowance lives on a website. This plugin adds the
missing pieces:

* **Only the models you mark.** The provider card on the Models page lists the subscription catalog
  with search and a “tool calling only” filter; ticking models writes them into
  `llm-pi-ai.providers.nanogpt.models`, and the model picker shows exactly those.
* **The ×1/×2 rate.** NanoGPT does not return the multiplier from any endpoint — it is server-side
  accounting. The plugin carries the documented ×2 set (12 model ids) and shows it as a column in the
  picker and as a ` ×2` suffix in the model name.
* **Reasoning levels.** Each model's `reasoning_efforts` becomes the harness's Effort menu
  (`none → off`, the rest keep their names), so “Off” really turns thinking off.
* **The remaining quota.** A row inside the usage-stats footer block — the same design as its
  Go/DeepSeek rows — with the text-model percentage and the image percentage, plus a quota bar in the
  provider card.

The plugin only issues `GET /api/subscription/v1/models` and `GET /api/subscription/v1/usage`. It
never calls `/chat/completions`, so it does not spend the allowance it reports.

## Requirements

| What | Why |
|---|---|
| DeepSeek Harness **≥ 0.2.2-rc.1** | The plugin uses the 0.2.x client contract (`settings.models.provider-card`, `ctx.configForms`, `ctx.locale`) and the `llm-pi-ai` provider route. |
| Node.js **≥ 22** | The harness runtime. |
| A **NanoGPT PRO** subscription | The catalog endpoint returns subscription-included models only. |
| A NanoGPT API key | Stored as `NANOGPT_API_KEY` in `~/.dsh/.credentials.yaml` (or entered on the Models page). |
| The `llm-pi-ai` bundle | The provider route lives there; it ships with the harness. |
| `@xfqz86/dsh-usage-stats` (optional) | The quota row is inserted into its footer block. Without it the card still shows the quota. |

## Install

```bash
# 1. Add the bundle
dsh plugin --profile web add dsh-nanogpt

# 2. Make sure the bundle is enabled in the profile: dsh.profile.bundles must list "dsh-nanogpt"
#    (the plugin manager / market toggle does the same thing)

# 3. No restart needed for a new plugin: the loader picks up the new row and the
#    client bundle live. A restart is only needed after editing the host half of
#    an already-loaded plugin, or after moving the plugin to another path.
```

The plugin adds one row to the profile patch layer:

```yaml
- id: nanogpt
  name: dsh-nanogpt
```

The row id `nanogpt` **is** the plugin's settings namespace — do not rename it, or the settings form
and the patch layer will stop finding each other.

**Activation.** A new plugin is picked up live: the loader registers the new row and the client
bundle without a restart. A restart is needed only after editing the **host half** (`index.js`,
`lib/*.js`) of an already-loaded plugin, after changing the plugin's **path**, or after changing the
client package meta (`package.json` `dsh.client`/`exports`). The client half (`client.js`) and
volatile config fields are picked up live.

Then add the provider route to `llm-pi-ai` in `~/.dsh/profiles/web/cordis.patch.yml` (the plugin
does not create it for you, because a route needs at least one model):

```yaml
- id: llm-pi-ai
  config:
    providers:
      nanogpt:
        displayName: NanoGPT
        apiKeyEnv: NANOGPT_API_KEY
        api: openai-completions
        baseURL: https://api.nano-gpt.com/api/v1legacy
        models:
          - id: deepseek/deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts: { off: none, low: low, high: high, max: max }
```

`v1legacy` is the base URL NanoGPT's own DeepSeek Harness guide recommends: it returns reasoning in
`reasoning_content`, which the harness keeps across tool calls more often than the `reasoning` field
of `/api/v1`.

## Use

1. Open **Settings → Models** and find the **NanoGPT** row.
2. The card shows the remaining weekly allowance and the image quota.
3. Click **Choose models**, search, tick what you need, and **Apply**. The model picker now shows
   exactly those models; ×2 models carry the ` ×2` suffix.
4. Pick a model and an **Effort** level in the composer.

If a model was added through the built-in editor instead (its “Fetch available models” reads
`{baseURL}/models` without `?detailed=true`, so it gets ids only), the card shows a warning and a
**Fill from catalog** button: it supplies the missing context window, output cap, input types and
reasoning levels without touching values you already set.

## Settings

Plugins page → the `nanogpt` row:

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `NANOGPT_API_KEY` | Credential reference holding the key. |
| `baseURL` | `https://api.nano-gpt.com/api` | NanoGPT API base. |
| `modelsCacheTtlMs` | `600000` | Catalog cache lifetime. |
| `usageCacheTtlMs` | `60000` | Quota cache lifetime. |
| `extraRate2` | `''` | Extra ×2 model ids, comma-separated. |

## Verify without spending the allowance

```bash
# Live API, GET-only: catalog size, ×2 set, weekly quota, image quota
node tools/probe.mjs

# Offline: route wiring, normalization, no-key/401/429 shapes
node tools/smoke-host.mjs

# Offline: client bundle, provider card, quota row placement
node tools/smoke-client.mjs
```

## How it works

```
llm-pi-ai (shipped bundle)
  providers.nanogpt ──────────────► the harness model picker
        ▲                                   ▲
        │ configForms.mutate                 │ (only the marked models)
        │                                   │
dsh-nanogpt                                │
  host: GET /dsh-nanogpt/models ───────────┘  (catalog + rate + reasoning levels)
        GET /dsh-nanogpt/usage                 (quota)
  client: settings.models.provider-card        NanoGPT card: quota + picker
          usage-stats footer row               text/image percentages
```

* The host resolves the key through `ctx.credentials` on every request, caches both responses, and
  serves the last good payload when NanoGPT fails.
* The client writes the chosen models through `ctx.configForms.get('llm-pi-ai').mutate(...)` — the
  same path the shipped editor uses. `llm-pi-ai.providers` is volatile, so the picker updates without
  a harness restart.
* The quota row is inserted into the usage-stats footer block's DOM (`data-usage-stats-footer`,
  before the `unifiedMain` row) and re-inserted if the block re-renders. The usage-stats bundle has no
  extension point for a fourth source, and patching a third-party npm package that updates itself was
  not an option.

## Limitations

* The ×2 set is a local map (NanoGPT does not expose it). If NanoGPT changes it, add the ids to
  `extraRate2` — no code change needed.
* `maxTokens` is taken from the model's `max_output_tokens` (`null → 65536`). If a route rejects that
  cap, lower it in the built-in model editor.
* The quota row depends on the usage-stats DOM contract. If that plugin changes
  `data-usage-stats-footer` or `unifiedMain`, the row falls back to a separate footer row.
* The plugin does not create the `nanogpt` provider route: a route needs at least one model, and the
  catalog is the user's choice.

## License

MIT — see [LICENSE](LICENSE).
