/**
 * Updating the CLI itself (TODO 774, wave 36 bundle D, ARCHITECTURE.md 4.6.6).
 *
 * aios launches the CLI only with `-p` (stream-json), so the CLI's own auto-update that runs inside an interactive session
 * never runs. This only calls the CLI's own update subcommand (`selfUpdate` in `compat/claude-code.json`); it does not
 * bundle or modify anything and does not repoint symlinks (constraint 1). It does not touch credentials (constraint 2): the version is read with `--version`.
 *
 * The judgment is by **the exit code and the `--version` before and after**, and the output text is read only by partial match against the table's `signals` (it is neither displayed, saved
 * nor logged: the output can contain paths and URLs). The native CLI exits 0 and installs nothing when it cannot take the lock, when a package manager
 * manages it, or when an administrator has stopped it, so exit code 0 is not read as "updated" (we look at the versions before and after).
 *
 * Independent of electron (tests run with a fake CLI in a temporary directory).
 */
import { spawn } from 'node:child_process'
import { log } from '../../../common/logger.js'
import type { ReasonCode } from '@shared/reason.js'
import { PLAIN_VERSION_RE } from '@shared/update.js'
import type { AgentSelfUpdate, AgentSelfUpdateRun } from '../types.js'
import { flag, parseVersion, type CompatTable, type SelfUpdateTable } from './compat.js'
import { readKeychainMeta, type KeychainMeta } from './auth-diagnostics.js'

/** Upper bound for waiting on `--version` (the same as the detection at startup). */
const VERSION_TIMEOUT_MS = 15_000
/** The output is used only for the judgment (partial match). Only the head and tail of long output are kept. */
const OUTPUT_KEEP_BYTES = 64 * 1024
/** Grace period between sending SIGTERM on timeout and SIGKILL. */
const KILL_GRACE_MS = 5_000

export interface CommandResult {
  /** The exit code. Null if it ended by a signal or could not be started. */
  readonly code: number | null
  readonly output: string
  readonly timedOut: boolean
  /** Why it could not be started (`ENOENT` etc.). Null if it started. */
  readonly spawnError: string | null
}

/** The entry point that runs a child process once. Tests can pass a fake. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<CommandResult>

/** The default runner. stdin is closed, and stdout and stderr are kept together (only the head and tail if long). */
export const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let head = ''
    let tail = ''
    let timedOut = false
    let settled = false
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      resolve(result)
    }
    let killTimer: NodeJS.Timeout | null = null
    // Start it in its own process group: on timeout, grandchildren (such as npm started by the CLI) are stopped together. If a grandchild
    // keeps holding the pipe, 'close' never comes, so after a timeout it also finishes on 'exit'.
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const take = (chunk: Buffer): void => {
      let text = chunk.toString('utf8')
      if (head.length < OUTPUT_KEEP_BYTES) {
        const room = OUTPUT_KEEP_BYTES - head.length
        head += text.slice(0, room)
        // The rest of a chunk that straddles the head boundary is not dropped but goes to the tail (so a judgment word there is not missed).
        text = text.slice(room)
        if (text === '') return
      }
      tail = (tail + text).slice(-OUTPUT_KEEP_BYTES)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, output: head + tail, timedOut, spawnError: err.code ?? err.name })
    })
    child.on('exit', (code) => {
      if (timedOut) finish({ code, output: head + tail, timedOut, spawnError: null })
    })
    child.on('close', (code) => {
      finish({ code, output: head + tail, timedOut, spawnError: null })
    })
  })

/** Whether the output contains any of the table's words. */
function mentions(output: string, needles: readonly string[] | undefined): boolean {
  return (needles ?? []).some((needle) => needle !== '' && output.includes(needle))
}

/** Reads the reason it was not installed from the output text (the table's `signals`). Null if nothing matches. */
export function signalFailure(spec: SelfUpdateTable, output: string): ReasonCode | null {
  const signals = spec.signals
  if (signals === undefined) return null
  if (mentions(output, signals.disabled)) return 'agent-update-disabled'
  if (mentions(output, signals.managed)) return 'agent-update-managed'
  if (mentions(output, signals.busy)) return 'agent-update-busy'
  if (mentions(output, signals.permission)) return 'agent-update-permission'
  return null
}

export interface SelfUpdateDeps {
  readonly run?: CommandRunner
  /** Environment variables (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv
  /** TODO 1165: the entry point that reads the credentials item's attributes (only presence and times) before and after an update. Defaults to `readKeychainMeta` (tests replace it). */
  readonly readKeychain?: () => Promise<KeychainMeta>
}

/** Reading the attributes. Even on failure the update is not stopped (null). */
async function safeKeychain(read: () => Promise<KeychainMeta>): Promise<KeychainMeta | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/** Log fields (flat). Only times and states; no secret has been read. */
export function keychainFields(prefix: 'keychainBefore' | 'keychainAfter', meta: KeychainMeta | null): Record<string, string | boolean | null> {
  return {
    [`${prefix}`]: meta === null ? null : meta.state,
    [`${prefix}CreatedAt`]: meta?.createdAt ?? null,
    [`${prefix}ModifiedAt`]: meta?.modifiedAt ?? null
  }
}

/** Whether the attributes changed across the update. Null if either could not be read or was not found. */
export function keychainChanged(before: KeychainMeta | null, after: KeychainMeta | null): boolean | null {
  if (before === null || after === null || before.state !== 'found' || after.state !== 'found') return null
  return before.createdAt !== after.createdAt || before.modifiedAt !== after.modifiedAt
}

export class CliSelfUpdate implements AgentSelfUpdate {
  private readonly run: CommandRunner
  private readonly env: NodeJS.ProcessEnv
  private readonly readKeychain: () => Promise<KeychainMeta>

  constructor(
    private readonly table: CompatTable,
    private readonly spec: SelfUpdateTable,
    deps: SelfUpdateDeps = {}
  ) {
    this.run = deps.run ?? runCommand
    this.env = deps.env ?? process.env
    this.readKeychain = deps.readKeychain ?? (() => readKeychainMeta(table))
  }

  autoBlockedByBackend(): boolean {
    return (this.spec.autoDisableEnv ?? []).some((name) => {
      const value = this.env[name]
      return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
    })
  }

  async currentVersion(): Promise<string | null> {
    const result = await this.run(this.table.command, [flag(this.table, 'version')], VERSION_TIMEOUT_MS)
    return result.code === 0 ? parseVersion(result.output) : null
  }

  isKnownVersion(version: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.table.versions, version)
  }

  async update(): Promise<AgentSelfUpdateRun> {
    return this.runAndJudge('update', this.spec.updateArgs, null)
  }

  async install(version: string): Promise<AgentSelfUpdateRun> {
    // Only a version shape is passed on to the arguments (so a flag or another subcommand cannot slip in).
    if (!PLAIN_VERSION_RE.test(version)) {
      return { outcome: 'failed', before: null, after: null, failure: 'agent-update-not-switched', params: { version } }
    }
    return this.runAndJudge('install', [...this.spec.installArgs, version], version)
  }

  private async runAndJudge(
    kind: 'update' | 'install',
    args: readonly string[],
    target: string | null
  ): Promise<AgentSelfUpdateRun> {
    const keychainBefore = await safeKeychain(this.readKeychain)
    const before = await this.currentVersion()
    const started = Date.now()
    const result = await this.run(this.table.command, args, this.spec.timeoutMs)
    const after = await this.currentVersion()
    const keychainAfter = await safeKeychain(this.readKeychain)
    const ms = Date.now() - started
    const judged = judge(this.spec, result, before, after, target)
    // Output text is not logged (it can contain paths and URLs). Only versions, the exit code and the judgment.
    const fields = { kind, before, after, exitCode: result.code, timedOut: result.timedOut, ms, outcome: judged.outcome,
      ...keychainFields('keychainBefore', keychainBefore),
      ...keychainFields('keychainAfter', keychainAfter),
      keychainChanged: keychainChanged(keychainBefore, keychainAfter)
    }
    if (kind === 'update' && before === null && after !== null) {
      // The earlier `--version` could not be read, so we do not claim it went up.
      log.warn('agent.selfUpdate.beforeUnknown', { after, exitCode: result.code })
    }
    if (judged.outcome === 'failed') log.warn('agent.selfUpdate', { ...fields, failure: judged.failure })
    else log.info('agent.selfUpdate', fields)
    return judged
  }
}

/** Judgment for one run (pure function). `target` is the version specified by `install` (null for `update`). */
export function judge(
  spec: SelfUpdateTable,
  result: CommandResult,
  before: string | null,
  after: string | null,
  target: string | null
): AgentSelfUpdateRun {
  if (result.spawnError !== null) {
    return { outcome: 'failed', before, after, failure: 'agent-update-unavailable' }
  }
  if (target !== null) {
    if (after === target) {
      return before === after ? { outcome: 'unchanged', before, after } : { outcome: 'updated', before, after }
    }
    const reason = result.timedOut ? 'agent-update-timeout' : signalFailure(spec, result.output)
    return {
      outcome: 'failed',
      before,
      after,
      failure: reason ?? 'agent-update-not-switched',
      params: { version: target }
    }
  }
  // If the version changed, it went up regardless of the exit code or a timeout (e.g. it failed in cleanup after finishing the install).
  // When the earlier version could not be obtained (`before === null`) we cannot tell whether it changed: it does not become 'updated' and falls to 'unchanged' below.
  if (before !== null && after !== null && before !== after) return { outcome: 'updated', before, after }
  if (result.timedOut) return { outcome: 'failed', before, after, failure: 'agent-update-timeout' }
  const signalled = signalFailure(spec, result.output)
  if (signalled !== null) return { outcome: 'failed', before, after, failure: signalled }
  if (result.code !== 0) {
    return {
      outcome: 'failed',
      before,
      after,
      failure: 'agent-update-failed',
      params: { exitCode: result.code ?? -1 }
    }
  }
  if (after === null) return { outcome: 'failed', before, after, failure: 'agent-update-unavailable' }
  // `before === null` arrives here: we cannot tell whether it went up. It does not become 'updated' (no notification and no "revert" record is made).
  return { outcome: 'unchanged', before, after }
}
