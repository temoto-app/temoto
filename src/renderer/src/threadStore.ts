/**
 * The state of threads / the approval inbox (Zustand).
 *
 * The renderer receives **only diffs** from main (ARCHITECTURE.md chapter 3).
 * Events arrive batched every 16 ms (5.1 / spike 8), so the state is updated
 * only once per batch.
 */
import { withThumbnails } from './attachment-thumbnail.js'
import { create } from 'zustand'
import {
  loadSidebarCollapsed,
  pressMode,
  saveSidebarCollapsed,
  toggleCollapsed
} from './sidebarCollapse.js'
import { folderCreateInput } from './thread-list-heading.js'
import { EMPTY_THREAD_INDEX, applyThreadChange, indexFromList } from './thread-index.js'
import { useGitStatus } from './gitStatusStore.js'
import {
  appendEvents,
  keepsLiveEvents,
  lastCommands,
  lastMcpServers,
  lastSkills,
  mergeLoaded,
  liveDeltasOnly,
  prependOlder
} from './thread-events.js'
import { nextTurnEnded, type TurnEnded } from './thread/finish-scroll.js'
import {
  appendChildEvents,
  mergeChildEvents,
  NO_BUCKETS,
  prependChildEvents,
  splitChildEvents,
  type ChildBuckets
} from './thread/subagent-blocks.js'
import type { AgentStatus, AiosEvent, McpServerReport, ThinkingLevel } from '@shared/agent.js'
import type {
  ApprovalDecision,
  ApprovalItem,
  Attachment,
  BackendChoice,
  CreateThreadInput,
  DeletedThreadSummary,
  SessionSettings,
  Thread,
  ThreadRemoveResult,
  ThreadSummary,
  ViewerSelection
} from '@shared/thread.js'
import { CLIPBOARD_ATTACHMENT_PREFIX } from '@shared/thread.js'
import { selectionKey } from './viewer-selection.js'
import { loadUntil } from './thread/load-until.js'
import { createSubscriptionSlot } from './subscription-slot.js'
// A cycle (dropStore -> threadStore), but each calls the other only inside functions (nothing is touched at load time).
import { attachUris } from './dropStore.js'

/**
 * Whether the thread has past messages at the time it is created (item 139). A thread continued from a transcript (item 111: the list in the create
 * dialog, "this folder's CLI conversations" (item 122), and "continue this conversation" in conversation search,
 * whether continuing with the same id or branching) shows the transcript's past at the head of the timeline. If this were marked "loaded, empty",
 * `selectThread` would not fetch it and it would stay empty until the window is reloaded.
 * Ordinary new threads, Drop, and rewind branches (item 113, which do not copy the original timeline) start empty, so
 * this is false (no extra fetch).
 */
export function createdWithHistory(thread: Pick<Thread, 'transcriptOrigin'>): boolean {
  // A value without the field (an old shape, a fake in tests) is treated as an empty thread.
  return (thread.transcriptOrigin ?? null) !== null
}

/**
 * The per-message override of model / thinking (T7 / 4.5.1). Omitted means the thread's default,
 * `null` is an explicit "the backend's default". `settingsScope: 'thread'` also changes the default.
 */
export interface MessageSettings {
  readonly modelId?: string | null
  readonly thinking?: ThinkingLevel | null
  readonly settingsScope?: 'message' | 'thread'
}

/**
 * The state of "read more" (item 88). `before` is `seq < before` for the next page to fetch
 * (= the seq of the oldest row among those loaded), and `remaining` is the number of rows left before that.
 */
export interface OlderPage {
  readonly before: number | null
  readonly remaining: number
  readonly loading: boolean
}

/** The MCP servers reported by the thread's last `session_started` (item 110). */
export interface ThreadMcp {
  readonly servers: readonly McpServerReport[]
  readonly gatewayConflict: boolean
}

/**
 * The sidebar mode (chapter 5: the left column switches modes, like Slack). `'schedule'` is the list of scheduled runs
 * (TODO 372, wave 20 bundle B. Editing is the main side's `ScheduleEditor`), and `extensions` is the extensions view (TODO 367, Cmd+Shift+X, VS Code's Extensions).
 */
export type SidebarMode = 'threads' | 'files' | 'search' | 'schedule' | 'extensions' | 'web' | 'plugin'

interface ThreadState {
  mode: SidebarMode
  /**
   * Whether the sidebar (`.sidebar-panel`) is collapsed (5.5.1, T27). **A value separate from the width**: even when collapsed
   * `aios.sidebarWidth` is kept, so opening it returns to the original width.
   * The icon bar (48px) stays even when collapsed, so there is a way back even if this is true.
   */
  sidebarCollapsed: boolean
  /**
   * The thread list (item 75). **Kept split into rows (`threadsById`) and order (`threadOrder`).**
   * main sends single-row updates (`onItemChanged`) at high frequency, so with a single array
   * every row would be rebuilt on one change. Rows and order that did not change stay the same object
   * (`thread-index.ts`). Selectors should pull per row by `threadsById[id]`.
   */
  threadsById: Readonly<Record<string, ThreadSummary>>
  threadOrder: readonly string[]
  approvals: readonly ApprovalItem[]
  agent: AgentStatus | null
  settings: SessionSettings | null
  activeThreadId: string | null
  /**
   * Advances on every call to `selectThread` (item 212). **It advances even for a call where `activeThreadId` does not change**
   * (pressing the currently displayed thread again, or jumping to a conversation-search hit within the same thread). The settings editor
   * (`settingsEditorStore.ts`) cannot detect "was it selected again" from a change of
   * `activeThreadId` alone, so it watches this and closes.
   */
  selectionSeq: number
  /**
   * A mark that the selection of the "thread to open" at launch (`takeOpenRequest`: window restore, Drop on the Dock) is done (TODO 1186 review Y-1).
   * The side that shows a temporary view at launch (the automatic display of the change log) can show it only after the thread is restored and the viewer memory is applied
   * (`useViewerMemory` closes temporary views). True when the first fetch of `init` finishes.
   */
  initialOpenSettled: boolean
  /**
   * TODO 1265: a reminder's notification was clicked (`OpenRequest.scheduleJobId`). `scheduleStore.ts` watches this and opens that job's
   * editor (kept here because the open request arrives here, and `threadStore` must not import `scheduleStore`). `seq` makes a repeat click count.
   */
  scheduleOpenRequest: { readonly jobId: string; readonly seq: number } | null
  /** The highlight target when arriving from in-conversation search (6.1). */
  highlightEventId: string | null
  /**
   * A mark that the displayed thread's turn ended (TODO 464). **It advances only when a `result` arrives by push**
   * (not on timeline loading, "read more", or background threads). ThreadPane watches the change of `seq` and moves to
   * the head of the last answer (the decision of whether it was interrupted is ThreadPane's pure function).
   */
  turnEnded: TurnEnded | null
  /**
   * TODO 823: a mark that something was sent. It advances at the moment `send` empties the field (regardless of normal, reserved, interrupt, or `!`).
   * ThreadPane watches the change of `seq`, and if that thread is displayed, brings it to the bottom and restores the pinning.
   */
  sendScroll: { threadId: string; seq: number } | null
  /**
   * TODO 943: a provisional row for the message just sent (at most one per thread). Until main's `user_text` arrives,
   * ThreadPane shows it at the end of the timeline with the same look as the real one (`UserMessage`). **Held only by the renderer and not saved**
   * (constraints 9 / 10 and B-3 stay on the main side). Removed in the same update in which `user_text` arrives (so the replacement does not make the height jump).
   * Also removed when it was put in a reservation (`queued`) or the send failed (the text is put back in the field, TODO 750). The condition for showing is `optimisticText`.
   */
  pendingSends: Readonly<Record<string, PendingSend>>
  /**
   * The event list per thread. Folding is done on the drawing side (foldTimeline). **Deltas whose final version has arrived are not
   * left here** (item 88 / REVIEW D-1, `thread-events.ts`).
   */
  events: Record<string, readonly AiosEvent[]>
  /**
   * The rows of subagents (item 257). Per thread, the id of the parent's `Agent` call -> that child's rows.
   * **Not put in `events`**: even when child rows arrive, ThreadPane (the whole timeline) is not redrawn,
   * and only the block's component (`SubagentBlock`) is redrawn (item 88). The sorting is in `thread/subagent-blocks.ts`.
   */
  childEvents: Record<string, ChildBuckets>
  /** The position of "read more" (item 88). Only opened threads are present. */
  older: Record<string, OlderPage>
  /**
   * The "list of available commands" per thread (item 68). Taken from the payload of that thread's last `session_started`.
   * It is replaced only when a `session_started` arrives (unchanged on high-frequency pushes).
   */
  threadCommands: Record<string, readonly string[]>
  /**
   * The skill names per thread (TODO 564). Like `threadCommands`, taken from the last `session_started`.
   * Used only to put a "skill" badge in the Composer's `/` completion.
   */
  threadSkills: Record<string, readonly string[]>
  /** The skill names last reported by any thread (TODO 564). Used for the badge of a thread that has no session yet. */
  recentSkills: readonly string[] | null
  /**
   * The list of MCP servers per thread (item 110). Like `threadCommands`, taken from the last `session_started`
   * and replaced only when one arrives. Drawn by the badge in the ThreadPane heading (`McpBadge`).
   */
  threadMcp: Record<string, ThreadMcp>
  /**
   * The backend's feature table, model list, and command record (items 88 / 68). **Fetched once and kept**.
   * It is re-fetched only when the Adapter's state (`agent.onStatus`) changes and when `session_started`
   * may have changed the command record. It is not re-fetched when switching threads.
   */
  backends: readonly BackendChoice[] | null
  loaded: ReadonlySet<string>
  notPersisted: ReadonlySet<string>
  /** The send field's draft. Held so it does not disappear when switching threads. */
  drafts: Record<string, string>
  attachments: Record<string, readonly Attachment[]>
  /**
   * The selection range put back into the input field from a reservation (item 97). Attached ahead of the range currently selected in the viewer.
   * It disappears when sent or removed with the X.
   */
  heldSelections: Record<string, ViewerSelection>
  /**
   * The key (`selectionKey`, item 97) of a selection removed with the X / sent. The same selection is not attached
   * until the viewer selection is made again (so a sent selection does not keep being attached to the next message).
   */
  dismissedSelections: Record<string, string>
  sending: ReadonlySet<string>
  error: string | null
  /**
   * The list of deleted threads (item 191). Re-fetched when the "Deleted (N)" fold at the bottom of the sidebar is opened, and right after
   * a restore / delete. Deleted threads are not in `threadsChanged`, so this list is held separately.
   * A delete / restore in another window arrives as a whole via a dedicated push (`onDeletedChanged`, item 222).
   */
  deletedThreads: readonly DeletedThreadSummary[]

  init(): Promise<void>
  /** Releases the `init()` subscriptions (TODO 571, the cleanup of `App`'s `useEffect`). */
  dispose(): void
  /**
   * An icon was pressed. **Pressing the mode currently shown again collapses / opens it**, and
   * a different mode opens with that mode (decided by `pressMode`).
   */
  setMode(mode: SidebarMode): void
  /** The toggle for Cmd+B (menu). Does not change the mode. */
  toggleSidebar(): void
  /**
   * `keepMode: true` does not change the sidebar mode (for `jumpToEvent`, which opens from conversation search results. Briefly switching to `'threads'`
   * would unmount and remount SearchMode, re-running the full search and losing the focus of the search field).
   */
  selectThread(threadId: string, options?: { readonly keepMode?: boolean; readonly keepHighlight?: boolean }): Promise<void>
  /** "Read more" (item 88). Prepends the earlier page. Does nothing while loading or when 0 remain. */
  loadOlder(threadId: string): Promise<void>
  /** Re-fetches `backends` (item 88). The first time is from `init()`. */
  refreshBackends(): Promise<void>
  /** Jumps from a search result to the matching message (6.1). */
  jumpToEvent(threadId: string, eventId: string): Promise<void>
  /** From the create dialog (T5). A failure is put in `error`. Returns true on success. */
  /** `onCreated`: receives the id of the created thread before open (TODO 1142. Even if the selection moves during open, the created one can still be pointed to). */
  createThread(input: CreateThreadInput, onCreated?: (threadId: string) => void): Promise<boolean>
  /**
   * From a folder Drop (item 98). Main decides whether it is a folder and the count. A failure (two or more folders,
   * hitting an exclusion, etc.) is put in `error`. On success, opens the created thread and returns true.
   */
  createThreadFromDrop(
    uris: readonly string[],
    input?: Omit<CreateThreadInput, 'cwdUri' | 'scratch'>
  ): Promise<boolean>
  /**
   * Sends the contents of the input field. **If a response is in progress, main puts it in a reservation** (item 94). Either way the input field is emptied.
   * If `interrupt` is true it is an interrupt (Cmd+Enter): if a response is in progress, the current turn is interrupted and this is sent first.
   * If `shell` is true it is `!` in the input field (item 116): main runs it in the thread's cwd and mixes the result into the next
   * message. Attachments and the selection range are not sent and are kept (attached to the next message).
   */
  send(
    threadId: string,
    settings?: MessageSettings,
    interrupt?: boolean,
    selection?: ViewerSelection | null,
    shell?: boolean
  ): Promise<void>
  /**
   * The Compact button of the Context usage dialog (TODO 495). It only sends `/compact` to that thread -
   * it uses the same IPC as `send` (`window.aios.threads.send`), so **if a response is in progress, main puts it in a reservation**
   * (same behavior as item 94). It does not touch the input field's draft or attachments.
   */
  compact(threadId: string): Promise<void>
  /** The X on the selection-range chip (item 97). A put-back selection is discarded, and a viewer selection is not attached until it is selected again. */
  dismissSelection(threadId: string, selection: ViewerSelection): void
  /** Cancels a reservation (the chip's X, item 94). */
  cancelReservation(threadId: string, reservationId: string): Promise<void>
  /**
   * Puts a reservation back in the input field (the chip's pencil, item 94). It leaves the queue. If there is a half-written text,
   * the reservation's body goes first and the half-written text after it (neither is lost).
   */
  editReservation(threadId: string, reservationId: string): Promise<void>
  /**
   * Stop (the prompt box's stop button / Esc). Sends an interrupt to the current turn and **keeps the process** (items 96 / 161).
   * Only when the interrupt is not accepted or nothing is responding does main stop the whole process (SIGINT).
   * Different from an interrupting send (Cmd+Enter).
   */
  interrupt(threadId: string): Promise<void>
  /**
   * "Rewind to here" (item 113, 4.5.6). Has main create a new thread branched from the state just before the user's message `eventId`, and opens it.
   * If `files` is true the files are also rewound (called after the preview is accepted).
   * A failure is put in `error` and returns false. The original thread is untouched.
   */
  rewind(threadId: string, eventId: string, files: boolean): Promise<boolean>
  /**
   * "Lighten and continue in a new conversation" (TODO 961). Has main create a new thread and opens it, moving the original thread's draft over
   * (main attaches the handoff text to the first send). A failure is put in `error` and returns false. The original thread is untouched.
   */
  handoff(threadId: string): Promise<boolean>
  /**
   * A model of another backend was chosen in the Model picker (TODO 1018). If main switched it in place, nothing is done (it arrives as a list diff);
   * if it branched, the draft being typed is moved and the new thread is opened (same as `handoff`).
   */
  switchBackend(threadId: string, backend: string, modelId: string | null): Promise<boolean>
  /**
   * Deletes a thread (T19). If the scratch area has contents and `force` is absent, main deletes nothing and returns
   * `removed: false`, so the caller shows a confirmation and calls again with `force: true`.
   */
  removeThread(threadId: string, force?: boolean): Promise<ThreadRemoveResult>
  renameThread(threadId: string, title: string): Promise<void>
  /**
   * The Sidebar right-click "Mark as unread" / "Mark as read" (TODO 741). main's single-row delivery
   * (`threads.push`) fixes the list row, so this just calls without waiting.
   */
  setThreadUnread(threadId: string, unread: boolean): Promise<void>
  /** Re-fetches the deleted list (item 191). Called when the fold is opened and right after a restore / delete. */
  loadDeletedThreads(): Promise<void>
  /**
   * Restores a deleted thread (item 191). When main puts `deleted_at` back, it naturally returns to the normal list
   * (`onChanged`). Here it is only removed from the deleted list immediately.
   * False if it was no longer deleted (e.g. a double restore).
   */
  restoreThread(threadId: string): Promise<boolean>
  decide(id: string, decision: ApprovalDecision): Promise<void>
  /**
   * TODO 906 (continuation of 823): sets only the "it was sent" mark (`sendScroll`). Used by send paths other than `send` (an answer to a question,
   * approving a plan and instructions to revise it, /compact, resume), and ThreadPane brings it to the bottom.
   */
  markSendScroll(threadId: string): void
  setDraft(threadId: string, text: string): void
  /**
   * Adds a file to the attachments. If outside the reference scope, `{ ok: true, outside: uri }` (the band asks for permission).
   * If it could not be attached, `{ ok: false, reason }` - the reason is shown by the caller (`attachUris`) in the band above the Composer
   * (TODO 489. It used to be shown in `error` at the top of the window).
   */
  addAttachment(threadId: string, uri: string): Promise<AttachOutcome>
  removeAttachment(threadId: string, uri: string): void
  /**
   * Adds a clipboard image (one with no path) to the attachments (item 319, wave 17 bundle F). main reads it with
   * electron's `clipboard.read()`. `nameFor(n)` builds the sequential display name (`paste.imageName`, the extension is
   * added).
   * A failure (empty, too large) puts a reason code in `error`. Returns true if added.
   */
  /** If `capture` is passed, it takes a part of the screen instead of the clipboard (TODO 957, `keepWindows` is Option). */
  addPastedImage(
    threadId: string,
    nameFor: (n: number) => string,
    capture?: { readonly keepWindows: boolean }
  ): Promise<boolean>
  /**
   * Adds a folder to the reference scope (4.4 / 4.5). If refused, returns the reason (a reason code or the choke point's sentence), and null if allowed.
   * It is not shown in the band at the top of the window (`error`); the caller (the Composer's attachment band) shows it in the band (TODO 600).
   */
  allowDir(threadId: string, dirUri: string): Promise<string | null>
  setSettings(patch: Partial<SessionSettings>): Promise<void>
  clearError(): void
  // wave 14 bundle F (item 194)
  /**
   * From "New" in the cwd-order heading. Without a dialog, it creates immediately with that group's cwd (a new scratch area for no-folder) and
   * the default from settings (concrete values), selects it, and moves focus to the prompt box. Returns true on success.
   */
  createThreadInFolder(uri: string | null): Promise<boolean>
  /** The thread that should get focus moved to the prompt box (item 194). The Composer resets it to null when it takes it. */
  composerFocus: string | null
  takeComposerFocus(threadId: string): boolean
  /**
   * TODO 1267: "start dictation in this thread's Composer" from the dictation hotkey. `takeDictateRequest` consumes it (true once) only while it is
   * fresh, so a request that nobody consumed (no microphone button) cannot fire later when the thread is opened.
   */
  dictateRequest: { threadId: string; at: number } | null
  takeDictateRequest(threadId: string): boolean
}

/** TODO 1267: how long a dictation request from the hotkey stays valid while waiting for the Composer to mount. */
export const DICTATE_REQUEST_FRESH_MS = 10_000

/** TODO 943: the provisional message row. `token` advances on every send (so the result of an old send does not remove a new provisional row). */
export interface PendingSend {
  readonly text: string
  readonly token: number
}

/**
 * TODO 943: whether to show the sent text as a provisional message. Shown only for a send where main sends it on the spot (not put in a reservation) and
 * it is known that the body of the `user_text` it records will be exactly the typed text:
 *
 * - `!` (item 116) becomes a `shell_run` row, not a message, so it is not shown.
 * - Attachments and selection ranges (item 97): main's `composeText` adds paths relative to the cwd and heading lines, so the renderer
 *   cannot build the same body (the replacement would change the height). Not shown (it waits for `user_text` as before).
 * - If a response is in progress (`running` / `awaiting-approval`) or a reservation remains, main puts it in a reservation and shows it as a chip (item 94).
 *   It is not shown to avoid showing it twice. If it is misjudged and `queued` is returned, it is removed at that point.
 *
 * null if not shown.
 */
export function optimisticText(input: {
  readonly text: string
  readonly shell: boolean
  readonly attachments: number
  readonly selection: boolean
  readonly state: string | undefined
  readonly reservations: number
}): string | null {
  if (input.shell || input.attachments > 0 || input.selection) return null
  if (input.text.trim() === '') return null
  if (input.state === 'running' || input.state === 'awaiting-approval') return null
  if (input.reservations > 0) return null
  return input.text
}

/** TODO 943: how long until the provisional row is taken down when `sent` returned but `user_text` never arrived (a missed event). */
const PENDING_SEND_FALLBACK_MS = 15_000

let pendingSendToken = 0

/** TODO 943: returns `pendingSends` with the provisional row of `token` removed if it is still there (the same object if not). */
function withoutPending(
  pending: Readonly<Record<string, PendingSend>>,
  threadId: string,
  token: number | null
): Readonly<Record<string, PendingSend>> {
  const current = pending[threadId]
  if (current === undefined || (token !== null && current.token !== token)) return pending
  const next = { ...pending }
  delete next[threadId]
  return next
}

/** The result of `addAttachment` (TODO 489). `outside` is a URI that was outside the reference scope (shown in the permission band). */
export type AttachOutcome =
  | { readonly ok: true; readonly outside: string | null }
  | { readonly ok: false; readonly reason: string }

/** The last number of pasted images per thread (item 319). Used only for the sequence number in the display name. */
const pasteSeq = new Map<string, number>()

/** The number of `jumpToEvent` (TODO 498). Jumping again advances it and stops loading earlier pages for the previous destination. */
let jumpSeq = 0

/**
 * The `init()` subscriptions (TODO 571). In a StrictMode dev build `init()` runs twice, and with two sets of subscriptions
 * one push ran `appendEvents` twice and answers looked doubled (unlike `mergeLoaded`, it does not drop by id).
 */
const subscriptions = createSubscriptionSlot()

/**
 * Threads that `selectThread` is reading from the DB (TODO 570). Rows that arrive meanwhile are kept even if not yet in `loaded`
 * (`mergeLoaded` mixes them into the loaded list). Held as a count for when the same thread is opened repeatedly.
 */
const opening = new Map<string, number>()

const NO_LIVE: readonly AiosEvent[] = []

export const useThreads = create<ThreadState>((set, get) => {
  /** Opens a just-created thread as "loaded (empty)" (shared by create and Drop). */
  const adoptCreated = async (threadId: string): Promise<void> => {
    set((state) => {
      const loaded = new Set(state.loaded)
      loaded.add(threadId)
      return { loaded, events: { ...state.events, [threadId]: [] } }
    })
    await get().selectThread(threadId)
  }

  /**
   * Opens a created thread (shared by create, Drop, and rewind). A thread with past content (item 139) is not made
   * "empty"; like an existing thread, its timeline is read with `selectThread`.
   */
  const openCreated = async (thread: Thread): Promise<void> => {
    if (createdWithHistory(thread)) await get().selectThread(thread.id)
    else await adoptCreated(thread.id)
  }

  /** Opens a thread created by a handoff (TODO 961 / 1018). The draft being typed is moved to the new thread (the new conversation is the side that sends). */
  const adoptHandoff = async (fromId: string, thread: Thread): Promise<void> => {
    const draft = get().drafts[fromId] ?? ''
    if (draft !== '') {
      set((state) => ({ drafts: { ...state.drafts, [fromId]: '', [thread.id]: draft } }))
    }
    await openCreated(thread)
  }

  /**
   * Takes the "thread to open" that main left with this window (the Dock Drop of item 98 (c), the window restore at launch of
   * item 36). A just-created thread (`created`) may arrive before the list delivery,
   * so it is made empty with `adoptCreated` before selecting. An existing thread is selected as is
   * (its timeline is read).
   */
  const takeOpenRequest = async (): Promise<void> => {
    const request = await window.aios.threads.takeOpenRequest()
    if (request === null) return
    if ('threadId' in request) {
      if (request.created === true) await adoptCreated(request.threadId)
      else await get().selectThread(request.threadId)
      if (request.notice !== undefined) set({ error: request.notice })
      // `aios://new` (TODO 976 stage 3): the body and attachments are only placed, not sent. Attachments go the same way as Drop (a failure shows in the band).
      if (request.draft !== undefined && request.draft !== '') get().setDraft(request.threadId, request.draft)
      if (request.attach !== undefined && request.attach.length > 0) await attachUris(request.threadId, request.attach)
      if (request.dictate === true) set({ composerFocus: request.threadId, dictateRequest: { threadId: request.threadId, at: Date.now() } })
    } else if ('scheduleJobId' in request) {
      // TODO 1265: open the scheduled-run view (expanded) and let `scheduleStore` open the job's editor.
      saveSidebarCollapsed(false)
      set({
        mode: 'schedule',
        sidebarCollapsed: false,
        scheduleOpenRequest: { jobId: request.scheduleJobId, seq: (get().scheduleOpenRequest?.seq ?? 0) + 1 }
      })
    } else set({ error: request.reason })
  }

  return {
  mode: 'threads',
  // Carry over whether it was collapsed last time in this window. If it cannot be read, "open".
  sidebarCollapsed: loadSidebarCollapsed(),
  threadsById: EMPTY_THREAD_INDEX.byId,
  threadOrder: EMPTY_THREAD_INDEX.order,
  approvals: [],
  agent: null,
  settings: null,
  activeThreadId: null,
  selectionSeq: 0,
  initialOpenSettled: false,
  scheduleOpenRequest: null,
  highlightEventId: null,
  turnEnded: null,
  sendScroll: null,
  pendingSends: {},
  events: {},
  childEvents: {},
  older: {},
  threadCommands: {},
  threadSkills: {},
  recentSkills: null,
  threadMcp: {},
  backends: null,
  loaded: new Set<string>(),
  notPersisted: new Set<string>(),
  drafts: {},
  attachments: {},
  heldSelections: {},
  dismissedSelections: {},
  sending: new Set<string>(),
  error: null,
  deletedThreads: [],

  async init(): Promise<void> {
    const token = subscriptions.begin()
    const [threads, approvals, agent, settings] = await Promise.all([
      window.aios.threads.list(),
      window.aios.approvals.list(),
      window.aios.agent.status(),
      window.aios.agent.getSettings()
    ])
    const initial = indexFromList(threads)
    set({ threadsById: initial.byId, threadOrder: initial.order, approvals, agent, settings })

    // If a later init (the second one in StrictMode) or a dispose has come, that one does the subscribing and fetching of the handed-over items.
    if (!subscriptions.claim(token)) return
    const keep = (unsubscribe: unknown): void => subscriptions.add(unsubscribe)
    keep(window.aios.threads.onChanged((next) =>
      set((state) => {
        const index = indexFromList(next, { byId: state.threadsById, order: state.threadOrder })
        return { threadsById: index.byId, threadOrder: index.order }
      })
    ))
    keep(window.aios.threads.onItemChanged((summary) =>
      set((state) => {
        const index = applyThreadChange({ byId: state.threadsById, order: state.threadOrder }, summary)
        // If nothing changed, return the state as is (do not notify subscribers).
        if (index.byId === state.threadsById && index.order === state.threadOrder) return state
        return { threadsById: index.byId, threadOrder: index.order }
      })
    ))
    keep(window.aios.approvals.onChanged((next) => set({ approvals: next })))
    // Item 222: a delete / restore in another window is also aligned with this window's "Deleted (N)" fold.
    keep(window.aios.threads.onDeletedChanged((next) => set({ deletedThreads: next })))
    keep(window.aios.agent.onStatus((next) => {
      set({ agent: next })
      // The Adapter's state (login, feature table) changed. Re-fetch the Composer's options (item 88).
      void get().refreshBackends()
    }))
    keep(window.aios.threads.onEvents((batch) => {
      // One batch = one update. Sort by thread, then `set` just once.
      const grouped = new Map<string, AiosEvent[]>()
      for (const event of batch.events) {
        const bucket = grouped.get(event.threadId)
        if (bucket === undefined) grouped.set(event.threadId, [event])
        else bucket.push(event)
      }
      if (grouped.size === 0) return
      // Item 277: the model did a push / merge / commit. If it is the displayed thread, re-fetch the BottomBar's git summary.
      // TODO 699: a change in another working copy (a child's commit running in a worktree, `elsewhere`) does not trigger a re-fetch.
      const active = get().activeThreadId
      if (active !== null && batch.events.some((e) => refreshesGitStatus(e, active))) {
        useGitStatus.getState().poke()
      }
      let commandsChanged = false
      set((state) => {
        const events = { ...state.events }
        let childEvents = state.childEvents
        let threadCommands = state.threadCommands
        let threadSkills = state.threadSkills
        let recentSkills = state.recentSkills
        let threadMcp = state.threadMcp
        let turnEnded = state.turnEnded
        let pendingSends = state.pendingSends
        const keep = {
          loaded: state.loaded,
          notPersisted: state.notPersisted,
          opening: new Set(opening.keys()),
          retentionOf: (id: string) => state.threadsById[id]?.thread.retention
        }
        for (const [threadId, batchList] of grouped) {
          // Item 257: child rows go to blocks. For a batch of only child rows, the parent's list keeps its reference.
          const buckets = childEvents[threadId] ?? NO_BUCKETS
          const split = splitChildEvents(batchList, buckets)
          const list = split.main
          // TODO 570: rows of a thread that is not open are not kept (read from the DB when opened). Used only for the decision below.
          if (keepsLiveEvents(threadId, keep)) {
            const nextBuckets = appendChildEvents(buckets, split.children)
            if (nextBuckets !== buckets) childEvents = { ...childEvents, [threadId]: nextBuckets }
            if (list.length > 0) events[threadId] = appendEvents(events[threadId] ?? [], list)
          } else {
            // TODO 1139: rows are not kept, but the in-flight deltas are, so that opening midway does not start mid-sentence.
            const before = events[threadId] ?? NO_LIVE
            const after = liveDeltasOnly(before, list)
            if (after !== before) {
              if (after.length === 0) delete events[threadId]
              else events[threadId] = after
            }
          }
          // TODO 464: the displayed thread's turn ended (the parent's `result`. Child rows are on the `split.children` side).
          turnEnded = nextTurnEnded(turnEnded, state.activeThreadId, threadId, list)
          // TODO 943: the real message arrived. The provisional row is removed in the same update (replaced in one draw).
          if (pendingSends[threadId] !== undefined && list.some((event) => event.kind === 'user_text')) {
            pendingSends = withoutPending(pendingSends, threadId, null)
          }
          // Item 68: when a session starts, replace that thread's list.
          const commands = lastCommands(list)
          if (commands !== undefined) {
            threadCommands = { ...threadCommands, [threadId]: commands }
            commandsChanged = true
          }
          // TODO 564: skill names are also replaced on the same trigger (the completion badge).
          const skills = lastSkills(list)
          if (skills !== undefined) {
            threadSkills = { ...threadSkills, [threadId]: skills }
            recentSkills = skills
          }
          // Item 110: the MCP server list is also replaced on the same trigger.
          const mcp = lastMcpServers(list)
          if (mcp !== undefined) threadMcp = { ...threadMcp, [threadId]: mcp }
        }
        return {
          events,
          ...(childEvents === state.childEvents ? {} : { childEvents }),
          ...(threadCommands === state.threadCommands ? {} : { threadCommands }),
          ...(threadSkills === state.threadSkills ? {} : { threadSkills, recentSkills }),
          ...(threadMcp === state.threadMcp ? {} : { threadMcp }),
          ...(turnEnded === state.turnEnded ? {} : { turnEnded }),
          ...(pendingSends === state.pendingSends ? {} : { pendingSends })
        }
      })
      // The backend's record has also been replaced on the main side (used to decide for a new thread).
      if (commandsChanged) void get().refreshBackends()
    }))
    void get().refreshBackends()
    // TODO 1138: a single-row delivery or approval request that came between fetching the first list and attaching the subscription had no receiver and was dropped.
    // Pull once more after subscribing to catch up (the list is idempotent. Even if a delivery after subscribing was applied first, the pulled value is main's current value).
    void (async () => {
      const [threads, approvals] = await Promise.all([window.aios.threads.list(), window.aios.approvals.list()])
      if (!subscriptions.isCurrent(token)) return
      set((state) => {
        const index = indexFromList(threads, { byId: state.threadsById, order: state.threadOrder })
        return { threadsById: index.byId, threadOrder: index.order, approvals }
      })
    })()
    // Item 98 (c) / 36: a thread created by a Dock Drop, and the thread of a window restored at launch.
    // **Fetch after subscribing** - in a window that has just opened, the signal may have flown before the subscription, and
    // what was handed over remains if we go and fetch it. A window with no record is handed nothing and selects nothing (item 80).
    keep(window.aios.threads.onOpenRequest(() => void takeOpenRequest()))
    set({ initialOpenSettled: false })
    const settle = (): void => set({ initialOpenSettled: true })
    void takeOpenRequest().then(settle, settle)

    // Item 80: merely opening a window selects nothing (decision 3 of item 71). If the first thread were
    // auto-selected, `threads.open` -> `openThread` -> `markRead` would run, and the moment a window is opened
    // from the Dock the unread mark would vanish (an accident). It starts with an empty ThreadPane, and only when the user
    // clicks / creates new / jumps from a search result (all via `selectThread`) is
    // `threads.open` called for the first time. The second window of Cmd+N also goes through the same `init()`, so it is
    // fixed automatically.
  },

  dispose(): void {
    subscriptions.dispose()
  },

  setMode(mode): void {
    const next = pressMode({ mode: get().mode, collapsed: get().sidebarCollapsed }, mode)
    saveSidebarCollapsed(next.collapsed)
    set({ mode: next.mode, sidebarCollapsed: next.collapsed })
  },

  toggleSidebar(): void {
    const next = toggleCollapsed({ mode: get().mode, collapsed: get().sidebarCollapsed })
    saveSidebarCollapsed(next.collapsed)
    set({ sidebarCollapsed: next.collapsed })
  },

  async jumpToEvent(threadId, eventId): Promise<void> {
    // The mode stays on search (so results can be followed one after another). ThreadPane looks at
    // highlightEventId, scrolls, and releases the highlight after a few seconds.
    set({ highlightEventId: eventId })
    // Take the number before the await (TODO 518-2). If taken after `selectThread`, a second call could happen before the first `selectThread` finishes,
    // and when the second `timeline` arrives later, the first would hold the latest number, keep reading earlier pages, and on arrival
    // re-attach the highlight to itself. In the current UI the search list is detached during the first `selectThread`, so it cannot be pressed
    // (proxy verification run 30), but keep the numbers advancing in call order.
    jumpSeq += 1
    const token = jumpSeq
    await get().selectThread(threadId, { keepMode: true, keepHighlight: true })
    // TODO 498: if the message is not loaded (before the first 2,000), read earlier pages until it arrives (the same `loadUntil` as in-thread search 496).
    // ThreadPane moves to it when the row for `highlightEventId` is drawn (it searches again each time pages increase).
    // Stop if we jumped elsewhere again (the number advanced) or opened another thread. `highlightEventId` is released by ThreadPane after 4 seconds, so
    // it is not used as a stop condition (loading one page for more than 4 seconds used to stop it midway - wave 25 code-review).
    // If the highlight was released by the time it arrives, re-attach it (ThreadPane moves to that row). If it did not arrive (a message that disappeared), nothing is moved to.
    const reached = await loadUntil(
      { getState: get },
      threadId,
      eventId,
      () => jumpSeq === token && get().activeThreadId === threadId
    )
    if (reached && jumpSeq === token && get().activeThreadId === threadId && get().highlightEventId !== eventId) {
      set({ highlightEventId: eventId })
    }
  },

  async selectThread(threadId, options): Promise<void> {
    set((state) => ({
      activeThreadId: threadId,
      ...(options?.keepMode === true ? {} : { mode: 'threads' as const }),
      // TODO 1140: the highlight from a conversation-search jump is cleared when moving to another thread (if left, following and the end-of-turn move stall for up to 4 seconds).
      ...(options?.keepHighlight !== true && state.activeThreadId !== threadId && state.highlightEventId !== null
        ? { highlightEventId: null }
        : {}),
      selectionSeq: state.selectionSeq + 1
    }))
    // TODO 570: rows that arrive during loading are kept (`mergeLoaded` mixes them in). The mark is removed after the load is reflected.
    opening.set(threadId, (opening.get(threadId) ?? 0) + 1)
    try {
      await window.aios.threads.open(threadId)
      if (get().loaded.has(threadId)) return
      const timeline = await window.aios.threads.timeline(threadId)
      set((state) => {
        // Do not drop what arrived while open (the ordering is `mergeLoaded`). Child rows (item 257) go to blocks.
        const split = splitChildEvents(timeline.events)
        const merged = mergeLoaded(split.main, state.events[threadId] ?? [])
        const buckets = mergeChildEvents(split.children, state.childEvents[threadId] ?? NO_BUCKETS)
        const loaded = new Set(state.loaded)
        loaded.add(threadId)
        const notPersisted = new Set(state.notPersisted)
        if (timeline.notPersisted) notPersisted.add(threadId)
        const commands = lastCommands(merged)
        const skills = lastSkills(merged)
        const mcp = lastMcpServers(merged)
        return {
          events: { ...state.events, [threadId]: merged },
          childEvents: { ...state.childEvents, [threadId]: buckets },
          older: {
            ...state.older,
            [threadId]: { before: timeline.oldestSeq, remaining: timeline.remaining, loading: false }
          },
          ...(commands === undefined || state.threadCommands[threadId] !== undefined
            ? {}
            : { threadCommands: { ...state.threadCommands, [threadId]: commands } }),
          ...(skills === undefined || state.threadSkills[threadId] !== undefined
            ? {}
            : { threadSkills: { ...state.threadSkills, [threadId]: skills } }),
          ...(mcp === undefined || state.threadMcp[threadId] !== undefined
            ? {}
            : { threadMcp: { ...state.threadMcp, [threadId]: mcp } }),
          loaded,
          notPersisted
        }
      })
    } finally {
      const left = (opening.get(threadId) ?? 1) - 1
      if (left > 0) opening.set(threadId, left)
      else opening.delete(threadId)
    }
  },

  async loadOlder(threadId): Promise<void> {
    const page = get().older[threadId]
    if (page === undefined || page.loading || page.before === null || page.remaining === 0) return
    const before = page.before
    set((state) => ({ older: { ...state.older, [threadId]: { ...page, loading: true } } }))
    try {
      const timeline = await window.aios.threads.timelineBefore(threadId, before)
      set((state) => {
        // Item 257: the child rows of the earlier page also go to blocks (prepended).
        const buckets = state.childEvents[threadId] ?? NO_BUCKETS
        const split = splitChildEvents(timeline.events, buckets)
        return {
          events: { ...state.events, [threadId]: prependOlder(state.events[threadId] ?? [], split.main) },
          childEvents: { ...state.childEvents, [threadId]: prependChildEvents(buckets, split.children) },
          older: {
            ...state.older,
            [threadId]: {
              // If the return is empty, we have reached the start (including the case where it was deleted meanwhile).
              before: timeline.oldestSeq,
              remaining: timeline.oldestSeq === null ? 0 : timeline.remaining,
              loading: false
            }
          }
        }
      })
    } catch (err) {
      set((state) => ({
        error: messageOf(err),
        older: { ...state.older, [threadId]: { ...page, loading: false } }
      }))
    }
  },

  async refreshBackends(): Promise<void> {
    try {
      const backends = await window.aios.threads.backends()
      set({ backends })
    } catch (err) {
      // Even if it cannot be fetched, the Composer just shows no options and sending still works.
      set({ error: messageOf(err) })
    }
  },

  async createThread(input, onCreated): Promise<boolean> {
    let thread
    try {
      thread = await window.aios.threads.create(input)
    } catch (err) {
      set({ error: messageOf(err) })
      return false
    }
    // Item 141: clear it so the band of a previous failure does not stay on after the next success.
    set({ error: null })
    onCreated?.(thread.id)
    await openCreated(thread)
    return true
  },

  async createThreadFromDrop(uris, input): Promise<boolean> {
    let thread
    try {
      thread = await window.aios.threads.createFromDrop(uris, input)
    } catch (err) {
      set({ error: messageOf(err) })
      return false
    }
    // Item 141: clear it so the band of a previous Drop failure does not stay on after the next Drop success.
    set({ error: null })
    await openCreated(thread)
    return true
  },

  async send(threadId, settings, interrupt = false, selection = null, shell = false): Promise<void> {
    const text = get().drafts[threadId] ?? ''
    const attachments = get().attachments[threadId] ?? []
    if (text.trim() === '' && attachments.length === 0 && selection === null) return
    // Do not send while sending. This prevents pressing Cmd+Enter twice from sending the same message twice (review B-2).
    if (get().sending.has(threadId)) return
    // TODO 943: the provisional message (whether to show it is `optimisticText`). Shown in the same update that empties the field.
    const summary = get().threadsById[threadId]
    const optimistic = optimisticText({
      text,
      shell,
      attachments: attachments.length,
      selection: selection !== null,
      state: summary?.runtime.state,
      reservations: summary?.runtime.reservations.length ?? 0
    })
    const pendingToken = optimistic === null ? null : (pendingSendToken += 1)
    // TODO 750: empty the field **right after** it is pressed (same as VS Code / the CLI). main's round trip (`refreshStatus` /
    // the first probe / spawn) can take several seconds, and before, text retyped and attachments added during that time
    // were wholly lost at the end of the round trip. On failure the catch below puts it back: if nothing was typed, the original text;
    // if something was typed, the original text is prepended (same shape as `editReservation`). `!` does not send attachments, so they are not touched.
    set((state) => {
      const sending = new Set(state.sending)
      sending.add(threadId)
      return {
        sending,
        error: null,
        drafts: { ...state.drafts, [threadId]: '' },
        sendScroll: { threadId, seq: (state.sendScroll?.seq ?? 0) + 1 },
        attachments: shell ? state.attachments : { ...state.attachments, [threadId]: [] },
        ...(optimistic === null || pendingToken === null
          ? {}
          : { pendingSends: { ...state.pendingSends, [threadId]: { text: optimistic, token: pendingToken } } })
      }
    })
    // TODO 750: for `!`, main's `submit` "puts it in a reservation if sending", so there is no reason to keep the renderer's `sending` set
    // until the command ends (main's limit is 120 seconds) - if left set, Enter is silently ignored for that
    // thread meanwhile. The result is seen in the timeline's `shell_run` row, so only here `sending` is lowered immediately
    // so later sends are not blocked (the failure band still shows from the catch below as before).
    if (shell) {
      set((state) => {
        const sending = new Set(state.sending)
        sending.delete(threadId)
        return { sending }
      })
    }
    try {
      // `!` (item 116) sends only the body. Attachments, the selection range, and model / thinking are kept for the next message.
      const input = shell
        ? { text, shell: true }
        : {
            text,
            // TODO 550: attach the reduced version to show in the timeline after sending (main keeps it only for images that have no file).
            attachments: await withThumbnails(attachments),
            ...(settings ?? {}),
            ...(selection === null ? {} : { selection })
          }
      const outcome = interrupt
        ? await window.aios.threads.sendInterrupt(threadId, input)
        : await window.aios.threads.send(threadId, input)
      if (pendingToken !== null) {
        // Put in a reservation: the chip shows it, so the provisional row is removed (not shown twice). Sent on the spot: if `user_text`
        // arrives, onEvents removes it. Only when it did not arrive, remove it after a while.
        if (outcome?.kind === 'queued') {
          set((state) => ({ pendingSends: withoutPending(state.pendingSends, threadId, pendingToken) }))
        } else {
          setTimeout(() => {
            set((state) => {
              const pendingSends = withoutPending(state.pendingSends, threadId, pendingToken)
              return pendingSends === state.pendingSends ? state : { pendingSends }
            })
          }, PENDING_SEND_FALLBACK_MS)
        }
      }
      if (shell) return
      set((state) => {
        const heldSelections = { ...state.heldSelections }
        delete heldSelections[threadId]
        return {
          heldSelections,
          // A sent selection is not attached to the next message until it is selected again (item 97).
          dismissedSelections:
            selection === null
              ? state.dismissedSelections
              : { ...state.dismissedSelections, [threadId]: selectionKey(selection) }
        }
      })
    } catch (err) {
      set((state) => {
        const draft = state.drafts[threadId] ?? ''
        const restoredText = draft.trim() === '' ? text : `${text}\n${draft}`
        if (shell) return { error: messageOf(err), drafts: { ...state.drafts, [threadId]: restoredText } }
        const current = state.attachments[threadId] ?? []
        const extra = attachments.filter((a) => !current.some((c) => c.uri === a.uri))
        return {
          error: messageOf(err),
          drafts: { ...state.drafts, [threadId]: restoredText },
          attachments: { ...state.attachments, [threadId]: [...extra, ...current] },
          // TODO 943: the provisional row of a message that could not be sent is removed (the text was put back in the field).
          pendingSends: withoutPending(state.pendingSends, threadId, pendingToken ?? -1)
        }
      })
    } finally {
      if (!shell) {
        set((state) => {
          const sending = new Set(state.sending)
          sending.delete(threadId)
          return { sending }
        })
      }
    }
  },

  markSendScroll(threadId): void {
    set((state) => ({ sendScroll: { threadId, seq: (state.sendScroll?.seq ?? 0) + 1 } }))
  },

  async compact(threadId): Promise<void> {
    get().markSendScroll(threadId)
    try {
      await window.aios.threads.send(threadId, { text: '/compact' })
    } catch (err) {
      set({ error: messageOf(err) })
    }
  },

  async cancelReservation(threadId, reservationId): Promise<void> {
    try {
      await window.aios.threads.cancelReservation(threadId, reservationId)
    } catch (err) {
      set({ error: messageOf(err) })
    }
  },

  async editReservation(threadId, reservationId): Promise<void> {
    let input
    try {
      input = await window.aios.threads.takeReservation(threadId, reservationId)
    } catch (err) {
      set({ error: messageOf(err) })
      return
    }
    // It was already sent (a race). Do nothing - the sent message is in the timeline.
    if (input === null) return
    set((state) => {
      const draft = state.drafts[threadId] ?? ''
      const current = state.attachments[threadId] ?? []
      const extra = (input.attachments ?? []).filter((a) => !current.some((c) => c.uri === a.uri))
      return {
        drafts: {
          ...state.drafts,
          [threadId]: draft.trim() === '' ? input.text : `${input.text}\n${draft}`
        },
        attachments: { ...state.attachments, [threadId]: [...extra, ...current] },
        // The selection attached to the reservation is also put back (item 97). It is attached ahead of the viewer's selection.
        heldSelections:
          input.selection === undefined
            ? state.heldSelections
            : { ...state.heldSelections, [threadId]: input.selection }
      }
    })
  },

  dismissSelection(threadId, selection): void {
    set((state) => {
      if (state.heldSelections[threadId] === selection) {
        const heldSelections = { ...state.heldSelections }
        delete heldSelections[threadId]
        return { heldSelections }
      }
      return {
        dismissedSelections: { ...state.dismissedSelections, [threadId]: selectionKey(selection) }
      }
    })
  },

  async interrupt(threadId): Promise<void> {
    await window.aios.threads.interrupt(threadId)
  },

  async rewind(threadId, eventId, files): Promise<boolean> {
    let thread
    try {
      thread = await window.aios.threads.rewind(threadId, eventId, { files })
    } catch (err) {
      set({ error: messageOf(err) })
      return false
    }
    await openCreated(thread)
    return true
  },

  async handoff(threadId): Promise<boolean> {
    let thread
    try {
      thread = await window.aios.threads.handoff(threadId)
    } catch (err) {
      set({ error: messageOf(err) })
      return false
    }
    await adoptHandoff(threadId, thread)
    return true
  },

  async switchBackend(threadId, backend, modelId): Promise<boolean> {
    let thread
    try {
      thread = await window.aios.threads.switchBackend(threadId, backend, modelId)
    } catch (err) {
      set({ error: messageOf(err) })
      return false
    }
    // Switched in place (a thread that has not sent yet): the row arrives in the list diff (`onChanged`), and the Composer switches accordingly.
    if (thread.id !== threadId) await adoptHandoff(threadId, thread)
    return true
  },

  async removeThread(threadId, force = false): Promise<ThreadRemoveResult> {
    let result: ThreadRemoveResult
    try {
      result = await window.aios.threads.remove(threadId, { force })
    } catch (err) {
      // TODO 577: if it throws, show it in the band (do not make it an unhandled rejection). `removed: false` with 0 items
      // is not "awaiting confirmation" (main always deletes when there are 0 items), so the caller shows no confirmation.
      set({ error: messageOf(err) })
      return { removed: false, scratchEntries: 0 }
    }
    if (!result.removed) return result
    set((state) => {
      const events = { ...state.events }
      delete events[threadId]
      const childEvents = { ...state.childEvents }
      delete childEvents[threadId]
      const older = { ...state.older }
      delete older[threadId]
      const loaded = new Set(state.loaded)
      loaded.delete(threadId)
      return {
        events,
        childEvents,
        older,
        loaded,
        activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId
      }
    })
    // Item 191: re-fetch the deleted list (the fold's N and contents). No new push is added -
    // deletion is not frequent, so this one round trip is enough.
    void get().loadDeletedThreads()
    return result
  },

  async renameThread(threadId, title): Promise<void> {
    await window.aios.threads.rename(threadId, title)
  },

  async setThreadUnread(threadId, unread): Promise<void> {
    await window.aios.threads.setUnread(threadId, unread)
  },

  async loadDeletedThreads(): Promise<void> {
    const deletedThreads = await window.aios.threads.listDeleted()
    set({ deletedThreads })
  },

  async restoreThread(threadId): Promise<boolean> {
    const restored = await window.aios.threads.restore(threadId)
    if (restored === null) return false
    set((state) => ({
      deletedThreads: state.deletedThreads.filter((entry) => entry.id !== threadId)
    }))
    return true
  },

  async decide(id, decision): Promise<void> {
    // TODO 906: a decision that becomes a user message (an answer to a question, text attached to a refusal, approving a plan) is treated the same as a send and
    // brought to the bottom. An ordinary tool allow / deny is not a message, so it does not move the reading position.
    const item = get().approvals.find((entry) => entry.id === id)
    if (item !== undefined && isSpokenDecision(item, decision)) get().markSendScroll(item.threadId)
    await window.aios.approvals.decide(id, decision)
  },

  setDraft(threadId, text): void {
    set((state) => ({ drafts: { ...state.drafts, [threadId]: text } }))
  },

  /** D&D / paste (4.5). If outside the reference scope, tells the caller. */
  async addAttachment(threadId, uri): Promise<AttachOutcome> {
    const result = await window.aios.threads.resolveAttachment(threadId, uri)
    if (!result.ok) return { ok: false, reason: result.reason }
    // TODO 591: remember as is the value where main decided "whether to keep it", and use it right before sending to decide whether to make the reduced version
    // (so the renderer does not needlessly make a reduced version for an image where main keeps only the path).
    const attachment = { ...result.attachment, keepsThumbnail: result.keepsThumbnail }
    set((state) => {
      const current = state.attachments[threadId] ?? []
      if (current.some((a) => a.uri === uri)) return {}
      return { attachments: { ...state.attachments, [threadId]: [...current, attachment] } }
    })
    return { ok: true, outside: result.outsideAllowed ? uri : null }
  },

  async addPastedImage(threadId, nameFor, capture): Promise<boolean> {
    const result =
      capture === undefined ? await window.aios.paste.image() : await window.aios.paste.capture(capture.keepWindows)
    if (!result.ok) {
      // Cancelling the capture (Esc) shows nothing (TODO 957).
      if (result.reason !== 'capture-cancelled') set({ error: result.reason })
      return false
    }
    set((state) => {
      const current = state.attachments[threadId] ?? []
      // The sequence continues only while chips of images pasted into that thread remain (it returns to 1 on send or removing all with X).
      // Removing one in the middle with X does not close up the numbers (so two chips with the same name are not side by side).
      const pasted = current.filter((a) => a.uri.startsWith(CLIPBOARD_ATTACHMENT_PREFIX))
      const n = pasted.length === 0 ? 1 : (pasteSeq.get(threadId) ?? pasted.length) + 1
      pasteSeq.set(threadId, n)
      // The extension stays as the type main read (`image.png` / `image.jpg` ...).
      const name = result.attachment.name
      const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
      const attachment = { ...result.attachment, name: `${nameFor(n)}${extension}` }
      return { attachments: { ...state.attachments, [threadId]: [...current, attachment] } }
    })
    return true
  },

  removeAttachment(threadId, uri): void {
    set((state) => ({
      attachments: {
        ...state.attachments,
        [threadId]: (state.attachments[threadId] ?? []).filter((a) => a.uri !== uri)
      }
    }))
  },

  async allowDir(threadId, dirUri): Promise<string | null> {
    try {
      await window.aios.threads.allowDir(threadId, dirUri)
      return null
    } catch (err) {
      return messageOf(err)
    }
  },

  async setSettings(patch): Promise<void> {
    const settings = await window.aios.agent.setSettings(patch)
    set({ settings })
  },

  clearError(): void {
    set({ error: null })
  },

  // wave 14 bundle F (item 194)
  composerFocus: null,

  async createThreadInFolder(uri): Promise<boolean> {
    if (get().backends === null) await get().refreshBackends()
    // The default backend is the head of main's list (`primary`). Same as the create dialog's fallback.
    const backend = get().backends?.[0]
    if (backend === undefined) return false
    // TODO 1142: focus goes to the thread that was created. Even if another row is selected during open, it is not given to that one.
    let createdId: string | null = null
    const ok = await get().createThread(folderCreateInput(uri, backend, get().settings), (id) => {
      createdId = id
    })
    if (ok && createdId !== null) set({ composerFocus: createdId })
    return ok
  },

  takeComposerFocus(threadId): boolean {
    if (get().composerFocus !== threadId) return false
    set({ composerFocus: null })
    return true
  },

  dictateRequest: null,

  takeDictateRequest(threadId): boolean {
    const request = get().dictateRequest
    if (request === null || request.threadId !== threadId) return false
    set({ dictateRequest: null })
    return Date.now() - request.at <= DICTATE_REQUEST_FRESH_MS
  }
  }
})

/**
 * Whether to re-fetch the displayed thread's BottomBar git summary on this event (item 277 / TODO 699).
 * When it is a version-control change notice, belongs to that thread, and is not a change in another working copy (`elsewhere`).
 */
export function refreshesGitStatus(event: AiosEvent, activeThreadId: string): boolean {
  return event.kind === 'vcs_state_changed' && event.threadId === activeThreadId && event.payload.elsewhere !== true
}

/**
 * TODO 906: whether this decision is the user's "message" (= whether to bring it to the bottom like a send). An answer to a question, text
 * attached to a refusal (e.g. "fix it"), and approving a plan are. An ordinary tool allow / deny, and a refusal without text, are not.
 */
export function isSpokenDecision(item: ApprovalItem, decision: ApprovalDecision): boolean {
  switch (decision.kind) {
    case 'answer':
      return true
    case 'deny':
      return (decision.message ?? '').trim() !== ''
    case 'allow':
    case 'allow-manual':
      return item.plan !== undefined && item.plan !== null
    default:
      return false
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    // An Error over IPC becomes "Error invoking remote method '...': Error: body".
    const match = /Error:\s*(.*)$/.exec(err.message)
    return match?.[1]?.trim() ?? err.message
  }
  return String(err)
}
