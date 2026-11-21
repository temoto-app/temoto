/**
 * Key decisions for the prompt box (ARCHITECTURE.md 5.5, T16 / TODO 20).
 *
 * A lone Return sends, so the Enter that **confirms an IME conversion must be
 * told apart from the Enter that sends**. The decision is a pure function that depends on neither the DOM nor React
 * (`test/composer-keys.test.ts` guards against regressions), and the Composer only
 * calls `shouldSend(event.nativeEvent)`.
 *
 * There are two ways to recognize an IME confirmation, and **both are checked**:
 *
 * - `isComposing`: true for a key fired during composition. Chromium sets it.
 * - `keyCode === 229`: the historical value that stands for a key during composition. A safety net
 *   for implementations that do not set `isComposing` (old Safari / some IMEs); even when `key` is
 *   `'Enter'`, `keyCode` stays 229.
 *
 * If either is set it is a "conversion confirmation", so nothing is sent.
 */

/** Only the part of `KeyboardEvent` used for the decision. Tests can build it as a plain object. */
export interface ComposerKey {
  readonly key: string
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  /** Whether it fired during composition (IME). `KeyboardEvent.isComposing`. */
  readonly isComposing: boolean
  /** 229 during composition. A safety net for implementations that do not set `isComposing`. */
  readonly keyCode: number
}

/**
 * Whether this key sends.
 *
 * - Lone `Enter`: send
 * - `⌘Enter` / `Ctrl+Enter`: send (do not betray habits from before T16). While a response is running,
 *   `⌘Enter` (`Ctrl+Enter` outside mac) is an **interrupt**: `shouldInterrupt` (item 94)
 * - `Shift+Enter`: newline (left to the default behavior)
 * - `Alt+Enter`: newline (the option key is not assigned to send)
 * - `Enter` confirming a conversion: **do not send**
 */
export function shouldSend(event: ComposerKey): boolean {
  if (event.key !== 'Enter') return false
  // Conversion confirmation. `keyCode` is deprecated, but it is checked here on purpose for compatibility.
  if (event.isComposing || event.keyCode === 229) return false
  if (event.shiftKey) return false
  if (event.altKey) return false
  return true
}

/** The modifier-key convention. ⌘ on macOS, Ctrl elsewhere (item 94). */
export type KeyPlatform = 'mac' | 'other'

/** Decide the convention from a string such as `navigator.platform`. Empty or unknown is `other`. */
export function keyPlatformOf(platform: string): KeyPlatform {
  return /mac|iphone|ipad/i.test(platform) ? 'mac' : 'other'
}

/**
 * Whether this key does an **interrupting send** (item 94 / 4.5.4).
 *
 * By default Enter during a response is a **reservation** (sent after the current response ends), so even a mistaken press does not break the current
 * response. Add the modifier key only when you want to stop the current response and send right away:
 *
 * - macOS: `⌘Enter`. `Ctrl+Enter` stays a plain send (= a reservation if a response is running).
 * - Elsewhere: `Ctrl+Enter`.
 *
 * Keys that do not pass the send decision (`shouldSend`: conversion confirmation, Shift, Alt) are not interrupts either.
 * An interrupt when no response is running is the same as a plain send (main decides).
 */
export function shouldInterrupt(event: ComposerKey, platform: KeyPlatform): boolean {
  if (!shouldSend(event)) return false
  return platform === 'mac' ? event.metaKey : event.ctrlKey
}

/**
 * Whether this key toggles Plan mode (item 112 / 4.2.3). **`Shift+Tab` only** (the same keystroke as the CLI).
 *
 * - `Shift+Tab` during conversion (IME) yields to candidate handling.
 * - Keys with ⌘ / Ctrl / ⌥ are not taken (they are used to switch windows and tabs).
 * - A bare `Tab` is not taken (focus movement, slash completion).
 */
export function isPlanToggle(event: ComposerKey): boolean {
  if (event.key !== 'Tab' || !event.shiftKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  return !event.metaKey && !event.ctrlKey && !event.altKey
}

/**
 * Whether this key **stops the response** (item 161 / 4.5.4). A lone `Esc` only. The caller asks only when
 * the input box has focus and a response is running (an Esc with no response running does nothing).
 *
 * - **Esc during conversion (IME) is not taken**, since it cancels the conversion. It is detected the same way as `shouldSend`:
 *   both `isComposing` and `keyCode === 229` (T16).
 * - Keys with modifiers (⌘ / Ctrl / ⌥ / Shift) are not taken (they yield to window operations, leaving full screen, etc.).
 * - While a completion list (`/` / `@`) is open, the list's close handler takes Esc first (the order in the Composer).
 */
export function shouldStop(event: ComposerKey): boolean {
  if (event.key !== 'Escape') return false
  if (event.isComposing || event.keyCode === 229) return false
  return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
}
