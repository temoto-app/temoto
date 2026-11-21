/**
 * Folds a list of `AiosEvent` into a shape ThreadPane can draw (ARCHITECTURE.md 5.1).
 *
 * It is a pure function so that it can be unit-tested separately from rendering.
 * What is guaranteed here:
 * - **Tool calls are gathered into a dedicated block, not Markdown**, and the result and approval
 *   are bundled by the same `toolUseId`.
 * - **A subagent's messages are folded under the parent's tool call** (`parentToolUseId`).
 * - Deltas during streaming are kept separately in `streaming` and dropped when the finalized `assistant_text`
 *   arrives. The concatenation of deltas matches the final message, so no cross-check is needed
 *   (spike 8).
 */
import type {
  AiosEvent,
  ApprovalOutcome,
  JsonValue,
  OutsideWriteScope,
  RateLimitPayload,
  ResultPayload,
  SentAttachment,
  ShellRunPayload,
  SubtaskEndStatus,
  SubtaskUsage,
  ThinkingLevel
} from '@shared/agent.js'
import type { ToolProgress } from '@shared/thread.js'
import { relabelAttachmentMarks } from '@shared/attachment-mark.js'
import type { Translate } from '../i18n/index.js'

export interface ToolItem {
  readonly kind: 'tool'
  readonly id: string
  readonly ts: number
  readonly toolUseId: string
  readonly name: string
  readonly summary: string
  readonly input: JsonValue
  readonly truncated: boolean
  /** The plan body if this is a plan presentation (the full Markdown text, item 167). Absent otherwise and on earlier rows. */
  readonly plan?: string
  /** The direction if this is entering or leaving plan mode (item 275). `foldTimeline` turns it into a `plan` row if present. */
  readonly planTransition?: 'enter' | 'exit'
  /** The path of the plan file (item 275). Omitted if none. */
  readonly planFile?: string
  /** The skill name if this is a call that used a skill (TODO 1100). The source of the badge at the head of a turn (`thread/skills.ts`). */
  readonly skill?: string
  /** The URI of that skill's file (TODO 1105). Read from the row where the backend injected the body. Pressing the badge opens it. */
  readonly skillUri?: string
  /** The result is only the length and success. The contents are not persisted (constraint 10). */
  readonly result: { readonly ok: boolean; readonly bytes: number; readonly text?: string } | null
  /**
   * The turn ended without a result arriving (item 280-5; extended to subagent blocks in wave 18). True only for the tool call that is **first within this
   * `foldTimeline` call** and either was followed by a `result` / `session_started`, or the process is already gone (`live: false` of `foldTimeline`),
   * while its `result` is null.
   * A subagent block (`foldSubagentBlock`) folds only the block's contents separately, so the child's tool calls inside a block are also
   * subject to the same decision as "first within the block" (the parent `Agent` call of the child is not in that list).
   * It is shown as "interrupted", not "running". It is decided just by refolding the saved rows, so it is the same after a restart.
   * If a result arrives (`result !== null`), that wins. Set only when true (false is omitted).
   */
  readonly interrupted?: boolean
  readonly approval: {
    readonly requestId: string
    readonly outcome: ApprovalOutcome
    readonly requestedAt: number
    readonly decidedAt: number | null
  } | null
  /** Child items that go under this call, such as a subagent's messages. */
  readonly children: readonly TimelineItem[]
}

export type TimelineItem =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly ts: number
      readonly text: string
      /** The images sent (TODO 550). The field is absent if none. */
      readonly attachments?: readonly SentAttachment[]
    }
  | {
      readonly kind: 'assistant'
      readonly id: string
      readonly ts: number
      readonly text: string
      readonly actor: 'main' | 'subagent'
    }
  | ToolItem
  | {
      readonly kind: 'approval'
      readonly id: string
      readonly ts: number
      readonly toolName: string
      readonly summary: string
      readonly requestId: string
      readonly outcome: ApprovalOutcome
      readonly requestedAt: number
      readonly decidedAt: number | null
      /** The number of lines of the plan if this is a plan presentation (an observation in item 196). Shown as "Plan (N lines)" in place of `summary`. */
      readonly planLines?: number
    }
  | PlanRow
  | { readonly kind: 'result'; readonly id: string; readonly ts: number; readonly result: ResultPayload }
  | {
      readonly kind: 'error'
      readonly id: string
      readonly ts: number
      readonly message: string
      readonly origin: string
    }
  | {
      readonly kind: 'rate_limit'
      readonly id: string
      readonly ts: number
      readonly info: RateLimitPayload
      /**
       * Whether to show one row in the timeline (item 317). It is shown only when the limit was hit (`rejected`) and at the switch to
       * pay-as-you-go (the previous row was not pay-as-you-go). Other rows are kept as items for the position (`afterId`,
       * `progress.ts`), and ThreadPane draws nothing for them.
       */
      readonly notice: 'rejected' | 'overage' | null
    }
  | {
      readonly kind: 'session'
      readonly id: string
      readonly ts: number
      readonly model: string | null
      readonly resumed: boolean
    }
  | {
      /** A switch of model / thinking (T7 / 4.5.1). */
      readonly kind: 'settings'
      readonly id: string
      readonly ts: number
      readonly modelId: string | null
      readonly thinking: ThinkingLevel | null
      readonly scope: 'message' | 'thread'
      /** How the running process was switched (item 95). Absent on earlier rows. */
      readonly via: 'live' | 'restart' | 'none' | null
    }
  | {
      /**
       * A finished subagent (how item 93 is shown, 4.6.3). One row at the position of `subtask_finished`.
       * The description and kind are taken from the `subtask_started` with the same id. An end whose start was not seen
       * (a tool run, a start in an earlier page, cleanup of a child from before a resume) is not shown.
       */
      readonly kind: 'subtask'
      readonly id: string
      readonly ts: number
      readonly taskId: string
      /** The parent's call that spawned the child (TODO 403: the key to look up `runtime.subagentModels`). */
      readonly toolUseId: string | null
      readonly description: string
      readonly subagentType: string | null
      readonly status: SubtaskEndStatus
      readonly summary: string | null
      readonly usage: SubtaskUsage | null
      readonly startedAt: number
    }
  | {
      /**
       * A conversation boundary (item 117 / 4.5.3.1). `reset` = everything before here is no longer passed to the model (`/clear`),
       * `compacted` = everything before here was replaced by a summary. Token counts exist only for compaction (before and after the conversation part).
       */
      readonly kind: 'boundary'
      readonly id: string
      readonly ts: number
      readonly boundary: 'reset' | 'compacted'
      readonly trigger: 'manual' | 'auto' | null
      readonly preTokens: number | null
      readonly postTokens: number | null
    }
  | {
      /**
       * A shell run with `!` in the prompt box (item 116 / 4.5.7). The command and output (what is saved is already redacted).
       * It is not a backend tool call, so it is a separate row from `ToolItem`.
       */
      readonly kind: 'shell'
      readonly id: string
      readonly ts: number
      readonly run: ShellRunPayload
    }
  | { readonly kind: 'unknown'; readonly id: string; readonly ts: number; readonly hint: string }
  | {
      /** A write to the main working copy by a run split off in a worktree (TODO 700). */
      readonly kind: 'outside_write'
      readonly id: string
      readonly ts: number
      readonly path: string
      readonly scope: OutsideWriteScope
    }

/**
 * The row for entering / leaving plan mode (item 275, looks the same as the CLI / VS Code). It is derived **when folding** from the tool calls of
 * `EnterPlanMode` / `ExitPlanMode` (`ToolItem.planTransition`). The saved shape does not change, so the same row appears after
 * a restore on restart.
 * - `entered`: `Entered plan mode`
 * - `approved`: `User approved the plan` (with a plan)
 * - `exited`: `Exited plan mode` (when the plan is empty)
 * - `stayed`: `Stayed in plan mode` (the plan was declined - keep planning)
 * - `pending`: awaiting approval of the plan (the approval frame is shown above)
 */
export type PlanVerdict = 'entered' | 'approved' | 'exited' | 'stayed' | 'pending'

export interface PlanRow {
  readonly kind: 'plan'
  readonly id: string
  readonly ts: number
  readonly toolUseId: string
  readonly verdict: PlanVerdict
  /** The plan body (for `approved` / `stayed` / `pending`, if any). */
  readonly plan?: string
  /** The path of the plan file. Only when known (`approved`). */
  readonly planFile?: string
}

/** The approval outcome -> the plan row decision (a pure function shared by the approval row and the tool row). */
export function planVerdictOfOutcome(outcome: ApprovalOutcome, hasPlan: boolean): PlanVerdict {
  if (outcome.kind === 'pending') return 'pending'
  if (outcome.kind === 'denied') return 'stayed'
  return hasPlan ? 'approved' : 'exited'
}

/**
 * A row if the tool item is entering / leaving plan, otherwise null. If the entering tool was declined or failed, it stays
 * an ordinary tool row (so it does not falsely say `Entered plan mode`).
 */
export function planRowOf(item: ToolItem): PlanRow | null {
  if (item.planTransition === undefined) return null
  const base = { kind: 'plan' as const, id: item.id, ts: item.ts, toolUseId: item.toolUseId }
  const plan = item.plan === undefined ? {} : { plan: item.plan }
  if (item.planTransition === 'enter') {
    if (item.approval?.outcome.kind === 'denied' || item.approval?.outcome.kind === 'pending') return null
    if (item.result?.ok === false) return null
    return { ...base, verdict: 'entered' }
  }
  const verdict = planVerdictOfOutcome(
    item.approval?.outcome ?? { kind: 'allowed', by: 'default' },
    item.plan !== undefined
  )
  return {
    ...base,
    verdict,
    ...plan,
    ...(verdict === 'approved' && item.planFile !== undefined ? { planFile: item.planFile } : {})
  }
}

export interface FoldedTimeline {
  readonly items: readonly TimelineItem[]
  /** The body being received. Becomes empty when finalized. */
  readonly streaming: string
  /** The thinking being received. Collapsed by default. Not persisted (4.3.1). */
  readonly thinking: string
}

export interface FoldOptions {
  /**
   * Whether the backend process is (or is about to be) running (item 280-5). Default true. If false (`idle` / `error` /
   * `stopping`), a parent tool call that has no result by the end will never get one, so it is marked "interrupted".
   * This removes the leftover "running" right after a restart (the process is `idle`, and the transcript stopped without a `result`).
   */
  readonly live?: boolean
  /**
   * Turns the attachment mark on the first line of the user's own message (the Japanese word for "attachment" plus the name, in parentheses) into a sentence in the display language (TODO 519). If omitted, the mark stays as is.
   * The bubble, the sticky question, the jump box, and in-thread search all look at the same `item.text`, so this is done once, here.
   */
  readonly attachmentLabel?: (name: string) => string
}

/** A copy with the `interrupted` mark removed (when a result arrives late). */
function withoutInterrupted(item: ToolItem): ToolItem {
  if (item.interrupted === undefined) return item
  const copy: { -readonly [K in keyof ToolItem]: ToolItem[K] } = { ...item }
  delete copy.interrupted
  return copy
}

/**
 * Folds an event list. The same list gives the same result (replayable).
 *
 * Item 280-5: a tool call that is first within this call and whose turn ended without a result gets
 * `interrupted` (followed by a `result` / `session_started` / a terminating `error`, or
 * `options.live === false`). In the full timeline (a call that passes `events[threadId]` as is),
 * "first" = really has no parent (`parentToolUseId` is undefined). Rows of a subagent whose parent is alive
 * (with `parentToolUseId`, item 93) may keep running in the background even after the parent's `result`, so they are not subject to this.
 * **Wave 18**: when `foldSubagentBlock` passes only a subagent block separately to this function, the child's
 * tool calls inside the block also become "first within this call" (the parent `Agent` call itself is not in that list), and
 * the same decision applies: if the block is folded with `options.live === false`, unfinished rows inside it also become "interrupted".
 */
export function foldTimeline(events: readonly AiosEvent[], options: FoldOptions = {}): FoldedTimeline {
  const live = options.live !== false
  // While building we want to rewrite things, so keep a mutable draft and freeze at the end.
  interface Draft {
    item: TimelineItem
    /** The child list, used only for tool items. */
    children: Draft[]
    /** The parent tool call this item belongs to. */
    parentToolUseId: string | undefined
    /**
     * Whether no parent was found in `events` for this call (= "first" within this fold).
     * In the full timeline this is the same as "really has no parent", but when a subagent block is folded
     * alone (`foldSubagentBlock`), every event in the block is passed with the id of the `Agent` call (which is outside the block) still in
     * `parentToolUseId`, so the `tool_use` with that id is not in this list. **"First" is decided not by whether `event.parentToolUseId`
     * exists but by whether the parent's draft was actually found** - this makes the same "interrupted" decision as 280-5 (`pendingTop`) work
     * for unfinished rows inside an item 93 block too.
     */
    isTop: boolean
  }

  const drafts: Draft[] = []
  /** toolUseId -> its draft. Looked up in one table regardless of parent or child. */
  const byToolUseId = new Map<string, Draft>()
  let streaming = ''
  let thinking = ''
  /** The most recent main-agent skill call (TODO 1105). What `skill_loaded` attaches to; cleared once attached. */
  let lastSkillDraft: Draft | null = null
  /** Whether the previous `rate_limit` was pay-as-you-go (item 317). null if there is no row yet. */
  let lastOverage: boolean | null = null
  /** The start of a subagent (item 93). Remembered so the end row can get a description. */
  const subagentStarts = new Map<
    string,
    { readonly description: string; readonly subagentType: string | null; readonly ts: number }
  >()

  /** Parent tool calls whose result has not arrived yet (item 280-5). Marked "interrupted" at the end of the turn. */
  const pendingTop = new Set<Draft>()
  const markInterrupted = (): void => {
    for (const draft of pendingTop) {
      if (draft.item.kind === 'tool' && draft.item.result === null) {
        draft.item = { ...draft.item, interrupted: true }
      }
    }
    pendingTop.clear()
  }

  const add = (item: TimelineItem, parentToolUseId: string | undefined): Draft => {
    const parent = parentToolUseId === undefined ? undefined : byToolUseId.get(parentToolUseId)
    const draft: Draft = { item, children: [], parentToolUseId, isTop: parent === undefined }
    if (parent !== undefined) parent.children.push(draft)
    else drafts.push(draft)
    return draft
  }

  for (const event of events) {
    switch (event.kind) {
      case 'user_text':
        streaming = ''
        thinking = ''
        add(
          {
            kind: 'user',
            id: event.id,
            ts: event.ts,
            text:
              options.attachmentLabel === undefined
                ? event.payload.text
                : relabelAttachmentMarks(event.payload.text, options.attachmentLabel),
            // The images sent (TODO 550).
            ...(event.payload.attachments === undefined || event.payload.attachments.length === 0
              ? {}
              : { attachments: event.payload.attachments })
          },
          undefined
        )
        break

      case 'assistant_delta':
        streaming += event.payload.text
        break

      case 'thinking_delta':
        thinking += event.payload.text
        break

      case 'assistant_text':
        // The finalized version arrived, so the in-flight delta is dropped (it matches the concatenation - spike 8).
        streaming = ''
        thinking = ''
        add(
          {
            kind: 'assistant',
            id: event.id,
            ts: event.ts,
            text: event.payload.text,
            actor: event.actor
          },
          event.parentToolUseId
        )
        break

      case 'tool_use': {
        streaming = ''
        thinking = ''
        const draft = add(
          {
            kind: 'tool',
            id: event.id,
            ts: event.ts,
            toolUseId: event.payload.toolUseId,
            name: event.payload.name,
            summary: event.payload.summary,
            input: event.payload.input,
            truncated: event.payload.truncated,
            ...(event.payload.plan === undefined ? {} : { plan: event.payload.plan }),
            ...(event.payload.planTransition === undefined ? {} : { planTransition: event.payload.planTransition }),
            ...(event.payload.planFile === undefined ? {} : { planFile: event.payload.planFile }),
            ...(event.payload.skill === undefined ? {} : { skill: event.payload.skill }),
            result: null,
            approval: null,
            children: []
          },
          event.parentToolUseId
        )
        // Whether it goes under a parent or a child, the result and approval come back here by toolUseId.
        byToolUseId.set(event.payload.toolUseId, draft)
        if (draft.isTop) pendingTop.add(draft)
        if (event.payload.skill !== undefined && event.parentToolUseId === undefined) lastSkillDraft = draft
        break
      }

      case 'tool_result': {
        const draft = byToolUseId.get(event.payload.toolUseId)
        if (draft === undefined || draft.item.kind !== 'tool') break
        pendingTop.delete(draft)
        // A result that arrives late takes priority over "interrupted" (the mark is removed).
        draft.item = {
          ...withoutInterrupted(draft.item),
          result: {
            ok: event.payload.ok,
            bytes: event.payload.bytes,
            ...(event.payload.text === undefined ? {} : { text: event.payload.text })
          }
        }
        break
      }

      // The location of a skill's file (TODO 1105). If the most recent skill call succeeded (no error), attach it to that call.
      // If there is no earlier call, it was an error, or it was already attached, attach it to nothing. O(1).
      case 'skill_loaded': {
        const draft = lastSkillDraft
        lastSkillDraft = null
        if (draft === null || draft.item.kind !== 'tool' || draft.item.skillUri !== undefined) break
        if (draft.item.result === null || !draft.item.result.ok) break
        draft.item = { ...draft.item, skillUri: event.payload.uri }
        break
      }

      case 'permission_request': {
        const approval = {
          requestId: event.payload.requestId,
          outcome: event.payload.outcome,
          requestedAt: event.payload.requestedAt,
          decidedAt: event.payload.decidedAt
        }
        const toolUseId = event.payload.toolUseId
        const draft = toolUseId === null ? undefined : byToolUseId.get(toolUseId)
        if (draft !== undefined && draft.item.kind === 'tool') {
          draft.item = { ...draft.item, approval }
          break
        }
        // An approval arrives **before** the tool runs, so the matching tool_use is usually not there yet.
        // If there is an item with the same requestId, overwrite the outcome (pending -> allowed/denied).
        const existing = findApproval(drafts, event.payload.requestId)
        const item: TimelineItem = {
          kind: 'approval',
          id: event.id,
          ts: event.ts,
          toolName: event.payload.toolName,
          summary: event.payload.summary,
          ...(event.payload.planLines === undefined ? {} : { planLines: event.payload.planLines }),
          ...approval
        }
        if (existing !== undefined) existing.item = item
        else add(item, undefined)
        break
      }

      case 'result':
        streaming = ''
        thinking = ''
        markInterrupted()
        add({ kind: 'result', id: event.id, ts: event.ts, result: event.payload }, undefined)
        break

      case 'error':
        // On process exit (`exit`), calls that have no result will never get one (item 280-5).
        // Also clear a half-written in-flight bubble (TODO 941, same rule as `resetsStreaming` in `thread-events.ts`).
        if (event.payload.origin === 'exit') {
          streaming = ''
          thinking = ''
          markInterrupted()
        }
        add(
          {
            kind: 'error',
            id: event.id,
            ts: event.ts,
            message: event.payload.message,
            origin: event.payload.origin
          },
          undefined
        )
        break

      case 'rate_limit': {
        // Item 317: the "usage: allowed_warning" row that came every turn was dropped (the usage rate is in the BottomBar).
        // The switch to pay-as-you-go is compared with the previous `rate_limit`. Only `rejected` / pay-as-you-go rows are saved
        // (ThreadStore), so after reopening "the previous one is unknown" and it shows once as a switch.
        const overageStarted = event.payload.usingOverage && lastOverage !== true
        lastOverage = event.payload.usingOverage
        const notice =
          event.payload.status === 'rejected' ? 'rejected' : overageStarted ? 'overage' : null
        add({ kind: 'rate_limit', id: event.id, ts: event.ts, info: event.payload, notice }, undefined)
        break
      }

      case 'session_started':
        // A new process: calls that had no result by then will never get one (stop, crash, restart).
        // The in-flight string also belongs to the previous process (TODO 941).
        streaming = ''
        thinking = ''
        markInterrupted()
        add(
          {
            kind: 'session',
            id: event.id,
            ts: event.ts,
            model: event.payload.model,
            resumed: event.payload.resumed
          },
          undefined
        )
        break

      case 'settings_changed':
        add(
          {
            kind: 'settings',
            id: event.id,
            ts: event.ts,
            modelId: event.payload.modelId,
            thinking: event.payload.thinking,
            scope: event.payload.scope,
            via: event.payload.via ?? null
          },
          undefined
        )
        break

      case 'unknown':
        add(
          { kind: 'unknown', id: event.id, ts: event.ts, hint: event.payload.hint ?? '?' },
          undefined
        )
        break

      // A conversation boundary (item 117). The in-flight string is not touched: a boundary only comes after a `result`, so
      // the in-flight string is already empty at that point. **Do not add this to RESETS_STREAMING in `thread-events.ts`**
      // (if added, do both at once. A pitfall of item 88).
      case 'conversation_reset':
        add(
          {
            kind: 'boundary',
            id: event.id,
            ts: event.ts,
            boundary: 'reset',
            trigger: null,
            preTokens: null,
            postTokens: null
          },
          undefined
        )
        break

      case 'context_compacted':
        add(
          {
            kind: 'boundary',
            id: event.id,
            ts: event.ts,
            boundary: 'compacted',
            trigger: event.payload.trigger,
            preTokens: event.payload.preTokens,
            postTokens: event.payload.postTokens
          },
          undefined
        )
        break

      case 'shell_run':
        // The result of `!` (item 116). The in-flight body is not touched (it is a separate event from the backend's turn).
        add({ kind: 'shell', id: event.id, ts: event.ts, run: event.payload }, undefined)
        break

      case 'turn_usage':
        // Context usage (item 60) is not shown in the timeline. The Composer's pie chart draws
        // `ThreadRuntime.contextUsage` (the last one).
        break

      case 'subtask_started':
        // Background work (item 93 / 4.6.3). No start row is shown: while it is running, the list above the Composer
        // (`SubtaskList`, `ThreadRuntime.subtasks`) shows it. Tool runs are not remembered.
        if (event.payload.isSubagent && !subagentStarts.has(event.payload.taskId)) {
          subagentStarts.set(event.payload.taskId, {
            description: event.payload.description,
            subagentType: event.payload.subagentType,
            ts: event.ts
          })
        }
        break

      case 'subtask_progress':
      case 'subtask_backgrounded':
        // Progress is not saved, and the list draws it from runtime. It is not shown in the timeline. The notice that work moved to the background (TODO 1196) is also
        // not saved; main's record (the list spinner) just counts it.
        break

      case 'tool_progress':
        // Tool progress (item 259). Not saved; the tool row shows seconds from main's record (`runtime.toolProgress`)
        // (so the same value can be looked up after reopening or in another window). No row is made.
        break

      case 'api_retry':
      case 'mcp_connecting':
      case 'vcs_state_changed':
      case 'background_tasks':
        // Item 277. Not saved and not made a row (a retry is a single in-progress line, and git only re-fetches the BottomBar).
        // The full set of background work of TODO 1196 is the same: it only replaces main's record (the list spinner).
        break

      case 'worktree_changed':
        // TODO 633. Not saved and not made a row (the move tool's row already exists. Following the working folder is main's list).
        break

      case 'outside_write':
        // TODO 700: a write to the main working copy by a run split off in a worktree. A mark row after the write row.
        add(
          {
            kind: 'outside_write',
            id: event.id,
            ts: event.ts,
            path: event.payload.path,
            scope: event.payload.scope
          },
          undefined
        )
        break

      case 'subtask_finished': {
        const start = subagentStarts.get(event.payload.taskId)
        if (start === undefined) break
        subagentStarts.delete(event.payload.taskId)
        add(
          {
            kind: 'subtask',
            id: event.id,
            ts: event.ts,
            taskId: event.payload.taskId,
            toolUseId: event.payload.toolUseId,
            description: start.description,
            subagentType: start.subagentType,
            status: event.payload.status,
            summary: event.payload.summary,
            usage: event.payload.usage,
            startedAt: start.ts
          },
          undefined
        )
        break
      }
    }
  }

  if (!live) markInterrupted()
  return { items: drafts.map(freeze), streaming, thinking }

  function freeze(draft: Draft): TimelineItem {
    if (draft.item.kind !== 'tool') return draft.item
    const row = planRowOf(draft.item)
    if (row !== null) return row
    return { ...draft.item, children: draft.children.map(freeze) }
  }

  function findApproval(list: Draft[], requestId: string): Draft | undefined {
    for (const draft of list) {
      if (draft.item.kind === 'approval' && draft.item.requestId === requestId) return draft
      const found = findApproval(draft.children, requestId)
      if (found !== undefined) return found
    }
    return undefined
  }
}

/**
 * The time an approval has been held (4.2: make old requests stand out). **`t` is passed by the caller (the renderer) because
 * main does not know the language** (TODO 66).
 */
export function formatHeld(ms: number, t: Translate): string {
  if (ms < 60_000) return t('timeline.held.seconds', { n: Math.floor(ms / 1000) })
  if (ms < 3_600_000) return t('timeline.held.minutes', { n: Math.floor(ms / 60_000) })
  return t('timeline.held.hours', { n: Math.floor(ms / 3_600_000) })
}

/**
 * "When it was created" (4.2.1: approval rules now persist across restarts, so this lets you tell apart a rule
 * you no longer remember pressing). Today's shows only the time, others only the date.
 * Seconds are not needed, and in exchange the full date and time goes into the element's `title`.
 */
export function formatWhen(ts: number, t: Translate, now = Date.now()): string {
  const at = new Date(ts)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  if (at.toDateString() === new Date(now).toDateString()) {
    return t('timeline.when.today', { hh, mm })
  }
  return `${at.getMonth() + 1}/${at.getDate()}`
}

/** Byte units (`B` / `KB` / `MB` / `GB` / `TB`) are the same in every language, so it does not take `t`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 4).toFixed(1)} TB`
}

/**
 * The elapsed seconds of a running tool (item 259). Advances the reported seconds by "the time since the report was received"
 * (reports come every 30 seconds, and the renderer fills in between). `at` is main's clock, but it is the same machine so they agree.
 */
export function toolProgressSeconds(progress: ToolProgress, now: number): number {
  return progress.elapsedSeconds + Math.floor(Math.max(0, now - progress.at) / 1000)
}

/** `12s` / `1m 5s` / `1h 2m` (the CLI's way of writing elapsed time). Units do not depend on the language, so it does not take `t`. */
export function formatToolElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const s = total % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}
