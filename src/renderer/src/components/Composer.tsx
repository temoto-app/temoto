/**
 * The prompt box (ARCHITECTURE.md 4.5).
 *
 * The official VS Code extension cannot take images by drag and drop. Here, a Drop from Finder / aios's file list
 * and a clipboard paste are handled by **the same path**.
 * There are two Drop receivers (items 253 / 258, 4.5): the whole conversation pane attaches (the outer frame of `ThreadPane`,
 * `pane-drop.ts`), while only this textarea inserts the full path at the cursor in the same way as Terminal.
 *
 * - Images are attached to the body (base64); anything else puts a path reference (`@path`) into the text.
 * - If the target is outside the thread's reference scope, **ask the user whether to add it.**
 *   Putting it in the reference scope is equivalent to "letting it read the full text without approval" (spike 9d), so
 *   we do not widen it silently.
 * - Resolution (reading, size checks, scope checks) is all done on the main side. The renderer holds only
 *   URIs (IMPLEMENTATION_BRIEF chapter 7).
 *
 * Appearance and the send key were changed in T16 (5.5): monospace + `❯` at the left edge + a single underline,
 * auto-grow from 1 to 10 lines, a lone Enter sends (Shift+Enter inserts a newline,
 * and the Enter that confirms IME conversion does not send; the decision is `shouldSend` in `composer-keys.ts`).
 *
 * Slash commands (item 68 / 4.5.3): if the input starts with a slash followed by a name and the name is not in the list the backend reported,
 * **it is not sent and a band is shown** (no turn is consumed). Starting with `/` shows completion candidates narrowed from the list.
 * The decision is the pure function in `composer-slash.ts`, and no command name is written here (constraint 6).
 *
 * Queueing and interrupting (item 94 / 4.5.4): sending during a response is **queued** (main sends it after the current response ends).
 * It is queued by Enter during a response and by the "queue" button shown only during a response. Stopping the current response and sending right away is
 * ⌘Enter (Ctrl+Enter other than mac; `shouldInterrupt` in `composer-keys.ts`) and the "interrupt" button shown only during a response.
 * Queued messages appear as chips above the input; the pencil returns one to the input and the x cancels it.
 * The final decision on whether a response is in progress is main's (the renderer's state can lag).
 *
 * Stop (item 161, matched to the qlm spec): the primary button is a single one that serves as both send and stop, and during a response it is a red stop square.
 * **It can be pressed at any time** (even with an empty input or while awaiting approval). If the input has focus, Esc also stops
 * (an Esc during IME conversion is not caught; `shouldStop`). The "Stop" button in the heading was removed, and this is the only way to stop.
 * The right end is a single box of [queue] [interrupt] [up arrow / stop square], so the primary button's position does not move even when the two on the left come and go.
 * The paperclip at the left end of the lower row is the OS file picker, and feeds the same path as Drop and paste (`attach`).
 *
 * Plan mode (item 112 / 4.2.3): toggled from the menu in the thread heading (`ThreadSettingsMenu`, TODO 465) and
 * `Shift+Tab` (`isPlanToggle` in `composer-keys.ts`). Only while ON, the Composer shows a `⏸ plan mode on` badge
 * (pressing it turns it OFF). The value is held by main (`runtime.planMode`) and synced to the process just before the next send.
 * When the plan is approved with "proceed with this plan", main turns it back OFF.
 * Specifying a file with `@` (item 114 / 4.5.8): the characters after `@` drive a file name search, and the inside of the working folder is
 * shown first among the candidates (the whole machine is searched). The decision and ordering are the pure functions in `composer-at.ts`, and the search is in `composer-at-search.ts`.
 * A shell with `!` (item 116 / 4.5.7): an input that starts with a half-width `!` is run by main in the thread's cwd, and the
 * command and its output are mixed into the next message. The look (frame color, badge, button wording) shows that it is a `!` input.
 *
 * Re-render granularity (item 88): the thread row pulls only `thread`, and the child `ComposerUsage` pulls
 * `contextUsage` for itself with the donut. The high-frequency delivery of `turn_usage` / `result` does not redraw the Composer body
 * (the input and the buttons). The backend choices use the cache in `threadStore.backends`,
 * so switching threads does not round-trip over IPC.
 *
 * Primary button (item 154 / 5.5): an icon per state instead of text. The mapping from state to kind is cut out into the pure function
 * `composerButtonKind` in `composer-button.ts`, and `title` / `aria-label` keep the earlier wording (for example the Japanese for "send (Enter)").
 * The Plan badge (only while ON, TODO 465) is placed outside `.composer-settings` (the Model / Thinking column), next to the primary button (right-aligned).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThinkingLevel } from '@shared/agent.js'
import { BASE_THINKING_LEVELS, nearestThinkingLevel } from '@shared/agent.js'
import type { Attachment, Reservation, SessionState } from '@shared/thread.js'
import { useThreads, type MessageSettings } from '../threadStore.js'
import { isPlanToggle, keyPlatformOf, shouldInterrupt, shouldSend, shouldStop } from '../composer-keys.js'
import {
  modelsSignature,
  resolveModelChoice,
  resolveThinkingChoice,
  switchNeedsRestart,
  thinkingLabel as thinkingLabelOf,
  thinkingSegmentLevels
} from '../composer-choice.js'
import {
  checkSlash,
  commandsFor,
  completeSlash,
  skillsFor,
  slashMenuStep,
  slashName,
  suggestSlash
} from '../composer-slash.js'
import {
  atActiveIndex,
  atCursorStep,
  atInitialCursor,
  atInsertPath,
  atTokenAt,
  completeAt,
  type AtCandidate
} from '../composer-at.js'
import { useAtCandidates } from '../composer-at-search.js'
import { isShellDraft } from '@shared/shell-input.js'
import {
  composerButtonDisabled,
  composerButtonKind,
  composerStopLocked,
  composerButtonLabelKey,
  composerPlaceholderKey,
  composerPlaceholderKind,
  composerSendEmpty,
  composerSideButtons,
  composerSubmitAction
} from '../composer-button.js'
import { SegmentedControl } from './SegmentedControl.js'
import { ModelPicker } from './ModelPicker.js'
import { canSwitchBackendInPlace } from '@shared/backend-switch.js'
import { ContextUsageDonut } from './ContextUsageDonut.js'
import { Spinner } from './Spinner.js'
import { ComposerSendIcon } from '../icons/ComposerSendIcon.js'
import { ComposerQueueIcon } from '../icons/ComposerQueueIcon.js'
import { ComposerShellIcon } from '../icons/ComposerShellIcon.js'
import { ComposerInterruptIcon } from '../icons/ComposerInterruptIcon.js'
import { ComposerStopIcon } from '../icons/ComposerStopIcon.js'
import { LaterList, LaterMenu } from './LaterMenu.js'
import { ComposerAttachIcon } from '../icons/ComposerAttachIcon.js'
import { ComposerCaptureIcon } from '../icons/ComposerCaptureIcon.js'
import { VoiceButton } from './VoiceButton.js'
import { isDictateShortcut } from '../shortcuts.js'
import { RecentFilesButton } from './RecentFiles.js'
import { RecentOffers } from './RecentOffers.js'
import { Tooltip } from './Tooltip.js'
import { insertAtCursor } from '../voice-input.js'
import { carriesFiles, droppedUris } from '../drop-uris.js'
import { currentFilesDrag, endFilesDrag, filesDragActive } from '../files-drag.js'
import { insertPathsAtCursor, pathsText } from '../drop-paths.js'
import { NO_FAILED, NO_OUTSIDE, allowOutsideDirs, attachUris, useDropNotices } from '../dropStore.js'
import { describeReason, useT } from '../i18n/index.js'
import { pasteAction } from '../paste-image.js'
import { useStore } from '../store.js'
import { openComposerImage } from '../open-attachment-image.js'
import { effectiveSelection, selectionLabel } from '../viewer-selection.js'

/** The same reason as ThreadPane's NO_EVENTS. Do not build a new array in a selector. */
const NO_ATTACHMENTS: readonly Attachment[] = []
const NO_RESERVATIONS: readonly Reservation[] = []

/** Responding = a send in these states becomes a queued message (item 94). The source of truth is main. */
const BUSY_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'starting',
  'running',
  'awaiting-approval',
  'stopping'
])

/** The convention for the interrupt modifier key (Cmd on mac, Ctrl otherwise). */
const KEY_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)
const INTERRUPT_KEY_LABEL = KEY_PLATFORM === 'mac' ? '⌘Enter' : 'Ctrl+Enter'

/** TODO 1064: time to let the user read the first-run notice band before the window is hidden (first time only). */
const CAPTURE_HEADSUP_READ_MS = 2200

export function Composer({
  threadId,
  hidden = false
}: {
  threadId: string
  /** Hidden while a multiple-choice question is shown (item 166). It is not removed so that the Model / Thinking selection is kept. */
  hidden?: boolean
}): React.JSX.Element {
  const t = useT()
  const draft = useThreads((state) => state.drafts[threadId] ?? '')
  // Whether it is a `!` input (item 116). The look switches from the single character `!` (whether it can be sent is `shellCommandOf`).
  const shellDraft = isShellDraft(draft)
  const attachments = useThreads((state) => state.attachments[threadId] ?? NO_ATTACHMENTS)
  const sending = useThreads((state) => state.sending.has(threadId))
  const setDraft = useThreads((state) => state.setDraft)
  const send = useThreads((state) => state.send)
  const removeAttachment = useThreads((state) => state.removeAttachment)
  const addPastedImage = useThreads((state) => state.addPastedImage)
  // Stop (item 161). The same entry point the heading button used to call (the abort of items 95/96; if awaiting approval, the pending
  // approval is cancelled too). The name `interrupt` matches main's SessionManager.interrupt.
  const stopReply = useThreads((state) => state.interrupt)
  // The selection (item 97). The range currently selected in the viewer (this window's ViewerPane) and the range
  // restored from a queued message. Both are selectors that only return existing objects.
  const liveSelection = useStore((state) => state.viewerSelection)
  const heldSelection = useThreads((state) => state.heldSelections[threadId])
  const dismissedSelection = useThreads((state) => state.dismissedSelections[threadId])
  const dismissSelection = useThreads((state) => state.dismissSelection)
  const selection = effectiveSelection(heldSelection, liveSelection, dismissedSelection)
  // Per row (item 75), and only `thread` (item 88). Even when `runtime` (state, cost, usage) changes,
  // `thread` stays the same object (thread-index.ts), so we do not redraw.
  const thread = useThreads((state) => state.threadsById[threadId]?.thread)
  const live = useThreads((state) => state.threadsById[threadId]?.runtime.live === true)
  // How to switch the running process (item 95). A single string, so `turn_usage` does not redraw.
  const switchRestart = useThreads(
    (state) => state.threadsById[threadId]?.runtime.switchRestart ?? 'always'
  )
  // Whether a response is in progress (item 94). A single string, so `turn_usage` does not redraw.
  const runtimeState = useThreads((state) => state.threadsById[threadId]?.runtime.state)
  const busy = runtimeState !== undefined && BUSY_STATES.has(runtimeState)
  // Plan mode (item 112). A single boolean, so `turn_usage` does not redraw.
  const planMode = useThreads((state) => state.threadsById[threadId]?.runtime.planMode === true)
  const settings = useThreads((state) => state.settings)
  const threadModelId = thread?.modelId ?? null
  const threadThinking = thread?.thinking ?? null
  const backendId = thread?.backend ?? null
  // The choices are taken from the backend's feature table (4.6: features that cannot be used are not shown). It only returns an
  // existing object inside the cache (`backends`), so the selector does not build a value.
  const backend = useThreads(
    (state) => state.backends?.find((choice) => choice.id === backendId) ?? null
  )
  const planAvailable = backend?.planMode === true
  // TODO 1018: list the other backends in the Model menu too ("backend > model"). A choice that crosses backends is switched on the spot if nothing has been
  // sent yet, and if there is a conversation it branches into a new thread (no confirmation; the row's wording makes it clear).
  const allBackends = useThreads((state) => state.backends)
  const switchBackend = useThreads((state) => state.switchBackend)
  const crossKind = thread !== undefined && canSwitchBackendInPlace(thread) ? 'in-place' : 'fork'
  /** Plan toggle (item 112, Shift+Tab and the ON badge). Main holds the value and it comes back through delivery (`runtime.planMode`). */
  const togglePlan = (): void => {
    if (!planAvailable) return
    void window.aios.threads.setPlanMode(threadId, !planMode)
  }
  // TODO 1222: automatic selection of the recommendation (per conversation, default OFF). Main holds the value and it comes back through the thread row delivery.
  const autoPick = thread?.autoPickRecommended === true
  const toggleAutoPick = (): void => {
    void window.aios.threads.setAutoPickRecommended(threadId, !autoPick)
  }
  // The list of usable commands (item 68). The thread's own report takes priority; otherwise the backend's cache.
  const threadCommands = useThreads((state) => state.threadCommands[threadId])
  const commands = commandsFor(threadCommands, backend?.commands)
  // TODO 564: the skill names among them (the completion badge). The thread's report takes priority; otherwise the list last reported anywhere.
  const threadSkills = useThreads((state) => state.threadSkills[threadId])
  const recentSkills = useThreads((state) => state.recentSkills)
  const skills = skillsFor(threadSkills, recentSkills)
  const skillSet = useMemo(() => new Set(skills ?? []), [skills])

  // The standing Model / thinking buttons (item 61 / 4.5.1). There is no "default" choice; a
  // concrete value is always selected. The initial value is the thread's value, and if there is none `composer-choice.ts` falls back to
  // the default in settings -> the first of the list (FALLBACK_THINKING for thinking).
  const [modelId, setModelId] = useState<string | null>(null)
  const [thinking, setThinking] = useState<ThinkingLevel | null>(null)
  const settingsModelId = settings?.defaultModelId ?? null
  const settingsThinking = settings?.defaultThinking ?? null
  const latestModels = backend?.models ?? null
  // A list with the same contents keeps the same reference (TODO 937). So a re-fetch over IPC does not revert the selection.
  const modelsKey = modelsSignature(latestModels)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- same key means same contents
  const models = useMemo(() => latestModels, [modelsKey])

  // When the thread is switched, return to that thread's value. It cannot be decided before the list arrives
  // (to pick the first for a thread with nothing specified we need the list), so we decide again once it arrives.
  useEffect(() => {
    setModelId(models === null ? threadModelId : resolveModelChoice(threadModelId, settingsModelId, models))
    setThinking(resolveThinkingChoice(threadThinking, settingsThinking))
  }, [threadId, threadModelId, threadThinking, settingsModelId, settingsThinking, models])

  // The thinking levels that work with that model (item 92). Levels that do not work are shown disabled rather than removed,
  // and if the selected level does not work, we show and send the nearest working level (`nearestThinkingLevel`, the
  // same function as main's validation). Only the display is adjusted; `thinking` (the user's choice) is not changed:
  // going "none" on Sonnet -> Opus (adjusts to "shallow") -> back to Sonnet returns to "none".
  const selectedModel = models?.find((m) => m.id === modelId)
  const selectableThinking = selectedModel?.thinkingLevels ?? BASE_THINKING_LEVELS
  const shownThinking = thinking === null ? null : nearestThinkingLevel(thinking, selectableThinking)
  const modelLabel = selectedModel?.label ?? modelId ?? ''
  // Item 92: a model where effort has no effect (Haiku) is effectively a two-way "none / on", so only the label of the on side
  // (`FALLBACK_THINKING`) uses `thinking.on` (the Japanese for "on") instead of the level name (the Japanese for "normal").
  const thinkingBinary = selectedModel?.thinkingBinary ?? false
  const thinkingLabel = (level: ThinkingLevel): string => thinkingLabelOf(level, thinkingBinary, t)
  /**
   * The thinking levels turned into segment options. The display names come from the dictionary (7.4.4). TODO 1205: to "none / shallow / normal / deep",
   * add on the right the higher levels the model supports (deeper / max / an unnamed level) (`thinkingSegmentLevels`).
   */
  const thinkingOptions = thinkingSegmentLevels(selectedModel?.thinkingLevels).map((level) => {
    const disabled = !selectableThinking.includes(level)
    return {
      value: level,
      label: thinkingLabel(level),
      title: disabled
        ? t('composer.thinkingUnavailable', { level: thinkingLabel(level), model: modelLabel })
        : `thinking: ${thinkingLabel(level)}`,
      disabled
    }
  })

  // A change always means "from now on" (item 61: "this once only" was abolished). If it differs from the thread's row,
  // the next send rewrites the thread's settings. A thread with nothing specified (null) also counts as "changed"
  // by its difference from the concrete value decided here, and is filled in at the first send. A level adjusted
  // (item 92) also counts as "changed" if it differs from the row, and the effective level is saved on the next send.
  const changed = modelId !== threadModelId || shownThinking !== threadThinking
  const overrides: MessageSettings | undefined = changed
    ? { modelId, thinking: shownThinking, settingsScope: 'thread' }
    : undefined
  // The name when stopped on a slash command not in the list (item 68). Cleared when the input changes.
  // We also remember whether it was about to be sent as an interrupt ("send anyway" uses the same way of sending).
  const [blocked, setBlocked] = useState<{ name: string; interrupt: boolean } | null>(null)
  /** TODO 1156: the time Send was last pressed. Stop is not accepted for 300 ms right after a send (`composerStopLocked`). */
  const lastSentAt = useRef<number | null>(null)
  const stopAllowed = (): boolean => !composerStopLocked(lastSentAt.current, Date.now())
  /**
   * `force` is the band's "send anyway". An escape hatch when it was wrongly stopped by the cached list.
   * `interrupt` is an interrupt (item 94). If nothing is responding, it is the same as a normal send (main decides).
   */
  const submit = (force = false, interrupt = false): void => {
    // `!` (item 116) stops only a `!` with no command, and skips the slash check. Anything else is stopped on a slash command not in the list.
    const check = shellDraft || force ? null : checkSlash(draft, commands)
    const action = composerSubmitAction({
      shellDraft,
      draft,
      force,
      unknownSlash: check?.kind === 'unknown' ? check.name : null
    })
    if (action.kind === 'skip') return
    if (action.kind === 'blocked') {
      setBlocked({ name: action.name, interrupt })
      return
    }
    setBlocked(null)
    // The stop lock (TODO 1156) applies only when actually sending. An early return that sends nothing must not stop the stop square.
    lastSentAt.current = Date.now()
    if (action.shell) void send(threadId, undefined, interrupt, null, true)
    else void send(threadId, overrides, interrupt, selection)
  }

  // Completion candidates (item 68). If closed with Esc, they are not shown until the input changes.
  const suggestions = useMemo(() => suggestSlash(draft, commands), [draft, commands])
  const [slashCursor, setSlashCursor] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const showSuggestions = suggestions.length > 0 && !slashDismissed
  useEffect(() => {
    setSlashCursor(0)
    setSlashDismissed(false)
    setBlocked(null)
  }, [draft])
  const complete = (name: string): void => {
    setDraft(threadId, completeSlash(name))
    textRef.current?.focus()
  }
  /**
   * TODO 564: "Create a new skill" at the end of the menu. It only puts a request template for having the CLI write a skill into the input,
   * and the user sends it (after adding instructions). aios does not know the skill file's shape or location (the CLI does).
   */
  const startCreateSkill = (): void => {
    const text = t('composer.slashCreateSkillPrompt')
    pendingCaret.current = text.length
    setDraft(threadId, text)
    textRef.current?.focus()
  }
  /** The number of completion rows (candidates + "Create a new skill" at the end). */
  const slashMenuLength = suggestions.length + 1

  // `@` completion (item 114). Looks at the `@` reference at the input position (caret). Not queried during IME conversion
  // (we do not search on the unconfirmed reading; same handling as `isComposing` in T16). Not shown for a `!` input
  // (`@` goes to the shell as is).
  const [caret, setCaret] = useState(0)
  const [composing, setComposing] = useState(false)
  const atToken = shellDraft || composing ? null : atTokenAt(draft, caret)
  const { candidates: atCandidates, stale: atStale } = useAtCandidates(
    atToken?.query ?? null,
    thread?.cwdUri || null
  )
  const [atCursor, setAtCursor] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const showAt = atToken !== null && atCandidates.length > 0 && !atDismissed
  const atStart = atToken?.start ?? -1
  useEffect(() => {
    setAtCursor(atInitialCursor(atToken?.query ?? null))
    setAtDismissed(false)
  }, [atStart, atToken?.query])
  /** Reposition the caret after completion (only after rendering, or the textarea's value is stale). */
  const pendingCaret = useRef<number | null>(null)
  const completeAtCandidate = (candidate: AtCandidate): void => {
    if (atToken === null) return
    // A folder gets a trailing `/` (TODO 436).
    const next = completeAt(draft, atToken, atInsertPath(candidate))
    pendingCaret.current = next.caret
    setCaret(next.caret)
    setDraft(threadId, next.text)
    textRef.current?.focus()
  }

  /** Keys while `@` candidates are shown. Returns true if handled. */
  const onAtKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!showAt || event.nativeEvent.isComposing) return false
    const at = atActiveIndex(atCursor, atCandidates.length)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setAtCursor(atCursorStep(at, event.key === 'ArrowDown' ? 1 : -1, atCandidates.length))
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setAtDismissed(true)
      return true
    }
    // If nothing is selected (recent candidates for a bare `@`, before pressing the arrow keys), Enter sends and Tab keeps its default behavior.
    const selected = at < 0 ? undefined : atCandidates[at]
    if (selected === undefined) return false
    // If the candidates still belong to the previous word (between the debounce and the search round trip), Enter does not complete and proceeds to send (TODO 942).
    // Tab is an explicit action to pick a candidate, so it is as before.
    if (atStale && shouldSend(event.nativeEvent)) return false
    // Enter / Tab insert the candidate (they do not send). But if what was typed is exactly the selected candidate,
    // Enter proceeds to send (same as slash completion). Otherwise, close with Esc first to send.
    const enter = shouldSend(event.nativeEvent)
    if (enter && atToken !== null && atInsertPath(selected) === atToken.query) return false
    if ((event.key === 'Tab' && !event.shiftKey) || enter) {
      event.preventDefault()
      completeAtCandidate(selected)
      return true
    }
    return false
  }

  /** Keys while completion candidates are shown. Returns true if handled (the caller does not go on to the send decision). */
  const onSlashKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!showSuggestions || event.nativeEvent.isComposing) return false
    const at = Math.min(slashCursor, slashMenuLength - 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSlashCursor(slashMenuStep(at, event.key === 'ArrowDown' ? 1 : -1, slashMenuLength))
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setSlashDismissed(true)
      return true
    }
    // The trailing "Create a new skill" (TODO 564). Tab / Enter puts in the template.
    if (at === suggestions.length) {
      if ((event.key === 'Tab' && !event.shiftKey) || shouldSend(event.nativeEvent)) {
        event.preventDefault()
        startCreateSkill()
        return true
      }
      return false
    }
    const selected = suggestions[at]
    if (selected === undefined) return false
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      complete(selected)
      return true
    }
    // Enter completes only when "the selected candidate differs from the name typed". If they are the same, it proceeds to send.
    if (shouldSend(event.nativeEvent) && selected !== slashName(draft)) {
      event.preventDefault()
      complete(selected)
      return true
    }
    return false
  }

  /** While a file is over the textarea (item 258). Dropping here inserts the full path rather than attaching. */
  const [pathDrop, setPathDrop] = useState(false)
  /** Attachments that were outside the reference scope (the whole conversation pane receives Drop; `dropStore.ts`, item 253). */
  const outside = useDropNotices((state) => state.outside[threadId] ?? NO_OUTSIDE)
  const clearOutside = useDropNotices((state) => state.clearOutside)
  /** What could not be attached (TODO 489). If a drop fails, it is not silent: the file name and reason are shown here. */
  const failed = useDropNotices((state) => state.failed[threadId] ?? NO_FAILED)
  const clearFailed = useDropNotices((state) => state.clearFailed)
  /** Folders for which "add to reference scope" was refused (TODO 600). The reason is shown in the band. */
  const allowFailed = useDropNotices((state) => state.allowFailed[threadId] ?? NO_FAILED)
  const clearAllowFailed = useDropNotices((state) => state.clearAllowFailed)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  // A thread created with "New" in the list heading (item 194, wave 14 bundle F) starts from the prompt box.
  const focusRequested = useThreads((state) => state.composerFocus === threadId)
  useEffect(() => {
    if (!focusRequested || textRef.current === null) return
    if (useThreads.getState().takeComposerFocus(threadId)) textRef.current.focus()
  }, [focusRequested, threadId])

  /**
   * auto-grow (T16 / TODO 20). Starts at 1 line and follows the content height (`scrollHeight`).
   * The upper limit is decided by CSS `max-height` (about 20 lines, up to half the window, TODO 1059), and anything beyond scrolls inside.
   * We re-measure on every render so that it also covers the draft returning to empty after a send.
   */
  useLayoutEffect(() => {
    const element = textRef.current
    if (element === null) return
    element.style.height = 'auto'
    // `scrollHeight` includes padding but not the border. Since box-sizing is border-box, add it.
    const border = element.offsetHeight - element.clientHeight
    element.style.height = `${element.scrollHeight + border}px`
    // The caret position after inserting through `@` completion (item 114). Set it after the value has been redrawn.
    if (pendingCaret.current !== null) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [draft])

  const attach = useCallback((uris: readonly string[]) => attachUris(threadId, uris), [threadId])

  /**
   * A Drop onto the textarea (item 258). Not attached: the full path is inserted at the cursor in the same format
   * as dropping onto Terminal (escaped with `\ `). The outer frame (the whole conversation pane, `ThreadPane`) looks at `defaultPrevented` and does not attach.
   */
  const onInputDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
      event.preventDefault() // The outer frame's Drop (the pane's attachment) sees this and does nothing
      setPathDrop(false)
      const text = pathsText(droppedUris(event.dataTransfer, window.aios.drop.uriFor, currentFilesDrag()))
      // Use it up on this drop (a fix from the code-review, TODO 677).
      endFilesDrag()
      if (text === '') return
      const element = event.currentTarget
      const current = useThreads.getState().drafts[threadId] ?? ''
      const next = insertPathsAtCursor(current, element.selectionStart, element.selectionEnd, text)
      pendingCaret.current = next.caret
      setCaret(next.caret)
      setDraft(threadId, next.text)
      element.focus()
    },
    [threadId, setDraft]
  )

  /** The paperclip (item 161). Pick with the OS file picker and feed the same path as Drop and paste. */
  const pickAttachments = useCallback(async () => {
    const uris = await window.aios.attachments.pick()
    if (uris.length > 0) await attach(uris)
  }, [attach])

  // Voice input (item 226, wave 14 bundle M). The transcription is only put at the cursor; a person presses Enter to send.
  // The result returns asynchronously, so the body and selection are taken as of the time it returns (so text typed during recording is not erased).
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null)
  /** TODO 1268: set by `VoiceButton` while it is mounted (mac only). Null where voice input is unavailable, so the shortcut does nothing. */
  const voiceToggle = useRef<(() => void) | null>(null)
  const insertVoiceText = useCallback(
    (spoken: string) => {
      const element = textRef.current
      const current = useThreads.getState().drafts[threadId] ?? ''
      const start = element?.selectionStart ?? current.length
      const end = element?.selectionEnd ?? current.length
      const next = insertAtCursor(current, start, end, spoken)
      pendingCaret.current = next.caret
      setCaret(next.caret)
      setVoiceNotice(null)
      setDraft(threadId, next.text)
      element?.focus()
    },
    [threadId, setDraft]
  )

  // TODO 957: capture part of the screen and attach it. Holding ⌥ does not hide aios's window. No duplicate start while capturing.
  const capturing = useRef(false)
  const [captureNotice, setCaptureNotice] = useState<string | null>(null)
  const captureScreen = useCallback(
    async (keepWindows: boolean) => {
      if (capturing.current) return
      capturing.current = true
      try {
        // TODO 1064: only the first time, "macOS will ask for confirmation once more". Show the band before capturing and leave time (once only) to read it before the window is hidden.
        // Write the done marker after showing and waiting (a failure before display does not use it up).
        if (await window.aios.paste.captureHeadsUp().catch(() => false)) {
          setCaptureNotice(t('capture.headsUp'))
          await new Promise((resolve) => setTimeout(resolve, CAPTURE_HEADSUP_READ_MS))
          void window.aios.paste.captureHeadsUpShown().catch(() => undefined)
        }
        await addPastedImage(threadId, (n) => t('paste.imageName', { n }), { keepWindows })
      } finally {
        setCaptureNotice(null)
        capturing.current = false
      }
    },
    [addPastedImage, threadId, t]
  )
  // Shortcut ⌃⇧⌘5 (with ⌥ the window is not hidden). Only while aios is in front (the renderer's keydown).
  // Only the Composer of the visible thread receives it.
  useEffect(() => {
    if (hidden || KEY_PLATFORM !== 'mac') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Digit5' || !event.ctrlKey || !event.shiftKey || !event.metaKey) return
      event.preventDefault()
      void captureScreen(event.altKey)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hidden, captureScreen])

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // A file with a path takes the same path as Drop (4.5), an image with no path is read by main and attached (item 319),
      // and if there is text, the default paste applies (the routing is in `paste-image.ts`).
      const action = pasteAction(event.clipboardData, window.aios.drop.uriFor)
      if (action.kind === 'default') return
      event.preventDefault()
      if (action.kind === 'attach') void attach(action.uris)
      else void addPastedImage(threadId, (n) => t('paste.imageName', { n }))
    },
    [attach, addPastedImage, threadId, t]
  )

  return (
    <div className="composer" hidden={hidden}>
      {outside.length > 0 ? (
        <div className="composer-permission">
          {t('composer.outside')}
          <span className="paths">{outside.map(basenameOf).join(', ')}</span>
          <button
            type="button"
            onClick={() => void allowOutsideDirs(threadId, outside)}
          >
            {t('composer.allowDir')}
          </button>
          <button type="button" onClick={() => clearOutside(threadId)}>
            {t('composer.sendAnyway')}
          </button>
          {/* TODO 624: adding does not affect this send (--add-dir is not reflected until a new process is started next).
              We only tell the user in the wording (the mechanism of 584 itself is unchanged). */}
          <span className="composer-allow-hint">{t('composer.allowDirHint')}</span>
        </div>
      ) : null}
      {allowFailed.length > 0 ? (
        <div className="composer-permission composer-attach-failed composer-allow-failed" role="alert">
          {t('composer.allowDirFailed')}
          <ul className="failures">
            {allowFailed.map((failure) => (
              <li key={failure.uri}>
                <span className="paths">{basenameOf(failure.uri)}</span>: {describeReason(t, failure.reason)}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => clearAllowFailed(threadId)}>
            {t('composer.attachFailedDismiss')}
          </button>
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div className="composer-permission composer-attach-failed" role="alert">
          {t('composer.attachFailed')}
          <ul className="failures">
            {failed.map((failure) => (
              <li key={failure.uri}>
                <span className="paths">{basenameOf(failure.uri)}</span>: {describeReason(t, failure.reason)}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => clearFailed(threadId)}>
            {t('composer.attachFailedDismiss')}
          </button>
        </div>
      ) : null}

      {/* TODO 999 / 1172: the badge of recent files (while aios is in front, within 5 minutes, at most 3). */}
      <RecentOffers threadId={threadId} hidden={hidden} />
      {attachments.length > 0 || selection !== null ? (
        <div className="composer-attachments">
          {selection !== null ? (
            // The selection (item 97). When sent, main embeds it in the body, and it is not attached to the next message until selected again.
            <span className="chip selection" title={t('composer.selectionHint')}>
              ✂{' '}
              {t(selection.truncated ? 'composer.selectionTruncated' : 'composer.selection', {
                label: selectionLabel(selection)
              })}
              <button
                type="button"
                aria-label={t('composer.selectionRemove')}
                title={t('composer.selectionRemove')}
                onClick={() => dismissSelection(threadId, selection)}
              >
                ×
              </button>
            </span>
          ) : null}
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.uri}
              attachment={attachment}
              onRemove={() => removeAttachment(threadId, attachment.uri)}
            />
          ))}
        </div>
      ) : null}

      {/* Queued messages (item 94). In send order. When one is sent the chip disappears and the message appears in the timeline. */}
      <ReservationChips threadId={threadId} />
      {/* A "send later" queued message (TODO 989). With a time; cancelled with the x. */}
      <LaterList threadId={threadId} />
      {/* The number of `!` results not yet mixed into the next message (item 116). */}
      <PendingShellNote threadId={threadId} />

      {/* Item 42: the input, divider, toolbar and send button fit in a single frame with four rounded corners.
          The border color changes only while focused (CSS :focus-within. It does not touch the send decision). */}
      {blocked !== null ? (
        // A command not in the list (item 68). Nothing was sent, so no turn was consumed.
        <div className="composer-permission composer-slash-blocked" role="alert">
          {t('composer.slashUnavailable', { name: blocked.name })}
          <button type="button" onClick={() => submit(true, blocked.interrupt)} disabled={sending}>
            {t('composer.slashSendAnyway')}
          </button>
        </div>
      ) : null}

      {/* Completion candidates (item 68). The frame (`.composer-frame`) is overflow: hidden, so they are placed
          outside it, right above, in the flow (absolute positioning would be clipped by the frame). */}
      {showSuggestions ? (
        <ul className="composer-slash-menu" role="listbox" aria-label={t('composer.slashMenu')}>
          {suggestions.map((name, index) => (
            <li
              key={name}
              role="option"
              aria-selected={index === Math.min(slashCursor, slashMenuLength - 1)}
              className={index === Math.min(slashCursor, slashMenuLength - 1) ? 'active' : undefined}
              // Decide on mousedown (with click, the textarea's blur comes first).
              onMouseDown={(event) => {
                event.preventDefault()
                complete(name)
              }}
            >
              <span className="slash-name">/{name}</span>
              {/* TODO 564: CLI skills are distinguished by a badge (the name stays as the CLI reported it). */}
              {skillSet.has(name) ? <span className="slash-skill-tag">{t('composer.slashSkillTag')}</span> : null}
            </li>
          ))}
          {/* TODO 564: "Create a new skill" at the end. Puts the request template for having the CLI write it into the input (not sent). */}
          <li
            key="__create-skill"
            role="option"
            aria-selected={Math.min(slashCursor, slashMenuLength - 1) === suggestions.length}
            className={`slash-create-skill${Math.min(slashCursor, slashMenuLength - 1) === suggestions.length ? ' active' : ''}`}
            onMouseDown={(event) => {
              event.preventDefault()
              startCreateSkill()
            }}
          >
            {t('composer.slashCreateSkill')}
          </li>
        </ul>
      ) : null}

      {/* `@` candidates (item 114). Placed the same way as the slash frame (outside the frame, right above, in the flow).
          Inside the working folder a relative path is shown, outside an absolute path (the same string that gets inserted). */}
      {showAt ? (
        <ul className="composer-slash-menu composer-at-menu" role="listbox" aria-label={t('composer.atMenu')}>
          {atCandidates.map((candidate, index) => {
            const active = index === atActiveIndex(atCursor, atCandidates.length)
            return (
              <li
                key={candidate.uri}
                role="option"
                aria-selected={active}
                className={active ? 'active' : undefined}
                title={candidate.inCwd ? t('composer.atInCwd') : t('composer.atOutsideCwd')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  completeAtCandidate(candidate)
                }}
              >
                <span className="at-name">
                  {candidate.name}
                  {candidate.isDirectory ? '/' : ''}
                </span>
                <span className={`at-path${candidate.inCwd ? '' : ' outside'}`}>{candidate.path}</span>
              </li>
            )
          })}
        </ul>
      ) : null}

      {captureNotice !== null ? (
        <div className="composer-permission composer-voice-notice" role="status">
          {captureNotice}
        </div>
      ) : null}

      {voiceNotice !== null ? (
        // The voice input notice (item 226). Placed in the flow outside the frame (`overflow: hidden`), right above.
        <div className="composer-permission composer-voice-notice" role="alert">
          {voiceNotice}
          <button type="button" onClick={() => setVoiceNotice(null)} aria-label={t('common.close')}>
            ×
          </button>
        </div>
      ) : null}

      <div className={`composer-frame${shellDraft ? ' shell-mode' : ''}`}>
      <div className="composer-prompt">
        {shellDraft ? (
          // A `!` input (item 116). When sent it runs in the cwd, and the result is mixed into the next message.
          <span className="composer-mode-badge" title={t('composer.shellHint')}>
            {t('composer.shellMode')}
          </span>
        ) : null}
        {pathDrop ? <span className="composer-drop-hint">{t('drop.pathHint')}</span> : null}
        <textarea
          ref={textRef}
          className={`composer-input${pathDrop ? ' path-drop' : ''}`}
          rows={1}
          value={draft}
          placeholder={t(
            composerPlaceholderKey(composerPlaceholderKind({ busy, planMode }))
          )}
          onChange={(event) => {
            setCaret(event.target.selectionStart)
            setDraft(threadId, event.target.value)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => {
            setComposing(false)
            setCaret(event.currentTarget.selectionStart)
          }}
          onPaste={onPaste}
          onDragOver={(event) => {
            if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
            event.preventDefault()
            setPathDrop(true)
          }}
          onDragLeave={() => setPathDrop(false)}
          onDrop={onInputDrop}
          onKeyDown={(event) => {
            // Shift+Tab toggles Plan ON / OFF (item 112). On a backend where it is unavailable, the default behavior (focus move) applies.
            if (planAvailable && isPlanToggle(event.nativeEvent)) {
              event.preventDefault()
              togglePlan()
              return
            }
            // Start / stop dictation (TODO 1268). Does nothing (and the key keeps its default) where there is no microphone button.
            if (voiceToggle.current !== null && isDictateShortcut(event.nativeEvent)) {
              event.preventDefault()
              voiceToggle.current()
              return
            }
            if (onAtKey(event)) return
            if (onSlashKey(event)) return
            // Esc stops (item 161). If the completion list is open, it is closed first (the two above take it).
            // An Esc during conversion cancels the conversion, so `shouldStop` does not catch it.
            if (busy && shouldStop(event.nativeEvent)) {
              event.preventDefault()
              if (stopAllowed()) void stopReply(threadId)
              return
            }
            // The decision is put out into a pure function (composer-keys.ts). The Enter that confirms IME conversion does not send.
            if (!shouldSend(event.nativeEvent)) return
            event.preventDefault()
            // Like the send button, do not send while sending. ⌘Enter is an interrupt (item 94).
            if (!sending) submit(false, shouldInterrupt(event.nativeEvent, KEY_PLATFORM))
          }}
        />
      </div>
      <div className="composer-actions">
        {/* Item 61: Model / Thinking are standing segment buttons. Item 60: to their right,
            the context usage donut (shown only when the denominator is known). */}
        <div className="composer-settings">
          {/* The attach button (paperclip, item 161). It can be pressed during a response too (the attachment goes with the next message / queued message).
              The description uses the shared popover rather than the OS title (items 320 / 373). */}
          <Tooltip placement="top" content={t('composer.attachHint')}>
            <button
              type="button"
              className="composer-attach"
              onClick={() => void pickAttachments()}
              aria-label={t('composer.attach')}
            >
              <ComposerAttachIcon />
            </button>
          </Tooltip>
          {/* TODO 999: a small window of recent files (whole PC, last 7 days). Choosing one attaches it through the same path as above. */}
          <RecentFilesButton threadId={threadId} />
          {/* TODO 957: capture part of the screen and attach (macOS only). Normally aios's window is hidden for the capture. ⌥ keeps it visible. */}
          {KEY_PLATFORM === 'mac' ? (
            <Tooltip
              placement="top"
              content={
                <>
                  <div>{t('composer.captureHint1')}</div>
                  <div>{t('composer.captureHint2')}</div>
                </>
              }
            >
              <button
                type="button"
                className="composer-attach"
                onClick={(event) => void captureScreen(event.altKey)}
                aria-label={t('composer.capture')}
              >
                <ComposerCaptureIcon />
              </button>
            </Tooltip>
          ) : null}
          {/* Voice input (item 226). Next to the paperclip, so the send button's position does not move. macOS only
              (the on-device recognition helper is macOS-only). */}
          {KEY_PLATFORM === 'mac' ? (
            <VoiceButton threadId={threadId} onText={insertVoiceText} onNotice={setVoiceNotice} toggleRef={voiceToggle} />
          ) : null}
          {backend !== null && backend.modelSelect ? (
            // Top-level aliases are a button row; a model with a pinned version goes in the "Other" menu (TODO 769).
            <ModelPicker
              models={backend.models}
              value={modelId}
              onChange={setModelId}
              backends={allBackends ?? []}
              backendId={backend.id}
              crossKind={crossKind}
              onSwitchBackend={(target, targetModel) => void switchBackend(threadId, target, targetModel)}
            />
          ) : null}
          {backend !== null && backend.thinkingLevel ? (
            <SegmentedControl
              label="thinking"
              value={shownThinking}
              onChange={setThinking}
              options={thinkingOptions}
            />
          ) : null}
          <ComposerUsage threadId={threadId} />
          {backend !== null &&
          changed &&
          live &&
          switchNeedsRestart(switchRestart, threadThinking, shownThinking) ? (
            // Shown only on the path that restarts by dropping and resuming (item 95). If the version supports it,
            // it switches while running (4.5.1).
            <span className="composer-note">{t('composer.restartNote')}</span>
          ) : null}
        </div>
        {thread !== undefined ? (
          // TODO 1222: the switch for automatic selection of the recommendation (per conversation, default OFF). Placed in the row of the approval-mode badges (`.auto-pick-toggle`, the same look as Plan below).
          // Only for a single-select question whose first option is the recommended one: after a few seconds of countdown, the recommendation is chosen. Effective only in conversations where it is ON.
          <Tooltip placement="top" content={t('composer.autoPickHint')}>
            <button type="button" className={autoPick ? 'auto-pick-toggle on' : 'auto-pick-toggle'} aria-pressed={autoPick} onClick={toggleAutoPick}>
              {t(autoPick ? 'composer.autoPickOn' : 'composer.autoPickOff')}
            </button>
          </Tooltip>
        ) : null}
        {planAvailable && planMode ? (
          // The Plan mode badge (TODO 465, a revision of 112 / 154 / 256). The switching entry points are the menu in the thread heading
          // (`ThreadSettingsMenu`) and Shift+Tab, and this is shown **only while ON** (the CLI also shows
          // nothing when OFF). It is a badge to prevent sending in Plan unawares, and pressing it turns it OFF. The wording follows the CLI's text under the input,
          // `⏸ plan mode on` (item 256). The keys are written in the popover. Right-aligned, next to the primary button (the same place as item 154):
          // the primary button is in the right-end box (`.composer-buttons`), so it does not move when the badge comes and goes (item 161).
          <Tooltip placement="top" content={t('composer.planOnHint')}>
            <button type="button" className="plan-toggle on" aria-pressed={true} onClick={togglePlan}>
              {t('composer.planOn')}
            </button>
          </Tooltip>
        ) : null}
        {(() => {
          // The right-end box (item 161, matched to qlm). Normally [up arrow]; during a response [queue] [interrupt] [stop square].
          // The primary button's position does not move when the two on the left come and go (fixed to the box's right end). The decision is a pure function
          // (`composer-button.ts`). The text is removed in favor of icons, and the wording is kept in `title` / `aria-label`.
          const kind = composerButtonKind({ sending, busy, shellDraft })
          const label = t(composerButtonLabelKey(kind))
          const empty = composerSendEmpty({
            shellDraft,
            draft,
            hasAttachments: attachments.length > 0,
            hasSelection: selection !== null
          })
          const side = composerSideButtons({ busy, sending, empty })
          const title =
            kind === 'stop' ? t('composer.stopHint') : kind === 'shellRun' ? t('composer.shellHint') : label
          // Item 373: the description is the shared popover, not the OS title. When disabled, a short reason is added.
          // Chromium may not deliver mouseenter / focus to a disabled button, so
          // the popover's receiver is the span wrapping the button (always enabled); `disabled` stays on the button itself
          // (so the decisions of `composerButtonDisabled` / `composerSideButtons` can be used unchanged).
          const reserveTip = empty ? t('composer.reserveDisabledHint') : t('composer.reserveHint')
          const interruptTip = empty
            ? t('composer.interruptDisabledHint')
            : t('composer.interruptHint', { key: INTERRUPT_KEY_LABEL })
          const sendDisabled = composerButtonDisabled(kind, empty)
          return (
            <div className="composer-buttons">
              {side.visible ? (
                // Queue (item 94 / 161). Same as Enter during a response. It is not made to share the stop button (that would make stopping impossible).
                <Tooltip placement="top" content={reserveTip}>
                  <span className="composer-icon-tip" aria-disabled={side.disabled || undefined}>
                    <button
                      type="button"
                      className="composer-reserve"
                      onClick={() => submit(false, false)}
                      disabled={side.disabled}
                      aria-label={t('composer.reserve')}
                    >
                      <ComposerQueueIcon />
                    </button>
                  </span>
                </Tooltip>
              ) : null}
              {side.visible ? (
                // Interrupt (item 94). Stops the current response and sends right away. Placed between queue and stop
                // (from the left: "leave the current response alone -> stop and send -> stop").
                <Tooltip placement="top" content={interruptTip}>
                  <span className="composer-icon-tip" aria-disabled={side.disabled || undefined}>
                    <button
                      type="button"
                      className="composer-interrupt"
                      onClick={() => submit(false, true)}
                      disabled={side.disabled}
                      aria-label={t('composer.interrupt')}
                    >
                      <ComposerInterruptIcon />
                    </button>
                  </span>
                </Tooltip>
              ) : null}
              {/* "Send later" (TODO 989). To the left of the primary button. Usable during a response too. */}
              <LaterMenu threadId={threadId} settings={overrides} />
              {/* The primary button (item 154 / 161). A single button serving as both send and stop. All shapes are placed, and CSS (`data-kind`)
                  decides which one is shown, so the button is not rebuilt and the place to press does not move.
                  In the stop role it can always be pressed (`composerButtonDisabled`). */}
              <Tooltip placement="top" content={title}>
                <span className="composer-icon-tip" aria-disabled={sendDisabled || undefined}>
                  <button
                    type="button"
                    className={`composer-send composer-send-${kind}`}
                    data-kind={kind}
                    onClick={() => {
                      if (kind === 'stop') {
                        if (stopAllowed()) void stopReply(threadId)
                      }
                      else submit()
                    }}
                    disabled={sendDisabled}
                    aria-label={label}
                  >
                    <span className="composer-glyph glyph-send">
                      <ComposerSendIcon />
                    </span>
                    <span className="composer-glyph glyph-stop">
                      <ComposerStopIcon />
                    </span>
                    <span className="composer-glyph glyph-shell">
                      <ComposerShellIcon />
                    </span>
                    <span className="composer-glyph glyph-spinner">
                      <Spinner className="in-row composer-send-spinner" />
                    </span>
                  </button>
                </span>
              </Tooltip>
            </div>
          )
        })()}
      </div>
      </div>
    </div>
  )
}

/**
 * The queued message chips (item 94). A child that **subscribes by itself**: `runtime.reservations` stays the same array
 * when the contents are the same (thread-index.ts), so the delivery of `turn_usage` does not redraw it.
 */
function ReservationChips({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const reservations = useThreads(
    (state) => state.threadsById[threadId]?.runtime.reservations ?? NO_RESERVATIONS
  )
  const cancel = useThreads((state) => state.cancelReservation)
  const edit = useThreads((state) => state.editReservation)
  if (reservations.length === 0) return null
  return (
    <ol className="composer-reservations" aria-label={t('composer.reservations')}>
      {reservations.map((item) => (
        <li key={item.id} className={`chip reservation${item.interrupt ? ' interrupt' : ''}`}>
          <span className="reservation-kind">
            {item.interrupt ? t('composer.reservation.interrupt') : t('composer.reservation.queued')}
          </span>
          <span className="reservation-text">{item.preview}</span>
          {item.attachments > 0 ? (
            <span className="reservation-attachments">
              {t('composer.reservation.attachments', { count: item.attachments })}
            </span>
          ) : null}
          {/* Item 373: the popover is the shared Tooltip (`title` is not used). These two never become disabled,
              so wrapping the button directly is enough (the `composer-icon-tip` span is unnecessary). */}
          <Tooltip placement="top" content={t('composer.reservation.edit')}>
            <button
              type="button"
              className="reservation-action"
              aria-label={t('composer.reservation.edit')}
              onClick={() => void edit(threadId, item.id)}
            >
              ✎
            </button>
          </Tooltip>
          <Tooltip placement="top" content={t('composer.reservation.cancel')}>
            <button
              type="button"
              className="reservation-action"
              aria-label={t('composer.reservation.cancel')}
              onClick={() => void cancel(threadId, item.id)}
            >
              ×
            </button>
          </Tooltip>
        </li>
      ))}
    </ol>
  )
}

/**
 * The number of `!` results waiting to be mixed into the next message (item 116). A child that **subscribes by itself**:
 * it is a single number, so the delivery of `turn_usage` does not redraw it.
 */
function PendingShellNote({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const count = useThreads((state) => state.threadsById[threadId]?.runtime.pendingShell ?? 0)
  if (count === 0) return null
  return (
    <div className="composer-shell-pending" title={t('composer.shellPendingHint')}>
      {t('composer.shellPending', { count })}
    </div>
  )
}

/**
 * A child that **subscribes by itself** (item 88) to the context usage donut (item 60). `turn_usage` arrives
 * on every API call, so if the Composer body pulled it, the whole input would be redrawn.
 */
function ComposerUsage({ threadId }: { threadId: string }): React.JSX.Element {
  const usage = useThreads((state) => state.threadsById[threadId]?.runtime.contextUsage ?? null)
  return <ContextUsageDonut usage={usage} threadId={threadId} />
}

/**
 * The data URL of an attachment (TODO 461). Only for an image that has base64 for sending and an `image/*` type.
 * The material is the very `Attachment` that main read for sending and passed over: no extra read and no IPC.
 * The CSP (`index.html`) `img-src` allows `data:`.
 */
export function attachmentThumbnailSrc(attachment: Attachment): string | null {
  if (attachment.kind !== 'image') return null
  if (attachment.base64 === undefined || attachment.base64 === '') return null
  const type = attachment.mediaType
  if (type === null || !type.startsWith('image/')) return null
  return `data:${type};base64,${attachment.base64}`
}

/**
 * One attachment chip (TODO 461). An image shows a thumbnail (square, `object-fit: cover`) to the left of the chip,
 * and hovering the thumbnail shows a larger preview in a popover.
 * TODO 971: clicking the thumbnail (and name) opens it in ViewerPane (this reversed 461's "do not open"). The x only removes. The name is shortened.
 * A `reference` (path reference) is as before: the file icon + name.
 *
 * The data URL can be a string of several MB, so it is built only once with `useMemo` (not concatenated on every re-render).
 */
/** The upper limit of one side of the popover preview (px). It fits, with the name row, within the popover's `max-height` (360px). */
export const ATTACHMENT_PREVIEW_MAX = 300

/**
 * The preview size (TODO 461). Keeps the aspect ratio and fits inside a square of `max` (small images are not enlarged).
 * The popover decides its placement from the size right after drawing (`useLayoutEffect` in `Tooltip`), so
 * `width` / `height` are given explicitly so the size is fixed without waiting for the image to decode.
 */
export function fitAttachmentPreview(
  natural: { width: number; height: number },
  max: number | { width: number; height: number } = ATTACHMENT_PREVIEW_MAX
): { width: number; height: number } {
  const box = typeof max === 'number' ? { width: max, height: max } : max
  const { width, height } = natural
  if (!(width > 0) || !(height > 0)) return { width: box.width, height: box.height }
  const scale = Math.min(1, box.width / width, box.height / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The popover frame's margin (padding 6 + border 1 on both sides) plus the height of the name row (margin included). */
const PREVIEW_FRAME_PX = 14
const PREVIEW_NAME_ROW_PX = 24
/** The gap between the popover and the chip (6) + the margin at the window edge (8). `GAP` / `MARGIN` of `Tooltip`. */
const PREVIEW_ABOVE_RESERVE_PX = 14

/**
 * The frame usable for an image in the Composer chip's popover (TODO 770). 80% of the window's width / height minus the popover's margin and the name row.
 * The window size is read each time it is shown (so it follows resizing). It does not enlarge beyond the original size (`fitAttachmentPreview`).
 */
export function composerPreviewBox(
  viewport: { width: number; height: number },
  /**
   * The free space above the chip (px, from the chip's top edge to the window's top edge). The popover appears above, so if it does not fit, it is clamped to the top edge and
   * covers the chip. When passed, the image is shrunk to a height at which the whole popover (frame, name row, gap, window-edge margin) fits in that space.
   */
  spaceAbove?: number
): { width: number; height: number } {
  const height = Math.max(1, Math.floor(viewport.height * 0.8) - PREVIEW_FRAME_PX - PREVIEW_NAME_ROW_PX)
  const fitAbove =
    spaceAbove === undefined
      ? height
      : Math.max(1, Math.floor(spaceAbove) - PREVIEW_ABOVE_RESERVE_PX - PREVIEW_FRAME_PX - PREVIEW_NAME_ROW_PX)
  return {
    width: Math.max(1, Math.floor(viewport.width * 0.8) - PREVIEW_FRAME_PX),
    height: Math.min(height, fitAbove)
  }
}

function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: Attachment
  onRemove: () => void
}): React.JSX.Element {
  const t = useT()
  // The attachments array returns the same objects the store holds (after adding or removing, the remaining elements keep the same reference), so
  // memoizing by reference means we rebuild only when the contents change.
  const src = useMemo(() => attachmentThumbnailSrc(attachment), [attachment])
  // The original size at the time the thumbnail was read. Used to decide the popover preview's size in advance.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const chipRef = useRef<HTMLSpanElement | null>(null)
  if (src === null) {
    return (
      <span className="chip">
        {attachment.kind === 'image' ? '🖼' : '📄'} {attachment.name}
        <button type="button" onClick={onRemove}>
          ×
        </button>
      </span>
    )
  }
  // The popover's anchor is only the thumbnail and the name (not the x): if the popover is clamped to the top edge and covers the x, hover
  // stays open and the x cannot be pressed. In a window where it does not fit above, the image is shrunk to the free space above the chip.
  return (
    <span className="chip chip-image" ref={chipRef}>
      <Tooltip
        placement="top"
        className="attachment-preview-tip attachment-preview-large"
        content={() => (
          <>
            <img
              className="attachment-preview"
              src={src}
              alt=""
              {...fitAttachmentPreview(
                natural ?? { width: 0, height: 0 },
                composerPreviewBox(
                  { width: window.innerWidth, height: window.innerHeight },
                  chipRef.current?.getBoundingClientRect().top
                )
              )}
            />
            <div className="attachment-preview-name">{attachment.name}</div>
          </>
        )}
      >
        <span
          className="chip-preview-anchor clickable"
          onClick={() => {
            openComposerImage(attachment)
          }}
        >
          <img
            className="attachment-thumb"
            src={src}
            alt={t('composer.attachmentThumb', { name: attachment.name })}
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight
              })
            }
          />
          <span className="chip-name">{attachment.name}</span>
        </span>
      </Tooltip>
      <button type="button" onClick={onRemove}>
        ×
      </button>
    </span>
  )
}

function basenameOf(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))
}
