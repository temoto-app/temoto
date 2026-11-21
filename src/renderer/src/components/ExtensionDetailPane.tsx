/**
 * Extension detail and the audit log (overall), opened where ThreadPane is (TODO 367 -> TODO 458, ARCHITECTURE.md 5.3).
 *
 * In TODO 367, following VS Code opening extension details in an editor tab, it was shown as a ViewerPane temporary view,
 * but the main column of aios is ThreadPane, so in TODO 458 (owner request 2026-10-04) it moved to the same place as the settings editor (item 187) and the scheduled-run editor
 * (TODO 372): ThreadPane is hidden with CSS rather than removed (`.settings-editor ~ .thread-pane`).
 * Opening / closing, and the priority among the 3 screens (the one opened later wins), are in `mainPanel.ts`. The contents of ViewerPane are not touched.
 *
 * **What is drawn is the renderer's own screen** (not a plugin iframe). Plugin code is not run; it only draws the manifest and state
 * that main holds, received through `window.aios.plugins.detail` / `audit`.
 *
 * Tabs: Overview / Contributions / Permissions / Runtime.
 * - Contributions: the viewer's extensions, schemes, temporary view kinds and receivers, commands, mcp, indexers.
 * - Permissions: the declared capabilities (the upper bound) and the consent state (7.7: declaration -> consent -> policy).
 * - Runtime: the process state and crash count, and **the audit log of that extension only** (`plugins.audit(limit, pluginId)`).
 *
 * "Disable" can be pressed even for a built-in (TODO 460). Only the last fallback receiver (`summary.required`, aios.text) cannot be pressed;
 * it is shown grayed out, with the reason given in a popover and a sentence beside it (12.9). We use
 * `aria-disabled` rather than the `disabled` attribute because a `disabled` button may not receive mouse enter / leave (it differs by browser and version), so the popover might not appear.
 *
 * "Uninstall" (TODO 1233, ARCHITECTURE 7.2) is shown only for external extensions (`summary.bundled` is false); built-ins can only be disabled
 * (same as built-in extensions in VS Code). No confirmation dialog is shown (the folder goes to the trash and can be restored). When it is gone, the detail is closed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { EXPLICIT_CONSENT_CAPABILITIES, type AuditEntry, type PluginDetail } from '@shared/plugin.js'
import { useExtensionPane } from '../mainPanel.js'
import { useLocale } from '../localeStore.js'
import { describeReason, useT, type MessageKey, type Translate } from '../i18n/index.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { PluginIcon } from './PluginIcon.js'
import { PluginAccountSection } from './PluginAccountSection.js'
import { PluginSettingsSection } from './PluginSettingsSection.js'
import { CAPABILITY_LABELS, STATUS_LABELS, canUpdate, extensionStatus, updateDetail, updateLabel, updateRejectDetail } from '../extensions.js'
import { Tooltip } from './Tooltip.js'
import { InlineMarkdown } from './InlineMarkdown.js'
import { extensionNotices } from '../third-party-notices.js'
import { localizedHeading } from '@shared/third-party-notices.js'

/** The number of audit log entries. **No COUNT of all rows** (12.7). Always the newest N. */
export const AUDIT_LIMIT = 50
export const AUDIT_ALL_LIMIT = 200

export const EXTENSION_TABS = ['overview', 'contributions', 'permissions', 'runtime'] as const
export type ExtensionTab = (typeof EXTENSION_TABS)[number]

const TAB_LABELS: Readonly<Record<ExtensionTab, MessageKey>> = {
  overview: 'extensions.tab.overview',
  contributions: 'extensions.tab.contributions',
  permissions: 'extensions.tab.permissions',
  runtime: 'extensions.tab.runtime'
}

/** An empty array as a module constant (the React #185 episode). */
const NO_ENTRIES: readonly AuditEntry[] = []

function CloseButton(): React.JSX.Element {
  const t = useT()
  const close = useExtensionPane((state) => state.close)
  return (
    <Tooltip content={t('common.close')}>
      <button type="button" className="icon-button settings-editor-close" onClick={close} aria-label={t('common.close')}>
        <CloseIcon />
      </button>
    </Tooltip>
  )
}

/** The heading band of the place (the same `.settings-editor-header` as the settings editor and the scheduled-run editor). */
function PaneHeader({ title, id }: { readonly title: string; readonly id: string | null }): React.JSX.Element {
  return (
    <div className="settings-editor-header extension-editor-header">
      <h1 className="extension-editor-title">{title}</h1>
      {id === null ? null : <span className="extension-editor-id">{id}</span>}
      <span className="viewer-spacer" />
      <CloseButton />
    </div>
  )
}

/** The extension screen open in ThreadPane's place (`view` of `mainPanel.ts`). App places it when `useMainPanel() === 'extension'`. */
export function ExtensionPanel(): React.JSX.Element | null {
  const view = useExtensionPane((state) => state.view)
  if (view === null) return null
  // When switched to another extension, rebuild (return the tab to Overview).
  if (view.kind === 'extension') return <ExtensionDetailPane key={view.pluginId} pluginId={view.pluginId} />
  return <AuditLogPane />
}

/** The extension detail. When `pluginId` changes, the caller rebuilds it with `key` (returns the tab to Overview). */
export function ExtensionDetailPane({ pluginId }: { readonly pluginId: string }): React.JSX.Element {
  const t = useT()
  /** undefined = loading, null = no extension with that id. */
  const [detail, setDetail] = useState<PluginDetail | null | undefined>(undefined)
  const [tab, setTab] = useState<ExtensionTab>('overview')
  const tabRefs = useRef<Partial<Record<ExtensionTab, HTMLButtonElement | null>>>({})

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.aios.plugins.detail(pluginId).then(
        (next) => {
          if (!cancelled) setDetail(next)
        },
        () => {
          if (!cancelled) setDetail(null)
        }
      )
    }
    load()
    // When the list is redistributed because of enable / disable, consent, or a process start or crash, re-fetch the detail too.
    const unsubscribe = window.aios.plugins.onChanged(load)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [pluginId])

  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = EXTENSION_TABS.indexOf(tab)
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (index + 1) % EXTENSION_TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + EXTENSION_TABS.length) % EXTENSION_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = EXTENSION_TABS.length - 1
    if (next === null) return
    event.preventDefault()
    const target = EXTENSION_TABS[next] as ExtensionTab
    setTab(target)
    tabRefs.current[target]?.focus()
  }

  const name = detail?.summary.displayName ?? pluginId

  return (
    <div className="thread-pane settings-editor extension-detail" role="region" aria-label={name} data-plugin-id={pluginId}>
      <PaneHeader title={name} id={pluginId} />
      {detail === undefined ? (
        <p className="extension-detail-body hint">{t('common.loading')}</p>
      ) : detail === null ? (
        <p className="extension-detail-body hint">{t('extensions.notFound')}</p>
      ) : (
        <div className="extension-detail-body">
          <DetailHeading detail={detail} />
          <div className="extension-tabs" role="tablist" aria-label={name} onKeyDown={onTabKey}>
            {EXTENSION_TABS.map((key) => (
              <button
                key={key}
                ref={(el) => {
                  tabRefs.current[key] = el
                }}
                type="button"
                role="tab"
                id={`extension-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`extension-panel-${key}`}
                tabIndex={tab === key ? 0 : -1}
                className={`extension-tab${tab === key ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                {t(TAB_LABELS[key])}
              </button>
            ))}
          </div>
          <div
            className="extension-tab-panel"
            role="tabpanel"
            id={`extension-panel-${tab}`}
            aria-labelledby={`extension-tab-${tab}`}
          >
            {tab === 'overview' ? (
              <OverviewTab detail={detail} />
            ) : tab === 'contributions' ? (
              <ContributionsTab detail={detail} />
            ) : tab === 'permissions' ? (
              <PermissionsTab detail={detail} />
            ) : (
              <RuntimeTab detail={detail} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DetailHeading({ detail }: { readonly detail: PluginDetail }): React.JSX.Element {
  const t = useT()
  const { summary } = detail
  const status = extensionStatus(summary)
  // TODO 460: built-ins can also be disabled individually. Only the last fallback receiver (`required`, aios.text) cannot be pressed.
  const locked = summary.required
  const toggle = (): void => {
    if (locked) return
    void window.aios.plugins.setEnabled(summary.id, !summary.enabled)
  }
  const close = useExtensionPane((state) => state.close)
  /** Whether an uninstall is in progress (so it cannot be pressed twice). */
  const [uninstalling, setUninstalling] = useState(false)
  /** The reason main refused (the exception's sentence; the wording is built at draw time). */
  const [uninstallError, setUninstallError] = useState<string | null>(null)
  const uninstall = (): void => {
    if (uninstalling || summary.bundled) return
    setUninstalling(true)
    setUninstallError(null)
    void window.aios.plugins.uninstall(summary.id).then(
      () => close(),
      (err: unknown) => {
        setUninstalling(false)
        setUninstallError(err instanceof Error ? err.message : String(err))
      }
    )
  }
  const action = (
    <button
      type="button"
      className={`extension-action${locked ? ' disabled' : ''}`}
      aria-disabled={locked ? 'true' : undefined}
      onClick={toggle}
    >
      {summary.enabled ? t('plugins.disable') : t('plugins.enable')}
    </button>
  )
  return (
    <div className="extension-detail-heading">
      <span className="extension-detail-icon">
        <PluginIcon url={summary.iconUrl} size={56} />
      </span>
      <div className="extension-detail-summary">
        <h2 className="extension-detail-name">
          {summary.displayName}
          <span className="extension-detail-version">{summary.version}</span>
        </h2>
        <p className="extension-detail-meta">
          <span>{summary.id}</span>
          {summary.publisher === null ? null : <span>{summary.publisher}</span>}
          <span className="extension-badge">
            {summary.bundled ? t('extensions.badge.builtin') : t('extensions.badge.installed')}
          </span>
          <span className={`extension-status ${status}`}>
            {t(STATUS_LABELS[status], { count: summary.crashes })}
          </span>
        </p>
        <p className="extension-detail-description">
          {summary.description ?? t('extensions.overview.noDescription')}
        </p>
        <div className="extension-detail-actions">
          {locked ? <Tooltip content={t('extensions.disableRequiredHint')}>{action}</Tooltip> : action}
          {summary.bundled ? null : (
            <Tooltip content={t('extensions.uninstallHint')}>
              <button
                type="button"
                className={`extension-action extension-uninstall-action${uninstalling ? ' disabled' : ''}`}
                aria-disabled={uninstalling ? 'true' : undefined}
                onClick={uninstall}
              >
                {t('extensions.uninstall')}
              </button>
            </Tooltip>
          )}
          {/* Do not leave the reason it cannot be pressed only in a popover (TODO 460: it looked like pressing did nothing, silently). */}
          {locked ? <span className="extension-action-note">{t('extensions.disableRequiredHint')}</span> : null}
          {!locked && !summary.enabled ? (
            <span className="extension-action-note">{t('extensions.disabledNote')}</span>
          ) : null}
          {uninstallError === null ? null : (
            <span className="extension-action-note" role="alert">
              {describeReason(t, uninstallError)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function OverviewTab({ detail }: { readonly detail: PluginDetail }): React.JSX.Element {
  const t = useT()
  const { summary } = detail
  return (
    <div className="extension-overview">
      <div className="extension-overview-main">
        <dl className="extension-fields">
          <Field label={t('extensions.overview.id')}>{summary.id}</Field>
          <Field label={t('extensions.overview.name')}>{summary.name}</Field>
          <Field label={t('extensions.overview.version')}>{summary.version}</Field>
          {/* TODO 1144 stage 1: cross-check with the version table of the latest Release's extensions. Stage 2: the "Update" button, in progress, and failure. */}
          <Field label={t('extensions.overview.update')}>
            <UpdateField summary={summary} />
          </Field>
          {summary.publisher === null ? null : (
            <Field label={t('extensions.overview.publisher')}>{summary.publisher}</Field>
          )}
          <Field label={t('extensions.overview.source')}>
            {summary.bundled ? t('extensions.badge.builtin') : t('extensions.badge.installed')}
          </Field>
        </dl>
        {/* TODO 952 stage 1: login for the declared credentials (nothing is shown if there is no declaration). */}
        {detail.enabledReset ? (
          <p className="hint" role="status" data-testid="extension-enabled-reset">
            {t('extensions.overview.enabledReset')}
          </p>
        ) : null}
        <PluginAccountSection pluginId={summary.id} />
        {/* TODO 1225: the `configuration` fields of the manifest (nothing is shown if there is no declaration). */}
        <PluginSettingsSection key={summary.id} pluginId={summary.id} />
        <p className="hint">{t('extensions.overview.isolation')}</p>
      </div>
      <LicensesAside summary={summary} />
    </div>
  )
}

/**
 * TODO 1144 stage 2: the "Update" field. A badge + a description + (only when there is an update and an asset, or the previous attempt failed) the "Update" button.
 * After pressing, it waits until main finishes fetching, validating and replacing. The state (updating / failed) arrives in `summary.update` through the list redistribution.
 * After updating, a sentence is added that open viewers are not closed (reopening gives the new version) (8.5.1).
 */
function UpdateField({ summary }: { readonly summary: PluginDetail['summary'] }): React.JSX.Element {
  const t = useT()
  const info = summary.update
  /** The version this screen finished updating to (the reopen notice is shown). */
  const [updatedTo, setUpdatedTo] = useState<string | null>(null)
  /**
   * The reason main refused without starting the update (wave 73 review). Failures of fetching, validating and replacing arrive as "failed" in `summary.update`,
   * but a refusal before starting (a form that does not run, no asset, in the middle of shutdown, etc.) arrives only as a reject. Shown until the next press.
   * What is held is the exception's sentence; the wording is built at draw time (so it follows a change of display language).
   */
  const [rejected, setRejected] = useState<string | null>(null)
  const run = (): void => {
    if (info.state !== 'available' && info.state !== 'failed') return
    if (!canUpdate(info)) return
    const target = info.latest
    setRejected(null)
    void window.aios.plugins.update(summary.id).then(
      () => setUpdatedTo(target),
      (err: unknown) => setRejected(err instanceof Error ? err.message : String(err))
    )
  }
  return (
    <>
      <span className={`extension-update ${info.state}`} data-update-state={info.state}>
        {updateLabel(t, info)}
      </span>
      {canUpdate(info) ? (
        <button type="button" className="extension-action extension-update-action" onClick={run}>
          {info.state === 'failed' ? t('extensions.update.retry') : t('extensions.update.button')}
        </button>
      ) : null}
      <span className="extension-update-detail">{updateDetail(t, info)}</span>
      {rejected === null ? null : (
        <span className="extension-update-detail extension-update-rejected" role="alert">
          {updateRejectDetail(t, rejected)}
        </span>
      )}
      {updatedTo !== null && summary.version === updatedTo && info.state !== 'failed' ? (
        <span className="extension-update-detail">{t('extensions.update.reopenHint')}</span>
      ) : null}
    </>
  )
}

/**
 * The field to the right of "Overview" (TODO 459, corresponding to Resources / More Info in the VS Code extension detail). The extension's own license, and
 * the third-party libraries that extension bundles in its bundle, with their licenses. The source of truth for the mapping is the lines in `THIRD_PARTY_NOTICES.md` that list the extensions using each library
 * (embedded at build time, `extensionNotices`). The body is not shown as raw Markdown (`InlineMarkdown`, and the full text is in `<pre>`).
 */
function LicensesAside({ summary }: { readonly summary: PluginDetail['summary'] }): React.JSX.Element {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  const notices = extensionNotices(summary.id)
  return (
    <aside className="extension-overview-aside" aria-label={t('extensions.license.title')}>
      <h3>{t('extensions.license.title')}</h3>
      <dl className="extension-fields">
        <Field label={t('extensions.license.self')}>
          {summary.bundled ? t('extensions.license.sameAsApp') : t('extensions.license.notDeclared')}
        </Field>
      </dl>
      <h3>{t('extensions.license.bundledLibraries')}</h3>
      {notices.length === 0 ? (
        <p className="hint extension-licenses-none">{t('extensions.license.none')}</p>
      ) : (
        <ul className="extension-licenses">
          {notices.map((notice) => (
            <li key={notice.heading}>
              <details className="extension-license">
                <summary>
                  <InlineMarkdown text={localizedHeading(notice, locale)} />
                  {notice.license === '' ? null : (
                    <span className="extension-license-name">
                      {' · '}
                      <InlineMarkdown text={notice.license} />
                    </span>
                  )}
                </summary>
                <pre className="extension-license-text">{notice.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

function joinList(values: readonly string[]): string {
  return values.join(', ')
}

function ContributionsTab({ detail }: { readonly detail: PluginDetail }): React.JSX.Element {
  const t = useT()
  const { viewer, commands, mcp, indexer } = detail.contributions
  const empty = viewer === null && commands.length === 0 && !mcp && indexer === null
  if (empty) return <p className="hint">{t('extensions.contrib.none')}</p>
  return (
    <div className="extension-contributions">
      {viewer === null ? null : (
        <section>
          <h3>{t('extensions.contrib.viewer')}</h3>
          <dl className="extension-fields">
            {viewer.extensions.length > 0 ? (
              <Field label={t('extensions.contrib.extensions')}>
                {joinList(viewer.extensions.map((ext) => `.${ext}`))}
              </Field>
            ) : null}
            {viewer.schemes.length > 0 ? (
              <Field label={t('extensions.contrib.schemes')}>
                {joinList(viewer.schemes.map((scheme) => `${scheme}:`))}
              </Field>
            ) : null}
            {viewer.payloads.length > 0 ? (
              <Field label={t('extensions.contrib.payloads')}>
                {joinList(viewer.payloads.map((kind) => t(`extensions.contrib.payload.${kind}`)))}
              </Field>
            ) : null}
            {viewer.fallback ? (
              <Field label={t('extensions.contrib.extensions')}>{t('extensions.contrib.fallback')}</Field>
            ) : null}
            <Field label={t('extensions.contrib.editable')}>
              {viewer.editable ? t('extensions.contrib.editableYes') : t('extensions.contrib.editableNo')}
            </Field>
            <Field label={t('extensions.contrib.priority')}>
              {t('extensions.contrib.priorityValue', { priority: viewer.priority })}
            </Field>
          </dl>
        </section>
      )}
      {commands.length === 0 ? null : (
        <section>
          <h3>{t('extensions.contrib.commands')}</h3>
          <table className="extension-table">
            <tbody>
              {commands.map((command) => (
                <tr key={command.id}>
                  <td className="extension-code">{command.id}</td>
                  <td>{command.title}</td>
                  <td>{command.sideEffect ? t('extensions.contrib.sideEffect') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {mcp ? (
        <section>
          <h3>{t('extensions.contrib.mcp')}</h3>
          <p>{t('extensions.contrib.mcpDeclared')}</p>
        </section>
      ) : null}
      {indexer === null ? null : (
        <section>
          <h3>{t('extensions.contrib.indexer')}</h3>
          <p>
            {indexer.interval === null
              ? t('extensions.contrib.indexerDeclared')
              : t('extensions.contrib.indexerInterval', { interval: indexer.interval })}
          </p>
        </section>
      )}
    </div>
  )
}

function permissionScope(t: Translate, permission: PluginDetail['permissions'][number]): string {
  if (permission.targets.length === 0) {
    if (permission.capability === 'fs') return t('extensions.perm.fsOpened')
    if (permission.capability === 'ui') return t('extensions.perm.uiOnly')
    return '—'
  }
  return permission.targets
    .map((target) =>
      target.mode === null
        ? target.value
        : `${t(target.mode === 'read' ? 'extensions.perm.read' : 'extensions.perm.write')}: ${target.value}`
    )
    .join(', ')
}

function PermissionsTab({ detail }: { readonly detail: PluginDetail }): React.JSX.Element {
  const t = useT()
  const { summary, permissions } = detail
  /** The reason main refused to record consent (wave 86 fix Y: do not make it look as if nothing silently happened). The wording is built at draw time. */
  const [consentError, setConsentError] = useState<string | null>(null)
  const toggle = (capability: PluginDetail['permissions'][number]['capability'], granted: boolean): void => {
    setConsentError(null)
    void window.aios.plugins.setConsent(summary.id, capability, granted).catch((err: unknown) => {
      setConsentError(err instanceof Error ? err.message : String(err))
    })
  }
  return (
    <div className="extension-permissions">
      <p className="hint">{t('extensions.perm.intro')}</p>
      {consentError === null ? null : (
        <p className="extension-action-note" role="alert">
          {describeReason(t, consentError)}
        </p>
      )}
      {permissions.length === 0 ? (
        <p>{t('extensions.perm.none')}</p>
      ) : (
        <table className="extension-table">
          <thead>
            <tr>
              <th>{t('extensions.perm.capability')}</th>
              <th>{t('extensions.perm.scope')}</th>
              <th>{t('extensions.perm.consent')}</th>
            </tr>
          </thead>
          <tbody>
            {permissions.map((permission) => (
              <tr key={permission.capability} data-capability={permission.capability}>
                <td>{t(CAPABILITY_LABELS[permission.capability])}</td>
                <td>{permissionScope(t, permission)}</td>
                <td>
                  <span className={`extension-consent ${permission.consented ? 'granted' : 'denied'}`}>
                    {permission.consented ? t('extensions.perm.granted') : t('extensions.perm.notGranted')}
                  </span>
                  {summary.bundled && !EXPLICIT_CONSENT_CAPABILITIES.has(permission.capability) ? null : (
                    <button
                      type="button"
                      className="extension-consent-toggle"
                      onClick={() => toggle(permission.capability, !permission.consented)}
                    >
                      {permission.consented ? t('extensions.perm.revoke') : t('extensions.perm.grant')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {summary.bundled && permissions.length > 0 ? (
        <p className="hint">{t('extensions.perm.builtinConsent')}</p>
      ) : null}
      {permissions.some((permission) => permission.capability === 'browser') ? (
        <p className="hint">{t('extensions.perm.browserConsent')}</p>
      ) : null}
    </div>
  )
}

function RuntimeTab({ detail }: { readonly detail: PluginDetail }): React.JSX.Element {
  const t = useT()
  const { summary } = detail
  const status = extensionStatus(summary)
  const { entries, reload } = useAudit(AUDIT_LIMIT, summary.id)
  return (
    <div className="extension-runtime">
      <dl className="extension-fields">
        <Field label={t('extensions.runtime.process')}>
          <span className={`extension-status ${status}`}>{t(STATUS_LABELS[status], { count: summary.crashes })}</span>
        </Field>
        <Field label={t('extensions.runtime.crashes')}>
          {summary.host === 'none'
            ? '—'
            : t('extensions.runtime.crashCount', { count: summary.crashes, limit: detail.restartLimit })}
        </Field>
      </dl>
      <div className="extension-audit-heading">
        <h3>{t('extensions.runtime.audit')}</h3>
        <span className="hint">{t('extensions.audit.newest', { count: AUDIT_LIMIT })}</span>
        <span className="viewer-spacer" />
        <button type="button" onClick={reload}>
          {t('extensions.audit.reload')}
        </button>
      </div>
      <AuditList entries={entries} showPlugin={false} />
    </div>
  )
}

/** Reads the audit log. If `pluginId` is passed, only that extension's. */
function useAudit(
  limit: number,
  pluginId?: string
): { readonly entries: readonly AuditEntry[] | null; readonly reload: () => void } {
  const [entries, setEntries] = useState<readonly AuditEntry[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    void window.aios.plugins.audit(limit, pluginId).then(
      (next) => {
        if (!cancelled) setEntries(next)
      },
      () => {
        if (!cancelled) setEntries(NO_ENTRIES)
      }
    )
    return () => {
      cancelled = true
    }
  }, [limit, pluginId, tick])
  const reload = useCallback(() => setTick((value) => value + 1), [])
  return { entries, reload }
}

function AuditList({
  entries,
  showPlugin
}: {
  readonly entries: readonly AuditEntry[] | null
  readonly showPlugin: boolean
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  if (entries === null) return <p className="hint">{t('common.loading')}</p>
  if (entries.length === 0) return <p className="hint">{t('plugins.audit.empty')}</p>
  const tag = locale === 'ja' ? 'ja-JP' : 'en-US'
  return (
    <div className={`audit-log extension-audit${showPlugin ? '' : ' no-plugin'}`}>
      {entries.map((entry, i) => (
        <div key={`${entry.at}-${i}`} className={entry.decision === 'deny' ? 'deny' : ''}>
          <span className="audit-time">{new Date(entry.at).toLocaleString(tag)}</span>
          {showPlugin ? <span className="audit-plugin">{entry.pluginId}</span> : null}
          <span className="audit-op">
            {entry.capability}.{entry.op}
          </span>
          <span className="audit-target">{entry.target ?? ''}</span>
          <span className="audit-decision">
            {entry.decision === 'allow'
              ? t('approval.allow')
              : t('plugins.audit.denied', { reason: entry.reason ?? '' })}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The audit log (overall). Opened from the entry point in the extension view's heading (TODO 367). */
export function AuditLogPane(): React.JSX.Element {
  const t = useT()
  const { entries, reload } = useAudit(AUDIT_ALL_LIMIT)
  return (
    <div className="thread-pane settings-editor extension-detail audit-pane" role="region" aria-label={t('extensions.auditAll')}>
      <PaneHeader title={t('extensions.auditAll')} id={null} />
      <div className="extension-detail-body">
        <div className="extension-audit-heading">
          <span className="hint">{t('extensions.audit.newest', { count: AUDIT_ALL_LIMIT })}</span>
          <span className="viewer-spacer" />
          <button type="button" onClick={reload}>
            {t('extensions.audit.reload')}
          </button>
        </div>
        <AuditList entries={entries} showPlugin />
      </div>
    </div>
  )
}
