/**
 * dsh-plugin-ollama-usage — Host half.
 *
 * Owns three things, and nothing else:
 *
 * 1. This row's own configuration (`baseURL` / `credentialMode` / `apiKeyEnv`), declared as the
 *    `Config` schema dsh 0.2 reads off the loader entry itself.
 * 2. The credential seam reads and writes. Writes go to a plugin-owned reference
 *    (`OLLAMA_USAGE_API_KEY`) and nowhere else — this half has no API that accepts a
 *    foreign reference, so it cannot overwrite a provider's shared key by construction.
 * 3. One account-usage read against `GET {baseURL}/api/usage`, and the one HTTP route the
 *    browser half talks to (owned by this row, fenced by `connection.requestRejection`).
 *
 * It imports exactly one `@deepseek-ai/*` module: **schemastery**, the schema factory. On dsh 0.1.x
 * this half was deliberately dependency-free and handed `ctx.settings.register(ns, schema)` a
 * hand-rolled callable carrying `toJSON()`. That API was removed in 0.2, and the replacement cannot
 * be hand-rolled either: the settings service requires a **real** schemastery schema —
 * `volatileForm()` reads `schema.meta.volatile`, `schema(entry)` requires `toJSON`
 * (`dsh-settings/lib/index.js:103-131`, `:538-541`) — so the schema factory is now a hard peer
 * (`package.json` → `peerDependencies`). Every other capability is still reached through the
 * composition's own seams: `settings`, `credentials`, `connection`, `webServer`.
 *
 * @module dsh-plugin-ollama-usage
 */
import z from '@deepseek-ai/schemastery'

/** Stable plugin name (also the loader row's module id). */
export const name = 'dsh-plugin-ollama-usage'

/**
 * Settings namespace. In dsh 0.2 this is not a name the plugin picks: the namespace **is** this
 * row's loader id, which `cordis.patch.yml` inserts as `- id: ollama-usage` and which
 * `settings.describe()` reports back as `ns`. `settings.update(ns, …)` addresses that same id.
 */
const NS = 'ollama-usage'

/** Named-route prefix this half owns on the composition's `webServer`. */
const ROUTE_PREFIX = '/ollama-usage'

/** Every endpoint reachable under {@link ROUTE_PREFIX}; anything else is a 404. */
const ENDPOINTS = new Set([
  'config/read',
  'config/save',
  'credential/describe',
  'credential/set',
  'credential/unset',
  'usage/read',
])

/** Request bodies are small JSON objects; anything larger is refused unread. */
const MAX_BODY_BYTES = 64 * 1024

const DEFAULT_BASE_URL = 'https://ollama.com'
const DEFAULT_API_KEY_ENV = 'OLLAMA_API_KEY'

/** The reference this plugin owns. Never shared with a provider. */
const DIRECT_REF = 'OLLAMA_USAGE_API_KEY'

const MODE_REFERENCE = 'reference'
const MODE_DIRECT = 'direct'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_USAGE_BYTES = 1_048_576
const WINDOW_KEYS = ['session', 'weekly', 'monthly']

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')

function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = error.message
  if (typeof message === 'string' && message.length > 0) return message
  return String(error)
}

function normalizeMode(value) {
  return text(value) === MODE_DIRECT ? MODE_DIRECT : MODE_REFERENCE
}
function normalizeBaseURL(value) {
  const raw = text(value).replace(/\/+$/, '')
  return raw.length === 0 ? DEFAULT_BASE_URL : raw
}
function normalizeApiKeyRef(value) {
  const raw = text(value)
  return raw.length === 0 ? DEFAULT_API_KEY_ENV : raw
}
function baseURLProblem(value) {
  const raw = text(value)
  if (raw.length === 0) return 'baseURL 不能为空'
  if (!/^https?:\/\/[^\s/?#]+/i.test(raw)) return 'baseURL 必须以 http:// 或 https:// 开头并包含主机名'
  return undefined
}
function apiKeyRefProblem(value) {
  const raw = text(value)
  if (raw.length === 0) return 'apiKeyEnv 不能为空'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return 'apiKeyEnv 只能包含字母、数字、下划线，且不能以数字开头'
  return undefined
}

/**
 * This row's `Config` — the schema the settings service reads off the loader entry
 * (`dsh-settings/lib/index.js:538-541`: `entry.fiber.runtime.Config`) and the one the loader
 * validates this row's `config:` against. In dsh 0.2 the namespace **is** the row id and the
 * schema **is** this export, so the values live in the profile patch
 * (`~/.dsh/profiles/<profile>/cordis.patch.yml`) instead of the removed `settings.yaml`.
 *
 * Every field is `.volatile()`: `volatileForm()` returns `undefined` for a schema without one, and
 * `describe()` then **skips the entry entirely**, after which every write is refused with
 * `Plugin entry "ollama-usage" has no volatile fields`. That is exactly how this plugin died on
 * 0.2.0-rc.1. All three fields are leaves of a flat object root, so per-leaf markers are the correct
 * shape: `isVolatilePath()` stops at the first volatile node (which is why a nested dict would have
 * to carry the marker itself), and `validateVolatileSchema` rejects a volatile field *inside* a
 * volatile one — there is nothing to nest here.
 *
 * `credentialMode` is a union rather than a plain string so the generated form offers the two modes
 * as a choice and a hand-written junk value fails activation loudly instead of being silently
 * rewritten; {@link resolveConfig} still normalises whatever reaches this half, so no request
 * depends on the schema having been the gate.
 */
export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL).description('Ollama API base URL').volatile(),
  credentialMode: z
    .union([MODE_REFERENCE, MODE_DIRECT])
    .default(MODE_REFERENCE)
    .description('reference = reuse an existing apiKeyEnv read-only; direct = a key owned by this plugin')
    .volatile(),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).description('referenced only in reference mode').volatile(),
})

/**
 * Read one `Config` field as plain data.
 *
 * A `.volatile()` field resolves to a stable reference that only `get()` exposes — that indirection
 * is what lets a live edit reach an already-running plugin — while the very same field read back
 * from `settings.describe()` is already plain JSON. Unwrapping at every read keeps the rest of this
 * module on plain data, and duck-typing `get` avoids a dependency on cosmokit's `isVolatile`
 * (schemastery exports only its default).
 *
 * @param value - a resolved `Config` field, wrapped or plain.
 * @returns the plain value.
 */
function unwrapField(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * Resolve one configuration layer into the three values this half consumes, normalised.
 *
 * Three shapes reach this function and all three must work: `apply`'s own `config` argument carries
 * volatile references, `settings.describe().value` is plain JSON projected through the form schema,
 * and a missing service, a half-written patch or a value that never passed through schemastery can
 * leave any field absent. The normalisation the old hand-rolled schema used to do at registration
 * lives here now — at the point of consumption, which is the only place it can still be relied on.
 *
 * @param value - a config layer: the row's `config`, or a `describe()` entry's `value`.
 * @returns `{ baseURL, credentialMode, apiKeyEnv }`, never `undefined`.
 */
function resolveConfig(value) {
  const source = isRecord(value) ? value : {}
  return {
    baseURL: normalizeBaseURL(unwrapField(source.baseURL)),
    credentialMode: normalizeMode(unwrapField(source.credentialMode)),
    apiKeyEnv: normalizeApiKeyRef(unwrapField(source.apiKeyEnv)),
  }
}

/**
 * The usage endpoint. Ollama's native API base already ends in `/api`; accepting either
 * spelling means the documented default (`https://ollama.com`) and the API base
 * (`https://ollama.com/api`) both work.
 */
function usageURL(baseURL) {
  const trimmed = normalizeBaseURL(baseURL)
  const apiBase = /\/api$/i.test(trimmed) ? trimmed : `${trimmed}/api`
  return `${apiBase}/usage`
}

/** Which credential reference the current configuration resolves through. */
function effectiveRef(value) {
  return value.credentialMode === MODE_DIRECT ? DIRECT_REF : value.apiKeyEnv
}

function describeOwn(settings) {
  const list = settings.describe()
  if (!Array.isArray(list)) return undefined
  for (const entry of list) {
    if (isRecord(entry) && entry.ns === NS) return entry
  }
  return undefined
}

/**
 * Read this row's configuration as the browser needs it: resolved value, revision, effective
 * reference.
 *
 * The live settings document outranks the loader row's own layer: `describe()` re-reads the profile
 * patch, so a value that landed through this half's own save — or a hand edit of the patch under HMR
 * — reaches the next request without waiting for a recomposition. The row layer is the fallback, not
 * a duplicate: it is what still answers when the settings service is absent or when it does not list
 * this entry (the entry only appears there once this module exports a volatile `Config`).
 *
 * @param ctx - plugin context.
 * @param rowConfig - `apply`'s own config argument, wrapped or plain.
 * @returns the JSON-safe view the card renders.
 */
function configView(ctx, rowConfig) {
  const value = resolveConfig(rowConfig)
  const fallback = {
    available: false,
    registered: false,
    writable: false,
    value,
    revision: null,
    ref: effectiveRef(value),
    endpoint: usageURL(value.baseURL),
    error: 'settings service unavailable',
  }
  const settings = ctx.settings
  if (settings === undefined) return fallback
  let descriptor
  try {
    descriptor = describeOwn(settings)
  } catch (error) {
    return { ...fallback, available: true, error: errorMessage(error) }
  }
  if (descriptor === undefined) {
    return { ...fallback, available: true, error: `settings entry "${NS}" is not configurable` }
  }
  const live = resolveConfig(descriptor.value)
  return {
    available: true,
    registered: true,
    writable: settings.writable === true,
    value: live,
    revision: typeof descriptor.revision === 'number' ? descriptor.revision : null,
    ref: effectiveRef(live),
    endpoint: usageURL(live.baseURL),
    error: null,
  }
}

async function saveConfig(ctx, patchSource, expectedRevision, rowConfig) {
  const settings = ctx.settings
  if (settings === undefined) return { ok: false, error: { code: 'unavailable', message: 'settings service unavailable' } }
  const source = isRecord(patchSource) ? patchSource : {}
  const nextMode = normalizeMode(source.credentialMode)
  const nextBase = text(source.baseURL)
  const nextRef = text(source.apiKeyEnv)
  const fields = []
  const baseProblem = baseURLProblem(nextBase)
  if (baseProblem !== undefined) fields.push({ field: 'baseURL', message: baseProblem })
  if (nextMode === MODE_REFERENCE) {
    const refProblem = apiKeyRefProblem(nextRef)
    if (refProblem !== undefined) fields.push({ field: 'apiKeyEnv', message: refProblem })
  }
  if (fields.length > 0) {
    return { ok: false, error: { code: 'invalid', message: fields.map((item) => item.message).join('；'), fields } }
  }
  const patch = { baseURL: normalizeBaseURL(nextBase), credentialMode: nextMode }
  if (nextMode === MODE_REFERENCE) patch.apiKeyEnv = normalizeApiKeyRef(nextRef)
  const expected = typeof expectedRevision === 'number' && Number.isFinite(expectedRevision) ? expectedRevision : undefined
  try {
    // `update` merges the patch into this row's `config:` in the profile patch and re-runs
    // `describe()` before returning, so the view below already reflects the write. `NS` is the row
    // id — a namespace the plugin chose would be refused with `No configurable plugin entry "…"`.
    await settings.update(NS, patch, expected)
  } catch (error) {
    const label = typeof error.name === 'string' ? error.name : ''
    const message = errorMessage(error)
    const conflict = label === 'SettingsConflictError' || message.includes('changed since it was read')
    return { ok: false, error: { code: conflict ? 'conflict' : 'failed', message } }
  }
  const view = configView(ctx, rowConfig)
  return { ok: true, value: view.value, revision: view.revision, ref: view.ref }
}

/**
 * `describe` never returns a value, which is what lets the card show "configured / writable"
 * without the secret ever crossing to the browser.
 */
async function credentialView(ctx, refOverride, rowConfig) {
  const view = configView(ctx, rowConfig)
  const requested = text(refOverride).length > 0 ? text(refOverride) : view.ref
  const normalized = view.value.credentialMode === MODE_DIRECT ? DIRECT_REF : normalizeApiKeyRef(requested)
  const result = {
    mode: view.value.credentialMode,
    ref: normalized,
    owned: normalized === DIRECT_REF,
    configured: false,
    writable: false,
    source: null,
    error: null,
  }
  const credentials = ctx.credentials
  if (credentials === undefined) return { ...result, error: 'credentials service unavailable' }
  try {
    const info = await credentials.describe(normalized)
    if (!isRecord(info)) return result
    return {
      ...result,
      configured: info.configured === true,
      writable: info.writable === true,
      source: typeof info.source === 'string' ? info.source : null,
    }
  } catch (error) {
    return { ...result, error: errorMessage(error) }
  }
}

/**
 * Write the plugin-owned key. There is intentionally no `ref` parameter: a caller cannot
 * aim this at another plugin's reference.
 */
async function setOwnCredential(ctx, value, rowConfig) {
  const credentials = ctx.credentials
  if (credentials === undefined) return { ok: false, error: { code: 'unavailable', message: 'credentials service unavailable' } }
  const view = configView(ctx, rowConfig)
  if (view.value.credentialMode !== MODE_DIRECT) {
    return { ok: false, error: { code: 'wrong-mode', message: '仅在密钥模式下才能保存本插件专属密钥' } }
  }
  const secret = typeof value === 'string' ? value.trim() : ''
  if (secret.length === 0) return { ok: false, error: { code: 'empty', message: '密钥不能为空' } }
  try {
    await credentials.set(DIRECT_REF, secret)
  } catch (error) {
    return { ok: false, error: { code: 'failed', message: errorMessage(error) } }
  }
  const info = await credentialView(ctx, undefined, rowConfig)
  return { ok: true, ref: DIRECT_REF, configured: info.configured, writable: info.writable, source: info.source }
}

async function clearOwnCredential(ctx, rowConfig) {
  const credentials = ctx.credentials
  if (credentials === undefined) return { ok: false, error: { code: 'unavailable', message: 'credentials service unavailable' } }
  try {
    await credentials.unset(DIRECT_REF)
  } catch (error) {
    return { ok: false, error: { code: 'failed', message: errorMessage(error) } }
  }
  const info = await credentialView(ctx, undefined, rowConfig)
  return { ok: true, ref: DIRECT_REF, configured: info.configured, writable: info.writable }
}

function isoInstant(value) {
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}
function firstPresent(record, keys) {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}
function parseWindow(value, now) {
  if (!isRecord(value)) return undefined
  const usage = value.usage
  if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) return undefined
  const models = []
  if (Array.isArray(value.models)) {
    for (const entry of value.models) {
      if (!isRecord(entry)) continue
      const modelName = typeof entry.name === 'string' ? entry.name : ''
      const count = entry.request_count
      if (modelName.length === 0) continue
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue
      models.push({ name: modelName, requestCount: count })
    }
  }
  let resetsAt = isoInstant(firstPresent(value, ['resets_at', 'reset_at', 'reset', 'resetsAt']))
  if (resetsAt === undefined) {
    const after = firstPresent(value, ['reset_after_seconds', 'resetAfterSeconds'])
    if (typeof after === 'number' && Number.isFinite(after) && after >= 0) {
      resetsAt = new Date(now + after * 1000).toISOString()
    }
  }
  return resetsAt === undefined ? { usage, models } : { usage, models, resetsAt }
}

/**
 * Decode the account snapshot, or `undefined` for anything unrecognised — the caller turns
 * that into a silent "nothing to show" rather than an error surface.
 */
function parseUsage(value) {
  if (!isRecord(value)) return undefined
  const limits = value.limits
  if (!isRecord(limits)) return undefined
  const now = Date.now()
  const usage = { fetchedAt: new Date(now).toISOString() }
  let found = 0
  for (const key of WINDOW_KEYS) {
    const window = parseWindow(limits[key], now)
    if (window === undefined) continue
    usage[key] = window
    found += 1
  }
  return found === 0 ? undefined : usage
}

/**
 * Read one account snapshot.
 *
 * The API key travels only on this Host-to-Ollama hop. Nothing about the failure path can
 * echo it: errors carry a status code or a message the endpoint itself produced, never the
 * request headers.
 *
 * @returns `{ status: 'ok', usage }`, `{ status: 'unsupported' }` for an endpoint without a
 *   usage surface (404), or `{ status: 'none' }` for every other reason — including "not
 *   configured", which is not an error.
 */
async function readUsage(ctx, rowConfig) {
  const view = configView(ctx, rowConfig)
  const credentials = ctx.credentials
  if (credentials === undefined) return { status: 'none' }
  let resolved
  try {
    resolved = await credentials.resolve(view.ref)
  } catch {
    return { status: 'none' }
  }
  const apiKey = isRecord(resolved) && typeof resolved.value === 'string' ? resolved.value : ''
  if (apiKey.trim().length === 0) return { status: 'none' }
  let response
  try {
    response = await fetch(view.endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return { status: 'none' }
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return { status: 'unsupported' }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { status: 'none' }
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_USAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { status: 'none' }
  }
  let body
  try {
    body = await response.text()
  } catch {
    return { status: 'none' }
  }
  if (body.length > MAX_USAGE_BYTES) return { status: 'none' }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: 'none' }
  }
  const usage = parseUsage(parsed)
  return usage === undefined ? { status: 'none' } : { status: 'ok', usage }
}

const ok = (value) => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message } })

/**
 * One request from this plugin's browser half. The envelope keeps the shape the connection
 * service used to carry — `{ ok: true, value }` / `{ ok: false, error: { code, message } }` —
 * so the browser half's decode logic stays one shape.
 */
async function handleRequest(ctx, endpoint, payload, rowConfig) {
  const input = isRecord(payload) ? payload : {}
  switch (endpoint) {
    case 'config/read':
      return ok(configView(ctx, rowConfig))
    case 'config/save':
      return ok(await saveConfig(ctx, input.patch, input.expectedRevision, rowConfig))
    case 'credential/describe':
      return ok(await credentialView(ctx, input.ref, rowConfig))
    case 'credential/set':
      return ok(await setOwnCredential(ctx, input.value, rowConfig))
    case 'credential/unset':
      return ok(await clearOwnCredential(ctx, rowConfig))
    case 'usage/read':
      return ok(await readUsage(ctx, rowConfig))
    default:
      return fail('unknown-endpoint', `unknown ollama-usage endpoint: ${String(endpoint)}`)
  }
}

/**
 * Required services.
 *
 * `inject` is not decoration: the framework hands a plugin a capability-scoped context
 * proxy, and reading a service this module did not declare is *denied* — `ctx.settings`
 * throws, `ctx.get('settings')` silently yields `undefined`.
 *
 * `webServer` is this half's route carrier (`register`), and `connection` is the trust fence
 * the route asks before every answer (`requestRejection`) — the same two services the shipped
 * `dsh-host-open-in-app` row injects. A `connection.rpc` channel would instead register its
 * physical route on the *connection row's* context and force the shipped row to be widened by a
 * patch; owning the route removes that coupling (`.trellis/spec/.../halves-contract.md`,
 * "Channel or own route").
 */
export const inject = ['settings', 'credentials', 'connection', 'webServer']


/** JSON response, never cached: configuration, credentials and usage are live facts. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Apply the composition's trust fence before anything else, exactly as the shipped
 * `dsh-host-open-in-app` routes do: `connection.requestRejection` owns the Host/Origin check
 * (403) and the browser-session cookie gate (401).
 *
 * Fails *closed*: a composition without that seam answers 503, so this route can never serve
 * configuration, credentials or usage unauthenticated.
 *
 * @param ctx - plugin context; `connection` is injected by this row.
 * @param req - the incoming request (only its headers are read).
 * @param res - response owned here when the request is rejected.
 * @returns true when a rejection was written and the handler must stop.
 */
function rejected(ctx, req, res) {
  const connection = ctx.connection
  if (typeof connection.requestRejection !== 'function') {
    console.error('[ollama-usage] trust fence unavailable: refusing to serve')
    res.writeHead(503)
    res.end('trust fence unavailable')
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection)
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/**
 * Read one bounded JSON object body.
 *
 * @param req - the incoming request stream.
 * @returns the payload object (`{}` for an empty body), rejecting on an oversized or non-JSON
 *   body so the caller can answer 400 instead of guessing.
 */
function readPayload(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => reject(new Error('body could not be read')))
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(isRecord(parsed) ? parsed : {})
      } catch {
        reject(new Error('body is not a JSON object'))
      }
    })
  })
}

/**
 * The endpoint segment of the request path, decoded.
 *
 * @param req - the incoming request.
 * @returns the endpoint name, or an empty string when the path carries none.
 */
function endpointOf(req) {
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return ''
    return decodeURIComponent(pathname.slice(ROUTE_PREFIX.length + 1))
  } catch {
    return ''
  }
}

/**
 * The one route handler: fence first, then the method, the media type, the endpoint and the
 * body. The endpoint travels in the path, so `POST /ollama-usage/config/read` is the read.
 *
 * @param ctx - plugin context.
 * @param req - the incoming request.
 * @param res - response owned by this handler.
 * @param rowConfig - the loader row's config, re-read per request (a `.volatile()` field stays live).
 */
async function routeHandler(ctx, req, res, rowConfig) {
  if (rejected(ctx, req, res)) return
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const mediaType = text(req.headers === undefined ? '' : req.headers['content-type']).split(';')[0]
  if (mediaType !== 'application/json') {
    sendJson(res, 415, fail('unsupported-media-type', 'content-type must be application/json'))
    return
  }
  const endpoint = endpointOf(req)
  if (!ENDPOINTS.has(endpoint)) {
    sendJson(res, 404, fail('unknown-endpoint', `unknown ollama-usage endpoint: ${String(endpoint)}`))
    return
  }
  let payload
  try {
    payload = await readPayload(req)
  } catch (error) {
    sendJson(res, 400, fail('bad-request', errorMessage(error)))
    return
  }
  sendJson(res, 200, await handleRequest(ctx, endpoint, payload, rowConfig))
}

/**
 * Mount this half's one route.
 *
 * There is deliberately nothing to register with the settings service: in dsh 0.2 the namespace
 * **is** this loader row's id and the schema **is** the exported `Config`, which the service reads
 * off the entry itself (`dsh-settings/lib/index.js:538-541`). The old
 * `ctx.settings.register(NS, schema)` call is gone — on 0.2.0-rc.1 it threw
 * `TypeError: ctx.settings.register is not a function`, which the loader reports, isolates to this
 * row, and otherwise swallows: the plugin simply stopped existing.
 *
 * @param ctx - plugin context; `settings`, `credentials`, `connection` and `webServer` are injected.
 * @param config - this row's config, with any `.volatile()` field still wrapped.
 */
export function apply(ctx, config) {
  // Kept as the layer `settings.describe()` is read *above*, not resolved once here: keeping the
  // volatile references means a live edit is visible even on the fallback path (see `configView`).
  const rowConfig = config

  // A route that cannot register (a duplicate (kind, path)) must degrade to "no UI surface" rather
  // than lose the rest of the plugin. Measured on 0.2.0-rc.1: a throwing row does **not** fail the
  // plugin tree — it is isolated, and the only trace is one line in the boot log, which is the worst
  // possible failure mode. Degrading loudly here beats being silently absent.
  try {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => routeHandler(ctx, req, res, rowConfig),
      }),
      'ollama-usage: route',
    )
  } catch (error) {
    console.error(`[ollama-usage] route unavailable: ${errorMessage(error)}`)
  }
}
