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
const injected = []
const registrations = []
const effects = []
const timers = []
const services = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => undefined
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

check('claims exactly the three seats', injected, [
  'conversation.composer.dock',
  'conversation.input.dock',
  'settings.plugin.item',
])
check('registered three entries', registrations.length, 3)

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
check('settings seat: slot name', bySlot['settings.plugin.item'].name, 'settings.plugin.item')
check('settings seat: key is the namespace', bySlot['settings.plugin.item'].key, 'ollama-usage')
check(
  'every seat registered a component',
  registrations.every((entry) => typeof entry.component === 'function'),
  true,
)

check('stylesheet injected once', styleTags.length, 1)
check('stylesheet is tagged with the plugin', styleTags[0].dataset.plugin, 'ollama-usage-client')
check('stylesheet carries the pill rules', styleTags[0].textContent.includes('.ollama-usage-pill'), true)
check('stylesheet carries the panel rules', styleTags[0].textContent.includes('.ollama-usage-panel'), true)
// Both surfaces are flow rows now, so the hero has no anchor/fixed mode left to style.
check('stylesheet has no hero overlay rules left', [
  styleTags[0].textContent.includes('.ollama-usage-hero'),
  styleTags[0].textContent.includes('[data-mode='),
  styleTags[0].textContent.includes('.ollama-usage-dock[data-flow="true"]'),
], [false, false, true])
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
