/**
 * Self-contained checks for both halves. No test runner, no dependencies:
 *
 *   node test/host.test.mjs
 *
 * The Host half is mounted against a fake cordis context and asserted on behaviour — the
 * settings namespace it registers, the RPC channel it exposes, the credential writes it
 * refuses, and the silent empty states. The client half is asserted structurally, because
 * its correctness there is a packaging contract (loader wrapper + the three slot seats).
 */
import { readFile } from 'node:fs/promises'

const hostUrl = new URL('../lib/index.js', import.meta.url)
const clientUrl = new URL('../lib/client.js', import.meta.url)

const { apply, inject, name } = await import(hostUrl.href)

const seen = { ns: null, schema: null, channel: null, handler: null }
let credentialMode = 'reference'
const credentialCalls = []

const services = {
  settings: {
    writable: true,
    register(ns, schema) {
      seen.ns = ns
      seen.schema = schema
      return { get: () => schema({}), update: async () => undefined }
    },
    describe() {
      return [
        {
          ns: seen.ns,
          value: seen.schema({ baseURL: 'https://ollama.com', credentialMode, apiKeyEnv: 'OLLAMA_API_KEY' }),
          revision: 3,
          user: {},
          schema: seen.schema.toJSON(),
        },
      ]
    },
    async update() {
      return undefined
    },
  },
  connection: {
    rpc: {
      handle(channel, handler) {
        seen.channel = channel
        seen.handler = handler
        return () => undefined
      },
    },
  },
  credentials: {
    async resolve() {
      return credentialMode === 'direct' ? { value: 'sk-x', source: 'file' } : undefined
    },
    async describe() {
      return { configured: true, writable: true, source: 'file' }
    },
    async set(ref, value) {
      credentialCalls.push({ ref, value })
    },
    async unset(ref) {
      credentialCalls.push({ ref, unset: true })
    },
  },
}

const ctx = {
  // Services are also readable as properties: the plugin declares them in its `inject`
  // export, and a declared service is what the real capability-scoped context allows.
  // Getters keep the swap-the-service stubs below effective.
  get settings() {
    return services.settings
  },
  get credentials() {
    return services.credentials
  },
  get connection() {
    return services.connection
  },
  webServer: { register: () => () => undefined },
  inject(names, callback) {
    const sub = Object.create(ctx)
    for (const serviceName of names) sub[serviceName] = services[serviceName]
    return callback(sub)
  },
  get(serviceName) {
    return services[serviceName]
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => undefined
  },
}

const results = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

apply(ctx)

// --- Host half: registration ------------------------------------------------------------
check('plugin name', name, 'dsh-plugin-ollama-usage')
// Regression guard for the bug that kept the whole plugin inert: the capability-scoped
// context proxy denies undeclared services, so a missing `inject` export means the plugin
// mounts, registers nothing, and reports nothing.
check('declares every required service', inject, ['settings', 'credentials', 'connection', 'webServer'])
check('settings namespace', seen.ns, 'ollama-usage')
check('rpc channel', seen.channel, '/ollama-usage')
check('schema defaults', seen.schema({}), {
  baseURL: 'https://ollama.com',
  credentialMode: 'reference',
  apiKeyEnv: 'OLLAMA_API_KEY',
})
check('schema normalises junk', seen.schema({ baseURL: 'https://x.test/', credentialMode: 'nope', apiKeyEnv: '  ' }), {
  baseURL: 'https://x.test',
  credentialMode: 'reference',
  apiKeyEnv: 'OLLAMA_API_KEY',
})
check('schema.toJSON is serialisable', typeof seen.schema.toJSON().dict.baseURL.default, 'string')

// --- Host half: config over RPC ---------------------------------------------------------
const read = await seen.handler('config/read', {})
check('config/read ok', [read.ok, read.value.registered, read.value.ref, read.value.revision], [true, true, 'OLLAMA_API_KEY', 3])
check('endpoint derived from baseURL', read.value.endpoint, 'https://ollama.com/api/usage')

// --- Host half: credential confinement --------------------------------------------------
credentialMode = 'reference'
const refused = await seen.handler('credential/set', { value: 'sk-secret' })
check('credential/set refuses in reference mode', [refused.value.ok, refused.value.error.code], [false, 'wrong-mode'])
check('nothing written in reference mode', credentialCalls.length, 0)

credentialMode = 'direct'
const accepted = await seen.handler('credential/set', { value: 'sk-secret' })
check('credential/set writes in direct mode', accepted.value.ok, true)
check('write went to the plugin-owned ref', credentialCalls[0].ref, 'OLLAMA_USAGE_API_KEY')
check('no foreign ref ever written', credentialCalls.every((call) => call.ref === 'OLLAMA_USAGE_API_KEY'), true)
const cleared = await seen.handler('credential/unset', {})
check('credential/unset clears the plugin-owned ref', [cleared.value.ok, credentialCalls.at(-1).ref], [true, 'OLLAMA_USAGE_API_KEY'])
credentialMode = 'reference'

// --- Host half: silent empty states (R5) ------------------------------------------------
const withCredentials = services.credentials
delete services.credentials
check('usage/read without credentials service', (await seen.handler('usage/read', {})).value, { status: 'none' })
services.credentials = withCredentials

services.credentials = { async resolve() { return undefined }, async describe() { return { configured: false, writable: false } } }
check('usage/read with an unconfigured credential', (await seen.handler('usage/read', {})).value, { status: 'none' })

services.credentials = { async resolve() { return { value: 'sk-x', source: 'file' } }, async describe() { return { configured: true, writable: true, source: 'file' } } }
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response('not found', { status: 404 })
check('usage/read against an endpoint without usage', (await seen.handler('usage/read', {})).value, { status: 'unsupported' })

globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      limits: {
        session: { usage: 0.259, models: [{ name: 'deepseek-v4.1-flash', request_count: 505 }] },
        weekly: { usage: 0.057, models: [] },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
const decoded = (await seen.handler('usage/read', {})).value
check('usage/read decodes status', decoded.status, 'ok')
check('usage/read decodes a window', decoded.usage.session, { usage: 0.259, models: [{ name: 'deepseek-v4.1-flash', requestCount: 505 }] })
check('usage/read keeps the present windows only', Object.keys(decoded.usage).sort(), ['fetchedAt', 'session', 'weekly'])
check('usage/read carries no key', JSON.stringify(decoded).includes('sk-x'), false)

globalThis.fetch = async () => new Response('<html>nope</html>', { status: 200 })
check('usage/read on a non-JSON body', (await seen.handler('usage/read', {})).value, { status: 'none' })
globalThis.fetch = realFetch

const unknown = await seen.handler('nope/nope', {})
check('unknown endpoint is a loud protocol error', [unknown.ok, unknown.error.code], [false, 'unknown-endpoint'])

// --- Host half: dependency-free ---------------------------------------------------------
const hostSource = await readFile(hostUrl, 'utf8')
check('host half imports nothing from the harness', /from\s+['"]@deepseek-ai\//.test(hostSource), false)

// --- Client half: packaging contract ---------------------------------------------------
const clientSource = await readFile(clientUrl, 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
check('client bundle registers a loader factory', clientSource.includes('window.__ModuleLoader__.load'), true)
check('client bundle id equals the package name', clientSource.includes(`id: '${packageJson.name}'`), true)
check('client bundle exports apply + inject', [clientSource.includes('exports.apply = apply'), clientSource.includes('exports.inject = inject')], [true, true])
check('client exports the composer dock seat', clientSource.includes('conversation.composer.dock'), true)
check('client exports the frame overlay seat', clientSource.includes("'shell.overlay'"), true)
check('client exports the plugin settings card seat', clientSource.includes('settings.plugin.item'), true)
check('client bundle requests only baseline modules', /require\((?!'react')/.test(clientSource), false)
check('manifest declares the client bundle', packageJson.exports['./client'], './lib/client.js')
check('manifest declares the loader patch', packageJson.dsh.bundle.patch, './cordis.patch.yml')
check('manifest targets the web platform', packageJson.dsh.client.platform, 'web')

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
      (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
  )
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
