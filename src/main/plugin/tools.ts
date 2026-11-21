/**
 * Relay for plugin tools (TODO 847, ARCHITECTURE 7.6.7). The main stage of gateway -> main -> plugin-host.
 *
 * - **List** (`list`): the `mcp.tools` of enabled plugins, listed by their name at the gateway (`pluginToolExposedName`).
 *   The gateway receives it only once at startup and puts it in `tools/list`.
 * - **Call** (`prepare` -> (approval) -> `run`): look the name up again (a plugin that became disabled or disappeared is refused),
 *   **re-check the arguments with the same schema as the manifest**, and call plugin-host's `mcp.<name>`. The result has a size limit.
 *   Approval (`sideEffect: true`) needs the conversation's context, so `GatewayRequests` does it between `prepare` and `run`.
 * - **Audit**: one line per call (plugin id, tool name, success or failure, elapsed time). Values of arguments and results are not kept
 *   (the logging rule in Conventions). The result is only returned to the model and not stored (constraint 10).
 *
 * Plugin code does not run here (constraint 8) - `invoke` only throws to the plugin-host process.
 * Responses are for the model, so they are fixed English sentences. A failure is returned as `{ error }` and not thrown (so the gateway can tell it from
 * `aios unavailable`, and so the CLI is not dragged in).
 */
import type {
  AuditEntry,
  CapabilityName,
  HostExportKind,
  PluginToolDeclaration,
  PluginToolListing
} from '@shared/plugin.js'
import { log } from '../../common/logger.js'
import { pluginToolExposedName } from './manifest.js'
import type { EnabledPluginTool } from './host.js'
import { checkToolArgs } from './tool-schema.js'

/** Upper limit of a tool's result (number of characters as JSON). The gateway further fits the response into 32 KB (`respond`). */
export const MAX_PLUGIN_TOOL_RESULT_CHARS = 256 * 1024
/** Upper limit of one tool call (milliseconds). A plugin's infinite loop or a Promise that never settles must not stop the conversation. */
export const PLUGIN_TOOL_TIMEOUT_MS = 60_000
/** Upper limit on the number of tools shown at the gateway (total over all plugins). The excess is dropped from the end in id order. */
export const MAX_EXPOSED_PLUGIN_TOOLS = 64
/** Upper limit (characters) when returning an error message a plugin threw to the model. */
const MAX_ERROR_CHARS = 500

/** The entry point borrowed from `PluginHost`. Tests pass a fake. */
export interface PluginToolSource {
  enabledTools(): readonly EnabledPluginTool[]
  invoke(pluginId: string, command: string, arg: unknown, kind: HostExportKind, timeoutMs: number): Promise<unknown>
  /**
   * Record the first-time consent (TODO 848). Without it, a tool that needs consent cannot be called (it is refused as `consentRequired`).
   * TODO 1233: if `expectedIdentity` (the extension's identity at the time it was asked) differs from now, nothing is recorded and false is returned.
   */
  setConsent?(pluginId: string, capability: CapabilityName, granted: boolean, expectedIdentity?: string | null): boolean | void
}

/** A resolved tool. Returned by `prepare` and passed to `run`. */
export interface ResolvedPluginTool {
  readonly pluginId: string
  readonly exposedName: string
  readonly declaration: PluginToolDeclaration
  readonly sideEffect: boolean
  /**
   * Capabilities that need "first-time consent" and have none yet (TODO 848, `browser`). If not empty, the relay asks in the approval inbox before calling,
   * and if it passes, records it with `grantConsent` (it does not ask again afterwards).
   */
  readonly pendingConsent: readonly CapabilityName[]
  /** The scope of consent shown in the approval inbox (`browser.hosts`). */
  readonly consentTargets: readonly string[]
  /** TODO 1227: whether this is a tool of a bundled extension (a value decided by where main loaded it from). The unattended turn's choke point looks at it. */
  readonly bundled: boolean
  /** TODO 1227 (fix X): fingerprint of the tool declaration (`EnabledPluginTool.fingerprint`, empty if none). It is compared with the rule's permission at the time of use. */
  readonly fingerprint: string
  /**
   * TODO 1233: the extension's identity at the time of resolving (`EnabledPluginTool.identity`). First-time consent that passed in the approval inbox is recorded only if this value
   * equals the current one. Omitted or null is not recorded (the closed side).
   */
  readonly identity?: string | null
}

export type PreparedPluginCall =
  | { readonly ok: true; readonly tool: ResolvedPluginTool; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

/** The audit `reason`. No values are put in. */
export type PluginToolDenyReason =
  | 'unavailable'
  | 'invalid-args'
  | 'user-denied'
  | 'cancelled'
  | 'system-denied'
  | 'error'
  | 'timeout'
  | 'crashed'
  | 'too-large'

/** The part of the approval inbox's denial result that is needed to decide the reason kept in the audit. */
export interface PluginToolApprovalDenial {
  readonly by: 'user' | 'rule' | 'default' | 'system'
  readonly reply?: { readonly kind: string }
}

/**
 * The reason it did not pass in the approval inbox (the audit `reason`). Tells apart the user's refusal (`user-denied`) from aios's own withdrawal - the backend's
 * cancellation (`approveCancelled`), timeout, session end, interruption, shutdown (`reply.kind === 'cancelled'`)
 * (wave 45 code-review). Any other system denial is `system-denied`.
 */
export function approvalDenyReason(result: PluginToolApprovalDenial): PluginToolDenyReason {
  if (result.reply?.kind === 'cancelled') return 'cancelled'
  if (result.by === 'system') return 'system-denied'
  return 'user-denied'
}

export class PluginToolRelay {
  constructor(
    private readonly deps: {
      readonly source: PluginToolSource
      readonly audit: { record(entry: AuditEntry): void }
      readonly now?: () => number
      readonly timeoutMs?: number
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The list shown at the gateway (enabled plugins only). */
  list(): readonly PluginToolListing[] {
    const out: PluginToolListing[] = []
    for (const entry of this.deps.source.enabledTools()) {
      if (out.length >= MAX_EXPOSED_PLUGIN_TOOLS) {
        log.warn('plugin.tools.capped', { max: MAX_EXPOSED_PLUGIN_TOOLS })
        break
      }
      const { tool } = entry
      out.push({
        name: pluginToolExposedName(entry.pluginId, tool.name),
        title: `${entry.pluginName}: ${tool.title ?? tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema
      })
    }
    return out
  }

  /** Look up the currently enabled tool from its name at the gateway. null for a disabled or disappeared plugin and for an unknown name. */
  lookup(exposedName: string): ResolvedPluginTool | null {
    for (const entry of this.deps.source.enabledTools()) {
      if (pluginToolExposedName(entry.pluginId, entry.tool.name) !== exposedName) continue
      return {
        pluginId: entry.pluginId,
        exposedName,
        declaration: entry.tool,
        sideEffect: entry.tool.sideEffect === true,
        pendingConsent: entry.pendingConsent ?? [],
        consentTargets: entry.consentTargets ?? [],
        bundled: entry.bundled === true,
        fingerprint: entry.fingerprint ?? '',
        identity: entry.identity ?? null
      }
    }
    return null
  }

  /** Resolve and re-check the arguments. On failure, leave one audit line and return the reason. */
  prepare(exposedName: unknown, args: unknown): PreparedPluginCall {
    const name = typeof exposedName === 'string' ? exposedName : ''
    const tool = name === '' ? null : this.lookup(name)
    if (tool === null) {
      // A tool of a plugin that was disabled, dropped and removed, or swapped (the gateway keeps showing the startup list until the next session).
      const [guessedId, guessedTool] = splitExposedName(name)
      this.recordAudit(guessedId, guessedTool, 'deny', 'unavailable', null)
      return { ok: false, error: 'this tool is not available: its plugin is disabled or was removed' }
    }
    const value = args === undefined || args === null ? {} : args
    const error = checkToolArgs(tool.declaration.inputSchema as Record<string, unknown>, value)
    if (error !== null) {
      this.recordAudit(tool.pluginId, tool.declaration.name, 'deny', 'invalid-args', null)
      return { ok: false, error: `invalid arguments: ${error}` }
    }
    return { ok: true, tool, args: value as Record<string, unknown> }
  }

  /**
   * The first-time consent passed in the approval inbox (TODO 848). Record all capabilities of `pendingConsent`. False if there is no way to record
   * (the caller refuses without calling the tool).
   */
  grantConsent(tool: ResolvedPluginTool): boolean {
    const setConsent = this.deps.source.setConsent
    if (setConsent === undefined) return false
    // TODO 1233: consent is recorded for the extension (identity) at the time it was asked. It is not moved to an extension whose contents changed while asking.
    const expected = tool.identity ?? null
    for (const capability of tool.pendingConsent) {
      if (setConsent.call(this.deps.source, tool.pluginId, capability, true, expected) === false) {
        log.warn('plugin.consent.notRecorded', { pluginId: tool.pluginId, capability })
        return false
      }
    }
    log.info('plugin.consent.granted', { pluginId: tool.pluginId, capabilities: tool.pendingConsent.join(',') })
    return true
  }

  /** It did not pass in the approval inbox (sideEffect). Only recorded in the audit. The reason is told apart by `approvalDenyReason`. */
  recordDenied(tool: ResolvedPluginTool, denial: PluginToolApprovalDenial): void {
    this.recordAudit(tool.pluginId, tool.declaration.name, 'deny', approvalDenyReason(denial), null)
  }

  /**
   * Call plugin-host's `mcp.<name>`. The return value takes the shape returned to the model: a string becomes `{ text }` (a shape the gateway can
   * truncate as body text), anything else `{ result }`. A failure is `{ error }`.
   */
  async run(tool: ResolvedPluginTool, args: Record<string, unknown>): Promise<unknown> {
    const started = this.now()
    const name = tool.declaration.name
    let raw: unknown
    try {
      raw = await this.deps.source.invoke(
        tool.pluginId,
        name,
        args,
        'mcp',
        this.deps.timeoutMs ?? PLUGIN_TOOL_TIMEOUT_MS
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const reason = failureReason(message)
      this.finish(tool, started, false, reason)
      if (reason === 'timeout') return { error: 'the plugin did not answer in time' }
      if (reason === 'crashed') return { error: 'the plugin stopped while running this tool' }
      if (reason === 'unavailable') return { error: 'this tool is not available: its plugin is disabled or was removed' }
      return { error: `the plugin reported an error: ${message.slice(0, MAX_ERROR_CHARS)}` }
    }
    const shaped = typeof raw === 'string' ? { text: raw } : { result: raw ?? null }
    let size: number
    try {
      size = JSON.stringify(shaped).length
    } catch {
      this.finish(tool, started, false, 'error')
      return { error: 'the plugin returned a value that is not JSON' }
    }
    if (size > MAX_PLUGIN_TOOL_RESULT_CHARS) {
      this.finish(tool, started, false, 'too-large')
      return { error: `the plugin returned more than ${MAX_PLUGIN_TOOL_RESULT_CHARS} characters` }
    }
    this.finish(tool, started, true, null)
    return shaped
  }

  private finish(tool: ResolvedPluginTool, started: number, ok: boolean, reason: PluginToolDenyReason | null): void {
    const ms = Math.max(0, this.now() - started)
    this.recordAudit(tool.pluginId, tool.declaration.name, ok ? 'allow' : 'deny', reason, ms)
    log.info('plugin.tool.call', { pluginId: tool.pluginId, tool: tool.declaration.name, ok, ms, ...(reason === null ? {} : { reason }) })
  }

  private recordAudit(
    pluginId: string,
    tool: string,
    decision: 'allow' | 'deny',
    reason: PluginToolDenyReason | null,
    ms: number | null
  ): void {
    this.deps.audit.record({
      at: this.now(),
      pluginId,
      capability: 'mcp',
      op: 'tool',
      // Only the tool's name (the declared one, or the gateway name up to 64 characters). Argument values are not put in.
      target: tool.slice(0, 64),
      decision,
      reason,
      ms
    })
  }
}

/**
 * The approval inbox summary that asks for first-time consent (TODO 848). One line for the user (a fixed English sentence + plugin id + host).
 * Argument values are not put in.
 */
export function consentSummary(tool: ResolvedPluginTool): string {
  const hosts = tool.consentTargets.slice(0, 8).join(', ')
  if (tool.pendingConsent.includes('browser')) {
    return `First use: allow ${tool.pluginId} to read pages with your Web view sign-in (cookies) on ${hosts === '' ? '(no hosts)' : hosts}`
  }
  return `First use: allow ${tool.pluginId} to use ${tool.pendingConsent.join(', ')}`
}

/**
 * Take a guess at the plugin id and the tool name from the gateway name (for the audit line, TODO 883). The audit `target` is only the tool name, as in a normal call
 * (the plugin id goes in the `pluginId` field). If it cannot be told, `?` and the name as is.
 */
function splitExposedName(exposedName: string): [pluginId: string, tool: string] {
  const cut = exposedName.indexOf('__')
  if (cut <= 0) return ['?', exposedName]
  return [exposedName.slice(0, cut).replace(/_/g, '.').slice(0, 64), exposedName.slice(cut + 2)]
}

/** Derive the reason from the failure message of `PluginHost.invoke` (the message is host.ts's). */
function failureReason(message: string): PluginToolDenyReason {
  if (message === 'plugin invoke timeout' || message === 'plugin host timeout') return 'timeout'
  if (message.startsWith('plugin host exited') || message === 'plugin host stopped') return 'crashed'
  if (message === 'plugin not available' || message === 'undeclared-export' || message === 'plugin host is shutting down') {
    return 'unavailable'
  }
  return 'error'
}
