# dsh-nanogpt

[English](README.md) · [Русский](README.ru.md) · 中文

在 DSH 中使用 NanoGPT 的订阅制与付费模型：两个挑选器（订阅与全部文本模型）、
每个模型上“从订阅扣费 / 从余额扣费”的切换开关、两个 API 密钥及其 billing mode、
为模型选择 upstream 提供方，以及在卡片和 usage-stats 区块中显示的周配额余量。

## 为什么

NanoGPT 提供 **298** 个订阅模型和 **618** 个文本模型（其中 318 个是付费模型，
不在订阅范围内），而 DSH 内置的选择器会把它们一次性全部列出。插件提供：

* **只显示已勾选的模型** —— 挑选器把选中的 id 写入
  `llm-pi-ai.providers.nanogpt.models`，选择器恰好只显示这些模型；
* **两个挑选器** —— “订阅”（仅包含 PRO 内的模型）和“全部模型”（NanoGPT 的规范列表：
  订阅 + 付费）。挑选器中的付费模型标注了 `$/1M in/out` 价格，并强制从余额扣费；
* **每个模型的扣费方式** —— “订阅”（密钥 `NANOGPT_API_KEY`，每周额度）
  或“余额”（密钥 `NANOGPT_PAYGO_API_KEY`，账户中的资金）；
* **卡片中的两个密钥字段** —— 分别用于订阅和余额，带掩码预览，并显示密钥实际的
  billing mode（`subscription only` / `subscription first` / `paygo only`）；
* **提供方选择** —— 在“余额”模式下，可为模型从 `GET /api/models/:id/providers`
  中选择提供方：名称、`$/1M` 价格，不可用的显示为灰色；“自动”为默认值。
  显式指定的提供方始终按提供方的价格从余额扣费，因此该列表只对余额模式的模型显示；
* **倍率 ×1/×2** —— 订阅挑选器中的一列，以及订阅模型名称中的 ` ×2` 后缀；
* **推理层级** —— 从模型的 `reasoning_efforts` 映射到 `llm-pi-ai` 的
  `reasoningEfforts`（`none → off`，其余同名）；
* **配额与余额** —— 卡片中订阅的周额度进度条、`$X.XX` 余额，以及“N 个模型 · 订阅 X ·
  余额 Y”计数器；usage-stats 区块内的“NanoGPT · 文本 N% · 图片 N%”一行，
  以及卡片中的进度条；
* **三种界面语言** —— 提供商卡片、配额徽章以及插件列表中的插件卡片提供英语、俄语和
  简体中文，语言跟随 DSH 的「设置 → 通用 → 语言」设置。

如果模型是通过**内置**的 Models 编辑器添加的（它的 “Fetch available models”
读取 `{baseURL}/models` 时不带 `?detailed=true`，因此只能拿到 id），NanoGPT
卡片会显示警告“有 N 个模型缺少设置”和按钮**“从目录填充”**：该按钮会补齐
`contextWindow`、`maxTokens`、`input` 和 `reasoningEfforts`，不会改动用户已经设置的值。

## 两个密钥与扣费方式

NanoGPT 允许创建多个 API 密钥，并在控制台（API keys → key → Billing）
为每个密钥设置策略：`subscription first`、`subscription only` 或
`pay-as-you-go only`。插件需要两个密钥：

| 卡片中的字段 | Credential 引用 | 扣费来源 |
|---|---|---|
| 订阅密钥 | `NANOGPT_API_KEY` | input token 的每周额度 |
| 余额密钥 | `NANOGPT_PAYGO_API_KEY` | NanoGPT 余额中的资金 |

密钥通过 `ctx.remote.credentials.set` 写入（只写；值永远不会返回浏览器——Host
只提供掩码预览）。卡片会在字段旁显示该密钥的实际
billing mode（取自 `/subscription/v1/usage`），
并且如果余额密钥实际上是 `subscription only`，就会给出警告——那样余额模型会失败。

**密钥如何切换。** `llm-pi-ai` 中的密钥是对整条路由设置的，
而扣费方式是针对每个模型设置的，因此插件的 Host 部分在 `globalThis.fetch`
中拦截发往 `api.nano-gpt.com` 的出站请求（与 `dsh-llm-request-routing` 是同一手法）。
对于标记为“余额”的模型，请求会带上 `Authorization: Bearer <余额密钥>`；对于“订阅”
则不改动该头部。如果存在余额模型但没有保存余额密钥，请求会以明确的错误失败，
而不是消耗订阅。

**提供方。** 对于余额模型，请求中会加上 `X-Provider: <provider-id>`。NanoGPT
的显式提供方始终是 pay-as-you-go，
并且比模型的基础价格更贵（provider-selection markup），因此只有在“余额”
模式下才能选择提供方。将模型切回“订阅”时，已固定的提供方会被重置。

**付费模型。** 在“全部模型”挑选器中，`subscription.included: false`
的条目会被强制设为余额模式（切换开关被禁用）。这些模型需要在 NanoGPT
控制台开启 **Enable paid models on API**；如果余额密钥报告付费扣费已被禁止，
卡片会给出警告。

**关于余额的重要说明。** 在 pay-as-you-go 模式下，NanoGPT
会按请求的全部 `max_completion_tokens` 预留余额。
插件保留模型的 `maxTokens = max_output_tokens`（与订阅的处理方式一致），
因此在余额较少时可能出现 `402 insufficient_balance`——请提高余额，
或在内置编辑器中调小 `maxTokens`。

## 前置条件

1. NanoGPT 的密钥写入 `~/.dsh/.credentials.yaml` → `refs.NANOGPT_API_KEY`
   和 `refs.NANOGPT_PAYGO_API_KEY`（或填在 Models 页面卡片的两个字段里）。
   订阅密钥始终必需：它是 `llm-pi-ai` 路由本身的 credential；余额密钥只在存在“余额”
   模式的模型时才需要——拦截器会用它替代路由密钥。
2. 在 `llm-pi-ai` 中添加路由 `nanogpt`（位于配置的 patch 层）：

```yaml
      nanogpt:
        displayName: NanoGPT
        apiKeyEnv: NANOGPT_API_KEY
        api: openai-completions
        baseURL: https://api.nano-gpt.com/api/v1legacy
        models: [ ... ]
```

`baseURL` 是 `v1legacy`：reasoning 通过 `reasoning_content` 返回，这与 NanoGPT
官方针对 DSH 的说明所推荐的一致。不需要在 `apiKeyEnv` 中指定余额密钥：它由 Host
拦截器按模型注入。

## 安装

已发布：[github.com/taxah92/dsh-nanogpt](https://github.com/taxah92/dsh-nanogpt)，
npm `dsh-nanogpt@0.2.0`。

```
dsh plugin --profile web add dsh-nanogpt
```

从本地检出开发：

```
dsh plugin --profile web add link:/path/to/dsh-nanogpt
```

从 0.2.0 起，Host 部分会拦截 `fetch` 并新增路由，
因此更新后需要**重启 DSH**（客户端部分的改动无需重启即可生效）。

### ⚠️ 指向 `schemastery` 的符号链接

插件在 `dependencies` 中声明了 `@deepseek-ai/schemastery`，但 pnpm 不会展开 `link:`
包的依赖。Node 从真实路径解析导入，因此需要符号链接（`node_modules/` 目录不会进入
git）：

```bash
cd /path/to/dsh-nanogpt
mkdir -p node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery \
  node_modules/@deepseek-ai/schemastery
```

检查 schema 是否为“原生”的（否则 DSH 会把插件显示为“问题”，并且不会渲染设置表单）：

```bash
# 在同一包目录中执行
node -e "import('./index.js')
  .then(m => console.log(Reflect.get(m.Config, Symbol.for('schemastery')) === true))"
```

输出应为 `true`。

## 插件设置

Plugins 页面 → `nanogpt` 一行：

| 字段 | Default | 含义 |
|---|---|---|
| `apiKeyEnv` | `NANOGPT_API_KEY` | 订阅密钥的 credential 引用 |
| `paygoKeyEnv` | `NANOGPT_PAYGO_API_KEY` | 余额密钥的 credential 引用 |
| `baseURL` | `https://api.nano-gpt.com/api` | API 基地址 |
| `modelsCacheTtlMs` | `600000` | 目录与提供方列表的缓存 |
| `usageCacheTtlMs` | `60000` | 配额、余额与密钥 billing mode 的缓存 |
| `extraRate2` | `''` | 以逗号分隔的额外 ×2 id |
| `balanceModels` | `[]` | 从余额扣费的模型 id（由卡片写入） |
| `modelProviders` | `{}` | `{ "<model-id>": "<provider-id>" }`（由卡片写入） |

## Host 部分的路由

| 路由 | 返回内容 |
|---|---|
| `GET /dsh-nanogpt/models` | 订阅目录（字段名为拉丁字母：`models[]`，含 rate/efforts） |
| `GET /dsh-nanogpt/all-models` | 618 个模型的规范目录（匿名请求，不带账户过滤） |
| `GET /dsh-nanogpt/providers?model=<id>` | `supportsProviderSelection`、提供方、`$/1M` 价格 |
| `GET /dsh-nanogpt/usage` | 每周配额、图片、`routing.billingMode` |
| `GET /dsh-nanogpt/keys` | 两个密钥的状态：configured/masked/billing mode |
| `GET /dsh-nanogpt/balance` | USD 余额（`POST /check-balance`，不触发生成、不产生扣费） |

## 不产生扣费的 API 检查

```bash
node plugins/dsh-nanogpt/tools/probe.mjs          # 概要
node plugins/dsh-nanogpt/tools/probe.mjs --json   # 机器可读输出
```

脚本会读取目录、usage、第一条合适的模型的提供方列表以及余额。不会调用推理；
余额通过 `POST /check-balance` 读取，该接口不消耗 token。

## 实现结构

```
index.js          host：Config、六个 GET 路由、fetch 拦截
                  （余额模型的余额密钥 + X-Provider）
client.js         client：settings.models.provider-card（配额、余额、两个密钥、
                  两个挑选器、per-model 切换开关、提供方下拉框），
                  usage-stats 区块内的配额行
lib/normalize.js  纯归一化函数（可不依赖 DSH 测试）
tools/probe.mjs   不产生扣费的 API 检查
tools/smoke-*.mjs host 与客户端 bundle 的离线测试
```

Host 在每个请求时通过 `ctx.credentials` 解析密钥，缓存响应，并在 upstream
出错时返回 stale 缓存。客户端通过 `ctx.configForms.get('llm-pi-ai').mutate(...)`
写入所选模型——与内置编辑器走同一条路径；余额与提供方的标记写入自己的 `nanogpt`
段（volatile 字段），因此选择器和拦截器无需重启 DSH 就能看到改动。

## 限制

* ×2 倍率是一张本地映射表（外加规范目录中的 `subscription.inputTokenMultiplier`）；
  如果 NanoGPT 侧发生变化，需要修改 `extraRate2`。
* `maxTokens` 取自模型的 `max_output_tokens`（`null → 65536`），余额模型也是如此——
  参见关于余额预留的警告。
* 如果订阅密钥未保存，`llm-pi-ai`
  会在到达拦截器之前就拒绝请求（`MISSING_CREDENTIAL`），因此在路由拿到自己的密钥之前，
  余额模型也无法使用。
* “全部模型”挑选器使用的规范目录是**匿名**请求的：使用 subscription-only 密钥时
  NanoGPT 会把列表收窄为订阅集合，而匿名列表始终是完整的。
* 提供方列表仅对 `supportsProviderSelection: true` 的模型可用；
  其余模型在卡片中会显示说明，而 NanoGPT 会忽略 `X-Provider`。
* 配额行是通过 DOM 插入 usage-stats 区块的：外部 bundle 没有为第四个来源提供扩展点，
  而我们没有去给会自动更新的 npm 包打补丁。约定的是
  `data-usage-stats-footer` + `unifiedMain`；如果 usage-stats 更换了它，
  这一行会脱离出来、变成单独的一行（届时再回到这个问题：fork，还是向作者提需求）。
