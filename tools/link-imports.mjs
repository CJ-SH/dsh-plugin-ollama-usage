#!/usr/bin/env node
/**
 * Link this plugin's peer import to the DeepSeek Harness installation closure.
 *
 * Why this exists: dsh resolves an installed plugin's own bare imports from the plugin's **real
 * path**. A `link:`-installed plugin lives outside the profile, so Node's parent-walk never reaches
 * `$DSH_HOME/profiles/node_modules` and `@deepseek-ai/schemastery` fails as ERR_MODULE_NOT_FOUND —
 * which kills the whole row, not just its configuration surface.
 *
 * `$DSH_HOME/profiles/node_modules` is the fallback dsh itself maintains ("the installation
 * dependency closure") and its entries are junctions to the very files the harness loads. Pointing
 * this plugin's `node_modules` at that same entry makes the plugin and the harness share one module
 * instance, which is what `Config` needs to be the *same* schemastery the settings service
 * introspects.
 *
 * A copy would resolve but break that identity, so never `npm install` this package.
 *
 * Idempotent, and not needed when the plugin is installed as a materialized directory (tgz / copy
 * under the profile's node_modules): there the ordinary parent-walk already finds the closure.
 *
 * @module dsh-plugin-ollama-usage/tools/link-imports
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bare specifiers this plugin imports and where dsh publishes each one. */
const PEERS = ['@deepseek-ai/schemastery']

/** Expand a leading `~`, `~/` or `~\\` against the OS home. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Resolve `$DSH_HOME`, mirroring dsh's own precedence: `$DSH_HOME`, then `~/.dsh`. */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  return resolve(expandHome(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')))
}

/** Remove whatever occupies `path` so the link can be recreated. */
function clear(path) {
  if (!existsSync(path) && lstatSync(path, { throwIfNoEntry: false }) === undefined) return
  rmSync(path, { recursive: true, force: true })
}

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const closureDir = join(resolveDshHome(), 'profiles', 'node_modules')

let linked = 0
for (const peer of PEERS) {
  const source = join(closureDir, peer)
  if (!existsSync(source)) {
    console.error(`[ollama-usage] ${peer} is not published at ${source}`)
    console.error('[ollama-usage] run dsh once so it can build the profile module fallback, or set $DSH_HOME')
    process.exitCode = 1
    continue
  }
  const link = join(pluginDir, 'node_modules', peer)
  mkdirSync(dirname(link), { recursive: true })
  const current = lstatSync(link, { throwIfNoEntry: false })
  if (current !== undefined) {
    if (current.isSymbolicLink() || current.isDirectory()) rmSync(link, { recursive: true, force: true })
    else clear(link)
  }
  // A Windows junction needs no elevation, and Node treats it like any other directory link.
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  linked += 1
  console.log(`[ollama-usage] linked ${peer} -> ${source}`)
}
console.log(`[ollama-usage] ${linked}/${PEERS.length} peer imports linked`)
