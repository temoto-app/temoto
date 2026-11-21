/**
 * Badge for a plugin's sync progress (TODO 1038, ARCHITECTURE.md 5.6 / 7.5). Placed on the right of the BottomBar next to the index badge.
 *
 * One per reporting plugin, showing the `{ done, total, state }` it reported through the Broker. When it finishes (`done`)
 * main discards it and the badge disappears. Clicking opens the extension's detail (the ThreadPane area, `mainPanel.ts`); re-entry
 * (`needs-reauth`) is also done from there. Colors are CSS variables only (`.plugin-sync.attention`).
 */
import { useEffect } from 'react'
import { useT } from '../i18n/index.js'
import { useExtensionPane } from '../mainPanel.js'
import { initPluginSurfaces, syncLabel, usePluginSurfaces } from '../pluginView.js'
import { usePluginList } from '../extensions.js'

export function PluginSyncBar(): React.JSX.Element | null {
  const t = useT()
  const status = usePluginSurfaces((state) => state.snapshot.status)
  const list = usePluginList()
  const openExtension = useExtensionPane((state) => state.openExtension)
  useEffect(() => initPluginSurfaces(), [])
  if (status.length === 0) return null
  return (
    <>
      {status.map((entry) => {
        const label = syncLabel(entry)
        if (label === null) return null
        const name = list?.find((plugin) => plugin.id === entry.pluginId)?.displayName ?? entry.pluginId
        const attention = entry.state === 'needs-reauth'
        return (
          <button
            key={entry.pluginId}
            type="button"
            className={`plugin-sync${attention ? ' attention' : ''}`}
            title={t('pluginSync.openDetail', { name })}
            onClick={() => openExtension(entry.pluginId)}
          >
            {t(label.key, { ...label.values, name })}
          </button>
        )
      })}
    </>
  )
}
