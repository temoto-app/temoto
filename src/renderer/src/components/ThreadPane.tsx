/**
 * ThreadPane (ARCHITECTURE.md 5.1).
 *
 * - The Markdown renderer **shares** `markdown/render.ts`. We do not build two paths (5.1 / 7.4).
 * - **While receiving, an unfinished code block is closed before drawing** (`closeOpenFences`).
 *   Measured: 43% of render frames had an unclosed block (spike 8).
 * - Tool calls are a dedicated collapsible block, not Markdown.
 * - Sub-agent messages are drawn nested under the parent's tool call.
 * - Clicking a file-path link opens it in ViewerPane (store.select).
 *   `http:` / `https:` / `mailto:` go to the external browser via main (5.1 "External links").
 * - This thread's pending approvals (question, plan, permission request) are shown in the Composer's place and
 *   replace the input field (`ApprovalOrComposer`, items 166 / 182, 5.4). Resolved ones stay as notes in the timeline.
 * - The copy button of a code block is **not in the body HTML**; it is overlaid on `.code-block` with a
 *   portal (5.1.2 / T17).
 */
import { TriggerIcon } from '../icons/TriggerIcon.js'
import { openExternalLink } from '../markdown-link.js'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AiosEvent, ApprovalOutcome, JsonValue, ThinkingLevel } from '@shared/agent.js'
import { settingsNoteShowsThinking, thinkingLabel } from '../composer-choice.js'
import { closeOpenFences, decodeCodeBlock, renderMarkdown } from '@shared/markdown/render.js'
import { openLinkHref } from '../markdown-link.js'
import { deferLocalImages, resolveLocalImages } from '../markdown-images.js'
import { useThreads } from '../threadStore.js'
import { rainbowStyle } from '../rainbow.js'
import {
  foldTimeline,
  formatBytes,
  formatHeld,
  planVerdictOfOutcome,
  type PlanRow,
  type TimelineItem
} from '../thread/timeline.js'
import { buildProgressTurns } from '../thread/progress.js'
import { formatTurnDuration, lastTurnCache } from '../thread/turn-end.js'
import { shouldScrollToHighlight } from '../thread/highlight-scroll.js'
import { finishScrollPlan, finishScrollTop, STICKY_RESERVE_PX } from '../thread/finish-scroll.js'
import { isAtBottom } from '../thread/jump.js'
import { TurnEndAge } from './TurnEndAge.js'
import { ResumeBar } from './ResumeBar.js'
import { AuthExpiredBar } from './AuthExpiredBar.js'
import { PromptCacheBar } from './PromptCacheBar.js'
import { showsResume } from '../thread/resume.js'
import { CopyButton } from './CopyButton.js'
import { MermaidView } from './MermaidView.js'
import { isMermaidCodeBlock, mermaidSourceOf, shouldDrawDiagrams } from '../thread/mermaid-blocks.js'
import { ToolInput, ToolHoverBody } from './ToolInput.js'
import { Tooltip } from './Tooltip.js'
import { displayToolSummary, toolHover } from '../thread/tool-input.js'
import { redactText } from '@shared/redact.js'
import { NewChatButton } from './NewChatButton.js'
import { SubtaskFinishedNote, SubtaskList } from './SubtaskList.js'
import { SubagentBlock } from './SubagentBlock.js'
import { TodoList } from './TodoList.js'
import { ConversationBoundary } from './ConversationBoundary.js'
import { ThreadSettingsMenu } from './ThreadSettingsMenu.js'
import { ThreadHeaderActions } from './ThreadHeaderActions.js'
import { ThreadCapabilityNote } from './ThreadCapabilityNote.js'
import { McpBadge } from './McpBadge.js'
import { useRedmine } from '../redmineStore.js'
import { ShellRunBlock } from './ShellRunBlock.js'
import { PlanBlock } from './PlanBlock.js'
import { ApprovalOrComposer } from './ApprovalPrompt.js'
import { DrillPanel } from './DrillPanel.js'
import { FolderNotice, threadFolderNoticeVisible } from './FolderNotice.js'

/** How long until the highlight of an in-conversation search jump is cleared (6.1). Once cleared, auto-scroll and the move of 464 work again. */
const HIGHLIGHT_CLEAR_MS = 4000
import { JumpNav, useJumpNav } from './JumpNav.js'
import { ScrollBottomButton } from './ScrollBottomButton.js'
import { UserMessage } from './UserMessage.js'
import { StickyQuestion } from './StickyQuestion.js'
import { ProgressBlock } from './ProgressBlock.js'
import { SkillBadges } from './SkillBadges.js'
import { skillBadgesByTurn } from '../thread/skills.js'
import { ForkBanner, RewindMenu } from './RewindMenu.js'
import { ExportTurnButton } from './ExportTurnButton.js'
import { TranscriptBanner } from './TranscriptBanner.js'
import { ToolElapsed, useToolProgress } from './ToolElapsed.js'
import { describeReason, useT } from '../i18n/index.js'
import { threadTitleLabel } from '../thread/title.js'
import { usePaneDrop } from '../pane-drop.js'
import { ThreadFind } from './ThreadFind.js'
import { SearchIcon } from '../icons/SearchIcon.js'
import { activeFindTerms, openThreadFind, useFindPending, useThreadFind } from '../threadFindStore.js'
import { threadFindKeyLabel } from '../shortcuts.js'
import { keyPlatformOf } from '../composer-keys.js'
import { toolFindText } from '../thread/find-hidden.js'
import { ContextMenu, useContextMenuState } from './ContextMenu.js'
import { threadSelectionMenuItems } from '../path-context-menu.js'
import { writeClipboard } from './PathActions.js'
import { searchSelection } from '../shortcut-actions.js'
import { currentKeybindings, searchKeyLabel } from '../shortcuts.js'
import { PRODUCT_NAME } from '@shared/product.js'

/**
 * Make the empty default a **module constant**. Writing `?? []` inside a selector returns a new array every
 * time, so zustand's useSyncExternalStore decides it "keeps being updated" and re-renders forever (React error #185).
 */
const NO_EVENTS: readonly AiosEvent[] = []

/** For the same reason (`NO_EVENTS` above), the empty array of code blocks is also a module constant. */
const NO_BLOCKS: readonly HTMLElement[] = []

const PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

export function ThreadPane(): React.JSX.Element {
  const t = useT()
  // TODO 1030: right-click on a selection in the body (copy + 3 searches).
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()
  const threadId = useThreads((state) => state.activeThreadId)
  // Dropping anywhere on the pane attaches (items 253 / 258). Only a drop onto the textarea is taken by the Composer, which inserts the path.
  const paneDrop = usePaneDrop(threadId)
  const events = useThreads((state) =>
    threadId === null ? NO_EVENTS : (state.events[threadId] ?? NO_EVENTS)
  )
  // Select per row, and only the values used (item 75). `thread` stays the same object while its contents are the
  // same (thread-index.ts), so the timeline is not redrawn on every `turn_usage`.
  const thread = useThreads((state) =>
    threadId === null ? undefined : state.threadsById[threadId]?.thread
  )
  const runtimeState = useThreads((state) =>
    threadId === null ? undefined : state.threadsById[threadId]?.runtime.state
  )
  const notPersisted = useThreads((state) =>
    threadId === null ? false : state.notPersisted.has(threadId)
  )
  const highlightEventId = useThreads((state) => state.highlightEventId)
  // TODO 943: provisional row for a message just sent (until main's `user_text` arrives).
  const optimisticSend = useThreads((state) =>
    threadId === null ? undefined : state.pendingSends[threadId]
  )
  // "Load more" (item 88). The button is shown at the top only when something remains.
  const older = useThreads((state) => (threadId === null ? undefined : state.older[threadId]))
  const loadOlder = useThreads((state) => state.loadOlder)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // TODO 1137: .thread-body is not drawn until threadId is decided. Also kept in state so the ResizeObserver effect can re-attach when the element appears.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)
  const setBodyRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    setBodyEl(el)
  }, [])
  /**
   * Distance from the bottom edge before prepending the previous page. After prepending we return to the same
   * distance so the row being looked at does not move (scrollTop advances by the amount added above). Used only
   * when the first row changes.
   */
  const olderAnchor = useRef<number | null>(null)
  const [pinned, setPinnedState] = useState(true)
  /**
   * The latest value of `pinned` (TODO 464). The value set by the end-landing (layout effect) is also kept in a ref
   * so that the auto-scroll effect of the same render (whose state is still old) can read it.
   */
  const pinnedRef = useRef(true)
  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next
    setPinnedState(next)
  }, [])
  // TODO 464: marker that a turn of the displayed thread has ended. The value at mount time counts as "done" (reopening does not move anything).
  const turnEnded = useThreads((state) => state.turnEnded)
  const handledEnd = useRef<number>(turnEnded?.seq ?? 0)

  // A parent tool call with no result while there is no process (`idle` / `error` / `stopping`) is "interrupted" (item 280-5).
  // After a restart (only the transcript remains, the process is `idle`) it looks the same.
  const live = runtimeState === 'starting' || runtimeState === 'running' || runtimeState === 'awaiting-approval'
  // The attachment mark of the user's own message (the Japanese "attachment: name" in parentheses) is added by main regardless of language, so convert it to the display language when drawing (TODO 519).
  const attachmentLabel = useCallback((name: string) => t('timeline.user.attachmentMark', { name }), [t])
  const folded = useMemo(
    () => foldTimeline(events, { live, attachmentLabel }),
    [events, live, attachmentLabel]
  )
  // Progress reports (5.1.3). Built per turn; only the last turn is shown at the very bottom.
  const progressTurns = useMemo(() => buildProgressTurns(events, t), [events, t])
  const lastTurn = progressTurns.length === 0 ? null : progressTurns[progressTurns.length - 1]!
  /**
   * Wave 13 bundle F: "show at the very bottom" is correct only when nothing follows the last turn.
   * `!` (item 116) does not start a turn, so it is not a boundary of `buildProgressTurns`; right after continuing a
   * transcript, for example, the afterId of the "last turn" can point before the real end of the timeline
   * (= the last element of `folded.items`). As is, ProgressBlock would be drawn unconditionally at the end, below
   * a later `!` frame (reverse of chronological order; the observation of item 138). When afterId does not match the
   * last item, it is drawn right after that item through the same path as other past turns (`pastTurns`).
   */
  // TODO 1100: badge of the skills used (at the head of the first line of the turn's answer).
  const skillTurns = useMemo(() => skillBadgesByTurn(folded.items), [folded.items])
  const trailingItemId = folded.items.length === 0 ? null : folded.items[folded.items.length - 1]!.id
  const itemIds = useMemo(() => new Set(folded.items.map((item) => item.id)), [folded.items])
  const lastTurnInline = lastTurn !== null && lastTurn.afterId !== trailingItemId && itemIds.has(lastTurn.afterId)
  const pastTurns = useMemo(() => {
    const entries = progressTurns.slice(0, -1)
    return new Map((lastTurnInline && lastTurn !== null ? [...entries, lastTurn] : entries).map((turn) => [turn.afterId, turn]))
  }, [progressTurns, lastTurnInline, lastTurn])
  // TODO 466: cache lifetime of the last turn (including hand-over). While the next turn is running, no estimate is shown
  // (that turn is reading and writing the cache again).
  const lastCacheAll = useMemo(() => lastTurnCache(folded.items), [folded.items])
  const lastCache = live ? null : lastCacheAll
  // Jumping between "my questions" (5.1.4, TODO 53). The body grows during a response, so re-measure along with `folded`.
  const jump = useJumpNav(scrollRef, folded.items, folded, setPinned, bodyEl)

  // Right after prepending a previous page, correct the scroll position before painting (item 88).
  // Use it once, in the render where loading finished (the pass where `loading` went down), then discard it. If
  // everything added was a duplicate and the first row did not change, or on failure, discard it here too (same
  // height means same position). For events arriving at the end, `anchor` is null, so nothing happens.
  const firstId = folded.items[0]?.id ?? null
  const olderLoading = older?.loading ?? false
  const olderBefore = older?.before ?? null
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = olderAnchor.current
    if (el === null || anchor === null || olderLoading) return
    olderAnchor.current = null
    el.scrollTop = el.scrollHeight - anchor
  }, [firstId, olderLoading, olderBefore])

  const readOlder = (): void => {
    if (threadId === null) return
    const el = scrollRef.current
    if (el !== null) olderAnchor.current = el.scrollHeight - el.scrollTop
    void loadOlder(threadId)
  }

  // Only at the moment an answer finishes, move to the head of the last answer even if the user is reading above (TODO 464, 5.1.5).
  // The decision is in `thread/finish-scroll.ts`. Move before paint (layout effect) and lower `pinnedRef` before the
  // auto-scroll below (so that the same render does not pull back to the bottom).
  useLayoutEffect(() => {
    if (turnEnded === null || turnEnded.seq === handledEnd.current) return
    handledEnd.current = turnEnded.seq
    if (turnEnded.threadId !== threadId) return
    // Right after jumping from an in-conversation search, the position of that message takes priority.
    if (highlightEventId !== null) return
    // While a term is being typed in the in-thread search (TODO 496), the position of the match the search box moved to takes priority.
    if (activeFindTerms(useThreadFind.getState()).length > 0) return
    const box = scrollRef.current
    // Do not move while ThreadPane is hidden (`display: none`) by the settings editor, the scheduled-run editor, etc.
    if (box === null || box.clientHeight === 0 || box.getClientRects().length === 0) return
    const plan = finishScrollPlan(folded.items, turnEnded.eventId)
    if (plan === null) return
    let top = box.scrollHeight
    if (plan.kind === 'answer') {
      const head = document.getElementById(`ev-${plan.headId}`)
      if (head !== null) {
        const headTop = head.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
        const sticky = box.parentElement?.querySelector<HTMLElement>('.sticky-question') ?? null
        const reserve = sticky === null ? STICKY_RESERVE_PX : Math.max(sticky.offsetHeight, STICKY_RESERVE_PX)
        top = finishScrollTop(headTop, box, reserve)
      }
    }
    box.scrollTop = top
    // After moving to the head we are not at the bottom, so following the next turn waits until the user returns to the bottom.
    setPinned(isAtBottom(box))
    jump.sync()
  }, [turnEnded, threadId, folded.items, highlightEventId, setPinned, jump])

  // TODO 823: after sending a prompt (of any kind), move to the very bottom and restore the sticking.
  // TODO 906: while the question frame is shown, the timeline is collapsed to height 0 (`.thread-pane:has(.question-prompt)
  // .thread-body`), so a marker set during that time (an answer to a question) has nowhere to move. Keep it pending
  // instead of discarding it, and move when the height returns (ResizeObserver).
  const sendScroll = useThreads((state) => state.sendScroll)
  const handledSend = useRef<number>(sendScroll?.seq ?? 0)
  const pendingSend = useRef(false)
  // `jump` is a new object on every render, so putting it in the dependencies would re-attach the ResizeObserver every render (hot while streaming).
  // Read the latest `sync` through a ref and keep the identity of `scrollToSentBottom`.
  const jumpSyncRef = useRef(jump.sync)
  jumpSyncRef.current = jump.sync
  const scrollToSentBottom = useCallback((): boolean => {
    const box = scrollRef.current
    if (box === null || box.clientHeight === 0) return false
    box.scrollTop = box.scrollHeight
    setPinned(true)
    jumpSyncRef.current()
    return true
  }, [setPinned])
  useLayoutEffect(() => {
    if (sendScroll === null || sendScroll.seq === handledSend.current) return
    handledSend.current = sendScroll.seq
    if (sendScroll.threadId !== threadId) return
    pendingSend.current = !scrollToSentBottom()
  }, [sendScroll, threadId, scrollToSentBottom])
  useEffect(() => {
    pendingSend.current = false
  }, [threadId])
  useEffect(() => {
    const box = bodyEl
    if (box === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pendingSend.current && scrollToSentBottom()) pendingSend.current = false
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [scrollToSentBottom, bodyEl])

  // TODO 940: when the thread is switched, reset the position state (do not carry over the detached following or the "load more" anchor of the previous thread).
  // Set it to follow the end and go to the end through the auto-scroll below (remembering position per thread is a separate matter).
  const lastThreadId = useRef(threadId)
  useLayoutEffect(() => {
    if (lastThreadId.current === threadId) return
    lastThreadId.current = threadId
    olderAnchor.current = null
    setPinned(true)
  }, [threadId, setPinned])

  // Auto-scroll only while stuck to the end.
  useEffect(() => {
    if (!pinned || !pinnedRef.current) return
    if (highlightEventId !== null) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [folded.items.length, folded.streaming, pinned, highlightEventId, threadId, optimisticSend])

  // When we jumped here from an in-conversation search, scroll to that message (6.1).
  // The highlight is cleared after a few seconds (the promise of `jumpToEvent`). Otherwise auto-scroll and the "moment
  // it ended" move of 464 stay stopped for the whole session (found in the wave 23 code-review).
  // TODO 940: once found and scrolled, do not move again (do not pull back with flowing items).
  // Only while the item is not yet in the DOM (waiting for a page to load, 498), search again each time items increase.
  const highlightScrolled = useRef<string | null>(null)
  useEffect(() => {
    if (highlightEventId === null) {
      highlightScrolled.current = null
      return
    }
    if (!shouldScrollToHighlight(highlightScrolled.current, highlightEventId)) return
    const target = document.getElementById(`ev-${highlightEventId}`)
    if (target === null) return
    target.scrollIntoView({ block: 'center' })
    highlightScrolled.current = highlightEventId
  }, [highlightEventId, folded.items.length])
  // The timer that clears the highlight runs only once per highlight (it is not re-set every time items increase).
  useEffect(() => {
    if (highlightEventId === null) return
    const timer = window.setTimeout(() => {
      if (useThreads.getState().highlightEventId === highlightEventId) {
        useThreads.setState({ highlightEventId: null })
      }
    }, HIGHLIGHT_CLEAR_MS)
    return () => window.clearTimeout(timer)
  }, [highlightEventId])

  if (threadId === null || thread === undefined || runtimeState === undefined) {
    return (
      <div className="thread-pane empty">
        <p>{t('thread.empty')}</p>
      </div>
    )
  }

  const state = runtimeState

  return (
    <div className={paneDrop.dragging ? 'thread-pane pane-dropping' : 'thread-pane'} {...paneDrop.handlers}>
      {paneDrop.dragging ? (
        // TODO 913: one overlay, the whole pane is an attachment (the left/right split of 563 is abolished).
        <div className="pane-drop-overlay" aria-hidden="true">
          <span>{t('drop.attachHint')}</span>
        </div>
      ) : null}
      {/* The working directory's rainbow (TODO 50 / 108) is only a 2px underline. The background is not painted (to protect
          the state colors inside). Unassigned (scratch area, TODO 58) or no cwd gives `thread.rainbow === null`
          (already decided by main's `RainbowRegistry`). */}
      <div className="thread-header" style={rainbowStyle(thread.rainbow)}>
        {/* Display name of the cwd (T18). Shown at the head of the title as "hoge ·". It holds no path. */}
        {thread.cwdName !== '' ? (
          <>
            <span className="thread-cwd">{thread.cwdName} ·</span>
            {/* Create a new thread in this cwd right away (item 255). "Open in editor" moved to the settings menu.
                **Make it a sibling outside `.thread-cwd` (overflow: hidden, max-width)** (item 280-2). Inside it, a long
                cwd name cut the button off with the frame, and a long title shrank and cut off the right side. */}
            <NewChatButton
              uri={thread.cwdUri}
              className="thread-new-chat"
              label={t('threads.newInFolder', { name: thread.cwdName })}
            />
          </>
        ) : null}
        <span className="thread-title">{threadTitleLabel(t, thread.title)}</span>
        {/* TODO 1216: a conversation started by a trigger can open its original event (mail, PR) from the heading (https only; main re-checks). */}
        {thread.triggerOrigin?.url === undefined ? null : (
          <Tooltip content={t('trigger.openSource')}>
            <button
              type="button"
              className="icon-button thread-trigger-source"
              aria-label={t('trigger.openSource')}
              onClick={(event) =>
                openExternalLink(thread.triggerOrigin?.url ?? '', { metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey })
              }
            >
              <TriggerIcon size={16} />
            </button>
          </Tooltip>
        )}
        {/* The state badge ("idle" etc.) and the instruction-file badge were removed in item 190. State is visible from the
            sidebar spinner, the stop square in the prompt field, and the progress and error rows of the timeline. */}
        {thread.approvalStrict ? (
          <span className="thread-strict" title={t('thread.strictHint')}>
            {t('thread.strict')}
          </span>
        ) : null}
        <McpBadge threadId={threadId} />
        {/* TODO 865: "Open viewer", "Open folder in editor" and "Export conversation", which were inside the ... menu, are now icons to the left of the magnifier. */}
        <ThreadHeaderActions threadId={threadId} />
        {/* In-thread search (TODO 496). Only an icon in the heading (no permanent input field). Pressing it or Cmd+F opens the search box at the top right. */}
        <Tooltip content={`${t('threadFind.open')} (${threadFindKeyLabel(PLATFORM)})`}>
          <button
            type="button"
            className="icon-button thread-find-open"
            onClick={() => openThreadFind()}
            aria-label={t('threadFind.open')}
          >
            <SearchIcon />
          </button>
        </Tooltip>
        {/* Per-thread settings (item 187). One at the right end of the heading. */}
        <ThreadSettingsMenu threadId={threadId} />
        {/* The "Stop" button in the heading was removed in item 161. The only way to stop is the stop square in the prompt field (and Esc). */}
        {/* The money ($) display was removed in item 165 (the record stays in runtime.costUsd; the CLI itself shows it with /cost).
            Right alignment: `.thread-title`'s `flex: 1 1 auto` (item 138) already absorbs all free width and pushes the
            following badges to the container's right end, so there was no need to re-add margin-left: auto to other
            elements (the same rule on the cost element was already disabled). */}
      </div>

      <ThreadCapabilityNote threadId={threadId} />
      {notPersisted ? (
        <div className="thread-banner">{t('thread.notPersisted')}</div>
      ) : null}
      {/* Thread branched by a rewind (item 113). The past is not copied; only a band that jumps to the original message. */}
      {thread.forkedFrom !== null ? <ForkBanner origin={thread.forkedFrom} backend={thread.backend} /> : null}
      {/* Thread continued from a terminal / VS Code conversation (item 111). The past part is read from the transcript and shown at the head. */}
      {thread.transcriptOrigin !== null ? <TranscriptBanner origin={thread.transcriptOrigin} /> : null}

      {/* Floating search box of the in-thread search (TODO 496, 5.1.7). A sibling of height 0, overlaid on the top right of the body. The pinned question
          (355) is the sibling just before the body, so this goes before it (both are absolute, so the order does not affect appearance). */}
      <ThreadFind threadId={threadId} bodyRef={scrollRef} />

      {/* Overlay the original question of the answer being read at the top (TODO 355, 5.1.4). A sibling of height 0; not mixed into .thread-body. */}
      <StickyQuestion handle={jump} items={folded.items} />

      <div
        className="thread-body"
        ref={setBodyRef}
        onContextMenu={(event) => {
          // TODO 1030: show our own menu only when the selection is inside the body. Otherwise keep the default behavior.
          const selection = window.getSelection()
          const text = selection === null || selection.isCollapsed ? '' : selection.toString()
          const anchor = selection?.anchorNode ?? null
          if (text === '' || anchor === null || !event.currentTarget.contains(anchor)) return
          const items = threadSelectionMenuItems(
            text,
            t,
            (copied) => void writeClipboard(copied),
            (target, query) => searchSelection(query, target),
            (target) => searchKeyLabel(target, currentKeybindings().platform)
          )
          if (items.length > 0) openMenu(event, items)
        }}
        onScroll={(event) => {
          const el = event.currentTarget
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
          jump.sync()
        }}
      >
        {older !== undefined && older.remaining > 0 ? (
          // Button at the top (owner decision of item 88). No automatic loading on reaching the top
          // (it could interfere with jumps / `pinned`).
          <div className="timeline-older">
            <button type="button" onClick={readOlder} disabled={older.loading}>
              {older.loading ? t('common.loading') : t('thread.loadOlder', { count: older.remaining })}
            </button>
          </div>
        ) : null}
        {folded.items.map((item) => (
          <div
            key={item.id}
            id={`ev-${item.id}`}
            className={
              item.id === highlightEventId || item.id === jump.flashId
                ? 'timeline-item highlighted'
                : 'timeline-item'
            }
          >
            {skillTurns.has(item.id) ? (
              <SkillBadges badges={skillTurns.get(item.id)!} cwdUri={thread?.cwdUri || null} />
            ) : null}
            <Item
              item={item}
              depth={0}
              threadId={threadId}
              {...(lastCache !== null && item.id === lastCache.resultId ? { cacheTtlMs: lastCache.ttlMs } : {})}
            />
            {pastTurns.has(item.id) ? (
              <ProgressBlock turn={pastTurns.get(item.id)!} active={false} />
            ) : null}
          </div>
        ))}
        {folded.thinking !== '' ? <Thinking text={folded.thinking} /> : null}
        {folded.streaming !== '' ? <Streaming text={folded.streaming} /> : null}
        {lastTurn === null || lastTurnInline ? null : (
          <ProgressBlock turn={lastTurn} active={ACTIVE_STATES.has(state)} />
        )}
        {/* TODO 943: provisional message. Drawn with the same frame and component as the real one (`Item`'s 'user') so the replacement does not change height
            (the hover buttons are absolutely positioned and have no height, so they are not attached to the provisional row). */}
        {optimisticSend === undefined ? null : (
          <div className="timeline-item" data-pending-send="true">
            <UserMessage text={optimisticSend.text} />
          </div>
        )}
        {/* TODO 521: if an answer stopped midway, a resume button at the end (below the last row of the stopped turn). */}
        {thread.interrupted !== undefined && showsResume(thread.interrupted, state) ? (
          // TODO 893: an expired authentication is replaced by a guide and a "send again" row.
          thread.interrupted === 'interrupt-auth' ? (
            <AuthExpiredBar threadId={threadId} />
          ) : (
            <ResumeBar threadId={threadId} reason={thread.interrupted} />
          )
        ) : null}
        <div ref={bottomRef} />
      </div>

      {/* Box for jumping between "my questions" (5.1.4, TODO 53). A sibling of height 0; not mixed into .thread-body. */}
      <JumpNav handle={jump} />
      {/* "Down to the bottom" (TODO 552). Only while away from the bottom edge: center of the column, just above the Composer. */}
      <ScrollBottomButton visible={!pinned} onJump={jump.jumpLast} />

      {/* Sub-agents running in the background (presentation of item 93, 4.6.3). Just above the Composer's place. */}
      <TodoList threadId={threadId} />
      <SubtaskList threadId={threadId} />
      {/* TODO 963 / 961: if the prompt cache has expired, a band just above the Composer. */}
      <PromptCacheBar threadId={threadId} cache={lastCache} items={folded.items} />
      {/* TODO 1118: only for a conversation opened from an aios:// link in a first-time folder (the `cwdHistoryDeferred` marker, removed by main on the first send),
          tell what will run without confirmation. The content decision is main's (`folderNotice`). Conversations created by the create dialog or Drop
          have no marker, so it is not shown even after the user removes that folder from the recent list (review fix). */}
      {thread !== undefined && threadFolderNoticeVisible(thread, optimisticSend !== undefined) ? (
        <FolderNotice cwdUri={thread.cwdUri} placement="thread" />
      ) : null}
      {/* TODO 982: a drill conversation - what a drill does, then the list of what it stopped (and "allow from now on", 1292 item 2). */}
      {thread.drill === undefined ? null : <DrillPanel threadId={threadId} state={thread.drill} running={live} />}
      {/* If there is a pending approval (question, plan, permission request), hide the Composer and show the oldest one
          (items 166 / 182. Same as the CLI / VS Code). The former approval frame (ApprovalInbox, 5.4) is gone.
          TODO 982: after a drill's one run the Composer goes away (main refuses any further send; a question can still be answered). */}
      <ApprovalOrComposer threadId={threadId} composerHidden={thread.drill === 'ran' && !live} />
      <ContextMenu point={menuPoint} items={menuItems} onClose={closeMenu} />
    </div>
  )
}

/**
 * The "· thinking ..." of the switch row (T7). Not shown if the thread's backend has no thinking levels (TODO 1018,
 * the addendum of the real-machine check of 1017). While the backend list has not arrived or it is not in the registry, shown as before.
 */
function SettingsThinking({
  threadId,
  thinking
}: {
  threadId: string | null
  thinking: ThinkingLevel | null
}): React.JSX.Element | null {
  const t = useT()
  const shown = useThreads((state) => {
    const backend = threadId === null ? undefined : state.threadsById[threadId]?.thread.backend
    return settingsNoteShowsThinking(state.backends, backend)
  })
  if (!shown) return null
  return (
    <>
      {' · '}
      {t('timeline.settings.thinking', {
        thinking: thinking === null ? t('timeline.settings.default') : thinkingLabel(thinking, false, t)
      })}
    </>
  )
}

/** The condition for showing the waiting display = **whether a turn is in progress** (not whether body text has arrived; TODO 14). */
const ACTIVE_STATES: ReadonlySet<string> = new Set(['starting', 'running', 'awaiting-approval'])

function Item({
  item,
  depth,
  cacheTtlMs,
  threadId
}: {
  item: TimelineItem
  depth: number
  /** The thread of this timeline (used to look up the child worktree marker). */
  threadId: string | null
  /** Only for the last turn's end row: lifetime of the prompt cache (including hand-over, TODO 466). */
  cacheTtlMs?: number
}): React.JSX.Element | null {
  const t = useT()
  switch (item.kind) {
    case 'user':
      // "Rewind to here" (item 113) is attached only to the user's message rows.
      // The user's own message is drawn as typed, without passing through Markdown (TODO 352, `UserMessage`).
      return (
        <>
          <UserMessage text={item.text} attachments={item.attachments} />
          {/* TODO 818: export this one question and answer to PDF (visible on hover). */}
          {threadId === null ? null : <ExportTurnButton threadId={threadId} eventId={item.id} />}
          <RewindMenu eventId={item.id} />
        </>
      )
    case 'assistant':
      return <Message role={item.actor === 'subagent' ? 'subagent' : 'assistant'} text={item.text} />
    case 'tool':
      return <ToolBlock item={item} depth={depth} />
    case 'plan':
      return <PlanTransition row={item} />
    case 'approval':
      // Plan approval (item 275): once settled, it becomes the CLI's `User approved the plan` / `Stayed in plan mode` row.
      if (item.planLines !== undefined && item.outcome.kind !== 'pending') {
        return <PlanTransition row={{ kind: 'plan', id: item.id, ts: item.ts, toolUseId: item.requestId, verdict: planVerdictOfOutcome(item.outcome, true) }} />
      }
      return (
        <div className="timeline-note approval">
          <strong>{t('timeline.approval')}</strong>{' '}
          {item.planLines === undefined
            ? `${item.toolName} ${item.summary}`
            : `${t('timeline.plan.label')} (${t(
                item.planLines === 1 ? 'timeline.plan.lines.one' : 'timeline.plan.lines.other',
                { count: item.planLines }
              )})`}
          <OutcomeLabel outcome={item.outcome} requestedAt={item.requestedAt} />
        </div>
      )
    case 'result':
      return (
        // A turn stopped by an interrupt (item 94) is "interrupted", not an error. The decision is the marker the Adapter attached.
        <div className={`timeline-note result${item.result.interrupted === true ? ' interrupted' : ''}`}>
          {item.result.interrupted === true
            ? t('timeline.result.interrupted')
            : item.result.ok
              ? t('timeline.result.ok')
              : t('timeline.result.error')}{' '}
          ·{' '}
          {/* TODO 466: total time made readable + when it ended (only TurnEndAge redraws with the clock). */}
          {formatTurnDuration(item.result.durationMs, t)}
          <TurnEndAge endedAt={item.ts} {...(cacheTtlMs === undefined ? {} : { cacheTtlMs })} />
          {item.result.denials.length > 0
            ? ` · ${t('timeline.result.denials', { count: item.result.denials.length })}`
            : ''}
        </div>
      )
    case 'error':
      return (
        <div className="timeline-note error">
          {/* Text originating from main arrives as a reason code (TODO 519). Text that is not a code, such as stderr, is shown as is. */}
          <strong>{t('timeline.error')}</strong> ({item.origin}) {describeReason(t, item.message)}
        </div>
      )
    case 'session':
      return (
        <div className="timeline-note session">
          {item.resumed ? t('timeline.session.resumed') : t('timeline.session.started')}
          {item.model === null ? '' : ` (${item.model})`}
        </div>
      )
    case 'settings':
      // model / thinking switch (T7 / 4.5.1). The same row appears in past timelines.
      return (
        <div className="timeline-note settings">
          {item.scope === 'thread'
            ? t('timeline.settings.thread')
            : t('timeline.settings.message')}
          :{' '}
          {t('timeline.settings.model', {
            model: item.modelId === null ? t('timeline.settings.default') : item.modelId
          })}
          {/* TODO 1018 (addendum of 1017): do not write thinking for a backend with no thinking levels. */}
          <SettingsThinking threadId={threadId} thinking={item.thinking} />
          {/* Item 95: whether it switched while running or restarted. Rows from before, or rows where there was no process, are not shown. */}
          {item.via === 'live' || item.via === 'restart' ? ` · ${t(`timeline.settings.via.${item.via}`)}` : null}
        </div>
      )
    case 'rate_limit':
      // Item 317: only show hitting the limit and the switch to metered billing (the usage rate is the BottomBar's UsageBadge).
      return item.notice === null ? null : (
        <div className="timeline-note rate-limit">
          {item.notice === 'rejected' ? t('usage.timeline.rejected') : t('usage.timeline.overage')}
        </div>
      )
    case 'subtask':
      // A finished sub-agent (presentation of item 93, 4.6.3). While running, SubtaskList shows it.
      return <SubtaskFinishedNote item={item} threadId={threadId} />
    case 'boundary':
      // Conversation boundary (item 117).
      return <ConversationBoundary item={item} />
    case 'shell':
      // The `!` of the prompt field (item 116). Command and output in one frame.
      return <ShellRunBlock run={item.run} />
    case 'outside_write':
      // TODO 700: in a turn split off by a worktree, the main working copy was rewritten. No stopping, no asking - marker only.
      return (
        <div className="timeline-note outside-write" role="note">
          <span aria-hidden="true">⚠ </span>
          {t(`timeline.outsideWrite.${item.scope}`)} <code className="outside-write-path">{item.path}</code>
        </div>
      )
    case 'unknown':
      // Unknown events are kept, not discarded (4.6). The UI shows only that they exist.
      return <div className="timeline-note unknown">{t('timeline.unknown', { hint: item.hint })}</div>
    default:
      return null
  }
}

/**
 * Dispatch of links in the body (5.1 "External links"). Shared by confirmed messages and body text being received.
 *
 * - `file:`, relative, and no-scheme (`memory/x.md`, `src/a.ts:42`) -> resolved with main's `fs.resolveLink` in the
 *   order thread cwd -> auto memory and opened in ViewerPane. If unresolved, the reason goes to the band (item 254,
 *   `markdown-link.ts`). Never handed to the external browser.
 * - `http:` / `https:` -> the web view of ViewerPane (TODO 400). Shift / Cmd + click and `mailto:` ask main to
 *   "open externally". Even though the renderer dispatches, **main re-validates with the same pure function**
 *   (the renderer's value is not trusted).
 * - `thread://<threadId>/<eventId>` -> select that conversation and move to the message (TODO 1155, `openThreadLink`).
 * - Anything else (an in-page `#heading`) -> do nothing.
 *
 * `preventDefault()` in every case. Letting it through causes a normal page navigation, which main's `will-navigate`
 * just swallows, and to the user it looks like "nothing happens".
 */
function onMarkdownLinkClick(event: React.MouseEvent<HTMLElement>): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a')
  if (anchor === null) return
  event.preventDefault()
  // http(s) goes to ViewerPane, and shift / Cmd + click to the OS browser (TODO 400).
  const rect = anchor.getBoundingClientRect()
  openLinkHref(
    anchor.getAttribute('href'),
    null,
    { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
    undefined,
    // TODO 995: when unresolved, the balloon is at the lower left of the link (the small offset is in one place in LinkPopover).
    { x: rect.left, y: rect.bottom }
  )
}

/**
 * Markdown of the body. Shared by confirmed messages and messages being received.
 *
 * `render.ts` wraps each fence in `<div class="code-block" data-code="…">` (5.1.2), so after rendering we collect
 * those and **overlay copy buttons with a portal**. Two reasons not to embed the button in the body HTML: DOMPurify
 * drops `button` (it would vanish), and the copied content should come from the **uncolored plain text** of `data-code`.
 *
 * Whenever `html` changes, React swaps innerHTML and the `.code-block` DOM nodes are recreated, so re-collecting is
 * done in an effect that has `html` as a dependency. If the node list is the same, `setBlocks` is not called
 * (calling it would loop effect -> re-render -> effect without end).
 */
function MarkdownBody({
  html: rendered,
  streaming = false
}: {
  html: string
  /** No diagrams are drawn mid-stream (TODO 880). Draw after it closes. */
  streaming?: boolean
}): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  // TODO 876: for local images, stash src before rendering and, after rendering, apply the aios-res:// URL that main provides.
  const imageThreadId = useThreads((state) => state.activeThreadId)
  const html = useMemo(() => deferLocalImages(rendered, imageThreadId), [rendered, imageThreadId])
  useEffect(() => {
    const root = host.current
    if (root === null) return
    let alive = true
    resolveLocalImages(root, imageThreadId, () => alive)
    return () => {
      alive = false
    }
  }, [html, imageThreadId])
  const [blocks, setBlocks] = useState<readonly HTMLElement[]>(NO_BLOCKS)
  useEffect(() => {
    const root = host.current
    if (root === null) return
    const found = Array.from(root.querySelectorAll<HTMLElement>('.code-block'))
    setBlocks((prev) =>
      prev.length === found.length && prev.every((node, i) => node === found[i])
        ? prev
        : found.length === 0
          ? NO_BLOCKS
          : found
    )
  }, [html])
  return (
    <>
      <div
        className="markdown"
        ref={host}
        // renderMarkdown goes through markdown-it (html: false) + DOMPurify (5.1 / 7.4).
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={onMarkdownLinkClick}
      />
      {blocks.map((node, i) =>
        createPortal(<CopyButton code={decodeCodeBlock(node.dataset['code'])} />, node, `code-copy-${i}`)
      )}
      {shouldDrawDiagrams({ streaming })
        ? blocks.map((node, i) =>
            isMermaidCodeBlock(node)
              ? createPortal(<MermaidView code={mermaidSourceOf(node)} host={node} />, node, `code-diagram-${i}`)
              : null
          )
        : null}
    </>
  )
}

/** A model message (parent / sub-agent). The user's own message is `UserMessage` (TODO 352, not Markdown). */
function Message({
  role,
  text
}: {
  role: 'assistant' | 'subagent'
  text: string
}): React.JSX.Element {
  const redmineBase = useRedmine((state) => state.baseUrl)
  const html = useMemo(() => renderMarkdown(text, { linkPaths: true, redmineBase, math: true }).html, [text, redmineBase])
  return (
    <div className={`message ${role}`}>
      <MarkdownBody html={html} />
    </div>
  )
}

/**
 * Body being received. Close an unfinished code fence before drawing (5.1).
 * Syntax coloring stays on while receiving (measurement of 5.1.2: re-rendering per delta takes p90 1 ms for a
 * 240-line block). If it turns out heavy, use `renderMarkdown(…, { highlight: false })`.
 */
function Streaming({ text }: { text: string }): React.JSX.Element {
  const redmineBase = useRedmine((state) => state.baseUrl)
  const html = useMemo(
    () => renderMarkdown(closeOpenFences(text), { linkPaths: true, redmineBase, math: true }).html,
    [text, redmineBase]
  )
  return (
    <div className="message assistant streaming">
      <MarkdownBody html={html} streaming />
    </div>
  )
}

/** Thinking is shown by default (item 65). The user can close it with the collapse button. It is not saved either (4.3.1). */
function Thinking({ text }: { text: string }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(true)
  // Search inside even while closed (decision 5 of TODO 496).
  const pending = useFindPending('thinking', text, open, () => setOpen(true))
  return (
    <div className="thinking" {...pending}>
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {t('thread.thinking', { count: text.length })}
      </button>
      {open ? <div className="thinking-text">{text}</div> : null}
    </div>
  )
}

/** Whether to show the balloon on a collapsed row (item 286): when the full text is longer than the summary, or the summary is cut off by the field. */
function toolHoverWanted(anchor: HTMLElement, input: JsonValue | null, summary: string): boolean {
  if (toolHover(input, summary).more) return true
  const el = anchor.querySelector<HTMLElement>('.tool-summary')
  return el !== null && el.scrollWidth > el.clientWidth
}

function ToolBlock({ item, depth }: { item: TimelineItem; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Output re-read from the canonical copy (the backend's transcript). **Neither saved nor indexed** (constraint 10).
  const [restored, setRestored] = useState<{ text: string; truncated: boolean } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const threadId = useThreads((state) => state.activeThreadId)
  const t = useT()
  // Item 259: progress while running (kept by main). Undefined for a row whose result has arrived or a row with no report.
  const progress = useToolProgress(
    item.kind === 'tool' && item.result === null && item.interrupted !== true ? item.toolUseId : null
  )
  // Item 321: whether this is a call that started a child (there is a group). Only the boolean is selected. The group heading does not show the size of the result
  // (it is the size of the notice of starting, not the amount of the child's work).
  const toolUseId = item.kind === 'tool' ? item.toolUseId : null
  const spawnsSubagent = useThreads((state) => {
    if (threadId === null || toolUseId === null) return false
    if (state.childEvents[threadId]?.[toolUseId] !== undefined) return true
    return state.threadsById[threadId]?.runtime.subtasks?.some((s) => s.toolUseId === toolUseId) === true
  })
  // Decision 5 of TODO 496: also search the arguments while collapsed and the result (only at hand while receiving) with the in-thread search, and open on a hit.
  // A result after a restart is not saved (constraint 10), so it does not match. The "output re-read from the canonical copy" (`restored`) exists only while open.
  const hidden = useMemo(() => toolFindText(item), [item])
  const pending = useFindPending(`tool:${item.id}`, hidden, open, () => setOpen(true))
  if (item.kind !== 'tool') return <></>

  const restore = (): void => {
    if (threadId === null || restoring) return
    setRestoring(true)
    void window.aios.threads
      .toolResult(threadId, item.toolUseId)
      .then((result) => {
        setRestored(
          result === null
            ? { text: t('tool.transcriptMissing'), truncated: false }
            : { text: result.text, truncated: result.truncated }
        )
      })
      .finally(() => setRestoring(false))
  }

  // TODO 351 (351-3): if the CLI process dies while awaiting approval, main (`ApprovalBroker`) withdraws the dangling
  // approval as `allowed: false, by: 'system'` - nobody declined. Unlike a denied by the user (`by: 'user'`), this is
  // treated as "interrupted" (both the parent row and child rows, matching the "interrupted" derived from bundle C's `runtime.live`).
  const deniedBySystem =
    item.approval !== null && item.approval.outcome.kind === 'denied' && item.approval.outcome.by === 'system'
  const status =
    item.approval !== null && item.approval.outcome.kind === 'pending'
      ? t('thread.state.awaitingApproval')
      : item.approval !== null && item.approval.outcome.kind === 'denied' && !deniedBySystem
        ? t('tool.denied')
        : item.result === null
          ? item.interrupted === true || deniedBySystem
            ? t('tool.interrupted')
            : progress === undefined
              ? t('tool.running')
              : <ToolElapsed progress={progress} />
          : item.result.ok
            ? spawnsSubagent
              ? null
              : formatBytes(item.result.bytes)
            : t('tool.failed')

  return (
    <div className={`tool-block depth-${Math.min(depth, 3)}`} {...pending}>
      {/* Hovering a collapsed row shows the full text (item 286). Not shown if the summary fits in the field and equals the full text. */}
      <Tooltip
        className="tool-hover"
        content={() => <ToolHoverBody input={item.input} summary={item.summary} />}
        when={(anchor) => toolHoverWanted(anchor, item.input, item.summary)}
      >
        <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
          <span className="tool-caret">{open ? '▾' : '▸'}</span>
          <span className="tool-name">{item.name}</span>
          {/* Rows being received are sent by main without redaction (only the saving entry point does it). Also pass them through for display (item 286). */}
          {/* Item 321: rows decided by the plain-text key (the title of a child call) are rebuilt from the arguments (old rows keep the instruction text as the summary). */}
          <span className="tool-summary">{redactText(displayToolSummary(item.input, item.summary)).text}</span>
          <span className={`tool-status ${item.result?.ok === false ? 'bad' : ''}`}>{status}</span>
        </button>
      </Tooltip>
      {/* If it is a plan presentation, show the body collapsed (item 167). */}
      {item.plan !== undefined ? (
        <PlanBlock findKey={`plan:${item.id}`} plan={item.plan} renderBody={(text) => <Message role="assistant" text={text} />} />
      ) : null}
      {open ? (
        <div className="tool-detail">
          {/* Arguments of a child's tool call are not saved (item 257, summary only). Null after reopening. */}
          {item.input === null ? null : <ToolInput input={item.input} className="tool-input" />}
          {item.truncated ? <div className="tool-note">{t('tool.inputTruncated')}</div> : null}
          {item.approval !== null ? (
            <div className="tool-note">
              <OutcomeLabel
                outcome={item.approval.outcome}
                requestedAt={item.approval.requestedAt}
              />
            </div>
          ) : null}
          {item.result === null ? null : item.result.text !== undefined ? (
            <pre className="tool-result">{item.result.text}</pre>
          ) : restored !== null ? (
            <>
              <pre className="tool-result">{restored.text}</pre>
              <div className="tool-note">
                {restored.truncated ? t('tool.restoredHead') : t('tool.restored')}
              </div>
            </>
          ) : (
            // After a restart we arrive here. tool_result is not saved (constraint 10 / 4.3.1).
            <div className="tool-note">
              {t('tool.outputOmitted', { size: formatBytes(item.result.bytes) })}
              <button type="button" className="link-button" onClick={restore} disabled={restoring}>
                {restoring ? t('common.loading') : t('tool.restore')}
              </button>
            </div>
          )}
        </div>
      ) : null}
      {item.children.length > 0 ? (
        <div className="tool-children">
          {item.children.map((child) => (
            <Item key={child.id} item={child} depth={depth + 1} threadId={threadId} />
          ))}
        </div>
      ) : null}
      {/* Sub-agent group (item 257). The child's rows are not in the parent's column; the group component fetches them itself.
          Nothing is drawn for a call that did not start a child. */}
      {threadId === null ? null : (
        <SubagentBlock
          threadId={threadId}
          toolUseId={item.toolUseId}
          renderItem={(child) => <Item item={child} depth={depth + 1} threadId={threadId} />}
        />
      )}
    </div>
  )
}

/**
 * Row for entering and leaving plan mode (item 275). `● Entered plan mode` / `● User approved the plan` / `● Exited plan mode` /
 * `● Stayed in plan mode`. The plan body keeps the collapsed `PlanBlock` (item 167) below as it is.
 */
function PlanTransition({ row }: { row: PlanRow }): React.JSX.Element {
  const t = useT()
  const label =
    row.verdict === 'entered'
      ? t('timeline.plan.entered')
      : row.verdict === 'approved'
        ? t('timeline.plan.approved')
        : row.verdict === 'exited'
          ? t('timeline.plan.exited')
          : row.verdict === 'stayed'
            ? t('timeline.plan.stayed')
            : t('timeline.plan.pending')
  return (
    <div className={`plan-transition ${row.verdict}`}>
      <div className="plan-transition-head">
        <span className="plan-transition-dot" aria-hidden="true">●</span> <strong>{label}</strong>
      </div>
      {row.verdict === 'entered' ? <div className="plan-transition-note">{t('timeline.plan.enteredNote')}</div> : null}
      {row.planFile !== undefined ? (
        <div className="plan-transition-note">{t('timeline.plan.saved', { path: row.planFile })}</div>
      ) : null}
      {row.plan !== undefined ? (
        <PlanBlock findKey={`plan:${row.id}`} plan={row.plan} renderBody={(text) => <Message role="assistant" text={text} />} />
      ) : null}
    </div>
  )
}

/** Make clear who refused (4.2 / 7.6: distinguish a refusal caused by main stopping from a user refusal). */
export function OutcomeLabel({
  outcome,
  requestedAt
}: {
  outcome: ApprovalOutcome
  requestedAt: number
}): React.JSX.Element {
  const t = useT()
  if (outcome.kind === 'pending') {
    return (
      <span className="outcome pending">
        {t('outcome.pending', { held: formatHeld(Date.now() - requestedAt, t) })}
      </span>
    )
  }
  if (outcome.kind === 'allowed') {
    // When a choice question was answered, show **the answer text itself**, not "allowed" (T31 / 4.2.2).
    if (outcome.answer !== undefined && outcome.answer !== '') {
      const label = (
        <span className="outcome allowed">
          {t(outcome.autoPicked === true ? 'outcome.answeredAuto' : 'outcome.answered', { answer: outcome.answer })}
        </span>
      )
      // TODO 1230: for an automatically picked question, show the question, the option list, the recommendation and the chosen answer in the badge (not shown for questions answered by hand).
      if (outcome.autoPicked !== true || outcome.autoPick === undefined) return label
      const record = outcome.autoPick
      return (
        <>
          {label}
          <div className="auto-pick-record" data-testid="auto-pick-record">
            <div className="auto-pick-head">
              <span className="auto-pick-badge">{t('outcome.autoPick.badge')}</span>
              <span className="auto-pick-question">{record.question}</span>
            </div>
            <ul className="auto-pick-options">
              {record.options.map((option, index) => (
                <li key={index} className={index === record.chosen ? 'chosen' : undefined}>
                  <span>{option}</span>
                  {index === record.recommended ? (
                    <span className="auto-pick-mark">{t('outcome.autoPick.recommended')}</span>
                  ) : null}
                  {index === record.chosen ? <span className="auto-pick-mark">{t('outcome.autoPick.chosen')}</span> : null}
                </li>
              ))}
            </ul>
            <div className="auto-pick-waited">{t('outcome.autoPick.waited', { seconds: String(Math.round(record.waitedMs / 1000)) })}</div>
          </div>
        </>
      )
    }
    return (
      <span className="outcome allowed">
        {t('outcome.allowed', {
          by:
            outcome.by === 'rule'
              ? t('outcome.by.rule')
              : outcome.by === 'default'
                ? t('outcome.by.default')
                : t('outcome.by.user')
        })}
      </span>
    )
  }
  // If it was declined without saying anything (item 183), add no sentence. "Talk about this question" shows that.
  const note =
    outcome.reply === 'stop'
      ? ''
      : outcome.reply === 'clarify'
        ? t('outcome.clarify')
        : // TODO 567: aios's withdrawal is a reason code. Old saved rows (Japanese sentences) are shown as is.
          outcome.by === 'system'
          ? describeReason(t, outcome.message)
          : outcome.message
  return (
    <span className="outcome denied">
      {t('outcome.denied', { by: outcome.by === 'system' ? PRODUCT_NAME : t('outcome.by.user') })}{' '}
      {note}
    </span>
  )
}
