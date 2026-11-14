/**
 * Client half of `dsh-nanogpt`.
 *
 * Two surfaces, both fed by the Host half's routes:
 *
 *   1. `settings.models.provider-card` (keyed by the `llm-pi-ai` settings
 *      namespace) — a NanoGPT card on the provider's row in Settings → Models:
 *      quota, balance, the two API-key fields with their billing policy, and
 *      two model pickers. The subscription picker lists only models included
 *      in NanoGPT PRO; the all-models picker lists every text model NanoGPT
 *      serves, paid models outside the subscription included. Each row has a
 *      per-model spending toggle (subscription / balance). A balance row also
 *      offers provider selection, discovered through
 *      `GET /api/models/:id/providers` on the Host.
 *
 *      The chosen models are written into `llm-pi-ai.providers.nanogpt.models`
 *      through the same `configForms` service the shipped editor uses; the
 *      balance flags and provider pins are written into this plugin's own
 *      settings namespace (`nanogpt`). The Host rewrites the outbound request
 *      for balance models: it swaps in the balance credential and injects the
 *      pinned provider into the body.
 *   2. The sidebar footer — one extra row inside the usage-stats plugin's
 *      unified block, unchanged: the subscription text percentage and the
 *      image percentage. The usage-stats bundle has no extension point for a
 *      fourth source, so the row is inserted into that block's DOM and
 *      re-inserted if the block re-renders; the third-party package itself is
 *      not modified.
 *
 * Contract this leans on (read from the installed packages, not guessed):
 *   - `settings.models.provider-card` is a keyed slot dispatched with
 *     `entryKey = settingsNs`; owner props carry the row's
 *     `ProviderDirectoryEntry` (`provider.provider` is the route id).
 *   - `ctx.configForms.get(ns)` returns a `ConfigForm` whose `mutate(ops,
 *     revision)` writes path ops against the Host settings document; both
 *     `llm-pi-ai.providers` and this plugin's row are volatile, so a write
 *     re-resolves without a restart.
 *   - `ctx.remote.credentials.set/unset/describe` are the write-only credential
 *     Remote methods; a stored value never comes back to the browser.
 *   - The usage-stats footer block carries `data-usage-stats-footer` and its
 *     rows use `unifiedGoRow`/`unifiedMain` class suffixes.
 *
 * The Host owns NanoGPT I/O; this half never talks to NanoGPT directly.
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

    /** Settings namespace this plugin's own row lives in (balance flags, providers). */
    const OWN_NS = 'nanogpt';

    /** Host routes; keep in step with `index.js`. */
    const MODELS_ROUTE = '/dsh-nanogpt/models';
    const ALL_MODELS_ROUTE = '/dsh-nanogpt/all-models';
    const PROVIDERS_ROUTE = '/dsh-nanogpt/providers';
    const USAGE_ROUTE = '/dsh-nanogpt/usage';
    const KEYS_ROUTE = '/dsh-nanogpt/keys';
    const BALANCE_ROUTE = '/dsh-nanogpt/balance';

    /** Fallback credential references when the Host config is not loaded yet. */
    const SUBSCRIPTION_REF = 'NANOGPT_API_KEY';
    const PAYGO_REF = 'NANOGPT_PAYGO_API_KEY';

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
.dsh-ng-balanceRow{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}
.dsh-ng-balanceValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsh-ng-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dsh-ng-counts{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
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
.dsh-ng-keys{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dsh-ng-keyHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-ng-keyTitle{font-size:11px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-ng-keyRow{display:flex;flex-direction:column;gap:4px}
.dsh-ng-keyLabel{display:flex;align-items:baseline;gap:6px;justify-content:space-between;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-ng-keyInputRow{display:flex;align-items:center;gap:6px}
.dsh-ng-keyInput{box-sizing:border-box;flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px}
.dsh-ng-keyInput:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-ng-keyStatus{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-ng-keyStatusOk{color:var(--dsw-alias-state-success-primary,#3d9a50)}
.dsh-ng-keyStatusWarn{color:var(--dsw-alias-state-warn-label)}
.dsh-ng-fold{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);user-select:none}
.dsh-ng-picker{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dsh-ng-pickerBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-ng-search{box-sizing:border-box;flex:1;min-width:140px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px}
.dsh-ng-search:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-ng-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dsh-ng-pickerActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-ng-visible{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-ng-list{display:flex;flex-direction:column;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsh-ng-row{display:flex;flex-direction:column;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-ng-row:last-child{border-bottom:none}
.dsh-ng-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ng-rowTop{display:flex;align-items:center;gap:8px;padding:4px 8px}
.dsh-ng-rowPick{display:flex;align-items:center;gap:8px;min-width:0;flex:1;cursor:pointer}
.dsh-ng-rowMain{display:flex;flex-direction:column;min-width:0;flex:1}
.dsh-ng-rowName{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ng-rowId{font-family:var(--ds-font-family-code);font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ng-rate{flex:none;min-width:26px;text-align:center;font-size:10px;line-height:14px;padding:1px 4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-ng-rate2{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);color:var(--dsw-alias-state-warn-label)}
.dsh-ng-price{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-ng-rowMeta{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-ng-rowEfforts{flex:none;max-width:120px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ng-seg{display:inline-flex;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;overflow:hidden}
.dsh-ng-segBtn{border:none;background:transparent;height:18px;padding:0 6px;font-family:inherit;font-size:10px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap}
.dsh-ng-segBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-ng-segBtnOn{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ng-segBtnOn:hover:not(:disabled){color:var(--dsw-alias-label-primary-foreground)}
.dsh-ng-segBtn:disabled{opacity:.7;cursor:default}
.dsh-ng-rowDetail{display:flex;align-items:center;gap:6px;padding:0 8px 6px 26px;flex-wrap:wrap}
.dsh-ng-select{box-sizing:border-box;max-width:100%;min-width:160px;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;line-height:16px}
.dsh-ng-select:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-ng-note{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
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
      'card.subtitle': 'subscription + balance',
      'card.quota': 'Weekly input tokens',
      'card.left': 'left',
      'card.used': '{used} of {total} used',
      'card.reset': 'resets {date}',
      'card.images': 'Images today: {used} used, {remaining} left',
      'card.balance': 'Balance',
      'card.balanceUnavailable': '—',
      'card.selected': '{n} selected',
      'card.counts': '{n} models · {sub} subscription · {bal} balance',
      'card.subscriptionPicker': 'Subscription',
      'card.allPicker': 'All models',
      'card.hide': 'Hide',
      'card.search': 'Search models',
      'card.searchAll': 'Search all text models',
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
      'card.loadingAll': 'Loading the full model catalog…',
      'card.error': 'Could not load the catalog: {message}',
      'card.stale': 'Showing a cached catalog: {message}',
      'card.empty': 'No models match the filter.',
      'card.incomplete': '{n} model(s) are missing settings from the catalog.',
      'card.enrich': 'Fill from catalog',
      'card.enriched': 'Settings filled from the catalog.',
      'card.keys': 'API keys',
      'card.keysError': 'Could not read the key states: {message}',
      'card.keysHint':
        'Keys are stored write-only. The subscription key spends the weekly allowance; the balance key spends the NanoGPT account balance.',
      'card.subscriptionKey': 'Subscription key',
      'card.paygoKey': 'Balance key',
      'card.keyNotSet': 'not set',
      'card.keySavedShort': 'saved',
      'card.keySaved': 'Key saved.',
      'card.keyRemoved': 'Key removed.',
      'card.keyFailed': 'The key was not saved: {message}',
      'card.keyRemove': 'Remove',
      'card.keySave': 'Save',
      'card.keyShow': 'Show',
      'card.keyHide': 'Hide',
      'card.keyBilling': 'billing: {mode}',
      'card.keyBillingUnknown': 'billing: unknown',
      'card.modeSubscriptionOnly': 'subscription only',
      'card.modeSubscriptionFirst': 'subscription first',
      'card.modePaygoOnly': 'balance only',
      'card.spend': 'Spend',
      'card.spendSubscription': 'Subscription',
      'card.spendBalance': 'Balance',
      'card.paidOnly': 'Balance only',
      'card.paidOnlyHint': 'Not covered by the subscription — balance billing only.',
      'card.price': '{in} / {out} per 1M',
      'card.priceTitle': 'Model price, USD per 1M: input / output',
      'card.providerAuto': 'Auto (default)',
      'card.providerLoading': 'Loading providers…',
      'card.providerError': 'Providers unavailable: {message}',
      'card.providerUnsupported': 'This model does not support provider selection.',
      'card.providerPaygoNote': 'A pinned provider is billed to the balance at the provider price (pay-as-you-go).',
      'card.providerUnavailable': 'unavailable',
      'card.warnNoPaygo': 'The balance key is not set: models in balance mode will fail.',
      'card.warnSubOnlyKey': 'The balance key is marked subscription-only in NanoGPT: balance models will fail.',
      'card.warnPaidDisabled': 'Paid models may be disabled for this key in NanoGPT (Enable paid models on API).',
      'card.warnNoBalance': '{n} configured model(s) are outside the subscription but not marked for balance.',
      'card.warnBalanceReserve': 'Balance requests reserve the full max output tokens; a small balance can return 402.',
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
      'card.subtitle': 'подписка + баланс',
      'card.quota': 'Недельные input-токены',
      'card.left': 'осталось',
      'card.used': 'использовано {used} из {total}',
      'card.reset': 'сброс {date}',
      'card.images': 'Картинки сегодня: {used} использовано, {remaining} осталось',
      'card.balance': 'Баланс',
      'card.balanceUnavailable': '—',
      'card.selected': 'выбрано {n}',
      'card.counts': '{n} моделей · подписка {sub} · баланс {bal}',
      'card.subscriptionPicker': 'Подписка',
      'card.allPicker': 'Все модели',
      'card.hide': 'Скрыть',
      'card.search': 'Поиск моделей',
      'card.searchAll': 'Поиск по всем текстовым моделям',
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
      'card.loadingAll': 'Загрузка полного каталога моделей…',
      'card.error': 'Не удалось загрузить каталог: {message}',
      'card.stale': 'Показан кэш каталога: {message}',
      'card.empty': 'Под фильтр ничего не подходит.',
      'card.incomplete': 'У {n} модел(ей) не хватает настроек из каталога.',
      'card.enrich': 'Заполнить из каталога',
      'card.enriched': 'Настройки заполнены из каталога.',
      'card.keys': 'API-ключи',
      'card.keysError': 'Не удалось прочитать состояние ключей: {message}',
      'card.keysHint':
        'Ключи хранятся только на запись. Ключ подписки тратит недельный лимит; ключ баланса списывает деньги с баланса NanoGPT.',
      'card.subscriptionKey': 'Ключ подписки',
      'card.paygoKey': 'Ключ баланса',
      'card.keyNotSet': 'не задан',
      'card.keySavedShort': 'сохранён',
      'card.keySaved': 'Ключ сохранён.',
      'card.keyRemoved': 'Ключ удалён.',
      'card.keyFailed': 'Ключ не сохранён: {message}',
      'card.keyRemove': 'Удалить',
      'card.keySave': 'Сохранить',
      'card.keyShow': 'Показать',
      'card.keyHide': 'Скрыть',
      'card.keyBilling': 'списание: {mode}',
      'card.keyBillingUnknown': 'списание: неизвестно',
      'card.modeSubscriptionOnly': 'только подписка',
      'card.modeSubscriptionFirst': 'сначала подписка',
      'card.modePaygoOnly': 'только баланс',
      'card.spend': 'Списание',
      'card.spendSubscription': 'Подписка',
      'card.spendBalance': 'Баланс',
      'card.paidOnly': 'Только баланс',
      'card.paidOnlyHint': 'Не входит в подписку — можно списывать только с баланса.',
      'card.price': '{in} / {out} за 1M',
      'card.priceTitle': 'Цена модели, USD за 1M: вход / выход',
      'card.providerAuto': 'Авто (по умолчанию)',
      'card.providerLoading': 'Загрузка провайдеров…',
      'card.providerError': 'Провайдеры недоступны: {message}',
      'card.providerUnsupported': 'Эта модель не поддерживает выбор провайдера.',
      'card.providerPaygoNote': 'Закреплённый провайдер всегда списывается с баланса по цене провайдера (pay-as-you-go).',
      'card.providerUnavailable': 'недоступен',
      'card.warnNoPaygo': 'Ключ баланса не задан: модели в режиме «Баланс» будут падать.',
      'card.warnSubOnlyKey': 'Ключ баланса в NanoGPT помечен как «только подписка»: балансные модели будут падать.',
      'card.warnPaidDisabled': 'Платные модели могут быть выключены для этого ключа в NanoGPT (Enable paid models on API).',
      'card.warnNoBalance': '{n} настроенная модель вне подписки, но не помечена как «Баланс».',
      'card.warnBalanceReserve': 'Балансные запросы резервируют весь max output; при маленьком балансе возможен 402.',
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
      'card.subtitle': '订阅 + 余额',
      'card.quota': '每周输入 token',
      'card.left': '剩余',
      'card.used': '已用 {used} / {total}',
      'card.reset': '{date} 重置',
      'card.images': '今日图片：已用 {used}，剩余 {remaining}',
      'card.balance': '余额',
      'card.balanceUnavailable': '—',
      'card.selected': '已选 {n}',
      'card.counts': '{n} 个模型 · 订阅 {sub} · 余额 {bal}',
      'card.subscriptionPicker': '订阅',
      'card.allPicker': '全部模型',
      'card.hide': '收起',
      'card.search': '搜索模型',
      'card.searchAll': '搜索全部文本模型',
      'card.toolOnly': '仅工具调用',
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
      'card.loadingAll': '正在加载完整模型目录…',
      'card.error': '无法加载目录：{message}',
      'card.stale': '显示缓存的目录：{message}',
      'card.empty': '没有符合筛选条件的模型。',
      'card.incomplete': '{n} 个模型缺少目录中的设置。',
      'card.enrich': '从目录填充',
      'card.enriched': '已从目录填充设置。',
      'card.keys': 'API 密钥',
      'card.keysError': '无法读取密钥状态：{message}',
      'card.keysHint': '密钥只写不读。订阅密钥消耗每周额度；余额密钥从 NanoGPT 余额扣费。',
      'card.subscriptionKey': '订阅密钥',
      'card.paygoKey': '余额密钥',
      'card.keyNotSet': '未设置',
      'card.keySavedShort': '已保存',
      'card.keySaved': '密钥已保存。',
      'card.keyRemoved': '密钥已删除。',
      'card.keyFailed': '密钥未保存：{message}',
      'card.keyRemove': '删除',
      'card.keySave': '保存',
      'card.keyShow': '显示',
      'card.keyHide': '隐藏',
      'card.keyBilling': '计费：{mode}',
      'card.keyBillingUnknown': '计费：未知',
      'card.modeSubscriptionOnly': '仅订阅',
      'card.modeSubscriptionFirst': '订阅优先',
      'card.modePaygoOnly': '仅余额',
      'card.spend': '计费',
      'card.spendSubscription': '订阅',
      'card.spendBalance': '余额',
      'card.paidOnly': '仅余额',
      'card.paidOnlyHint': '不在订阅范围内 — 只从余额扣费。',
      'card.price': '{in} / {out} / 1M',
      'card.priceTitle': '模型价格，USD / 1M：输入 / 输出',
      'card.providerAuto': '自动（默认）',
      'card.providerLoading': '正在加载提供商…',
      'card.providerError': '提供商不可用：{message}',
      'card.providerUnsupported': '该模型不支持选择提供商。',
      'card.providerPaygoNote': '固定提供商始终按提供商价格从余额扣费（pay-as-you-go）。',
      'card.providerUnavailable': '不可用',
      'card.warnNoPaygo': '未设置余额密钥：余额模式的模型会失败。',
      'card.warnSubOnlyKey': '余额密钥在 NanoGPT 中为「仅订阅」：余额模型会失败。',
      'card.warnPaidDisabled': '此密钥可能未启用付费模型（Enable paid models on API）。',
      'card.warnNoBalance': '{n} 个已配置模型不在订阅内，但未标记为余额计费。',
      'card.warnBalanceReserve': '余额请求会预留完整 max output；余额较少时可能返回 402。',
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

    /** USD with two decimals; `$0.10`. */
    function formatUsd(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return `$${value.toFixed(2)}`;
    }

    /** One USD rate, trimmed to a readable precision (`$0.1575`, `$2`, `$10`). */
    function formatRate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const text =
        value >= 10 ? value.toFixed(0) : value >= 1 ? String(Number(value.toFixed(2))) : String(Number(value.toFixed(4)));
      return `$${text}`;
    }

    /** `$0.10/$0.60` per million tokens for a catalog price pair. */
    function formatPrice(price) {
      if (price === null || typeof price !== 'object') return '';
      return `${formatRate(price.prompt)}/${formatRate(price.completion)}`;
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

    /**
     * One `llm-pi-ai` model entry built from a normalized catalog record.
     * The rate suffix appears only for a subscription-billed ×2 model: the
     * multiplier is a subscription accounting fact, not a pay-as-you-go price.
     */
    function modelEntry(model, billing) {
      return {
        id: model.id,
        name: withRateSuffix(model.name, billing === 'subscription' ? model.rate : 1),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
      };
    }

    /**
     * Fill an existing entry's missing fields from the catalog.
     *
     * The built-in Models editor adds a model from an endpoint listing that may
     * disclose only ids, so a model added there lands without a context window,
     * output cap, input types, or reasoning levels. This merge keeps every
     * user-tuned value and supplies only what the entry does not declare.
     * @param {object} entry - configured `llm-pi-ai` model entry.
     * @param {object|undefined} model - normalized catalog record for the same id.
     * @param {string} billing - `subscription` or `balance`.
     * @returns {object} the entry with missing fields filled.
     */
    function mergeEntry(entry, model, billing) {
      if (model === undefined) return entry;
      return {
        ...entry,
        name: withRateSuffix(
          entry.name === entry.id ? model.name : entry.name,
          billing === 'subscription' ? model.rate : 1,
        ),
        contextWindow: entry.contextWindow ?? model.contextWindow,
        maxTokens: entry.maxTokens ?? model.maxTokens,
        input: entry.input ?? model.input,
        reasoningEfforts: entry.reasoningEfforts ?? model.reasoningEfforts,
      };
    }

    /** Split a stored `modelProviders` object into a Map for the draft. */
    function providersToMap(value) {
      const out = new Map();
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
      for (const [id, provider] of Object.entries(value)) {
        if (typeof provider === 'string' && provider.length > 0) out.set(id, provider);
      }
      return out;
    }

    /**
     * Shared Host-data store: both catalogs, the quota, the key states, the
     * balance, and the provider-discovery cache.
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
        allModels: null,
        allModelsError: null,
        allModelsStale: false,
        loadingAllModels: false,
        usage: null,
        usageError: null,
        loadingUsage: false,
        keys: null,
        keysError: null,
        loadingKeys: false,
        balance: null,
        balanceError: null,
        loadingBalance: false,
        providers: {},
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

      const inflight = new Map();
      const request = (key, url, onBody, onError) => {
        if (inflight.has(key)) return inflight.get(key);
        const promise = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
              onError(body?.error === 'no-key' ? 'no-key' : (body?.message ?? `HTTP ${response.status}`), body);
              return;
            }
            onBody(body);
          })
          .catch((error) => {
            onError(String(error?.message ?? error), null);
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, promise);
        return promise;
      };

      const loadModels = (force = false) => {
        if (inflight.has('models') && !force) return inflight.get('models');
        publish({ loadingModels: true });
        return request(
          'models',
          MODELS_ROUTE,
          (body) => {
            publish({
              loadingModels: false,
              models: Array.isArray(body?.models) ? body.models : [],
              modelsError: null,
              modelsStale: body?.stale === true,
            });
          },
          (message) => publish({ loadingModels: false, modelsError: message }),
        );
      };

      const loadAllModels = (force = false) => {
        if (inflight.has('all-models') && !force) return inflight.get('all-models');
        publish({ loadingAllModels: true });
        return request(
          'all-models',
          ALL_MODELS_ROUTE,
          (body) => {
            publish({
              loadingAllModels: false,
              allModels: Array.isArray(body?.models) ? body.models : [],
              allModelsError: null,
              allModelsStale: body?.stale === true,
            });
          },
          (message) => publish({ loadingAllModels: false, allModelsError: message }),
        );
      };

      const loadUsage = (force = false) => {
        if (inflight.has('usage') && !force) return inflight.get('usage');
        publish({ loadingUsage: true });
        return request(
          'usage',
          USAGE_ROUTE,
          (body) => {
            publish({ loadingUsage: false, usage: body, usageError: null });
          },
          (message) => publish({ loadingUsage: false, usageError: message }),
        );
      };

      const loadKeys = (force = false) => {
        if (inflight.has('keys') && !force) return inflight.get('keys');
        publish({ loadingKeys: true });
        return request(
          'keys',
          KEYS_ROUTE,
          (body) => {
            publish({ loadingKeys: false, keys: body, keysError: null });
          },
          (message) => publish({ loadingKeys: false, keysError: message }),
        );
      };

      const loadBalance = (force = false) => {
        if (inflight.has('balance') && !force) return inflight.get('balance');
        publish({ loadingBalance: true });
        return request(
          'balance',
          BALANCE_ROUTE,
          (body) => {
            publish({ loadingBalance: false, balance: body, balanceError: null });
          },
          (message) => publish({ loadingBalance: false, balanceError: message }),
        );
      };

      const loadProviders = (modelId) => {
        if (typeof modelId !== 'string' || modelId.length === 0) return undefined;
        const known = state.providers[modelId];
        if (known !== undefined && known.status !== 'error') return undefined;
        const key = `providers:${modelId}`;
        if (inflight.has(key)) return inflight.get(key);
        publish({ providers: { ...state.providers, [modelId]: { status: 'loading' } } });
        const promise = fetch(`${PROVIDERS_ROUTE}?model=${encodeURIComponent(modelId)}`, {
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) {
              publish({
                providers: {
                  ...state.providers,
                  [modelId]: { status: 'error', error: body?.message ?? `HTTP ${response.status}` },
                },
              });
              return;
            }
            publish({ providers: { ...state.providers, [modelId]: { status: 'ready', data: body } } });
          })
          .catch((error) => {
            publish({
              providers: { ...state.providers, [modelId]: { status: 'error', error: String(error?.message ?? error) } },
            });
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, promise);
        return promise;
      };

      return { subscribe, getSnapshot, loadModels, loadAllModels, loadUsage, loadKeys, loadBalance, loadProviders };
    }

    /**
     * Outer card: the slot dispatches on every `llm-pi-ai` provider row, so
     * this half decides whether the row is NanoGPT before any hook runs.
     */
    function ProviderCard(props) {
      if (props?.provider?.provider !== PROVIDER) return null;
      return h(NanoGptCard, props);
    }

    /** Map a raw `routing.billingMode` to the card's label. */
    function billingModeText(t, mode) {
      if (mode === 'subscription_only') return t('card.modeSubscriptionOnly');
      if (mode === 'subscription_first') return t('card.modeSubscriptionFirst');
      if (mode === 'paygo_only') return t('card.modePaygoOnly');
      return null;
    }

    /** The NanoGPT provider card: quota, balance, keys, and the two model pickers. */
    function NanoGptCard({ provider, keyConfigured, t, form, ownForm, remote, store }) {
      const host = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const formState = React.useSyncExternalStore(
        React.useCallback((notify) => form.subscribe(notify), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
      );
      const ownState = React.useSyncExternalStore(
        React.useCallback((notify) => ownForm.subscribe(notify), [ownForm]),
        React.useCallback(() => ownForm.getSnapshot(), [ownForm]),
      );

      const [openPicker, setOpenPicker] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [toolOnly, setToolOnly] = React.useState(true);
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [keysOpen, setKeysOpen] = React.useState(true);
      const [keysTouched, setKeysTouched] = React.useState(false);
      const [keyDrafts, setKeyDrafts] = React.useState({ subscription: '', balance: '' });
      const [keyReveal, setKeyReveal] = React.useState({ subscription: false, balance: false });
      const [keySaving, setKeySaving] = React.useState({ subscription: false, balance: false });
      const [keyMessage, setKeyMessage] = React.useState(null);

      React.useEffect(() => {
        store.loadModels();
        store.loadAllModels();
        store.loadUsage();
        store.loadKeys();
        store.loadBalance();
      }, [store]);

      // Open the key fold when either key is missing, once the first key
      // snapshot settles; a later manual toggle wins.
      React.useEffect(() => {
        if (keysTouched || host.keys === null) return;
        const keys = host.keys;
        if (keys.subscription?.configured === false || keys.balance?.configured === false) setKeysOpen(true);
        else setKeysOpen(false);
      }, [host.keys, keysTouched]);

      const configuredModels = React.useMemo(() => {
        const models = formState.value?.providers?.[PROVIDER]?.models;
        return Array.isArray(models) ? models : [];
      }, [formState.value]);
      const configuredIds = React.useMemo(
        () => new Set(configuredModels.map((entry) => entry.id)),
        [configuredModels],
      );

      const ownValue = ownState.value ?? {};
      const storedBalance = React.useMemo(() => new Set(Array.isArray(ownValue.balanceModels) ? ownValue.balanceModels : []), [ownValue.balanceModels]);
      const storedProviders = React.useMemo(() => providersToMap(ownValue.modelProviders), [ownValue.modelProviders]);
      const subscriptionRef = typeof ownValue.apiKeyEnv === 'string' ? ownValue.apiKeyEnv : SUBSCRIPTION_REF;
      const paygoRef = typeof ownValue.paygoKeyEnv === 'string' ? ownValue.paygoKeyEnv : PAYGO_REF;

      const allModelsById = React.useMemo(() => {
        const map = new Map();
        for (const model of host.models ?? []) map.set(model.id, model);
        for (const model of host.allModels ?? []) map.set(model.id, model);
        return map;
      }, [host.models, host.allModels]);

      /** Whether a model is outside the subscription (paid catalog record). */
      const paidOnly = React.useCallback(
        (id) => {
          const model = allModelsById.get(id);
          return model !== undefined && model.included === false;
        },
        [allModelsById],
      );

      /** The effective selection: the draft while editing, otherwise the config. */
      const selection = React.useMemo(() => {
        if (draft !== null) return draft;
        const selected = new Set(configuredIds);
        const billing = new Map();
        const providerById = new Map();
        for (const id of selected) {
          billing.set(id, paidOnly(id) || storedBalance.has(id) ? 'balance' : 'subscription');
          const pinned = storedProviders.get(id);
          if (typeof pinned === 'string') providerById.set(id, pinned);
        }
        return { selected, billing, provider: providerById };
      }, [draft, configuredIds, paidOnly, storedBalance, storedProviders]);

      const source = openPicker === 'all' ? host.allModels : host.models;
      const loading = openPicker === 'all' ? host.loadingAllModels : host.loadingModels;
      const sourceError = openPicker === 'all' ? host.allModelsError : host.modelsError;
      const models = source ?? [];

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

      // Balance rows need provider discovery; do it once per model, lazily.
      const balanceKey = React.useMemo(() => {
        const ids = [];
        for (const [id, billing] of selection.billing) {
          if (billing === 'balance' && selection.selected.has(id)) ids.push(id);
        }
        return ids.sort().join('|');
      }, [selection]);
      React.useEffect(() => {
        if (openPicker === null || balanceKey.length === 0) return;
        for (const id of balanceKey.split('|')) store.loadProviders(id);
      }, [balanceKey, openPicker, store]);

      React.useEffect(() => {
        if (openPicker === 'all') store.loadAllModels();
      }, [openPicker, store]);

      // Entries the built-in editor added from a plain listing carry an id and
      // nothing else; the card offers to fill them.
      const incomplete = React.useMemo(() => {
        return configuredModels.filter((entry) => {
          const model = allModelsById.get(entry.id);
          if (model === undefined) return false;
          return (
            entry.contextWindow === undefined ||
            entry.maxTokens === undefined ||
            entry.input === undefined ||
            (entry.reasoningEfforts === undefined && model.reasoningEfforts !== undefined)
          );
        });
      }, [configuredModels, allModelsById]);

      const paidWithoutBalance = React.useMemo(
        () => configuredModels.filter((entry) => paidOnly(entry.id) && !storedBalance.has(entry.id)),
        [configuredModels, paidOnly, storedBalance],
      );

      const beginDraft = () => {
        const selected = new Set(configuredIds);
        const billing = new Map();
        const providerById = new Map();
        for (const id of selected) {
          billing.set(id, paidOnly(id) || storedBalance.has(id) ? 'balance' : 'subscription');
          const pinned = storedProviders.get(id);
          if (typeof pinned === 'string') providerById.set(id, pinned);
        }
        setDraft({ selected, billing, provider: providerById });
        setMessage(null);
      };

      const openMode = (mode) => {
        if (openPicker === mode) {
          setOpenPicker(null);
          return;
        }
        if (draft === null) beginDraft();
        setOpenPicker(mode);
        setQuery('');
        setMessage(null);
        if (mode === 'all') store.loadAllModels();
      };

      const toggle = (id) => {
        if (draft === null) beginDraft();
        const current = draft ?? selection;
        const selected = new Set(current.selected);
        const billing = new Map(current.billing);
        const providerById = new Map(current.provider);
        if (selected.has(id)) {
          selected.delete(id);
          billing.delete(id);
          providerById.delete(id);
        } else {
          selected.add(id);
          billing.set(id, paidOnly(id) ? 'balance' : 'subscription');
          if (paidOnly(id)) store.loadProviders(id);
        }
        setDraft({ selected, billing, provider: providerById });
        setMessage(null);
      };

      const selectVisible = (on) => {
        const current = draft ?? selection;
        const selected = new Set(current.selected);
        const billing = new Map(current.billing);
        const providerById = new Map(current.provider);
        for (const model of visible) {
          if (on) {
            selected.add(model.id);
            if (!billing.has(model.id)) billing.set(model.id, paidOnly(model.id) ? 'balance' : 'subscription');
          } else {
            selected.delete(model.id);
            billing.delete(model.id);
            providerById.delete(model.id);
          }
        }
        setDraft({ selected, billing, provider: providerById });
        setMessage(null);
      };

      const setBilling = (id, value) => {
        if (paidOnly(id)) return;
        const current = draft ?? selection;
        const selected = new Set(current.selected);
        selected.add(id);
        const billing = new Map(current.billing);
        billing.set(id, value);
        const providerById = new Map(current.provider);
        if (value === 'balance') store.loadProviders(id);
        else providerById.delete(id);
        setDraft({ selected, billing, provider: providerById });
        setMessage(null);
      };

      const setProvider = (id, value) => {
        const current = draft ?? selection;
        const providerById = new Map(current.provider);
        if (typeof value === 'string' && value.length > 0) providerById.set(id, value);
        else providerById.delete(id);
        setDraft({ selected: new Set(current.selected), billing: new Map(current.billing), provider: providerById });
        setMessage(null);
      };

      const apply = async () => {
        setSaving(true);
        setMessage(null);
        try {
          const current = draft ?? selection;
          const next = [];
          // Existing entries keep their order and any user-tuned fields; the
          // catalog fills only what the entry does not declare.
          for (const entry of configuredModels) {
            if (!current.selected.has(entry.id)) continue;
            const billing = paidOnly(entry.id) ? 'balance' : (current.billing.get(entry.id) ?? 'subscription');
            next.push(mergeEntry(entry, allModelsById.get(entry.id), billing));
          }
          // Newly selected models are appended in catalog order.
          for (const model of models) {
            if (!current.selected.has(model.id) || configuredIds.has(model.id)) continue;
            const billing = model.included === false ? 'balance' : (current.billing.get(model.id) ?? 'subscription');
            next.push(modelEntry(model, billing));
          }
          const balanceModels = [];
          const modelProviders = {};
          for (const id of current.selected) {
            const billing = paidOnly(id) ? 'balance' : (current.billing.get(id) ?? 'subscription');
            if (billing !== 'balance') continue;
            balanceModels.push(id);
            const pinned = current.provider.get(id);
            if (typeof pinned === 'string' && pinned.length > 0) modelProviders[id] = pinned;
          }
          const accepted = await form.mutate(
            [{ op: 'set', path: ['providers', PROVIDER, 'models'], value: next }],
            formState.revision,
          );
          if (!accepted) {
            setMessage(t('card.rejected'));
            return;
          }
          const ownAccepted = await ownForm.mutate(
            [
              { op: 'set', path: ['balanceModels'], value: balanceModels },
              { op: 'set', path: ['modelProviders'], value: modelProviders },
            ],
            ownState.revision,
          );
          if (!ownAccepted) {
            setMessage(t('card.rejected'));
            return;
          }
          setDraft(null);
          setOpenPicker(null);
          setMessage(t('card.saved'));
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
          const next = configuredModels.map((entry) =>
            mergeEntry(entry, allModelsById.get(entry.id), paidOnly(entry.id) ? 'balance' : 'subscription'),
          );
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
        setOpenPicker(null);
        setMessage(null);
      };

      /** Write one key through the credential Remote; the value never comes back. */
      const saveKey = async (which) => {
        const value = keyDrafts[which].trim();
        if (value.length === 0) return;
        const ref = which === 'subscription' ? subscriptionRef : paygoRef;
        setKeySaving((state) => ({ ...state, [which]: true }));
        setKeyMessage(null);
        try {
          const response = await remote.credentials.set(ref, value);
          if (response?.ok !== true) {
            setKeyMessage(t('card.keyFailed', { message: response?.error?.message ?? 'unknown error' }));
            return;
          }
          setKeyDrafts((state) => ({ ...state, [which]: '' }));
          setKeyReveal((state) => ({ ...state, [which]: false }));
          setKeyMessage(t('card.keySaved'));
          await store.loadKeys(true);
          store.loadBalance(true);
        } catch (error) {
          setKeyMessage(t('card.keyFailed', { message: String(error?.message ?? error) }));
        } finally {
          setKeySaving((state) => ({ ...state, [which]: false }));
        }
      };

      const removeKey = async (which) => {
        const ref = which === 'subscription' ? subscriptionRef : paygoRef;
        setKeySaving((state) => ({ ...state, [which]: true }));
        setKeyMessage(null);
        try {
          const response = await remote.credentials.unset(ref);
          if (response?.ok !== true) {
            setKeyMessage(t('card.keyFailed', { message: response?.error?.message ?? 'unknown error' }));
            return;
          }
          setKeyMessage(t('card.keyRemoved'));
          await store.loadKeys(true);
          store.loadBalance(true);
        } catch (error) {
          setKeyMessage(t('card.keyFailed', { message: String(error?.message ?? error) }));
        } finally {
          setKeySaving((state) => ({ ...state, [which]: false }));
        }
      };

      const weekly = host.usage?.weekly;
      // `percentUsed` is a fraction (may exceed 1), not a percentage.
      const percent = typeof weekly?.percentUsed === 'number' ? weekly.percentUsed * 100 : 0;
      const total =
        weekly && typeof weekly.used === 'number' && typeof weekly.remaining === 'number'
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

      const balanceValue =
        host.balance && typeof host.balance.usdBalance === 'number'
          ? formatUsd(host.balance.usdBalance)
          : t('card.balanceUnavailable');

      const balanceRow = h(
        'div',
        { className: 'dsh-ng-balanceRow' },
        h('span', null, t('card.balance')),
        h('span', { className: 'dsh-ng-balanceValue' }, balanceValue),
      );

      const keyRows = (() => {
        const keys = host.keys;
        const rows = [];
        const row = (which, label, keyState) => {
          const configured = keyState?.configured === true;
          const modeText =
            typeof keyState?.billingMode === 'string' ? billingModeText(t, keyState.billingMode) : null;
          const statusParts = [];
          if (configured) statusParts.push(t('card.keySavedShort'));
          else statusParts.push(t('card.keyNotSet'));
          if (modeText !== null) statusParts.push(t('card.keyBilling', { mode: modeText }));
          if (keyState?.source !== undefined && keyState?.source !== null) statusParts.push(keyState.source);
          const reveal = keyReveal[which] === true;
          return h(
            'div',
            { className: 'dsh-ng-keyRow', key: which },
            h(
              'div',
              { className: 'dsh-ng-keyLabel' },
              h('span', null, label),
              h(
                'span',
                { className: `dsh-ng-keyStatus${configured ? ' dsh-ng-keyStatusOk' : ' dsh-ng-keyStatusWarn'}` },
                statusParts.join(' · '),
              ),
            ),
            h(
              'div',
              { className: 'dsh-ng-keyInputRow' },
              h('input', {
                className: 'dsh-ng-keyInput',
                type: reveal ? 'text' : 'password',
                autoComplete: 'new-password',
                value: keyDrafts[which],
                placeholder: configured ? (keyState?.masked ?? '••••••') : t('card.keyNotSet'),
                onChange: (event) => setKeyDrafts((state) => ({ ...state, [which]: event.target.value })),
              }),
              h(
                'button',
                { type: 'button', className: 'dsh-ng-link', onClick: () => setKeyReveal((state) => ({ ...state, [which]: !reveal })) },
                reveal ? t('card.keyHide') : t('card.keyShow'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ng-btn',
                  disabled: keySaving[which] || keyDrafts[which].trim().length === 0,
                  onClick: () => saveKey(which),
                },
                t('card.keySave'),
              ),
              configured && keyState?.writable !== false
                ? h(
                    'button',
                    { type: 'button', className: 'dsh-ng-link', disabled: keySaving[which], onClick: () => removeKey(which) },
                    t('card.keyRemove'),
                  )
                : null,
            ),
          );
        };
        rows.push(row('subscription', t('card.subscriptionKey'), keys?.subscription ?? null));
        rows.push(row('balance', t('card.paygoKey'), keys?.balance ?? null));
        return rows;
      })();

      const keysSection = h(
        'div',
        { className: 'dsh-ng-keys' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ng-fold',
            onClick: () => {
              setKeysTouched(true);
              setKeysOpen((open) => !open);
            },
          },
          h('span', { className: 'dsh-ng-keyTitle' }, t('card.keys')),
          h('span', null, keysOpen ? t('card.keyHide') : t('card.keyShow')),
        ),
        keysOpen
          ? [
              h('div', { className: 'dsh-ng-note', key: 'hint' }, t('card.keysHint')),
              ...keyRows,
              host.keysError === null
                ? null
                : h('div', { className: 'dsh-ng-msg dsh-ng-msgErr', key: 'error' }, t('card.keysError', { message: host.keysError })),
              keyMessage === null ? null : h('div', { className: 'dsh-ng-msg', key: 'msg' }, keyMessage),
            ]
          : null,
      );

      /** Options for one model's provider select, from the discovery cache. */
      const providerOptions = (model) => {
        const entry = host.providers[model.id];
        if (entry === undefined || entry.status === 'loading') {
          return { state: 'loading' };
        }
        if (entry.status === 'error') {
          return { state: 'error', message: entry.error };
        }
        const data = entry.data;
        if (data?.supportsProviderSelection !== true) return { state: 'unsupported' };
        const providers = Array.isArray(data.providers) ? data.providers : [];
        return {
          state: 'ready',
          options: providers.map((row) => ({
            id: row.id,
            label:
              `${row.displayName}${row.available === false ? ` (${t('card.providerUnavailable')})` : ''}` +
              (typeof row.inputPer1M === 'number' || typeof row.outputPer1M === 'number'
                ? ` · ${formatPrice({ prompt: row.inputPer1M, completion: row.outputPer1M })}`
                : ''),
            disabled: row.available === false,
          })),
        };
      };

      const row = (model) => {
        const selected = selection.selected.has(model.id);
        const isPaid = model.included === false || paidOnly(model.id);
        const billing = isPaid ? 'balance' : (selection.billing.get(model.id) ?? 'subscription');
        const pinned = selection.provider.get(model.id) ?? '';
        const options = billing === 'balance' && selected ? providerOptions(model) : null;
        return h(
          'div',
          { className: 'dsh-ng-row', key: model.id },
          h(
            'div',
            { className: 'dsh-ng-rowTop' },
            h(
              'label',
              { className: 'dsh-ng-rowPick' },
              h('input', { type: 'checkbox', checked: selected, onChange: () => toggle(model.id) }),
              h(
                'span',
                { className: 'dsh-ng-rowMain' },
                h('span', { className: 'dsh-ng-rowName' }, model.name),
                h('span', { className: 'dsh-ng-rowId' }, model.id),
              ),
            ),
            isPaid
              ? h(
                  'span',
                  { className: 'dsh-ng-price', title: t('card.priceTitle') },
                  formatPrice(model.price) || '—',
                )
              : h(
                  'span',
                  { className: `dsh-ng-rate${model.rate === 2 ? ' dsh-ng-rate2' : ''}` },
                  `×${model.rate ?? 1}`,
                ),
            h(
              'span',
              { className: 'dsh-ng-rowMeta' },
              `${formatTokens(model.contextWindow)} · ${formatTokens(model.maxTokens)}`,
            ),
            h('span', { className: 'dsh-ng-rowEfforts' }, effortsText(model.reasoningEfforts)),
            h(
              'span',
              { className: 'dsh-ng-seg', title: isPaid ? t('card.paidOnlyHint') : t('card.spend') },
              isPaid
                ? h(
                    'button',
                    { type: 'button', className: 'dsh-ng-segBtn dsh-ng-segBtnOn', disabled: true, key: 'paid' },
                    t('card.paidOnly'),
                  )
                : [
                    h(
                      'button',
                      {
                        type: 'button',
                        key: 'sub',
                        className: `dsh-ng-segBtn${billing === 'subscription' ? ' dsh-ng-segBtnOn' : ''}`,
                        onClick: () => setBilling(model.id, 'subscription'),
                      },
                      t('card.spendSubscription'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        key: 'bal',
                        className: `dsh-ng-segBtn${billing === 'balance' ? ' dsh-ng-segBtnOn' : ''}`,
                        onClick: () => setBilling(model.id, 'balance'),
                      },
                      t('card.spendBalance'),
                    ),
                  ],
            ),
          ),
          billing === 'balance' && selected
            ? h(
                'div',
                { className: 'dsh-ng-rowDetail' },
                options === null || options.state === 'loading'
                  ? h('span', { className: 'dsh-ng-note' }, t('card.providerLoading'))
                  : options.state === 'error'
                    ? h('span', { className: 'dsh-ng-note' }, t('card.providerError', { message: options.message }))
                    : options.state === 'unsupported'
                      ? h('span', { className: 'dsh-ng-note' }, t('card.providerUnsupported'))
                      : [
                          h(
                            'select',
                            {
                              className: 'dsh-ng-select',
                              value: options.options.some((option) => option.id === pinned) ? pinned : '',
                              onChange: (event) => setProvider(model.id, event.target.value),
                            },
                            [
                              h('option', { value: '', key: 'auto' }, t('card.providerAuto')),
                              ...options.options.map((option) =>
                                h(
                                  'option',
                                  { value: option.id, key: option.id, disabled: option.disabled },
                                  option.label,
                                ),
                              ),
                            ],
                          ),
                          h('span', { className: 'dsh-ng-note' }, t('card.providerPaygoNote')),
                        ],
              )
            : null,
        );
      };

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
            placeholder: openPicker === 'all' ? t('card.searchAll') : t('card.search'),
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
        sourceError !== null && source !== null && sourceError !== 'no-key'
          ? h('div', { className: 'dsh-ng-warn', key: 'source-error' }, t('card.error', { message: sourceError }))
          : loading && source === null
            ? h('div', { className: 'dsh-ng-msg', key: 'loading' }, openPicker === 'all' ? t('card.loadingAll') : t('card.loading'))
            : h(
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

      const keys = host.keys;
      const selectedCount = selection.selected.size;
      let subtitleCount = 0;
      let balanceCount = 0;
      for (const id of selection.selected) {
        const billing = paidOnly(id) ? 'balance' : (selection.billing.get(id) ?? 'subscription');
        if (billing === 'balance') balanceCount += 1;
        else subtitleCount += 1;
      }
      const counts = t('card.counts', { n: selectedCount, sub: subtitleCount, bal: balanceCount });
      const paidConfigured = configuredModels.filter((entry) => paidOnly(entry.id)).length;

      const warnings = [];
      if (balanceCount > 0 && keys?.balance?.configured === false) {
        warnings.push(h('div', { className: 'dsh-ng-warn', key: 'no-paygo' }, t('card.warnNoPaygo')));
      }
      if (balanceCount > 0 && keys?.balance?.billingMode === 'subscription_only') {
        warnings.push(h('div', { className: 'dsh-ng-warn', key: 'sub-only' }, t('card.warnSubOnlyKey')));
      }
      if (paidWithoutBalance.length > 0) {
        warnings.push(
          h('div', { className: 'dsh-ng-warn', key: 'no-balance-flag' }, t('card.warnNoBalance', { n: paidWithoutBalance.length })),
        );
      }
      if (paidConfigured > 0 && keys?.balance?.paidSpendPolicyAllowsBalance === false) {
        warnings.push(h('div', { className: 'dsh-ng-warn', key: 'paid-disabled' }, t('card.warnPaidDisabled')));
      }
      if (balanceCount > 0) {
        warnings.push(h('div', { className: 'dsh-ng-note', key: 'reserve' }, t('card.warnBalanceReserve')));
      }

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
        balanceRow,
        h(
          'div',
          { className: 'dsh-ng-actions' },
          h('span', { className: 'dsh-ng-counts' }, counts),
          h(
            'span',
            { className: 'dsh-ng-pickerBar' },
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ng-btn${openPicker === 'subscription' ? ' dsh-ng-btnPrimary' : ''}`,
                onClick: () => openMode('subscription'),
              },
              t('card.subscriptionPicker'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ng-btn${openPicker === 'all' ? ' dsh-ng-btnPrimary' : ''}`,
                onClick: () => openMode('all'),
              },
              t('card.allPicker'),
            ),
          ),
        ),
        keysSection,
        status,
        ...warnings,
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
        openPicker === null ? null : picker,
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
      // `remote.credentials` is a Cordis service of its own: the client assembly
      // publishes every Remote namespace under `remote.<ns>`, and `ctx.remote`
      // refuses a namespace the caller did not inject. `remote` stays for the
      // assembly itself, mirroring the shipped settings pages.
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { en: EN, ru: RU, zh: ZH }), 'nanogpt: dictionaries');

        const store = createHostStore();
        const form = ctx.configForms.get(SETTINGS_NS);
        const ownForm = ctx.configForms.get(OWN_NS);

        ctx.effect(() => installFooterRow(store, t), 'nanogpt: footer row');

        ctx.slots.inject('settings.models.provider-card', () =>
          ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              key: SETTINGS_NS,
              locale: NS,
              inject: () => ({ t, form, ownForm, remote: ctx.remote, store }),
            },
            ProviderCard,
          ),
        );
      },
    };
  },
});