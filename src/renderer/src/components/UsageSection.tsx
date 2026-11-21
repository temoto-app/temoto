/**
 * The "Account and usage" section of the settings screen (item 317, wave 17 bundle B). Shows the same
 * `UsageDetails` as the BottomBar panel. Only when neither value exists (the login info has no email and usage has not
 * been received even once), a short note says it will appear after the first turn.
 */
import { useEffect } from 'react'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
import { ensureUsage, useNow, useUsage } from '../usageStore.js'
import { UsageDetails } from './UsageDetails.js'

export function UsageSection(): React.JSX.Element {
  const t = useT()
  const snapshot = useUsage((state) => state.snapshot)
  const email = useThreads((state) => state.agent?.email ?? null)
  const now = useNow(30_000)

  useEffect(() => ensureUsage(), [])

  return (
    <div className="usage-section">
      <UsageDetails snapshot={snapshot} email={email} now={now} />
      {snapshot === null ? <p className="hint">{t('usage.none')}</p> : null}
    </div>
  )
}
