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
 */
import { useEffect, useState } from 'react'
import { useT, type Translate } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'

/**
 * "Log in" (TODO 960): runs the CLI's public subcommand (`auth login`) in Terminal; main detects completion and
 * resends the input that had stopped. The renderer passes only the conversation's id (the source of the cwd, or null if none). The Sidebar badge uses it too.
 */
export async function startLogin(t: Translate, threadId: string | null): Promise<void> {
  try {
    const result = await window.aios.agent.startLogin(threadId)
    if (!result.opened) useThreads.setState({ error: t(`reason.${result.reason}`) })
  } catch (err) {
    useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
  }
}

export function AuthExpiredBar({ threadId }: { threadId: string }): React.JSX.Element {
  const t = useT()
  const [sending, setSending] = useState(false)
  // While the state is absent (null) right after launch, lean toward "expired" (so the guidance is shown).
  const loggedIn = useThreads((state) => state.agent?.loggedIn ?? false)

  useEffect(() => {
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

  return (
    <div className={`timeline-note resume auth-expired${loggedIn ? ' logged-in' : ''}`} role="status">
      <span className="resume-note">{loggedIn ? t('thread.auth.loggedIn') : t('thread.auth.expired')}</span>
      {loggedIn ? null : (
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
    </div>
  )
}
