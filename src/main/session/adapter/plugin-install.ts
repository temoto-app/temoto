/**
 * Installs and removes CLI plugins (TODO 1099, wave 65 bundle A, ARCHITECTURE.md 4.5.3.3). **This file is the only entry point that
 * calls the CLI's plugin subcommands** (constraint 6).
 *
 * aios does not write to `~/.claude/plugins/` (constraint 2). It runs the CLI's non-interactive subcommands (`plugins` in `compat/claude-code.json`)
 * as child processes and lets the CLI itself write. The shape is the same as `self-update.ts` (TODO 774), and what it reads is **only the exit code and
 * the `outcome` / `failureCode` of one `--json` line**. Output sentences, including `message`, are neither shown, saved nor logged
 * (they can contain paths and URLs).
 *
 * - From the result lines, only the one in which the random number passed through an environment variable (`nonceEnv`) is echoed in `nonce` is taken (so JSON written to stdout
 *   by a plugin or a child is not mistaken for it). For a version where the CLI does not echo it, a line without a nonce is taken; if there is none, the exit code alone decides.
 * - stdin is closed. Without a TTY, the CLI will not run commands a marketplace declares (a command-type source / headersHelper) unless
 *   `-y` / `--accept-command` is given. aios passes neither (stage 1 does not install command types).
 * - The name is one listed in the catalog (`plugin-catalog.ts`), and the CLI is given the official marketplace's name (`installName`, TODO 1177).
 *   Only what is listed in the installed-plugin list with the user scope can be removed.
 *   Values coming from the renderer are checked again in main.
 * - It does not run with the fake backend, in dev, or in a duplicate, and returns the reason (the same as 774). While a conversation is running it returns "after it finishes".
 *
 * Independent of electron (tests run with a fake runner).
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { log } from '../../../common/logger.js'
import type {
  PluginCatalogResult,
  PluginOpReason,
  PluginOpResult,
  PluginOpsDisabled
} from '../../../shared/skills.js'
import { loadBackendPaths, loadCompatTable, type BackendPaths, type CompatTable, type PluginsTable } from './compat.js'
import {
  CATALOG_PAGE,
  NAME_RE,
  PluginCatalogReader,
  installedNamesOf,
  searchCatalog,
  withInstalledCandidates
} from './plugin-catalog.js'

/** How much to keep from the end of stdout (the result line is the last single line). */
const STDOUT_KEEP_BYTES = 256 * 1024
const KILL_GRACE_MS = 5_000
/** Upper bound on the search term's length. */
const MAX_QUERY = 200
const FAILURE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/

export interface PluginRunResult {
  readonly code: number | null
  /** The end of stdout (used only to look for the result line). */
  readonly stdout: string
  readonly timedOut: boolean
  readonly spawnError: string | null
}

export interface PluginRunOptions {
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  /**
   * Whether the result line is in the end of stdout. If this is true after the CLI has exited (`exit`), the result is returned without waiting for `close` (which does not come
   * while a grandchild holds stdout).
   */
  readonly resultReady?: (stdout: string) => boolean
}

export type PluginRunner = (command: string, args: readonly string[], options: PluginRunOptions) => Promise<PluginRunResult>

/**
 * The default runner. stdin is closed, only the end of stdout is kept, and stderr is read and discarded.
 *
 * Sometimes the CLI itself has finished but a grandchild (git etc.) holds stdout, so `close` never comes. In that case it
 * (a) returns immediately if the result line is complete after `exit`, and (b) if it is still incomplete when time runs out, stops the grandchild and returns with the CLI's exit code
 * (`timedOut` is true only when the CLI itself did not finish in time).
 */
export const runPluginCommand: PluginRunner = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = ''
    let timedOut = false
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let killTimer: NodeJS.Timeout | null = null
    const finish = (result: PluginRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      resolve(result)
    }
    // Start it in its own process group: on timeout, grandchildren (git etc.) are stopped together.
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: options.env,
      cwd: options.cwd
    })
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    /** If the CLI has finished and the result line is complete, return it (and let go of the leftover grandchild's pipe). */
    const finishIfReady = (): void => {
      if (settled || !exited || timedOut) return
      if (options.resultReady === undefined || !options.resultReady(stdout)) return
      finish({ code: exitCode, stdout, timedOut: false, spawnError: null })
      child.stdout.destroy()
      child.stderr.destroy()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-STDOUT_KEEP_BYTES)
      finishIfReady()
    })
    child.stderr.on('data', () => undefined)
    const timer = setTimeout(() => {
      if (exited) {
        // The CLI finished in time and a grandchild merely holds the pipe. Stop the grandchild and return with the CLI's exit code.
        killGroup('SIGKILL')
        finish({ code: exitCode, stdout, timedOut: false, spawnError: null })
        child.stdout.destroy()
        child.stderr.destroy()
        return
      }
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }, options.timeoutMs)
    timer.unref?.()
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, timedOut, spawnError: err.code ?? err.name })
    })
    child.on('exit', (code) => {
      if (timedOut) {
        finish({ code, stdout, timedOut, spawnError: null })
        return
      }
      exited = true
      exitCode = code
      finishIfReady()
    })
    child.on('close', (code) => {
      finish({ code, stdout, timedOut, spawnError: null })
    })
  })

/** The fields read from the result line. */
export interface PluginResultLine {
  readonly outcome: string
  readonly failureCode: string | null
}

/**
 * Looks for the result line at the end of stdout. If `nonce` was passed, take the line that echoes it. If there is none, a line
 * without a nonce field (a CLI version that does not echo it). If neither, null.
 */
export function parseResultLine(stdout: string, nonce: string | null): PluginResultLine | null {
  const { matched, fallback } = scanResultLines(stdout, nonce)
  return matched ?? fallback
}

/**
 * Whether the result line is complete (the runner's `resultReady`). If a nonce was passed, true only when a line that echoes it exists
 * (a line without a nonce may be output from a plugin or a child, so it alone is not taken as complete).
 */
export function hasResultLine(stdout: string, nonce: string | null): boolean {
  const { matched, fallback } = scanResultLines(stdout, nonce)
  return nonce === null ? fallback !== null : matched !== null
}

function scanResultLines(
  stdout: string,
  nonce: string | null
): { matched: PluginResultLine | null; fallback: PluginResultLine | null } {
  let fallback: PluginResultLine | null = null
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('{')) continue
    let data: unknown
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    const record = data as Record<string, unknown>
    if (typeof record['outcome'] !== 'string') continue
    const code = record['failureCode']
    const parsed = {
      outcome: record['outcome'],
      // The reason code is only an identifier shape (it goes to the log, so even if a sentence slips in it is not recorded).
      failureCode: typeof code === 'string' ? (FAILURE_CODE_RE.test(code) ? code : 'unrecognized') : null
    }
    const lineNonce = record['nonce']
    if (nonce !== null && lineNonce === nonce) return { matched: parsed, fallback }
    if (lineNonce === undefined && fallback === null) fallback = parsed
  }
  return { matched: null, fallback }
}

/** `failureCode` → aios's reason (null if not in the table). */
function classify(table: PluginsTable, code: string | null): PluginOpReason | 'already' | null {
  if (code === null) return null
  const codes = table.failureCodes
  if (codes.alreadyDone?.includes(code)) return 'already'
  if (codes.commandSource?.includes(code)) return 'command-source'
  if (codes.policy?.includes(code)) return 'policy'
  if (codes.network?.includes(code)) return 'network'
  if (codes.notInstallable?.includes(code)) return 'not-installable'
  if (codes.notInstalled?.includes(code)) return 'not-installed'
  return null
}

/**
 * Judgment for one run (pure function). If the exit code and the result line are complete, judge by them before the timeout mark (the CLI had
 * finished and a grandchild was only holding the pipe). Only when there is no result line or no exit code (it was stopped without finishing) is it 'timeout'.
 */
export function judgePluginRun(table: PluginsTable, result: PluginRunResult, line: PluginResultLine | null): PluginOpResult {
  if (result.spawnError !== null) return { ok: false, reason: 'unavailable' }
  const classified = classify(table, line?.failureCode ?? null)
  if (classified === 'already') return { ok: true, already: true }
  if (result.timedOut && (line === null || result.code === null)) return { ok: false, reason: 'timeout' }
  if (result.code === 0 && (line === null || line.outcome === 'ok')) return { ok: true, already: false }
  if (classified !== null) return { ok: false, reason: classified }
  return { ok: false, reason: 'failed', exitCode: result.code ?? -1 }
}

export interface CliPluginManagerDeps {
  /** The reason install / remove does not run (dev, fake backend, duplicate). It runs if null. */
  readonly opsDisabled: PluginOpsDisabled | null
  /** Whether a conversation is running (the reason if so, null if not). */
  readonly blocker: () => string | null
  readonly run?: PluginRunner
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly table?: CompatTable
  readonly paths?: BackendPaths
  readonly now?: () => number
}

/** The "CLI plugin" entry point of Settings Skills (list, install, remove). */
export class CliPluginManager {
  private readonly table: CompatTable
  private readonly spec: PluginsTable | undefined
  private readonly reader: PluginCatalogReader
  private readonly run: PluginRunner
  private readonly env: NodeJS.ProcessEnv
  private readonly home: string
  private busy = false

  constructor(private readonly deps: CliPluginManagerDeps) {
    this.table = deps.table ?? loadCompatTable()
    this.spec = this.table.plugins
    const paths = deps.paths ?? loadBackendPaths()
    this.home = deps.home ?? homedir()
    this.reader = new PluginCatalogReader({
      paths,
      table: this.spec,
      home: this.home,
      ...(deps.now === undefined ? {} : { now: deps.now })
    })
    this.run = deps.run ?? runPluginCommand
    this.env = deps.env ?? process.env
  }

  private opsDisabled(): PluginOpsDisabled | null {
    if (this.spec === undefined) return 'no-backend-support'
    return this.deps.opsDisabled
  }

  /** The catalog filtered by words, and the list of installed plugins. */
  async catalog(query: unknown): Promise<PluginCatalogResult> {
    const text = typeof query === 'string' ? query.slice(0, MAX_QUERY) : ''
    const snapshot = await this.reader.read()
    const marketplace = this.spec?.marketplace
    // The installed plugin's name is the first half of `<installName>@<marketplace>` (not the catalog's `entryNames` name, TODO 1177).
    const installedNames = installedNamesOf(snapshot.installed, marketplace)
    const refreshCommand = this.spec === undefined ? null : [this.table.command, ...this.spec.refreshHint].join(' ')
    const opsDisabled = this.opsDisabled()
    if (!snapshot.catalog.ok) {
      return {
        entries: [],
        matched: 0,
        total: 0,
        fetchedAt: null,
        unavailable: snapshot.catalog.reason,
        refreshCommand,
        installed: snapshot.installed,
        opsDisabled
      }
    }
    const { entries, matched } = searchCatalog(snapshot.catalog.records, text, installedNames, CATALOG_PAGE)
    return {
      entries,
      matched,
      total: snapshot.catalog.records.length,
      fetchedAt: snapshot.catalog.fetchedAt,
      unavailable: null,
      refreshCommand,
      installed: snapshot.installed,
      opsDisabled
    }
  }

  /** Installs a name listed in the catalog (user scope). */
  async install(name: unknown): Promise<PluginOpResult> {
    const spec = this.spec
    if (spec === undefined || this.deps.opsDisabled !== null) return { ok: false, reason: 'disabled' }
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, reason: 'invalid' }
    const snapshot = await this.reader.read()
    if (!snapshot.catalog.ok) return { ok: false, reason: 'invalid' }
    // Even for an undecided listing, if a candidate is installed it resolves to that name as the list does (so it does not disagree with the list's badge).
    const records = withInstalledCandidates(snapshot.catalog.records, installedNamesOf(snapshot.installed, spec.marketplace))
    const record = records.find((entry) => entry.nameKey === name.toLowerCase())
    if (record === undefined) return { ok: false, reason: 'invalid' }
    if (record.blocked === 'command-source') return { ok: false, reason: 'command-source' }
    if (record.blocked !== null || record.installName === null || !NAME_RE.test(record.installName)) {
      return { ok: false, reason: 'not-installable' }
    }
    // Pass the official marketplace's name, not the catalog name (`record.name`) (TODO 1177).
    return this.runOp('install', [...spec.installArgs, `${record.installName}@${spec.marketplace}`, spec.jsonFlag])
  }

  /** Removes the `<name>@<marketplace>` that is listed in the installed-plugin list with the user scope. */
  async uninstall(id: unknown): Promise<PluginOpResult> {
    const spec = this.spec
    if (spec === undefined || this.deps.opsDisabled !== null) return { ok: false, reason: 'disabled' }
    if (typeof id !== 'string' || id.length > 260) return { ok: false, reason: 'invalid' }
    const snapshot = await this.reader.read()
    const plugin = snapshot.installed.find((entry) => entry.id === id)
    if (plugin === undefined) return { ok: false, reason: 'not-installed' }
    if (!plugin.removable || !NAME_RE.test(plugin.name) || !NAME_RE.test(plugin.marketplace)) {
      return { ok: false, reason: 'invalid' }
    }
    return this.runOp('uninstall', [...spec.uninstallArgs, `${plugin.name}@${plugin.marketplace}`, spec.jsonFlag])
  }

  private async runOp(kind: 'install' | 'uninstall', args: readonly string[]): Promise<PluginOpResult> {
    const spec = this.spec
    if (spec === undefined) return { ok: false, reason: 'disabled' }
    if (this.deps.blocker() !== null) return { ok: false, reason: 'session-busy' }
    if (this.busy) return { ok: false, reason: 'op-busy' }
    this.busy = true
    try {
      const nonce = spec.nonceEnv === undefined ? null : randomBytes(16).toString('hex')
      const env: NodeJS.ProcessEnv = { ...this.env }
      if (spec.nonceEnv !== undefined && nonce !== null) env[spec.nonceEnv] = nonce
      const started = Date.now()
      const result = await this.run(this.table.command, args, {
        timeoutMs: spec.timeoutMs,
        env,
        cwd: this.home,
        resultReady: (stdout) => hasResultLine(stdout, nonce)
      })
      const line = parseResultLine(result.stdout, nonce)
      const judged = judgePluginRun(spec, result, line)
      // Output sentences and plugin names are not logged. Only the exit code, the judgment and the CLI's reason code.
      const fields = {
        kind,
        exitCode: result.code,
        timedOut: result.timedOut,
        ms: Date.now() - started,
        lineFound: line !== null,
        failureCode: line?.failureCode ?? null,
        ok: judged.ok,
        ...(judged.ok ? { already: judged.already } : { reason: judged.reason })
      }
      if (judged.ok) log.info('agent.plugin', fields)
      else log.warn('agent.plugin', fields)
      return judged
    } finally {
      this.busy = false
    }
  }
}
