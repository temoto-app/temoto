/**
 * A subagent block (item 257, wave 15 bundle A, ARCHITECTURE.md 4.6.3 "blocks").
 *
 * Under the parent timeline's `Agent` call (ToolBlock), it shows what that subagent read, ran and
 * said (the form of the VS Code extension / CLI). By default it shows the last few steps and "+N"; pressing shows everything.
 *
 * - **Re-rendering is confined to this component** (item 88). It subscribes only to its own block (`childEvents[threadId][toolUseId]`)
 *   and, while running, its own record (the one entry in `runtime.subtasks` with the same `toolUseId`). Even when child rows
 *   arrive, ThreadPane is not re-rendered (child rows do not go into `events`, see `thread/subagent-blocks.ts`).
 * - The rows inside use ThreadPane's `Item` as is (`renderItem`). A child's tool call is an ordinary
 *   ToolBlock (pressing shows arguments and result), and a child's message is `message subagent` (vertical line `--subagent-line`).
 * - While running, the first line is "current activity · elapsed time · tokens · tool count". The redraw every
 *   second is confined to this component's state, and no timer is set when it is not running.
 * - Collapse / expand is remembered only inside the window (not saved). When arriving from the list above the prompt field (`SubtaskList`)
 *   (`revealSubagentBlock`), the frame is highlighted for a short time. When arriving from a conversation search to a child's message,
 *   it is expanded even if collapsed (the row cannot be scrolled to if it is not in the DOM).
 * - **State is distinguished by color and mark** (item 321): running / awaiting approval / done / failed / stopped are shown by the color of the vertical line
 *   at the left of the block (a `subagent-state-` class with the state name) and the mark on the first line (spinner / pause / check / x / stop square). After it ends the first line
 *   is kept too (from the usage in the end notification: "done · 0:16 · 19.5k tokens · 1 tool call"), so that blocks of subagents that ran in parallel can be compared.
 *   The sources are the record (`runtime.subtasks`), the inbox (`subtask.taskId` of `approvals`) and the end notification in the parent's
 *   sequence (`finishedSubtasksByToolUse`). All are fetched with selectors that return a boolean or the same reference, so other blocks are not re-rendered.
 * - **TODO 403**: the child's model (`runtime.subagentModels`, not saved) is added at the head of the numbers on the first line,
 *   in the same order as the rows of the list above the Composer (model · elapsed time · tokens). After a restart there is no model, and it starts from the duration.
 * - **Wave 18 (observation on 333)**: when a child becomes Stopped / Failed, or when the whole thread's process is gone
 *   (the same `live` criterion as ThreadPane), the block is folded with `foldSubagentBlock(events, { live: false })`.
 *   A child's tool-call row with no result does not stay "running"; it becomes "interrupted" (`tool.interrupted`) like the parent
 *   (`ToolItem.interrupted`, `timeline.ts`).
 */
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { SubtaskFinishedPayload } from '@shared/agent.js'
import type { RunningSubtask } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'
import type { TimelineItem } from '../thread/timeline.js'
import {
  blockHasEvent,
  foldSubagentBlock,
  NO_CHILD_EVENTS,
  subagentAnchorId,
  subagentBlockView
} from '../thread/subagent-blocks.js'
import {
  finishedSubtasksByToolUse,
  formatElapsed,
  formatTokens,
  subagentState,
  subagentStateMark,
  subtaskAwaitingApproval,
  subtaskElapsedMs,
  type SubagentState
} from '../thread/subtasks.js'
import { Spinner } from './Spinner.js'
import { SubtaskWorktreeMark } from './SubtaskWorktreeMark.js'
import { useFindPending } from '../threadFindStore.js'
import { itemFindText } from '../thread/find-hidden.js'
import { FIND_ROOT_ATTR } from '../thread/find-dom.js'

/** How long a block that was jumped to stays highlighted. */
const FLASH_MS = 1500
/** Interval for redrawing the elapsed time. The display is in seconds. */
const TICK_MS = 1000

interface BlockUiState {
  /** Expanded blocks (the id of the parent's `Agent` call). Only inside the window. */
  readonly expanded: Readonly<Record<string, true>>
  /** The block highlighted now. */
  readonly flash: string | null
  toggle(toolUseId: string): void
  /** Expand (in-thread search found a hit in a hidden row and advanced to it, TODO 496). */
  expand(toolUseId: string): void
}

const useBlockUi = create<BlockUiState>((set) => ({
  expanded: {},
  flash: null,
  toggle(toolUseId): void {
    set((state) => {
      const expanded = { ...state.expanded }
      if (expanded[toolUseId] === true) delete expanded[toolUseId]
      else expanded[toolUseId] = true
      return { expanded }
    })
  },
  expand(toolUseId): void {
    set((state) => (state.expanded[toolUseId] === true ? state : { expanded: { ...state.expanded, [toolUseId]: true } }))
  }
}))

let flashTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Jump from the list above the prompt field to a block (item 257). If the block is not in the DOM yet (it is on a previous page, or
 * not a single child row has arrived), do nothing and return false.
 */
export function revealSubagentBlock(toolUseId: string): boolean {
  const target = document.getElementById(subagentAnchorId(toolUseId))
  if (target === null) return false
  target.scrollIntoView({ block: 'nearest' })
  useBlockUi.setState({ flash: toolUseId })
  if (flashTimer !== null) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashTimer = null
    useBlockUi.setState({ flash: null })
  }, FLASH_MS)
  return true
}

function findRunning(
  subtasks: readonly RunningSubtask[] | undefined,
  toolUseId: string
): RunningSubtask | undefined {
  if (subtasks === undefined) return undefined
  for (const subtask of subtasks) if (subtask.toolUseId === toolUseId) return subtask
  return undefined
}

export function SubagentBlock({
  threadId,
  toolUseId,
  renderItem
}: {
  threadId: string
  toolUseId: string
  renderItem: (item: TimelineItem) => React.JSX.Element | null
}): React.JSX.Element | null {
  const t = useT()
  const events = useThreads((state) => state.childEvents[threadId]?.[toolUseId] ?? NO_CHILD_EVENTS)
  const running = useThreads((state) =>
    findRunning(state.threadsById[threadId]?.runtime.subtasks, toolUseId)
  )
  // Item 321: the end notification (the same payload reference for the same row) and whether it is awaiting approval (a boolean).
  const finished = useThreads((state) => {
    const parent = state.events[threadId]
    return parent === undefined ? undefined : finishedSubtasksByToolUse(parent).get(toolUseId)
  })
  // Wave 18 (observation on 333): whether this block "will get no more continuation". Either (1) the backend process of the whole thread
  // is gone (`runtime.live`, the same material as "is it responding" in Composer.tsx), or (2) this child holds a Stopped / Failed
  // end notification (`completed` is not counted, since normally nothing continues after it). A child whose parent process died while awaiting approval
  // (`runtime.live` drops with no end notification) is also caught by this.
  const threadLive = useThreads((state) => state.threadsById[threadId]?.runtime.live === true)
  // TODO 403: the child's model (a string is fetched, so a growing number of other children's models does not cause a re-render).
  const model = useThreads((state) => state.threadsById[threadId]?.runtime.subagentModels?.[toolUseId] ?? null)
  const ended = !threadLive || (finished !== undefined && finished.status !== 'completed')
  const taskId = running?.taskId ?? null
  const waiting = useThreads((state) =>
    taskId === null ? false : subtaskAwaitingApproval(state.approvals, threadId, taskId)
  )
  // Whether we arrived from a conversation search to a child's message (only a boolean is fetched, so other blocks are not re-rendered).
  const searched = useThreads((state) => blockHasEvent(events, state.highlightEventId))
  const expanded = useBlockUi((state) => state.expanded[toolUseId] === true)
  const flash = useBlockUi((state) => state.flash === toolUseId)
  const toggle = useBlockUi((state) => state.toggle)
  const items = useMemo(() => foldSubagentBlock(events, { live: !ended }), [events, ended])
  const view = useMemo(
    () => subagentBlockView(items, expanded || searched),
    [items, expanded, searched]
  )
  // In-thread search (decision 5 of TODO 496): rows hidden behind "+N" are also searched. The mark goes on the "+N" button (the position of the hidden rows), and
  // after it is opened, the match is chosen from inside the block's root (`data-find-root`).
  const hiddenText = useMemo(
    () => (view.hidden === 0 ? '' : items.slice(0, view.hidden).map(itemFindText).join('\n')),
    [items, view.hidden]
  )
  const pending = useFindPending(`subagent:${toolUseId}`, hiddenText, view.hidden === 0, () =>
    useBlockUi.getState().expand(toolUseId)
  )

  if (items.length === 0 && running === undefined) return null
  const state = subagentState(running, finished?.status ?? null, waiting)
  const className = ['subagent-block', state === null ? null : `subagent-state-${state}`, flash ? 'flash' : null]
    .filter((name) => name !== null)
    .join(' ')
  return (
    <div id={subagentAnchorId(toolUseId)} className={className} {...{ [FIND_ROOT_ATTR]: '' }}>
      {state === null ? null : finished !== undefined ? (
        <FinishedLine state={state} finished={finished} model={model} threadId={threadId} toolUseId={toolUseId} />
      ) : running === undefined ? null : (
        <RunningLine subtask={running} state={state} model={running.model ?? model} threadId={threadId} toolUseId={toolUseId} />
      )}
      {view.hidden > 0 ? (
        <button
          type="button"
          className="subagent-more"
          onClick={() => toggle(toolUseId)}
          aria-expanded={false}
          {...pending}
        >
          {t('subagent.more', { count: view.hidden })}
        </button>
      ) : null}
      {view.items.map((item) => (
        <div key={item.id} id={`ev-${item.id}`} className="subagent-step">
          {renderItem(item)}
        </div>
      ))}
      {expanded && view.collapsible ? (
        <button
          type="button"
          className="subagent-more"
          onClick={() => toggle(toolUseId)}
          aria-expanded={true}
        >
          {t('subagent.collapse', { count: view.total })}
        </button>
      ) : null}
    </div>
  )
}

/** The state mark (item 321). A spinner while running, a text mark otherwise. Shared with the list's buttons. */
export function SubagentStateMark({ state }: { state: SubagentState }): React.JSX.Element {
  const mark = subagentStateMark(state)
  return (
    <span className={`subtask-mark subagent-mark-${state}`} aria-hidden="true">
      {mark === null ? <Spinner className="in-row" /> : mark}
    </span>
  )
}

/** One line of a finished child (item 321). State, model (TODO 403), duration, tokens, tool count (the usage of the end notification). */
function FinishedLine({
  state,
  finished,
  model,
  threadId,
  toolUseId
}: {
  state: SubagentState
  finished: SubtaskFinishedPayload
  model: string | null
  threadId: string
  toolUseId: string
}): React.JSX.Element {
  const t = useT()
  const parts: string[] = []
  if (model !== null) parts.push(model)
  if (finished.usage !== null) {
    parts.push(formatElapsed(finished.usage.durationMs))
    parts.push(t('subtasks.tokens', { tokens: formatTokens(finished.usage.totalTokens) }))
    parts.push(t('subagent.toolUses', { count: finished.usage.toolUses }))
  }
  return (
    <div className={`subagent-running subagent-line-${state}`}>
      <SubagentStateMark state={state} />
      <span className="subagent-activity">{t(`subtasks.status.${finished.status}`)}</span>
      {parts.length === 0 ? null : <span className="subagent-stats">{parts.join(' · ')}</span>}
      <SubtaskWorktreeMark threadId={threadId} toolUseId={toolUseId} />
    </div>
  )
}

/** One line of a running child. Current activity (the last tool if none), model (TODO 403), elapsed time, tokens, tool count. */
function RunningLine({
  subtask,
  state,
  model,
  threadId,
  toolUseId
}: {
  subtask: RunningSubtask
  state: SubagentState
  model: string | null
  threadId: string
  toolUseId: string
}): React.JSX.Element {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const activity =
    subtask.activity ??
    (subtask.lastToolName === null ? null : t('subtasks.lastTool', { tool: subtask.lastToolName }))
  const parts = [formatElapsed(subtaskElapsedMs(subtask, now))]
  if (model !== null) parts.unshift(model)
  if (subtask.usage !== null) {
    parts.push(t('subtasks.tokens', { tokens: formatTokens(subtask.usage.totalTokens) }))
    parts.push(t('subagent.toolUses', { count: subtask.usage.toolUses }))
  }
  // Awaiting approval is stated before the activity (the same thing as the pause mark, also in words).
  const label =
    state === 'waiting'
      ? activity === null
        ? t('subagent.state.waiting')
        : `${t('subagent.state.waiting')} · ${activity}`
      : (activity ?? t(`subtasks.status.${subtask.status}`))
  return (
    <div className={`subagent-running subtask-${subtask.status} subagent-line-${state}`} role="status">
      <SubagentStateMark state={state} />
      <span className="subagent-activity" title={label}>
        {label}
      </span>
      <span className="subagent-stats">{parts.join(' · ')}</span>
      <SubtaskWorktreeMark threadId={threadId} toolUseId={toolUseId} />
    </div>
  )
}
