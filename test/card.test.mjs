/**
 * Card behaviour harness. Loads the real bundle, captures the registered ConfigCard, and
 * drives it with a minimal hook runtime so the card's own state machine — mount effect,
 * `config/read`, `credential/describe`, `draft` — can be observed without a browser.
 *
 *   node test/card.test.mjs
 */
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../lib/client.js', import.meta.url)

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

// --- Minimal hook runtime -----------------------------------------------------------------
let states = []
let deps = []
let cursor = 0
let pending = []
let dirty = false

const schedule = () => {
  dirty = true
}
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    const index = cursor
    cursor += 1
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(states[index]) : next
      if (Object.is(value, states[index])) return
      states[index] = value
      schedule()
    }
    return [states[index], set]
  },
  useEffect: (effect, list) => {
    const index = cursor
    cursor += 1
    const previous = deps[index]
    const changed = previous === undefined || list === undefined || list.length !== previous.length || list.some((entry, at) => !Object.is(entry, previous[at]))
    if (!changed) return
    deps[index] = list
    pending.push(effect)
  },
  useLayoutEffect: (effect, list) => reactStub.useEffect(effect, list),
}

// --- Loader + document --------------------------------------------------------------------
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

// --- Fake context: the replies are the ones the live channel really returns ---------------
const calls = []
const services = {
  // Real `slots.inject` semantics: the callback runs only while the slot is declared. No hub is
  // declared here, so the card lands on this plugin's own Settings page.
  slots: {
    inject: (key, callback) => (key === 'plugin-suite.panel' ? () => undefined : callback()),
    register: (options, component) => { services.slots.caught.push({ options, component }); return () => undefined },
    caught: [],
  },
  locale: { getLocale: () => ({ active: 'zh' }) },
}

// Every request carries a JSON body — an omitted one is exactly the bug that once kept the
// settings card stuck on "读取中…", so the harness refuses to answer without it.
const replied = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
globalThis.fetch = async (input, init) => {
  const endpoint = new URL(String(input)).pathname.slice('/ollama-usage/'.length)
  calls.push(endpoint)
  if (init === undefined || typeof init.body !== 'string') {
    throw new Error(`bad-request: ${endpoint} sent no body`)
  }
  if (endpoint === 'config/read') {
    return replied({
      available: true,
      registered: true,
      writable: true,
      value: { baseURL: 'https://ollama.com', credentialMode: 'reference', apiKeyEnv: 'OLLAMA_API_KEY' },
      revision: 0,
      ref: 'OLLAMA_API_KEY',
      endpoint: 'https://ollama.com/api/usage',
      error: null,
    })
  }
  if (endpoint === 'credential/describe') {
    return replied({ mode: 'reference', ref: 'OLLAMA_API_KEY', owned: false, configured: true, writable: true, source: 'file', error: null })
  }
  return replied({ status: 'none' })
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
const configCard = services.slots.caught.find((entry) => entry.options.name === 'settings.section')
check('caught the settings card component', typeof configCard?.component, 'function')

// --- Drive the card ------------------------------------------------------------------------
const textsOf = (node, found = []) => {
  if (node === null || node === undefined || node === false) return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)
    return found
  }
  for (const child of node.children ?? []) textsOf(child, found)
  return found
}

function render() {
  cursor = 0
  pending = []
  const tree = configCard.component()
  for (const effect of pending) effect()
  return tree
}

async function settle(rounds = 10) {
  let tree = render()
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (!dirty) break
    dirty = false
    tree = render()
  }
  return tree
}

const tree = await settle()
const texts = textsOf(tree)
const joined = texts.join(' | ')

check('the card called the host', calls.includes('config/read'), true)
check('it also asked for the credential', calls.includes('credential/describe'), true)
check('the card collapsed by default', joined.includes('Ollama Cloud 用量') && joined.includes('读取中…'), false)

// --- Expand it the way a click does, then re-inspect the body -----------------------------
const findHeader = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findHeader(child)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.props?.className === 'ollama-usage-cardheader') return node
  for (const child of node.children ?? []) {
    const hit = findHeader(child)
    if (hit !== null) return hit
  }
  return null
}

const header = findHeader(tree)
check('the header is clickable', typeof header?.props?.onClick, 'function')
header.props.onClick()
dirty = true
const expanded = await settle()
const bodyTexts = textsOf(expanded)
const body = bodyTexts.join(' | ')

check('the expanded card left the loading state', body.includes('读取中…'), false)
check('it rendered the baseURL field', body.includes('baseURL'), true)
check('it rendered the credential mode labels', body.includes('凭据模式') && body.includes('密钥模式'), true)
check('it reported the credential as configured', body.includes('已配置'), true)
check('it did not report a read failure', body.includes('无法读取配置'), false)

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
      (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
  )
}
if (failed.length > 0) console.log(`\ncard texts: ${joined}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
