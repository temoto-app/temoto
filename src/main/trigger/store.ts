/**
 * Trigger tables (migration 35 `trigger_rules` / `trigger_events`, TODO 1216, ARCHITECTURE 6.2.6).
 *
 * **Does not depend on electron.** The only writer is this entry point in main (not the index DB, so constraint 8.1 does not apply).
 *
 * - `trigger_rules`: the user's rules (one per trigger). With no row the default applies (`DEFAULT_TRIGGER_RULE` = disabled). The working folder is
 *   stored as a path and converted to a URI when handed to the renderer. `capped_day` / `capped_count` are "how many were skipped today because of the limit" (not carried over).
 * - `trigger_events`: deduplication and the per-day count. **The key is only a SHA-256** — no body is kept (constraint 9).
 *   Fix V (code-review, migration 36): only while an event is accepted but not yet fired, the event contents (`pending`: title, URL, working folder,
 *   reference text; the title and reference text are after redaction; the key is not kept) are stored, and put back in the queue after a restart (returned by `recover`).
 *   Once fired, given up, or dropped, `pending` goes back to NULL.
 */
import { createHash } from 'node:crypto'
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import { isThinkingLevel } from '@shared/agent.js'
import {
  checkAllowedToolNames,
  DEFAULT_TRIGGER_RULE,
  localDay,
  startOfLocalDay,
  isTriggerAutoDisabled,
  type PluginTriggerEvent,
  type TriggerAutoDisabled,
  type TriggerRule
} from '@shared/trigger.js'
import { redactText } from '@shared/redact.js'
import { pathToUri, uriToPath } from '../../common/uri.js'

export type TriggerEventState =
  /** Received and sitting in the queue (in memory). */
  | 'queued'
  /** A conversation was started and its first message sent. */
  | 'started'
  /** Could not start. If attempts remain it is retried from the queue; if notified again it is accepted again. */
  | 'failed'
  /** Attempts used up. The same key is not accepted again. */
  | 'gave-up'

/** Cleanup: event rows older than this are deleted (if the same key arrives again it is accepted as a new event). */
export const TRIGGER_EVENT_RETENTION_MS = 180 * 24 * 60 * 60_000
/** The window over which the list counts "given up" events. */
export const TRIGGER_FAILED_WINDOW_MS = 7 * 24 * 60 * 60_000

/** A rule row (main's shape; the working folder is a path). */
export interface StoredTriggerRule {
  readonly enabled: boolean
  readonly instructions: string | null
  readonly cwd: string | null
  readonly modelId: string | null
  readonly thinking: TriggerRule['thinking']
  readonly dailyCap: number
  /** TODO 1227: names of the extension's own tools that this rule allows in unattended turns (migration 38). */
  readonly allowedTools: readonly string[]
  /**
   * TODO 1227 fix X (migration 39): the extension's identity when the rule was written (`PluginHost.identityOf`). Null for old rows and defaults.
   * `TriggerService` compares it with the current identity and, if different, turns the rule back to disabled (`autoDisable`).
   */
  readonly ownerIdentity: string | null
  /** TODO 1227 fix X (migration 39): why aios turned it back to disabled. Null if the user wrote the rule. */
  readonly autoDisabled: TriggerAutoDisabled | null
}

/** Contents of a waiting event (fix V). The key is not kept (deduplication uses `key_hash`). */
export type TriggerPayload = Omit<PluginTriggerEvent, 'key'>

/** A candidate row to put back in the queue after a restart (returned by `recover`). */
export interface PendingTriggerRow {
  readonly id: number
  readonly pluginId: string
  readonly triggerId: string
  readonly state: 'queued' | 'failed'
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  /** The contents. Null if the shape is unreadable (the caller drops it). */
  readonly payload: TriggerPayload | null
}

/** Serialize the contents as JSON (the title and reference text are redacted: constraint 10, "mask before saving"). */
export function encodeTriggerPayload(payload: TriggerPayload): string {
  return JSON.stringify({
    trigger: payload.trigger,
    title: redactText(payload.title).text,
    ...(payload.url === undefined ? {} : { url: payload.url }),
    ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
    prompt: redactText(payload.prompt).text
  })
}

/** Inverse of `encodeTriggerPayload`. Null if the shape is wrong (re-validating the shape is the caller's `checkTriggerEvent`). */
export function decodeTriggerPayload(raw: string | null): TriggerPayload | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value !== 'object' || value === null) return null
    const { trigger, title, url, cwd, prompt } = value
    if (typeof trigger !== 'string' || typeof title !== 'string' || typeof prompt !== 'string') return null
    if (url !== undefined && typeof url !== 'string') return null
    if (cwd !== undefined && typeof cwd !== 'string') return null
    return {
      trigger,
      title,
      prompt,
      ...(typeof url === 'string' ? { url } : {}),
      ...(typeof cwd === 'string' ? { cwd } : {})
    }
  } catch {
    return null
  }
}

export interface TriggerStats {
  readonly accepted: number
  readonly capped: number
  readonly lastAcceptedAt: number | null
  readonly lastThreadId: string | null
  readonly failedRecent: number
}

/** The deduplication key. The extension's key string itself is not kept. */
export function hashTriggerKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

interface RuleRow {
  enabled: number
  instructions: string | null
  cwd: string | null
  model_id: string | null
  thinking: string | null
  daily_cap: number
  capped_day: string | null
  capped_count: number
  allowed_tools: string | null
  owner_identity: string | null
  auto_disabled: string | null
}

/**
 * One tool a rule allowed (TODO 1227): its name, plus the fingerprint of the tool declaration at the time it was allowed (`pluginToolFingerprint`, fix X).
 * At use time the choke point compares it with the current tool's fingerprint (it does not pass if the declaration changed or a different extension took over the same id).
 */
export interface AllowedToolGrant {
  readonly name: string
  readonly fingerprint: string
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/

/**
 * Read `trigger_rules.allowed_tools`. JSON of `[{ "name": …, "fp": … }]`. Empty if the shape is wrong (fails toward allowing nothing).
 * The names-only array (no fingerprints) written by bundle D's first version is also empty: it is unknown which declaration the permission was for, so the user has to allow it again.
 */
export function decodeAllowedToolGrants(raw: string | null): readonly AllowedToolGrant[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const names: unknown[] = []
    const grants: AllowedToolGrant[] = []
    for (const item of value as unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const { name, fp } = item as Record<string, unknown>
      if (typeof fp !== 'string' || !FINGERPRINT_RE.test(fp)) return []
      names.push(name)
      grants.push({ name: name as string, fingerprint: fp })
    }
    // Same validation as the renderer's entry point for the shape and number of names (`checkAllowedToolNames`). Duplicates are not read.
    const checked = checkAllowedToolNames(names)
    return checked === null || checked.length !== grants.length ? [] : grants
  } catch {
    return []
  }
}

/** Names only (for showing and counting rules on screen). */
export function decodeAllowedTools(raw: string | null): readonly string[] {
  return decodeAllowedToolGrants(raw).map((grant) => grant.name)
}

function encodeAllowedToolGrants(grants: readonly AllowedToolGrant[]): string | null {
  return grants.length === 0 ? null : JSON.stringify(grants.map((grant) => ({ name: grant.name, fp: grant.fingerprint })))
}

export class TriggerStore {
  private readonly selectRule: Statement
  private readonly upsertRule: Statement
  private readonly bumpCapped: Statement
  private readonly selectEvent: Statement
  private readonly insertEvent: Statement
  private readonly requeueEvent: Statement
  private readonly updateEvent: Statement
  private readonly countSince: Statement
  private readonly selectLast: Statement
  private readonly countFailed: Statement
  private readonly failQueued: Statement
  private readonly selectPending: Statement
  private readonly sweepEvents: Statement

  /**
   * TODO 1260: reset instructions that exactly equal a retired default to NULL ("follow the extension's default"). Returns the rows changed.
   * Idempotent: once reset, the row no longer matches, so running it on every start changes nothing.
   */
  resetStaleInstructions(pluginId: string, triggerId: string, staleTexts: readonly string[]): number {
    if (staleTexts.length === 0) return 0
    const marks = staleTexts.map(() => '?').join(',')
    const r = this.db
      .prepare(
        `UPDATE trigger_rules SET instructions = NULL WHERE plugin_id = ? AND trigger_id = ? AND instructions IN (${marks})`
      )
      .run(pluginId, triggerId, ...staleTexts)
    return r.changes
  }

  constructor(private readonly db: Database) {
    this.selectRule = db.prepare(
      `SELECT enabled, instructions, cwd, model_id, thinking, daily_cap, capped_day, capped_count, allowed_tools,
         owner_identity, auto_disabled
       FROM trigger_rules WHERE plugin_id = ? AND trigger_id = ?`
    )
    this.upsertRule = db.prepare(`
      INSERT INTO trigger_rules (plugin_id, trigger_id, enabled, instructions, cwd, model_id, thinking, daily_cap, allowed_tools,
        owner_identity, auto_disabled, updated_at)
      VALUES (@plugin_id, @trigger_id, @enabled, @instructions, @cwd, @model_id, @thinking, @daily_cap, @allowed_tools,
        @owner_identity, @auto_disabled, @now)
      ON CONFLICT(plugin_id, trigger_id) DO UPDATE SET
        enabled = excluded.enabled, instructions = excluded.instructions, cwd = excluded.cwd,
        model_id = excluded.model_id, thinking = excluded.thinking, daily_cap = excluded.daily_cap,
        allowed_tools = excluded.allowed_tools, owner_identity = excluded.owner_identity, auto_disabled = excluded.auto_disabled,
        updated_at = excluded.updated_at
    `)
    // If there is no row, create a default (disabled) row first and then count (a disabled rule never hits the limit, but for the sake of shape).
    this.bumpCapped = db.prepare(`
      INSERT INTO trigger_rules (plugin_id, trigger_id, capped_day, capped_count, updated_at)
      VALUES (@plugin_id, @trigger_id, @day, 1, @now)
      ON CONFLICT(plugin_id, trigger_id) DO UPDATE SET
        capped_count = CASE WHEN capped_day = excluded.capped_day THEN capped_count + 1 ELSE 1 END,
        capped_day = excluded.capped_day
    `)
    this.selectEvent = db.prepare(
      `SELECT id, state, attempts FROM trigger_events WHERE plugin_id = ? AND trigger_id = ? AND key_hash = ?`
    )
    this.insertEvent = db.prepare(`
      INSERT INTO trigger_events (plugin_id, trigger_id, key_hash, state, attempts, created_at, updated_at, pending)
      VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
    `)
    this.requeueEvent = db.prepare(
      `UPDATE trigger_events SET state = 'queued', reason = NULL, updated_at = ?, pending = ? WHERE id = ?`
    )
    this.updateEvent = db.prepare(`
      UPDATE trigger_events SET state = @state, thread_id = COALESCE(@thread_id, thread_id), reason = @reason,
        attempts = attempts + @attempt, updated_at = @now,
        pending = CASE WHEN @clear_pending = 1 THEN NULL ELSE pending END
      WHERE id = @id
    `)
    this.countSince = db.prepare(
      `SELECT COUNT(*) AS n FROM trigger_events WHERE plugin_id = ? AND trigger_id = ? AND created_at >= ?`
    )
    this.selectLast = db.prepare(
      `SELECT created_at, (SELECT thread_id FROM trigger_events t2
          WHERE t2.plugin_id = t1.plugin_id AND t2.trigger_id = t1.trigger_id AND t2.thread_id IS NOT NULL
          ORDER BY t2.updated_at DESC LIMIT 1) AS last_thread
       FROM trigger_events t1 WHERE plugin_id = ? AND trigger_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    this.countFailed = db.prepare(
      `SELECT COUNT(*) AS n FROM trigger_events
       WHERE plugin_id = ? AND trigger_id = ? AND state = 'gave-up' AND updated_at >= ?`
    )
    // A `queued` row with no contents (from before migration 36) cannot be restored, so as before it falls to `failed`.
    this.failQueued = db.prepare(
      `UPDATE trigger_events SET state = 'failed', reason = 'interrupted', updated_at = ? WHERE state = 'queued' AND pending IS NULL`
    )
    this.selectPending = db.prepare(
      `SELECT id, plugin_id, trigger_id, state, attempts, created_at, updated_at, pending FROM trigger_events
       WHERE pending IS NOT NULL AND state IN ('queued', 'failed') ORDER BY created_at, id`
    )
    this.sweepEvents = db.prepare(`DELETE FROM trigger_events WHERE created_at < ?`)
  }

  rule(pluginId: string, triggerId: string): StoredTriggerRule {
    const row = this.selectRule.get(pluginId, triggerId) as RuleRow | undefined
    if (row === undefined) {
      const { cwdUri: _cwdUri, ...defaults } = DEFAULT_TRIGGER_RULE
      return { ...defaults, cwd: null, ownerIdentity: null, autoDisabled: null }
    }
    return {
      enabled: row.enabled === 1,
      instructions: row.instructions,
      cwd: row.cwd,
      modelId: row.model_id,
      thinking: isThinkingLevel(row.thinking) ? row.thinking : null,
      dailyCap: row.daily_cap,
      allowedTools: decodeAllowedTools(row.allowed_tools),
      ownerIdentity: row.owner_identity,
      autoDisabled: isTriggerAutoDisabled(row.auto_disabled) ? row.auto_disabled : null
    }
  }

  /** The shape handed to the renderer (the working folder is a URI). */
  ruleForView(pluginId: string, triggerId: string): TriggerRule {
    const { cwd, ownerIdentity: _owner, autoDisabled: _auto, ...rest } = this.rule(pluginId, triggerId)
    return { ...rest, cwdUri: cwd === null ? null : pathToUri(cwd) }
  }

  /** TODO 1227: the tools the rule allowed (name and fingerprint). */
  grants(pluginId: string, triggerId: string): readonly AllowedToolGrant[] {
    const row = this.selectRule.get(pluginId, triggerId) as RuleRow | undefined
    return row === undefined ? [] : decodeAllowedToolGrants(row.allowed_tools)
  }

  /**
   * Write a rule. Validating the working folder is up to the caller (IPC does `FsAccess.assertAllowed`).
   * TODO 1227 (fix X): the names in `rule.allowedTools` are stored paired with `fingerprints` (name -> fingerprint of the current tool declaration).
   * A name with no fingerprint is not stored (the caller `TriggerService.updateRule` has already validated against the current candidates).
   * `ownerIdentity` is the extension's identity at write time (migration 39). `autoDisabled` is the mark that aios turned the rule back to disabled; omitting it clears it
   * (the user wrote it). The mark is kept only when rewriting a rule with a different owner while it stays disabled (`TriggerService.updateRule`).
   */
  setRule(
    pluginId: string,
    triggerId: string,
    rule: TriggerRule,
    now: number = Date.now(),
    owner: {
      readonly fingerprints?: ReadonlyMap<string, string>
      readonly ownerIdentity?: string | null
      readonly autoDisabled?: TriggerAutoDisabled | null
    } = {}
  ): void {
    const fingerprints = owner.fingerprints ?? new Map<string, string>()
    const grants = rule.allowedTools.flatMap((name) => {
      const fingerprint = fingerprints.get(name)
      return fingerprint === undefined || !FINGERPRINT_RE.test(fingerprint) ? [] : [{ name, fingerprint }]
    })
    this.upsertRule.run({
      plugin_id: pluginId,
      trigger_id: triggerId,
      enabled: rule.enabled ? 1 : 0,
      instructions: rule.instructions,
      cwd: rule.cwdUri === null ? null : uriToPath(rule.cwdUri),
      model_id: rule.modelId,
      thinking: rule.thinking,
      daily_cap: rule.dailyCap,
      allowed_tools: encodeAllowedToolGrants(grants),
      owner_identity: owner.ownerIdentity ?? null,
      auto_disabled: owner.autoDisabled ?? null,
      now
    })
  }

  /**
   * TODO 1227: in an unattended turn, does the rule (`pluginId`, `triggerId`) allow the extension's own tool `toolName`?
   * Fix X: true only when not just the name but the fingerprint `fingerprint` of the **currently loaded** tool declaration equals the one at the time it was allowed.
   * False if the row is missing, the shape is unreadable, the name is absent, or the fingerprint differs. **Whether it is the same extension's tool, has no side effects, or is bundled is checked by the caller's choke point.**
   */
  allowsTool(pluginId: string, triggerId: string, toolName: string, fingerprint: string): boolean {
    if (!FINGERPRINT_RE.test(fingerprint)) return false
    return this.grants(pluginId, triggerId).some((grant) => grant.name === toolName && grant.fingerprint === fingerprint)
  }

  /**
   * TODO 1227 (fix X, code-review): at startup, narrow the rules' tool permissions for the extensions that are **currently loaded** to the current candidates (`allowable`:
   * extension id -> tool name -> fingerprint). Drops permissions for names not among the candidates or with a different fingerprint (so that permissions for a removed tool, a tool that gained side effects, or a tool whose
   * declaration changed cannot come back to life later).
   * **Rule rows are not deleted** — rows of extensions not in `allowable` (failed to load, or removed) are left alone. This keeps the user's instruction text and settings through manifest validation failures,
   * transient load failures, and a launch that rolled back to the previous version. No events arrive for them, so they do not run.
   * Returns the number of rows fixed.
   */
  narrowGrants(allowable: ReadonlyMap<string, ReadonlyMap<string, string>>): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT plugin_id, trigger_id, allowed_tools FROM trigger_rules WHERE allowed_tools IS NOT NULL`).all() as {
        plugin_id: string
        trigger_id: string
        allowed_tools: string
      }[]
      const narrow = this.db.prepare(`UPDATE trigger_rules SET allowed_tools = ? WHERE plugin_id = ? AND trigger_id = ?`)
      let narrowed = 0
      for (const row of rows) {
        const tools = allowable.get(row.plugin_id)
        if (tools === undefined) continue
        const current = decodeAllowedToolGrants(row.allowed_tools)
        const kept = current.filter((grant) => tools.get(grant.name) === grant.fingerprint)
        const encoded = encodeAllowedToolGrants(kept)
        if (encoded !== row.allowed_tools) {
          narrow.run(encoded, row.plugin_id, row.trigger_id)
          narrowed += 1
        }
      }
      return narrowed
    })()
  }

  /**
   * TODO 1227 fix X (security review): compare the rule's identity with the current extension. `identities` maps loaded extension
   * id -> identity (null if unreadable). For rows that are enabled or hold tool permissions:
   *  - extension not loaded -> `plugin-missing`,
   *  - identity differs from when it was written (unreadable, updated, swapped, swapped between bundled and external) -> `plugin-changed`
   * and the rule is **turned back to disabled and its tool permissions removed** (instruction text, working folder, model, and limit stay — the row is not deleted). A row with no identity from write time
   * (before migration 39) gets the current value filled in if it is now bundled (`bundled`, decided by location), and `plugin-changed` if external.
   * Returns the number of rows turned back.
   */
  reconcileOwners(identities: ReadonlyMap<string, string | null>, now: number = Date.now()): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT plugin_id, trigger_id, owner_identity FROM trigger_rules WHERE enabled = 1 OR allowed_tools IS NOT NULL`)
        .all() as { plugin_id: string; trigger_id: string; owner_identity: string | null }[]
      const disable = this.db.prepare(
        `UPDATE trigger_rules SET enabled = 0, allowed_tools = NULL, auto_disabled = ?, updated_at = ? WHERE plugin_id = ? AND trigger_id = ?`
      )
      const adopt = this.db.prepare(`UPDATE trigger_rules SET owner_identity = ? WHERE plugin_id = ? AND trigger_id = ?`)
      let disabled = 0
      for (const row of rows) {
        const loaded = identities.has(row.plugin_id)
        const current = identities.get(row.plugin_id) ?? null
        if (loaded && current !== null && row.owner_identity === current) continue
        if (loaded && current === 'bundled' && row.owner_identity === null) {
          adopt.run(current, row.plugin_id, row.trigger_id)
          continue
        }
        disable.run(loaded ? 'plugin-changed' : 'plugin-missing', now, row.plugin_id, row.trigger_id)
        disabled += 1
      }
      return disabled
    })()
  }

  /**
   * TODO 1233 (ARCHITECTURE 6.2.6 / 7.2): the user uninstalled an extension — **delete that extension's rule rows** (instruction text, working folder,
   * limit, tool permissions, and owner identity included). Events accepted but not yet fired drop their contents and become `failed` (`disabled`)
   * (not restored across launches). Event rows (key digest, the conversation it started) stay for deduplication and history. If the same extension is reinstalled,
   * its rules start from the default (disabled). Runs inside the caller's (`PluginHost.uninstall`) transaction. Returns the number of rules deleted.
   */
  forgetPlugin(pluginId: string, now: number = Date.now()): number {
    this.db
      .prepare(
        `UPDATE trigger_events SET state = 'failed', reason = 'disabled', pending = NULL, updated_at = ?
         WHERE plugin_id = ? AND pending IS NOT NULL AND state IN ('queued', 'failed')`
      )
      .run(now, pluginId)
    return this.db.prepare(`DELETE FROM trigger_rules WHERE plugin_id = ?`).run(pluginId).changes
  }

  /** Count one event skipped because of the limit (today's count only; resets to 1 when the day changes). */
  noteCapped(pluginId: string, triggerId: string, now: number = Date.now()): void {
    this.bumpCapped.run({ plugin_id: pluginId, trigger_id: triggerId, day: localDay(now), now })
  }

  /** The number accepted today (local time). */
  acceptedToday(pluginId: string, triggerId: string, now: number = Date.now()): number {
    return (this.countSince.get(pluginId, triggerId, startOfLocalDay(now)) as { n: number }).n
  }

  /**
   * Look up a key. Null if absent. `queued` / `started` / `gave-up` are duplicates; `failed` may be accepted as a re-notification.
   */
  lookup(pluginId: string, triggerId: string, keyHash: string): { id: number; state: TriggerEventState; attempts: number } | null {
    const row = this.selectEvent.get(pluginId, triggerId, keyHash) as
      | { id: number; state: TriggerEventState; attempts: number }
      | undefined
    return row ?? null
  }

  /**
   * Insert a new event as `queued` (the key is a unique index). Returns the row id. `payload` is the contents kept until it fires (fix V).
   * Omitting it means no contents (after a restart it falls to `failed`).
   */
  insertQueued(
    pluginId: string,
    triggerId: string,
    keyHash: string,
    now: number = Date.now(),
    payload: TriggerPayload | null = null
  ): number {
    const result = this.insertEvent.run(
      pluginId,
      triggerId,
      keyHash,
      now,
      now,
      payload === null ? null : encodeTriggerPayload(payload)
    )
    return Number(result.lastInsertRowid)
  }

  /** Put a `failed` row back in the queue (it was notified again). The contents are replaced by those of the new notification. */
  requeue(id: number, now: number = Date.now(), payload: TriggerPayload | null = null): void {
    this.requeueEvent.run(now, payload === null ? null : encodeTriggerPayload(payload), id)
  }

  /**
   * Fired or failed to fire. `attempt` is true when this counts as one attempt. The contents (`pending`) are kept only while the row is `failed` and waiting for a retry;
   * otherwise (`started` / `gave-up`) and with `dropPending` (dropped: disabled, limit, unreadable) they are cleared (fix V).
   */
  mark(
    id: number,
    state: TriggerEventState,
    options: { threadId?: string | null; reason?: string | null; attempt?: boolean; dropPending?: boolean } = {},
    now: number = Date.now()
  ): void {
    this.updateEvent.run({
      id,
      state,
      thread_id: options.threadId ?? null,
      reason: options.reason ?? null,
      attempt: options.attempt === true ? 1 : 0,
      clear_pending: state !== 'failed' || options.dropPending === true ? 1 : 0,
      now
    })
  }

  stats(pluginId: string, triggerId: string, now: number = Date.now()): TriggerStats {
    const rule = this.selectRule.get(pluginId, triggerId) as RuleRow | undefined
    const last = this.selectLast.get(pluginId, triggerId) as { created_at: number; last_thread: string | null } | undefined
    return {
      accepted: this.acceptedToday(pluginId, triggerId, now),
      capped: rule !== undefined && rule.capped_day === localDay(now) ? rule.capped_count : 0,
      lastAcceptedAt: last?.created_at ?? null,
      lastThreadId: last?.last_thread ?? null,
      failedRecent: (this.countFailed.get(pluginId, triggerId, now - TRIGGER_FAILED_WINDOW_MS) as { n: number }).n
    }
  }

  /**
   * Startup cleanup: delete old rows, turn `queued` rows with no contents (from before migration 36) into `failed`, and return **the waiting rows that hold contents**
   * (`queued`, and `failed` waiting for a retry) oldest first (fix V). `TriggerService.start` decides whether to put them back in the queue or drop them.
   * `started` (finished after firing) is not returned — the conversation already exists, so it is not started twice.
   */
  recover(now: number = Date.now()): PendingTriggerRow[] {
    return this.db.transaction(() => {
      this.sweepEvents.run(now - TRIGGER_EVENT_RETENTION_MS)
      this.failQueued.run(now)
      const rows = this.selectPending.all() as {
        id: number
        plugin_id: string
        trigger_id: string
        state: 'queued' | 'failed'
        attempts: number
        created_at: number
        updated_at: number
        pending: string | null
      }[]
      return rows.map((row) => ({
        id: row.id,
        pluginId: row.plugin_id,
        triggerId: row.trigger_id,
        state: row.state,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: decodeTriggerPayload(row.pending)
      }))
    })()
  }
}
