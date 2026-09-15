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
check('declared services', exported.inject, ['slots', 'locale', 'connection', 'timer'])

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
  connection: { rpc: { call: async () => ({ ok: true, value: { status: 'none' } }) } },
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
  'shell.overlay',
  'settings.plugin.item',
])
check('registered three entries', registrations.length, 3)

const bySlot = Object.fromEntries(registrations.map((entry) => [entry.options.name, entry.options]))
check('dock seat: slot name', bySlot['conversation.composer.dock'].name, 'conversation.composer.dock')
check('dock seat: cell id', bySlot['conversation.composer.dock'].id, 'ollama-usage')
check('dock seat: order', bySlot['conversation.composer.dock'].order, 1)
check('overlay seat: slot name', bySlot['shell.overlay'].name, 'shell.overlay')
check('overlay seat: cell id', bySlot['shell.overlay'].id, 'ollama-usage-hero')
check('overlay seat: order', bySlot['shell.overlay'].order, 1)
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
check('stylesheet covers the hero anchor mode', styleTags[0].textContent.includes('[data-mode="anchored"]') || styleTags[0].textContent.includes('.ollama-usage-hero'), true)

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
check('client and host agree on the channel', [
  clientSource.includes("const CHANNEL = '/ollama-usage'"),
  hostSource.includes("const CHANNEL = '/ollama-usage'"),
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
