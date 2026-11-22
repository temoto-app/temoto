/**
 * ApprovalBroker — the approval inbox (ARCHITECTURE.md 4.2).
 *
 * Precise definition: **when a permission prompt occurs, it manages the response in one place.**
 * It is not "every dangerous operation passes through here". Commands judged read-only and
 * reads of already-allowed directories are judged by the CLI itself to need no approval and never
 * arrive (spike 9b). **aios cannot decide which operations go through approval.**
 * For auditing, every `tool_use` is kept in `thread_events`, and whether it was approved is stored as an attribute.
 *
 * T12 turned the inbox from "a place that stops everything by default" into "**a place where you choose what to stop**",
 * and **T40 went further and made "ask as little as possible" the default**. An incoming request is handled in this order:
 *
 * 1. **Questions that ask for an answer** (4.2.2) are always queued ("letting it through" would mean "not answering").
 *    **Plan proposals** (4.2.3, item 112) are always queued only when the user turned Plan ON in that thread
 *    (they asked to see the plan). Since **item 167 (2026-09-27)**, a plan that the AI produced by entering plan mode on its
 *    own while Plan is OFF is treated like any other tool (2. to 5. below) -
 *    with the default allow-everything it passes as `by: 'default'`, and the plan text stays in the timeline
 *    (`tool_use.payload.plan`). In a strict-mode thread it is queued.
 *    **Operations that send something out** (TODO 959, `outbound`: mail, posts, a push to a remote, ...) and plugin tools with side effects
 *    (TODO 847, `alwaysAsk`) are also always queued - even a rule cannot silence them. **Writes that would
 *    persist or switch off a safeguard**
 *    (TODO 1042, `persistence`: shell startup files, CLI settings, `.git/hooks`, crontab ...) are the same, and come before the quiet standard commands (2.5).
 * 2. If a **rule** (made with "always allow") matches, it passes as `by: 'rule'`.
 *    A `Bash` rule is an exact match of the command, others match the tool name. **Rules are one table for the whole app**
 *    (T40): tied to neither a thread nor a working folder. The storage is injected (`ApprovalRuleStore`), and
 *    this class does not know the DB. **In a strict-mode thread only command-level rules apply; rules for just a tool name
 *    (`Write` etc.) are ignored** (TODO 994: so that one "always allow" does not cross the line for unattended scheduled jobs).
 * 2.5 **Standard commands that are not asked about** (TODO 1031, owner decision 2026-10-28): if every segment of a `Bash` command is in the table
 *    (`quiet.ts`, `quiet` in `compat/outbound.json`) and no stop pattern matches, it passes as `by: 'default'` even in strict mode and
 *    outside the default allow list. Even if it was matched as an outbound operation (1.), it passes when its contents are only table entries
 *    (an ordinary push inside `bash -c "git push"`, etc.; the table holds nothing that sends data out). `ssh` / `scp` / `sftp` / `rsync` enter the table
 *    only when all destinations are in the "hosts not to ask about" (TODO 1029, `policy.sshAllowedHosts`). If only hosts are missing, `quietHosts`
 *    is attached when queueing, and the frame's "don't ask about this host from now on" can add them.
 * 3. If the thread is **strict**, it is queued without looking at the default. But in a conversation with no role, if the user chose "don't ask in this conversation"
 *    (`allow-thread`, TODO 994), a request matching one of its rows (the first word of a Bash command, a path to write, the name of a read-only tool;
 *    wave 91 983 stage 3; not all of Bash) passes as `by: 'rule'` - a permission for that thread, in memory only,
 *    and **anything matching a stop pattern does not pass** (outbound operations were already queued in 1.). A conversation with a role consults only the table (2.7).
 * 4. **Default** (`ApprovalPolicy`): if `autoAllowAll` is true everything passes regardless of tool name. If false,
 *    only the tools listed in `autoAllowTools` pass. Either way, `Bash` is queued if it
 *    matches a **stop pattern**. **The default stop patterns were emptied in item 167** (only what the user added stops).
 * 5. Everything else is queued and waits for the user's response.
 *
 * **Full delegation mode** (TODO 1175, `policy.fullDelegation`, owner decision 2026-11-07): a request that the judgment above would queue is judged again with four of the lines in 1. removed
 * (plugin tools with side effects, outbound operations - including publishing and sending -, persistence writes, and paths out of a conversation that read a secret),
 * and if it then passes it is let through without asking (the actor stays as in the judgment below, `rule` / `default`, and the logged reason is `full-delegation`). Only those four lines are removed,
 * so questions, requested plans, stop patterns, and strict mode (and anything outside the default allow list) are queued as before. Requests that change aios's own safeguard settings
 * (`settingsGate`, `gated` of 1060) are not removed either - so the AI cannot silently change the stop patterns or full delegation itself.
 *
 * The CLI's `--permission-mode` stays `manual`. Loosening happens only here, and
 * we do not use `bypassPermissions` (`tool_use` would stop arriving and the audit trail would vanish). The "Bypass permissions equivalent" of item 167
 * is also built by letting everything through here, not by a CLI mode.
 *
 * **No timeout is implemented** (spike 2: a 600-second hold was demonstrated). The only exception is the deadline of an unattended turn of a scheduled job
 * (`expiresAt` = shortly before the next scheduled run at the time the turn was started, TODO 959); once it passes the request is denied as `expired`.
 * Instead the UI shows how long a request has been waiting and makes old requests stand out. The backend has a timeout on MCP tool calls
 * (TODO 632, ARCHITECTURE 7.6.5), which is extended by the gateway's progress and the `timeout` of `--mcp-config`,
 * but if it still gives up waiting, we withdraw the request with `cancelRequest` (`tool-timeout`) so that no clickable dialog is left behind.
 */
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import type { AutoPickRecord, JsonValue } from '@shared/agent.js'
import {
  DEFAULT_APPROVAL_POLICY,
  canAlwaysAllow,
  type ApprovalDecision,
  type ApprovalItem,
  type ApprovalPolicy,
  type ApprovalRule,
  type ApprovalSubtask,
  type ApprovalQueueReason,
  type OutboundDetail,
  type PersistenceDetail,
  approvalQueueReasonCode,
  canAllowForRole,
  roleGrantEligible,
  canAllowForThread,
  isRoleGrantScope,
  type GrantSubject,
  type RoleGrantOffer,
  type RoleGrantScope,
  type ThreadGrantOffer
} from '@shared/thread.js'
import { log } from '../../common/logger.js'
import { redactText } from '../../common/redact.js'
import { commandOf, matchDenyPattern, normalizeCommand } from './policy.js'
import { quietPlan } from './quiet.js'
import {
  grantActive,
  grantRowOf,
  matchGrant,
  proposeGrants,
  sameGrant,
  sanitizeGrantRow,
  type GrantCandidate,
  type GrantMatchContext,
  type RoleGrantRow
} from './grants.js'
import type { RoleGrantPersistence } from './grant-store.js'
import type { DrillGrantRefusal } from '@shared/drill.js'
import { sshHostAllowed } from '@shared/ssh-hosts.js'
import { AUTO_PICK_SECONDS, answeredInput, isAnswerRequest, questionsOf, recommendedPick } from './questions.js'
import {
  APPROVAL_DENIED_USER_CODE,
  approvalCancelCode,
  type ApprovalCancelReason,
  type ApprovalReply
} from './reply.js'

/**
 * The result of an approval. It distinguishes the actor (4.2 / 7.6: from a deny caused by main shutting down).
 * `default` is an automatic allow by the default allow list (T12).
 */
export interface ApprovalResult {
  readonly allowed: boolean
  readonly by: 'user' | 'rule' | 'default' | 'system'
  readonly message: string
  /**
   * Rewritten arguments to return to the backend (T31 / 4.2.2). Present only when a multiple-choice
   * question was answered. If present, the gateway returns it as `updatedInput` as is; if absent it
   * echoes the original arguments (as before).
   */
  readonly updatedInput?: JsonValue
  /** What was answered, to show in the timeline (T31). Present only when answered. */
  readonly answer?: string
  /** Whether the answer was the recommendation chosen automatically (TODO 1194). It only changes the timeline wording. */
  readonly autoPicked?: boolean
  /** Record of the event when the choice was made automatically (TODO 1230). Attached together with `autoPicked`. */
  readonly autoPick?: AutoPickRecord
  /**
   * The form of a refusal by the user (items 182 / 183). The Adapter builds the sentence returned to the model from this
   * (`AgentAdapter.approvalReply`). If it cannot (no table), a neutral English sentence (`fallbackApprovalReply`) is used,
   * and if that is missing too, `message` is returned as is. Not attached to rules or defaults. aios's own withdrawal
   * (`by: 'system'`) carries `cancelled` (TODO 567).
   */
  readonly reply?: ApprovalReply
}

export interface ApprovalRequestInput {
  readonly threadId: string
  readonly threadTitle: string
  readonly toolName: string
  readonly summary: string
  readonly input: JsonValue
  /** The thread's strict mode (T12). `false` when omitted. */
  readonly strict?: boolean
  /**
   * The thread's working directory (absolute path). **Not used for judgment** - the T26 rule "only inside this working folder"
   * (`scope: 'cwd'`) was removed in T40, and rules are one table for the whole app (4.2.1.1).
   * `test/approval.test.ts` verifies that it is ignored even when passed.
   */
  readonly cwd?: string
  /** If this is a tool call of a sub-agent, that sub-agent (item 93). Used for display only, not for judgment. */
  readonly subtask?: ApprovalSubtask | null
  /**
   * If this is a plan proposal, the plan text (item 112 / 4.2.3). The Adapter knows which tool is a proposal
   * (`AgentAdapter.planProposal`). **If `planRequested` is true, it is queued without looking at defaults, rules or strict mode.**
   */
  readonly plan?: string | null
  /**
   * Whether the user turned Plan ON in this thread (item 167). `false` when omitted.
   * When false, a plan proposal is one the AI made by entering plan mode on its own - handled like any other tool by
   * rules, strict mode and defaults.
   */
  readonly planRequested?: boolean
  /** Whether this is a write for which a before/after diff can be shown (item 97, 7.6.4). Used for display only. */
  readonly diffable?: boolean
  /**
   * The backend's `tool_use` id (TODO 632). **Not used for judgment** - a handle for withdrawing this request (`cancelRequest`)
   * when the backend stops waiting (a result arrived first for that `tool_use`).
   */
  readonly toolUseId?: string | null
  /** A marker of one gateway call (TODO 632). Used for matching when the gateway reports "cancelled". */
  readonly callId?: string | null
  /**
   * Always queue, without looking at defaults, rules or strict mode (TODO 847). Attached by the relay for plugin tools with side effects (`sideEffect: true`)
   * (owner decision 2026-10-15: only tools with side effects ask every time). `false` when omitted.
   */
  readonly alwaysAsk?: boolean
  /**
   * Leave the asking to the tool stage's consent (a fix from the review of TODO 1055). For the gateway tools that read a Web tab (`getOpenUrlText`, and
   * `getViewerScreenshot`, which captures a Web tab), the tool stage asks for the first consent itself. Queueing here for strict mode or "outside the default" would ask twice, so
   * **only when the sole reason to queue is "strict" or "outside the default"** the request passes without asking. The other lines (requests that ask for an answer, plans, side effects, outbound operations, persistence,
   * paths out after a secret was read, stop patterns) are judged as before. `false` when omitted.
   */
  readonly toolStageAsks?: boolean
  /**
   * **An operation that sends something out** (TODO 959, 4.2.1). The manager judges it with the Adapter's `outboundAction` and attaches it. If non-null, it does not pass
   * even with the default allow-everything, nor without strict mode, nor **by a rule** (owner decision 2026-10-24: in every thread).
   * No "always allow" is created either. Omitted or null is an ordinary request.
   */
  readonly outbound?: OutboundDetail | null
  /**
   * **A write that would persist or switch off a safeguard** (TODO 1042, 4.2.1). The manager judges it with the Adapter's `persistenceAction` and attaches it.
   * If non-null, like outbound operations, it does not pass by default, by a rule, or as a quiet standard command (1031). No "always allow" is created either.
   */
  readonly persistence?: PersistenceDetail | null
  /** If this call **reads a secret**, the kind of marker (TODO 1043). The Broker marks the thread whatever the outcome (in memory only). */
  readonly secretRead?: string | null
  /**
   * If this call is **a path out**, the name that matched (TODO 1043: Web fetch, MCP, curl / ssh / git fetch ..., `openUrl`).
   * If the thread has a secret marker, it does not pass by default, by a rule, as a quiet standard command, or to a host not asked about (1029).
   */
  readonly egress?: string | null
  /**
   * Deadline for the answer (epoch ms, TODO 959). When it passes, the request is denied by a system withdrawal (`expired`). Attached only by the unattended
   * turns of scheduled jobs (until the next scheduled run, owner decision 2026-10-24). Omitted or null means **no upper limit on the wait** (spike 2).
   */
  readonly expiresAt?: number | null
  /**
   * A request to "run outside the sandbox" from a conversation started with the OS sandbox enabled (TODO 1106, 4.2.4). If true, it is refused **without asking**,
   * without looking at defaults, rules or strict mode (by: system, `approval-cancelled-os-sandbox`). It is a double line with the backend's
   * `allowUnsandboxedCommands: false` (if either one is missing, nothing runs outside the sandbox). `false` when omitted.
   */
  readonly unsandboxed?: boolean
  /**
   * A request that changes settings concerning aios's own safeguards or updates (`gated` of TODO 1060, the gateway's `setSetting`). Attached together with `alwaysAsk`.
   * **Queued even in full delegation mode (TODO 1175)** - full delegation removes the side-effect tool line, but if the AI could silently change the stop patterns or full delegation itself,
   * the lines that are supposed to stop things (stop patterns, strict mode) would lose their meaning. `false` when omitted.
   */
  readonly settingsGate?: boolean
  /**
   * TODO 1289: a gateway tool that an **unattended turn** wants to use (the action name, `open-url` for `openUrl`). Always queued, without
   * looking at defaults, rules, the role table, strict mode **or full delegation** (nobody chose to let an unwatched turn do this), and the
   * frame says why (`unattended`). No "always allow" either. Omitted or null is an ordinary request.
   */
  readonly unattended?: string | null
  /**
   * This conversation's role (TODO 983, 4.2.5). The manager builds it from main's own rows on every request (`threads.role_id` and
   * `threads.schedule_job_id`), and does not attach it for conversations with neither (ordinary conversations, triggers) - **without a role the grant
   * table is never consulted** (owner decision 2026-11-15).
   */
  readonly role?: ApprovalRole | null
  /** The subject of a grant (TODO 983). The manager builds it with the Adapter's `grantSubjectOf` and attaches it. If null, the table is not consulted and nothing is proposed. */
  readonly grantSubject?: GrantSubject | null
  /**
   * An entry point for building the grant subject later (wave 91 code-review). Used only by "don't ask in this conversation" of a strict conversation without a role; it is called
   * only when needed and `grantSubject` is absent (it includes a realpath of the path, so it is not run for requests that pass by rule, quiet standard command or full delegation).
   */
  readonly grantSubjectOf?: () => GrantSubject | null
}

/**
 * A conversation's approval role (TODO 983; stage 4, owner decision 2026-11-21). The grant table has two kinds of keys: a scheduled job's
 * (`job:<jobId>`, stages 1-3 - those rows are not moved) and a Teammate's (`role:<roleId>`). A Teammate's job run consults both; the
 * Teammate's other conversations only the Teammate's; a job with no Teammate only the job's.
 */
export interface ApprovalRole {
  /** The key a press of "Always allow ... from now on" adds rows under (the Teammate's when the conversation has one, else the job's). */
  readonly key: string
  /** The display name (the Teammate's name, or the job name). */
  readonly name: string
  /** Display only: whose row a press adds. Omitted means a job. */
  readonly kind?: 'job' | 'teammate'
  /** Every key whose rows apply to this conversation. Omitted means `[key]`; `key` always applies. */
  readonly keys?: readonly string[]
}

/** The keys whose rows apply to a role (`key` first). */
function roleKeysOf(role: ApprovalRole): readonly string[] {
  return [role.key, ...(role.keys ?? []).filter((key) => key !== role.key)]
}

/** Matching for a request to withdraw (TODO 632). A match on either one counts. Null / omitted fields are not looked at. */
export interface ApprovalRequestMatch {
  readonly toolUseId?: string | null
  readonly callId?: string | null
}

/** Upper limit of the "please fix" text (the message of a denial). It goes into the `tool_result` for the model as is. */
const MAX_DENY_MESSAGE = 8000

interface Pending {
  /** Replaced to remove `autoPick` when the setting is turned off (TODO 1194). Not rewritten otherwise. */
  item: ApprovalItem
  readonly resolve: (result: ApprovalResult) => void
  /** For matching a withdrawal (TODO 632). Not put in `ApprovalItem` (the form passed to the renderer). */
  readonly toolUseId: string | null
  readonly callId: string | null
  /** The label of the question that is picked automatically (TODO 1194). The result of `recommendedPick` when the request is queued. `decide` only compares against it. */
  readonly pick: { readonly question: string; readonly label: string } | null
  /** Timer for the deadline (TODO 959). Stopped on decision, withdrawal and shutdown. */
  timer: ReturnType<typeof setTimeout> | null
  /** The request as received (TODO 983). After a grant is added, queued requests are judged again against the table (`releaseRoleGrants`). */
  readonly request: ApprovalRequestInput
  /**
   * A candidate row to add with "allow this role from now on" (TODO 983). **A value main decided when queueing**; `allow-role` uses only this
   * (values from the renderer are not used). `ApprovalItem.roleGrant` is the display form (without the hash).
   */
  readonly roleGrant: { readonly roleKey: string; readonly candidates: readonly GrantCandidate[] } | null
  /**
   * Candidates to add with "don't ask in this conversation" (TODO 983 stage 3). Only for requests of a strict conversation without a role. `allow-thread` uses only this
   * (values from the renderer are not used). In memory only.
   */
  readonly threadGrant: { readonly candidates: readonly GrantCandidate[] } | null
}

/** The role key used when passing the rows of "don't ask in this conversation" for matching (a namespace separate from the table's `job:<id>`; the rows are in memory only and are not written to the table). */
function threadRoleKey(threadId: string): string {
  return `thread:${threadId}`
}

/** The display form of the proposals shown in the frame (a value passed to the renderer; it has no hash). Role proposals and conversation proposals have the same form. */
function offerSubjectsOf(candidates: readonly GrantCandidate[]): RoleGrantOffer['subjects'] {
  return candidates.map((candidate) => ({
    kind: candidate.subjectKind,
    value: candidate.subject,
    ...(candidate.access === null ? {} : { access: candidate.access })
  }))
}

/** The upper limit of `setTimeout` (about 24.8 days). Deadlines beyond it are re-armed in steps. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Storage for rules (T22 / T40). **The Broker does not touch the DB** - it receives this entry point by injection for reading and writing.
 * The implementation is `ThreadStore` (`approval.rules` in `app_settings`). If it is not passed,
 * the Broker works in memory only as before, so tests can build a Broker without preparing a DB.
 */
export interface ApprovalRuleStore {
  /** Read all rules. Broken rows are dropped. */
  loadApprovalRules(): readonly ApprovalRule[]
  /** Replace the rules **as a whole** (an empty array deletes everything). */
  saveApprovalRules(rules: readonly ApprovalRule[]): void
}

export interface ApprovalBrokerEvents {
  /** The queue changed. Used to redraw the top of the sidebar. */
  onChanged(items: readonly ApprovalItem[]): void
  /** A request was decided, including automatic allows. Received by SessionManager for the audit log. */
  onDecided(item: ApprovalItem, result: ApprovalResult): void
}

const BASH = 'Bash'

/**
 * Record of the event of an automatic choice (TODO 1230). The labels of the question and options are taken from `ApprovalItem.questions` (values main re-read) -
 * values from the renderer are not used. If the chosen label is not among the options, null (only the marker is attached).
 */
function autoPickRecord(
  item: ApprovalItem,
  pick: { readonly question: string; readonly label: string },
  now: number
): AutoPickRecord | null {
  const question = item.questions?.find((q) => q.question === pick.question)
  if (question === undefined) return null
  const options = question.options.map((option) => option.label)
  const chosen = options.indexOf(pick.label)
  if (chosen < 0) return null
  const recommended = question.options.findIndex((option) => option.recommended === true)
  return {
    question: question.question,
    options,
    recommended: recommended < 0 ? chosen : recommended,
    chosen,
    waitedMs: Math.max(0, now - item.requestedAt)
  }
}

/** aios's own withdrawal (TODO 567). `message` is a reason code, `reply` is the material for the sentence returned to the model. */
function cancelledResult(reason: ApprovalCancelReason): ApprovalResult {
  return { allowed: false, by: 'system', message: approvalCancelCode(reason), reply: { kind: 'cancelled', reason } }
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()
  /**
   * Auto-approval rules (4.2: "rules are kept by the app and the CLI's settings are not touched").
   * The granularity was decided in T12 (tool name, command for `Bash`) plus the breadth of T26. **Persisted in T22**:
   * lookups use this in-memory table, and it is written back to `ruleStore` only when it changes.
   */
  private readonly rules = new Map<string, ApprovalRule>()
  private policy: ApprovalPolicy
  /** Per-conversation automatic choice of recommendations (TODO 1222). `SessionManager` passes an entry point that reads the `threads` row. */
  private autoPickLookup: ((threadId: string) => boolean) | null = null
  private strictLookup: ((threadId: string) => boolean) | null = null
  /**
   * TODO 983 stage 4: the conversation's role **now** (the manager reads `threads.role_id` again). Queued requests are re-checked against it
   * when a press adds a row and when released by a new row, so a conversation moved to another Teammate while a frame waits neither
   * writes into the old Teammate's table nor is released by it. If not passed, the role attached when queueing is used.
   */
  private roleLookup: ((threadId: string) => ApprovalRole | null) | null = null
  /**
   * Threads for which "don't ask in this conversation" was chosen, and their rows (TODO 994; in wave 91 983 stage 3 it was widened from Bash only to the subjects
   * the stage-1 match `matchGrant` can build (the first word of Bash, a prefix match on the path to write, the name of a read-only tool)). Not written to the table (`role_grants`). **Not persisted** - gone on restart,
   * and removed by `forgetThread` when the thread is deleted or strict mode is turned off (turning it on again asks again). It only affects the strict-mode judgment (`autoDecision`).
   */
  private readonly threadGrants = new Map<string, RoleGrantRow[]>()
  /**
   * Threads that read a secret, and the kind of the first secret read (TODO 1043). **Not persisted** - gone on restart (held the same way as `allow-thread` of 994).
   * Not removed by rewind (113) or by turning off strict mode (what was read is already in the conversation context). Only thread deletion (`dropThread`) removes it.
   */
  private readonly secretReads = new Map<string, string>()
  /**
   * The per-role grant table (TODO 983, 4.2.5). Lookups use this memory; it is written to `grantStore` only when something is added. Holds only rows validated on load.
   * Expired rows may remain here, but matching compares against `now` every time so they have no effect (sweeping them is stage 2).
   */
  private readonly roleGrants: RoleGrantRow[] = []
  /**
   * Whether a tool is known to be read-only (TODO 983 stage 2, owner decision 2026-11-15). The manager answers with the `isReadOnlyTool` of that conversation's Adapter.
   * If not passed, all `tool` rows have no effect (the closing side).
   */
  private readOnlyToolLookup: ((toolName: string, threadId: string | null) => boolean) | null = null
  /** Throttling timer for telling the renderer about usage records (table updates). */
  private touchNotifyTimer: ReturnType<typeof setTimeout> | null = null
  /** After shutdown (`shutdown` done), nothing is written back. So that nothing is written after the DB is closed (12.9). */
  private stopped = false

  constructor(
    private readonly events: ApprovalBrokerEvents,
    policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
    /** If omitted, rules live in memory only (for the life of the process). */
    private readonly ruleStore: ApprovalRuleStore | null = null,
    /** Storage for the per-role grant table (TODO 983). If omitted, memory only. */
    private readonly grantStore: RoleGrantPersistence | null = null
  ) {
    this.policy = policy
    this.loadRoleGrants()
    this.sweepExpiredGrants()
    if (this.ruleStore === null) return
    let loaded = 0
    let converted = false
    for (const rule of this.ruleStore.loadApprovalRules()) {
      const clean = sanitizeRule(rule)
      if (clean === null) continue
      // TODO 859: old rows (only the plaintext command) are converted to a hash + masked display and written back.
      if (clean.command !== rule.command || clean.commandHash !== rule.commandHash) converted = true
      this.rules.set(ruleKey(clean), clean)
      loaded += 1
    }
    log.info('approval.rules.loaded', { count: loaded })
    if (converted) this.persist()
  }

  /** From the settings screen. An empty `autoAllowTools` returns to the "stop everything" of Phase 2 and before. */
  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy
  }

  /**
   * The entry point that asks whether a tool is known to be read-only (TODO 983 stage 2). The manager asks **only that conversation's Adapter** with `isReadOnlyTool` (no OR).
   * `threadId` is the conversation of the request being matched or proposed. For listing or cleaning the table it is the row's conversation (rows for "this conversation only") or null (= the default Adapter).
   * Right after it is passed, `tool` rows that have no effect are deleted from the DB (`not-read-only`).
   */
  setReadOnlyToolLookup(lookup: ((toolName: string, threadId: string | null) => boolean) | null): void {
    this.readOnlyToolLookup = lookup
    if (lookup !== null) this.sweepIneffectiveToolGrants()
  }

  /**
   * The owner of "this conversation picks the recommendation automatically" (TODO 1222). SessionManager passes an entry point that reads `threads.auto_pick_recommended`.
   * If not passed (tests), every conversation is false = no automatic choice. **The judgment re-reads it every time, twice: when the request is queued and when an automatic answer arrives**
   * (values from the renderer are not trusted).
   */
  setAutoPickLookup(lookup: ((threadId: string) => boolean) | null): void {
    this.autoPickLookup = lookup
  }

  /**
   * When automatic choice was turned off for a conversation (TODO 1222, the behavior of 1194 made per conversation). Removes `autoPick` from the questions in that conversation that are counting down
   * and tells the renderer (the renderer stops counting and waits for a human answer). When it is turned ON, it is not attached afterwards to questions already queued (only from the next question).
   */
  autoPickDisabled(threadId: string): void {
    let changed = false
    for (const entry of this.pending.values()) {
      if (entry.item.threadId !== threadId || entry.item.autoPick === undefined) continue
      const { autoPick: _drop, ...rest } = entry.item
      entry.item = rest
      changed = true
    }
    if (changed) this.events.onChanged(this.list())
  }

  /**
   * Whether the conversation is strict right now (wave 91 code-review). Checked at the moment "don't ask in this conversation" is pressed (`allowForThread`).
   * If not passed (tests), it is not checked.
   */
  setStrictLookup(lookup: ((threadId: string) => boolean) | null): void {
    this.strictLookup = lookup
  }

  /** TODO 983 stage 4: how to read a conversation's current role (see `roleLookup`). */
  setRoleLookup(lookup: ((threadId: string) => ApprovalRole | null) | null): void {
    this.roleLookup = lookup
  }

  /** A queued request's role now (`roleLookup`), or the one attached when it was queued. */
  private currentRole(entry: Pending): ApprovalRole | null {
    return this.roleLookup !== null ? this.roleLookup(entry.item.threadId) : (entry.request.role ?? null)
  }

  private autoPickOn(threadId: string): boolean {
    return this.autoPickLookup?.(threadId) === true
  }

  getPolicy(): ApprovalPolicy {
    return this.policy
  }

  list(): readonly ApprovalItem[] {
    return [...this.pending.values()]
      .map((p) => p.item)
      .sort((a, b) => a.requestedAt - b.requestedAt)
  }

  /**
   * Handle a permission request arriving from the gateway. If queued, it does not resolve until the user responds.
   * **No upper limit on the wait** - except when a deadline (`expiresAt`, only for unattended turns of scheduled jobs, TODO 959) is attached.
   */
  request(input: ApprovalRequestInput): Promise<ApprovalResult> {
    const questions = questionsOf(input.toolName, input.input)
    const pick = this.autoPickOn(input.threadId) ? recommendedPick(questions) : null
    const item: ApprovalItem = {
      id: randomUUID(),
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      toolName: input.toolName,
      summary: input.summary,
      input: input.input,
      requestedAt: Date.now(),
      questions,
      ...(pick === null ? {} : { autoPick: { label: pick.label, seconds: AUTO_PICK_SECONDS } }),
      subtask: input.subtask ?? null,
      plan: input.plan ?? null,
      diffable: input.diffable === true,
      ...(input.outbound === undefined || input.outbound === null ? {} : { outbound: input.outbound })
    }

    // A request that arrived after shutdown (item 79). Queueing it would leave it in `pending` with nobody to resolve it, so
    // return it immediately with the same system denial that `shutdown` gave to pending ones. Rules and defaults are not consulted.
    if (this.stopped) {
      const result = cancelledResult('quit')
      this.events.onDecided(item, result)
      return Promise.resolve(result)
    }

    // TODO 1106: a request from a conversation with the sandbox enabled to run outside the sandbox. Refuse without asking (no new dialog, consistent with 167).
    // The secret marker is still attached (for a call that reads, the attempt to read is recorded even if refused - the same "whatever the outcome" as 1043).
    if (input.unsandboxed === true) {
      this.noteRequestSecretRead(input)
      const result = cancelledResult('os-sandbox')
      log.info('approval.denied.unsandboxed', { threadId: input.threadId, tool: input.toolName })
      this.events.onDecided(item, result)
      return Promise.resolve(result)
    }

    // TODO 1043: if the call reads a secret, mark the thread whatever the outcome (so that paths out after the read are asked about). Review 57-5: the marker is attached only after the
    // judgment of the current request is done. If the current request itself reads and sends out (`cat ~/.aws/credentials | curl …`), the judgment treats the request's
    // `secretRead` as read too (`secretEgress`).
    const auto = this.autoDecision(input)
    if (auto !== null) {
      this.noteRequestSecretRead(input)
      const result: ApprovalResult = { allowed: true, by: auto.by, message: '' }
      log.info('approval.auto', {
        threadId: input.threadId,
        tool: input.toolName,
        reason: auto.reason,
        ...(auto.grantIds === undefined ? {} : { grantId: auto.grantIds.join(',') })
      })
      if (auto.grantIds !== undefined) this.touchRoleGrants(auto.grantIds)
      // Automatic allows are also kept in the audit (T12 item 6: even when loosened, the record does not disappear).
      this.events.onDecided(item, result)
      return Promise.resolve(result)
    }

    // TODO 1175: full delegation mode. Judge again with the four lines removed, and if it passes, do not ask. The actor stays as in the judgment below; only the reason is `full-delegation`.
    const delegated = this.delegatedDecision(input)
    if (delegated !== null) {
      this.noteRequestSecretRead(input)
      const result: ApprovalResult = { allowed: true, by: delegated.by, message: '' }
      log.info('approval.auto', { threadId: input.threadId, tool: input.toolName, reason: 'full-delegation' })
      this.events.onDecided(item, result)
      return Promise.resolve(result)
    }

    // The reason for queueing is also shown in the frame (TODO 994). The renderer shows "why we are asking" in one line.
    const reason = this.queueReason(input)
    this.noteRequestSecretRead(input)
    if (
      input.toolStageAsks === true &&
      (reason.kind === 'strict' || reason.kind === 'not-default' || reason.kind === 'unknown')
    ) {
      const result: ApprovalResult = { allowed: true, by: 'default', message: '' }
      log.info('approval.auto', { threadId: input.threadId, tool: input.toolName, reason: 'tool-stage' })
      this.events.onDecided(item, result)
      return Promise.resolve(result)
    }
    // TODO 1029: if only hosts of the "hosts not to ask about" are missing, show "don't ask about this host from now on" at the end of the frame.
    const quietHosts = this.missingQuietHosts(input)
    const base: ApprovalItem = { ...item, reason, ...(quietHosts.length === 0 ? {} : { quietHosts }) }
    // TODO 983: in a role's conversation, if it is queued for a reason the table may loosen, decide the value of "allow this role from now on" here (the renderer returns only the expiry).
    const roleGrant = this.roleGrantOffer(input, base)
    // TODO 983 stage 3: for a strict conversation without a role, decide the value of "don't ask in this conversation" here (memory only).
    const threadGrant = roleGrant === null ? this.threadGrantOffer(input, base) : null
    const queued: ApprovalItem = {
      ...base,
      ...(roleGrant === null ? {} : { roleGrant: roleGrant.offer }),
      ...(threadGrant === null ? {} : { threadGrant: threadGrant.offer })
    }
    return new Promise<ApprovalResult>((resolve) => {
      const entry: Pending = {
        item: queued,
        resolve,
        toolUseId: nonEmpty(input.toolUseId),
        callId: nonEmpty(input.callId),
        pick,
        timer: null,
        request: input,
        roleGrant: roleGrant === null ? null : { roleKey: roleGrant.roleKey, candidates: roleGrant.candidates },
        threadGrant: threadGrant === null ? null : { candidates: threadGrant.candidates }
      }
      this.pending.set(queued.id, entry)
      const expiresAt = typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt) ? input.expiresAt : null
      if (expiresAt !== null) this.armExpiry(entry, expiresAt)
      log.info('approval.queued', {
        id: queued.id,
        threadId: queued.threadId,
        tool: queued.toolName,
        reason: approvalQueueReasonCode(reason),
        queued: this.pending.size,
        ...(expiresAt === null ? {} : { expiresAt })
      })
      this.events.onChanged(this.list())
    })
  }

  /**
   * Whether it can pass without asking. If so, the actor and reason; otherwise null.
   * The order is as in the comment at the top: rules (command-level only if strict) -> if strict, the thread's Bash permission ->
   * (if not strict) default allow.
   */
  private autoDecision(
    input: ApprovalRequestInput,
    /** Re-judgment of full delegation mode (TODO 1175). If true, the four lines (side effects, persistence, paths out after a secret, outbound operations) are not looked at. */
    delegated = false
  ): { by: 'rule' | 'default'; reason: string; grantIds?: readonly string[] } | null {
    // A request that asks for an answer is **never passed automatically** (T31 / 4.2.2).
    // "Letting it through" means "not answering", which makes no sense for a question. Rules and defaults are skipped.
    if (isAnswerRequest(questionsOf(input.toolName, input.input))) return null
    // A plan proposal the user asked for is the same (item 112 / 4.2.3). Letting it through would move to implementation without the user seeing the plan.
    // A plan the AI produced on its own while Plan is OFF is not stopped (item 167) - it falls through to the ordinary judgment below.
    if (isRequestedPlan(input)) return null
    // TODO 1289: a gateway tool asked for by an unattended turn. Nothing lets it through, full delegation included.
    if (nonEmpty(input.unattended) !== null) return null
    // Plugin tools with side effects (TODO 847). Neither rules nor defaults let them through.
    if (input.alwaysAsk === true && !delegated) return null
    // Writes that would persist or switch off a safeguard (TODO 1042). Neither rules, defaults nor quiet standard commands let them through (`echo … >> ~/.zshrc` is made
    // only of table commands, but it is stopped here first).
    if (input.persistence !== undefined && input.persistence !== null && !delegated) return null
    // Paths out of a conversation that read a secret (TODO 1043). Stopped before the quiet standard commands and the hosts not asked about (1029).
    if (!delegated && this.secretEgress(input) !== null) return null
    const command = input.toolName === BASH ? commandOf(input.input) : null
    // Quiet standard commands (TODO 1031): a Bash command whose every segment is in the table and that matches no stop pattern.
    const quiet = command !== null && this.quietPasses(command)
    // Operations that send something out (TODO 959). Neither rules nor defaults let them through - a line that "always allow" cannot silence.
    // But a command made only of quiet standard commands (TODO 1031: an ordinary push inside `bash -c "git push"`, `echo "a; curl -d …"`, and other cases
    // where the matcher matched coarsely) passes. The table holds nothing that sends data out (curl / gh / mail …).
    if (input.outbound !== undefined && input.outbound !== null && !quiet && !delegated) return null
    const normalized = command === null ? null : normalizeCommand(command)
    const hash = normalized === null ? null : commandHashOf(normalized)

    const strict = input.strict === true
    // Rules are one table for the whole app (T40). Neither the thread nor the working folder is looked at.
    for (const rule of this.rules.values()) {
      if (rule.toolName !== input.toolName) continue
      // In strict mode, rules for just a tool name (`Write` etc., no command) are not looked at (TODO 994).
      if (rule.commandHash == null) {
        if (strict) continue
        return { by: 'rule', reason: 'rule' }
      }
      if (rule.commandHash !== hash) continue
      return { by: 'rule', reason: 'rule' }
    }

    // Quiet standard commands (TODO 1031, owner decision 2026-10-28): they pass even in strict mode and outside the default allow list. Strict mode
    // is the stage that stops "sending out or breaking things". The actor is the default (`default`), the reason is `quiet`.
    if (quiet) return { by: 'default', reason: 'quiet' }

    // Stage 2.7 (TODO 983, 4. of 4.2.5): the per-role grant table. Consulted whether or not the thread is strict. The stage 0 lines (the ones that returned null above) cannot be removed by the table.
    // Not consulted in the re-judgment of full delegation (the table is not mixed into a judgment with the four lines removed).
    if (!delegated) {
      const grant = this.roleGrantMatch(input)
      if (grant !== null) return { by: 'rule', reason: 'role-grant', grantIds: grant.map((row) => row.id) }
    }

    if (strict) {
      // "Don't ask in this conversation" (TODO 994, 983 stage 3). Commands that cannot be read and those that match a stop pattern are queued.
      if (this.threadGrantMatch(input) !== null) return { by: 'rule', reason: 'thread' }
      return null
    }
    // Full delegation mode implies `autoAllowAll` (tools outside the default allow list are not asked about either, review of TODO 1175).
    if (!delegated && !this.policy.autoAllowAll && !this.policy.autoAllowTools.includes(input.toolName)) {
      return null
    }
    if (input.toolName === BASH) {
      // A Bash command that cannot be read is not passed (if we do not know what would pass, we stop it).
      // **Stop patterns also apply with `autoAllowAll`** - a net of only the patterns the user added
      // (empty by default, item 167). What the user added stops even under allow-everything.
      if (command === null) return null
      if (matchDenyPattern(command, this.policy.bashDenyPatterns) !== null) return null
    }
    return { by: 'default', reason: delegated || this.policy.autoAllowAll ? 'default-all' : 'default-tool' }
  }

  /**
   * Whether full delegation mode (TODO 1175) can pass it without asking. Null if the mode is OFF, for a change of safeguard settings (`settingsGate`), or for a strict-mode thread.
   * The rest is left to `autoDecision` with the four lines removed. Full delegation implies `autoAllowAll`, so tools outside the default allow list also pass, while questions, requested plans, stop patterns and unreadable commands stay null (queued).
   * Strict mode is looked at first because the "quiet standard commands" (1031) behind the removed lines pass even in strict mode (the persistence of `echo … >> ~/.zshrc` would get through in strict mode).
   * Call it only after the plain judgment (`autoDecision(input)`) returned null - if it passes now, the difference is in the removed lines, so the reason can be called full delegation.
   */
  private delegatedDecision(input: ApprovalRequestInput): { by: 'rule' | 'default' } | null {
    if (this.policy.fullDelegation !== true || input.settingsGate === true || input.strict === true) return null
    // TODO 1289: full delegation does not remove the unattended-turn line either (the re-judgment would stop there anyway; kept explicit).
    if (nonEmpty(input.unattended) !== null) return null
    const decision = this.autoDecision(input, true)
    return decision === null ? null : { by: decision.by }
  }

  /** Why it was queued (for the log and, since TODO 994, a line of the approval frame). */
  private queueReason(input: ApprovalRequestInput): ApprovalQueueReason {
    if (isAnswerRequest(questionsOf(input.toolName, input.input))) return { kind: 'question' }
    if (isRequestedPlan(input)) return { kind: 'plan' }
    const unattended = nonEmpty(input.unattended)
    if (unattended !== null) return { kind: 'unattended', action: unattended }
    if (input.alwaysAsk === true) return { kind: 'side-effect' }
    if (input.outbound !== undefined && input.outbound !== null) return { kind: 'outbound', match: input.outbound.match }
    if (input.persistence !== undefined && input.persistence !== null) {
      return { kind: 'persistence', match: input.persistence.match, target: input.persistence.target }
    }
    const secret = this.secretEgress(input)
    if (secret !== null) return { kind: 'secret-read', source: secret.source, egress: secret.egress }
    // Bash stop patterns and unreadable commands come before strict (review of TODO 994). Otherwise a request queued by a stop pattern after "don't ask about Bash in this conversation"
    // would show up as `strict` and not show that row (`canAllowForThread`) again.
    if (input.toolName === BASH) {
      const command = commandOf(input.input)
      if (command === null) return { kind: 'no-command' }
      const hit = matchDenyPattern(command, this.policy.bashDenyPatterns)
      if (hit !== null) return { kind: 'deny-pattern', pattern: hit }
    }
    if (input.strict === true) return { kind: 'strict' }
    if (!this.policy.autoAllowAll && !this.policy.autoAllowTools.includes(input.toolName)) {
      return { kind: 'not-default' }
    }
    return { kind: 'unknown' }
  }

  decide(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) {
      // When two windows show the same conversation, the automatic answer arrives twice. The second one for an already resolved id is silently ignored (TODO 1194).
      if (decision.kind === 'answer' && decision.auto === true) log.debug('approval.auto-pick.ignored', { id, reason: 'resolved' })
      return false
    }
    // TODO 1194: an automatic answer re-reads the current setting. An automatic answer after it was turned OFF, or for a question that is not eligible, is refused, and the question stays queued waiting for a human.
    if (decision.kind === 'answer' && decision.auto === true && (!this.autoPickOn(entry.item.threadId) || entry.pick === null)) {
      log.info('approval.auto-pick.refused', { id, reason: entry.pick === null ? 'not-eligible' : 'disabled' })
      return false
    }
    this.pending.delete(id)
    clearExpiry(entry)

    let result: ApprovalResult
    if (decision.kind === 'deny') {
      // Declining with nothing written means "stop and wait"; with text it means "do this instead" (items 182 / 183).
      // The plan's "please fix" (item 112) is the latter too. The sentence returned to the model is built by the Adapter from its table (`reply`).
      const message = decision.message?.trim().slice(0, MAX_DENY_MESSAGE) ?? ''
      result =
        message === ''
          ? { allowed: false, by: 'user', message: APPROVAL_DENIED_USER_CODE, reply: { kind: 'stop' } }
          : { allowed: false, by: 'user', message, reply: { kind: 'feedback', text: message } }
    } else if (decision.kind === 'answer') {
      // An answer to a multiple-choice question (T31 / 4.2.2). **Values from the renderer are re-checked here**:
      // unknown question texts and labels not among the options are dropped (the convention of 12.7).
      // If an answer comes for a request that could not be read as a question, it falls back to a plain allow.
      if (entry.item.questions === null) {
        log.warn('approval.answer.refused', { id, tool: entry.item.toolName })
        result = { allowed: true, by: 'user', message: '' }
      } else {
        const { updatedInput, summary } = answeredInput(
          entry.item.input,
          entry.item.questions,
          decision.answers,
          decision.texts ?? {}
        )
        // TODO 1194: the automatic marker is kept only when the answer matches the request's own `autoPick` (the renderer's value is not trusted).
        const pick = entry.pick
        const auto =
          decision.auto === true &&
          pick !== null &&
          (decision.answers[pick.question] ?? []).length === 1 &&
          decision.answers[pick.question]?.[0] === pick.label &&
          Object.values(decision.texts ?? {}).every((text) => text.trim() === '')
        const record = auto && pick !== null ? autoPickRecord(entry.item, pick, Date.now()) : null
        result = {
          allowed: true,
          by: 'user',
          message: '',
          updatedInput,
          answer: summary,
          ...(auto ? { autoPicked: true } : {}),
          ...(record === null ? {} : { autoPick: record })
        }
        // TODO 1230: the log line for this. **No sentences are logged** (the question, option labels and answer are body text) - only ids, counts, positions and seconds waited.
        if (record !== null) {
          log.info('approval.auto-pick.applied', {
            id,
            threadId: entry.item.threadId,
            options: record.options.length,
            recommended: record.recommended,
            chosen: record.chosen,
            waitedSec: Math.round(record.waitedMs / 1000)
          })
        }
      }
    } else {
      // Values from the renderer are re-verified in main. No rule is made for the gateway's own tools; it falls
      // back to a one-time allow (4.2 / review B-5). Rules can be made for the user's MCP server tools (item 110).
      if (decision.kind === 'allow-always' && entry.item.questions !== null) {
        // No "always allow" for a question (T31): it cannot hold what to answer to the next question.
        log.warn('approval.rule.refused', { id, tool: entry.item.toolName, reason: 'question' })
      } else if (decision.kind === 'allow-always' && entry.item.plan !== null && entry.item.plan !== undefined) {
        // None for a plan either (item 112): as a rule it would pass the next plan without being seen.
        log.warn('approval.rule.refused', { id, tool: entry.item.toolName, reason: 'plan' })
      } else if (decision.kind === 'allow-always' && entry.item.outbound != null) {
        // None for operations that send something out either (TODO 959): as a rule it would pass the next send without reading it.
        log.warn('approval.rule.refused', { id, tool: entry.item.toolName, reason: 'outbound' })
      } else if (
        decision.kind === 'allow-always' &&
        (entry.item.reason?.kind === 'persistence' || entry.item.reason?.kind === 'secret-read')
      ) {
        // None for persistence writes (TODO 1042) or paths out of a conversation that read a secret (TODO 1043) either: they would pass the next one without reading it.
        log.warn('approval.rule.refused', { id, tool: entry.item.toolName, reason: entry.item.reason.kind })
      } else if (decision.kind === 'allow-always' && !canAlwaysAllow(entry.item.toolName)) {
        log.warn('approval.rule.refused', { id, tool: entry.item.toolName })
      } else if (decision.kind === 'allow-always') {
        this.addRule(entry.item)
      } else if (decision.kind === 'allow-role') {
        // TODO 983: build the row only from the value main decided when queueing. A request that does not fit the conditions, or an unknown expiry, falls back to a one-time allow.
        // Stage 4: the conversation must still belong to the role the frame named (it may have been moved to another Teammate meanwhile).
        const stillOwned = entry.roleGrant !== null && this.currentRole(entry)?.key === entry.roleGrant.roleKey
        if (entry.roleGrant !== null && stillOwned && canAllowForRole(entry.item) && isRoleGrantScope(decision.scope)) {
          this.addRoleGrants(entry, decision.scope)
        } else {
          log.warn('approval.grant.refused', {
            id,
            tool: entry.item.toolName,
            reason: entry.roleGrant === null ? 'no-role' : !stillOwned ? 'role-changed' : 'not-eligible'
          })
        }
      } else if (decision.kind === 'allow-thread') {
        // TODO 994 / 983 stage 3: only for requests where main attached a proposal, in strict mode without a role. Anything else (sent falsely by the renderer) falls back to a one-time allow.
        if (entry.threadGrant !== null && canAllowForThread(entry.item)) this.allowForThread(entry, id)
        else log.warn('approval.thread.refused', { id, tool: entry.item.toolName })
      }
      result = { allowed: true, by: 'user', message: '' }
    }

    log.info('approval.decided', {
      id,
      allowed: result.allowed,
      heldMs: Date.now() - entry.item.requestedAt
    })
    entry.resolve(result)
    this.events.onDecided(entry.item, result)
    // TODO 983: after a grant is added, resolve the other queued requests of the same role that now pass under the new table.
    if (decision.kind === 'allow-role' && entry.roleGrant !== null) this.releaseRoleGrants(entry.roleGrant.roleKey)
    this.events.onChanged(this.list())
    return true
  }

  /**
   * Turn "always allow" into a rule. For `Bash` the key is **that command** (whitespace-normalized, exact match),
   * not a coarse rule on the tool name alone (the answer to the "granularity" of TODO 27).
   * No rule is made for a Bash command that cannot be read.
   *
   * **Rules are one table for the whole app** (T40). If a rule for the same tool (for Bash, the same command) already
   * exists, nothing is done.
   */
  private addRule(item: ApprovalItem): void {
    let command: string | null = null
    if (item.toolName === BASH) {
      const raw = commandOf(item.input)
      if (raw === null) {
        log.warn('approval.rule.refused', { id: item.id, tool: item.toolName, reason: 'no-command' })
        return
      }
      command = normalizeCommand(raw)
    }
    const rule: ApprovalRule = {
      id: randomUUID(),
      toolName: item.toolName,
      // TODO 859: matching uses SHA-256; only the string passed through redaction is used for display and storage.
      command: command === null ? null : redactText(command).text,
      commandHash: command === null ? null : commandHashOf(command),
      createdAt: Date.now()
    }
    const key = ruleKey(rule)
    if (this.rules.has(key)) return
    this.rules.set(key, rule)
    log.info('approval.rule.added', { tool: item.toolName, command: command !== null })
    this.persist()
  }

  /**
   * Record "don't ask in this conversation" (TODO 994, 983 stage 3), and pass the strict-mode requests already queued in the same thread that pass under the new row,
   * using the same judgment (`threadGrantMatch`). `except` is the request being decided now. The rows are only candidates that main decided when queueing.
   * **If the conversation is no longer strict at the time of the answer, no row is added and it falls back to a one-time allow** (turning off strict mode makes `forgetThread` delete the rows, but if
   * a frame left queued is pressed, the row would silently pass when strict mode is turned on again. Wave 91 code-review).
   */
  private allowForThread(entry: Pending, except: string): void {
    const grant = entry.threadGrant
    if (grant === null) return
    const threadId = entry.item.threadId
    if (this.strictLookup !== null && !this.strictLookup(threadId)) {
      log.warn('approval.thread.refused', { id: entry.item.id, tool: entry.item.toolName, reason: 'not-strict' })
      return
    }
    // TODO 983 stage 4: the conversation was moved under a Teammate after the frame was shown. Its requests now consult the Teammate's table,
    // so no in-memory row is added (and nothing queued is released by one) - a one-time allow.
    if (this.roleLookup !== null && this.roleLookup(threadId) !== null) {
      log.warn('approval.thread.refused', { id: entry.item.id, tool: entry.item.toolName, reason: 'role-changed' })
      return
    }
    const now = Date.now()
    const rows = this.threadGrants.get(threadId) ?? []
    for (const candidate of grant.candidates) {
      const row = grantRowOf(candidate, threadRoleKey(threadId), entry.item.toolName, 'thread', threadId, now)
      if (!rows.some((existing) => sameGrant(existing, row))) rows.push(row)
    }
    this.threadGrants.set(threadId, rows)
    log.info('approval.thread.allowed', { threadId, tool: entry.item.toolName, kinds: grant.candidates.map((c) => c.subjectKind).join(',') })
    this.releasePending(
      (id, other) => id !== except && other.item.threadId === threadId && other.request.role == null && other.item.reason?.kind === 'strict',
      (other) => this.threadGrantMatch(other.request),
      'thread'
    )
  }

  /** The subject of "don't ask in this conversation". Uses the subject the manager attached, or if absent the whole Bash command (a call that does not go through the Adapter). */
  private threadSubject(input: ApprovalRequestInput): GrantSubject | null {
    if (input.grantSubject != null) return input.grantSubject
    // Build the subject only when it is needed (it includes a realpath of the path). Only matching in conversations that have rows, and proposals only when queueing a frame, come here.
    const lazy = input.grantSubjectOf?.() ?? null
    if (lazy !== null) return lazy
    if (input.toolName !== BASH) return null
    const command = commandOf(input.input)
    return command === null ? null : { kind: 'command', command }
  }

  /** This conversation's rows (input for matching and proposals). `tool` rows only for tools known to be read-only (the same line as stage 2). */
  private threadRows(threadId: string): readonly RoleGrantRow[] {
    const rows = this.threadGrants.get(threadId) ?? []
    const lookup = this.readOnlyToolLookup
    return rows.filter((row) => row.subjectKind !== 'tool' || (lookup !== null && lookup(row.toolName, threadId)))
  }

  /**
   * Whether a request in a strict conversation without a role hits a row of "don't ask in this conversation" (TODO 983 stage 3). Conversations with a role do not consult it (the table is used instead).
   * The stage 0 lines, stop patterns and unreadable commands are already stopped first by `autoDecision` / `threadBashPasses`.
   */
  private threadGrantMatch(input: ApprovalRequestInput): readonly RoleGrantRow[] | null {
    if (input.strict !== true || input.role != null) return null
    const rows = this.threadGrants.get(input.threadId)
    if (rows === undefined || rows.length === 0) return null
    return this.grantMatchOf(input, this.threadSubject(input), this.threadRows(input.threadId), threadRoleKey(input.threadId))
  }

  /** The value to attach "don't ask in this conversation" to a request being queued; null if it is not attached. */
  private threadGrantOffer(
    input: ApprovalRequestInput,
    item: ApprovalItem
  ): { offer: ThreadGrantOffer; candidates: readonly GrantCandidate[] } | null {
    if (input.strict !== true || input.role != null || item.reason?.kind !== 'strict') return null
    const candidates = this.grantProposalOf(
      input,
      item,
      this.threadSubject(input),
      this.threadRows(input.threadId),
      threadRoleKey(input.threadId)
    )
    return candidates === null ? null : { candidates, offer: { subjects: offerSubjectsOf(candidates) } }
  }

  /**
   * Common matching (role table and conversation rows): pass to `matchGrant` only when the subject can be built, the tool is allowable, and for a shell the command does not match a stop pattern and is readable.
   * The caller (`autoDecision`) has already looked at the stage 0 lines.
   */
  private grantMatchOf(
    input: ApprovalRequestInput,
    subject: GrantSubject | null,
    rows: readonly RoleGrantRow[],
    roleKey: string,
    alsoRoleKeys: readonly string[] = []
  ): readonly RoleGrantRow[] | null {
    if (subject === null || !canAlwaysAllow(input.toolName)) return null
    if (subject.kind === 'command' && !this.threadBashPasses(subject.command)) return null
    return matchGrant(subject, rows, this.grantContext(input, roleKey, alsoRoleKeys))
  }

  /**
   * Common proposals (role table and conversation rows): pass to `proposeGrants` only requests that pass the frame eligibility check (`roleGrantEligible`, same as the renderer) and the same lines as matching.
   * Null if none can be made (when a secret is included, the reason is logged).
   */
  private grantProposalOf(
    input: ApprovalRequestInput,
    item: ApprovalItem,
    subject: GrantSubject | null,
    rows: readonly RoleGrantRow[],
    roleKey: string,
    alsoRoleKeys: readonly string[] = []
  ): readonly GrantCandidate[] | null {
    if (subject === null || !canAlwaysAllow(input.toolName) || !roleGrantEligible(item)) return null
    if (subject.kind === 'command' && !this.threadBashPasses(subject.command)) return null
    const proposal = proposeGrants(subject, rows, this.grantContext(input, roleKey, alsoRoleKeys))
    if ('refused' in proposal) {
      log.info('approval.grant.refused', { threadId: input.threadId, tool: input.toolName, reason: proposal.refused })
      return null
    }
    return proposal.candidates.length === 0 ? null : proposal.candidates
  }

  /**
   * Resolve with `by: 'rule'` the queued requests that match `applies` and for which `matchOf` returns a row (common to the role table and conversation rows).
   * **Paths out of a conversation that got a secret marker after queueing are not resolved** (a stage 0 line), and neither is anything outside `roleGrantEligible` (outbound operations, plans, questions).
   * `onMatch` receives the row that resolved it (for usage records etc.).
   */
  private releasePending(
    applies: (id: string, entry: Pending) => boolean,
    matchOf: (entry: Pending) => readonly RoleGrantRow[] | null,
    reason: string,
    onMatch?: (rows: readonly RoleGrantRow[]) => void
  ): void {
    for (const [id, entry] of [...this.pending]) {
      if (!applies(id, entry) || !roleGrantEligible(entry.item) || this.secretEgress(entry.request) !== null) continue
      const rows = matchOf(entry)
      if (rows === null) continue
      onMatch?.(rows)
      this.autoResolve(id, entry, reason, rows.length === 0 ? {} : { grantId: rows.map((row) => row.id).join(',') })
    }
  }

  /** Pass a queued request as `by: 'rule'` and remove it (common to table, row and hosts-not-asked-about release). */
  private autoResolve(id: string, entry: Pending, reason: string, extra: Record<string, string> = {}): void {
    this.pending.delete(id)
    clearExpiry(entry)
    const result: ApprovalResult = { allowed: true, by: 'rule', message: '' }
    log.info('approval.auto', { threadId: entry.item.threadId, tool: entry.item.toolName, reason, ...extra })
    entry.resolve(result)
    this.events.onDecided(entry.item, result)
  }

  /**
   * Whether a shell command may pass under "don't ask in this conversation" (TODO 994). Unreadable ones and those matching a stop pattern do not pass.
   * This one place is the judgment for both `autoDecision` and `allowForThread` (for requests already queued).
   */
  private threadBashPasses(command: string | null): boolean {
    return command !== null && matchDenyPattern(command, this.policy.bashDenyPatterns) === null
  }

  /**
   * Whether it may pass as a quiet standard command (TODO 1031). Every segment is in the table (`quiet.ts`) and it does not match the user's stop patterns.
   * Stop patterns are a net the user added themselves, so they are stronger than the table of standard commands.
   */
  private quietPasses(command: string): boolean {
    const verdict = this.quietVerdict(command)
    return verdict !== null && verdict.missing.length === 0
  }

  /** Judgment of quiet standard commands (TODO 1031 / 1029). Null if it is not in the table or matches a stop pattern; if it is in the table, the hosts missing from the "hosts not to ask about" (it passes if empty). */
  private quietVerdict(command: string): { readonly missing: readonly string[] } | null {
    if (matchDenyPattern(command, this.policy.bashDenyPatterns) !== null) return null
    const plan = quietPlan(command)
    if (plan === null) return null
    const allowed = this.policy.sshAllowedHosts ?? []
    return { missing: plan.hosts.filter((host) => !sshHostAllowed(host, allowed)) }
  }

  /** For a request being queued, the hosts a `Bash` command is missing from the "hosts not to ask about" (TODO 1029) that would let it pass if added. Empty otherwise. */
  private missingQuietHosts(input: ApprovalRequestInput): readonly string[] {
    // Persistence writes (TODO 1042) and paths out of a conversation that read a secret (TODO 1043) do not pass even if hosts are added, so we do not show it.
    if (input.toolName !== BASH || (input.persistence ?? null) !== null || this.secretEgress(input) !== null) return []
    const command = commandOf(input.input)
    if (command === null) return []
    return this.quietVerdict(command)?.missing ?? []
  }

  /**
   * After "don't ask about this host from now on" (TODO 1029), resolve the other pending requests (the same form as `allowForThread`).
   * Only those `Bash` requests queued with `quietHosts` that now pass as quiet standard commands with the current list (`autoDecision` passes them).
   */
  releaseAllowedHosts(strictOf: (threadId: string) => boolean): void {
    let released = 0
    for (const [id, entry] of [...this.pending]) {
      if ((entry.item.quietHosts ?? []).length === 0) continue
      const auto = this.autoDecision({
        threadId: entry.item.threadId,
        threadTitle: entry.item.threadTitle,
        toolName: entry.item.toolName,
        summary: entry.item.summary,
        input: entry.item.input,
        strict: strictOf(entry.item.threadId),
        outbound: entry.item.outbound ?? null,
        persistence: entry.item.reason?.kind === 'persistence' ? { match: entry.item.reason.match, target: entry.item.reason.target } : null,
        egress: entry.item.reason?.kind === 'secret-read' ? entry.item.reason.egress : null
      })
      if (auto === null) continue
      this.autoResolve(id, entry, 'ssh-host')
      released += 1
    }
    if (released > 0) this.events.onChanged(this.list())
  }

  // ---- Per-role grant table (TODO 983, 4.2.5) ----

  /** Read everything from the storage and keep only the validated rows in memory (at startup). */
  private loadRoleGrants(): void {
    if (this.grantStore === null) return
    let loaded = 0
    let dropped = 0
    for (const row of this.grantStore.loadRoleGrants()) {
      const clean = sanitizeGrantRow(row)
      if (clean === null) {
        dropped += 1
        continue
      }
      this.roleGrants.push(clean)
      loaded += 1
    }
    log.info('approval.grants.loaded', { count: loaded, ...(dropped === 0 ? {} : { dropped }) })
  }

  /** Matching context. A Bash segment passes either as a "quiet standard command" (1031, including hosts not asked about) or by a grant row. */
  private grantContext(input: ApprovalRequestInput, roleKey: string, alsoRoleKeys: readonly string[] = []): GrantMatchContext {
    return {
      roleKey,
      ...(alsoRoleKeys.length === 0 ? {} : { alsoRoleKeys }),
      toolName: input.toolName,
      threadId: input.threadId,
      now: Date.now(),
      quietSegment: (segment) => this.quietPasses(segment),
      home: canonicalHome()
    }
  }

  /**
   * The stage 2.7 match (TODO 983). If there is a role and a subject and a valid row matches, the row used. For a shell, commands matching a stop pattern or unreadable ones do not pass
   * (the same line as `threadBashPasses`). The caller (`autoDecision`) has already looked at the stage 0 lines.
   */
  private roleGrantMatch(input: ApprovalRequestInput, role: ApprovalRole | null = input.role ?? null): readonly RoleGrantRow[] | null {
    if (role === null || this.roleGrants.length === 0) return null
    // Stage 4: the rows of every key of the role (a Teammate's job run: the job's and the Teammate's). Nothing is built when no row could apply.
    const [key, ...also] = roleKeysOf(role)
    if (key === undefined || !this.roleGrants.some((row) => row.roleKey === key || also.includes(row.roleKey))) return null
    const subject = this.roleSubject(input)
    if (subject === null) return null
    // Expired rows are swept at every match (before sweeping, `matchGrant` compares against `now` so they have no effect anyway).
    this.sweepExpiredGrants()
    return this.grantMatchOf(input, subject, this.effectiveGrants(input.threadId), key, also)
  }

  /** The grant subject of a role conversation's request: the one the manager attached, or built now through its lazy entry point. */
  private roleSubject(input: ApprovalRequestInput): GrantSubject | null {
    return input.grantSubject ?? input.grantSubjectOf?.() ?? null
  }

  /** The value to attach "allow this role from now on" to a request being queued (TODO 983); null if not attached. */
  private roleGrantOffer(
    input: ApprovalRequestInput,
    item: ApprovalItem
  ): { roleKey: string; offer: RoleGrantOffer; candidates: readonly GrantCandidate[] } | null {
    const role = input.role ?? null
    if (role === null) return null
    // Stage 4: one row only, under `role.key` (a Teammate's job run offers the Teammate's row, not the job's too - 5. of 4.2.5). Segments
    // already covered by a row of any key of the role are not proposed again.
    const [key, ...also] = roleKeysOf(role)
    if (key === undefined) return null
    const candidates = this.grantProposalOf(input, item, this.roleSubject(input), this.effectiveGrants(input.threadId), key, also)
    if (candidates === null) return null
    const offer: RoleGrantOffer = {
      roleName: role.name,
      ...(role.kind === 'teammate' ? { roleKind: 'teammate' as const } : {}),
      subjects: offerSubjectsOf(candidates)
    }
    return { roleKey: key, candidates, offer }
  }

  /** Add rows of "allow this role from now on" (TODO 983). If a valid row for the same permission exists, do not stack another. Nothing is written after shutdown. */
  private addRoleGrants(entry: Pending, scope: RoleGrantScope): void {
    const grant = entry.roleGrant
    if (grant === null || this.stopped) return
    const now = Date.now()
    const rows: RoleGrantRow[] = []
    for (const candidate of grant.candidates) {
      const row = grantRowOf(candidate, grant.roleKey, entry.item.toolName, scope, entry.item.threadId, now)
      if (this.roleGrants.some((existing) => sameGrant(existing, row) && grantActive(existing, now, entry.item.threadId))) continue
      if (rows.some((added) => sameGrant(added, row))) continue
      rows.push(row)
    }
    if (rows.length === 0) return
    try {
      this.grantStore?.addRoleGrants(rows)
    } catch (error) {
      // If it cannot be written, it is not added to memory either (so that a permission that would vanish on restart does not silently take effect). This time's one-time allow stays as is.
      log.warn('approval.grant.refused', {
        id: entry.item.id,
        reason: 'store',
        message: error instanceof Error ? error.message : String(error)
      })
      return
    }
    this.roleGrants.push(...rows)
    for (const row of rows) {
      log.info('approval.grant.added', {
        roleKey: row.roleKey,
        tool: row.toolName,
        kind: row.subjectKind,
        scope: row.scope,
        source: row.source,
        // The value only for paths (the convention is not to log argument values; paths are the exception).
        ...(row.subjectKind === 'path-prefix' && row.subject !== null ? { path: row.subject } : {})
      })
    }
  }

  /**
   * After a grant is added, resolve the other queued requests of the same role that pass under the new table (TODO 983, the same form as `releaseAllowedHosts`).
   * It resolves within the frames of `canAllowForRole` (those queued by stage 0 lines or stop patterns are excluded from the start), and only those matching the table.
   */
  private releaseRoleGrants(roleKey: string): void {
    // Waiting requests that have no proposal of their own (no candidate could be made, or every segment is already in the table) are also re-checked with the new table if they are in the same role.
    // Stage 4: by the conversation's role now, and every request whose role consults rows of `roleKey` (a Teammate's job runs too).
    this.releasePending(
      (_id, entry) => {
        const role = this.currentRole(entry)
        return role !== null && roleKeysOf(role).includes(roleKey)
      },
      (entry) => this.roleGrantMatch(entry.request, this.currentRole(entry)),
      'role-grant',
      (rows) => this.touchRoleGrants(rows.map((row) => row.id))
    )
  }

  // ---- Drills (TODO 982) and "allow from now on" from a drill's list (TODO 1292 item 2) ----

  /**
   * What "allow from now on" would add to the role's table for an operation a drill stopped. **Judged with the same lines as the approval
   * frame** - no separate table: the queue reason the request would get in a strict conversation (`queueReason`), `roleGrantEligible`
   * (the stage 0 lines: outbound 959, persistence 1042, secret paths out 1043, side effects 847, questions, plans, unattended-turn tools,
   * stop patterns and unreadable commands), `canAlwaysAllow` (aios's own tools), whether it would already pass in a strict conversation
   * (`autoDecision`: rules, quiet standard commands, the role's rows), and `proposeGrants` against the rows the role already has.
   * Nothing is queued, decided, recorded or added. `input.role` must be set (the key the rows would go under).
   */
  drillGrantProposal(
    input: ApprovalRequestInput
  ): { readonly candidates: readonly GrantCandidate[] } | { readonly refused: DrillGrantRefusal } {
    const role = input.role ?? null
    if (role === null) return { refused: 'no-subject' }
    const strict: ApprovalRequestInput = { ...input, strict: true }
    const reason = this.queueReason(strict)
    const item = { reason, outbound: input.outbound ?? null, plan: input.plan ?? null, questions: questionsOf(input.toolName, input.input) }
    if (!roleGrantEligible(item)) return { refused: drillRefusalOf(reason) }
    if (!canAlwaysAllow(input.toolName)) return { refused: 'gateway' }
    if (this.autoDecision(strict) !== null) return { refused: 'covered' }
    const subject = this.roleSubject(input)
    if (subject === null) return { refused: 'no-subject' }
    if (subject.kind === 'command' && !this.threadBashPasses(subject.command)) return { refused: 'deny-pattern' }
    const [key, ...also] = roleKeysOf(role)
    if (key === undefined) return { refused: 'no-subject' }
    const proposal = proposeGrants(subject, this.effectiveGrants(input.threadId), this.grantContext(strict, key, also))
    if ('refused' in proposal) return { refused: proposal.refused === 'secret' ? 'secret' : 'no-subject' }
    return proposal.candidates.length === 0 ? { refused: 'covered' } : { candidates: proposal.candidates }
  }

  /**
   * TODO 1292 item 2: adds the rows a person ticked in a drill's list, under `roleKey` (`role:<id>` only - the caller re-built the key from
   * main's rows), `scope: 'forever'`, `source: 'drill'`. Every row is validated again (`sanitizeGrantRow`) and a row the table already has
   * is not stacked. If the storage cannot be written nothing is added (as `addRoleGrants`). Queued requests of the role that now pass are
   * released. Returns the rows added (empty when the table already had them all), or null when nothing could be written (after shutdown,
   * a storage failure).
   */
  addDrillGrants(
    roleKey: string,
    threadId: string,
    entries: readonly { readonly toolName: string; readonly candidates: readonly GrantCandidate[] }[]
  ): readonly RoleGrantRow[] | null {
    if (this.stopped || !roleKey.startsWith('role:')) return null
    const now = Date.now()
    const rows: RoleGrantRow[] = []
    for (const entry of entries) {
      for (const candidate of entry.candidates) {
        const built = sanitizeGrantRow({ ...grantRowOf(candidate, roleKey, entry.toolName, 'forever', threadId, now), source: 'drill' })
        if (built === null) continue
        if (this.roleGrants.some((existing) => sameGrant(existing, built) && grantActive(existing, now, threadId))) continue
        if (rows.some((added) => sameGrant(added, built))) continue
        rows.push(built)
      }
    }
    if (rows.length === 0) return []
    try {
      this.grantStore?.addRoleGrants(rows)
    } catch (error) {
      log.warn('approval.grant.refused', { reason: 'store', source: 'drill', message: error instanceof Error ? error.message : String(error) })
      return null
    }
    this.roleGrants.push(...rows)
    for (const row of rows) {
      log.info('approval.grant.added', {
        roleKey: row.roleKey,
        tool: row.toolName,
        kind: row.subjectKind,
        scope: row.scope,
        source: row.source,
        ...(row.subjectKind === 'path-prefix' && row.subject !== null ? { path: row.subject } : {})
      })
    }
    this.releaseRoleGrants(roleKey)
    this.events.onChanged(this.list())
    return rows
  }

  // ---- Per-role grant table: listing, deletion, cleanup, usage records (TODO 983 stage 2, 7. / 8. of 4.2.5) ----

  /**
   * Rows that can take effect in the table: `tool` rows only for tools known to be read-only (old rows for tools that may be either write or read have no effect).
   * Expired rows are not included either (rows that could not be deleted from the DB but remain in memory are neither shown nor applied). `threadId` is the request's conversation (null for listing and cleanup).
   */
  private effectiveGrants(threadId: string | null): readonly RoleGrantRow[] {
    const lookup = this.readOnlyToolLookup
    const now = Date.now()
    return this.roleGrants.filter(
      (row) =>
        !(row.scope === 'today' && (row.expiresAt === null || row.expiresAt <= now)) &&
        (row.subjectKind !== 'tool' || (lookup !== null && lookup(row.toolName, threadId ?? row.threadId)))
    )
  }

  /** Delete from the DB `tool` rows that no longer take effect (saved in stage 1, for tools that the current judgment does not call read-only). At startup (when the lookup is passed). */
  private sweepIneffectiveToolGrants(): void {
    const lookup = this.readOnlyToolLookup
    if (lookup === null) return
    this.removeGrantRows((row) => row.subjectKind === 'tool' && !lookup(row.toolName, row.threadId), 'not-read-only')
  }

  /**
   * Delete from the DB the "this conversation only" rows of conversations that no longer exist (at startup; for deleted conversations, and ones whose DB deletion failed).
   * `exists` tells whether the conversation exists now (the manager looks it up in `threads`).
   */
  sweepOrphanThreadGrants(exists: (threadId: string) => boolean): void {
    this.removeGrantRows((row) => row.scope === 'thread' && (row.threadId === null || !exists(row.threadId)), 'orphan-thread')
  }

  /**
   * Delete from the DB the `job:<id>` rows of jobs that no longer exist (at startup; what `removeRoleGrantsOf` left behind when a DB failure happened while deleting a job).
   * `isLive` tells whether the role key is still alive. The manager owns parsing the key form and knowing whether the job exists; this class does not know the key form
   * (job ids are UUIDs and are not reused, TODO 1251).
   */
  sweepOrphanJobGrants(isLive: (roleKey: string) => boolean): void {
    this.removeGrantRows((row) => !isLive(row.roleKey), 'orphan-job')
  }

  /** TODO 983 stage 4: the same for the `role:<id>` rows of Teammates that no longer exist (the manager parses the key and asks the role table). */
  sweepOrphanRoleGrants(isLive: (roleKey: string) => boolean): void {
    this.removeGrantRows((row) => !isLive(row.roleKey), 'orphan-role')
  }

  /** Delete expired rows from the table (at startup and when matching). */
  private sweepExpiredGrants(): void {
    const now = Date.now()
    this.removeGrantRows((row) => row.scope === 'today' && (row.expiresAt === null || row.expiresAt <= now), 'expired')
  }

  /**
   * Delete the rows matching the condition from the storage and memory. **If they cannot be deleted from the storage (after shutdown, or a write failure), memory is not changed either and 0 is returned**
   * (deleting only from memory would bring the rows back on restart, or look deleted while still in the DB). No writing to the storage after shutdown (12.9). Returns the number of rows deleted.
   * The remaining rows are removed by the startup cleanup (`not-read-only` / `orphan-thread` / expired) or at the next opportunity.
   */
  private removeGrantRows(
    match: (row: RoleGrantRow) => boolean,
    reason:
      | 'user'
      | 'job-deleted'
      | 'role-deleted'
      | 'thread-deleted'
      | 'expired'
      | 'not-read-only'
      | 'orphan-thread'
      | 'orphan-job'
      | 'orphan-role'
  ): number {
    const rows = this.roleGrants.filter(match)
    if (rows.length === 0) return 0
    if (this.stopped) return 0
    if (this.grantStore !== null) {
      try {
        this.grantStore.removeRoleGrants(rows.map((row) => row.id))
      } catch (error) {
        log.warn('approval.grant.refused', { reason: 'store', message: error instanceof Error ? error.message : String(error) })
        return 0
      }
    }
    const gone = new Set(rows.map((row) => row.id))
    for (let index = this.roleGrants.length - 1; index >= 0; index -= 1) {
      if (gone.has(this.roleGrants[index]!.id)) this.roleGrants.splice(index, 1)
    }
    for (const row of rows) {
      log.info(reason === 'expired' ? 'approval.grant.expired' : 'approval.grant.removed', {
        roleKey: row.roleKey,
        tool: row.toolName,
        kind: row.subjectKind,
        scope: row.scope,
        ...(reason === 'expired' ? {} : { reason }),
        ...(row.subjectKind === 'path-prefix' && row.subject !== null ? { path: row.subject } : {})
      })
    }
    return rows.length
  }

  /** The rows of a role that can take effect now (after sweeping expired ones). The source of the settings table. */
  listRoleGrants(roleKey: string): readonly RoleGrantRow[] {
    this.sweepExpiredGrants()
    return this.effectiveGrants(null).filter((row) => row.roleKey === roleKey)
  }

  /**
   * The ✕ of the table. Deletes **only when the id is a row of that role** (re-checking a value from the renderer). Not found, or a row of another role, returns false.
   * If it cannot be written to the storage, it is not deleted (it would stay in the table and look to the user as if still in effect).
   */
  removeRoleGrant(roleKey: string, id: string): boolean {
    if (!this.roleGrants.some((row) => row.id === id && row.roleKey === roleKey)) return false
    return this.removeGrantRows((row) => row.id === id && row.roleKey === roleKey, 'user') > 0
  }

  /** When a job (or, stage 4, a Teammate) is deleted, delete all rows of its key. */
  removeRoleGrantsOf(roleKey: string, reason: 'job-deleted' | 'role-deleted' = 'job-deleted'): void {
    this.removeGrantRows((row) => row.roleKey === roleKey, reason)
  }

  /** Update `last_used_at` / `use_count` of rows that passed a request through the table (memory and storage). Nothing is written to the storage after shutdown. */
  private touchRoleGrants(ids: readonly string[]): void {
    const now = Date.now()
    const touched = new Set(ids)
    for (let index = 0; index < this.roleGrants.length; index += 1) {
      const row = this.roleGrants[index]!
      if (touched.has(row.id)) this.roleGrants[index] = { ...row, lastUsedAt: now, useCount: row.useCount + 1 }
    }
    if (this.stopped) return
    if (this.grantStore !== null) {
      try {
        this.grantStore.touchRoleGrants(ids, now)
      } catch (error) {
        log.warn('approval.grant.touch.failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    this.notifyTouched()
  }

  /** Notify as a change of the approval list so that the renderer can re-fetch the table's use counts and last-used times. At most once per 500 ms even if consecutive. */
  private notifyTouched(): void {
    if (this.touchNotifyTimer !== null || this.stopped) return
    this.touchNotifyTimer = setTimeout(() => {
      this.touchNotifyTimer = null
      if (!this.stopped) this.events.onChanged(this.list())
    }, 500)
    this.touchNotifyTimer.unref?.()
  }

  /**
   * Mark a thread as "has read a secret" (TODO 1043). Called when the manager sees a tool_use (including reads that never reach approval) and
   * for an approval request (`secretRead`). Keeps the kind of the first read.
   */
  markSecretRead(threadId: string, source: string): void {
    if (this.secretReads.has(threadId)) return
    this.secretReads.set(threadId, source)
    log.info('approval.secret.marked', { threadId, source })
  }

  /** Whether the thread has a secret marker (TODO 1043). Used by the gateway's `openUrl` and plugin tools to decide whether to ask. */
  hasReadSecret(threadId: string): boolean {
    return this.secretReads.has(threadId)
  }

  /** If this is a path out of a marked thread, the kind of secret read and the name of the path. Otherwise null. */
  private secretEgress(input: ApprovalRequestInput): { source: string; egress: string } | null {
    if (typeof input.egress !== 'string' || input.egress === '') return null
    // review 57-5: the marker is attached after the judgment, so the current request's own read (`secretRead`) is looked at here too.
    const own = typeof input.secretRead === 'string' && input.secretRead !== '' ? input.secretRead : undefined
    const source = this.secretReads.get(input.threadId) ?? own
    return source === undefined ? null : { source, egress: input.egress }
  }

  /** If a request reads a secret, mark the thread whatever the outcome (TODO 1043). Called after the current request's judgment (review 57-5). */
  private noteRequestSecretRead(input: ApprovalRequestInput): void {
    if (typeof input.secretRead === 'string' && input.secretRead !== '') this.markSecretRead(input.threadId, input.secretRead)
  }

  /** When a thread is deleted (TODO 1043). Forget the secret marker and "don't ask about Bash in this conversation". */
  dropThread(threadId: string): void {
    this.secretReads.delete(threadId)
    this.forgetThread(threadId)
    // Rows of "this conversation only" grants (TODO 983 stage 2).
    this.removeGrantRows((row) => row.scope === 'thread' && row.threadId === threadId, 'thread-deleted')
  }

  /** When a thread is deleted or strict mode is turned off (TODO 994). Forget "don't ask about Bash in this conversation from now on". */
  forgetThread(threadId: string): void {
    this.threadGrants.delete(threadId)
  }

  /** Write the rules back to the storage. Does nothing if there is no storage or after shutdown. */
  private persist(): void {
    if (this.ruleStore === null || this.stopped) return
    this.ruleStore.saveApprovalRules(this.sortedRules())
  }

  /**
   * Clean up requests left over when a thread is deleted / a session dies. The reason is received as a kind, not a sentence
   * (TODO 567: the timeline gets a reason code, the model gets the Adapter's fixed English sentence).
   */
  cancelThread(threadId: string, reason: ApprovalCancelReason): void {
    this.cancelWhere((entry) => entry.item.threadId === threadId, reason)
  }

  /**
   * Withdraw one request that the backend stopped waiting for (TODO 632). Called when the gateway receives a cancellation notice
   * (`notifications/cancelled`, `callId`) and when a result arrives for the tool_use of a request in the inbox
   * (`toolUseId`). No clickable dialog is left behind - an answer would no longer arrive.
   * If nothing matches (already decided / auto-allowed and never queued), does nothing and returns false.
   */
  cancelRequest(threadId: string, match: ApprovalRequestMatch, reason: ApprovalCancelReason): boolean {
    const toolUseId = nonEmpty(match.toolUseId)
    const callId = nonEmpty(match.callId)
    if (toolUseId === null && callId === null) return false
    const cancelled = this.cancelWhere(
      (entry) =>
        entry.item.threadId === threadId &&
        ((callId !== null && entry.callId === callId) || (toolUseId !== null && entry.toolUseId === toolUseId)),
      reason
    )
    if (cancelled > 0) log.info('approval.cancelled', { threadId, reason, count: cancelled })
    return cancelled > 0
  }

  private cancelWhere(match: (entry: Pending) => boolean, reason: ApprovalCancelReason): number {
    let count = 0
    for (const [id, entry] of this.pending) {
      if (!match(entry)) continue
      this.pending.delete(id)
      clearExpiry(entry)
      const result = cancelledResult(reason)
      entry.resolve(result)
      this.events.onDecided(entry.item, result)
      count += 1
    }
    if (count > 0) this.events.onChanged(this.list())
    return count
  }

  /**
   * At shutdown. Turn every pending request into a system denial, then drop them.
   * Rules are not written back afterwards (nothing is written after `before-quit` closes the DB - 12.9).
   * The rules themselves were written when they were pressed, so there is nothing to save here.
   * It deliberately does not call `onDecided` (TODO 1073): shutdown is right before the DB closes, and writing to the audit here could become a write after close.
   * So requests withdrawn at shutdown do not remain in the audit (the decided state of `permission_request`).
   */
  shutdown(): void {
    this.stopped = true
    if (this.touchNotifyTimer !== null) clearTimeout(this.touchNotifyTimer)
    this.touchNotifyTimer = null
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearExpiry(entry)
      entry.resolve(cancelledResult('quit'))
    }
    this.events.onChanged([])
  }

  /**
   * Arm the deadline timer (TODO 959). If it is beyond the `setTimeout` limit, re-arm in steps at the limit.
   * When it passes, withdraw as `expired` (`by: 'system'`; the model is told "it was not executed because no answer came").
   */
  private armExpiry(entry: Pending, expiresAt: number): void {
    const wait = Math.max(0, expiresAt - Date.now())
    entry.timer = setTimeout(
      () => {
        entry.timer = null
        if (this.pending.get(entry.item.id) !== entry) return
        if (Date.now() < expiresAt) {
          this.armExpiry(entry, expiresAt)
          return
        }
        log.info('approval.expired', { id: entry.item.id, threadId: entry.item.threadId, tool: entry.item.toolName })
        this.cancelWhere((candidate) => candidate === entry, 'expired')
      },
      Math.min(wait, MAX_TIMER_MS)
    )
    // Waiting for a deadline must not hold up shutdown.
    entry.timer.unref?.()
  }

  // ---- Rules ----

  /** The list of rules. Shown in the inbox's "list of rules and revoking" (one for the whole app). */
  private sortedRules(): ApprovalRule[] {
    return [...this.rules.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  listRules(): readonly ApprovalRule[] {
    // commandHash stays inside main (not passed to the renderer). Only its first 8 digits are attached for display
    // (so rules that differ only in a masked secret do not look the same, wave 42 code-review).
    return this.sortedRules().map(({ commandHash, ...rest }) =>
      commandHash != null && commandHash !== '' ? { ...rest, hashHead: commandHash.slice(0, 8) } : rest
    )
  }

  removeRule(id: string): boolean {
    for (const [key, rule] of this.rules) {
      if (rule.id !== id) continue
      this.rules.delete(key)
      log.info('approval.rule.removed', { tool: rule.toolName })
      this.persist()
      return true
    }
    return false
  }
}

/** TODO 982: why a stopped operation of a drill has no checkbox, from the reason it would be queued for. */
function drillRefusalOf(reason: ApprovalQueueReason): DrillGrantRefusal {
  switch (reason.kind) {
    case 'question':
    case 'plan':
    case 'side-effect':
    case 'outbound':
    case 'persistence':
    case 'secret-read':
    case 'unattended':
    case 'no-command':
    case 'deny-pattern':
      return reason.kind
    default:
      return 'no-subject'
  }
}

function clearExpiry(entry: Pending): void {
  if (entry.timer === null) return
  clearTimeout(entry.timer)
  entry.timer = null
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Whether this is a plan proposal the user asked for (item 112 / 167). This one is always queued whatever happens. */
function isRequestedPlan(input: ApprovalRequestInput): boolean {
  return input.plan !== undefined && input.plan !== null && input.planRequested === true
}

/** The lookup key. The tool name, and only for `Bash` the command as well (the granularity of T12). The thread is not part of it (T40). */
function ruleKey(rule: ApprovalRule): string {
  return `${rule.toolName}\u0000${rule.commandHash ?? ''}`
}

/** TODO 859: the SHA-256 (hex) of the normalized command. Used for matching rules. */
function commandHashOf(normalizedCommand: string): string {
  return createHash('sha256').update(normalizedCommand).digest('hex')
}

/**
 * Validate a rule read from the storage (T22). Treat the DB contents as a "value from outside" too:
 * a row written by an old version or touched by hand must not revive a rule that cannot be made now.
 * Null if it does not pass (only one rule disappears, falling to the side of asking for approval).
 */
function sanitizeRule(rule: ApprovalRule): ApprovalRule | null {
  if (rule.toolName === '') return null
  // No rule can be made for the gateway's own tools (review B-5 of 4.2). Applied to past rows too
  // (before item 110, all `mcp__*` were disallowed. The user's servers have no old rows).
  if (!canAlwaysAllow(rule.toolName)) return null
  if (rule.toolName === BASH) {
    // A Bash rule without a command would pass every command.
    if (rule.command === null || rule.command === '') return null
    // Matching uses the hash. For an old row without a hash, it is made from the plaintext command and the display one is masked (TODO 859).
    const hash = rule.commandHash != null && rule.commandHash !== '' ? rule.commandHash : commandHashOf(normalizeCommand(rule.command))
    return { ...rule, command: redactText(normalizeCommand(rule.command)).text, commandHash: hash }
  }
  // Other tools work with only the tool name, so they are normalized to a form without a command.
  return { id: rule.id, toolName: rule.toolName, command: null, createdAt: rule.createdAt }
}

let cachedHome: string | null = null
/**
 * 983 stage 1: the home directory used to judge a parent that is too broad. The path being matched is a realpath, so the home is also resolved to a realpath (so that a symlinked home
 * does not let the judgment slip through; wave 89 automatic security review). If it cannot be resolved, `homedir()` as is. Resolved once and remembered.
 */
function canonicalHome(): string {
  if (cachedHome !== null) return cachedHome
  const raw = homedir()
  try {
    cachedHome = realpathSync(raw)
  } catch {
    cachedHome = raw
  }
  return cachedHome
}
