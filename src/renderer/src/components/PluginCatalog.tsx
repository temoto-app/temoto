/**
 * "Install a CLI plugin" inside the settings "Skills" section (TODO 1099, ARCHITECTURE.md 4.5.3.3). `SkillSettings` places it below.
 *
 * - Main reads the catalog from the CLI's cache and returns it filtered by the search word (only the adapter knows the location and the marketplace name, constraint 6).
 *   When the catalog is missing, stale or malformed, the list is emptied and a reason plus "the command to type in a terminal" is shown (the command string comes from main).
 * - Install and remove: main runs the CLI's non-interactive subcommands. aios does not write to the settings directory (constraint 2).
 *   No confirmation dialog is shown (TODO 167: a removed plugin can be installed again). The result is reported in a strip inside the section.
 * - After installing, the skill list is re-read through `onChanged`. The Composer's `/` candidates are updated automatically by the CLI's `commands_changed` /
 *   the next conversation's `session_started` (nothing to do here).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  InstalledCliPlugin,
  PluginCatalogEntry,
  PluginCatalogResult,
  PluginOpResult
} from '@shared/skills.js'
import { useT } from '../i18n/index.js'

/** Wait between the end of typing and the lookup, in ms. */
const SEARCH_DEBOUNCE_MS = 200
const NOTICE_MS = 8000

export function PluginCatalog({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<PluginCatalogResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null)
  const timer = useRef<number | null>(null)
  const latest = useRef(0)

  const load = useCallback(async (text: string): Promise<void> => {
    const ticket = ++latest.current
    const next = await window.aios.skills.pluginCatalog(text)
    // Even if an earlier query returns late while typing, only the result for the last word is shown.
    if (ticket === latest.current) setResult(next)
  }, [])

  useEffect(() => {
    const handle = window.setTimeout(() => void load(query), query === '' ? 0 : SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query, load])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const announce = (text: string, failed: boolean): void => {
    setNotice({ text, failed })
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const report = (kind: 'install' | 'uninstall', name: string, outcome: PluginOpResult): void => {
    if (outcome.ok) {
      const key =
        kind === 'install'
          ? outcome.already
            ? 'settings.skills.plugins.done.installAlready'
            : 'settings.skills.plugins.done.install'
          : outcome.already
            ? 'settings.skills.plugins.done.uninstallAlready'
            : 'settings.skills.plugins.done.uninstall'
      announce(t(key, { name }), false)
      return
    }
    announce(t(`settings.skills.plugins.fail.${outcome.reason}`, { name, exitCode: outcome.exitCode ?? -1 }), true)
  }

  const act = async (kind: 'install' | 'uninstall', key: string, name: string): Promise<void> => {
    if (pending !== null) return
    setPending(key)
    try {
      const outcome =
        kind === 'install' ? await window.aios.skills.pluginInstall(key) : await window.aios.skills.pluginUninstall(key)
      report(kind, name, outcome)
    } catch {
      report(kind, name, { ok: false, reason: 'failed', exitCode: -1 })
    } finally {
      setPending(null)
    }
    await load(query)
    onChanged()
  }

  const opsDisabled = result?.opsDisabled ?? null
  const busy = pending !== null

  const entryRow = (entry: PluginCatalogEntry): React.JSX.Element => {
    const installing = pending === entry.name
    // The label is the name that appears in "installed CLI plugins" after installing (the name passed to the CLI). For something that cannot be installed it is the catalog name (TODO 1177).
    const shownName = entry.installName ?? entry.name
    return (
      <li key={entry.name}>
        <div className="skill-settings-main">
          <span className="skill-settings-name">{entry.title}</span>
          {entry.title === shownName ? null : <span className="skill-settings-tag">{shownName}</span>}
          {entry.version === null ? null : <span className="skill-settings-tag">{entry.version}</span>}
          {entry.review === null ? null : (
            <span className="skill-settings-tag">{t(`settings.skills.plugins.review.${entry.review}`)}</span>
          )}
          {entry.publisher === null ? null : <span className="skill-settings-tag">{entry.publisher}</span>}
          <span className="skill-settings-buttons">
            {entry.installed ? (
              <span className="skill-settings-tag">{t('settings.skills.plugins.installed')}</span>
            ) : entry.blocked !== null || opsDisabled !== null ? null : (
              <button type="button" disabled={busy} onClick={() => void act('install', entry.name, entry.title)}>
                {installing ? t('settings.skills.plugins.installing') : t('settings.skills.plugins.install')}
              </button>
            )}
          </span>
        </div>
        <div className="hint skill-settings-description">
          {entry.summary === '' ? t('settings.skills.noDescription') : entry.summary}
        </div>
        {entry.blocked === null || entry.installed ? null : (
          <div className="hint skill-settings-description">{t(`settings.skills.plugins.blocked.${entry.blocked}`)}</div>
        )}
      </li>
    )
  }

  const installedRow = (plugin: InstalledCliPlugin): React.JSX.Element => {
    const removing = pending === plugin.id
    return (
      <li key={plugin.id}>
        <div className="skill-settings-main">
          <span className="skill-settings-name">{plugin.name}</span>
          <span className="skill-settings-tag">{plugin.marketplace}</span>
          {plugin.version === null ? null : <span className="skill-settings-tag">{plugin.version}</span>}
          <span className="skill-settings-tag">{t(`settings.skills.plugins.scope.${plugin.scope}`)}</span>
          <span className="skill-settings-buttons">
            {!plugin.removable || opsDisabled !== null ? null : (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void act('uninstall', plugin.id, plugin.name)}
              >
                {removing ? t('settings.skills.plugins.uninstalling') : t('settings.skills.plugins.uninstall')}
              </button>
            )}
          </span>
        </div>
        {plugin.removable ? null : (
          <div className="hint skill-settings-description">{t('settings.skills.plugins.notRemovable')}</div>
        )}
      </li>
    )
  }

  return (
    <div className="plugin-catalog">
      <h4 className="skill-settings-scope">{t('settings.skills.plugins.installedHeading')}</h4>
      {result === null ? null : result.installed.length === 0 ? (
        <p className="hint">{t('settings.skills.plugins.noneInstalled')}</p>
      ) : (
        <ul className="skill-settings-list" role="list">
          {result.installed.map(installedRow)}
        </ul>
      )}
      <h4 className="skill-settings-scope plugin-catalog-heading">{t('settings.skills.plugins.heading')}</h4>
      {opsDisabled === null ? null : <p className="hint">{t(`settings.skills.plugins.disabled.${opsDisabled}`)}</p>}
      {notice === null ? null : (
        <p className={notice.failed ? 'skill-notice denied' : 'skill-notice'} role="status">
          {notice.text}
        </p>
      )}
      {result !== null && result.unavailable !== null ? (
        <p className="hint" role="status">
          {t(`settings.skills.plugins.unavailable.${result.unavailable}`)}
          {result.refreshCommand === null ? null : (
            <> {t('settings.skills.plugins.refresh', { command: result.refreshCommand })}</>
          )}
        </p>
      ) : (
        <>
          <input
            type="search"
            className="plugin-catalog-search"
            value={query}
            placeholder={t('settings.skills.plugins.search')}
            aria-label={t('settings.skills.plugins.search')}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {result === null ? null : (
            <>
              <p className="hint">
                {result.matched > result.entries.length
                  ? t('settings.skills.plugins.countTruncated', {
                      matched: result.matched,
                      total: result.total,
                      shown: result.entries.length
                    })
                  : t('settings.skills.plugins.count', { matched: result.matched, total: result.total })}
                {result.fetchedAt === null ? null : (
                  <>
                    {' · '}
                    {t('settings.skills.plugins.fetchedAt', { date: new Date(result.fetchedAt).toLocaleString() })}
                  </>
                )}
              </p>
              {result.entries.length === 0 ? (
                <p className="hint">{t('settings.skills.plugins.noMatch')}</p>
              ) : (
                <ul className="skill-settings-list" role="list">
                  {result.entries.map(entryRow)}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
