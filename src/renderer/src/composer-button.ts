/**
 * The button at the right end of the prompt box (items 154 / 161, ARCHITECTURE.md 4.5.4 / 5.5.5). Pure functions that depend on neither
 * the DOM nor React; `test/composer-button.test.ts` guards against regressions.
 *
 * Item 161 (follow the qlm spec) redecided the layout:
 *
 * - **There is one primary button, serving as both send and stop.** Normally it is up-arrow (send, accent fill); while a response is running it is
 *   a square (stop, danger fill). The button is not rebuilt; the shape is swapped in CSS, so the place to press does not move.
 * - **Stop can always be pressed.** Even with an empty input, and even mid-send (while a reservation is handed over via IPC).
 *   "Cannot press when there is nothing to send" (`composerSendEmpty`) applies only when the button's role is send.
 * - **Reserve and interrupt are separate buttons**, shown to the left of the primary button only while a response is running (`composerSideButtons`).
 *   This overrides item 154's "reserve (during a response) turns the primary button into a clock": if the primary button also served as
 *   reserve, there would be no way to stop during a response.
 *
 * Keep text in `title` / `aria-label` (the meaning remains even though the visible text is gone).
 */
import { shellCommandOf } from '@shared/shell-input.js'
import type { MessageKey } from './i18n/ja.js'

export type ComposerButtonKind = 'send' | 'stop' | 'shellRun' | 'sending' | 'shellRunning'

export interface ComposerButtonState {
  /** Mid-send (writing to main). */
  sending: boolean
  /** A response is running (item 94). The primary button is stop during this time (item 161). */
  busy: boolean
  /** Input for `!` (item 116). */
  shellDraft: boolean
}

/**
 * The primary button's role. **While a response is running, stop comes before everything** (item 161): even mid-send during a response (while
 * a reservation is being handed over) or with a `!` draft, the way to stop is not removed. When no response is running it stays as in item 154
 * (mid-send -> `!` -> normal).
 */
export function composerButtonKind(state: ComposerButtonState): ComposerButtonKind {
  if (state.busy) return 'stop'
  if (state.sending) return state.shellDraft ? 'shellRunning' : 'sending'
  if (state.shellDraft) return 'shellRun'
  return 'send'
}

/** TODO 1156: for this period right after sending, stop (click and Esc alike) is not accepted. Owner decision 2026-11-05. */
export const STOP_LOCK_MS = 300

/**
 * Whether we are within `STOP_LOCK_MS` of sending. Pressing again right after send (up-arrow) would hit a button that has already turned into a square
 * in the same place and stop the response that just started; this rejects that mistaken press. Once the response has started the square is immediate
 * (false if `sentAt` is null or 300 ms have passed). Not used for the reserve / interrupt side buttons (item 94).
 */
export function composerStopLocked(sentAt: number | null, now: number): boolean {
  return sentAt !== null && now - sentAt >= 0 && now - sentAt < STOP_LOCK_MS
}

/** What to do when send is pressed (review X of TODO 1156). The stop lock is applied only for `send`. */
export type ComposerSubmitAction =
  | { readonly kind: 'skip' }
  | { readonly kind: 'blocked'; readonly name: string }
  | { readonly kind: 'send'; readonly shell: boolean }

/**
 * Branching of send. `!` (item 116) is not sent without a command (`skip`). Anything else, unless it is `force` (the band's "send anyway"),
 * is stopped at a `/name` not in the list (`blocked`, item 68). **Nothing is sent except for `send`, so
 * the caller must not stamp the send time then**: stamping it would disable the square for 300 ms although nothing is running.
 * `unknownSlash` is the name when `checkSlash` returned `unknown` (null otherwise).
 */
export function composerSubmitAction(params: {
  readonly shellDraft: boolean
  readonly draft: string
  readonly force: boolean
  readonly unknownSlash: string | null
}): ComposerSubmitAction {
  if (params.shellDraft) return shellCommandOf(params.draft) === null ? { kind: 'skip' } : { kind: 'send', shell: true }
  if (!params.force && params.unknownSlash !== null) return { kind: 'blocked', name: params.unknownSlash }
  return { kind: 'send', shell: false }
}

const LABEL_KEYS: Readonly<Record<ComposerButtonKind, MessageKey>> = {
  send: 'composer.send',
  stop: 'composer.stop',
  shellRun: 'composer.shellRun',
  sending: 'composer.sending',
  shellRunning: 'composer.shellRunning'
}

/** Dictionary key for the meaning of the button. The text is gone but remains in `title` / `aria-label` (item 154). */
export function composerButtonLabelKey(kind: ComposerButtonKind): MessageKey {
  return LABEL_KEYS[kind]
}

/**
 * Whether the primary button cannot be pressed. **In the stop role it can always be pressed** (qlm: "get this wrong and the response
 * can no longer be stopped"). Mid-send prevents a double press. Send and running `!` cannot be pressed when there is nothing to send.
 */
export function composerButtonDisabled(kind: ComposerButtonKind, empty: boolean): boolean {
  if (kind === 'stop') return false
  if (kind === 'sending' || kind === 'shellRunning') return true
  return empty
}

/** The reserve / interrupt buttons shown to the left of the primary button only during a response (item 161). */
export interface ComposerSideButtons {
  /** Whether to show them. Only during a response (the primary button does not move when they appear or disappear, since they sit in a box at the right end). */
  readonly visible: boolean
  /** Whether they cannot be pressed. Nothing to send, or mid-send. */
  readonly disabled: boolean
}

export function composerSideButtons(state: {
  busy: boolean
  sending: boolean
  empty: boolean
}): ComposerSideButtons {
  return { visible: state.busy, disabled: state.sending || state.empty }
}

/**
 * The state where "pressing does nothing" (item 154: gray out when the draft is empty and cannot be pressed).
 * For `!` input, when there is no command (`shellCommandOf` is null); otherwise
 * the same condition as the early return of `threadStore.send` (empty body, no attachments, and no selection).
 */
export function composerSendEmpty(params: {
  shellDraft: boolean
  draft: string
  hasAttachments: boolean
  hasSelection: boolean
}): boolean {
  if (params.shellDraft) return shellCommandOf(params.draft) === null
  return params.draft.trim() === '' && !params.hasAttachments && !params.hasSelection
}

/**
 * The placeholder (item 156, three cases aligned with VS Code). The decision applies only when the draft is empty
 * (during `!` / `/` input the placeholder is not visible, so they are out of scope).
 *
 * Priority: "sending during a response becomes a reservation" (item 94) is checked first, then Plan mode (item 112).
 * **The awaiting-approval branch was removed in item 182 (wave 14 bundle C)**: while awaiting approval the approval screen replaces the Composer
 * (the Composer is `hidden`), so an awaiting-approval placeholder has no way to be seen. VS Code too hides the input while awaiting
 * approval and shows one line, "Waiting for permission…" (the section on 154 in item 196).
 */
export type ComposerPlaceholderKind = 'normal' | 'queue' | 'plan'

export function composerPlaceholderKind(state: { busy: boolean; planMode: boolean }): ComposerPlaceholderKind {
  if (state.busy) return 'queue'
  if (state.planMode) return 'plan'
  return 'normal'
}

const PLACEHOLDER_KEYS: Readonly<Record<ComposerPlaceholderKind, MessageKey>> = {
  normal: 'composer.placeholder',
  queue: 'composer.placeholderQueue',
  plan: 'composer.placeholderPlan'
}

export function composerPlaceholderKey(kind: ComposerPlaceholderKind): MessageKey {
  return PLACEHOLDER_KEYS[kind]
}
