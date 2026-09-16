/**
 * dsh-plugin-ollama-usage — browser half.
 *
 * Shipped in the module-loader bundle form: this file's only job is to register a factory
 * with the shell's loader, which materializes it as a plugin when the web shell needs it.
 * `react` is resolved from the platform baseline, so this bundle requests nothing else.
 *
 * Three surfaces, all additive:
 * - `conversation.composer.dock` (id `ollama-usage`, order 1) — the pill in the active session.
 * - `shell.overlay` (id `ollama-usage-hero`, order 1) — the same pill in a brand-new session.
 * - `settings.plugin.item` (key `ollama-usage`) — the configuration card.
 *
 * Everything it knows about the account arrives over the private `/ollama-usage` RPC channel
 * as already-decoded numbers. The API key never reaches this half.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-ollama-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const name = 'ollama-usage-client'
    const inject = ['slots', 'locale', 'timer']

    /** Named-route prefix the Host half owns on the composition's web server. */
    const ROUTE_PREFIX = '/ollama-usage'
    const NS = 'ollama-usage'
    const DOCK_ID = 'ollama-usage'
    const DOCK_ORDER = 1
    const OVERLAY_ID = 'ollama-usage-hero'
    const OVERLAY_ORDER = 1
    const REFRESH_INTERVAL_MS = 300_000
    const SETTLE_DELAY_MS = 250
    const INLINE_GAP_PX = 12
    const HERO_GAP_PX = 8
    const WINDOW_ORDER = ['session', 'weekly', 'monthly']
    const MODE_REFERENCE = 'reference'
    const MODE_DIRECT = 'direct'

    /** Rolling-window cadence, matching the wording the official Ollama card uses. */
    const CADENCE = {
      session: { hours: 5 },
      weekly: { days: 7 },
      monthly: { days: 30 },
    }

    const CSS = [
      '.ollama-usage-dock{box-sizing:border-box;width:100%;height:0;position:relative;pointer-events:none}',
      '.ollama-usage-dock[data-flow="true"]{height:auto;max-width:var(--dsh-chat-content-width,720px);margin:0 auto;padding:4px calc(var(--dsh-composer-side-clearance,16px) + 16px) 0;display:flex;justify-content:center;gap:12px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.ollama-usage-hero{position:absolute;left:0;top:0;width:100%;height:0;pointer-events:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.ollama-usage-hero[data-mode="fixed"]{left:50%;top:auto;bottom:6px;width:auto;height:auto;transform:translateX(-50%);max-width:calc(100vw - 48px);display:flex;justify-content:center}',
      '.ollama-usage-slot{position:absolute;left:0;top:0;transform:translateY(-50%);display:inline-flex;pointer-events:auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.ollama-usage-dock[data-flow="true"] .ollama-usage-slot{position:relative;left:auto;top:auto;transform:none}',
      '.ollama-usage-hero .ollama-usage-slot{transform:none}',
      '.ollama-usage-hero[data-mode="fixed"] .ollama-usage-slot{position:relative;left:auto;top:auto}',
      '.ollama-usage-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.ollama-usage-pill:hover,.ollama-usage-pill[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.ollama-usage-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.ollama-usage-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.ollama-usage-glyph{flex:none;width:14px;height:14px;place-items:center;display:grid;color:currentColor}',
      '.ollama-usage-glyph i{display:block;width:7px;height:7px;border-radius:50%;background:currentColor}',
      '.ollama-usage-panel{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:30;box-sizing:border-box;width:min(360px,calc(100vw - 48px));border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,none);overflow:hidden;font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;text-align:left}',
      '.ollama-usage-panelbody{display:flex;flex-direction:column;gap:8px;padding:6px 12px}',
      '.ollama-usage-row{display:flex;flex-direction:column;gap:4px}',
      '.ollama-usage-rowhead{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-primary)}',
      '.ollama-usage-title{flex:none;font-size:13px;font-weight:500;line-height:24px}',
      '.ollama-usage-progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:20px;overflow:hidden}',
      '.ollama-usage-value{flex:none;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:24px}',
      '.ollama-usage-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.ollama-usage-bar > span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}',
      '.ollama-usage-models{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.ollama-usage-models li{display:flex;justify-content:space-between;gap:12px}',
      '.ollama-usage-modelname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ollama-usage-foot{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}',
      '.ollama-usage-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}',
      '.ollama-usage-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.ollama-usage-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.ollama-usage-cardheader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.ollama-usage-cardheader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.ollama-usage-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.ollama-usage-cardname{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.ollama-usage-carddesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.ollama-usage-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
      '.ollama-usage-chevron[data-open="true"]{transform:rotate(180deg)}',
      '.ollama-usage-pending{flex:none;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);padding:1px 6px;font-size:11px;line-height:16px}',
      '.ollama-usage-cardbody{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.ollama-usage-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.ollama-usage-field + .ollama-usage-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.ollama-usage-field label{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}',
      '.ollama-usage-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;width:100%}',
      '.ollama-usage-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.ollama-usage-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.ollama-usage-modes{display:flex;gap:8px}',
      '.ollama-usage-mode{box-sizing:border-box;flex:1;text-align:left;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}',
      '.ollama-usage-mode[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.ollama-usage-modename{font-size:13px;font-weight:600;line-height:1.4}',
      '.ollama-usage-modedesc{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.ollama-usage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ollama-usage-btn{box-sizing:border-box;height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.ollama-usage-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.ollama-usage-btn:disabled{opacity:.5;cursor:default}',
      '.ollama-usage-btn[data-primary="true"]{border-color:var(--dsw-alias-border-l2);font-weight:600}',
      '.ollama-usage-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.ollama-usage-failed{min-width:0;color:var(--dsw-alias-state-error-primary);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.ollama-usage-ok{min-width:0;color:var(--dsw-alias-state-success-primary);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.ollama-usage-status{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
    ].join('\n')

    const COPY_ZH = {
      window: { session: '5 小时窗口', weekly: '每周窗口', monthly: '每月窗口' },
      requests: '次请求',
      usageTitle: 'Ollama 用量',
      pill: (pct) => `Ollama 窗口用量 ${pct}%`,
      pillTitle: (windowLabel, pct, reset) =>
        `Ollama 用量 · ${windowLabel} ${pct}%${reset.length === 0 ? '' : `（${reset}）`}`,
      resetAt: (clock) => `${clock} 重置`,
      resetEveryHours: (count) => `每 ${count} 小时重置`,
      resetEveryDays: (count) => `每 ${count} 天重置`,
      updatedAt: (clock) => `更新于 ${clock}`,
      cardTitle: 'Ollama Cloud 用量',
      cardDesc: '在输入框下方显示 Ollama Cloud 账户用量',
      unsaved: '未保存',
      expand: '展开',
      collapse: '收起',
      modeLabel: '凭据来源',
      modeNameReference: '凭据模式',
      modeDescReference: '复用已有环境变量引用',
      modeNameDirect: '密钥模式',
      modeDescDirect: '本插件专属密钥',
      refLabel: '环境变量引用名（apiKeyEnv）',
      refHint: '该引用由提供方共享，本插件对其只读：只解析、绝不写入。',
      directHint:
        '密钥保存在本插件专属引用 OLLAMA_USAGE_API_KEY，与任何提供方的 apiKeyEnv 完全隔离，不会互相覆盖。',
      keyLabel: 'API Key（本插件专属）',
      keyPlaceholder: '粘贴密钥后点「保存密钥」（不会回显）',
      save: '保存',
      discard: '丢弃',
      saveKey: '保存密钥',
      clearKey: '清除密钥',
      loading: '读取中…',
      saved: '已保存',
      discarded: '已丢弃未保存的修改',
      keySaved: '密钥已保存',
      keyCleared: '密钥已清除',
      conflict: '配置已被其它写入修改，请重新展开后再保存',
      readFailed: '无法读取配置',
      writeFailed: '保存失败',
      readOnly: '配置提供方为只读，修改无法写入',
      credLabel: '凭据状态',
      credConfigured: '已配置',
      credMissing: '未配置',
      credUnwritable: '只读来源',
      fetchLoading: '正在读取用量…',
      fetchNone: '未取到用量（未配置凭据/密钥、端点不支持或请求失败）',
      fetchOk: (count, clock) => `已读取 ${count} 个窗口 · ${clock}`,
    }

    const COPY_EN = {
      window: { session: '5-hour window', weekly: 'Weekly window', monthly: 'Monthly window' },
      requests: 'requests',
      usageTitle: 'Ollama usage',
      pill: (pct) => `Ollama usage ${pct}%`,
      pillTitle: (windowLabel, pct, reset) =>
        `Ollama usage · ${windowLabel} ${pct}%${reset.length === 0 ? '' : ` (${reset})`}`,
      resetAt: (clock) => `resets ${clock}`,
      resetEveryHours: (count) => `resets every ${count}h`,
      resetEveryDays: (count) => `resets every ${count}d`,
      updatedAt: (clock) => `Updated ${clock}`,
      cardTitle: 'Ollama Cloud usage',
      cardDesc: 'Shows Ollama Cloud account usage beneath the composer',
      unsaved: 'Unsaved',
      expand: 'Expand',
      collapse: 'Collapse',
      modeLabel: 'Credential source',
      modeNameReference: 'Reference mode',
      modeDescReference: 'Reuse an existing env reference',
      modeNameDirect: 'Key mode',
      modeDescDirect: 'A key owned by this plugin',
      refLabel: 'Environment reference (apiKeyEnv)',
      refHint: 'Shared with its provider: this plugin only reads it through the seam and never writes it.',
      directHint:
        'The key is stored under this plugin sole reference OLLAMA_USAGE_API_KEY, isolated from any provider apiKeyEnv.',
      keyLabel: 'API key (plugin-owned)',
      keyPlaceholder: 'Paste the key, then Save key (never echoed back)',
      save: 'Save',
      discard: 'Discard',
      saveKey: 'Save key',
      clearKey: 'Clear key',
      loading: 'Loading…',
      saved: 'Saved',
      discarded: 'Unsaved changes discarded',
      keySaved: 'Key saved',
      keyCleared: 'Key cleared',
      conflict: 'Configuration changed elsewhere; reopen before saving',
      readFailed: 'Could not read configuration',
      writeFailed: 'Save failed',
      readOnly: 'The settings provider is read-only; edits cannot be persisted',
      credLabel: 'Credential',
      credConfigured: 'configured',
      credMissing: 'not configured',
      credUnwritable: 'read-only source',
      fetchLoading: 'Reading usage…',
      fetchNone: 'No usage (credential or key missing, endpoint unsupported, or request failed)',
      fetchOk: (count, clock) => `${count} window(s) · ${clock}`,
    }

    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const readText = (value) => (typeof value === 'string' ? value : '')
    const pad2 = (value) => (value < 10 ? `0${value}` : String(value))

    function formatClock(iso) {
      if (iso.length === 0) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }
    function formatResetAt(iso) {
      if (iso.length === 0) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const now = new Date()
      const sameDay =
        date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
      if (sameDay) return formatClock(iso)
      return `${date.getMonth() + 1}/${date.getDate()} ${formatClock(iso)}`
    }
    function resetLabel(key, window, copy) {
      const at = formatResetAt(readText(window.resetsAt))
      if (at.length > 0) return copy.resetAt(at)
      const cadence = CADENCE[key]
      if (cadence === undefined) return ''
      if (cadence.hours !== undefined) return copy.resetEveryHours(cadence.hours)
      return copy.resetEveryDays(cadence.days)
    }
    const formatPercent = (fraction) => String(Math.round(fraction * 1000) / 10)

    function decodeWindow(raw) {
      if (!isRecord(raw)) return null
      const value = raw.usage
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
      const models = []
      if (Array.isArray(raw.models)) {
        for (const entry of raw.models) {
          if (!isRecord(entry)) continue
          const modelName = readText(entry.name)
          const count = entry.requestCount
          if (modelName.length === 0) continue
          if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue
          models.push({ name: modelName, requestCount: count })
        }
      }
      const resetsAt = readText(raw.resetsAt)
      return resetsAt.length === 0 ? { usage: value, models } : { usage: value, models, resetsAt }
    }
    function decodeUsage(raw) {
      if (!isRecord(raw)) return null
      const usage = { fetchedAt: readText(raw.fetchedAt) }
      let found = 0
      for (const key of WINDOW_ORDER) {
        const window = decodeWindow(raw[key])
        if (window === null) continue
        usage[key] = window
        found += 1
      }
      return found === 0 ? null : usage
    }
    /**
     * Whether two measurements describe the same placement. Re-measuring is cheap and happens
     * on every observed layout change, so writing state only on a real difference keeps the
     * pill from re-rendering (and re-observing) on every observer callback.
     */
    function samePlacement(current, next) {
      if (current === null || next === null) return current === next
      if (current.mode !== next.mode) return false
      if (next.mode !== 'inline' && next.mode !== 'anchored') return true
      return Math.abs(current.left - next.left) < 0.5 && Math.abs(current.top - next.top) < 0.5
    }

    /**
     * The window the pill reports: the 5-hour session window, fixed. Only when the account
     * does not return it at all does the pill fall back to the next window in
     * {@link WINDOW_ORDER}. The panel still lists every window the account returns.
     */
    function headlineOf(usage) {
      for (const key of WINDOW_ORDER) {
        const window = usage[key]
        if (window !== undefined) return { key, usage: window.usage, window }
      }
      return null
    }
    function countWindows(usage) {
      let total = 0
      for (const key of WINDOW_ORDER) {
        if (usage[key] !== undefined) total += 1
      }
      return total
    }
    function activeIsChinese(locale) {
      try {
        const active = readText(locale.getLocale().active)
        return active.length === 0 ? true : active.indexOf('zh') === 0
      } catch {
        return true
      }
    }

    /**
     * `display:contents` outlet wrappers generate no box, so a zero rect means "keep looking
     * inside". Bounded depth keeps a pathological tree from recursing forever.
     */
    function resolveBox(element, depth) {
      if (element === null || element === undefined) return null
      if (depth > 4) return null
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return { element, rect }
      const kids = element.children
      for (const kid of kids) {
        const inner = resolveBox(kid, depth + 1)
        if (inner !== null) return inner
      }
      return null
    }

    /** Descend through a single-child wrapper whose child spans it; stop at the real row. */
    function narrowToContent(box, depth) {
      if (depth > 3) return box
      if (box.element.children.length !== 1) return box
      const only = resolveBox(box.element.children[0], 0)
      if (only === null) return box
      if (only.rect.height > 64) return box
      if (only.rect.width < box.rect.width * 0.9) return box
      return narrowToContent(only, depth + 1)
    }

    /** The built-in pill row: whichever neighbour is a short, non-empty row of boxes. */
    function findPillRow(node) {
      const candidates = [node.previousElementSibling, node.nextElementSibling]
      const parent = node.parentElement
      if (parent !== null) {
        const kids = parent.children
        for (let index = kids.length - 1; index >= 0; index -= 1) {
          if (kids[index] !== node) candidates.push(kids[index])
        }
      }
      for (const candidate of candidates) {
        const resolved = resolveBox(candidate, 0)
        if (resolved === null) continue
        const box = narrowToContent(resolved, 0)
        if (box.rect.height > 64) continue
        if (box.element.children.length === 0) continue
        return box
      }
      return null
    }

    /** The resident composer body, located by the slot protocol's own `data-slot` marker. */
    function composerOutlet(node) {
      const doc = node.ownerDocument
      if (doc === null || doc === undefined) return null
      const outlet = doc.querySelector('[data-slot="conversation.composer.bar"]')
      return outlet === null ? null : resolveBox(outlet, 0)
    }

    /** Union of a row's children — the pill cluster, not the full-width row box. */
    function rowMetrics(element) {
      let minLeft = Infinity
      let maxRight = -Infinity
      let minTop = Infinity
      let maxBottom = -Infinity
      for (const child of element.children) {
        const rect = child.getBoundingClientRect()
        if (rect.width === 0) continue
        if (rect.left < minLeft) minLeft = rect.left
        if (rect.right > maxRight) maxRight = rect.right
        if (rect.top < minTop) minTop = rect.top
        if (rect.bottom > maxBottom) maxBottom = rect.bottom
      }
      if (!Number.isFinite(minLeft) || maxRight <= minLeft) return null
      if (!Number.isFinite(minTop) || maxBottom <= minTop) return null
      return { left: minLeft, right: maxRight, centerY: (minTop + maxBottom) / 2 }
    }

    function makeApply(ctx) {
      const copy = activeIsChinese(ctx.locale) ? COPY_ZH : COPY_EN
      const h = React.createElement
      const useIsoLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = name
        tag.textContent = CSS
        document.head.append(tag)
        return () => tag.remove()
      }, 'ollama-usage: stylesheet')

      const store = { phase: 'loading', usage: null, inFlight: false }
      const dataListeners = new Set()
      const phaseListeners = new Set()
      let dockMounts = 0
      let settled = false
      let pollStop = null
      let consumers = 0

      const emitData = () => dataListeners.forEach((listener) => listener())
      const heroVisible = () => settled && dockMounts === 0
      const emitPhase = () => {
        const current = heroVisible()
        phaseListeners.forEach((listener) => listener(current))
      }
      function markDockMounted() {
        dockMounts += 1
        settled = true
        emitPhase()
        return () => {
          dockMounts = Math.max(0, dockMounts - 1)
          emitPhase()
        }
      }
      ctx.timeout(() => {
        settled = true
        emitPhase()
      }, SETTLE_DELAY_MS)

      /**
       * The page's own origin, mirroring the shipped client halves.
       *
       * A page that is not served over http (Electron loads the built files over `file://`) has
       * origin `null`; the placeholder then points at nothing and the request fails into the
       * same error path as any other refusal.
       *
       * @returns the base URL the Host half's route is resolved against.
       */
      function hostBase() {
        const origin = globalThis.location?.origin
        return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
      }

      /**
       * One request to the Host half's route. A rejection is not an error surface: every caller
       * treats "no answer" as "nothing to show".
       *
       * The body is always the JSON payload — an omitted one is what once kept the settings card
       * stuck on its loading state, so the empty object is deliberate, not decorative. The
       * Host's own envelope carries the error code, and an HTTP-level refusal is raised as the
       * same kind of error so callers keep one catch shape.
       *
       * @param endpoint - the endpoint segment under {@link ROUTE_PREFIX}.
       * @param payload - the request body object.
       * @returns the envelope's `value`.
       */
      async function request(endpoint, payload) {
        const response = await fetch(new URL(`${ROUTE_PREFIX}/${endpoint}`, hostBase()), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        const answered = await response.json().catch(() => null)
        if (response.ok && isRecord(answered) && answered.ok === true) return answered.value
        const error = isRecord(answered) && isRecord(answered.error) ? answered.error : null
        const message =
          error === null
            ? `${endpoint} refused: HTTP ${String(response.status)}`
            : `${readText(error.code)}: ${readText(error.message)}`
        throw new Error(message)
      }

      async function refresh() {
        if (store.inFlight) return
        store.inFlight = true
        let usage = null
        try {
          const reply = await request('usage/read', {})
          usage = isRecord(reply) && reply.status === 'ok' ? decodeUsage(reply.usage) : null
        } catch {
          usage = null
        }
        store.inFlight = false
        store.phase = usage === null ? 'none' : 'ok'
        store.usage = usage
        emitData()
      }
      function acquire() {
        consumers += 1
        if (consumers > 1) return
        refresh()
        if (pollStop === null) pollStop = ctx.interval(() => refresh(), REFRESH_INTERVAL_MS)
      }
      function release() {
        consumers = Math.max(0, consumers - 1)
        if (consumers > 0 || pollStop === null) return
        const stop = pollStop
        pollStop = null
        stop()
      }

      function useUsage() {
        const [, setVersion] = React.useState(0)
        React.useEffect(() => {
          const listener = () => setVersion((current) => current + 1)
          dataListeners.add(listener)
          return () => dataListeners.delete(listener)
        }, [])
        return { phase: store.phase, usage: store.usage }
      }
      function useHero() {
        const [hero, setHero] = React.useState(heroVisible())
        React.useEffect(() => {
          const listener = (next) => setHero(next)
          phaseListeners.add(listener)
          listener(heroVisible())
          return () => phaseListeners.delete(listener)
        }, [])
        return hero
      }
      const useNodeHolder = () => React.useState(() => ({ current: null }))[0]

      function measureDock(box, slot) {
        const node = box.current
        const slotNode = slot.current
        if (node === null || slotNode === null) return { mode: 'flow' }
        const own = node.getBoundingClientRect()
        if (own.width === 0 || slotNode.getBoundingClientRect().width === 0) return { mode: 'flow' }
        const row = findPillRow(node)
        if (row === null) return { mode: 'flow' }
        const metrics = rowMetrics(row.element)
        if (metrics === null) return { mode: 'flow' }
        return {
          mode: 'inline',
          left: metrics.right - own.left + INLINE_GAP_PX,
          top: metrics.centerY - own.top,
        }
      }

      /**
       * In a brand-new session there is no dock row to sit beside, so the pill is anchored
       * under the composer card itself. `padding-bottom` is subtracted because the hero
       * composer stack reserves space below the card.
       */
      function measureHero(box, slot) {
        const node = box.current
        const slotNode = slot.current
        if (node === null || slotNode === null) return { mode: 'fixed' }
        const own = node.getBoundingClientRect()
        const slotRect = slotNode.getBoundingClientRect()
        if (own.width === 0 || slotRect.width === 0 || slotRect.height === 0) return { mode: 'fixed' }
        const anchor = composerOutlet(node)
        if (anchor === null || anchor.rect.width === 0 || anchor.rect.height === 0) return { mode: 'fixed' }
        let paddingBottom = 0
        const view = node.ownerDocument === null ? null : node.ownerDocument.defaultView
        if (view !== null && view !== undefined && typeof view.getComputedStyle === 'function') {
          const parsed = Number.parseFloat(view.getComputedStyle(anchor.element).paddingBottom)
          if (Number.isFinite(parsed)) paddingBottom = parsed
        }
        return {
          mode: 'anchored',
          left: anchor.rect.left + anchor.rect.width / 2 - own.left - slotRect.width / 2,
          top: anchor.rect.bottom - paddingBottom + HERO_GAP_PX + slotRect.height / 2 - own.top,
        }
      }

      function chevronSvg(open) {
        return h(
          'svg',
          {
            className: 'ollama-usage-chevron',
            'data-open': open ? 'true' : 'false',
            viewBox: '0 0 14 14',
            width: 14,
            height: 14,
            'aria-hidden': true,
          },
          h('path', {
            d: 'M3.5 5.25 7 8.75l3.5-3.5',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      }

      function WindowRow(props) {
        const window = props.window
        const kids = [
          h(
            'div',
            { className: 'ollama-usage-rowhead', key: 'head' },
            h('span', { className: 'ollama-usage-title' }, copy.window[props.windowKey]),
            h('span', { className: 'ollama-usage-progress' }, resetLabel(props.windowKey, window, copy)),
            h('span', { className: 'ollama-usage-value' }, `${formatPercent(window.usage)}%`),
          ),
          h(
            'div',
            { className: 'ollama-usage-bar', key: 'bar' },
            h('span', { style: { width: `${Math.max(0, Math.min(100, window.usage * 100))}%` } }),
          ),
        ]
        if (window.models.length > 0) {
          const rows = window.models.map((model, index) =>
            h(
              'li',
              { key: `${model.name}#${index}` },
              h('span', { className: 'ollama-usage-modelname' }, model.name),
              h('span', null, `${model.requestCount} ${copy.requests}`),
            ),
          )
          kids.push(h('ul', { className: 'ollama-usage-models', key: 'models' }, rows))
        }
        return h('div', { className: 'ollama-usage-row' }, kids)
      }

      function UsagePill(props) {
        const headline = props.headline
        const pct = formatPercent(headline.usage)
        const label = copy.pillTitle(copy.window[headline.key], pct, resetLabel(headline.key, headline.window, copy))
        return h(
          'button',
          {
            type: 'button',
            ref: (node) => {
              props.holder.current = node
            },
            className: 'ollama-usage-pill',
            'data-open': props.open ? 'true' : 'false',
            'aria-expanded': props.open ? 'true' : 'false',
            'aria-label': label,
            title: label,
            onClick: props.onToggle,
          },
          h('span', { className: 'ollama-usage-glyph' }, h('i', null)),
          h('span', { className: 'ollama-usage-label' }, copy.pill(pct)),
        )
      }

      function UsageSurface() {
        const state = useUsage()
        const [open, setOpen] = React.useState(false)
        const holder = useNodeHolder()
        if (state.phase !== 'ok' || state.usage === null) return null
        const headline = headlineOf(state.usage)
        if (headline === null) return null
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false)
          const node = holder.current
          if (node !== null && typeof node.focus === 'function') node.focus()
        }
        const kids = []
        if (open) {
          const rows = WINDOW_ORDER.filter((key) => state.usage[key] !== undefined).map((key) =>
            h(WindowRow, { key, windowKey: key, window: state.usage[key] }),
          )
          rows.push(h('div', { className: 'ollama-usage-foot', key: 'foot' }, copy.updatedAt(formatClock(state.usage.fetchedAt))))
          kids.push(
            h('div', { className: 'ollama-usage-panel', key: 'panel', role: 'dialog', onKeyDown }, h('div', { className: 'ollama-usage-panelbody' }, rows)),
          )
        }
        kids.push(
          h(UsagePill, {
            key: 'pill',
            headline,
            open,
            onToggle: () => setOpen((current) => !current),
            holder,
          }),
        )
        return h('div', { className: 'ollama-usage-slot-inner', onKeyDown }, kids)
      }

      function DockEntry() {
        const state = useUsage()
        const box = useNodeHolder()
        const slot = useNodeHolder()
        const [align, setAlign] = React.useState(null)
        React.useEffect(() => {
          const unmount = markDockMounted()
          acquire()
          return () => {
            unmount()
            release()
          }
        }, [])
        const phase = state.phase
        const modeKey = align === null ? 'none' : align.mode
        useIsoLayoutEffect(() => {
          const node = box.current
          if (node === null) return undefined
          const apply = () => {
            const next = measureDock(box, slot)
            setAlign((current) => (samePlacement(current, next) ? current : next))
          }
          apply()
          const view = node.ownerDocument === null ? null : node.ownerDocument.defaultView
          if (view === null || view === undefined || typeof view.ResizeObserver !== 'function') return undefined
          const observer = new view.ResizeObserver(apply)
          // Collapsing or expanding the sidebar moves the built-in cluster without resizing
          // the row it sits in, so every anchor whose geometry can move it is watched — one
          // stale measurement is exactly what lands this pill on top of the built-in ones.
          const watched = new Set()
          const watch = (element) => {
            if (element === null || element === undefined || watched.has(element)) return
            watched.add(element)
            observer.observe(element)
          }
          watch(node.parentElement)
          watch(node.parentElement === null ? null : node.parentElement.parentElement)
          const row = findPillRow(node)
          if (row !== null) {
            watch(row.element)
            watch(row.element.parentElement)
          }
          const outlet = composerOutlet(node)
          if (outlet !== null) watch(outlet.element)
          const onViewportChange = () => apply()
          if (typeof view.addEventListener === 'function') view.addEventListener('resize', onViewportChange)
          return () => {
            observer.disconnect()
            if (typeof view.removeEventListener === 'function') view.removeEventListener('resize', onViewportChange)
          }
        }, [phase, modeKey])
        const inline = align !== null && align.mode === 'inline'
        const slotStyle = inline ? { left: `${align.left}px`, top: `${align.top}px` } : undefined
        return h(
          'div',
          {
            className: 'ollama-usage-dock',
            'data-flow': inline ? 'false' : 'true',
            ref: (node) => {
              box.current = node
            },
          },
          h(
            'div',
            {
              className: 'ollama-usage-slot',
              style: slotStyle,
              ref: (node) => {
                slot.current = node
              },
            },
            state.phase === 'ok' ? h(UsageSurface, null) : null,
          ),
        )
      }

      function HeroEntry() {
        const state = useUsage()
        const hero = useHero()
        const box = useNodeHolder()
        const slot = useNodeHolder()
        const [align, setAlign] = React.useState(null)
        React.useEffect(() => {
          acquire()
          return () => release()
        }, [])
        const heroKey = hero ? 'hero' : 'idle'
        const modeKey = align === null ? 'none' : align.mode
        const phase = state.phase
        useIsoLayoutEffect(() => {
          const node = box.current
          if (node === null) return undefined
          const apply = () => {
            const next = measureHero(box, slot)
            setAlign((current) => (samePlacement(current, next) ? current : next))
          }
          apply()
          const view = node.ownerDocument === null ? null : node.ownerDocument.defaultView
          if (view === null || view === undefined || typeof view.ResizeObserver !== 'function') return undefined
          const observer = new view.ResizeObserver(apply)
          if (node.parentElement !== null) observer.observe(node.parentElement)
          const anchor = composerOutlet(node)
          if (anchor !== null) {
            observer.observe(anchor.element)
            if (anchor.element.parentElement !== null) observer.observe(anchor.element.parentElement)
          }
          const onViewportChange = () => apply()
          if (typeof view.addEventListener === 'function') view.addEventListener('resize', onViewportChange)
          return () => {
            observer.disconnect()
            if (typeof view.removeEventListener === 'function') view.removeEventListener('resize', onViewportChange)
          }
        }, [heroKey, modeKey, phase])
        const anchored = align !== null && align.mode === 'anchored'
        const slotStyle = anchored ? { left: `${align.left}px`, top: `${align.top}px` } : undefined
        return h(
          'div',
          {
            className: 'ollama-usage-hero',
            'data-mode': anchored ? 'anchored' : 'fixed',
            ref: (node) => {
              box.current = node
            },
          },
          h(
            'div',
            {
              className: 'ollama-usage-slot',
              style: slotStyle,
              ref: (node) => {
                slot.current = node
              },
            },
            hero && state.phase === 'ok' ? h(UsageSurface, null) : null,
          ),
        )
      }

      function textInput(id, value, onChange) {
        return h('input', { id, className: 'ollama-usage-input', type: 'text', value, spellCheck: false, onChange })
      }

      function ConfigCard() {
        const [open, setOpen] = React.useState(false)
        const [snapshot, setSnapshot] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [credential, setCredential] = React.useState(null)
        const [secret, setSecret] = React.useState('')
        const [notice, setNotice] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [reloadToken, setReloadToken] = React.useState(0)
        const usageState = useUsage()

        React.useEffect(() => {
          acquire()
          return () => release()
        }, [])

        React.useEffect(() => {
          let cancelled = false
          request('config/read', {})
            .then((reply) => {
              if (cancelled) return null
              const value = isRecord(reply) && isRecord(reply.value) ? reply.value : {}
              const next = {
                baseURL: readText(value.baseURL),
                apiKeyEnv: readText(value.apiKeyEnv),
                credentialMode: readText(value.credentialMode) === MODE_DIRECT ? MODE_DIRECT : MODE_REFERENCE,
                revision: isRecord(reply) && typeof reply.revision === 'number' ? reply.revision : null,
                writable: !isRecord(reply) || reply.writable !== false,
                error: isRecord(reply) ? readText(reply.error) : '',
              }
              setSnapshot(next)
              setDraft((current) =>
                current !== null
                  ? current
                  : { baseURL: next.baseURL, apiKeyEnv: next.apiKeyEnv, credentialMode: next.credentialMode },
              )
              return request('credential/describe', { ref: next.apiKeyEnv })
            })
            .then((reply) => {
              if (cancelled || !isRecord(reply)) return
              setCredential({
                configured: reply.configured === true,
                writable: reply.writable === true,
                error: readText(reply.error),
              })
            })
            .catch(() => {
              if (!cancelled) setNotice({ kind: 'error', text: copy.readFailed })
            })
          return () => {
            cancelled = true
          }
        }, [reloadToken])

        const reload = () => setReloadToken((current) => current + 1)
        const patchDraft = (patch) =>
          setDraft((current) => {
            const base = current === null ? { baseURL: '', apiKeyEnv: '', credentialMode: MODE_REFERENCE } : current
            return {
              baseURL: patch.baseURL === undefined ? base.baseURL : patch.baseURL,
              apiKeyEnv: patch.apiKeyEnv === undefined ? base.apiKeyEnv : patch.apiKeyEnv,
              credentialMode: patch.credentialMode === undefined ? base.credentialMode : patch.credentialMode,
            }
          })

        const onSave = () => {
          if (draft === null || busy) return
          setBusy(true)
          setNotice(null)
          request('config/save', {
            patch: { baseURL: draft.baseURL, apiKeyEnv: draft.apiKeyEnv, credentialMode: draft.credentialMode },
            expectedRevision: snapshot === null ? undefined : snapshot.revision,
          })
            .then((reply) => {
              setBusy(false)
              if (isRecord(reply) && reply.ok === true) {
                setNotice({ kind: 'ok', text: copy.saved })
                reload()
                return
              }
              const error = isRecord(reply) && isRecord(reply.error) ? reply.error : null
              const code = error === null ? '' : readText(error.code)
              setNotice({ kind: 'error', text: code === 'conflict' ? copy.conflict : error === null ? copy.writeFailed : readText(error.message) })
            })
            .catch(() => {
              setBusy(false)
              setNotice({ kind: 'error', text: copy.writeFailed })
            })
        }
        const onDiscard = () => {
          if (snapshot === null) return
          setDraft({ baseURL: snapshot.baseURL, apiKeyEnv: snapshot.apiKeyEnv, credentialMode: snapshot.credentialMode })
          setNotice({ kind: 'info', text: copy.discarded })
        }
        const onCredential = (endpoint, payload) => {
          if (busy) return
          setBusy(true)
          setNotice(null)
          request(endpoint, payload)
            .then((reply) => {
              setBusy(false)
              if (isRecord(reply) && reply.ok === true) {
                setSecret('')
                setNotice({ kind: 'ok', text: endpoint === 'credential/set' ? copy.keySaved : copy.keyCleared })
                reload()
                return
              }
              const error = isRecord(reply) && isRecord(reply.error) ? reply.error : null
              setNotice({ kind: 'error', text: error === null ? copy.writeFailed : readText(error.message) })
            })
            .catch(() => {
              setBusy(false)
              setNotice({ kind: 'error', text: copy.writeFailed })
            })
        }

        const mode = draft === null ? MODE_REFERENCE : draft.credentialMode
        const dirty =
          snapshot !== null &&
          draft !== null &&
          (snapshot.baseURL !== draft.baseURL ||
            snapshot.apiKeyEnv !== draft.apiKeyEnv ||
            snapshot.credentialMode !== draft.credentialMode)

        const header = h(
          'button',
          {
            type: 'button',
            className: 'ollama-usage-cardheader',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `${open ? copy.collapse : copy.expand}: ${copy.cardTitle}`,
            onClick: () => setOpen((current) => !current),
          },
          h(
            'span',
            { className: 'ollama-usage-headtext' },
            h('span', { className: 'ollama-usage-cardname' }, copy.cardTitle),
            h('span', { className: 'ollama-usage-carddesc' }, copy.cardDesc),
          ),
          dirty ? h('span', { className: 'ollama-usage-pending' }, copy.unsaved) : null,
          chevronSvg(open),
        )

        if (!open) return h('li', { className: 'ollama-usage-card', 'data-open': 'false' }, header)
        if (draft === null) {
          return h(
            'li',
            { className: 'ollama-usage-card', 'data-open': 'true' },
            header,
            h('div', { className: 'ollama-usage-cardbody' },
              h('div', { className: 'ollama-usage-field' }, copy.loading)),
          )
        }

        const credentialStatus =
          credential === null
            ? copy.loading
            : credential.configured
              ? copy.credConfigured + (credential.writable ? '' : ` · ${copy.credUnwritable}`)
              : copy.credMissing
        const usageStatus =
          usageState.phase === 'loading'
            ? copy.fetchLoading
            : usageState.phase === 'ok' && usageState.usage !== null
              ? copy.fetchOk(countWindows(usageState.usage), formatClock(usageState.usage.fetchedAt))
              : copy.fetchNone

        const fields = [
          h(
            'div',
            { key: 'baseurl', className: 'ollama-usage-field' },
            h('label', { htmlFor: 'ollama-usage-baseurl' }, 'baseURL'),
            textInput('ollama-usage-baseurl', draft.baseURL, (event) => patchDraft({ baseURL: event.target.value })),
            h('div', { className: 'ollama-usage-hint' }, 'Ollama API 地址，默认 https://ollama.com'),
          ),
          h(
            'div',
            { key: 'mode', className: 'ollama-usage-field' },
            h('label', null, copy.modeLabel),
            h(
              'div',
              { className: 'ollama-usage-modes', role: 'radiogroup', 'aria-label': copy.modeLabel },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ollama-usage-mode',
                  role: 'radio',
                  'aria-checked': mode === MODE_REFERENCE ? 'true' : 'false',
                  'data-active': mode === MODE_REFERENCE ? 'true' : 'false',
                  onClick: () => patchDraft({ credentialMode: MODE_REFERENCE }),
                },
                h('span', { className: 'ollama-usage-modename' }, copy.modeNameReference),
                h('span', { className: 'ollama-usage-modedesc' }, copy.modeDescReference),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ollama-usage-mode',
                  role: 'radio',
                  'aria-checked': mode === MODE_DIRECT ? 'true' : 'false',
                  'data-active': mode === MODE_DIRECT ? 'true' : 'false',
                  onClick: () => patchDraft({ credentialMode: MODE_DIRECT }),
                },
                h('span', { className: 'ollama-usage-modename' }, copy.modeNameDirect),
                h('span', { className: 'ollama-usage-modedesc' }, copy.modeDescDirect),
              ),
            ),
          ),
        ]

        if (mode === MODE_REFERENCE) {
          fields.push(
            h(
              'div',
              { key: 'ref', className: 'ollama-usage-field' },
              h('label', { htmlFor: 'ollama-usage-ref' }, copy.refLabel),
              textInput('ollama-usage-ref', draft.apiKeyEnv, (event) => patchDraft({ apiKeyEnv: event.target.value })),
              h('div', { className: 'ollama-usage-hint' }, copy.refHint),
              h('div', { className: 'ollama-usage-hint' }, `${copy.credLabel}: ${credentialStatus}`),
            ),
          )
        } else {
          fields.push(
            h(
              'div',
              { key: 'key', className: 'ollama-usage-field' },
              h('label', { htmlFor: 'ollama-usage-key' }, copy.keyLabel),
              h('input', {
                id: 'ollama-usage-key',
                className: 'ollama-usage-input',
                type: 'password',
                value: secret,
                autoComplete: 'off',
                placeholder: copy.keyPlaceholder,
                onChange: (event) => setSecret(event.target.value),
              }),
              h('div', { className: 'ollama-usage-hint' }, copy.directHint),
              h(
                'div',
                { className: 'ollama-usage-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ollama-usage-btn',
                    disabled: busy || secret.length === 0,
                    onClick: () => onCredential('credential/set', { value: secret }),
                  },
                  copy.saveKey,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ollama-usage-btn',
                    disabled: busy,
                    onClick: () => onCredential('credential/unset', {}),
                  },
                  copy.clearKey,
                ),
              ),
              h('div', { className: 'ollama-usage-hint' }, `OLLAMA_USAGE_API_KEY: ${credentialStatus}`),
            ),
          )
        }

        const statusLines = [h('span', { key: 'usage' }, `${copy.usageTitle}: ${usageStatus}`)]
        if (snapshot !== null && snapshot.error.length > 0) statusLines.push(h('span', { key: 'error' }, snapshot.error))
        if (snapshot !== null && !snapshot.writable) statusLines.push(h('span', { key: 'readonly' }, copy.readOnly))

        const note =
          notice === null
            ? h('p', { key: 'note', className: 'ollama-usage-ok' }, '')
            : h(
                'p',
                { key: 'note', className: notice.kind === 'ok' ? 'ollama-usage-ok' : 'ollama-usage-failed' },
                notice.text,
              )

        return h(
          'li',
          { className: 'ollama-usage-card', 'data-open': 'true' },
          header,
          h(
            'div',
            { className: 'ollama-usage-cardbody' },
            fields,
            h('div', { className: 'ollama-usage-status' }, statusLines),
            h(
              'div',
              { className: 'ollama-usage-footer' },
              note,
              h(
                'button',
                { type: 'button', className: 'ollama-usage-btn', disabled: busy || !dirty, onClick: onDiscard },
                copy.discard,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ollama-usage-btn',
                  'data-primary': 'true',
                  disabled: busy || !dirty,
                  onClick: onSave,
                },
                copy.save,
              ),
            ),
          ),
        )
      }

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: DOCK_ID, order: DOCK_ORDER }, DockEntry),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: OVERLAY_ORDER }, HeroEntry),
      )
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register({ name: 'settings.plugin.item', key: NS }, ConfigCard),
      )
    }

    function apply(ctx) {
      makeApply(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
