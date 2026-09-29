/**
 * Self-contained checks for both halves. No test runner, no dependencies:
 *
 *   node test/host.test.mjs
 *
 * The Host half is mounted against a fake cordis context and asserted on behaviour — the settings
 * contract it satisfies, the route it exposes, the credential writes it refuses, and the silent
 * empty states. The client half is asserted structurally, because its correctness there is a
 * packaging contract (loader wrapper + the three slot seats).
 *
 * The fake settings service below is the **real 0.2 surface** (`describe` / `update` / `writable`).
 * It used to hand-write `register(ns, schema)` — a method dsh 0.2 deleted — and to feed that own
 * schema back through `describe()`, which is exactly how 44 green assertions sat over a plugin whose
 * settings registration threw on the first line of `apply` and therefore never mounted its route.
 * Two anti-false-green guards now cover that class of failure: the source must not call the removed
 * method, and the exported `Config` must satisfy the rules the settings service applies to it.
 */
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'

const hostUrl = new URL('../lib/index.js', import.meta.url)
const clientUrl = new URL('../lib/client.js', import.meta.url)

const { apply, inject, name, Config } = await import(hostUrl.href)

// ── the contract dsh 0.2 enforces on a plugin Config ────────────────────────────────────
//
// Replicated from the installed `dsh-settings/lib/index.js` over this module's **real** serialized
// schema: `volatileForm()` (`:122-131`) returns `undefined` for a schema with no volatile field, and
// `describe()` then skips the entry entirely (`:417-419`) while every write is refused with
// `Plugin entry "…" has no volatile fields` (`:505-507`). Removing a `.volatile()` marker, or
// nesting one volatile field inside another (`validateVolatileSchema`), turns this suite red instead
// of silently disabling the whole configuration surface.
const schema = Config.toJSON()
const schemaNode = (uid) => schema.refs[String(uid)]
const rootNode = schemaNode(schema.uid)
const isVolatileNode = (value) => value?.meta?.volatile === true
/** `volatileForm`: the root itself, or at least one volatile field directly under an object root. */
const hasVolatileForm = (value) => {
  if (isVolatileNode(value)) return true
  if (value?.type !== 'object') return false
  return Object.values(value.dict ?? {}).some((uid) => isVolatileNode(schemaNode(uid)))
}
/** `isVolatilePath`: a path is editable once its first volatile ancestor covers it. */
const isVolatilePath = (value, path) => {
  if (isVolatileNode(value)) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : value?.dict?.[key]
  return child !== undefined && isVolatilePath(schemaNode(child), rest)
}
/** The published form carries no volatile markers (`plainSchema`, `:103-117`); only its shape matters here. */
const stripVolatile = (value) => {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value === null || typeof value !== 'object') return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'meta') {
      result[key] = stripVolatile(child)
      continue
    }
    const meta = { ...child }
    delete meta.volatile
    result.meta = meta
  }
  return result
}
/** A `.volatile()` field resolves to a stable reference read with `get()`; `describe()` hands back plain JSON. */
const resolvedField = (value, key) => {
  const field = value[key]
  return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field
}
const resolvedConfig = (value) => Object.fromEntries(
  ['baseURL', 'credentialMode', 'apiKeyEnv'].map((key) => [key, resolvedField(value, key)]),
)

// ── the fake settings service (the real 0.2 surface) ────────────────────────────────────

/**
 * The live settings document. `ns` is the loader row id — the plugin does not choose it, and it is
 * what the row's `config:` in `cordis.patch.yml` is keyed by.
 */
const document = {
  revision: 3,
  value: { baseURL: 'https://ollama.com', credentialMode: 'reference', apiKeyEnv: 'OLLAMA_API_KEY' },
}
const settingsCalls = []
const seen = { route: null, handler: null }
const credentialCalls = []

const services = {
  settings: {
    writable: true,
    /** Set by a test to make the next `update` fail the way the real service can. */
    failWith: undefined,
    describe() {
      // `value` is plain JSON projected through the form schema; `schema` is the marker-free form.
      return [{
        ns: 'ollama-usage',
        value: { ...document.value },
        revision: document.revision,
        user: {},
        schema: stripVolatile(schema),
      }]
    },
    async update(ns, patch, expectedRevision) {
      settingsCalls.push({ ns, patch, expectedRevision })
      if (services.settings.failWith !== undefined) throw services.settings.failWith
      document.value = { ...document.value, ...patch }
      document.revision += 1
    },
  },
  // The trust fence: the route asks it first and serves only when it answers `undefined`.
  connection: { requestRejection: () => undefined },
  credentials: {
    async resolve() {
      return document.value.credentialMode === 'direct' ? { value: 'sk-x', source: 'file' } : undefined
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
  webServer: {
    register(route) {
      seen.route = route
      seen.handler = route.handler
      return () => undefined
    },
  },
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

/** A request stream carrying `body`, the way `node:http` hands one to a route. */
function makeReq({ method = 'POST', url = '/ollama-usage/config/read', body, headers = {} } = {}) {
  const encoded = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const req = Readable.from(encoded === '' ? [] : [Buffer.from(encoded, 'utf8')])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', ...headers }
  return req
}

/** A response the route can own: it only calls `writeHead` and `end`. */
function makeRes() {
  const res = { status: 0, headers: {}, body: undefined }
  res.writeHead = (status, headers) => {
    res.status = status
    Object.assign(res.headers, headers ?? {})
  }
  res.end = (body) => {
    res.body = body
  }
  return res
}

const parseBody = (body) => {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * One request through the registered route.
 *
 * @param endpoint - the endpoint segment, or anything else to probe a 404.
 * @param payload - the JSON body object.
 * @param options - `method`, `headers`, `body` (raw override), `rejection` (what the
 *   composition's fence answers for this one call) and `handler` (a route other than the
 *   primary mount's).
 * @returns status, headers, raw body and the parsed envelope.
 */
async function callRaw(endpoint, payload, options = {}) {
  const previous = services.connection.requestRejection
  if (options.rejection !== undefined) services.connection.requestRejection = () => options.rejection
  try {
    const res = makeRes()
    const url = options.url ?? `/ollama-usage/${endpoint}`
    const body = 'body' in options ? options.body : payload
    await (options.handler ?? seen.handler)(makeReq({ method: options.method, url, body, headers: options.headers }), res)
    return { status: res.status, headers: res.headers, body: res.body, parsed: parseBody(res.body) }
  } finally {
    services.connection.requestRejection = previous
  }
}

/** The envelope of one request: the shape every assertion below consumes. */
const call = async (endpoint, payload, options) => (await callRaw(endpoint, payload, options)).parsed

/**
 * `apply`'s own `config` argument carries **volatile references**, while `describe().value` is plain
 * JSON. The row layer below is handed in wrapped on purpose, so the tolerant read path is measured
 * rather than assumed: losing the unwrapping helper turns the fallback assertions red.
 */
const volatile = (value) => ({ get: () => value })
const rowConfig = {
  baseURL: volatile('https://row.example/'),
  credentialMode: volatile('direct'),
  apiKeyEnv: volatile('ROW_LAYER_KEY'),
}

apply(ctx, rowConfig)

// --- Host half: registration ------------------------------------------------------------
check('plugin name', name, 'dsh-plugin-ollama-usage')
// Regression guard for the bug that kept the whole plugin inert: the capability-scoped
// context proxy denies undeclared services, so a missing `inject` export means the plugin
// mounts, registers nothing, and reports nothing.
check('declares every required service', inject, ['settings', 'credentials', 'connection', 'webServer'])
check('route registration', [seen.route?.kind, seen.route?.path], ['prefix', '/ollama-usage'])

// --- Host half: the Config contract ------------------------------------------------------
// Defaults resolve for a row with no `config:` at all (which is what a fresh install has: the
// bundle patch inserts `- id: ollama-usage` / `name: …` and nothing else).
check('config defaults resolve for an empty row config', resolvedConfig(Config(undefined)), {
  baseURL: 'https://ollama.com',
  credentialMode: 'reference',
  apiKeyEnv: 'OLLAMA_API_KEY',
})
check('config defaults resolve for a partial row config', resolvedConfig(Config({ baseURL: 'https://ollama.test/' })).baseURL, 'https://ollama.test/')
check('config serialises for the settings form', typeof schema, 'object')
// The schema must be the **real** schemastery: `dsh-settings` reads `meta.volatile` off it and the
// cordis loader validates the row's `config` through `Config["~standard"]`. A hand-rolled impostor
// carrying a `toJSON()` is what this package shipped with before, and it is what the 0.2 gate
// rejected. Optional chaining on purpose: an impostor without `~standard` must **fail** this
// assertion, not crash the harness before it can report one.
check('config is a schemastery schema, not a hand-rolled lookalike', Config['~standard']?.vendor, 'schemastery')
// The three defaults, read out of the serialized schema the settings service introspects.
check('the serialised schema carries all three defaults',
  ['baseURL', 'credentialMode', 'apiKeyEnv'].map((key) => schemaNode(rootNode.dict[key]).meta.default),
  ['https://ollama.com', 'reference', 'OLLAMA_API_KEY'])
// The guard for the failure this plugin actually shipped with on 0.2.0-rc.1.
check('config: the settings service can build a form from this schema', hasVolatileForm(rootNode), true)
check('config: every field is writable', ['baseURL', 'credentialMode', 'apiKeyEnv'].map((key) => isVolatilePath(rootNode, [key])), [true, true, true])
// A flat object root, so per-leaf markers are the right shape and nothing is nested: a volatile
// field inside a volatile node is rejected by `validateVolatileSchema`.
check('config: the root itself is not volatile', isVolatileNode(rootNode), false)
check('config: no field hides a nested volatile marker',
  Object.values(rootNode.dict).every((uid) => {
    const field = schemaNode(uid)
    return isVolatileNode(field) && !Object.values(field.dict ?? {}).some((inner) => isVolatileNode(schemaNode(inner)))
  }), true)

// --- Host half: config over the route ----------------------------------------------------
const read = await call('config/read', {})
check('config/read ok', [read.ok, read.value.registered, read.value.ref, read.value.revision], [true, true, 'OLLAMA_API_KEY', 3])
check('endpoint derived from baseURL', read.value.endpoint, 'https://ollama.com/api/usage')

// The live document is normalised where it is consumed: the old hand-rolled schema used to do this
// at registration, and that hook no longer exists.
document.value = { baseURL: 'https://x.test/', credentialMode: 'nope', apiKeyEnv: '  ' }
const junk = await call('config/read', {})
check('config/read normalises junk from the live document', junk.value.value, {
  baseURL: 'https://x.test',
  credentialMode: 'reference',
  apiKeyEnv: 'OLLAMA_API_KEY',
})
check('the normalised value drives the endpoint and the reference', [junk.value.endpoint, junk.value.ref], ['https://x.test/api/usage', 'OLLAMA_API_KEY'])
document.value = { baseURL: 'https://ollama.com', credentialMode: 'reference', apiKeyEnv: 'OLLAMA_API_KEY' }

// `describe()` failing must not take the configuration surface down: the loader row's own layer
// answers instead — through the volatile wrappers, which is why this assertion is the falsification
// of the unwrapping helper.
const liveDescribe = services.settings.describe
services.settings.describe = () => { throw new Error('settings document unavailable') }
const degraded = await call('config/read', {})
services.settings.describe = liveDescribe
check('a failed live read falls back to the row config layer',
  [degraded.value.value, degraded.value.endpoint, degraded.value.ref, degraded.value.available, degraded.value.registered, degraded.value.error],
  [{ baseURL: 'https://row.example', credentialMode: 'direct', apiKeyEnv: 'ROW_LAYER_KEY' },
    'https://row.example/api/usage', 'OLLAMA_USAGE_API_KEY', true, false, 'settings document unavailable'])

// --- Host half: the write path ----------------------------------------------------------
const saved = await call('config/save', { patch: { baseURL: 'https://saved.test', credentialMode: 'reference', apiKeyEnv: 'SAVED_KEY' }, expectedRevision: 3 })
check('config/save answers with the written value', [saved.value.ok, saved.value.value, saved.value.revision], [
  true,
  { baseURL: 'https://saved.test', credentialMode: 'reference', apiKeyEnv: 'SAVED_KEY' },
  4,
])
// `ns` is the loader row id — a namespace the plugin picked would be refused with
// `No configurable plugin entry "…"`, which is the second half of the 0.2 contract.
check('a save is addressed to the row id, with the revision it read',
  [settingsCalls[0].ns, settingsCalls[0].expectedRevision, settingsCalls[0].patch],
  ['ollama-usage', 3, { baseURL: 'https://saved.test', credentialMode: 'reference', apiKeyEnv: 'SAVED_KEY' }])
const invalid = await call('config/save', { patch: { baseURL: 'not a url', credentialMode: 'reference' }, expectedRevision: 4 })
check('an invalid patch is refused before any write', [invalid.value.ok, invalid.value.error.code, invalid.value.error.fields[0].field], [false, 'invalid', 'baseURL'])
check('the refused patch never reached the settings service', settingsCalls.length, 1)
services.settings.failWith = Object.assign(new Error('changed since it was read'), { name: 'SettingsConflictError' })
const conflicted = await call('config/save', { patch: { baseURL: 'https://other.test', credentialMode: 'reference', apiKeyEnv: 'OLLAMA_API_KEY' }, expectedRevision: 4 })
services.settings.failWith = undefined
check('a stale revision surfaces as a conflict', [conflicted.value.ok, conflicted.value.error.code], [false, 'conflict'])
document.value = { baseURL: 'https://ollama.com', credentialMode: 'reference', apiKeyEnv: 'OLLAMA_API_KEY' }
document.revision = 3

// --- Host half: credential confinement --------------------------------------------------
document.value.credentialMode = 'reference'
const refused = await call('credential/set', { value: 'sk-secret' })
check('credential/set refuses in reference mode', [refused.value.ok, refused.value.error.code], [false, 'wrong-mode'])
check('nothing written in reference mode', credentialCalls.length, 0)

document.value.credentialMode = 'direct'
const accepted = await call('credential/set', { value: 'sk-secret' })
check('credential/set writes in direct mode', accepted.value.ok, true)
check('write went to the plugin-owned ref', credentialCalls[0].ref, 'OLLAMA_USAGE_API_KEY')
check('no foreign ref ever written', credentialCalls.every((call) => call.ref === 'OLLAMA_USAGE_API_KEY'), true)
const cleared = await call('credential/unset', {})
check('credential/unset clears the plugin-owned ref', [cleared.value.ok, credentialCalls.at(-1).ref], [true, 'OLLAMA_USAGE_API_KEY'])
document.value.credentialMode = 'reference'

// --- Host half: silent empty states (R5) ------------------------------------------------
const withCredentials = services.credentials
delete services.credentials
check('usage/read without credentials service', (await call('usage/read', {})).value, { status: 'none' })
services.credentials = withCredentials

services.credentials = { async resolve() { return undefined }, async describe() { return { configured: false, writable: false } } }
check('usage/read with an unconfigured credential', (await call('usage/read', {})).value, { status: 'none' })

services.credentials = { async resolve() { return { value: 'sk-x', source: 'file' } }, async describe() { return { configured: true, writable: true, source: 'file' } } }
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response('not found', { status: 404 })
check('usage/read against an endpoint without usage', (await call('usage/read', {})).value, { status: 'unsupported' })

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
const decoded = (await call('usage/read', {})).value
check('usage/read decodes status', decoded.status, 'ok')
check('usage/read decodes a window', decoded.usage.session, { usage: 0.259, models: [{ name: 'deepseek-v4.1-flash', requestCount: 505 }] })
check('usage/read keeps the present windows only', Object.keys(decoded.usage).sort(), ['fetchedAt', 'session', 'weekly'])
check('usage/read carries no key', JSON.stringify(decoded).includes('sk-x'), false)

globalThis.fetch = async () => new Response('<html>nope</html>', { status: 200 })
check('usage/read on a non-JSON body', (await call('usage/read', {})).value, { status: 'none' })
globalThis.fetch = realFetch

const unknown = await call('nope/nope', {})
check('unknown endpoint is a loud protocol error', [unknown.ok, unknown.error.code], [false, 'unknown-endpoint'])

// --- Host half: the fence, the method, the media type, the body --------------------------
const fenced401 = await callRaw('config/read', {}, { rejection: 401 })
const fenced403 = await callRaw('config/read', {}, { rejection: 403 })
const fence = services.connection.requestRejection
delete services.connection.requestRejection
const fenceless = await callRaw('config/read', {})
services.connection.requestRejection = fence
check('401 from the fence is answered verbatim', [fenced401.status, fenced401.body], [401, 'unauthorized'])
check('403 from the fence is answered verbatim', [fenced403.status, fenced403.body], [403, 'forbidden'])
check('a composition without the fence fails closed', [fenceless.status, fenceless.body], [503, 'trust fence unavailable'])

const wrongMethod = await callRaw('config/read', {}, { method: 'GET' })
check('a non-POST method is refused with the method it allows', [wrongMethod.status, wrongMethod.headers.allow], [405, 'POST'])
const wrongType = await callRaw('config/read', {}, { headers: { 'content-type': 'text/plain' } })
check('a non-JSON media type is refused', [wrongType.status, wrongType.parsed.error.code], [415, 'unsupported-media-type'])
const broken = await callRaw('config/read', {}, { body: '{ not json' })
check('a non-JSON body is a bad request', [broken.status, broken.parsed.error.code], [400, 'bad-request'])
const oversized = await callRaw('config/read', {}, { body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) })
check('an oversized body is a bad request', [oversized.status, oversized.parsed.error.code], [400, 'bad-request'])
const answered = await callRaw('config/read', {})
check('a good read is 200 JSON in the client envelope', [
  answered.status,
  answered.headers['content-type'],
  answered.parsed.ok,
], [200, 'application/json; charset=utf-8', true])
check('the answer is never cached', answered.headers['cache-control'], 'no-store')

// --- Host half: the source must not call the removed settings API ------------------------
const hostSource = await readFile(hostUrl, 'utf8')
// The comments name the removed calls on purpose — they are what explains the migration — so the
// guards below read the **code** only. A guard over the raw text would be satisfied by a comment.
const hostCode = hostSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('host half imports exactly the schema factory', [...new Set([...hostSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).filter((specifier) => specifier.startsWith('@')))],
  ['@deepseek-ai/schemastery'])
// `ctx.settings.register(ns, schema)` is what threw `TypeError: ctx.settings.register is not a
// function` at `lib/index.js:586` on 0.2.0-rc.1: a row-level failure the loader isolates and only
// reports in the boot log, so nothing else in this suite could have noticed.
check('the removed settings.register call is gone', /settings\s*\.\s*register\s*\(/.test(hostCode), false)
check('the removed installSection call is gone', /installSection/.test(hostCode), false)
check('the registry write that remains is the route', /webServer\s*\.\s*register\s*\(/.test(hostCode), true)

// --- Host half: apply on a composition that cannot configure this row --------------------
// Two real situations at once: a fresh install inserts the row with no `config:` key at all, and a
// profile may mount a settings service that does not list this entry. Activation and the route must
// survive both, answering with the schema defaults.
const bare = { handler: null }
const bareSettings = {
  writable: false,
  describe: () => [],
  update: async () => { throw new Error('no configurable plugin entry "ollama-usage"') },
}
const bareCtx = {
  settings: bareSettings,
  credentials: services.credentials,
  connection: services.connection,
  webServer: {
    register(route) {
      bare.handler = route.handler
      return () => undefined
    },
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => undefined
  },
  get: () => undefined,
}
let bareError = null
try {
  apply(bareCtx, undefined)
} catch (error) {
  bareError = error
}
check('apply does not throw with no row config at all', [bareError, typeof bare.handler], [null, 'function'])
const bareRead = (await callRaw('config/read', {}, { handler: bare.handler })).parsed
check('an entry the settings service does not list still answers with the schema defaults',
  [bareRead.value.value, bareRead.value.registered, bareRead.value.writable, bareRead.value.error],
  [{ baseURL: 'https://ollama.com', credentialMode: 'reference', apiKeyEnv: 'OLLAMA_API_KEY' },
    false, false, 'settings entry "ollama-usage" is not configurable'])

// --- Client half: packaging contract ---------------------------------------------------
const clientSource = await readFile(clientUrl, 'utf8')
// Comments legitimately name the seat that was removed (they explain the migration), so this guard
// reads the **code** — the same reason the host guards above strip comments.
const clientCode = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
check('client bundle registers a loader factory', clientSource.includes('window.__ModuleLoader__.load'), true)
check('client bundle id equals the package name', clientSource.includes(`id: '${packageJson.name}'`), true)
check('client bundle exports apply + inject', [clientSource.includes('exports.apply = apply'), clientSource.includes('exports.inject = inject')], [true, true])
check('client exports the composer dock seat', clientSource.includes('conversation.composer.dock'), true)
check('client exports the composer hero dock seat', clientSource.includes("'conversation.input.dock'"), true)
// `settings.plugin.item` — the keyed card seat of the old Plugins tab — does not exist anywhere in
// dsh 0.2.0-rc.1 (the only Settings seat is the `settings.section` list). A bundle that still waits
// for the removed seat mounts its card nowhere and reports nothing, so BOTH halves of this guard
// matter: the live seat must be used, and the dead one must not be.
check('client half uses the live settings seat, not the removed one',
  [clientCode.includes('settings.plugin.item'), clientCode.includes('settings.section')],
  [false, true])
check('client bundle requests only baseline modules', /require\((?!'react')/.test(clientSource), false)
check('manifest declares the client bundle', packageJson.exports['./client'], './lib/client.js')
check('manifest declares the loader patch', packageJson.dsh.bundle.patch, './cordis.patch.yml')
check('manifest targets the web platform', packageJson.dsh.client.platform, 'web')

// --- Manifest: the 0.2 gate, the peer, and the display metadata --------------------------
// dsh 0.2 gates `@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*` peer and **denies the row** when a
// declared range cannot be satisfied, while declaring nothing passes silently — which is how this
// plugin kept loading on a runtime whose settings API it could not use.
check('manifest: every gated peer is pinned to the 0.2 line',
  Object.entries(packageJson.peerDependencies)
    .filter(([peer]) => peer === '@deepseek-ai/dsh' || peer.startsWith('@deepseek-ai/dsh-'))
    .map(([, range]) => range),
  ['^0.2.0-rc.1'])
check('manifest: the schema factory is a declared peer', packageJson.peerDependencies['@deepseek-ai/schemastery'], '*')
check('manifest: the peer link step is declared', packageJson.scripts['link-imports'], 'node tools/link-imports.mjs')
check('manifest: display metadata ships with the plugin',
  [packageJson.icon, packageJson.exports['./locale/*.json'], packageJson.files.includes('locale'), packageJson.files.includes('icon.svg')],
  ['./icon.svg', './locale/*.json', true, true])
const localeZh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const localeEn = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))
// Non-empty, not merely "a string": `meta.title: ""` is exactly the kind of half-migration that
// leaves the card titled by a blank.
check('manifest: both display dictionaries carry a title and a description',
  [localeZh, localeEn].map((dictionary) => [dictionary.meta?.title?.length > 0, dictionary.meta?.description?.length > 0]),
  [[true, true], [true, true]])
// Reviewed when the host half gained its one peer: the bundle reads `slots`, `locale` and `timer`,
// and registers into the two dock seats (declared by ui-conversation) and the Settings navigation
// (ui-settings). It never reads `connection` — the wire to the host is a plain `fetch` to this row's
// own route — so that edge named a dependency the browser half does not have.
check('manifest: the client edges name what the bundle actually reads',
  packageJson.dsh.client.inject,
  ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings'])

// --- The row id is the settings namespace ------------------------------------------------
const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const rowIds = [...patchText.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)].map((match) => match[1])
// `settings.update(ns, …)` is addressed by the loader row id, and the live document reports the same
// string as `ns` — the two must not drift apart in either direction.
check('patch: inserts exactly this plugin row', rowIds, ['ollama-usage'])
check('patch: the row id is the ns every settings call uses', settingsCalls.every((entry) => entry.ns === rowIds[0]), true)
check('patch: widens no shipped row', /- id:\s*(connection|web|webServer)\b/.test(patchText), false)

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
      (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
  )
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
