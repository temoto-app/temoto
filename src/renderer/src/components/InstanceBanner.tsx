/**
 * InstanceBanner: a band shown in a window launched with a non-default `userData` (`--user-data-dir`)
 * (ARCHITECTURE.md 3.1, TODO 192, a follow-up of item 186).
 *
 * On 2026-09-27 the owner mistook a proxy-verification copy (an APFS clone of the real userData started with
 * `--user-data-dir`) for the real one and typed a force-push instruction into the copy's window (the window position and threads
 * are restored the same as the real one by item 36, so in a `hiddenInset` window with no heading
 * they cannot be told apart). **Plan A** (owner decision 2026-09-28): when launched with a non-default
 * userData, show a colored band with its path at the top of the window. Plan B (do not restore) and
 * plan C (disable sending by default) were not adopted, so as not to hinder the usage where a worktree build is run in development
 * with `--user-data-dir` and actually sends (the verification procedure on a real machine).
 *
 * If `appInfo.userDataLabel` is null (the default userData), nothing is drawn.
 */
import { useStore } from '../store.js'
import { useT } from '../i18n/index.js'

export function InstanceBanner(): React.JSX.Element | null {
  const userDataLabel = useStore((state) => state.appInfo?.userDataLabel ?? null)
  const agentDisabled = useStore((state) => state.appInfo?.agentDisabled ?? false)
  const t = useT()

  if (userDataLabel === null) return null

  return (
    <div className="instance-banner" title={userDataLabel}>
      <span className="instance-banner-path">{t('app.instanceBanner', { path: userDataLabel })}</span>
      {agentDisabled ? (
        <span className="instance-banner-agent-disabled">{t('app.instanceBanner.agentDisabled')}</span>
      ) : null}
    </div>
  )
}
