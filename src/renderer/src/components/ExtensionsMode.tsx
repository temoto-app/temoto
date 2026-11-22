/**
 * The sidebar of the extension view (TODO 367, ARCHITECTURE.md 5.3 / 7.1). The shape of VS Code's Extensions view.
 *
 * - The headings are "Installed" and "Built-in". The current 4 standard ones are all "Built-in". There is no Marketplace section.
 * - One row has an icon (for now the default icon, TODO 368), the name (`displayName`), the version, the update state (TODO 1144 stage 1), a one-line description, the id, and the state.
 * - Pressing a row opens the detail in ThreadPane's place (`openExtension` in `mainPanel.ts`, TODO 458. The same place as the settings editor and the scheduled-run
 *   editor). What is drawn is the renderer's own screen, and plugin code is not run.
 * - At the right end of the heading is the entry point to open the "Audit log (overall)" (the per-plugin one is in the detail's "Runtime").
 * - TODO 1144 stage 3: if there are extensions that can be updated, "Update all" under the heading, and the per-extension results after pressing.
 *
 * Previously the table and audit log were in the settings "Plugins" section (`PluginSettings.tsx`). The contents moved here and to the detail.
 */
import { useState } from 'react'
import type { PluginSummary } from '@shared/plugin.js'
import type { PluginUpdateAllResult } from '@shared/plugin-update.js'
import { useExtensionPane } from '../mainPanel.js'
import { useT } from '../i18n/index.js'
import { PluginIcon } from './PluginIcon.js'
import { AuditLogIcon } from '../icons/AuditLogIcon.js'
import {
  STATUS_LABELS,
  extensionStatus,
  groupExtensions,
  updatablePlugins,
  updateAllResultLine,
  updateDetail,
  updateLabel,
  updateRejectDetail,
  usePluginList
} from '../extensions.js'
import { Tooltip } from './Tooltip.js'

export function ExtensionsMode(): React.JSX.Element {
  const t = useT()
  const list = usePluginList()
  const openAuditLog = useExtensionPane((state) => state.openAuditLog)
  const auditOpen = useExtensionPane((state) => state.view?.kind === 'audit')
  const groups = list === null ? null : groupExtensions(list)

  return (
    <>
      <div className="sidebar-header extensions-header">
        <span className="extensions-title">{t('extensions.title')}</span>
        <Tooltip content={t('extensions.auditAll')}>
          <button
            type="button"
            className={`icon-button extensions-audit${auditOpen ? ' active' : ''}`}
            aria-label={t('extensions.auditAll')}
            aria-pressed={auditOpen}
            onClick={openAuditLog}
          >
            <AuditLogIcon />
          </button>
        </Tooltip>
      </div>
      {list === null ? null : <UpdateAllBar list={list} />}
      <div className="sidebar-list extensions-list" aria-label={t('sidebar.mode.extensions')}>
        {groups === null ? (
          <p className="extensions-empty">{t('common.loading')}</p>
        ) : (
          <>
            <ExtensionSection
              label={t('extensions.section.installed')}
              plugins={groups.installed}
              empty={t('extensions.installedEmpty')}
            />
            <ExtensionSection label={t('extensions.section.builtin')} plugins={groups.builtin} empty={null} />
          </>
        )}
      </div>
    </>
  )
}

/**
 * TODO 1144 stage 3: the bulk "Update all". The number of extensions that can be updated (those whose detail shows "Update") and "Update all". When pressed, main
 * updates them one at a time in order, and when done shows the per-extension results (the version updated to / the reason for failure). The badge on each row (updating / failed)
 * arrives through the list redistribution as before. The result is shown until the next press. A refusal before starting (a form that does not run, in the middle of shutdown) is the reject's sentence.
 */
function UpdateAllBar({ list }: { readonly list: readonly PluginSummary[] }): React.JSX.Element | null {
  const t = useT()
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<readonly PluginUpdateAllResult[] | null>(null)
  const [rejected, setRejected] = useState<string | null>(null)
  const targets = updatablePlugins(list)
  if (targets.length === 0 && !running && results === null && rejected === null) return null
  const run = (): void => {
    if (running) return
    setRunning(true)
    setResults(null)
    setRejected(null)
    void window.aios.plugins
      .updateAll()
      .then(
        (next) => setResults(next),
        (err: unknown) => setRejected(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setRunning(false))
  }
  const updated = results?.some((result) => result.outcome === 'updated') ?? false
  return (
    <div className="extensions-update-all" role="region" aria-label={t('extensions.updateAll.label')}>
      {targets.length > 0 || running ? (
        <div className="extensions-update-all-line">
          <span className="extensions-update-all-count">
            {targets.length > 0 ? t('extensions.updateAll.count', { count: targets.length }) : null}
          </span>
          <button type="button" className="extension-action extensions-update-all-action" disabled={running} onClick={run}>
            {running ? t('extensions.updateAll.running') : t('extensions.updateAll.button')}
          </button>
        </div>
      ) : null}
      {rejected === null ? null : (
        <p className="extensions-update-all-note extension-update-rejected" role="alert">
          {updateRejectDetail(t, rejected)}
        </p>
      )}
      {results === null ? null : results.length === 0 ? (
        <p className="extensions-update-all-note">{t('extensions.updateAll.none')}</p>
      ) : (
        <ul className="extensions-update-all-results">
          {results.map((result) => (
            <li key={result.id} className={`extensions-update-all-result ${result.outcome}`} data-plugin-id={result.id}>
              {updateAllResultLine(t, result, list)}
            </li>
          ))}
        </ul>
      )}
      {updated ? <p className="extensions-update-all-note">{t('extensions.updateAll.reopenHint')}</p> : null}
    </div>
  )
}

function ExtensionSection({
  label,
  plugins,
  empty
}: {
  readonly label: string
  readonly plugins: readonly PluginSummary[]
  readonly empty: string | null
}): React.JSX.Element | null {
  if (plugins.length === 0 && empty === null) return null
  return (
    <section className="extensions-section" aria-label={label}>
      <h3 className="extensions-section-heading">
        <span>{label}</span>
        <span className="extensions-section-count">{plugins.length}</span>
      </h3>
      {plugins.length === 0 ? (
        <p className="extensions-empty">{empty}</p>
      ) : (
        <ul className="extensions-rows">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <ExtensionRow plugin={plugin} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ExtensionRow({ plugin }: { readonly plugin: PluginSummary }): React.JSX.Element {
  const t = useT()
  const openExtension = useExtensionPane((state) => state.openExtension)
  const current = useExtensionPane((state) => state.view?.kind === 'extension' && state.view.pluginId === plugin.id)
  const status = extensionStatus(plugin)
  return (
    <button
      type="button"
      className={`extension-row${current ? ' selected' : ''}${plugin.enabled ? '' : ' disabled'}`}
      aria-current={current ? 'true' : undefined}
      data-plugin-id={plugin.id}
      onClick={() => openExtension(plugin.id)}
    >
      <span className="extension-row-icon">
        <PluginIcon url={plugin.iconUrl} size={28} />
      </span>
      <span className="extension-row-body">
        <span className="extension-row-line">
          <span className="extension-row-name">{plugin.displayName}</span>
          <span className="extension-row-version">{plugin.version}</span>
          {/* TODO 1144 stage 1: the update state next to the version (latest / update available / cannot be confirmed). The reason is in the popover and the detail's "Update" field. */}
          <Tooltip content={() => updateDetail(t, plugin.update)}>
            <span className={`extension-update ${plugin.update.state}`} data-update-state={plugin.update.state}>
              {updateLabel(t, plugin.update)}
            </span>
          </Tooltip>
        </span>
        <span className="extension-row-description">
          {plugin.description ?? t('extensions.overview.noDescription')}
        </span>
        <span className="extension-row-line">
          {/* TODO 1299: the list shows the display name only; the id is in the detail's id field. The empty span keeps the status at the right edge. */}
          <span className="extension-row-spacer" />
          <span className={`extension-status ${status}`}>
            {t(STATUS_LABELS[status], { count: plugin.crashes })}
          </span>
        </span>
      </span>
    </button>
  )
}
