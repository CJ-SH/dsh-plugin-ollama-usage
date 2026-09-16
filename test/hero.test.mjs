/**
 * Hero-surface harness. Drives the real DockEntry / HeroEntry components with a minimal hook
 * runtime, so the phase rule — "the overlay appears only while no composer dock is mounted"
 * — is observable without a browser.
 *
 *   node test/hero.test.mjs
 */
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../lib/client.js', import.meta.url)

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

// --- Minimal hook runtime, one store per component ----------------------------------------
const stores = new WeakMap()
let active = null
let cursor = 0
let dirty = false
const storeOf = (component) => {
  let store = stores.get(component)
  if (store === undefined) {
    store = { states: [], deps: [], pending: [], cleanups: [] }
    stores.set(component, store)
  }
  return store
}
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    const store = storeOf(active)
    const index = cursor
    cursor += 1
    if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(store.states[index]) : next
      if (Object.is(value, store.states[index])) return
      store.states[index] = value
      dirty = true
    }
    return [store.states[index], set]
  },
  useEffect: (effect, list) => {
    const store = storeOf(active)
    const index = cursor
    cursor += 1
    const previous = store.deps[index]
    const changed = previous === undefined || list === undefined || list.length !== previous.length || list.some((entry, at) => !Object.is(entry, previous[at]))
    if (!changed) return
    store.deps[index] = list
    store.pending.push([index, effect])
  },
  useLayoutEffect: (effect, list) => reactStub.useEffect(effect, list),
}

let factory = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { append: () => undefined },
  querySelector: () => null,
}

await import(clientUrl.href)
const exported = factory((request) => {
  if (request === 'react') return reactStub
  throw new Error(`unexpected require("${request}")`)
})

const USAGE = { status: 'ok', usage: { fetchedAt: '2026-09-14T10:00:00.000Z', session: { usage: 0.2, models: [] }, weekly: { usage: 0.9, models: [] } } }
const caught = []
const services = {
  slots: { inject: (key, callback) => callback(), register: (options, component) => { caught.push({ options, component }); return () => undefined } },
  locale: { getLocale: () => ({ active: 'zh' }) },
  // The route is reached with `fetch`; one answered read is all this harness needs.
  placeholder: null,
}
globalThis.fetch = async (input) => {
  const endpoint = new URL(String(input)).pathname.slice('/ollama-usage/'.length)
  const value = endpoint === 'usage/read' ? USAGE : { status: 'none' }
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
}
const ctx = {
  slots: services.slots,
  locale: services.locale,
  effect: (callback) => callback(),
  timeout: () => () => undefined,
  interval: () => () => undefined,
  get: (name) => services[name],
}

exported.apply(ctx)
const dock = caught.find((entry) => entry.options.id === 'ollama-usage')?.component
const hero = caught.find((entry) => entry.options.id === 'ollama-usage-hero')?.component
check('captured both surfaces', [typeof dock, typeof hero], ['function', 'function'])

function render(component) {
  active = component
  cursor = 0
  const store = storeOf(component)
  store.pending = []
  const tree = component()
  for (const [index, effect] of store.pending) store.cleanups[index] = effect() ?? null
  return tree
}
const hasPill = (node, depth = 0) => {
  if (depth > 6 || node === null || node === undefined || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => hasPill(child, depth))
  if (typeof node.type === 'function') {
    if (node.type.name === 'UsagePill') return true
    // The surface decides for itself whether it contributes a pill at all, so render it.
    if (node.type.name === 'UsageSurface') {
      active = node.type
      cursor = 0
      return hasPill(node.type(node.props), depth + 1)
    }
    return false
  }
  if (node.props?.className === 'ollama-usage-pill') return true
  return (node.children ?? []).some((child) => hasPill(child, depth))
}
async function settle(component, rounds = 12) {
  let tree = render(component)
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (!dirty) break
    dirty = false
    tree = render(component)
  }
  return tree
}

// 1. A session is open: the dock mounts, and the overlay must stay out of the way.
const dockTree = await settle(dock)
check('the dock renders its pill in a session', hasPill(dockTree), true)

// The pill is pinned to the 5-hour window, even when a longer window is more loaded: the
// fixture above deliberately puts weekly (0.9) far above session (0.2).
const pillProps = []
const collectPills = (node, depth = 0) => {
  if (depth > 6 || node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectPills(child, depth)
    return
  }
  if (typeof node.type === 'function') {
    if (node.type.name === 'UsagePill') {
      pillProps.push(node.props)
      return
    }
    if (node.type.name === 'UsageSurface') {
      active = node.type
      cursor = 0
      collectPills(node.type(node.props), depth + 1)
    }
    return
  }
  for (const child of node.children ?? []) collectPills(child, depth)
}
collectPills(dockTree)
check('the pill reports the 5-hour window', pillProps[0]?.headline?.key, 'session')
check('it uses that window even though weekly is higher', [pillProps[0]?.headline?.usage, USAGE.usage.weekly.usage], [0.2, 0.9])
check('the overlay is suppressed while the dock is mounted', hasPill(await settle(hero)), false)

// 2. The conversation goes to hero: the dock unmounts, and the overlay must take over.
const store = storeOf(dock)
for (const cleanup of store.cleanups) if (typeof cleanup === 'function') cleanup()
store.deps = []
dirty = true
const heroTree = await settle(hero)
check('the overlay shows once the dock unmounts', hasPill(heroTree), true)

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
      (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
  )
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
