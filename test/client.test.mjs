/**
 * Client-half harness. Loads the real bundle through a fake module loader and mounts it
 * against a fake cordis context, then asserts the seats it claims and the lifecycle of the
 * stylesheet it injects.
 *
 * This is the check that would have caught the slot-name mistake made while prototyping
 * dynamically (`name` must be the slot key, `id`/`key` is the plugin's own cell).
 *
 *   node test/client.test.mjs
 */
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../lib/client.js', import.meta.url)
const hostUrl = new URL('../lib/index.js', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

// --- Fake module loader + baseline react ------------------------------------------------
let factory = null
let registeredId = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registeredId = entry.id
      factory = entry.factory
    },
  },
}

const createElement = (type, props, ...children) => ({ type, props, children })
const reactStub = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}

// --- Fake document (the bundle injects its own stylesheet) ------------------------------
const styleTags = []
globalThis.document = {
  createElement(tag) {
    const node = { tag, dataset: {}, textContent: '', removed: false, remove() { this.removed = true } }
    return node
  },
  head: { append: (node) => styleTags.push(node) },
  querySelector: () => null,
}

await import(clientUrl.href)
check('bundle registered a factory', typeof factory, 'function')
check('bundle id equals the package name', registeredId, packageJson.name)

const required = []
const exported = factory((request) => {
  required.push(request)
  if (request === 'react') return reactStub
  throw new Error(`unexpected require("${request}")`)
})
check('bundle requires only react', required, ['react'])
check('bundle exports apply + inject', [typeof exported.apply, Array.isArray(exported.inject)], ['function', true])
check('declared services', exported.inject, ['slots', 'locale', 'timer'])

// --- Fake cordis context ----------------------------------------------------------------
//
// The REAL `slots.inject` contract: the callback runs only while the slot declaration is live
// (and synchronously when it already is), with its disposer running on collapse. The two composer
// seats are declared by the shell; `plugin-suite.panel` is NOT, because no hub is installed. A
// stub that calls back unconditionally is exactly what keeps a renamed seat green — which is how
// the dead `settings.plugin.item` seat survived 93 passing assertions.
const injected = []
const registrations = []
const effects = []
const timers = []
const declaredSeats = new Set(['conversation.composer.dock', 'conversation.input.dock', 'settings.section'])
const pendingInjectors = []
const cellsIn = (slot) => registrations.filter((entry) => entry.options.name === slot)

const services = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      if (declaredSeats.has(key)) return callback() ?? (() => undefined)
      pendingInjectors.push({ key, callback })
      return () => undefined
    },
    declareSeat(key) {
      declaredSeats.add(key)
      for (const entry of pendingInjectors) {
        if (entry.key === key) entry.disposer = entry.callback() ?? (() => undefined)
      }
    },
    collapseSeat(key) {
      declaredSeats.delete(key)
      for (const entry of pendingInjectors) {
        if (entry.key !== key || entry.disposer === undefined) continue
        entry.disposer()
        entry.disposer = undefined
      }
    },
    register(options, component) {
      const entry = { options, component }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  },
  locale: { getLocale: () => ({ active: 'zh' }) },
  // No `connection` service: the browser half fetches the Host's own route.
  timer: { interval: () => () => undefined },
}
const ctx = {
  ...services,
  get: (serviceName) => services[serviceName],
  effect(callback, label) {
    const disposer = callback()
    effects.push({ label, disposer })
    return disposer
  },
  timeout(callback, delay) {
    timers.push({ delay })
    return () => undefined
  },
  interval(callback, delay) {
    timers.push({ delay, repeating: true })
    return () => undefined
  },
}

exported.apply(ctx)

check('claims the two composer seats, the Settings section, and the hub slot', injected, [
  'conversation.composer.dock',
  'conversation.input.dock',
  'settings.section',
  'plugin-suite.panel',
])
check('registered one entry per declared seat, plus its own Settings page', registrations.length, 3)

const bySlot = Object.fromEntries(registrations.map((entry) => [entry.options.name, entry.options]))
check('dock seat: slot name', bySlot['conversation.composer.dock'].name, 'conversation.composer.dock')
check('dock seat: cell id', bySlot['conversation.composer.dock'].id, 'ollama-usage')
check('dock seat: order', bySlot['conversation.composer.dock'].order, 1)
// The hero surface is no longer a measured `shell.overlay` box: it is the composer's own flow
// row, the same seat the sibling statusline plugin uses. The id keeps the `-hero` suffix because
// that is the state it serves.
check('hero seat: slot name', bySlot['conversation.input.dock'].name, 'conversation.input.dock')
check('hero seat: cell id', bySlot['conversation.input.dock'].id, 'ollama-usage-hero')
check('hero seat: order', bySlot['conversation.input.dock'].order, 1)
check('the measured overlay seat is gone', bySlot['shell.overlay'], undefined)
check('settings page: slot name', bySlot['settings.section'].name, 'settings.section')
check('settings page: cell id is the plugin id', bySlot['settings.section'].id, 'ollama-usage')
check('settings page: order', bySlot['settings.section'].order, 170)
// The old keyed card seat of the Plugins tab does not exist in dsh 0.2 at all; registering it is
// a silent no-op, so its absence is the guard rather than a cosmetic detail.
check('settings page: the dead keyed seat is gone', bySlot['settings.plugin.item'], undefined)
check('hub: nothing is contributed while no hub is installed', cellsIn('plugin-suite.panel').length, 0)
check(
  'every seat registered a component',
  registrations.every((entry) => typeof entry.component === 'function'),
  true,
)

// One panel, two mount points: the hub takes over and gives the page back when it goes away.
services.slots.declareSeat('plugin-suite.panel')
check('hub: the own page stands down', cellsIn('settings.section').length, 0)
check('hub: exactly one cell lands in the hub', cellsIn('plugin-suite.panel').length, 1)
services.slots.collapseSeat('plugin-suite.panel')
check('hub: collapsing the hub restores the own page', cellsIn('settings.section').length, 1)

check('stylesheet injected once', styleTags.length, 1)

// `settings.section` is declared by the settings shell, and registering into an UNDECLARED slot
// throws — which fails the entire browser half and surfaces as "did not activate" on a healthy
// workspace. That is exactly the bug this suite missed. With no seat declared, `apply` must
// contribute nothing and must not throw.
//
// Deliberately the LAST thing in this file: a second `apply` also injects its own stylesheet, and
// the assertion above is about one apply, so this must not run before it.
const seatlessSeats = []
const seatlessCtx = {
  // `makeApply` owns an effect and a poll timer before it ever looks at a seat, so a stub missing
  // these fails for the wrong reason and the guard would be measuring the stub, not the plugin.
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => undefined
  },
  slots: {
    inject: () => () => undefined,
    register: (options) => {
      seatlessSeats.push(options)
      return () => undefined
    },
  },
  locale: { getLocale: () => ({ active: 'zh' }), register: () => () => undefined },
  timeout: () => () => undefined,
  interval: () => () => undefined,
}
let seatlessError = null
try {
  exported.apply(seatlessCtx)
} catch (error) {
  seatlessError = error
}
check('seat: with no Settings seat declared, apply does not throw', seatlessError, null)
check('seat: and contributes nothing to an undeclared slot', seatlessSeats.length, 0)
check('stylesheet is tagged with the plugin', styleTags[0].dataset.plugin, 'ollama-usage-client')
check('stylesheet carries the pill rules', styleTags[0].textContent.includes('.ollama-usage-pill'), true)
check('stylesheet carries the panel rules', styleTags[0].textContent.includes('.ollama-usage-panel'), true)
// Both surfaces are plain flow items, and the measured overlay is gone for good: the shell owns
// the composer dock's row, and on a dsh without that row the same markup degrades to a row of its
// own. Nothing in the sheet may place, measure or lift the entry any more.
check('stylesheet has no overlay or measurement rules left', [
  styleTags[0].textContent.includes('.ollama-usage-hero'),
  styleTags[0].textContent.includes('[data-mode='),
  styleTags[0].textContent.includes('[data-flow'),
  /\.ollama-usage-dock\{[^}]*height:0/.test(styleTags[0].textContent),
  /\.ollama-usage-dock\{[^}]*position:absolute/.test(styleTags[0].textContent),
  /\.ollama-usage-slot\{[^}]*position:absolute/.test(styleTags[0].textContent),
], [false, false, false, false, false, false])
check('the dock entry is a plain flow item', [
  /\.ollama-usage-dock\{[^}]*display:inline-flex/.test(styleTags[0].textContent),
  /\.ollama-usage-dock\{[^}]*min-width:0/.test(styleTags[0].textContent),
  /\.ollama-usage-slot\{[^}]*display:inline-flex/.test(styleTags[0].textContent),
], [true, true, true])
// The detail panel is absolutely positioned, so its containing block has to be the slot that holds
// the pill — otherwise it climbs to the composer card and pops somewhere else entirely. This is the
// one `position` the entry still needs, and it is not measurement: no rect is ever read.
check('the panel is anchored to the slot that holds the pill', [
  /\.ollama-usage-slot\{[^}]*position:relative/.test(styleTags[0].textContent),
  /\.ollama-usage-panel\{[^}]*position:absolute/.test(styleTags[0].textContent),
  /\.ollama-usage-panel\{[^}]*bottom:calc\(100% \+ 6px\)/.test(styleTags[0].textContent),
], [true, true, true])
// The hero row shares the composer's input-dock line with the sibling statusline pill: the row is
// content-sized and the seat anchor (inline `display:contents`) is overridden into a wrapping row.
check('the hero row shares the composer dock line', [
  /\.ollama-usage-dockline\{[^}]*display:inline-flex/.test(styleTags[0].textContent),
  // The panel's own window rows own `.ollama-usage-row`, so the hero row must not reuse it.
  /\.ollama-usage-dockline\{[^}]*flex-direction:column/.test(styleTags[0].textContent),
  /\[data-slot="conversation\.input\.dock"\]\{[^}]*display:flex !important/.test(styleTags[0].textContent),
  /\[data-slot="conversation\.input\.dock"\]\{[^}]*flex-flow:row wrap/.test(styleTags[0].textContent),
], [true, false, true, true])

const settle = effects.find((entry) => String(entry.label).includes('stylesheet'))
check('stylesheet disposer removes the tag', (() => {
  settle.disposer()
  return styleTags[0].removed
})(), true)
check('a settle timer was scheduled', timers.some((entry) => entry.delay === 250), true)

// --- Cross-half contract: every endpoint the client calls exists on the host -------------
const clientSource = await readFile(clientUrl, 'utf8')
const hostSource = await readFile(hostUrl, 'utf8')
// The measurement path is deleted, not merely disabled. Asserted against **code**, not comments:
// the doc comment on the dock entry names the helpers it replaced on purpose.
const clientCode = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('the client half no longer measures the composer dock', [
  /ResizeObserver/.test(clientCode),
  /getBoundingClientRect/.test(clientCode),
  /data-flow/.test(clientCode),
  /function (resolveBox|narrowToContent|findPillRow|composerOutlet|rowMetrics|measureDock|samePlacement)\b/.test(clientCode),
  /INLINE_GAP_PX|useIsoLayoutEffect/.test(clientCode),
], [false, false, false, false, false])
// No dead hooks either: every class the client renders must have a rule of its own. The audit that
// produced this check found `.ollama-usage-slot-inner` — rendered for months, styled nowhere.
const renderedClasses = [...new Set([...clientSource.matchAll(/className: '(ollama-usage-[a-z0-9-]+)'/g)].map((match) => match[1]))]
check('every rendered class has a rule of its own', renderedClasses.filter((name) => !styleTags[0].textContent.includes('.' + name + '{')), [])
const called = [...new Set([...clientSource.matchAll(/(?:request|onCredential)\(\s*'([^']+)'/g)].map((match) => match[1]))].sort()
const handled = [...new Set([...hostSource.matchAll(/case\s+'([^']+)':/g)].map((match) => match[1]))].sort()
check('client calls exactly the endpoints the host handles', called, handled)
check('endpoint set is the expected six', handled, [
  'config/read',
  'config/save',
  'credential/describe',
  'credential/set',
  'credential/unset',
  'usage/read',
])
check('client and host agree on the route prefix', [
  clientSource.includes("const ROUTE_PREFIX = '/ollama-usage'"),
  hostSource.includes("const ROUTE_PREFIX = '/ollama-usage'"),
], [true, true])
check('client and host agree on the namespace', [
  clientSource.includes("const NS = 'ollama-usage'"),
  hostSource.includes("const NS = 'ollama-usage'"),
], [true, true])

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
      (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
  )
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
