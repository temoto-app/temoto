/**
 * The version badge in the right corner of BottomBar (TODO 316, wave 17 bundle A, ARCHITECTURE.md 5.6).
 *
 * A shortened form of `0.23.0 · 514bcd9 · Oct 4, 10:27 PM` (if dirty, `*` after the commit. The date format is TODO 457). When narrow,
 * this badge shrinks first into an ellipsis, so it does not push out the index status or the git info (`.build-badge` in
 * styles.css). Pressing it jumps to the "About" section of the settings screen (`jumpToBuildInfo`, via the existing
 * `openSettingsEditor` path).
 *
 * TODO 103 (wave 28 bundle G): on the first launch after an auto-update, "Updated to {version}" is prepended to the badge (unobtrusive:
 * no dialog and no notification). Pressing it jumps to About and dismisses it (all windows, `update.dismissNotice`).
 */
import { useEffect } from 'react'
import { formatBuildBadge, UNKNOWN_COMMIT } from '@shared/build-info.js'
import { useStore } from '../store.js'
import { useT } from '../i18n/index.js'
import { jumpToBuildInfo } from '../buildInfoJump.js'
import { initUpdate, useUpdate } from '../updateStore.js'
import { Tooltip } from './Tooltip.js'

export function BuildInfoBadge(): React.JSX.Element | null {
  const t = useT()
  const build = useStore((state) => state.appInfo?.build ?? null)
  const justUpdated = useUpdate((state) => state.status?.justUpdated ?? null)
  const dismissNotice = useUpdate((state) => state.dismissNotice)
  useEffect(() => initUpdate(), [])
  if (build === null) return null
  const text = formatBuildBadge(build)
  const title = [
    justUpdated === null ? '' : t('update.badge.updatedTitle', { from: justUpdated.from, to: justUpdated.to }),
    t('build.badge.title', { text }),
    build.dirty ? t('build.badge.dirty') : '',
    build.commit === UNKNOWN_COMMIT ? '' : build.commit
  ]
    .filter((line) => line !== '')
    .join('\n')
  return (
    <Tooltip content={title}>
      <button
        type="button"
        className={`build-badge${justUpdated === null ? '' : ' updated'}`}
        aria-label={title}
        onClick={() => {
          if (justUpdated !== null) void dismissNotice()
          jumpToBuildInfo()
        }}
      >
        {justUpdated === null ? null : (
          <span className="build-badge-updated">{t('update.badge.updated', { version: justUpdated.to })} · </span>
        )}
        {text}
      </button>
    </Tooltip>
  )
}
