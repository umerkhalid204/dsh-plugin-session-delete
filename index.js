/**
 * dsh-plugin-session-delete — Host half.
 *
 * One operation, two callers (Harness plugin practice): the browser button and
 * the `session_delete` agent tool both run `deleteSession()` below, so the
 * delete chain has exactly one implementation.
 *
 * Core has no delete API for sessions — the persistence seam states it plainly
 * ("Nothing deletes session files"), and `workspace.archiveSession` only hides a
 * row. This plugin therefore performs the durable removal itself, in the order
 * that keeps Harness state consistent:
 *
 *   1. stop the live agent on that session (cancel + time-boxed quiescence),
 *   2. flush buffered events, so a later teardown cannot re-create the log
 *      directory after we removed it,
 *   3. detach the row through `workspaceRegistry.archiveSession()` — the
 *      authoritative in-memory + on-disk accounting path, so the sidebar row
 *      disappears without a page reload,
 *   4. remove every session-owned log directory (`<root>/<project>/<encoded id>/`)
 *      for both id spellings, then re-sweep after a short delay and fail loudly
 *      if anything reappeared,
 *   5. drop the projection-cache unit row (domain `session_projcache`, table
 *      `sessions`) through the live storage domain, with a file-level fallback,
 *   6. strip leftover workspace accounting for the deleted id,
 *   7. confirm the session is no longer listed by `sessionQuery`.
 *
 * Session roots are discovered, never guessed: the Loader's own
 * `session-persistence-jsonl` config when `configEditor` is live, then
 * `$DSH_HOME/sessions`, then the per-profile default. `config.sessionRoot` adds
 * an explicit one. Every removal is path-validated: the directory must sit at
 * `<root>/<project>/<dir>` under a resolved root, be a real directory (never a
 * symlink), decode to one of the id spellings, and contain a session log or
 * `session.lock`.
 *
 * Plain ESM, no build step, no dependencies: `dsh plugin add github:…` installs
 * it as-is on any machine.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const name = 'session-delete'

// Nothing is a hard dependency: a terminal-only profile has no webServer, and a
// profile without tools still gets the HTTP route. Every service is read with
// ctx.get() and guarded.
export const inject = []

const ROUTE_PATH = '/session-delete/api/delete'
const MAX_BODY = 1 << 20

const PERSISTENCE_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
const PROJCACHE_DOMAIN = 'session_projcache'
const PROJCACHE_TABLE = 'sessions'
const WORKSPACE_DOMAIN = 'workspace'
const WORKSPACE_TABLE = 'workspaces'

/** Session ids are Harness-minted (`session-<uuid>`, rarely `session-<n>`); keep path building strictly validated. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** A session-owned directory holds the canonical log generations and its lock file. */
const SESSION_FILE_RE = /^session(\.v\d+)?\.jsonl($|\.)/

class DeleteError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'DeleteError'
    this.status = status
  }
}

// --- options -----------------------------------------------------------------

function expandHome(value) {
  if (!value) return ''
  const text = String(value).trim()
  if (!text) return ''
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || ''
  if (text === '~') return home
  if (text.startsWith('~/')) return path.join(home, text.slice(2))
  return text
}

function normalizeOptions(config) {
  const roots = []
  for (const raw of [config?.sessionRoot, process.env.DSH_SESSION_ROOT]) {
    const value = expandHome(raw)
    if (value) roots.push(path.resolve(value))
  }
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  }
  return {
    sessionRoots: roots,
    stopAgent: config?.stopAgent !== false,
    idleMs: number(config?.idleMs, 20000, 0, 120000),
    sweepMs: number(config?.sweepMs, 500, 0, 10000),
  }
}

/** Every root this Harness could store session logs under, deduplicated. */
function sessionRoots(ctx, options) {
  const out = [...options.sessionRoots]
  for (const root of rootsFromLoader(ctx)) out.push(root)
  const dshHome = expandHome(process.env.DSH_HOME) || path.join(os.homedir(), '.dsh')
  if (dshHome) {
    out.push(path.join(dshHome, 'sessions'))
    const profile = process.env.DSH_PROFILE
    if (profile) out.push(path.join(dshHome, 'profiles', profile, 'sessions'))
  }
  const seen = new Set()
  const roots = []
  for (const raw of out) {
    if (!raw) continue
    const resolved = path.resolve(expandHome(raw))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    roots.push(resolved)
  }
  return roots
}

/** Ask the Loader what root the JSONL backend was actually configured with. */
function rootsFromLoader(ctx) {
  const roots = []
  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.configuration !== 'function') return roots
  try {
    for (const item of editor.configuration() || []) {
      const entry = item?.entry
      const name = typeof entry === 'string' ? entry : entry?.name
      if (name !== PERSISTENCE_PACKAGE) continue
      for (const layer of [item?.override, item?.inherited]) {
        const root = layer && typeof layer === 'object' ? layer.root : undefined
        if (typeof root === 'string' && root) roots.push(root)
      }
    }
  } catch {
    /* configEditor is a diagnostic surface; its absence never blocks a delete */
  }
  return roots
}

// --- id + path helpers -------------------------------------------------------

function idVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else variants.add(`session-${sessionId}`)
  return [...variants]
}

/** The JSONL backend escapes path segments injectively (`~XXXX` for unsafe characters). */
function decodeSegment(name) {
  return String(name).replace(/~([0-9a-fA-F]{4})/g, (_, hex) => {
    const code = Number.parseInt(hex, 16)
    return Number.isFinite(code) ? String.fromCharCode(code) : _
  })
}

function isSessionDirectory(dir) {
  try {
    const entries = fs.readdirSync(dir)
    if (!entries.some((name) => SESSION_FILE_RE.test(name) || name === 'session.lock')) return false
    const realpath = fs.realpathSync(dir)
    return fs.statSync(realpath).isDirectory()
  } catch {
    return false
  }
}

/** Find `<root>/<project>/<session dir>` for every id spelling, without ever recomputing the project slug. */
function findSessionDirs(roots, variants) {
  const found = []
  for (const root of roots) {
    let projects
    try {
      projects = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(root, project.name)
      let dirs
      try {
        dirs = fs.readdirSync(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        const decoded = decodeSegment(dir.name)
        if (!variants.includes(dir.name) && !variants.includes(decoded)) continue
        const candidate = path.join(projectDir, dir.name)
        // Belt and braces: the candidate must sit exactly one level under this
        // project directory, which itself sits under a resolved root.
        const resolvedRoot = path.resolve(root)
        const resolvedCandidate = path.resolve(candidate)
        if (!resolvedCandidate.startsWith(resolvedRoot + path.sep)) continue
        if (path.dirname(path.dirname(resolvedCandidate)) !== resolvedRoot) continue
        if (!isSessionDirectory(resolvedCandidate)) continue
        if (!found.includes(resolvedCandidate)) found.push(resolvedCandidate)
      }
    }
  }
  return found
}

async function removeDirs(roots, variants) {
  const dirs = findSessionDirs(roots, variants)
  for (const dir of dirs) {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  return dirs
}

// --- storage-domain cleanup --------------------------------------------------

async function stripProjectionCache(ctx, roots, variants) {
  let removed = false
  const domain = ctx.get('storageDomain')?.get?.(PROJCACHE_DOMAIN)
  const table = domain?.table?.(PROJCACHE_TABLE)
  if (table && typeof table.get === 'function' && typeof table.delete === 'function') {
    for (const variant of variants) {
      try {
        if (table.get(variant) === undefined) continue
        await table.delete(variant)
        removed = true
      } catch {
        /* closed unit: the file-level sweep below still clears the stored row */
      }
    }
  }
  // Fallback for a closed or absent unit: remove the per-record projection file.
  for (const root of roots) {
    const dir = path.join(path.dirname(root), 'storages', PROJCACHE_DOMAIN, PROJCACHE_TABLE)
    for (const variant of variants) {
      const file = path.join(dir, `${variant}.json`)
      try {
        await fsp.stat(file)
      } catch {
        continue
      }
      try {
        await fsp.rm(file, { force: true })
        removed = true
      } catch {
        /* unreadable storage: the domain pass above already tried its own route */
      }
    }
  }
  return removed
}

/**
 * Residual workspace accounting. `archiveSession` already moved the id out of
 * its workspace row through the registry's own state; this pass clears rows the
 * registry never owned (a session that was never in a workspace) and the archive
 * slot, then re-runs once so a mid-flight registry flush cannot leave a ghost.
 */
async function stripWorkspaceAccounting(ctx, variants, { includeArchived = true } = {}) {
  let removed = false
  const domain = ctx.get('storageDomain')?.get?.(WORKSPACE_DOMAIN)
  if (!domain) return false
  const table = domain.table?.(WORKSPACE_TABLE)
  if (table && typeof table.entries === 'function' && typeof table.put === 'function') {
    for (const [id, record] of [...table.entries()]) {
      if (!record || !Array.isArray(record.sessionIds)) continue
      const kept = record.sessionIds.filter((value) => !variants.includes(value))
      if (kept.length === record.sessionIds.length) continue
      try {
        await table.put(id, { ...record, sessionIds: kept })
        removed = true
      } catch {
        /* closed unit */
      }
    }
  }
  if (includeArchived && domain.global && typeof domain.global.get === 'function' && typeof domain.global.set === 'function') {
    try {
      const state = domain.global.get()
      if (state && Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.some((value) => variants.includes(value))) {
        await domain.global.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((value) => !variants.includes(value)) })
        removed = true
      }
    } catch {
      /* closed unit */
    }
  }
  return removed
}

// --- the one delete ----------------------------------------------------------

async function stopLiveAgent(ctx, options, sessionId) {
  const agents = ctx.get('agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (!agent) return false
  for (const method of ['cancel', 'stop', 'interrupt']) {
    if (typeof agent[method] === 'function') {
      try {
        agent[method](method === 'cancel' ? { kind: 'user' } : 'session-delete')
      } catch {
        /* already settling */
      }
    }
  }
  if (options.stopAgent && typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([Promise.resolve(agent.whenIdle()).catch(() => undefined), sleep(options.idleMs)])
    } catch {
      /* time-boxed: deletion proceeds either way */
    }
  }
  return true
}

async function deleteSession(ctx, options, sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!SESSION_ID_RE.test(id)) throw new DeleteError(`invalid session id: ${id}`, 400)

  const agents = ctx.get('agents')
  const initiator = typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : undefined
  if (initiator && variantsMatch(idVariants(id), initiator.id)) {
    throw new DeleteError('a session cannot delete itself: run this from another session, or use the header button', 409)
  }

  const roots = sessionRoots(ctx, options)
  const variants = idVariants(id)
  const existing = findSessionDirs(roots, variants)

  const sessions = ctx.get('sessions')
  const live = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
  if (existing.length === 0 && !live) {
    throw new DeleteError(`no session artifacts found for ${id} (searched: ${roots.join(', ')})`, 404)
  }

  const stoppedAgent = await stopLiveAgent(ctx, options, id)

  const persistence = ctx.get('sessionPersistence')
  try {
    if (typeof persistence?.flush === 'function') await persistence.flush()
  } catch {
    /* one handle failing does not cancel the rest */
  }
  if (live && typeof sessions?.flush === 'function') {
    try {
      await sessions.flush(live)
    } catch {
      /* flush already covered by the service-wide barrier */
    }
  }

  let detached = false
  const registry = ctx.get('workspaceRegistry')
  if (typeof registry?.archiveSession === 'function') {
    try {
      await registry.archiveSession(id)
      detached = true
    } catch {
      /* not in any workspace: the file sweep still performs the durable delete */
    }
  }

  let removedDirs = await removeDirs(roots, variants)
  if (options.sweepMs > 0) await sleep(options.sweepMs)
  removedDirs = removedDirs.concat(await removeDirs(roots, variants))

  const remaining = findSessionDirs(roots, variants)
  if (remaining.length > 0) {
    throw new DeleteError(`session files could not be fully removed: ${remaining.join(', ')}`, 500)
  }

  const projectionCacheRemoved = await stripProjectionCache(ctx, roots, variants)
  let workspaceAccountingRemoved = await stripWorkspaceAccounting(ctx, variants)
  if (options.sweepMs > 0) {
    await sleep(50)
    workspaceAccountingRemoved = (await stripWorkspaceAccounting(ctx, variants)) || workspaceAccountingRemoved
  }

  let stillListed = null
  const query = ctx.get('sessionQuery')
  if (typeof query?.listSessions === 'function') {
    try {
      const listed = await query.listSessions()
      stillListed = (listed || []).some((record) => variantsMatch(variants, record?.id ?? record?.sessionId))
    } catch {
      /* listing is a confirmation, not a precondition */
    }
  }

  return {
    ok: true,
    sessionId: id,
    logDirs: removedDirs.map((dir) => path.basename(dir)),
    logPaths: removedDirs,
    logRemoved: removedDirs.length > 0,
    projectionCacheRemoved,
    workspaceAccountingRemoved,
    detachedFromSidebar: detached,
    stoppedAgent,
    stillListed: stillListed === true,
    stillListedKnown: stillListed !== null,
    rootsChecked: roots,
  }
}

function variantsMatch(variants, candidate) {
  return typeof candidate === 'string' && variants.includes(candidate)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- HTTP --------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

// --- activation --------------------------------------------------------------

export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') return
    return tools.register({
      name: 'session_delete',
      description:
        'Permanently delete one Harness session: it stops the live agent if one is running, then removes the persisted session log directory, the projection-cache row and the workspace accounting for that id. Irreversible. Deleting the session that is making this call is refused.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Exact session id to delete (`session-<uuid>`, or the bare uuid form).',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            sessionId: { type: 'string' },
            error: { type: 'string' },
            logRemoved: { type: 'boolean' },
            projectionCacheRemoved: { type: 'boolean' },
            workspaceAccountingRemoved: { type: 'boolean' },
            stoppedAgent: { type: 'boolean' },
            stillListed: { type: 'boolean' },
            stillListedKnown: { type: 'boolean' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value?.ok
              ? `deleted ${value.sessionId}: log=${value.logRemoved} projection=${value.projectionCacheRemoved} workspace=${value.workspaceAccountingRemoved} stopped=${value.stoppedAgent} stillListed=${value.stillListed}`
              : `session delete failed: ${value?.error ?? 'unknown error'}`,
          },
        ],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          return plain(deleteSession(ctx, options, args?.sessionId))
        } catch (error) {
          return plain({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'session-delete: tool')

  ctx.effect(() => {
    const web = ctx.get('webServer')
    if (!web || typeof web.register !== 'function') return
    return web.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {
          return sendJson(res, 400, { ok: false, error: 'body must be JSON' })
        }
        if (body?.confirm !== true) {
          return sendJson(res, 400, { ok: false, error: 'confirm must be true' })
        }
        try {
          return sendJson(res, 200, plain(await deleteSession(ctx, options, body.sessionId)))
        } catch (error) {
          const status = error instanceof DeleteError ? error.status : 500
          return sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'session-delete: route')
}

/** Tool results must be lossless JSON. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return { ok: false, error: 'session-delete returned a non-serializable result' }
  }
}
