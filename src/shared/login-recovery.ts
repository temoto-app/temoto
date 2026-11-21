/**
 * Recovery from an expired login, as main reports it to the renderer (TODO 960 / 1282, ARCHITECTURE 4.6.7).
 *
 * main (`src/main/session/login-recovery.ts`) holds the only copy of the state: whether it is waiting for the login that was
 * started in Terminal, which conversations are covered, and how the last attempt ended. The renderer only draws it
 * (`agent.loginRecovery()` and the `onLoginRecovery` push). Nothing here carries a token, a code, a URL or command output.
 */
import type { ReasonCode } from './reason.js'

export type LoginRecoveryPhase =
  /** Nothing has been started since launch. */
  | 'idle'
  /** Terminal was opened with the login; main checks the login state every few seconds until `deadline`. */
  | 'waiting'
  /** The login state came back. `resent` / `held` say what happened to each conversation. */
  | 'recovered'
  /** The user cancelled the wait, or every window was closed while waiting. Nothing was resent. */
  | 'cancelled'
  /** The wait ended without recovery, or a resend was rejected again. `failure` is the reason code. */
  | 'failed'

/** The reasons a recovery can end in `failed` (each has `reason.<code>` and `error.recovery.<code>` in the dictionaries). */
export type LoginRecoveryFailure = Extract<ReasonCode, 'login-timeout' | 'login-check-failed' | 'login-still-failing'>

/**
 * Why a conversation was not resent automatically after the login came back. It keeps the "Send again" button instead.
 * - `tool-started`: the stopped turn had already started running tools (resending could repeat their side effects).
 * - `unavailable`: there is no input to resend (sent before a restart, or the stopped turn was not the one aios last sent).
 * - `still-failing`: an automatic resend was already made for this conversation and it stopped on the login again.
 */
export type LoginResendHold = 'tool-started' | 'unavailable' | 'still-failing'

export interface LoginRecoveryState {
  readonly phase: LoginRecoveryPhase
  /** When the phase last changed (epoch ms). The renderer uses it to show a failure notice once per change. */
  readonly changedAt: number
  /** While waiting, when the wait gives up (epoch ms). null otherwise. */
  readonly deadline: number | null
  /**
   * Conversations covered by the wait (thread ids main holds). `resend` says whether its last input will be sent again
   * automatically once the login is back (false: it keeps "Send again"); `why` is the reason when it will not (null when it will).
   * A conversation that is not listed is not covered by this wait (nothing is sent for it automatically).
   */
  readonly waiting: readonly { readonly threadId: string; readonly resend: boolean; readonly why: LoginResendHold | null }[]
  /** After `recovered`: conversations whose last input was sent again automatically. */
  readonly resent: readonly string[]
  /**
   * Conversations left for the user, with the reason. Kept per conversation across phases (a later `failed` / `cancelled` does
   * not drop it) until its expired-login mark is cleared or it expires again; only conversations that still hold the mark.
   */
  readonly held: readonly { readonly threadId: string; readonly why: LoginResendHold }[]
  /** With `failed`: the reason code. null otherwise. */
  readonly failure: LoginRecoveryFailure | null
}

export const LOGIN_RECOVERY_IDLE: LoginRecoveryState = {
  phase: 'idle',
  changedAt: 0,
  deadline: null,
  waiting: [],
  resent: [],
  held: [],
  failure: null
}

/**
 * The guidance for unattended / scheduled runs (TODO 1282, owner decision 2026-11-21: guidance only). The words come from the
 * Adapter's table (constraint 6). aios never runs `setupCommand`, never reads the variable and never stores the token.
 */
export interface UnattendedLoginGuide {
  /** The command line the user types in their own terminal to create a long-lived token. */
  readonly setupCommand: string
  /** The name of the environment variable the CLI reads that token from. */
  readonly tokenEnv: string
}
