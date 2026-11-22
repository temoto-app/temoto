/**
 * The one line at the end of the timeline of a thread stopped by expired authentication (TODO 893, wave 47 bundle D). It replaces the
 * place of `ResumeBar` (TODO 521) only when the interruption kind is `interrupt-auth`.
 *
 * - **Guidance**: while the login has expired (`AgentStatus.loggedIn` is false) it says to run the CLI's `/login` in a terminal.
 *   The login state is re-checked once when main sets the marker (`SessionManager.recheckLogin`), and once more each time
 *   the window showing this row returns to the front (`agent.recheckLogin`). When it is back to logged in, the guidance disappears.
 *   It looks at the same `AgentStatus` as the startup "not logged in", so it matches the Sidebar badge (no new mechanism).
 * - **Send again**: resends the last input that stopped, as is (`threads.resendLast`). The content is in main's memory and
 *   the renderer does not hold it. If a response is in progress, main puts it in the queue (item 94), so it does not conflict with pending approvals or queued messages.
 *   **No dialog is shown** (167). aios does not touch token refresh or credentials (constraint 2).
 * - **Open in terminal** (TODO 908): opens Terminal.app in the conversation's working folder and starts the CLI's interactive session
 *   (`threads.openInTerminal`, only the conversation's id is passed). `/login` is not typed automatically: the badge's text gives the guidance.
 * - **While waiting for the login** (TODO 1282): after "Log in", main waits for the sign-in done in Terminal and the browser.
 *   The row shows what the user has to do, until when it waits, whether this conversation will be resent automatically, and
 *   a "Cancel" button (`agent.cancelLogin`). Only a conversation main lists with `resend: true` says it will be resent; one main
 *   lists with a reason says why not, and one main does not list is not covered by the wait (review of TODO 1282: never assume).
 *   Outside the wait, a conversation main did not resend (a turn that had started tools, no input kept, or a resend that stopped
 *   on the login again) says why and keeps "Send again" - main keeps that reason per conversation across later phases.
 *   All of it is main's state (`useLoginRecovery`).
 * - **Unattended conversations** (TODO 1282): a scheduled run or a trigger conversation also shows how to set up unattended
 *   authentication (guidance only; no token is asked for).
 */
import { useEffect, useState } from 'react'
import { formatReason } from '@shared/reason.js'
import type { LoginResendHold } from '@shared/login-recovery.js'
import { useT, type Translate } from '../i18n/index.js'
import { ensureLoginRecovery, useLoginRecovery } from '../loginRecoveryStore.js'
import { useThreads } from '../threadStore.js'
import { UnattendedAuthGuide } from './UnattendedAuthGuide.js'

/**
 * "Log in" (TODO 960): runs the CLI's public subcommand (`auth login`) in Terminal; main detects completion and
 * resends the input that had stopped. The renderer passes only the conversation's id (the source of the cwd, or null if none). The Sidebar badge uses it too.
 * A refusal goes to the common error notice with its reason code (TODO 1281 / 1282).
 */
export async function startLogin(_t: Translate, threadId: string | null): Promise<void> {
  try {
    const result = await window.aios.agent.startLogin(threadId)
    if (!result.opened) useThreads.setState({ error: formatReason(result.reason) })
  } catch (err) {
    useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
  }
}

const HOLD_KEYS = {
  'tool-started': 'thread.auth.held.toolStarted',
  unavailable: 'thread.auth.held.unavailable',
  'still-failing': 'thread.auth.held.stillFailing',
  drill: 'thread.auth.held.drill'
} as const satisfies Record<LoginResendHold, string>

/** While waiting: why this conversation will not be resent automatically when the login is back. */
const WAITING_HOLD_KEYS = {
  'tool-started': 'thread.auth.waitingHold.toolStarted',
  unavailable: 'thread.auth.waitingHold.unavailable',
  'still-failing': 'thread.auth.waitingHold.stillFailing',
  drill: 'thread.auth.waitingHold.drill'
} as const satisfies Record<LoginResendHold, string>

export function AuthExpiredBar({ threadId }: { threadId: string }): React.JSX.Element {
  const t = useT()
  const [sending, setSending] = useState(false)
  // While the state is absent (null) right after launch, lean toward "expired" (so the guidance is shown).
  const loggedIn = useThreads((state) => state.agent?.loggedIn ?? false)
  const unattended = useThreads((state) => {
    const thread = state.threadsById[threadId]?.thread
    return thread !== undefined && ((thread.scheduledJobId ?? '') !== '' || thread.triggerOrigin !== undefined)
  })
  const recovery = useLoginRecovery((state) => state.state)

  useEffect(() => {
    ensureLoginRecovery()
    const onFocus = (): void => {
      void window.aios.agent.recheckLogin().catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const resend = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    // Like the other send paths, scroll until the sent input is visible (TODO 906).
    useThreads.getState().markSendScroll(threadId)
    try {
      await window.aios.threads.resendLast(threadId)
    } catch (err) {
      useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  const openTerminal = async (): Promise<void> => {
    try {
      const result = await window.aios.threads.openInTerminal(threadId)
      // The reason is main's reason code (7.4.4). Show the per-reason sentence (`reason.terminal-*`).
      if (!result.opened) useThreads.setState({ error: t(`reason.${result.reason}`) })
    } catch (err) {
      useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  const cancel = (): void => {
    void window.aios.agent.cancelLogin().catch(() => undefined)
  }

  const waiting = recovery.phase === 'waiting'
  const mine = recovery.waiting.find((entry) => entry.threadId === threadId)
  // main keeps the reason per conversation in every phase (review of TODO 1282); while waiting, the waiting entry speaks instead.
  const held = waiting ? undefined : recovery.held.find((entry) => entry.threadId === threadId)
  const until =
    recovery.deadline === null
      ? ''
      : new Date(recovery.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className={`timeline-note resume auth-expired${loggedIn ? ' logged-in' : ''}${waiting ? ' waiting' : ''}`} role="status">
      {waiting ? (
        <span className="resume-note auth-waiting-note">
          {t('thread.auth.waiting', { time: until })}{' '}
          {mine === undefined
            ? t('thread.auth.waitingNotCovered')
            : mine.resend
              ? t('thread.auth.waitingResend')
              : t(WAITING_HOLD_KEYS[mine.why ?? 'unavailable'])}
        </span>
      ) : (
        <span className="resume-note">
          {loggedIn ? t('thread.auth.loggedIn') : t('thread.auth.expired')}
          {held === undefined ? null : <> {t(HOLD_KEYS[held.why])}</>}
        </span>
      )}
      {waiting ? (
        <button
          type="button"
          className="resume-button auth-cancel-button"
          title={t('thread.auth.cancelTitle')}
          onClick={cancel}
        >
          {t('thread.auth.cancel')}
        </button>
      ) : loggedIn ? null : (
        <button
          type="button"
          className="resume-button auth-login-button"
          title={t('thread.auth.loginTitle')}
          onClick={() => void startLogin(t, threadId)}
        >
          {t('thread.auth.login')}
        </button>
      )}
      <button
        type="button"
        className="resume-button auth-terminal-button"
        title={t('thread.auth.terminalTitle')}
        onClick={() => void openTerminal()}
      >
        {t('thread.auth.terminal')}
      </button>
      <button
        type="button"
        className="resume-button auth-resend-button"
        title={t('thread.auth.resendTitle')}
        disabled={sending}
        onClick={() => void resend()}
      >
        {t('thread.auth.resend')}
      </button>
      {unattended && !loggedIn && !waiting ? <UnattendedAuthGuide compact /> : null}
    </div>
  )
}
