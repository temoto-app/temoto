/**
 * The BottomBar notice "Updated the agent CLI to {version}" (TODO 774, wave 36 bundle D).
 *
 * Only when aios has raised the version through the backend's own update, it appears briefly for this launch next to the version badge (`BuildInfoBadge`) (no dialog or
 * notification: the same unobtrusive form as the badge of 103). Pressing it jumps to the agent CLI row of the "Update" section in settings and dismisses it (all windows).
 * "Unverified version" and "roll back to the previous version" exist only in the settings field (owner decision 2026-10-12).
 */
import { useEffect } from 'react'
import { useT } from '../i18n/index.js'
import { initAgentUpdate, jumpToAgentUpdate, useAgentUpdate } from '../agentUpdateStore.js'
import { Tooltip } from './Tooltip.js'

export function AgentUpdateNotice(): React.JSX.Element | null {
  const t = useT()
  const notice = useAgentUpdate((state) => state.status?.notice ?? null)
  const dismissNotice = useAgentUpdate((state) => state.dismissNotice)
  useEffect(() => initAgentUpdate(), [])
  const waiting = useAgentUpdate((state) => state.status?.waiting ?? null)
  // TODO 1143: the one line shown while waiting, when it is time to verify but a conversation is running (the notice of the raise comes first).
  if (notice === null && waiting !== null) {
    const text = t('agentUpdate.waiting.badge')
    return (
      <Tooltip content={t('agentUpdate.waiting.title')}>
        <button type="button" className="build-badge agent-update-badge" aria-label={text} onClick={jumpToAgentUpdate}>
          {text}
        </button>
      </Tooltip>
    )
  }
  if (notice === null) return null
  const title = t('agentUpdate.badge.title', { from: notice.from, to: notice.to })
  return (
    <Tooltip content={title}>
      <button
        type="button"
        className="build-badge updated agent-update-badge"
        aria-label={title}
        onClick={() => {
          void dismissNotice()
          jumpToAgentUpdate()
        }}
      >
        <span className="build-badge-updated">{t('agentUpdate.badge.text', { version: notice.to })}</span>
      </button>
    </Tooltip>
  )
}
