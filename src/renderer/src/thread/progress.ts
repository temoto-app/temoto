/**
 * Building the rows of the interim report "what is being looked at now" (ARCHITECTURE.md 5.1.3 / TODO 15).
 *
 * Like `foldTimeline` these are **pure functions**, unit-tested without a DOM
 * (`test/progress-lines.test.ts`). What is guaranteed here:
 *
 * - **The inputs are the `progress` of `tool_use` and the `hook_run` of a configured hook that has finished** (item 126-3).
 *   main (the adapter) decides the kind from the backend-specific tool name and passes it in (constraint 6).
 *   The renderer does not look at names. A hook row has only the name and the result; the output does not arrive (and is not saved).
 * - **Built per turn** (split at `user_text`). The list is the same during a response and after it is finalized,
 *   and reopening a past turn shows the same thing.
 * - **Identical items are folded** (same kind + display string + destination becomes one row with a count).
 *   The position stays at **where it first appeared** (rows jumping around is hard to read).
 * - **`other`, which has no display string, is folded into one row** ("N other operations").
 *   Showing all of them would fill the interim report.
 * - **Truncated to the latest N rows. What disappears is the older side**, so the last row (= where the spinner is)
 *   is never removed by the truncation.
 */
import type { AiosEvent, HookRunPayload, ToolProgressKind } from '@shared/agent.js'
import type { ApiRetry } from '@shared/thread.js'
import type { Translate } from '../i18n/index.js'

/**
 * The kind of a row. The tool kinds plus the row for a configured hook that has finished (`hook`, item 126-3).
 * Like `other`, `hook` gets no heading and shows the already-built `label` as is.
 */
export type ProgressLineKind = ToolProgressKind | 'hook'

/** The cap on the number of rows shown (8 rows, same as qlm). */
export const MAX_PROGRESS_LINES = 8

export interface ProgressLine {
  /** The React key. The id of the `tool_use` (or `hook_run`) event that first created this row. */
  readonly id: string
  readonly kind: ProgressLineKind
  /** The value shown (search term / shortened URL / parent directory name + file name / fixed phrase). */
  readonly label: string
  /** The destination when clicked. Not clickable if absent. */
  readonly href: string | null
  /** How many times the same thing occurred. The count is not shown for 1. */
  readonly count: number
}

export interface ProgressTurn {
  /** The turn's identity (the id of its first event). */
  readonly id: string
  /** The last event id of this turn. Used for the draw position (right after this item). */
  readonly afterId: string
  /** The rows shown (the latest MAX_PROGRESS_LINES rows). */
  readonly lines: readonly ProgressLine[]
  /** The number of older rows cut off. */
  readonly omitted: number
  /** The N of "Referenced materials (N)". The number of search / fetch / file rows (after folding). */
  readonly referenced: number
}

/** The kinds that `foldTimeline` makes into their own rows (folded ones cannot be used as a position). */
const ITEM_KINDS: ReadonlySet<AiosEvent['kind']> = new Set([
  'user_text',
  'assistant_text',
  'tool_use',
  'result',
  'error',
  'rate_limit',
  'session_started',
  'conversation_reset',
  'context_compacted',
  'unknown'
])

interface Bucket {
  id: string
  kind: ProgressLineKind
  label: string
  href: string | null
  count: number
}

/** A draft for one turn. */
interface TurnDraft {
  id: string
  afterId: string
  order: Bucket[]
  byKey: Map<string, Bucket>
  others: number
  othersId: string | null
}

function newTurn(id: string): TurnDraft {
  return { id, afterId: id, order: [], byKey: new Map(), others: 0, othersId: null }
}

/**
 * Event list -> the interim report per turn. **The same list gives the same result** (replayable).
 * Turns with no rows are also returned (so the caller can draw "responding but no rows yet").
 *
 * **`t` is needed only to build "N other operations"** (main does not know the language, TODO 66).
 * Other rows (those whose `kind` is not `other`) keep `label` as is, and the wording is
 * added by `progressLineText` (at draw time).
 */
export function buildProgressTurns(
  events: readonly AiosEvent[],
  t: Translate,
  limit: number = MAX_PROGRESS_LINES
): readonly ProgressTurn[] {
  const turns: TurnDraft[] = []
  let current: TurnDraft | null = null

  for (const event of events) {
    if (event.kind === 'user_text' || current === null) {
      current = newTurn(event.id)
      turns.push(current)
    }
    // The draw position is "the last event that has its own row in the timeline". `tool_result` and
    // approvals are folded into the tool row by `foldTimeline`, so no id remains and they cannot be used as a position.
    if (ITEM_KINDS.has(event.kind) && event.parentToolUseId === undefined) {
      current.afterId = event.id
    }

    if (event.kind === 'hook_run') {
      // A configured hook (item 126-3). One row with only the name and the result. The same name and the same result are folded
      // (if both the settings and the personal settings have a hook for the same event, the names are the same).
      addBucket(current, event.id, 'hook', hookLabel(t, event.payload), null)
      continue
    }
    if (event.kind !== 'tool_use') continue
    const hint = event.payload.progress
    // Rows saved before this feature have no `progress`. Do not guess from the name;
    // fold into "N other operations" (the flip side of not deciding the kind in the renderer).
    if (hint === undefined || (hint.kind === 'other' && hint.label === '')) {
      current.others += 1
      current.othersId ??= event.id
      continue
    }
    addBucket(current, event.id, hint.kind, hint.label, hint.href ?? null)
  }

  return turns.map((turn) => {
    const lines: ProgressLine[] = turn.order.map((b) => ({
      id: b.id,
      kind: b.kind,
      label: b.label,
      href: b.href,
      count: b.count
    }))
    if (turn.others > 0 && turn.othersId !== null) {
      lines.push({
        id: turn.othersId,
        kind: 'other',
        label: t('progress.others', { count: turn.others }),
        href: null,
        count: 1
      })
    }
    // Only searches, links, and materials count as "Referenced materials" (a hook is not a material).
    const referenced = lines.filter((line) => line.kind !== 'other' && line.kind !== 'hook').length
    const omitted = Math.max(0, lines.length - limit)
    return {
      id: turn.id,
      afterId: turn.afterId,
      lines: omitted === 0 ? lines : lines.slice(omitted),
      omitted,
      referenced
    }
  })
}

/** The same thing (kind + display string + destination) is folded and counted, and the position stays where it first appeared. */
function addBucket(
  turn: TurnDraft,
  id: string,
  kind: ProgressLineKind,
  label: string,
  href: string | null
): void {
  const key = `${kind}\u0000${label}\u0000${href ?? ''}`
  const found = turn.byKey.get(key)
  if (found !== undefined) {
    found.count += 1
    return
  }
  const bucket: Bucket = { id, kind, label, href, count: 1 }
  turn.byKey.set(key, bucket)
  turn.order.push(bucket)
}

/** The sentence of a hook row (item 126-3): "hook <name> (<result>)". The exit code is added only on failure. */
export function hookLabel(t: Translate, hook: HookRunPayload): string {
  const outcome =
    hook.outcome === 'success'
      ? t('progress.hook.success')
      : hook.outcome === 'error'
        ? hook.exitCode === null
          ? t('progress.hook.error')
          : t('progress.hook.errorExit', { code: hook.exitCode })
        : hook.outcome === 'cancelled'
          ? t('progress.hook.cancelled')
          : t('progress.hook.other')
  return t('progress.hook', { name: hook.hookName, outcome })
}

/**
 * One row for an API call retry (item 277): "Retry 5/10 - in 9 seconds (HTTP 529)".
 * The wait is truncated seconds (same as the CLI's "Retrying in 9s"; 9.6 s is 9). No parentheses if there is no status code. The body of `error` does not arrive (main drops it).
 */
export function apiRetryText(t: Translate, retry: ApiRetry): string {
  return t('progress.apiRetry', {
    attempt: retry.attempt,
    max: retry.maxRetries,
    seconds: Math.floor(retry.retryDelayMs / 1000),
    status: retry.errorStatus === null ? '' : t('progress.apiRetry.status', { status: retry.errorStatus })
  })
}

/**
 * The keys of the kind headings. `other` shows the fixed phrase (already built into `label`) as is, so it gets no heading.
 * `hook` is the same (the "hook <name> (<result>)" is already built).
 */
const KIND_LABEL_KEY: Readonly<Record<ProgressLineKind, 'progress.kind.search' | 'progress.kind.fetch' | 'progress.kind.file' | null>> = {
  search: 'progress.kind.search',
  fetch: 'progress.kind.fetch',
  file: 'progress.kind.file',
  other: null,
  hook: null
}

/** The display string of one row. */
export function progressLineText(t: Translate, line: ProgressLine): string {
  const headKey = KIND_LABEL_KEY[line.kind]
  const body = headKey === null ? line.label : `${t(headKey)}: ${line.label}`
  return line.count > 1 ? t('progress.timesSuffix', { body, count: line.count }) : body
}
