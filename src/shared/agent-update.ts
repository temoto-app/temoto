/**
 * main -> renderer shapes for the backend (agent CLI) update (TODO 774, wave 36 bundle D, ARCHITECTURE.md 4.6.6).
 *
 * aios starts the backend only with `-p` (stream-json), so the backend's own auto-update, which runs inside
 * an interactive session, never runs. Instead aios calls the backend's own update subcommand at launch and
 * once a day, when nothing is running. Only the adapter knows how to call it and how to read versions
 * (constraint 6). This file holds neutral words only.
 *
 * It carries no wording (7.4.4). A failure is a reason code (`agent-update-*` in `reason.ts`); the reason it
 * does not run is `AgentUpdateUnsupportedReason`, which the renderer dictionary (`agentUpdate.unsupported.<reason>`)
 * turns into a sentence.
 */
import type { ReasonCode, ReasonParams } from './reason.js'

export const AGENT_UPDATE_UNSUPPORTED_REASONS = [
  /** A copy started with `--user-data-dir` (`npm run dev:instance` / proxy verification). Only the everyday aios updates. */
  'instance',
  /** `npm run dev` (dev server) */
  'dev',
  /** `AIOS_DISABLE_AGENT=1` (a proxy-verification copy, item 186) */
  'agent-disabled',
  /** Fake backend (proxy-verification script, `AIOS_FIXTURES` / `AIOS_FAKE_LOG`) */
  'fake-backend',
  /** The backend has no update entry point. */
  'no-backend-support'
] as const

export type AgentUpdateUnsupportedReason = (typeof AGENT_UPDATE_UNSUPPORTED_REASONS)[number]

export type AgentUpdatePhase =
  /** Nothing done (not run yet) */
  | 'idle'
  /** An update is running */
  | 'updating'
  /** Reverting to the previous version */
  | 'reverting'
  /** The last run found it already up to date (no change) */
  | 'up-to-date'
  /** The last run moved to a new version */
  | 'updated'
  /** The last run reverted to the previous version */
  | 'reverted'
  /** The last run failed (the reason is in `failure`) */
  | 'failed'

export interface AgentUpdateRecord {
  readonly from: string
  readonly to: string
  /** Time of the update (ms). */
  readonly at: number
  /**
   * The new version passed the check (version detection / probe) once. From then on, an unrelated later
   * detection failure does not trigger "revert to the previous version" (the `from` / `to` record stays).
   */
  readonly confirmed?: boolean
}

export interface AgentUpdateStatus {
  /** Whether it can run. If false, `unsupportedReason` has the reason (the other fields only mean the version). */
  readonly supported: boolean
  readonly unsupportedReason: AgentUpdateUnsupportedReason | null
  /** Automatic runs (`agentUpdate.auto`, default ON). */
  readonly auto: boolean
  /** The backend's own setting (environment variable) disables auto-update. No automatic runs ("update now" can still be called). */
  readonly autoBlockedByBackend: boolean
  /**
   * The version (the one before the revert) for which automatic runs are stopped because we reverted. "Update now" clears it. Null if none.
   * This keeps the automatic run right after a revert from moving up again to the same (broken) version.
   */
  readonly heldFrom: string | null
  /** When the hold lifts by itself (ms, 7 days after the revert). Null if there is no `heldFrom`. */
  readonly heldUntil: number | null
  /** The current backend version. Null if unknown. */
  readonly current: string | null
  /** The current version is not in aios's table of known versions (unverified). */
  readonly unverified: boolean
  readonly phase: AgentUpdatePhase
  /** Time of the last run (ms), whether it succeeded or failed. */
  readonly checkedAt: number | null
  /** Time of the next check (ms). Null when auto is OFF, unsupported, or on hold (TODO 1143). */
  readonly nextCheckAt: number | null
  /**
   * Why we are waiting although it is time to check: a conversation etc. is active (`session` / `queue` / `shell` ..., values of main's decision).
   * Once it stops, the next tick (1 minute) runs. Null if not waiting (TODO 1143).
   */
  readonly waiting: string | null
  /** The reason for `phase === 'failed'`. */
  readonly failure: ReasonCode | null
  /** Values to fill into the `failure` sentence (exit code, version, etc.). Null if none. */
  readonly failureParams: ReasonParams | null
  /** Record of the last update (where to go back to when reverting). Null if none. */
  readonly lastUpdate: AgentUpdateRecord | null
  /**
   * The version we can revert to. Set only when the check after an update (probe, version detection) failed. **It is never reverted
   * automatically** (owner decision 2026-10-12).
   */
  readonly revertTo: string | null
  /** Updated in this launch (a short BottomBar notice, until clicked or dismissed). */
  readonly notice: { readonly from: string; readonly to: string } | null
}
