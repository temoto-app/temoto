/**
 * Contents of account and usage (item 317, same shape as the VS Code extension's "ACCOUNT & USAGE").
 * The BottomBar panel (`UsageBadge`) and the settings screen (`UsageSection`) show the same thing.
 *
 * - ACCOUNT: Email (the value of the same public subcommand as login detection. If none, the whole field is hidden).
 * - USAGE: the % of Session (5hr) / Weekly (7 day), the horizontal bar and "Resets in ...", and the time received ("value from n minutes ago").
 *   If there is no value, the whole field is hidden.
 * - For `allowed_warning` / `rejected` / metered, the warning color and a short note (`usageNeedsAttention`).
 *
 * It is a ratio against the plan's limit, not a cost (cost is not shown - item 165).
 */
import type { UsageWindow } from '@shared/agent.js'
import { usageNeedsAttention, type UsageSnapshot } from '@shared/usage.js'
import { useT, type MessageKey } from '../i18n/index.js'
import { formatReceivedAgo, formatResetsIn, usageBarWidth, usagePercentLabel } from '../usage-format.js'

function UsageMeter({
  label,
  window,
  now,
  warn
}: {
  readonly label: string
  readonly window: UsageWindow
  readonly now: number
  readonly warn: boolean
}): React.JSX.Element {
  const t = useT()
  const percentLabel = usagePercentLabel(window, now, t)
  const barWidth = usageBarWidth(window, now)
  const resets = formatResetsIn(window.resetsAt, now, t)
  return (
    <div className={`usage-meter${warn ? ' warn' : ''}`}>
      <div className="usage-meter-head">
        <span className="usage-meter-label">{label}</span>
        <span className="usage-meter-percent">{percentLabel}</span>
      </div>
      <div
        className="usage-meter-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={barWidth}
      >
        <div className="usage-meter-fill" style={{ width: `${barWidth}%` }} />
      </div>
      {resets === null ? null : <div className="usage-meter-resets">{resets}</div>}
    </div>
  )
}

function statusNote(snapshot: UsageSnapshot): MessageKey | null {
  if (snapshot.status === 'rejected') return 'usage.status.rejected'
  if (snapshot.usingOverage) return 'usage.status.overage'
  if (snapshot.status === 'allowed_warning') return 'usage.status.warning'
  return null
}

export function UsageDetails({
  snapshot,
  email,
  now
}: {
  readonly snapshot: UsageSnapshot | null
  readonly email: string | null
  readonly now: number
}): React.JSX.Element {
  const t = useT()
  const warn = snapshot !== null && usageNeedsAttention(snapshot)
  const note = snapshot === null ? null : statusNote(snapshot)
  return (
    <div className="usage-details">
      {email === null ? null : (
        <section className="usage-block">
          <h3 className="usage-heading">{t('usage.heading.account')}</h3>
          <div className="usage-row">
            <span className="usage-row-label">{t('usage.email')}</span>
            <span className="usage-row-value">{email}</span>
          </div>
        </section>
      )}
      {snapshot === null ? null : (
        <section className="usage-block">
          <h3 className="usage-heading">{t('usage.heading.usage')}</h3>
          {note === null ? null : <p className="usage-note warn">{t(note)}</p>}
          {snapshot.fiveHour === undefined ? null : (
            <UsageMeter label={t('usage.fiveHour')} window={snapshot.fiveHour} now={now} warn={warn} />
          )}
          {snapshot.sevenDay === undefined ? null : (
            <UsageMeter label={t('usage.sevenDay')} window={snapshot.sevenDay} now={now} warn={warn} />
          )}
          {snapshot.sevenDayFable === undefined ? null : (
            <>
              <UsageMeter label={t('usage.sevenDayFable')} window={snapshot.sevenDayFable} now={now} warn={warn} />
              {snapshot.sevenDayFableReceivedAt === undefined ||
              snapshot.sevenDayFableReceivedAt >= snapshot.receivedAt - 60_000 ? null : (
                <div className="usage-received">
                  {t('usage.sevenDayFable')}: {formatReceivedAgo(snapshot.sevenDayFableReceivedAt, now, t)}
                </div>
              )}
            </>
          )}
          <div className="usage-received">{formatReceivedAgo(snapshot.receivedAt, now, t)}</div>
        </section>
      )}
    </div>
  )
}
