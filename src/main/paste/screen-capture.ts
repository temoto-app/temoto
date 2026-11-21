/**
 * Captures part of the screen and attaches it (TODO 957). The body of the Composer's camera button and the shortcut (Ctrl+Shift+Cmd+5).
 *
 * - A small entry point that calls macOS's `screencapture -i` (range selection) with **fixed arguments and a fixed environment**. It is not general execution
 *   (the "execution capability principle" of constraint 8, in the same style as `runGit`). No renderer value enters the arguments.
 * - The captured image is written to **one file in a private temporary folder (0700)** and deleted right after reading (constraints 9 / 10 - kept
 *   nowhere). `-c` (clipboard) is not used, so as not to overwrite what the user had copied.
 * - Normally the aios window is hidden for the capture (usually other apps are what is captured). The window is always restored after the capture (even on Esc cancel or failure).
 *   `keepWindows: true` (while holding Opt) does not hide it - for the rare capture of aios itself.
 * - The shape is the same `Attachment` as a pasted image (`clipboard-image.ts`) (marker `aios-clipboard:`, with base64).
 * - **Screen recording permission (TCC)**: even the range-selecting `screencapture -i`, without permission, gives a result in which other apps' windows
 *   are not captured (only the wallpaper and its own window) and it is not an error - as of 2026-10-24 this is an **inference** from macOS's behavior and
 *   has not been confirmed on a real machine. So before capturing, if electron's `getMediaAccessStatus('screen')` is `denied` / `restricted`,
 *   it does not capture and returns guidance (`capture-permission`). `not-determined` captures (the OS asks at the first capture).
 * - **Never throws.** Failures are returned as reason codes. An Esc cancel is `capture-cancelled` (the renderer silently does nothing).
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorFields, log } from '../../common/logger.js'
import { CLIPBOARD_ATTACHMENT_PREFIX, type AttachmentResolution } from '@shared/thread.js'
import { sniffImageType } from './temp-image.js'
import { isMac } from '../../common/os/platform.js'
import { OS_MINIMAL_PATH, OS_TOOLS } from '../../common/os/tools.js'

/** The place fixed on macOS (PATH is not consulted). */
export const SCREENCAPTURE_PATH = OS_TOOLS.screencapture

/** `-i` range selection / `-x` no shutter sound / `-t png` / the file last. */
export const SCREENCAPTURE_ARGS: readonly string[] = ['-i', '-x', '-t', 'png']

/** Upper limit for waiting for the range selection. */
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000

/** The wait from hiding the window to starting the capture (so the hide animation is not captured). */
export const HIDE_SETTLE_MS = 250

export interface ScreenCaptureDeps {
  readonly platform: NodeJS.Platform
  /** The state of the screen recording permission (`systemPreferences.getMediaAccessStatus('screen')`). */
  readonly screenAccess: () => string
  /** Hides the aios window. The return value is a function that restores the window (must be called). */
  readonly hideWindows: () => () => void
  /** Runs `screencapture`. */
  readonly run: (file: string) => Promise<{ readonly spawnFailed: boolean }>
  readonly wait: (ms: number) => Promise<void>
}

export function execScreencapture(file: string): Promise<{ readonly spawnFailed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      SCREENCAPTURE_PATH,
      [...SCREENCAPTURE_ARGS, file],
      // The environment is fixed (the caller's PATH, DYLD_* and so on are not passed).
      { env: { PATH: OS_MINIMAL_PATH, LANG: 'C' }, timeout: CAPTURE_TIMEOUT_MS, windowsHide: true },
      (err) => {
        // Separate failures that come with an exit code (an Esc cancel is one of these) from failures to start (ENOENT, etc.).
        resolve({ spawnFailed: err !== null && typeof (err as NodeJS.ErrnoException).code === 'string' })
      }
    )
  })
}

/**
 * TODO 1064: whether to show the notice before the first capture. true only on macOS, when permission is not denied (if denied, the existing `capture-permission`
 * guidance comes first), and it has not been shown yet (the caller writes the "shown" marker). The capture is not stopped.
 */
export function shouldShowCaptureHeadsUp(platform: NodeJS.Platform, access: string, alreadyShown: boolean): boolean {
  if (!isMac(platform) || alreadyShown) return false
  return access !== 'denied' && access !== 'restricted'
}

/** The notice query (does not write) and the confirmation after showing (writes the "shown" marker). If there is no setting, it is not shown every time. */
export interface CaptureHeadsUpStore {
  readonly shown: () => boolean
  readonly markShown: () => void
}
export function createCaptureHeadsUp(
  store: CaptureHeadsUpStore | null,
  platform: NodeJS.Platform,
  access: () => string
): { query: () => boolean; confirm: () => void } {
  return {
    query: () => store !== null && shouldShowCaptureHeadsUp(platform, access(), store.shown()),
    // A query does not write, so that it is not used up by a failure before display or in the renderer (bundle X).
    confirm: () => store?.markShown()
  }
}

export async function captureScreenRegion(
  deps: ScreenCaptureDeps,
  options: { readonly keepWindows: boolean },
  maxBytes: number
): Promise<AttachmentResolution> {
  if (!isMac(deps.platform)) return { ok: false, reason: 'capture-unavailable' }
  const access = deps.screenAccess()
  if (access === 'denied' || access === 'restricted') return { ok: false, reason: 'capture-permission' }

  let dir: string | null = null
  let restore: (() => void) | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'aios-capture-'), { encoding: 'utf8' })
    const file = join(dir, 'capture.png')
    if (!options.keepWindows) {
      restore = deps.hideWindows()
      await deps.wait(HIDE_SETTLE_MS)
    }
    const { spawnFailed } = await deps.run(file)
    // Restore the window as soon as the capture ends (do not make it wait for loading the image).
    restore?.()
    restore = null
    if (spawnFailed) return { ok: false, reason: 'capture-failed' }

    let size = 0
    try {
      size = (await stat(file)).size
    } catch {
      return { ok: false, reason: 'capture-cancelled' }
    }
    if (size === 0) return { ok: false, reason: 'capture-cancelled' }
    if (size > maxBytes) return { ok: false, reason: 'paste-too-large' }
    const bytes = await readFile(file)
    if (sniffImageType(bytes.subarray(0, 16)) !== 'image/png') return { ok: false, reason: 'capture-failed' }
    return {
      ok: true,
      attachment: {
        uri: `${CLIPBOARD_ATTACHMENT_PREFIX}${randomUUID()}`,
        name: 'image.png',
        kind: 'image',
        mediaType: 'image/png',
        base64: bytes.toString('base64'),
        bytes: bytes.length
      },
      outsideAllowed: false,
      keepsThumbnail: true
    }
  } catch (err) {
    log.warn('capture.failed', errorFields(err))
    return { ok: false, reason: 'capture-failed' }
  } finally {
    restore?.()
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
