/**
 * The window set and the memory of window positions (ARCHITECTURE.md chapter 3 "1 profile + multiple windows",
 * 12.6 / TODO 26 / T21).
 *
 * aios is **1 profile = 1 process = multiple windows** (the same shape as Chrome).
 * It is not designed to open the same userData from 2 processes - the DB would hit `SQLITE_BUSY`, and
 * "the only writer of the index is IndexService" (6.2) and "nobody writes after the DB is closed" (12.9) hold
 * only within one process. A second launch makes the existing process open one window via `second-instance`.
 *
 * This file holds **only the parts that do not depend on electron** (managing the set, validating and
 * choosing bounds, reclaiming `SingletonLock`). Touching `BrowserWindow` / `screen` / `Menu` is done in
 * `index.ts` and `menu.ts`, which cannot be tested.
 */
import { log } from '../common/logger.js'
import {
  MAX_REMEMBERED_BOUNDS,
  MAX_RESTORED_WINDOWS,
  WINDOW_BOUNDS,
  isStoredWindowBounds,
  parseStoredBoundsList,
  type StoredWindowBounds,
  type StoredWindowState
} from '../common/settings-keys.js'

/**
 * The `app_settings` key. Holds the positions of windows in the order closed, and the windows that were open at the previous quit (item 36), as
 * JSON of `StoredWindowState[]`. **The key string exists only in `src/common/settings-keys.ts`** (TODO 85) - this is a re-export
 * for compatibility with existing callers (including tests).
 */
export const SETTING_WINDOW_BOUNDS = WINDOW_BOUNDS.key
export { MAX_REMEMBERED_BOUNDS, MAX_RESTORED_WINDOWS }

/** The default size of a new window. The `BrowserWindow` creation in `index.ts` uses this too. */
export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 } as const
/** No window smaller than this is created (it is also the lower bound for a broken stored value). */
export const MIN_WINDOW_SIZE = { width: 860, height: 520 } as const

/** The amount to shift (px) when a window is already at the same position. */
export const CASCADE_STEP = 28
/** The minimum area ratio at which a window counts as on screen. */
export const VISIBLE_RATIO = 0.5
/** Whether enough width remains on screen to grab the title bar. */
export const TITLE_GRAB_PX = 120

/**
 * An alias of `StoredWindowBounds` in `settings-keys.ts`. The validation logic can only live in
 * `common/` (the P1 boundary), so that became the definition site (TODO 85).
 */
export type WindowBounds = StoredWindowBounds

/** One element of `window.bounds` (the position of a closed window, or a window to bring back on the next launch. Item 36). */
export type WindowState = StoredWindowState

/** Only the part of `Display.workArea` used here. */
export type DisplayArea = WindowBounds

/**
 * The set of live windows. It does not hold `BrowserWindow` directly; "is it alive" is received by
 * injection, so it is testable. **Dead elements are dropped on every enumeration** - so that even if a `closed`
 * is missed, no destroyed window remains as a push target
 * (a destroyed `BrowserWindow` throws on just touching `.webContents`).
 */
export class WindowSet<T> {
  private readonly items = new Set<T>()

  constructor(private readonly alive: (item: T) => boolean) {}

  add(item: T): void {
    this.items.add(item)
  }

  delete(item: T): void {
    this.items.delete(item)
  }

  has(item: T): boolean {
    return this.items.has(item) && this.alive(item)
  }

  /** In the order added. Dead ones are removed here. */
  list(): readonly T[] {
    const live: T[] = []
    for (const item of this.items) {
      if (this.alive(item)) live.push(item)
      else this.items.delete(item)
    }
    return live
  }

  get size(): number {
    return this.list().length
  }

  clear(): void {
    this.items.clear()
  }
}

/**
 * Whether a value passes as `WindowBounds` (validation before rounding to integers), and the conversion of a stored value into
 * `WindowBounds[]` (broken elements are silently dropped). **The implementation is only in
 * `src/common/settings-keys.ts`** (TODO 85, the P1 boundary).
 */
export const isWindowBounds = isStoredWindowBounds
export const parseBoundsList = parseStoredBoundsList

function overlapArea(a: WindowBounds, b: DisplayArea): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

/**
 * Whether it is on screen. Prevents a window from appearing where it cannot be seen with a stored value from before a display was removed.
 *
 * Three conditions: (1) it meets the minimum size, (2) at least half of its area is
 * on screen counting all screens together, (3) **the title bar can be grabbed** - the top edge is inside the work area of some screen,
 * and at least `TITLE_GRAB_PX` remains horizontally. Without (3), a "window hidden above that cannot be moved"
 * could be restored.
 */
export function isOnScreen(bounds: WindowBounds, displays: readonly DisplayArea[]): boolean {
  if (!isWindowBounds(bounds)) return false
  if (bounds.width < MIN_WINDOW_SIZE.width || bounds.height < MIN_WINDOW_SIZE.height) return false
  if (displays.length === 0) return false
  const area = bounds.width * bounds.height
  let covered = 0
  for (const display of displays) covered += overlapArea(bounds, display)
  if (covered / area < VISIBLE_RATIO) return false
  return displays.some(
    (display) =>
      bounds.y >= display.y &&
      bounds.y < display.y + display.height &&
      bounds.x + bounds.width >= display.x + TITLE_GRAB_PX &&
      bounds.x <= display.x + display.width - TITLE_GRAB_PX
  )
}

function sameSpot(a: WindowBounds, b: WindowBounds): boolean {
  return Math.abs(a.x - b.x) < CASCADE_STEP && Math.abs(a.y - b.y) < CASCADE_STEP
}

/**
 * The position when opening one window.
 *
 * 1. The first stored value that is **on screen and does not overlap a currently open window**.
 * 2. If none, shift `CASCADE_STEP` from the last opened window (give up if that goes off screen).
 * 3. If neither works, `null` = let electron place it in the center at the default size.
 */
export function chooseBounds(input: {
  readonly saved: readonly WindowBounds[]
  readonly open: readonly WindowBounds[]
  readonly displays: readonly DisplayArea[]
}): WindowBounds | null {
  const usable = input.saved.filter((bounds) => isOnScreen(bounds, input.displays))
  const free = usable.find((bounds) => !input.open.some((other) => sameSpot(bounds, other)))
  if (free !== undefined) return free

  const last = input.open.at(-1)
  if (last !== undefined) {
    const shifted = { ...last, x: last.x + CASCADE_STEP, y: last.y + CASCADE_STEP }
    if (isOnScreen(shifted, input.displays)) return shifted
    // When we reach the edge, go back to a stored value that is on screen (the default if none).
    return usable[0] ?? null
  }
  return usable[0] ?? null
}

/**
 * Remembers the position of a closed window. **The head is the last window closed**, and the first window on the next launch appears there.
 * Old records at almost the same position are folded away (so that merely opening and closing the same window does not fill the list).
 */
export function rememberBounds(
  saved: readonly WindowBounds[],
  bounds: WindowBounds,
  limit = MAX_REMEMBERED_BOUNDS
): readonly WindowBounds[] {
  if (!isWindowBounds(bounds)) return saved.slice(0, limit)
  const rounded = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
  const rest = saved.filter((other) => !sameSpot(other, rounded))
  return [rounded, ...rest].slice(0, Math.max(1, limit))
}

// ---- Restoring per-window state (item 36, ARCHITECTURE.md 3.1) ----

function roundBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}

/**
 * Only the **positions of closed windows** among the stored values (the rest, after removing the records of windows to bring back on the next launch).
 * This is the candidate for `chooseBounds` and the base of `rememberBounds` when a window is closed individually.
 * A window closed individually does not enter the restore record (as in T21, only the position remains).
 */
export function closedBounds(saved: readonly WindowState[]): readonly WindowBounds[] {
  return saved
    .filter((state) => state.restore !== true)
    .map((state) => roundBounds(state))
}

/** One window that was open at quit. */
export interface OpenWindowSnapshot {
  readonly bounds: WindowBounds
  /** The thread that window was showing (`ThreadViews`). Null if nothing was open. */
  readonly threadId: string | null
  /** Whether that window was in front (had focus). */
  readonly focused: boolean
  /**
   * Whether it was maximized by zoom (the green button) (item 197). **Fullscreen is not included here**
   * - the caller (`src/main/index.ts`) decides with `isMaximized() && !isFullScreen()` and passes it.
   * In both cases `bounds` is the frame before maximizing / fullscreen (`getNormalBounds()`).
   */
  readonly maximized: boolean
}

/**
 * The value written at quit (at the start of `before-quit`) (item 36).
 *
 * - Lines up the open windows at the head as elements with `restore: true`. The order is the order opened, and
 *   **the window that was in front goes last** - at launch windows are created in that order, so the last created window
 *   tends to end up in front (an approximation of wanting the window that was in front on top, as Chrome does).
 * - As in T21, the position is also added to the "positions of closed windows" (kept as a candidate for the next Cmd+N).
 * - If there are 0 windows there are no restore elements, and the next launch opens 1 window as before.
 * - A window with broken bounds is not restored (and not added to the position record either).
 */
export function snapshotSession(
  saved: readonly WindowState[],
  open: readonly OpenWindowSnapshot[]
): readonly WindowState[] {
  let closed = closedBounds(saved)
  for (const window of open) closed = rememberBounds(closed, window.bounds)
  const valid = open.filter((window) => isWindowBounds(window.bounds))
  const ordered = [
    ...valid.filter((window) => !window.focused),
    ...valid.filter((window) => window.focused)
  ].slice(-MAX_RESTORED_WINDOWS)
  const restore: WindowState[] = ordered.map((window) => {
    const base =
      window.threadId !== null && window.threadId.length > 0
        ? { ...roundBounds(window.bounds), restore: true as const, threadId: window.threadId }
        : { ...roundBounds(window.bounds), restore: true as const }
    return window.maximized ? { ...base, maximized: true } : base
  })
  return [...restore, ...closed]
}

/** One window to bring back at launch. */
export interface RestoreEntry {
  /** Show it at that position. Null if it is not on screen (= leave it to `chooseBounds`). */
  readonly bounds: WindowBounds | null
  /** The thread to have that window open. Null if there is no record or the thread is gone (select nothing). */
  readonly threadId: string | null
  /**
   * Whether to open it maximized (item 197). **Open at the normal frame (`bounds`) and then maximize**
   * - even if `bounds` is null (off screen), maximizing itself can be done (it just goes on top of the position `chooseBounds`
   * decided).
   */
  readonly maximized: boolean
}

/**
 * The restore plan at launch (item 36). Returns the elements of the stored value with `restore: true`, in order.
 * If empty, it means "no window at the previous quit / no record (including the old format)", and the caller
 * opens 1 window as before.
 *
 * - A position from after a display was removed is dropped with `isOnScreen` and becomes null (the default placement).
 * - The thread is checked with `threadExists` (deleted ones are false), and null if missing. **A window with no record
 *   selects nothing** (item 80: merely opening a window does not select the first one).
 */
export function planRestore(input: {
  readonly saved: readonly WindowState[]
  readonly displays: readonly DisplayArea[]
  readonly threadExists: (threadId: string) => boolean
}): readonly RestoreEntry[] {
  return input.saved
    .filter((state) => state.restore === true)
    .slice(0, MAX_RESTORED_WINDOWS)
    .map((state) => {
      const bounds = roundBounds(state)
      const threadId = state.threadId
      return {
        bounds: isOnScreen(bounds, input.displays) ? bounds : null,
        threadId: threadId !== undefined && input.threadExists(threadId) ? threadId : null,
        maximized: state.maximized === true
      }
    })
}

// ---- Reclaiming SingletonLock ("a restart right after killing can fail") ----

/** The files Chromium puts in userData for single-instance enforcement. */
export const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const

export type SingletonLockVerdict =
  | 'no-lock' /** There is no lock (= it could not be taken for some other reason) */
  | 'alive' /** The pid written is alive = a real second instance */
  | 'other-host' /** Held by another host (a network home) */
  | 'unparsable' /** An unreadable shape */
  | 'reclaimed' /** It was a dead pid, so it was removed */

/** The contents of `SingletonLock` (`<hostname>-<pid>`). The host name can contain `-` too. */
export function parseSingletonLock(target: string): { hostname: string; pid: number } | null {
  const cut = target.lastIndexOf('-')
  if (cut <= 0 || cut === target.length - 1) return null
  const hostname = target.slice(0, cut)
  const pid = Number(target.slice(cut + 1))
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  return { hostname, pid }
}

export interface SingletonLockIo {
  /** The contents of the symlink. Null if none. */
  readlink(path: string): string | null
  /** Removes it. Does nothing if absent. */
  unlink(path: string): void
  /** Whether that pid is alive (`kill(pid, 0)`). */
  isAlive(pid: number): boolean
  hostname(): string
}

/**
 * Called once when `requestSingleInstanceLock()` returns false.
 * Removes **only a lock that points at a dead pid**. If it is alive it is a real second instance, so it is left alone.
 *
 * On macOS too Chromium's ProcessSingletonPosix is used, and `SingletonLock` is a symlink pointing at
 * `<hostname>-<pid>`. This is why a restart right after killing is treated as a "second instance" and
 * immediately does `app.quit()`.
 */
export function reclaimStaleSingletonLock(
  files: readonly string[],
  io: SingletonLockIo
): SingletonLockVerdict {
  const lock = files[0]
  if (lock === undefined) return 'no-lock'
  const target = io.readlink(lock)
  if (target === null) return 'no-lock'
  const parsed = parseSingletonLock(target)
  if (parsed === null) return 'unparsable'
  if (parsed.hostname !== io.hostname()) return 'other-host'
  if (io.isAlive(parsed.pid)) return 'alive'
  for (const file of files) io.unlink(file)
  log.warn('app.singleton.reclaimed', { pid: parsed.pid })
  return 'reclaimed'
}

/**
 * The "thread being shown" per window (TODO 71 / ARCHITECTURE.md 3.1 / 4.3).
 *
 * Whether to set the unread check mark depends on "**is it visible to someone right now**". Before, main remembered
 * only the one thread opened last (`activeThreadId`), it did not go away when a window closed,
 * and it could hold only one even with multiple windows. Here each window (keyed by `webContents.id`) holds its
 * own shown thread, and it is removed on the window's `closed`.
 *
 * "Visible" = shown in some window **and that window is in front (has focus)**.
 * While the app is in the background, a shown thread is still marked unread (like Slack). Whether it is in front is received
 * by injecting `BrowserWindow.isFocused()`, so it can be tested without electron.
 * An unread set while in the background is cleared by the caller with `focusedThread` when that window
 * regains focus.
 */
export class ThreadViews {
  private readonly views = new Map<number, string>()
  /** The window that last gained focus (a fix to TODO 1060: the runner-up of `primaryViewOf`). */
  private lastFocused: number | null = null

  constructor(private readonly focused: (viewId: number) => boolean = () => true) {}

  /** Window `viewId` showed `threadId` (null = showing nothing). */
  show(viewId: number, threadId: string | null): void {
    if (threadId === null) this.views.delete(viewId)
    else this.views.set(viewId, threadId)
  }

  /** The window closed (or reloaded and its display went away). */
  close(viewId: number): void {
    this.views.delete(viewId)
  }

  /** The thread is gone. Do not leave it as shown in any window. */
  forgetThread(threadId: string): void {
    for (const [viewId, shown] of this.views) {
      if (shown === threadId) this.views.delete(viewId)
    }
  }

  /** The thread window `viewId` is showing. */
  threadOf(viewId: number): string | null {
    return this.views.get(viewId) ?? null
  }

  /**
   * The windows showing `threadId` (item 97). Whether they are in front does not matter - the gateway's `openFile` also
   * opens in the ViewerPane of a background window (a different question from the unread decision).
   */
  viewsOf(threadId: string): number[] {
    const found: number[] = []
    for (const [viewId, shown] of this.views) if (shown === threadId) found.push(viewId)
    return found
  }

  /** Window `viewId` gained focus. */
  noteFocus(viewId: number): void {
    this.lastFocused = viewId
  }

  /**
   * One of the windows showing `threadId` (a fix to TODO 1060, so that `openSettings` sends to only one window):
   * the window in front now, else the window that last gained focus, else the first window. Null if none.
   */
  primaryViewOf(threadId: string): number | null {
    const views = this.viewsOf(threadId)
    return (
      views.find((viewId) => this.focused(viewId)) ??
      views.find((viewId) => viewId === this.lastFocused) ??
      views[0] ??
      null
    )
  }

  /** The thread shown per window (item 97, `listOpenFiles`). In the order the windows were opened. */
  entries(): [viewId: number, threadId: string][] {
    return [...this.views]
  }

  /** Whether it is shown in some front window. This is exactly the condition for not setting unread. */
  isSeen(threadId: string): boolean {
    for (const [viewId, shown] of this.views) {
      if (shown === threadId && this.focused(viewId)) return true
    }
    return false
  }
}
