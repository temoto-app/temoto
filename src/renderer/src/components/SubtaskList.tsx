/**
 * The list of subagents (the presentation of item 93, ARCHITECTURE.md 4.6.3).
 *
 * - **Running subagents** are shown at the end of ThreadPane, right above the Composer's place (the approval screen if awaiting approval, `ApprovalOrComposer`) (`SubtaskList`).
 *   By default a subagent also runs outside the parent's turn (after `result`), so it is shown for as long as
 *   `ThreadRuntime.subtasks` is non-empty, not depending on whether a response is in progress. After item 257 shrank it to a count and an entry for jumping,
 *   **TODO 403 made it a vertical list with one row per subagent** (side-by-side chips were hard to tell apart): the heading (count and
 *   total tokens) is its own line, and each row is state mark · description · model · elapsed time · tokens · current activity
 *   (in a faint color). The numeric columns are right-aligned with `tabular-nums`, and when narrow they drop in the order activity -> tokens (CSS
 *   container query). Beyond 8 rows, only the rows part scrolls. Pressing a row jumps to the block (`SubagentBlock`) at the position of the timeline's
 *   `Agent` call. Up/Down / Home / End move between rows (`list-keys.ts`).
 *   The child's tool calls and messages are shown by the block (the same role as the CLI's one-row-per-subagent list).
 * - **A finished subagent** leaves one row at the position of the timeline's `subtask_finished` (`SubtaskFinishedNote`).
 *   The summary is shown below it, with the duration and the model learned during this launch (`runtime.subagentModels`, not saved).
 * - A child's tokens are not included in the parent's context (item 60's donut), so the total is shown in the
 *   heading separately from the donut.
 * - **Re-rendering is confined to this component** (item 88). It subscribes only to `runtime.subtasks` (if the contents are the same,
 *   thread-index.ts reuses the same array), and the per-second redraw of the elapsed time is also done in its own state.
 *   ThreadPane and Composer are not re-rendered for this.
 * - Work for which `isSubagent` is false (a background shell, etc.) is not put in at main's stage (the same as the counting of eviction).
 * - **The mark at the head of a button is the same as the block's** (item 321): running = spinner, awaiting approval = pause (`SubagentStateMark`).
 *   Whether it is awaiting approval is looked up with `subtask.taskId` in the inbox (`approvals`). A finished subagent disappears from the list, so check / x marks are not shown.
 * - **"Stop all" at the right end of the heading** (TODO 1153 stage 1). With the same entry point as the prompt field's stop button (`threads.interrupt`),
 *   subagents can be stopped even after the parent's turn has ended (after the stop button has returned to the up arrow). Main closes the subagents as "stopped" and stops the processes.
 *   After pressing, it shows "Stopping..." and cannot be pressed until the list disappears (so a double press does not stop a process that has restarted).
 */
import { useEffect, useRef, useState } from 'react'
import type { RunningSubtask } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'
import type { TimelineItem } from '../thread/timeline.js'
import { listKeyStep, navKey } from '../list-keys.js'
import {
  finishedElapsedMs,
  formatElapsed,
  formatTokens,
  subagentState,
  subtaskAwaitingApproval,
  subtaskElapsedMs,
  totalSubtaskTokens
} from '../thread/subtasks.js'
import { revealSubagentBlock, SubagentStateMark } from './SubagentBlock.js'
import { SubtaskWorktreeMark } from './SubtaskWorktreeMark.js'

/** Make the empty default a module constant (writing `?? []` inside a selector would cause infinite re-rendering). */
const NO_SUBTASKS: readonly RunningSubtask[] = []

/** Interval for redrawing the elapsed time. The display is in seconds. */
const TICK_MS = 1000

export function SubtaskList({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const subtasks = useThreads(
    (state) => state.threadsById[threadId]?.runtime.subtasks ?? NO_SUBTASKS
  )
  // The awaiting-approval mark (item 321). The inbox becomes a different array only when it changes.
  const approvals = useThreads((state) => state.approvals)
  const stopAll = useThreads((state) => state.interrupt)
  const [stopping, setStopping] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rowsRef = useRef<HTMLDivElement>(null)
  const running = subtasks.length > 0

  // When the list disappears (stopped or finished), reset it for the next time.
  useEffect(() => {
    if (!running) setStopping(false)
  }, [running])

  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [running])

  if (!running) return null
  const total = totalSubtaskTokens(subtasks)

  // Up/Down / Home / End move between rows (`list-keys.ts` of TODO 357, stopping at the ends). Enter / Space are the button's default.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const key = navKey(event)
    if (key === null || rowsRef.current === null) return
    const rows = [...rowsRef.current.querySelectorAll<HTMLButtonElement>('.subtask-row')]
    const current = rows.findIndex((row) => row === document.activeElement)
    const next = listKeyStep(key, current, rows.length, { wrap: false })
    if (next === null) return
    event.preventDefault()
    rows[next]?.focus()
  }

  return (
    <div className="subtask-list" role="status" aria-live="polite">
      <div className="subtask-header-line">
        <div className="subtask-header" title={t('subtasks.tokensNote')}>
          {t('subtasks.heading', { count: subtasks.length })}
          {total > 0 ? (
            <span className="subtask-total">
              {' · '}
              {t('subtasks.total', { tokens: formatTokens(total) })}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="subtask-stop-all"
          disabled={stopping}
          title={t('subtasks.stopAllHint')}
          onClick={() => {
            setStopping(true)
            stopAll(threadId).catch(() => setStopping(false))
          }}
        >
          {stopping ? t('subtasks.stoppingAll') : t('subtasks.stopAll')}
        </button>
      </div>
      <div className="subtask-rows" ref={rowsRef} onKeyDown={onKeyDown} aria-label={t('subtasks.rowsLabel')}>
        {subtasks.map((subtask) => {
          const waiting = subtaskAwaitingApproval(approvals, threadId, subtask.taskId)
          const state = subagentState(subtask, null, waiting) ?? 'running'
          const activity = waiting
            ? t('subagent.state.waiting')
            : (subtask.activity ??
              (subtask.lastToolName === null ? '' : t('subtasks.lastTool', { tool: subtask.lastToolName })))
          return (
            <button
              type="button"
              key={subtask.taskId}
              className={`subtask-row subtask-${subtask.status} subagent-state-${state}`}
              disabled={subtask.toolUseId === null}
              onClick={() => {
                if (subtask.toolUseId !== null) revealSubagentBlock(subtask.toolUseId)
              }}
              title={rowTitle(subtask, waiting, t)}
            >
              <SubagentStateMark state={state} />
              <span className="subtask-desc">{subtask.description}</span>
              <SubtaskWorktreeMark threadId={threadId} toolUseId={subtask.toolUseId} plain />
              <span className="subtask-model">{subtask.model ?? ''}</span>
              <span className="subtask-time">{formatElapsed(subtaskElapsedMs(subtask, now))}</span>
              <span className="subtask-tokens">
                {subtask.usage === null ? '' : formatTokens(subtask.usage.totalTokens)}
              </span>
              <span className="subtask-activity">{activity}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The row's title. Description, kind, model, state, current activity, tokens (the same material as the main block). */
function rowTitle(subtask: RunningSubtask, waiting: boolean, t: ReturnType<typeof useT>): string {
  const parts = [subtask.description]
  if (subtask.subagentType !== null) parts.push(subtask.subagentType)
  if (subtask.model !== null) parts.push(subtask.model)
  parts.push(waiting ? t('subagent.state.waiting') : t(`subtasks.status.${subtask.status}`))
  if (subtask.activity !== null) parts.push(subtask.activity)
  else if (subtask.lastToolName !== null) parts.push(t('subtasks.lastTool', { tool: subtask.lastToolName }))
  if (subtask.usage !== null) {
    parts.push(t('subtasks.tokens', { tokens: formatTokens(subtask.usage.totalTokens) }))
  }
  parts.push(t('subtasks.jump'))
  return parts.join(' · ')
}

type SubtaskItem = Extract<TimelineItem, { kind: 'subtask' }>

/** One row of a finished child (timeline). The summary is text the child's model wrote, and it is saved after redaction. */
export function SubtaskFinishedNote({
  item,
  threadId
}: {
  item: SubtaskItem
  /** This timeline's thread (to look up the child's model and the worktree mark). */
  threadId: string | null
}): React.JSX.Element {
  const t = useT()
  const elapsed = finishedElapsedMs(item.usage, item.startedAt, item.ts)
  // TODO 403: the child's model learned during this launch (not saved, so it is not shown after a restart). A string is fetched, so
  // a growing number of other rows' models does not cause a re-render.
  const model = useThreads((state) => {
    if (threadId === null || item.toolUseId === null) return undefined
    return state.threadsById[threadId]?.runtime.subagentModels?.[item.toolUseId]
  })
  return (
    <div className={`timeline-note subtask subtask-${item.status}`}>
      <div className="subtask-note-line">
        <strong>{t('timeline.subtask')}</strong> {item.description}
        {item.subagentType === null ? '' : ` (${item.subagentType})`} ·{' '}
        {model === undefined ? '' : `${model} · `}
        {t(`subtasks.status.${item.status}`)} · {formatElapsed(elapsed)}
        {item.usage === null
          ? ''
          : ` · ${t('subtasks.tokens', { tokens: formatTokens(item.usage.totalTokens) })}`}
        {/* TODO 633 stage 2: the worktree of the child that really exists (learned during this launch, not saved). */}
        <SubtaskWorktreeMark threadId={threadId} toolUseId={item.toolUseId} spaced />
      </div>
      {item.summary === null || item.summary === '' ? null : (
        <div className="subtask-summary" title={item.summary}>{item.summary}</div>
      )}
    </div>
  )
}
