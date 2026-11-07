/**
 * Client half of `dsh-nanogpt`.
 *
 * Two surfaces, both fed by the Host half's read-only routes:
 *
 *   1. `settings.models.provider-card` (keyed by the `llm-pi-ai` settings
 *      namespace) — a NanoGPT card on the provider's row in Settings → Models:
 *      subscription quota, and a picker that writes the chosen models into
 *      `llm-pi-ai.providers.nanogpt.models` through the same `configForms`
 *      service the shipped editor uses. The selector then shows exactly the
 *      chosen models, with ` ×2` in the name for models billed at ×2.
 *   2. The sidebar footer — one extra row inside the usage-stats plugin's
 *      unified block, in the same design as its Go/DeepSeek quota rows: the
 *      text-model percentage and the image percentage. The usage-stats bundle
 *      has no extension point for a fourth source, so the row is inserted into
 *      that block's DOM and re-inserted if the block re-renders; the
 *      third-party package itself is not modified.
 *
 * Contract this leans on (read from the installed packages, not guessed):
 *   - `settings.models.provider-card` is a keyed slot dispatched with
 *     `entryKey = settingsNs`; owner props carry the row's
 *     `ProviderDirectoryEntry` (`provider.provider` is the route id).
 *   - `ctx.configForms.get('llm-pi-ai')` returns a `ConfigForm` whose
 *     `mutate(ops, revision)` writes path ops against the Host settings
 *     document; `llm-pi-ai.providers` is volatile, so the adapter re-resolves
 *     the route without a restart.
 *   - The usage-stats footer block carries `data-usage-stats-footer` and its
 *     rows use `unifiedGoRow`/`unifiedMain` class suffixes; the row is placed
 *     before the `unifiedMain` (today) row.
 *
 * The Host owns the catalog and the quota; this half never talks to NanoGPT
 * directly and never calls an inference endpoint.
 */
window.__ModuleLoader__.load({
  id: 'dsh-nanogpt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this bundle. */
    const NS = 'nanogpt';

    /** `llm-pi-ai` route id this plugin curates. */
    const PROVIDER = 'nanogpt';

    /** Settings namespace the provider route lives in. */
    const SETTINGS_NS = 'llm-pi-ai';

    /** Host routes; keep in step with `index.js`. */
    const MODELS_ROUTE = '/dsh-nanogpt/models';
    const USAGE_ROUTE = '/dsh-nanogpt/usage';

    /** Quota poll interval; the usage endpoint is a cheap GET. */
    const USAGE_POLL_MS = 300000;

    /**
     * Theme-token-only stylesheet. Every colour is a `--dsw-*` token so the
     * card follows light/dark and any installed theme; nothing hardcodes a
     * palette.
     */
    const CSS = `
.dsh-ng-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.dsh-ng-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsh-ng-title{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsh-ng-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-ng-quota{display:flex;flex-direction:column;gap:4px}
.dsh-ng-quotaHead{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-ng-quotaValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsh-ng-bar{height:6px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dsh-ng-barFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width .2s}
.dsh-ng-quotaFoot{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-ng-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-ng-count{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-ng-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;transition:background .12s}
.dsh-ng-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ng-btn:disabled{opacity:.6;cursor:default}
.dsh-ng-btnPrimary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ng-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary)}
.dsh-ng-link{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:11px;line-height:16px;padding:0}
.dsh-ng-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.dsh-ng-msg{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-ng-warn{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px}
.dsh-ng-msgErr{color:var(--dsw-alias-state-error-primary)}
.dsh-ng-picker{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dsh-ng-pickerBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-ng-search{box-sizing:border-box;flex:1;min-width:140px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px}
.dsh-ng-search:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-ng-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dsh-ng-pickerActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-ng-visible{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-ng-list{display:flex;flex-direction:column;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsh-ng-row{display:flex;align-items:center;gap:8px;padding:4px 8px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ng-row:last-child{border-bottom:none}
.dsh-ng-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ng-rowMain{display:flex;flex-direction:column;min-width:0;flex:1}
.dsh-ng-rowName{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ng-rowId{font-family:var(--ds-font-family-code);font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ng-rate{flex:none;min-width:26px;text-align:center;font-size:10px;line-height:14px;padding:1px 4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-ng-rate2{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);color:var(--dsw-alias-state-warn-label)}
.dsh-ng-rowMeta{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-ng-rowEfforts{flex:none;max-width:120px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ng-pickerFoot{display:flex;align-items:center;gap:8px}
.dsh-ng-footerRow{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:20px;padding:0 2px}
.dsh-ng-footerLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;font-size:11px;line-height:18px}
.dsh-ng-footerChip{height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);cursor:default;border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;white-space:nowrap;flex:1 1 0;justify-content:center;min-width:0;font-variant-numeric:tabular-nums}
.dsh-ng-footerChipWarn{color:var(--dsw-alias-state-warn-primary,#b45309)}
.dsh-ng-footerChipOver{color:var(--dsw-alias-state-error-primary,#e5484d)}
`;

    /** English copy; also the fallback, so every key must exist here. */
    const EN = {
      'card.title': 'NanoGPT',
      'card.subtitle': 'PRO subscription',
      'card.quota': 'Weekly input tokens',
      'card.left': 'left',
      'card.used': '{used} of {total} used',
      'card.reset': 'resets {date}',
      'card.images': 'Images today: {used} used, {remaining} left',
      'card.selected': '{n} selected',
      'card.choose': 'Choose models',
      'card.hide': 'Hide',
      'card.search': 'Search models',
      'card.toolOnly': 'Tool calling only',
      'card.selectVisible': 'Select visible',
      'card.deselectVisible': 'Deselect visible',
      'card.visible': '{n} shown',
      'card.apply': 'Apply',
      'card.cancel': 'Cancel',
      'card.saving': 'Saving…',
      'card.saved': 'Saved. The model picker updates on the next open.',
      'card.rejected': 'The host rejected the change.',
      'card.noKey': 'API key is not configured. Add it on the Models page.',
      'card.loading': 'Loading the subscription catalog…',
      'card.error': 'Could not load the catalog: {message}',
      'card.stale': 'Showing a cached catalog: {message}',
      'card.empty': 'No models match the filter.',
      'card.incomplete': '{n} model(s) are missing settings from the catalog.',
      'card.enrich': 'Fill from catalog',
      'card.enriched': 'Settings filled from the catalog.',
      'chip.label': 'NanoGPT',
      'chip.text': 'Text',
      'chip.images': 'Images',
      'chip.tooltip':
        'NanoGPT PRO · text: {textPercent}% of the weekly input-token allowance used ({remaining} left, resets {reset}) · images: {imagePercent}% of the daily allowance used ({imagesUsed}/{imagesTotal})',
      'chip.noKey': 'NanoGPT key is not configured',
      'chip.error': 'NanoGPT quota is unavailable',
    };

    /** Russian copy; missing keys fall back to {@link EN}. */
    const RU = {
      'card.title': 'NanoGPT',
      'card.subtitle': 'подписка PRO',
      'card.quota': 'Недельные input-токены',
      'card.left': 'осталось',
      'card.used': 'использовано {used} из {total}',
      'card.reset': 'сброс {date}',
      'card.images': 'Картинки сегодня: {used} использовано, {remaining} осталось',
      'card.selected': 'выбрано {n}',
      'card.choose': 'Выбрать модели',
      'card.hide': 'Скрыть',
      'card.search': 'Поиск моделей',
      'card.toolOnly': 'только с tool calling',
      'card.selectVisible': 'Выбрать видимые',
      'card.deselectVisible': 'Снять видимые',
      'card.visible': 'показано {n}',
      'card.apply': 'Применить',
      'card.cancel': 'Отмена',
      'card.saving': 'Сохранение…',
      'card.saved': 'Сохранено. Пикер моделей обновится при следующем открытии.',
      'card.rejected': 'Хост отклонил изменение.',
      'card.noKey': 'Ключ не настроен. Добавьте его на странице Models.',
      'card.loading': 'Загрузка подписочного каталога…',
      'card.error': 'Не удалось загрузить каталог: {message}',
      'card.stale': 'Показан кэш каталога: {message}',
      'card.empty': 'Под фильтр ничего не подходит.',
      'card.incomplete': 'У {n} модел(ей) не хватает настроек из каталога.',
      'card.enrich': 'Заполнить из каталога',
      'card.enriched': 'Настройки заполнены из каталога.',
      'chip.label': 'NanoGPT',
      'chip.text': 'Текст',
      'chip.images': 'Фото',
      'chip.tooltip':
        'NanoGPT PRO · текст: использовано {textPercent}% недельного лимита input-токенов (осталось {remaining}, сброс {reset}) · картинки: использовано {imagePercent}% дневного лимита ({imagesUsed}/{imagesTotal})',
      'chip.noKey': 'Ключ NanoGPT не настроен',
      'chip.error': 'Квота NanoGPT недоступна',
    };

    /** Chinese copy; missing keys fall back to {@link EN}. */
    const ZH = {
      'card.title': 'NanoGPT',
      'card.subtitle': 'PRO 订阅',
      'card.quota': '每周输入 token',
      'card.left': '剩余',
      'card.used': '已用 {used} / {total}',
      'card.reset': '{date} 重置',
      'card.images': '今日图片：已用 {used}，剩余 {remaining}',
      'card.selected': '已选 {n}',
      'card.choose': '选择模型',
      'card.hide': '收起',
      'card.search': '搜索模型',
      'card.toolOnly': '仅支持工具调用',
      'card.selectVisible': '全选可见',
      'card.deselectVisible': '取消全选可见',
      'card.visible': '显示 {n}',
      'card.apply': '应用',
      'card.cancel': '取消',
      'card.saving': '保存中…',
      'card.saved': '已保存。下次打开时模型选择器会更新。',
      'card.rejected': '主机拒绝了修改。',
      'card.noKey': '未配置 API 密钥，请在 Models 页面添加。',
      'card.loading': '正在加载订阅目录…',
      'card.error': '无法加载目录：{message}',
      'card.stale': '显示缓存的目录：{message}',
      'card.empty': '没有符合筛选条件的模型。',
      'card.incomplete': '{n} 个模型缺少目录中的设置。',
      'card.enrich': '从目录填充',
      'card.enriched': '已从目录填充设置。',
      'chip.label': 'NanoGPT',
      'chip.text': '文本',
      'chip.images': '图片',
      'chip.tooltip':
        'NanoGPT PRO · 文本：已用每周输入 token 额度的 {textPercent}%（剩余 {remaining}，{reset} 重置）· 图片：已用每日额度的 {imagePercent}%（{imagesUsed}/{imagesTotal}）',
      'chip.noKey': '未配置 NanoGPT 密钥',
      'chip.error': 'NanoGPT 配额不可用',
    };

    /** Compact token count: 60M, 1.2M, 345K. */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
      return String(Math.round(value));
    }

    /** Local date-time for a millisecond timestamp. */
    function formatDate(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return '—';
      }
    }

    /** `off · low · high` for a model's reasoning levels. */
    function effortsText(efforts) {
      if (efforts === null || typeof efforts !== 'object') return '';
      return Object.keys(efforts).join(' · ');
    }

    /** Keep the ` ×2` suffix in sync with the rate (mirror of `lib/normalize.js`). */
    function withRateSuffix(name, rate) {
      const base = String(name ?? '').replace(/\s*\(?×2\)?\s*$/u, '').trim();
      return rate === 2 ? `${base} ×2` : base;
    }

    /** One `llm-pi-ai` model entry built from a normalized catalog record. */
    function modelEntry(model) {
      return {
        id: model.id,
        name: withRateSuffix(model.name, model.rate),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
      };
    }

    /**
     * Fill an existing entry's missing fields from the catalog.
     *
     * The built-in Models editor adds a model from the endpoint's plain
     * `/models` listing, which discloses only ids — so a model added there
     * lands with no context window, output cap, input types, or reasoning
     * levels. This merge keeps every user-tuned value and supplies only what
     * the entry does not declare.
     * @param {object} entry - configured `llm-pi-ai` model entry.
     * @param {object|undefined} model - normalized catalog record for the same id.
     * @returns {object} the entry with missing fields filled.
     */
    function mergeEntry(entry, model) {
      if (model === undefined) return entry;
      return {
        ...entry,
        // The built-in editor names a hand-added model after its id; the
        // catalog's display name is better, but a user-renamed entry stays.
        name: withRateSuffix(entry.name === entry.id ? model.name : entry.name, model.rate),
        contextWindow: entry.contextWindow ?? model.contextWindow,
        maxTokens: entry.maxTokens ?? model.maxTokens,
        input: entry.input ?? model.input,
        reasoningEfforts: entry.reasoningEfforts ?? model.reasoningEfforts,
      };
    }

    /**
     * Shared Host-data store: the subscription catalog and the quota.
     *
     * Both surfaces read the same snapshot, so the card and the chip never
     * disagree about the remaining allowance. Fetches are de-duplicated while
     * one is in flight; `force` bypasses the in-flight guard for a click.
     */
    function createHostStore() {
      let state = {
        models: null,
        modelsError: null,
        modelsStale: false,
        loadingModels: false,
        usage: null,
        usageError: null,
        loadingUsage: false,
      };
      const listeners = new Set();
      const publish = (patch) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener();
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const getSnapshot = () => state;

      let modelsPromise = null;
      const loadModels = (force = false) => {
        if (modelsPromise !== null && !force) return modelsPromise;
        publish({ loadingModels: true });
        modelsPromise = fetch(MODELS_ROUTE, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
              publish({
                loadingModels: false,
                modelsError: body?.error === 'no-key' ? 'no-key' : (body?.message ?? `HTTP ${response.status}`),
              });
              return;
            }
            publish({
              loadingModels: false,
              models: Array.isArray(body?.models) ? body.models : [],
              modelsError: null,
              modelsStale: body?.stale === true,
            });
          })
          .catch((error) => {
            publish({ loadingModels: false, modelsError: String(error?.message ?? error) });
          })
          .finally(() => {
            modelsPromise = null;
          });
        return modelsPromise;
      };

      let usagePromise = null;
      const loadUsage = (force = false) => {
        if (usagePromise !== null && !force) return usagePromise;
        publish({ loadingUsage: true });
        usagePromise = fetch(USAGE_ROUTE, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
              publish({
                loadingUsage: false,
                usageError: body?.error === 'no-key' ? 'no-key' : (body?.message ?? `HTTP ${response.status}`),
              });
              return;
            }
            publish({ loadingUsage: false, usage: body, usageError: null });
          })
          .catch((error) => {
            publish({ loadingUsage: false, usageError: String(error?.message ?? error) });
          })
          .finally(() => {
            usagePromise = null;
          });
        return usagePromise;
      };

      return { subscribe, getSnapshot, loadModels, loadUsage };
    }

    /**
     * Outer card: the slot dispatches on every `llm-pi-ai` provider row, so
     * this half decides whether the row is NanoGPT before any hook runs.
     */
    function ProviderCard(props) {
      if (props?.provider?.provider !== PROVIDER) return null;
      return h(NanoGptCard, props);
    }

    /** The NanoGPT provider card: quota summary plus the model picker. */
    function NanoGptCard({ provider, keyConfigured, t, form, store }) {
      const host = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const formState = React.useSyncExternalStore(
        React.useCallback((notify) => form.subscribe(notify), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
      );

      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [toolOnly, setToolOnly] = React.useState(true);
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      React.useEffect(() => {
        store.loadModels();
        store.loadUsage();
      }, [store]);

      const configuredModels = React.useMemo(() => {
        const models = formState.value?.providers?.[PROVIDER]?.models;
        return Array.isArray(models) ? models : [];
      }, [formState.value]);
      const configuredIds = React.useMemo(
        () => new Set(configuredModels.map((entry) => entry.id)),
        [configuredModels],
      );
      const selected = draft ?? configuredIds;

      const models = host.models ?? [];
      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        return models.filter((model) => {
          if (toolOnly && model.toolCalling !== true) return false;
          if (needle.length === 0) return true;
          return (
            String(model.id).toLowerCase().includes(needle) ||
            String(model.name).toLowerCase().includes(needle)
          );
        });
      }, [models, query, toolOnly]);

      // Entries the built-in editor added from the plain `/models` listing
      // carry an id and nothing else; the card offers to fill them.
      const incomplete = React.useMemo(() => {
        const byId = new Map(models.map((model) => [model.id, model]));
        return configuredModels.filter((entry) => {
          const model = byId.get(entry.id);
          if (model === undefined) return false;
          return (
            entry.contextWindow === undefined ||
            entry.maxTokens === undefined ||
            entry.input === undefined ||
            (entry.reasoningEfforts === undefined && model.reasoningEfforts !== undefined)
          );
        });
      }, [configuredModels, models]);

      const toggle = (id) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setDraft(next);
        setMessage(null);
      };

      const selectVisible = (on) => {
        const next = new Set(selected);
        for (const model of visible) {
          if (on) next.add(model.id);
          else next.delete(model.id);
        }
        setDraft(next);
        setMessage(null);
      };

      const apply = async () => {
        setSaving(true);
        setMessage(null);
        try {
          const byId = new Map(models.map((model) => [model.id, model]));
          const next = [];
          // Existing entries keep their order and any user-tuned fields; the
          // catalog fills only what the entry does not declare (a model added
          // through the built-in editor arrives with an id and nothing else).
          for (const entry of configuredModels) {
            if (!selected.has(entry.id)) continue;
            next.push(mergeEntry(entry, byId.get(entry.id)));
          }
          // Newly selected models are appended in catalog order.
          for (const model of models) {
            if (!selected.has(model.id) || configuredIds.has(model.id)) continue;
            next.push(modelEntry(model));
          }
          const accepted = await form.mutate(
            [{ op: 'set', path: ['providers', PROVIDER, 'models'], value: next }],
            formState.revision,
          );
          if (accepted) {
            setDraft(null);
            setOpen(false);
            setMessage(t('card.saved'));
          } else {
            setMessage(t('card.rejected'));
          }
        } catch (error) {
          setMessage(String(error?.message ?? error));
        } finally {
          setSaving(false);
        }
      };

      /** Fill every configured model's missing fields from the catalog. */
      const enrich = async () => {
        setSaving(true);
        setMessage(null);
        try {
          const byId = new Map(models.map((model) => [model.id, model]));
          const next = configuredModels.map((entry) => mergeEntry(entry, byId.get(entry.id)));
          const accepted = await form.mutate(
            [{ op: 'set', path: ['providers', PROVIDER, 'models'], value: next }],
            formState.revision,
          );
          if (accepted) setMessage(t('card.enriched'));
          else setMessage(t('card.rejected'));
        } catch (error) {
          setMessage(String(error?.message ?? error));
        } finally {
          setSaving(false);
        }
      };

      const cancel = () => {
        setDraft(null);
        setOpen(false);
        setMessage(null);
      };

      const weekly = host.usage?.weekly;
      // `percentUsed` is a fraction (may exceed 1), not a percentage.
      const percent = typeof weekly?.percentUsed === 'number' ? weekly.percentUsed * 100 : 0;
      const total = weekly && typeof weekly.used === 'number' && typeof weekly.remaining === 'number'
        ? weekly.used + weekly.remaining
        : null;

      const quota = h(
        'div',
        { className: 'dsh-ng-quota' },
        h(
          'div',
          { className: 'dsh-ng-quotaHead' },
          h('span', null, t('card.quota')),
          h(
            'span',
            { className: 'dsh-ng-quotaValue' },
            weekly ? `${formatTokens(weekly.remaining)} ${t('card.left')}` : '—',
          ),
        ),
        h(
          'div',
          { className: 'dsh-ng-bar' },
          h('div', {
            className: 'dsh-ng-barFill',
            style: { width: `${Math.min(100, Math.max(0, percent))}%` },
          }),
        ),
        h(
          'div',
          { className: 'dsh-ng-quotaFoot' },
          h('span', null, weekly ? t('card.used', { used: formatTokens(weekly.used), total: formatTokens(total) }) : ''),
          h('span', null, weekly?.resetAt ? t('card.reset', { date: formatDate(weekly.resetAt) }) : ''),
        ),
        host.usage?.dailyImages
          ? h(
              'div',
              { className: 'dsh-ng-quotaFoot' },
              t('card.images', {
                used: host.usage.dailyImages.used ?? 0,
                remaining: host.usage.dailyImages.remaining ?? 0,
              }),
            )
          : null,
      );

      const row = (model) =>
        h(
          'label',
          { className: 'dsh-ng-row', key: model.id },
          h('input', {
            type: 'checkbox',
            checked: selected.has(model.id),
            onChange: () => toggle(model.id),
          }),
          h(
            'span',
            { className: 'dsh-ng-rowMain' },
            h('span', { className: 'dsh-ng-rowName' }, model.name),
            h('span', { className: 'dsh-ng-rowId' }, model.id),
          ),
          h(
            'span',
            { className: `dsh-ng-rate${model.rate === 2 ? ' dsh-ng-rate2' : ''}` },
            `×${model.rate}`,
          ),
          h(
            'span',
            { className: 'dsh-ng-rowMeta' },
            `${formatTokens(model.contextWindow)} · ${formatTokens(model.maxTokens)}`,
          ),
          h('span', { className: 'dsh-ng-rowEfforts' }, effortsText(model.reasoningEfforts)),
        );

      const picker = h(
        'div',
        { className: 'dsh-ng-picker' },
        h(
          'div',
          { className: 'dsh-ng-pickerBar' },
          h('input', {
            className: 'dsh-ng-search',
            type: 'search',
            value: query,
            placeholder: t('card.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'label',
            { className: 'dsh-ng-check' },
            h('input', {
              type: 'checkbox',
              checked: toolOnly,
              onChange: (event) => setToolOnly(event.target.checked),
            }),
            h('span', null, t('card.toolOnly')),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ng-pickerActions' },
          h('button', { type: 'button', className: 'dsh-ng-link', onClick: () => selectVisible(true) }, t('card.selectVisible')),
          h('button', { type: 'button', className: 'dsh-ng-link', onClick: () => selectVisible(false) }, t('card.deselectVisible')),
          h('span', { className: 'dsh-ng-visible' }, t('card.visible', { n: visible.length })),
        ),
        h(
          'div',
          { className: 'dsh-ng-list' },
          visible.length === 0
            ? h('div', { className: 'dsh-ng-msg' }, t('card.empty'))
            : visible.map(row),
        ),
        h(
          'div',
          { className: 'dsh-ng-pickerFoot' },
          h(
            'button',
            { type: 'button', className: 'dsh-ng-btn dsh-ng-btnPrimary', disabled: saving, onClick: apply },
            saving ? t('card.saving') : t('card.apply'),
          ),
          h('button', { type: 'button', className: 'dsh-ng-btn', disabled: saving, onClick: cancel }, t('card.cancel')),
        ),
      );

      const status = (() => {
        if (host.modelsError === 'no-key' || keyConfigured === false) {
          return h('div', { className: 'dsh-ng-msg dsh-ng-msgErr' }, t('card.noKey'));
        }
        if (host.modelsError !== null) {
          return h('div', { className: 'dsh-ng-msg dsh-ng-msgErr' }, t('card.error', { message: host.modelsError }));
        }
        if (host.models === null && host.loadingModels) {
          return h('div', { className: 'dsh-ng-msg' }, t('card.loading'));
        }
        if (host.modelsStale) {
          return h('div', { className: 'dsh-ng-msg' }, t('card.stale', { message: '' }));
        }
        return null;
      })();

      return h(
        'div',
        { className: 'dsh-ng-card' },
        h(
          'div',
          { className: 'dsh-ng-head' },
          h('span', { className: 'dsh-ng-title' }, t('card.title')),
          h('span', { className: 'dsh-ng-sub' }, t('card.subtitle')),
        ),
        quota,
        h(
          'div',
          { className: 'dsh-ng-actions' },
          h('span', { className: 'dsh-ng-count' }, t('card.selected', { n: selected.size })),
          h(
            'button',
            { type: 'button', className: 'dsh-ng-btn', onClick: () => setOpen(!open) },
            open ? t('card.hide') : t('card.choose'),
          ),
        ),
        status,
        incomplete.length === 0
          ? null
          : h(
              'div',
              { className: 'dsh-ng-warn' },
              h('span', null, t('card.incomplete', { n: incomplete.length })),
              h(
                'button',
                { type: 'button', className: 'dsh-ng-btn', disabled: saving, onClick: enrich },
                t('card.enrich'),
              ),
            ),
        open ? picker : null,
        message === null ? null : h('div', { className: 'dsh-ng-msg' }, message),
      );
    }

    /**
     * Embed the allowance row inside the usage-stats footer block.
     *
     * The usage-stats plugin owns the sidebar footer's unified block and has no
     * extension point for a fourth quota source (its three sources are compiled
     * into the bundle). Rather than patching a third-party npm package that
     * updates itself, this plugin inserts one extra row into that block's DOM —
     * the same place and the same chip design as the Go/DeepSeek rows — and
     * re-inserts it if the block re-renders.
     *
     * The row is a plain DOM node, not a React child: React owns the block's
     * children and would remove a foreign node on its next render, so a
     * MutationObserver puts it back. The block is a `<button>`, so the row is a
     * `<span>` (phrasing content) and a click bubbles to the block's own
     * handler, exactly like the Go chips.
     *
     * @param {object} store - shared Host-data store.
     * @param {(key: string, params?: object) => string} t - bound translator.
     * @returns {() => void} disposer removing the row, observers, and styles.
     */
    function installFooterRow(store, t) {
      const style = document.createElement('style');
      style.setAttribute('data-dsh-nanogpt', '');
      style.textContent = CSS;
      document.head.appendChild(style);

      const row = document.createElement('span');
      row.className = 'dsh-ng-footerRow';
      row.setAttribute('data-dsh-nanogpt-row', '');
      const label = document.createElement('span');
      label.className = 'dsh-ng-footerLabel';
      const textChip = document.createElement('span');
      const imageChip = document.createElement('span');
      row.append(label, textChip, imageChip);

      const tone = (value) =>
        value === null ? '' : value >= 85 ? ' dsh-ng-footerChipOver' : value >= 60 ? ' dsh-ng-footerChipWarn' : '';

      const render = () => {
        const state = store.getSnapshot();
        const weekly = state.usage?.weekly;
        const images = state.usage?.dailyImages;
        // `percentUsed` is a fraction (may exceed 1), not a percentage.
        const textPercent = typeof weekly?.percentUsed === 'number' ? Math.round(weekly.percentUsed * 100) : null;
        const imagePercent = typeof images?.percentUsed === 'number' ? Math.round(images.percentUsed * 100) : null;
        label.textContent = t('chip.label');
        textChip.className = `dsh-ng-footerChip${tone(textPercent)}`;
        textChip.textContent = `${t('chip.text')} ${textPercent === null ? '—' : `${textPercent}%`}`;
        imageChip.className = `dsh-ng-footerChip${tone(imagePercent)}`;
        imageChip.textContent = `${t('chip.images')} ${imagePercent === null ? '—' : `${imagePercent}%`}`;
        row.title = weekly
          ? t('chip.tooltip', {
              textPercent: textPercent ?? '—',
              remaining: formatTokens(weekly.remaining),
              reset: weekly.resetAt ? formatDate(weekly.resetAt) : '—',
              imagePercent: imagePercent ?? '—',
              imagesUsed: images?.used ?? 0,
              imagesTotal: images ? (images.used ?? 0) + (images.remaining ?? 0) : 0,
            })
          : state.usageError === 'no-key'
            ? t('chip.noKey')
            : t('chip.error');
      };

      let root = null;
      let block = null;
      let childObserver = null;

      /**
       * The usage-stats root carries `data-usage-stats-footer`; the visible
       * block is its `<button>` child (`unified` / `railUnified`). The row must
       * live inside that button, beside the Go/DeepSeek rows — appending it to
       * the root would put it below the block instead.
       */
      const blockOf = (found) => (found === null ? null : found.querySelector('button') ?? found);

      const place = () => {
        if (block === null) return;
        // The collapsed sidebar has no room for a full row; the expanded block
        // shows it, and the card still carries the numbers in rail mode.
        row.style.display = String(block.className).includes('rail') ? 'none' : '';
        if (block.contains(row)) return;
        const main = block.querySelector('[class*="unifiedMain"]');
        if (main !== null && main.parentNode === block) block.insertBefore(row, main);
        else block.appendChild(row);
      };

      const attach = () => {
        const found = document.querySelector('[data-usage-stats-footer]');
        const nextBlock = blockOf(found);
        if (found === root && nextBlock === block) {
          place();
          return;
        }
        if (childObserver !== null) {
          childObserver.disconnect();
          childObserver = null;
        }
        root = found;
        block = nextBlock;
        if (block === null) {
          if (row.parentNode !== null) row.parentNode.removeChild(row);
          return;
        }
        place();
        childObserver = new MutationObserver(() => place());
        childObserver.observe(block, { childList: true });
      };

      const unsubscribe = store.subscribe(render);
      const attachTimer = setInterval(attach, 2000);
      const usageTimer = setInterval(() => store.loadUsage(), USAGE_POLL_MS);
      store.loadUsage();
      render();
      attach();

      return () => {
        unsubscribe();
        clearInterval(attachTimer);
        clearInterval(usageTimer);
        if (childObserver !== null) childObserver.disconnect();
        if (row.parentNode !== null) row.parentNode.removeChild(row);
        style.remove();
      };
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { en: EN, ru: RU, zh: ZH }), 'nanogpt: dictionaries');

        const store = createHostStore();
        const form = ctx.configForms.get(SETTINGS_NS);

        ctx.effect(() => installFooterRow(store, t), 'nanogpt: footer row');

        ctx.slots.inject('settings.models.provider-card', () =>
          ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              key: SETTINGS_NS,
              locale: NS,
              inject: () => ({ t, form, store }),
            },
            ProviderCard,
          ),
        );
      },
    };
  },
});
