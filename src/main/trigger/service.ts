/**
 * The trigger intake and queue (TODO 1216, ARCHITECTURE 6.2.6).
 *
 * extension (plugin-host) -> CapabilityBroker (declaration and consent) -> **here** (shape, duplicates, rules, the daily limit) -> queue ->
 * `SessionManager.runTriggered` (one new conversation per item, the first turn unattended and read-only).
 *
 * **Independent of electron.** The clock, the timer, the entry point that starts a conversation and the extensions' declarations are injected, and tests drive it with fakes
 * (`test/trigger-service.test.ts`). The rules:
 *
 * - **Only one unattended conversation is started at a time**: the next is not started until the first turn of the previously started conversation ends (`TriggerRunner.isUnattended`).
 *   If the limit on concurrent runs is hit, it waits (`hasRoom`). It may start even while a human's conversation is responding (the idea of 974; it is a different conversation, so no disturbance).
 * - **If it cannot be started** (not logged in, a model not in the list, a startup failure), `runTriggered` logically deletes the empty conversation and throws. This
 *   writes `failed` and retries through the queue with a gap, up to `TRIGGER_MAX_ATTEMPTS` times. When used up, `gave-up` (the same key is not accepted again).
 * - **Only instances that may run** (`autoRun`, the same judgment as scheduled runs 6.2.4): a proxy-verification copy or `AIOS_DISABLE_AGENT` does not
 *   accept (`unavailable`, nothing is written).
 * - **Shutdown** (12.9): `stop()` accepts nothing after that, and returns after the result of the one item being started (creating a conversation and sending) has been written.
 *   Items in the queue are restored at the next startup from the contents written to the row when accepted (`pending`, fix V) (`start` -> `TriggerStore.recover`).
 */
import { STALE_DEFAULT_INSTRUCTIONS } from './stale-defaults.js'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { errorFields, log } from '../../common/logger.js'
import {
  checkTriggerEvent,
  composeTriggerPrompt,
  startOfLocalDay,
  type PluginTriggerEvent,
  type TriggerAutoDisabled,
  type TriggerDeclaration,
  type TriggerEmitResult,
  type TriggerOverview,
  type TriggerRow,
  type TriggerRule,
  type TriggerToolChoice
} from '@shared/trigger.js'
import { reasonError, parseReason } from '@shared/reason.js'
import { hashTriggerKey, type PendingTriggerRow, type TriggerPayload, type TriggerStore } from './store.js'

/** How many times one item that could not be started is tried (including the first). */
export const TRIGGER_MAX_ATTEMPTS = 3
/** The gap before a retry. */
export const TRIGGER_RETRY_DELAY_MS = 5 * 60_000
/** The interval at which the queue is looked at again (to catch the end of the previous conversation's turn and a free concurrency slot). */
export const TRIGGER_PUMP_MS = 30_000
/** The queue limit (the excess is passed over like `daily-cap` - it is hardly ever reached before the daily limit). */
export const MAX_TRIGGER_QUEUE = 200

/** The part of one tool an extension declared that is needed for editing rules (TODO 1227). */
export interface TriggerSourceTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly sideEffect?: boolean
  /**
   * TODO 1227 (fix X): the fingerprint of the tool declaration (`pluginToolFingerprint`). A rule's permission is kept as a pair of the name and this fingerprint, and the choke point compares it
   * with the current fingerprint at the time of use. A tool without one (empty) is not offered as a candidate.
   */
  readonly fingerprint?: string
}

/** An extension's declaration (from PluginHost). All installed extensions (disabled ones too, to show them in the list). */
export interface TriggerSourceEntry {
  readonly pluginId: string
  readonly pluginName: string
  readonly enabled: boolean
  readonly triggers: readonly TriggerDeclaration[]
  /**
   * TODO 1227: whether it is bundled (`PluginHost.isBundled` - decided by where it was loaded from, not the manifest's self-report). Omitted is false
   * (the non-bundled side = the strict side).
   */
  readonly bundled?: boolean
  /** TODO 1227: the manifest's `mcp.tools` (candidates for tools a rule can allow). Omitted means none. */
  readonly tools?: readonly TriggerSourceTool[]
  /**
   * TODO 1227 fix X (security review): an identity the extension cannot fake (`PluginHost.identityOf`: `bundled` for bundled ones, the SHA-256 of the contents for external ones).
   * null if unreadable, and null if omitted (= it cannot be said to be the same as the extension when the rule was written - the side that reverts to disabled).
   */
  readonly identity?: string | null
}

/**
 * TODO 1227 fix X: whether the extension when the rule was written and the current extension are the same (compared by identity). An old row without the value from when it was written is
 * considered the same only when the current one is bundled (decided by where it was loaded from).
 */
function sameOwner(entry: TriggerSourceEntry, ownerIdentity: string | null): boolean {
  const current = entry.identity ?? null
  if (current === null) return false
  return ownerIdentity === current || (ownerIdentity === null && current === 'bundled')
}

/**
 * TODO 1227: tools a rule can allow in an unattended turn. **Only tools without `sideEffect` of a non-bundled extension** (read tools of a bundled extension
 * pass even without a rule, so they are not candidates. A tool with side effects cannot be allowed in an unattended turn).
 */
export function triggerToolChoices(entry: TriggerSourceEntry): readonly TriggerToolChoice[] {
  return [...allowableTools(entry).keys()].flatMap((name) => {
    const tool = entry.tools?.find((item) => item.name === name)
    return tool === undefined ? [] : [{ name: tool.name, title: tool.title ?? tool.name, description: tool.description }]
  })
}

/** TODO 1227 (fix X): the name of a tool a rule can allow -> the fingerprint of the current declaration (the same range as `triggerToolChoices`). */
export function allowableTools(entry: TriggerSourceEntry): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  if (entry.bundled === true) return out
  for (const tool of entry.tools ?? []) {
    if (tool.sideEffect === true || tool.fingerprint === undefined || tool.fingerprint === '' || out.has(tool.name)) continue
    out.set(tool.name, tool.fingerprint)
  }
  return out
}

/** The shape passed to `SessionManager.runTriggered`. The working folder is a path (null means no affiliation). */
export interface TriggerLaunch {
  readonly pluginId: string
  readonly triggerId: string
  readonly triggerName: string
  readonly title: string
  readonly url: string | null
  readonly cwd: string | null
  readonly prompt: string
  readonly modelId: string | null
  readonly thinking: TriggerRule['thinking']
}

export interface TriggerRunner {
  /** Start a conversation and send the first message. Returns the id of the started conversation. A failure throws (the callee deletes the empty conversation). */
  run(launch: TriggerLaunch): Promise<string>
  /** Whether that conversation's first (unattended) turn has not ended yet. */
  isUnattended(threadId: string): boolean
  /** Whether one more session can be started now. */
  hasRoom(): boolean
}

export interface TriggerServiceOptions {
  /** Whether this instance starts conversations (the same value as `scheduleAutoRun`). If false, events are not accepted. */
  readonly autoRun: boolean
  /** Whether the working folder (path) may be used (as a directory for `FsAccess.assertAllowed`). */
  readonly cwdAllowed: (path: string) => boolean
  /**
   * Fix X: the real path (an absolute path with symlinks resolved). null if missing or unresolvable. The default is `fs.realpathSync.native`.
   * Used to compare, real path against real path, whether an event's working folder is inside the rule's working folder (replaced in tests).
   */
  readonly realpath?: (path: string) => string | null
  readonly onChanged?: () => void
  /**
   * TODO 1227 fix X: whether the computation of extension identities (`PluginHost.identitiesReady`) has finished. While false, events are not accepted (`unavailable`),
   * and the owner match of rules is not done (so a null before computation is not misread as "swapped"). Omitted is true (tests).
   */
  readonly ownersReady?: () => boolean
  readonly now?: () => number
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly retryDelayMs?: number
}

interface QueueItem {
  readonly rowId: number
  readonly pluginId: string
  readonly triggerId: string
  /** The contents of the event (no key is held - deduplication is the row's `key_hash`). */
  readonly event: TriggerPayload
  /** The number of attempts (the same as the row's `attempts`). */
  attempts: number
  /** Do not start before this (the gap before a retry). */
  notBefore: number
}

export class TriggerService {
  private readonly queue: QueueItem[] = []
  private launching: Promise<void> | null = null
  /** The conversation started last. The next is not started until its first turn ends. */
  private activeThreadId: string | null = null
  private timer: unknown = null
  private stopped = false
  private readonly now: () => number

  constructor(
    private readonly store: TriggerStore,
    private readonly source: { entries(): readonly TriggerSourceEntry[] },
    private readonly runner: TriggerRunner,
    private readonly options: TriggerServiceOptions
  ) {
    this.now = options.now ?? Date.now
  }

  /**
   * Once at startup. Sweep old rows, put events accepted in the previous run and not yet started back in the queue (fix V), and set the re-check tick.
   * An instance that does not run (`autoRun` false) does not touch waiting rows (neither restores nor discards).
   */
  start(): void {
    if (this.stopped) return
    this.reconcileOwners()
    this.narrowRuleTools()
    this.resetStaleInstructions()
    const pending = this.store.recover(this.now())
    if (!this.options.autoRun) {
      log.warn('trigger.autoRun.off', {})
      return
    }
    this.restore(pending)
    const set = this.options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
    this.timer = set(() => this.pump(), TRIGGER_PUMP_MS)
    this.pump()
  }

  /** TODO 1260: rules still holding a retired default instruction go back to following the current default. */
  private resetStaleInstructions(): void {
    for (const d of STALE_DEFAULT_INSTRUCTIONS) {
      const n = this.store.resetStaleInstructions(d.pluginId, d.triggerId, d.texts)
      if (n > 0) log.info('trigger.instructions.reset', { pluginId: d.pluginId, triggerId: d.triggerId, count: n })
    }
  }

  /**
   * Fix V (code-review): put events accepted in the previous run and not yet started (`queued`, and `failed` ones waiting for a retry) back in
   * the queue. An extension never reports an accepted key again, so they would be lost unless restored here. Re-checked before restoring:
   *  - Contents unreadable or failing the shape check (`checkTriggerEvent`) -> discard (`failed`, `interrupted`).
   *  - The attempt count is used up (one that failed midway through shutdown) -> `gave-up`.
   *  - The extension, declaration or rule is disabled -> **discard** (`failed`, `disabled`, delete the contents). Not picked up even if re-enabled - events during
   *    the disabled period are not shown (the same idea as 1217's "mail from before the time it was enabled is not shown"). If the extension reports again, it is accepted.
   *  - The daily limit: a row accepted on a previous day uses today's allowance (a row accepted today was already counted when accepted). The excess is discarded and counted as "passed over for the limit".
   *  - The queue limit (`MAX_TRIGGER_QUEUE`). The excess is likewise passed over.
   * `started` (ended after being started) is not returned by `recover` - the conversation already exists, so it is not started twice.
   */
  private restore(rows: readonly PendingTriggerRow[]): void {
    const now = this.now()
    const today = startOfLocalDay(now)
    const revivedOld = new Map<string, number>()
    let restored = 0
    for (const row of rows) {
      const scope = { pluginId: row.pluginId, triggerId: row.triggerId }
      const checked = row.payload === null ? null : checkTriggerEvent({ ...row.payload, key: `row-${row.id}` })
      if (checked === null || checked.trigger !== row.triggerId) {
        this.store.mark(row.id, 'failed', { reason: 'interrupted', dropPending: true }, now)
        log.info('trigger.restore.dropped', { ...scope, reason: 'unreadable' })
        continue
      }
      if (row.attempts >= TRIGGER_MAX_ATTEMPTS) {
        this.store.mark(row.id, 'gave-up', { reason: 'interrupted' }, now)
        log.info('trigger.restore.dropped', { ...scope, reason: 'attempts' })
        continue
      }
      const found = this.declaration(row.pluginId, row.triggerId)
      const rule = this.store.rule(row.pluginId, row.triggerId)
      if (found === null || !found.entry.enabled || !rule.enabled) {
        this.store.mark(row.id, 'failed', { reason: 'disabled', dropPending: true }, now)
        log.info('trigger.restore.dropped', { ...scope, reason: 'disabled' })
        continue
      }
      const scopeKey = `${row.pluginId}:${row.triggerId}`
      const old = row.createdAt < today
      const overCap =
        old && this.store.acceptedToday(row.pluginId, row.triggerId, now) + (revivedOld.get(scopeKey) ?? 0) >= rule.dailyCap
      if (overCap || this.queue.length >= MAX_TRIGGER_QUEUE) {
        this.store.mark(row.id, 'failed', { reason: 'daily-cap', dropPending: true }, now)
        this.store.noteCapped(row.pluginId, row.triggerId, now)
        log.info('trigger.restore.dropped', { ...scope, reason: 'daily-cap' })
        continue
      }
      if (old) revivedOld.set(scopeKey, (revivedOld.get(scopeKey) ?? 0) + 1)
      const { key: _key, ...event } = checked
      this.queue.push({
        rowId: row.id,
        pluginId: row.pluginId,
        triggerId: row.triggerId,
        event,
        attempts: row.attempts,
        // Rows that were waiting for a retry get a gap from the previous failure.
        notBefore: row.state === 'failed' ? row.updatedAt + (this.options.retryDelayMs ?? TRIGGER_RETRY_DELAY_MS) : now
      })
      restored += 1
    }
    if (rows.length > 0) {
      log.info('trigger.restored', { pending: rows.length, restored })
      this.options.onChanged?.()
    }
  }

  /**
   * TODO 1227 (fix X, code-review): narrow the tool permissions of rules of **currently loaded** extensions to the current candidates (name and fingerprint).
   * Rule rows are not deleted - so that an extension that merely failed to load (manifest validation failure, a temporary failure, a startup that went back to a previous version) does not lose its
   * instruction text, working folder, limit and permissions. That extension's events do not come, so the rule does not run. A row may be deleted only when the
   * user explicitly removes the extension (the current app has no way to delete - 6.2.6). That permissions do not come back to life is guaranteed by the choke point comparing against the
   * current declaration at the time of use (the fingerprint of `TriggerStore.allowsTool`).
   */
  /**
   * TODO 1227 fix X (security review): compare the extension when the rule was written with the current extension by identity, and if they differ (cannot be loaded, swapped,
   * an updated external extension, bundled and external swapped) **revert the rule to disabled and remove the tool permissions** (the row stays).
   * An id and tool names can be claimed by the extension, so when a different thing with the same id and the same name comes in, it does not run until the user enables it again.
   * The screen shows "the extension was not found / changed" (`TriggerRow.autoDisabled`).
   */
  reconcileOwners(): void {
    // Do not match before extension identities have been computed (so a misread does not revert rules to disabled).
    if (!this.ownersReady()) return
    const identities = new Map<string, string | null>()
    for (const entry of this.source.entries()) identities.set(entry.pluginId, entry.identity ?? null)
    const disabled = this.store.reconcileOwners(identities, this.now())
    if (disabled > 0) {
      log.warn('trigger.rules.auto-disabled', { disabled })
      this.options.onChanged?.()
    }
  }

  /**
   * TODO 1233: an extension was uninstalled - remove that extension's events from the queue (memory) and tell the screen.
   * The one item being started (`launching`) is not stopped (the conversation already exists). **Call it after the transaction that deleted the DB rows (rules and waiting events) has
   * committed** (`TriggerStore.forgetPlugin` is inside `PluginHost.uninstall`'s transaction; this is
   * `PluginHostDeps.onPluginForgotten`) - wave 86 fix Y (code-review): when the queue was trimmed inside the transaction, on a rollback
   * the DB still held the waiting events while the queue lost them, and they were silently never started.
   */
  dropPlugin(pluginId: string): void {
    let dropped = 0
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]?.pluginId !== pluginId) continue
      this.queue.splice(i, 1)
      dropped += 1
    }
    log.info('trigger.plugin.dropped', { pluginId, dropped })
    this.options.onChanged?.()
  }

  private narrowRuleTools(): void {
    const allowable = new Map<string, ReadonlyMap<string, string>>()
    for (const entry of this.source.entries()) allowable.set(entry.pluginId, allowableTools(entry))
    const narrowed = this.store.narrowGrants(allowable)
    if (narrowed > 0) log.info('trigger.rules.narrowed', { narrowed })
  }

  /** Shutdown (12.9): accept nothing afterwards, and wait for the one item being started. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      const clear = this.options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
      clear(this.timer)
      this.timer = null
    }
    await this.launching?.catch(() => undefined)
  }

  /** Fix X: whether extension identities have been computed (`TriggerServiceOptions.ownersReady`, omitted is true). */
  private ownersReady(): boolean {
    return this.options.ownersReady?.() ?? true
  }

  private declaration(pluginId: string, triggerId: string): { entry: TriggerSourceEntry; trigger: TriggerDeclaration } | null {
    const entry = this.source.entries().find((item) => item.pluginId === pluginId)
    const trigger = entry?.triggers.find((item) => item.id === triggerId)
    return entry === undefined || trigger === undefined ? null : { entry, trigger }
  }

  /**
   * Accept one event (from the Broker's `triggers.emit`). Declaration and consent are after the Broker has looked. Here: shape, duplicates, rules and limits.
   * **Keys, titles and reference text are not logged** (Conventions).
   */
  async emit(pluginId: string, raw: PluginTriggerEvent): Promise<TriggerEmitResult> {
    if (this.stopped || !this.ownersReady() || !this.options.autoRun) return { accepted: false, reason: 'unavailable' }
    const event = checkTriggerEvent(raw)
    const found = event === null ? null : this.declaration(pluginId, event.trigger)
    if (event === null || found === null || !found.entry.enabled) {
      log.info('trigger.rejected', { pluginId, reason: 'invalid' })
      return { accepted: false, reason: 'invalid' }
    }
    // Fix V: if an optional `cwd` fails the shape check, accept with only the `cwd` dropped (the value is not logged).
    if (raw.cwd !== undefined && event.cwd === undefined) log.info('trigger.cwd.dropped', { pluginId, triggerId: event.trigger, reason: 'shape' })
    const triggerId = event.trigger
    const rule = this.store.rule(pluginId, triggerId)
    if (!rule.enabled) return { accepted: false, reason: 'disabled' }
    // Fix X: an event from an extension other than the one when the rule was enabled (a different thing claiming the same id, or an update) is not accepted, and the rule reverts to disabled.
    if (!sameOwner(found.entry, rule.ownerIdentity)) {
      this.reconcileOwners()
      return { accepted: false, reason: 'disabled' }
    }
    const now = this.now()
    const keyHash = hashTriggerKey(event.key)
    const existing = this.store.lookup(pluginId, triggerId, keyHash)
    // A re-report: only what could not be started before (`failed`) is accepted again. If it is still in the queue, it is a duplicate.
    if (existing !== null && (existing.state !== 'failed' || this.queue.some((item) => item.rowId === existing.id))) {
      return { accepted: false, reason: 'duplicate' }
    }
    // The daily limit (only new keys are counted - a re-accepted row was counted on the day it was accepted). Not carried over; the number passed over is kept.
    if (existing === null && (this.store.acceptedToday(pluginId, triggerId, now) >= rule.dailyCap || this.queue.length >= MAX_TRIGGER_QUEUE)) {
      this.store.noteCapped(pluginId, triggerId, now)
      log.info('trigger.capped', { pluginId, triggerId, cap: rule.dailyCap })
      this.options.onChanged?.()
      return { accepted: false, reason: 'daily-cap' }
    }
    // Fix V: the contents are held in the row until started (to put it back in the queue across an app shutdown). The key is not held.
    const { key: _key, ...payload } = event
    let rowId: number
    let attempts = 0
    if (existing === null) {
      rowId = this.store.insertQueued(pluginId, triggerId, keyHash, now, payload)
    } else {
      rowId = existing.id
      attempts = existing.attempts
      this.store.requeue(rowId, now, payload)
    }
    this.queue.push({ rowId, pluginId, triggerId, event: payload, attempts, notBefore: now })
    log.info('trigger.accepted', { pluginId, triggerId, queued: this.queue.length, retry: existing !== null })
    this.options.onChanged?.()
    this.pump()
    return { accepted: true }
  }

  /** Look at the queue and start one item if possible. May be called any number of times (tick, event, end of a turn). */
  pump(): void {
    if (this.stopped || this.launching !== null) return
    if (this.activeThreadId !== null && this.runner.isUnattended(this.activeThreadId)) return
    const now = this.now()
    const index = this.queue.findIndex((item) => item.notBefore <= now)
    if (index < 0) return
    if (!this.runner.hasRoom()) return
    const [item] = this.queue.splice(index, 1)
    if (item === undefined) return
    const launching = this.launch(item).finally(() => {
      if (this.launching === launching) this.launching = null
      this.options.onChanged?.()
      // If there were items that could not be started, go on to the next (those that were started wait for the end of the first turn).
      queueMicrotask(() => this.pump())
    })
    this.launching = launching
  }

  private async launch(item: QueueItem): Promise<void> {
    const found = this.declaration(item.pluginId, item.triggerId)
    const rule = this.store.rule(item.pluginId, item.triggerId)
    // While waiting, the extension or the rule became disabled, or the extension was swapped (fix X): do not start (the contents are discarded. If reported again it is accepted - fix V).
    if (found === null || !found.entry.enabled || !rule.enabled || !sameOwner(found.entry, rule.ownerIdentity)) {
      this.store.mark(item.rowId, 'failed', { reason: 'disabled', dropPending: true }, this.now())
      log.info('trigger.dropped', { pluginId: item.pluginId, triggerId: item.triggerId, reason: 'disabled' })
      return
    }
    const cwd = this.pickCwd(item.event.cwd ?? null, rule.cwd)
    const prompt = composeTriggerPrompt({
      pluginName: found.entry.pluginName,
      triggerName: found.trigger.name,
      instructions: rule.instructions ?? found.trigger.defaultPrompt ?? '',
      event: item.event
    })
    item.attempts += 1
    try {
      const threadId = await this.runner.run({
        pluginId: item.pluginId,
        triggerId: item.triggerId,
        triggerName: found.trigger.name,
        title: item.event.title,
        url: item.event.url ?? null,
        cwd,
        prompt,
        modelId: rule.modelId,
        thinking: rule.thinking
      })
      this.activeThreadId = threadId
      this.store.mark(item.rowId, 'started', { threadId, attempt: true }, this.now())
      log.info('trigger.started', { pluginId: item.pluginId, triggerId: item.triggerId, threadId })
    } catch (err) {
      const code = parseReason(err instanceof Error ? err.message : '')?.code ?? 'error'
      const gaveUp = item.attempts >= TRIGGER_MAX_ATTEMPTS || this.stopped
      this.store.mark(item.rowId, gaveUp && !this.stopped ? 'gave-up' : 'failed', { reason: code, attempt: true }, this.now())
      log.warn('trigger.failed', {
        pluginId: item.pluginId,
        triggerId: item.triggerId,
        attempts: item.attempts,
        gaveUp,
        reason: code,
        ...errorFields(err)
      })
      if (!gaveUp) {
        item.notBefore = this.now() + (this.options.retryDelayMs ?? TRIGGER_RETRY_DELAY_MS)
        this.queue.push(item)
      }
    }
  }

  /**
   * Decide the working folder (fix X, security review). **The rule's working folder is authoritative** (the one the user chose). The working folder is
   * the execution context that selects that project's settings, `.mcp.json` and instruction files, so a value from outside (an extension's event) must not choose it:
   *  - The rule has no working folder or it cannot be used -> no affiliation (the event's working folder is **not accepted**).
   *  - The event's working folder is accepted only when its real path (realpath, symlinks resolved) is the same as or inside the rule's working folder's real path
   *    (the resolved path is what is accepted - so even if a symlink is swapped before starting, it does not get outside). Otherwise the rule's working folder.
   *  - Both are re-checked with `cwdAllowed` (FsAccess).
   */
  private pickCwd(fromEvent: string | null, fromRule: string | null): string | null {
    if (fromRule === null || !this.options.cwdAllowed(fromRule)) return null
    if (fromEvent === null) return fromRule
    const realpath = this.options.realpath ?? defaultRealpath
    const ruleReal = realpath(fromRule)
    // A relative name (TODO 1218) is resolved under the rule's working folder. Whether absolute or relative, the same check sees whether the real path is inside the rule's.
    // Absolute vs relative is decided by `path.isAbsolute` (the event shape check `isPosixAbsoluteCwd` passes only names starting with `/` as absolute, so they do not disagree).
    const eventReal = realpath(isAbsolute(fromEvent) ? fromEvent : join(fromRule, fromEvent))
    if (ruleReal !== null && eventReal !== null && isWithin(eventReal, ruleReal) && this.options.cwdAllowed(eventReal)) {
      return eventReal
    }
    log.info('trigger.cwd.ignored', { reason: ruleReal === null || eventReal === null ? 'unresolved' : 'outside-rule' })
    return fromRule
  }

  /** The list (the "Triggers" section of the scheduled-runs view). All declarations of installed extensions. */
  overview(): TriggerOverview {
    const now = this.now()
    const rows: TriggerRow[] = []
    for (const entry of this.source.entries()) {
      for (const trigger of entry.triggers) {
        const stats = this.store.stats(entry.pluginId, trigger.id, now)
        rows.push({
          pluginId: entry.pluginId,
          triggerId: trigger.id,
          pluginName: entry.pluginName,
          name: trigger.name,
          description: trigger.description ?? null,
          defaultPrompt: trigger.defaultPrompt ?? null,
          pluginEnabled: entry.enabled,
          bundled: entry.bundled === true,
          toolChoices: triggerToolChoices(entry),
          rule: this.viewRule(entry, trigger.id),
          autoDisabled: this.pendingOwnerReason(entry, trigger.id),
          today: { accepted: stats.accepted, capped: stats.capped },
          lastAcceptedAt: stats.lastAcceptedAt,
          lastThreadId: stats.lastThreadId,
          failedRecent: stats.failedRecent
        })
      }
    }
    return { autoRun: this.options.autoRun, queued: this.queue.length, triggers: rows }
  }

  /**
   * The rule passed to the renderer. Tool permissions show only those whose fingerprint matches the current candidates (a permission that stopped taking effect because the declaration changed
   * is not shown as "allowed" - including changes by an update after startup, after the startup narrowing).
   */
  private viewRule(entry: TriggerSourceEntry, triggerId: string): TriggerRule {
    const rule = this.store.ruleForView(entry.pluginId, triggerId)
    // Fix X: if it is a different extension from when the rule was written, do not show it as enabled or as having permissions (events are not accepted, and the choke point's fingerprint includes the identity too).
    if (!sameOwner(entry, this.store.rule(entry.pluginId, triggerId).ownerIdentity)) return { ...rule, enabled: false, allowedTools: [] }
    const allowable = allowableTools(entry)
    const live = this.store
      .grants(entry.pluginId, triggerId)
      .filter((grant) => allowable.get(grant.name) === grant.fingerprint)
      .map((grant) => grant.name)
    return { ...rule, allowedTools: live }
  }

  /**
   * TODO 1227 fix X (security review): the reason the user's confirmation is needed to re-enable a rule. The mark that aios reverted it (`auto_disabled`) if present
   * (it does not disappear even if the real one comes back); if it has not been reverted yet (before the match, etc.) but the extension differs from when it was written and is enabled or has permissions,
   * `plugin-changed`. Otherwise null.
   */
  private pendingOwnerReason(entry: TriggerSourceEntry, triggerId: string): TriggerAutoDisabled | null {
    const stored = this.store.rule(entry.pluginId, triggerId)
    // The mark stays until the user enables it again, even if the owner is the same again (the real one came back).
    if (stored.autoDisabled !== null) return stored.autoDisabled
    if (sameOwner(entry, stored.ownerIdentity)) return null
    return stored.enabled || this.store.grants(entry.pluginId, triggerId).length > 0 ? 'plugin-changed' : null
  }

  /**
   * Write a rule (an edit from the renderer). A trigger that is not in the declaration is refused. The working folder is after the IPC has checked it.
   * TODO 1227: tools allowed in an unattended turn are only **tools without `sideEffect` that the extension itself declares now, and only when the extension is not bundled**
   * (`triggerToolChoices`). If there is even one tool of another extension, one with side effects, or an unknown name, it is refused (the renderer's value is not trusted).
   */
  updateRule(
    pluginId: string,
    triggerId: string,
    input: TriggerRule,
    acknowledged: TriggerAutoDisabled | null = null
  ): TriggerOverview {
    const found = this.declaration(pluginId, triggerId)
    if (found === null) throw reasonError('invalid-value', { field: 'trigger' })
    let rule = input
    const choices = allowableTools(found.entry)
    if (rule.allowedTools.some((name) => !choices.has(name))) {
      log.warn('trigger.rule.tools.rejected', { pluginId, triggerId })
      throw reasonError('invalid-value', { field: 'allowedTools' })
    }
    // Fix X: permissions are kept as pairs of the name and the fingerprint of the current declaration (the choke point compares at the time of use).
    // A rule of an extension whose identity cannot be read cannot be enabled (even if written, it would revert to disabled at the next startup or event - refusing is better than silently reverting).
    if ((found.entry.identity ?? null) === null && (rule.enabled || rule.allowedTools.length > 0)) {
      log.warn('trigger.rule.owner.unknown', { pluginId, triggerId })
      throw reasonError('invalid-value', { field: 'plugin' })
    }
    // Fix X (security review): first match against the current extension. A rule tied to an extension different from when it was written (it was enabled or had permissions)
    // is re-tied to the current extension only when the user has seen "disabled because the extension changed / was not found" (`acknowledged` equals the current reason)
    // and enables it again. Otherwise (a save from a stale screen, switching the list, etc.) it is forced to disabled with no permissions,
    // and the mark and the previous owner are kept (consent is not silently moved to a different thing).
    this.reconcileOwners()
    const pending = this.pendingOwnerReason(found.entry, triggerId)
    const reenabling = rule.enabled || rule.allowedTools.length > 0
    if (pending !== null && !(reenabling && acknowledged === pending)) {
      if (reenabling) log.warn('trigger.rule.owner.unacknowledged', { pluginId, triggerId, reason: pending })
      rule = { ...rule, enabled: false, allowedTools: [] }
      this.store.setRule(pluginId, triggerId, rule, this.now(), {
        ownerIdentity: this.store.rule(pluginId, triggerId).ownerIdentity,
        autoDisabled: pending
      })
    } else {
      // Also keep the identity of the extension at the time of writing (if it becomes a different extension, it reverts to disabled).
      this.store.setRule(pluginId, triggerId, rule, this.now(), { fingerprints: choices, ownerIdentity: found.entry.identity ?? null })
    }
    log.info('trigger.rule.updated', {
      pluginId,
      triggerId,
      enabled: rule.enabled,
      cap: rule.dailyCap,
      allowedTools: rule.allowedTools.length
    })
    this.options.onChanged?.()
    return this.overview()
  }
}

/** `fs.realpathSync.native` (null for a path that is missing or unreadable). */
function defaultRealpath(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/** Whether `child` is the same as or inside `parent` (both are real paths of absolute paths). A folder whose name starts with `..` is not mistaken for outside. */
export function isWithin(child: string, parent: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(parent)) return false
  const rel = relative(parent, child)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
