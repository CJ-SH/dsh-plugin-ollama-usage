/**
 * dsh-plugin-ollama-usage — Host half.
 *
 * Owns three things, and nothing else:
 *
 * 1. Its own settings namespace `ollama-usage` (`baseURL` / `credentialMode` / `apiKeyEnv`).
 * 2. The credential seam reads and writes. Writes go to a plugin-owned reference
 *    (`OLLAMA_USAGE_API_KEY`) and nowhere else — this half has no API that accepts a
 *    foreign reference, so it cannot overwrite a provider's shared key by construction.
 * 3. One account-usage read against `GET {baseURL}/api/usage`, and the one HTTP route the
 *    browser half talks to (owned by this row, fenced by `connection.requestRejection`).
 *
 * Deliberately dependency-free: it imports no `@deepseek-ai/*` module. `settings` and
 * `credentials` are read with `ctx.get` (optional) and `ctx.inject` (soft), and the
 * settings schema is a plain callable object carrying `toJSON()` — the shape
 * `dsh-settings` actually consumes — instead of pulling in schemastery.
 *
 * @module dsh-plugin-ollama-usage
 */

/** Stable plugin name (also the loader row's module id). */
export const name = 'dsh-plugin-ollama-usage'

/** Settings namespace; also the key the browser card registers itself under. */
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
 * Resolve one settings section. Doubles as the namespace's schemastery-shaped schema:
 * `dsh-settings` calls it as `schema(mergeLayers(base, section))` and serializes it with
 * `toJSON()`, which is the whole contract this namespace needs.
 */
function settingsSchema(value) {
  const source = isRecord(value) ? value : {}
  return {
    baseURL: normalizeBaseURL(source.baseURL),
    credentialMode: normalizeMode(source.credentialMode),
    apiKeyEnv: normalizeApiKeyRef(source.apiKeyEnv),
  }
}
settingsSchema.toJSON = () => ({
  type: 'object',
  dict: {
    baseURL: { type: 'string', default: DEFAULT_BASE_URL, description: 'Ollama API base URL' },
    credentialMode: {
      type: 'string',
      default: MODE_REFERENCE,
      enum: [MODE_REFERENCE, MODE_DIRECT],
      description: 'reference = reuse an existing apiKeyEnv read-only; direct = a key owned by this plugin',
    },
    apiKeyEnv: { type: 'string', default: DEFAULT_API_KEY_ENV, description: 'referenced only in reference mode' },
  },
})

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

/** Read the namespace as the browser needs it: resolved value, revision, effective reference. */
function configView(ctx) {
  const fallback = {
    available: false,
    registered: false,
    writable: false,
    value: settingsSchema(undefined),
    revision: null,
    ref: DEFAULT_API_KEY_ENV,
    endpoint: usageURL(DEFAULT_BASE_URL),
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
    return { ...fallback, available: true, error: `settings namespace "${NS}" is not registered` }
  }
  const raw = descriptor.value
  const value = isRecord(raw)
    ? {
        baseURL: normalizeBaseURL(raw.baseURL),
        credentialMode: normalizeMode(raw.credentialMode),
        apiKeyEnv: normalizeApiKeyRef(raw.apiKeyEnv),
      }
    : settingsSchema(undefined)
  return {
    available: true,
    registered: true,
    writable: settings.writable === true,
    value,
    revision: typeof descriptor.revision === 'number' ? descriptor.revision : null,
    ref: effectiveRef(value),
    endpoint: usageURL(value.baseURL),
    error: null,
  }
}

async function saveConfig(ctx, patchSource, expectedRevision) {
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
    await settings.update(NS, patch, expected)
  } catch (error) {
    const label = typeof error.name === 'string' ? error.name : ''
    const message = errorMessage(error)
    const conflict = label === 'SettingsConflictError' || message.includes('changed since it was read')
    return { ok: false, error: { code: conflict ? 'conflict' : 'failed', message } }
  }
  const view = configView(ctx)
  return { ok: true, value: view.value, revision: view.revision, ref: view.ref }
}

/**
 * `describe` never returns a value, which is what lets the card show "configured / writable"
 * without the secret ever crossing to the browser.
 */
async function credentialView(ctx, refOverride) {
  const view = configView(ctx)
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
async function setOwnCredential(ctx, value) {
  const credentials = ctx.credentials
  if (credentials === undefined) return { ok: false, error: { code: 'unavailable', message: 'credentials service unavailable' } }
  const view = configView(ctx)
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
  const info = await credentialView(ctx)
  return { ok: true, ref: DIRECT_REF, configured: info.configured, writable: info.writable, source: info.source }
}

async function clearOwnCredential(ctx) {
  const credentials = ctx.credentials
  if (credentials === undefined) return { ok: false, error: { code: 'unavailable', message: 'credentials service unavailable' } }
  try {
    await credentials.unset(DIRECT_REF)
  } catch (error) {
    return { ok: false, error: { code: 'failed', message: errorMessage(error) } }
  }
  const info = await credentialView(ctx)
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
async function readUsage(ctx) {
  const view = configView(ctx)
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
async function handleRequest(ctx, endpoint, payload) {
  const input = isRecord(payload) ? payload : {}
  switch (endpoint) {
    case 'config/read':
      return ok(configView(ctx))
    case 'config/save':
      return ok(await saveConfig(ctx, input.patch, input.expectedRevision))
    case 'credential/describe':
      return ok(await credentialView(ctx, input.ref))
    case 'credential/set':
      return ok(await setOwnCredential(ctx, input.value))
    case 'credential/unset':
      return ok(await clearOwnCredential(ctx))
    case 'usage/read':
      return ok(await readUsage(ctx))
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
 */
async function routeHandler(ctx, req, res) {
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
  sendJson(res, 200, await handleRequest(ctx, endpoint, payload))
}

/** Mount the settings namespace and this half's route. */
export function apply(ctx) {
  // Registered on this plugin's own fiber, so it unwinds with the plugin; the registration
  // returns a scope, not a disposer, so it must not be wrapped in `ctx.effect`.
  ctx.settings.register(NS, settingsSchema)

  // A plugin row that throws in `apply` fails the *whole* plugin tree, so a route that cannot
  // register (a duplicate (kind, path)) must degrade to "no UI surface" rather than block boot.
  try {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => routeHandler(ctx, req, res),
      }),
      'ollama-usage: route',
    )
  } catch (error) {
    console.error(`[ollama-usage] route unavailable: ${errorMessage(error)}`)
  }
}
