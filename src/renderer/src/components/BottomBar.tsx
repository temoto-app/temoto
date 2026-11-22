/**
 * BottomBar: a single band across the bottom of the screen (ARCHITECTURE.md 5.6, TODO 51 / 52).
 *
 * It corresponds to VSCode's status bar. One for the whole app (directly under `.app`, after `.workspace`).
 * Left-aligned is the active thread's cwd git info (TODO 51), right-aligned the index status
 * (TODO 52, moved from the sidebar). With no git management or no cwd, the left side shows nothing.
 * TODO 525 / 1171: when it cannot connect to the model (the CLI's retry `api_retry`), the whole band is white text on red (`.bottom-bar.offline`).
 */
import { useEffect } from 'react'
import { useGitStatus, describeGitStatus } from '../gitStatusStore.js'
import { useThreads } from '../threadStore.js'
import { selectActiveWorkingCwd } from '../active-cwd.js'
import { useT } from '../i18n/index.js'
import { IndexStatusBar } from './IndexStatusBar.js'
import { PluginSyncBar } from './PluginSyncBar.js'
import { BuildInfoBadge } from './BuildInfoBadge.js'
import { AgentUpdateNotice } from './AgentUpdateNotice.js'
import { BackupNoticeBadge } from './BackupNoticeBadge.js'
import { UsageBadge } from './UsageBadge.js'
import { FullDelegationBadge } from './FullDelegationBadge.js'
import { ensureConnection, useConnectionAlert } from '../connectionStore.js'

function GitStatusItem(): React.JSX.Element | null {
  // TODO 633: a conversation that moved to a worktree looks at that worktree's git.
  const cwdUri = useThreads(selectActiveWorkingCwd)
  const setCwd = useGitStatus((state) => state.setCwd)
  const refresh = useGitStatus((state) => state.refresh)
  const stop = useGitStatus((state) => state.stop)
  const status = useGitStatus((state) => state.status)
  const t = useT()

  // Switching threads changes the reference. Read once at the moment of the switch, then re-read every 15 seconds.
  useEffect(() => {
    setCwd(cwdUri)
  }, [cwdUri, setCwd])

  // Re-read on window focus (matches right after committing from another terminal).
  // On unmount, stop the timer (the path that closes the window).
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [refresh, stop])

  if (status === null) return null
  const { text, title } = describeGitStatus(status, t)
  return (
    <span className="git-status" title={title}>
      {text}
    </span>
  )
}

export function BottomBar(): React.JSX.Element {
  const t = useT()
  // TODO 525 / 1171: when it cannot connect to the model (retries in the last 1 minute), the whole band is white text on red.
  useEffect(() => ensureConnection(), [])
  const alert = useConnectionAlert()
  return (
    <footer className={alert === null ? 'bottom-bar' : 'bottom-bar offline'} aria-label={t('bottomBar.ariaLabel')}>
      <div className="bottom-bar-left">
        {alert === null ? null : (
          <span className="bottom-bar-alert" role="status">
            {t('bottomBar.connectionFailed')}
          </span>
        )}
        <GitStatusItem />
      </div>
      <div className="bottom-bar-right">
        <FullDelegationBadge />
        <PluginSyncBar />
        <IndexStatusBar />
        <UsageBadge />
        <AgentUpdateNotice />
        <BackupNoticeBadge />
        <BuildInfoBadge />
      </div>
    </footer>
  )
}
