/**
 * Settings editor (item 187, ARCHITECTURE.md 5.8. Earlier sections: 4.2 / 4.3.1 / 4.6 / 7.4.1 / 7.4.4 / 12.2).
 *
 * **The form follows VS Code's settings editor**:
 * - It opens in the ThreadPane's place, not as a modal (`App.tsx` watches `useSettingsEditor` and swaps it in).
 * - A search field on top, a table of contents of categories on the left (pressing one scrolls to that category), and a column of items on the right.
 * - One item = title ("category: name", the category faint) -> description -> control, three rows vertically. For a boolean,
 *   the checkbox goes at the start of the description line.
 * - An item changed from the default gets a vertical line at the left edge. The gear menu has "reset to default". The default value is returned by main from
 *   `parse(null)` of each key in `settings-keys.ts` (`settings.snapshot`).
 * - The item table, search and change detection are in `settings-model.ts` (pure functions).
 *
 * **Per-thread settings (retention, deleting this thread's log, strict mode) are not here**;
 * they moved to the thread heading's menu (`ThreadSettingsMenu`). Diagnostic information (the agent CLI version,
 * login, feature table, re-detection) is in the last category, "Info".
 *
 * The authentication method is only displayed, and the UI does not change by method (constraint 3).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeSshHost } from '@shared/ssh-hosts.js'
import {
  DEFAULT_SANDBOX_ALLOWED_DOMAINS,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  normalizeSandboxDomain,
  normalizeSandboxWritePath
} from '@shared/os-sandbox.js'
import { AGENT_FEATURES, capabilitiesOf, isThinkingLevel, type BackendStatusRow } from '@shared/agent.js'
import type { VolumeEntry } from '@shared/types.js'
import type { ApprovalPolicy, ApprovalPolicyPatch, ApprovalRule, ThreadCreateOptions } from '@shared/thread.js'
import { DEFAULT_AUTO_ALLOW_TOOLS } from '@shared/thread.js'
import type { SettingValueKey, SettingValues, SettingsSnapshot } from '@shared/settings.js'
import type { OsSettingsState } from '@shared/os-settings.js'
import { THEME_PREFERENCES, isThemePreference } from '@shared/theme.js'
import { LOCALE_LABEL, LOCALE_PREFERENCES, isLocalePreference } from '@shared/locale.js'
import { EDITOR_IDS, EDITOR_LABELS, isEditorId } from '@shared/editor.js'
import {
  VOICE_LOCALE_PREFERENCES,
  isVoiceLocalePreference,
  type VoiceLocalePreference
} from '@shared/voice-locale.js'
import { GMAIL_DRAFT_FONTS, isGmailDraftFont, type GmailDraftFont } from '@shared/gmail-draft-font.js'
import { shortFingerprint, type TrustedCertificate } from '@shared/web-certs.js'
import type { LoginSite } from '@shared/web-login-sites.js'
import type { ViewerAssociationEntry } from '@shared/plugin.js'
import { useThreads } from '../threadStore.js'
import { useStore } from '../store.js'
import { DATA_NAME } from '@shared/product.js'
import { useTheme } from '../themeStore.js'
import { useLocale } from '../localeStore.js'
import { useEditor } from '../editorStore.js'
import { useSettingsEditor } from '../settingsEditorStore.js'
import { useSettingsJump } from '../settingsJump.js'
import { BackendCapabilityList } from './BackendCapabilityList.js'
import { LocalModelAdvice } from './LocalModelAdvice.js'
import { BuildInfoSection } from './BuildInfoSection.js'
import { DataTransferControl } from './DataTransferControl.js'
import { BackupControl } from './BackupControl.js'
import { describeReason, useT, type Translate } from '../i18n/index.js'
import { formatWhen } from '../thread/timeline.js'
import {
  listedModelChoices,
  modelChoiceLabel,
  resolveModelChoice,
  resolveThinkingChoice,
  thinkingLabel,
  thinkingSelectLevels
} from '../composer-choice.js'
import {
  SETTINGS_ITEMS,
  categoriesOf,
  currentCategory,
  filterSettingsItems,
  isModified,
  type SettingsCategory,
  type SettingsItem
} from '../settings-model.js'
import { Tooltip } from './Tooltip.js'
import { McpSettings } from './McpSettings.js'
import { SkillSettings } from './SkillSettings.js'
import { ShortcutSettings } from './ShortcutSettings.js'
import { UsageSection } from './UsageSection.js'
import { UnattendedAuthGuide } from './UnattendedAuthGuide.js'
import { MenuPopover } from './MenuPopover.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { SettingsIcon } from '../icons/SettingsIcon.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { AUTO_SAVE_MODES, MAX_AUTO_SAVE_DELAY_MS, MIN_AUTO_SAVE_DELAY_MS, isAutoSaveMode } from '@shared/auto-save.js'
import { initAutoSave, useAutoSave } from '../autoSaveStore.js'
import { FILE_SORT_ORDERS, isFileSortOrder } from '@shared/file-sort.js'
import { initFileSort, useFileSort } from '../fileSortStore.js'
import { initRedmine, useRedmine } from '../redmineStore.js'
import { normalizeRedmineBase } from '@shared/redmine-link.js'
import { initThreadCollapse, useThreadCollapse } from '../threadCollapseStore.js'
import {
  MAX_COLLAPSE_OLD_AFTER_DAYS,
  MIN_COLLAPSE_OLD_AFTER_DAYS
} from '@shared/thread-collapse.js'
import { initUpdate, useUpdate } from '../updateStore.js'
import type { UpdateStatus } from '@shared/update.js'
import { initAgentUpdate, useAgentUpdate } from '../agentUpdateStore.js'
import type { AgentUpdateStatus } from '@shared/agent-update.js'
import { formatReason } from '@shared/reason.js'

/** Measured in spike 5. Attached to the explanation of the parallel count. */
const RSS_PER_SESSION_MB = 410

/** The same habit as zustand: make the empty array a module constant to keep the reference stable. */
const NO_VOLUMES: readonly VolumeEntry[] = []
const NO_RULES: readonly ApprovalRule[] = []

/** The DOM id of a heading. The target the table of contents jumps to. */
function categoryAnchor(category: SettingsCategory): string {
  return `settings-category-${category}`
}

/** The string an item is searched against (only the display-language dictionary, same as VS Code). */
function searchTextOf(t: Translate, entry: SettingsItem): string {
  return [
    t(`settings.category.${entry.category}`),
    t(`settings.item.${entry.id}.title`),
    t(`settings.item.${entry.id}.description`, { mb: RSS_PER_SESSION_MB }),
    entry.storageKey ?? ''
  ].join('\n')
}

// Frame of one item

function SettingsItemView({
  entry,
  modified,
  onReset,
  checkbox,
  children
}: {
  entry: SettingsItem
  modified: boolean
  onReset: (() => void) | null
  /** The checkbox of an item with `kind === 'checkbox'`. */
  checkbox?: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useT()
  const description = t(`settings.item.${entry.id}.description`, { mb: RSS_PER_SESSION_MB })
  return (
    <div className={`settings-item${modified ? ' modified' : ''}`} data-setting={entry.id}>
      {modified ? (
        <span className="settings-item-modified" title={t('settings.modified')} aria-hidden="true" />
      ) : null}
      <div className="settings-item-title">
        {onReset === null ? null : (
          <MenuPopover
            className="settings-item-gear"
            label={t('settings.moreActions')}
            icon={<SettingsIcon />}
          >
            {(close) => (
              <button
                type="button"
                role="menuitem"
                disabled={!modified}
                onClick={() => {
                  close()
                  onReset()
                }}
              >
                {t('settings.reset')}
              </button>
            )}
          </MenuPopover>
        )}
        <span className="settings-item-category">{t(`settings.category.${entry.category}`)}: </span>
        <span className="settings-item-name">{t(`settings.item.${entry.id}.title`)}</span>
        {modified ? <span className="visually-hidden"> ({t('settings.modified')})</span> : null}
      </div>
      {checkbox !== undefined ? (
        <label className="settings-item-description settings-item-checkbox">
          <input
            type="checkbox"
            checked={checkbox.checked}
            disabled={checkbox.disabled}
            onChange={(event) => checkbox.onChange(event.target.checked)}
          />
          <span>{description}</span>
        </label>
      ) : (
        <div className="settings-item-description">{description}</div>
      )}
      {children === undefined ? null : <div className="settings-item-control">{children}</div>}
    </div>
  )
}

// Parts for lists and info (an item with a single value is drawn directly inside Settings)

/** Permission for external storage (4.4.2 "External storage"). The list is fetched from main when opened. */
function VolumeList(): React.JSX.Element {
  const t = useT()
  const [volumes, setVolumes] = useState<readonly VolumeEntry[]>(NO_VOLUMES)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void window.aios.fs.volumes().then(setVolumes)
  }, [])

  const toggle = (entry: VolumeEntry): void => {
    setBusy(entry.uri)
    void window.aios.fs
      .setVolumeAllowed(entry.uri, !entry.allowed)
      .then(setVolumes)
      .catch(() => window.aios.fs.volumes().then(setVolumes))
      .finally(() => setBusy(null))
  }

  if (volumes.length === 0) return <p className="hint">{t('settings.volumes.none')}</p>
  return (
    <ul className="volume-list">
      {volumes.map((entry) => (
        <li key={entry.uri} className={entry.mounted ? 'mounted' : 'unmounted'}>
          <label>
            <input
              type="checkbox"
              checked={entry.allowed}
              disabled={busy !== null || (!entry.mounted && !entry.allowed)}
              onChange={() => toggle(entry)}
            />
            <span className="volume-name">{entry.name}</span>
            {!entry.mounted ? <span className="hint">{t('settings.volumes.unmounted')}</span> : null}
            {entry.uuidMismatch ? (
              <span className="denied">{t('settings.volumes.uuidMismatch')}</span>
            ) : null}
          </label>
        </li>
      ))}
    </ul>
  )
}

/**
 * Deferral of protected folders (Desktop / Documents / Downloads) (TODO 805). The state reads the scan state (`ScanStatus.tccDeferredUntil`)
 * as it is. Pressing "include now" makes the index process end the deferral, and the display changes on the state notification.
 */
function ProtectedFolders(): React.JSX.Element {
  const t = useT()
  const until = useStore((state) => state.scan?.tccDeferredUntil ?? null)
  const [busy, setBusy] = useState(false)
  if (until === null) return <p className="hint">{t('settings.protectedFolders.included')}</p>
  return (
    <div className="settings-actions">
      <span className="hint">{t('settings.protectedFolders.deferred', { date: new Date(until).toLocaleString() })}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void window.aios.fs.includeProtectedFolders().finally(() => setBusy(false))
        }}
      >
        {t('settings.protectedFolders.includeNow')}
      </button>
    </div>
  )
}

/**
 * Rules created by "always allow" (item 163, app-wide in T40). They apply only to requests that do not pass the default allowance
 * (threads in strict mode, and Bash commands matching a stop pattern). There is no expiry.
 */
function AlwaysAllowedList(): React.JSX.Element {
  const t = useT()
  const [rules, setRules] = useState<readonly ApprovalRule[]>(NO_RULES)
  const load = useCallback((): void => {
    void window.aios.approvals.rules().then(setRules)
  }, [])
  useEffect(load, [load])

  if (rules.length === 0) return <p className="hint">{t('settings.approval.rulesEmpty')}</p>
  return (
    <div className="approval-rules">
      <ul>
        {rules.map((rule) => (
          <li key={rule.id}>
            <span className="approval-tool">{rule.toolName}</span>
            {rule.command !== null ? (
              <span className="approval-summary" title={rule.command}>
                {rule.command}
                {rule.hashHead !== undefined ? <span className="hint"> #{rule.hashHead}</span> : null}
              </span>
            ) : (
              <span className="approval-summary hint">{t('approval.ruleAllOfTool')}</span>
            )}
            <span className="approval-when" title={new Date(rule.createdAt).toLocaleString()}>
              {formatWhen(rule.createdAt, t)}
            </span>
            <button
              type="button"
              className="link"
              title={t('approval.removeRuleHint')}
              onClick={() => void window.aios.approvals.removeRule(rule.id).then(load)}
            >
              {t('approval.removeRule')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Destinations that are not asked about (TODO 1029). A list of `host` / `user@host`, with a field to add and a button to remove. Normalization and re-validation are in main
 * (`setApprovalPolicy`). If a value is dropped because it cannot be read, one short line is shown under the field. **It is sent to main as a diff of adds and removes**:
 * sending the whole list would erase, with the stale list from when the page was opened, the hosts added by "never ask about this host again" in an approval frame or in another window
 * (the same reason as the review of 1013's push destination).
 */
/** The bundle of text keys of the list (`<prefix>.none` / `.placeholder` / `.removeHint` / `.invalid`). The add and remove buttons are shared. */
type AllowListTexts = 'settings.sshHosts' | 'settings.sandboxDomains' | 'settings.sandboxWrite'

/**
 * Add and remove for a list of strings (destinations not asked about, TODO 1029; the OS sandbox's allow tables, TODO 1106). A value for which `normalize` returns null is not added
 * (main also re-validates).
 */
function SshHostList({
  hosts,
  addHost,
  removeHost,
  normalize = normalizeSshHost,
  texts = 'settings.sshHosts',
  notice = null
}: {
  hosts: readonly string[]
  addHost: (host: string) => void
  removeHost: (host: string) => void
  normalize?: (raw: string) => string | null
  texts?: AllowListTexts
  /** A one-line notice for what main dropped before saving (next to the `invalid` message on adding, shown the same way). */
  notice?: string | null
}): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = (): void => {
    const typed = text.trim()
    if (typed === '') return
    const host = normalize(typed)
    if (host === null) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setText('')
    addHost(host)
  }
  return (
    <div className="allow-list">
      {hosts.length === 0 ? (
        <p className="hint">{t(`${texts}.none`)}</p>
      ) : (
        <ul className="allow-list-items">
          {hosts.map((host) => (
            <li key={host}>
              <span className="allow-list-value" title={host}>
                {host}
              </span>
              <button type="button" className="link" title={t(`${texts}.removeHint`)} onClick={() => removeHost(host)}>
                {t('settings.sshHosts.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="allow-list-add">
        <input
          type="text"
          spellCheck={false}
          placeholder={t(`${texts}.placeholder`)}
          aria-label={t(`${texts}.placeholder`)}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
        />
        <button type="button" onClick={add} disabled={text.trim() === ''}>
          {t('settings.sshHosts.add')}
        </button>
      </div>
      {invalid ? <p className="hint">{t(`${texts}.invalid`)}</p> : null}
      {notice !== null ? <p className="hint">{notice}</p> : null}
    </div>
  )
}

/** History of working directories. Fetched from the same entry point as the creation dialog (`createOptions`). */
function CwdHistoryList({
  options,
  reload
}: {
  options: ThreadCreateOptions | null
  reload: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      {options === null ? null : options.cwdHistory.length === 0 ? (
        <p className="hint">{t('settings.cwdHistory.none')}</p>
      ) : (
        <ul className="cwd-history">
          {options.cwdHistory.map((entry) => (
            <li key={entry.uri} className={entry.usable ? '' : 'unusable'} title={entry.uri}>
              <span className="cwd-name">{entry.name}</span>
              {entry.parentName !== '' ? (
                <span className="cwd-parent">{t('cwd.inParent', { parent: entry.parentName })}</span>
              ) : null}
              {!entry.usable ? (
                <span className="cwd-reason">{describeReason(t, entry.reason)}</span>
              ) : null}
              <button
                type="button"
                className="cwd-remove"
                title={t('cwd.removeFromHistory')}
                onClick={() => void window.aios.threads.removeCwdHistory(entry.uri).then(reload)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-actions">
        <button
          type="button"
          className="danger"
          disabled={options === null || options.cwdHistory.length === 0}
          onClick={() => void window.aios.threads.clearCwdHistory().then(reload)}
        >
          {t('settings.cwdHistory.clearAll')}
        </button>
      </div>
    </>
  )
}

/**
 * TODO 907: a viewer per extension (VS Code's `workbench.editorAssociations`). The list of ones chosen with "open with another viewer", and
 * "reset to default" per extension / for all. The value is held by main (`ViewerAssociations`) and fetched when opened.
 */
function ViewerAssociationList(): React.JSX.Element {
  const t = useT()
  const [list, setList] = useState<readonly ViewerAssociationEntry[] | null>(null)
  useEffect(() => {
    // Stays empty in a fake window.aios that has no such entry point (the settings editor's tests).
    if (window.aios.viewer?.associations === undefined) {
      setList([])
      return
    }
    let live = true
    void window.aios.viewer.associations().then(
      (next) => {
        if (live) setList(next)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  const reset = (ext: string | null): void => {
    void window.aios.viewer.resetAssociation(ext).then(setList, () => undefined)
  }
  if (list === null) return <></>
  if (list.length === 0) return <p className="hint">{t('settings.viewerAssociations.none')}</p>
  return (
    <>
      <ul className="viewer-associations">
        {list.map((entry) => (
          <li key={entry.ext}>
            <span className="viewer-association-ext">.{entry.ext}</span>
            <span className="viewer-association-name">{entry.name}</span>
            {entry.valid ? null : <span className="hint">{t('settings.viewerAssociations.unavailable')}</span>}
            <button type="button" className="viewer-association-reset" onClick={() => reset(entry.ext)}>
              {t('settings.reset')}
            </button>
          </li>
        ))}
      </ul>
      <div className="settings-actions">
        <button type="button" onClick={() => reset(null)}>
          {t('settings.viewerAssociations.resetAll')}
        </button>
      </div>
    </>
  )
}

/** TODO 1055 (2): the state of consent for the AI reading the body of a Web tab, and revoking it. */
function WebTabReadConsent(): React.JSX.Element {
  const t = useT()
  const [granted, setGranted] = useState<boolean | null>(null)
  useEffect(() => {
    // Stays unconsented in a fake window.aios that has no such entry point (the settings editor's tests).
    if (window.aios.web?.tabReadConsent === undefined) {
      setGranted(false)
      return
    }
    let live = true
    void window.aios.web.tabReadConsent().then(
      (next) => {
        if (live) setGranted(next)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  if (granted === null) return <></>
  if (!granted) return <p className="hint">{t('settings.webTabRead.none')}</p>
  return (
    <p>
      <span>{t('settings.webTabRead.granted')}</span>{' '}
      <button type="button" className="link" onClick={() => void window.aios.web.revokeTabReadConsent().then(setGranted)}>
        {t('settings.webTabRead.revoke')}
      </button>
    </p>
  )
}

/** TODO 547: the list of certificates (host + fingerprint) trusted in the Web view, and revoking them. */
function TrustedCertificateList(): React.JSX.Element {
  const t = useT()
  const [list, setList] = useState<readonly TrustedCertificate[] | null>(null)
  useEffect(() => {
    // Stays empty in a fake window.aios that has no such entry point (the settings editor's tests).
    if (window.aios.web?.trustedCertificates === undefined) {
      setList([])
      return
    }
    let live = true
    void window.aios.web.trustedCertificates().then(
      (next) => {
        if (live) setList(next)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  if (list === null) return <></>
  if (list.length === 0) return <p className="hint">{t('settings.certificates.none')}</p>
  return (
    <ul className="trusted-certificates">
      {list.map((entry) => (
        <li key={entry.host} title={entry.fingerprint}>
          <span className="trusted-certificate-host">{entry.host}</span>
          <span className="trusted-certificate-fingerprint">{shortFingerprint(entry.fingerprint)}</span>
          <span className="hint">
            {t('settings.certificates.addedAt', { date: new Date(entry.addedAt).toLocaleDateString() })}
          </span>
          <button
            type="button"
            className="trusted-certificate-revoke"
            onClick={() => void window.aios.web.revokeCertificate(entry.host).then(setList)}
          >
            {t('settings.certificates.revoke')}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * TODO 697: the list of sites logged in on the Web view (hosts that have cookies, per registrable domain).
 * "Clear" for each site clears immediately with no dialog (167). "Clear all" logs out of every site at once, so
 * after pressing it there is a two-step "really clear / cancel" in place (inline, the same shape as `thread-row-confirm`).
 */
function LoginSiteList(): React.JSX.Element {
  const t = useT()
  const [list, setList] = useState<readonly LoginSite[] | null>(null)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [failed, setFailed] = useState(false)
  // Fix from code-review: if clearing fails (it may have partly cleared), re-fetch the list and show a short message.
  const runClear = (clear: () => Promise<readonly LoginSite[]>): void => {
    setFailed(false)
    void clear().then(setList, () => {
      setFailed(true)
      void window.aios.web.loginSites().then(setList, () => undefined)
    })
  }
  useEffect(() => {
    // Stays empty in a fake window.aios that has no such entry point (the settings editor's tests).
    if (window.aios.web?.loginSites === undefined) {
      setList([])
      return
    }
    let live = true
    void window.aios.web.loginSites().then(
      (next) => {
        if (live) setList(next)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  if (list === null) return <></>
  return (
    <>
      {list.length === 0 ? (
        <p className="hint">{t('settings.loginSites.none')}</p>
      ) : (
        <ul className="login-sites">
          {list.map((entry) => (
            <li key={entry.domain}>
              <span className="login-site-domain">{entry.domain}</span>
              <span className="hint">
                {entry.hostCount > 1
                  ? t('settings.loginSites.hosts', { count: entry.hostCount })
                  : null}
              </span>
              <button
                type="button"
                className="login-site-clear"
                onClick={() => runClear(() => window.aios.web.clearLoginSite(entry.domain))}
              >
                {t('settings.loginSites.clear')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <p className="hint login-sites-failed" role="status">
          {t('settings.loginSites.clearFailed')}
        </p>
      ) : null}
      <div className="settings-actions">
        {confirmingAll ? (
          <span className="login-sites-confirm-all">
            <span>{t('settings.loginSites.clearAllConfirm')}</span>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirmingAll(false)
                runClear(() => window.aios.web.clearAllLoginSites())
              }}
            >
              {t('settings.loginSites.clearAll')}
            </button>
            <button type="button" onClick={() => setConfirmingAll(false)}>
              {t('common.cancel')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="danger"
            disabled={list.length === 0}
            onClick={() => setConfirmingAll(true)}
          >
            {t('settings.loginSites.clearAll')}
          </button>
        )}
      </div>
    </>
  )
}

/** Diagnostics of the agent CLI (4.6). The authentication method is only shown (constraint 3). */
function AgentInfo(): React.JSX.Element {
  const t = useT()
  const agent = useThreads((state) => state.agent)
  const [busy, setBusy] = useState(false)

  if (agent === null) return <p className="hint">{t('settings.agent.checking')}</p>
  if (!agent.available) {
    return <p className="denied">{describeReason(t, agent.messageCode) || agent.message}</p>
  }
  return (
    <>
      <p>
        {t('settings.agent.version', { version: agent.version ?? '' })} /{' '}
        {agent.loggedIn ? t('settings.agent.loggedIn') : t('settings.agent.notLoggedIn')}
        {agent.authMethod === null ? '' : ` (${agent.authMethod}`}
        {agent.subscriptionType === null ? '' : ` · ${agent.subscriptionType}`}
        {agent.authMethod === null ? '' : ')'}
      </p>
      <p className="hint">
        {t('settings.agent.source', {
          source:
            agent.source === 'known-version'
              ? t('settings.agent.sourceKnown')
              : agent.needsProbe
                ? t('settings.agent.sourcePending')
                : t('settings.agent.sourceProbe')
        })}
      </p>
      <BackendCapabilityList capabilities={capabilitiesOf(agent.features)} />
      {/* TODO 987 review Y-5: the table of 4 items is the main thing. The list of all features overlaps in information, so it is collapsed (closed by default). */}
      <details className="feature-details">
        <summary>{t('settings.agent.featuresDetail')}</summary>
        <ul className="feature-list">
          {AGENT_FEATURES.map((feature) => (
            <li key={feature} className={agent.features[feature] ? 'on' : 'off'}>
              {agent.features[feature] ? '✓' : '×'} {feature}
            </li>
          ))}
        </ul>
      </details>
      {agent.degradations.length > 0 ? (
        <ul className="degradations">
          {agent.degradations.map((d) => (
            <li key={d.feature}>
              {d.feature}: {describeReason(t, d.code) || d.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="settings-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.aios.agent.recheck().finally(() => setBusy(false))
          }}
        >
          {t('settings.agent.recheck')}
        </button>
      </div>
    </>
  )
}

/**
 * TODO 1019: the state of non-default backends: version, whether usable, and the reason. If not found, how to install it;
 * when usable, one auxiliary line (e.g. the state of a local model, `messageCode`). It only guides and runs nothing.
 */
function OtherBackendsInfo(): React.JSX.Element | null {
  const t = useT()
  const [rows, setRows] = useState<readonly BackendStatusRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback((force: boolean) => {
    setBusy(true)
    void window.aios.agent
      .backends(force)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setBusy(false))
  }, [])
  useEffect(() => load(false), [load])

  const others = (rows ?? []).filter((row) => !row.primary)
  if (others.length === 0) return null
  return (
    <>
      {others.map((row) => (
        <div key={row.id} className="backend-status">
          <p>
            <strong>{row.label}</strong>{' '}
            {row.status.available ? (
              t('settings.agent.version', { version: row.status.version ?? '' })
            ) : (
              <span className="denied">{describeReason(t, row.status.messageCode) || row.status.message}</span>
            )}
          </p>
          {row.status.available && row.status.messageCode !== null ? (
            <p className="hint">{describeReason(t, row.status.messageCode)}</p>
          ) : null}
          {/* TODO 1066: recommendations for this PC (the fetch and context length only when pressed). Nothing is shown for a backend without them. */}
          {row.status.available ? <LocalModelAdvice backendId={row.id} /> : null}
          {/* TODO 987: what it can do (what it cannot is grayed out). */}
          {row.status.available ? <BackendCapabilityList capabilities={capabilitiesOf(row.status.features)} /> : null}
          {/* TODO 529 stage 2: guidance on providers (usable / what to do to use one). */}
          {row.status.available
            ? (row.status.notes ?? []).map((note) => (
                <p key={note} className="hint">
                  {describeReason(t, note)}
                </p>
              ))
            : null}
        </div>
      ))}
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => load(true)}>
          {t('settings.agent.recheck')}
        </button>
      </div>
    </>
  )
}

/** The sentence showing the version (per `phase`). If empty, nothing is shown. */
function describeUpdatePhase(t: Translate, status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return t('update.phase.checking')
    case 'downloading':
      return t('update.phase.downloading', { version: status.latest ?? '' })
    case 'up-to-date':
      return t('update.phase.upToDate')
    case 'available':
      return t('update.phase.available', { version: status.latest ?? '' })
    case 'held':
      return t('update.phase.held', { version: status.latest ?? '' })
    case 'staged':
      return t(status.auto ? 'update.phase.staged' : 'update.phase.stagedManual', { version: status.staged ?? '' })
    case 'failed':
      // TODO 1213: "Release not found" (none yet, or the repo is not visible from the gh login) is not a breakage, so
      // show only a calm sentence without "the update failed". The text says what to look at next (gh auth status).
      if (status.failure === 'update-no-release') return describeReason(t, status.failure) || ''
      return t('update.phase.failed', { reason: describeReason(t, status.failure) || '' })
    case 'idle':
      return ''
  }
}

/**
 * TODO 103: the current version and the latest version, "Check for updates" ("Install" if auto-update is OFF, and "Restart to update" after installing).
 * The version string is the `package.json` version, the same as the BottomBar badge and About (316). In a form where it does not work (such as a dev shell) only the reason is shown.
 */
function UpdateInfo({ status }: { status: UpdateStatus | null }): React.JSX.Element | null {
  const t = useT()
  const check = useUpdate((state) => state.check)
  const install = useUpdate((state) => state.install)
  const restart = useUpdate((state) => state.restart)
  // TODO 1263: the keychain item is named after this machine's data name (`aios` or `Temoto`).
  const dataName = useStore((state) => state.appInfo?.dataName ?? DATA_NAME)
  if (status === null) return null
  const working = status.phase === 'checking' || status.phase === 'downloading'
  const phase = status.supported ? describeUpdatePhase(t, status) : ''
  return (
    <div className="update-info">
      <p>
        {t('update.current', { version: status.current })}
        {' / '}
        {status.latest === null
          ? t('update.latestUnknown')
          : t('update.latest', { version: status.latest })}
        {status.checkedAt === null ? null : (
          <span className="hint"> ({t('update.checkedAt', { when: new Date(status.checkedAt).toLocaleString() })})</span>
        )}
      </p>
      {status.supported ? null : (
        <p className="hint">{t(`update.unsupported.${status.unsupportedReason ?? 'not-installed'}`)}</p>
      )}
      {status.supported && status.held !== null ? (
        <p className="hint update-held">{t('update.held', { version: status.held })}</p>
      ) : null}
      {status.supported ? (
        <p className="hint">{t(status.auto ? 'update.schedule' : 'update.scheduleOff')}</p>
      ) : null}
      {phase === '' ? null : (
        <p className={status.phase === 'failed' && status.failure !== 'update-no-release' ? 'denied' : 'hint'} aria-live="polite">
          {phase}
        </p>
      )}
      {status.supported && status.staged !== null ? (
        <>
          {status.stagedAt === null ? null : (
            <p className="hint">{t('update.stagedAt', { when: new Date(status.stagedAt).toLocaleString() })}</p>
          )}
          {status.auto && status.waiting !== null ? (
            <p className="hint" aria-live="polite">
              {t('update.waiting', { reason: describeReason(t, status.waiting) || '' })}
            </p>
          ) : null}
          {status.auto ? <p className="hint">{t('update.applyWhen')}</p> : null}
        </>
      ) : null}
      {status.supported && status.staged !== null && status.keychainPromptExpected ? (
        <div className="hint update-keychain">
          <p>{t('update.keychain.intro', { keychainItem: `${dataName} Safe Storage` })}</p>
          <p>{t('update.keychain.why')}</p>
          <ul>
            <li>
              <strong>{t('update.keychain.always')}</strong>: {t('update.keychain.alwaysBody')}
            </li>
            <li>
              <strong>{t('update.keychain.allow')}</strong>: {t('update.keychain.allowBody')}
            </li>
            <li>
              <strong>{t('update.keychain.deny')}</strong>: {t('update.keychain.denyBody')}
            </li>
          </ul>
        </div>
      ) : null}
      <div className="settings-actions">
        <button type="button" disabled={!status.supported || working} onClick={() => void check()}>
          {t('update.check')}
        </button>
        {status.supported && status.phase === 'available' ? (
          <button type="button" disabled={working} onClick={() => void install()}>
            {t('update.install')}
          </button>
        ) : null}
        {status.supported && status.staged !== null ? (
          <button type="button" onClick={() => void restart()}>
            {t('update.restart')}
          </button>
        ) : null}
        {/* TODO 1213: only on failure, open the log folder (the existing entry point of TODO 376). Retry is "Check for updates" above. */}
        {status.supported && status.phase === 'failed' && status.failure !== 'update-no-release' ? (
          <button type="button" onClick={() => void window.aios.editor.revealLogs()}>
            {t('build.openLogs')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The "next automatic check" sentence (code-review of TODO 1143). While it is running, it shows "checking" instead of a past time, and
 * while waiting for the next tick after the deadline has passed, "soon".
 */
function describeNextCheck(t: Translate, phase: AgentUpdateStatus['phase'], nextCheckAt: number, now: number): string {
  if (phase === 'updating' || phase === 'reverting') return t('agentUpdate.checkingNow')
  if (nextCheckAt <= now) return t('agentUpdate.nextCheckSoon')
  return t('agentUpdate.nextCheck', { when: new Date(nextCheckAt).toLocaleString() })
}

/** The sentence for the stage of the agent CLI's update (per `phase`). If empty, nothing is shown. */
function describeAgentUpdatePhase(t: Translate, status: AgentUpdateStatus): string {
  switch (status.phase) {
    case 'updating':
      return t('agentUpdate.phase.updating')
    case 'reverting':
      return t('agentUpdate.phase.reverting', { version: status.revertTo ?? status.lastUpdate?.from ?? '' })
    case 'up-to-date':
      return t('agentUpdate.phase.upToDate')
    case 'updated':
      return status.lastUpdate === null
        ? t('agentUpdate.phase.upToDate')
        : t('agentUpdate.phase.updated', { from: status.lastUpdate.from, to: status.lastUpdate.to })
    case 'reverted':
      return t('agentUpdate.phase.reverted', { version: status.current ?? '' })
    case 'failed':
      return t('agentUpdate.phase.failed', {
        reason: describeReason(t, status.failure === null ? null : formatReason(status.failure, status.failureParams ?? undefined)) || ''
      })
    case 'idle':
      return ''
  }
}

/**
 * TODO 774: updating the agent CLI itself. The current version ("unverified version" if it is not in the table), "Update now", and
 * "Roll back to the previous version" only when the check after the upgrade failed. In a form where it does not work (a duplicate, dev, a fake backend) only the reason is shown.
 */
function AgentUpdateInfo({ status }: { status: AgentUpdateStatus | null }): React.JSX.Element | null {
  const t = useT()
  const run = useAgentUpdate((state) => state.run)
  const revert = useAgentUpdate((state) => state.revert)
  if (status === null) return null
  const working = status.phase === 'updating' || status.phase === 'reverting'
  const phase = status.supported ? describeAgentUpdatePhase(t, status) : ''
  return (
    <div className="update-info">
      <p>
        {status.current === null
          ? t('agentUpdate.currentUnknown')
          : t('agentUpdate.current', { version: status.current })}
        {status.unverified ? <span className="denied"> {t('agentUpdate.unverified')}</span> : null}
        {status.checkedAt === null ? null : (
          <span className="hint"> ({t('update.checkedAt', { when: new Date(status.checkedAt).toLocaleString() })})</span>
        )}
      </p>
      {status.unverified ? <p className="hint">{t('agentUpdate.unverifiedHint')}</p> : null}
      {status.supported ? null : (
        <p className="hint">{t(`agentUpdate.unsupported.${status.unsupportedReason ?? 'instance'}`)}</p>
      )}
      {status.supported && status.heldFrom !== null ? (
        <p className="hint">{t('agentUpdate.held', {
            version: status.heldFrom,
            date: status.heldUntil === null ? '' : new Date(status.heldUntil).toLocaleDateString()
          })}</p>
      ) : null}
      {status.supported && status.heldFrom === null && status.autoBlockedByBackend && status.auto ? (
        <p className="hint">{t('agentUpdate.blockedByBackend')}</p>
      ) : null}
      {phase === '' ? null : (
        <p className={status.phase === 'failed' ? 'denied' : 'hint'} aria-live="polite">
          {phase}
        </p>
      )}
      {status.supported && status.auto && status.waiting !== null ? (
        <p className="hint">{t('agentUpdate.waiting.hint')}</p>
      ) : null}
      {status.supported && status.auto && status.waiting === null && status.nextCheckAt !== null ? (
        <p className="hint">{describeNextCheck(t, status.phase, status.nextCheckAt, Date.now())}</p>
      ) : null}
      {status.supported && status.revertTo !== null ? (
        <p className="denied">{t('agentUpdate.verifyFailed', { version: status.revertTo })}</p>
      ) : null}
      <div className="settings-actions">
        <button type="button" disabled={!status.supported || working} onClick={() => void run()}>
          {t('agentUpdate.run')}
        </button>
        {status.supported && status.revertTo !== null ? (
          <button type="button" disabled={working} onClick={() => void revert()}>
            {t('agentUpdate.revert', { version: status.revertTo })}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// The settings editor itself

export function Settings(): React.JSX.Element {
  const t = useT()
  const close = useSettingsEditor((state) => state.close)
  const settings = useThreads((state) => state.settings)
  const setSettings = useThreads((state) => state.setSettings)
  const themePreference = useTheme((state) => state.preference)
  const themeResolved = useTheme((state) => state.resolved)
  const setTheme = useTheme((state) => state.setPreference)
  const localePreference = useLocale((state) => state.preference)
  const localeResolved = useLocale((state) => state.resolved)
  const setLocale = useLocale((state) => state.setPreference)
  const editorId = useEditor((state) => state.id)
  const setEditor = useEditor((state) => state.setId)
  // TODO 555: the viewer's auto-save. One source in main (`autoSaveStore.ts`); a change is notified to all windows.
  const autoSaveMode = useAutoSave((state) => state.mode)
  const autoSaveDelayMs = useAutoSave((state) => state.delayMs)
  const updateAutoSave = useAutoSave((state) => state.update)
  useEffect(() => initAutoSave(), [])
  // TODO 659: the number of days for folding the thread list. One source in main (`threadCollapseStore.ts`); a change is notified to all windows.
  const threadCollapseDays = useThreadCollapse((state) => state.days)
  const updateThreadCollapseDays = useThreadCollapse((state) => state.update)
  useEffect(() => initThreadCollapse(), [])
  // TODO 872: the order of the file tree. One source in main (`fileSortStore.ts`). Re-fetching is handled by the tree side (`store.ts`).
  const fileSortOrder = useFileSort((state) => state.order)
  const updateFileSortOrder = useFileSort((state) => state.update)
  useEffect(() => {
    void initFileSort(() => undefined)
  }, [])
  // TODO 811: Redmine's base URL. One source in main (`redmineStore.ts`). The text being typed is held until it is committed (blur / Enter).
  const redmineBaseUrl = useRedmine((state) => state.baseUrl)
  const updateRedmine = useRedmine((state) => state.update)
  useEffect(() => initRedmine(), [])
  const [redmineText, setRedmineText] = useState<string | null>(null)
  const [redmineInvalid, setRedmineInvalid] = useState(false)
  /** The text being typed for the folding days (committed on blur / Enter). */
  const [collapseDaysText, setCollapseDaysText] = useState<string | null>(null)
  // TODO 103: auto-update. One source in main (`updateStore.ts`); a change of state is notified to all windows.
  const updateStatus = useUpdate((state) => state.status)
  const setAutoUpdate = useUpdate((state) => state.setAuto)
  useEffect(() => initUpdate(), [])
  // TODO 774: updating the agent CLI itself. One source in main (`agentUpdateStore.ts`).
  const agentUpdateStatus = useAgentUpdate((state) => state.status)
  const setAgentAutoUpdate = useAgentUpdate((state) => state.setAuto)
  const agentUpdateJumpSeq = useAgentUpdate((state) => state.jumpSeq)
  // TODO 1060 stage 2: the request "show this item" that came from the gateway's openSettings (`settingsJump.ts`).
  const settingsJumpSeq = useSettingsJump((state) => state.seq)
  useEffect(() => initAgentUpdate(), [])
  /** The text being typed for the wait time (committed on blur / Enter; snapping to the range on every keystroke would make typing impossible). */
  const [delayText, setDelayText] = useState<string | null>(null)

  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [query, setQuery] = useState('')
  // Values that main alone holds (approval, notification) are fetched once when opened and held here.
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null)
  // Of the writable locations, the paths main dropped for being the home itself or its parent (the review of item 8 in TODO 1109). Replaced on the next change.
  const [writeDropped, setWriteDropped] = useState<readonly string[]>([])
  const [patternsText, setPatternsText] = useState<string | null>(null)
  // TODO 1175: true only while the confirmation for enabling full-delegation mode is shown (a one-time confirmation inside the settings screen; no native dialog is used).
  const [delegationConfirm, setDelegationConfirm] = useState(false)
  const [notifyEnabled, setNotifyEnabled] = useState<boolean | null>(null)
  const [autoLogin, setAutoLogin] = useState<boolean | null>(null)
  const [asciiForSearch, setAsciiForSearch] = useState<boolean | null>(null)
  // TODO 999: the new-screenshot badge. The value is held by main (`ScreenshotOfferPreference`).
  const [screenshotOffer, setScreenshotOffer] = useState<boolean | null>(null)
  // TODO 1186: open the changelog after an update. The value is held by main (`ReleaseNotesService`).
  const [releaseNotesAuto, setReleaseNotesAuto] = useState<boolean | null>(null)
  // TODO 1266 / 1270: start at login and keep-awake. The OS's own state, held by main (`os-settings.ts`).
  const [osSettings, setOsSettings] = useState<OsSettingsState | null>(null)
  // TODO 626: the recognition language for voice input. Separate from the display language. One source in main, and no notification to other windows (as light as `EditorPreference`).
  const [voiceLocale, setVoiceLocale] = useState<VoiceLocalePreference | null>(null)
  // TODO 1229: the font for the body of Gmail drafts. The value is held by main (`GmailDraftFontPreference`).
  const [gmailDraftFont, setGmailDraftFont] = useState<GmailDraftFont | null>(null)
  // The defaults for a new thread (T5) and the working-directory history. Fetched from the same entry point as the creation dialog.
  const [options, setOptions] = useState<ThreadCreateOptions | null>(null)
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)

  const loadOptions = useCallback((): void => {
    void window.aios.threads.createOptions().then(setOptions)
  }, [])

  /** Re-fetches the values main holds. Called when opened and on `settings.onChanged` (the AI's `setSetting`, another window's settings screen, TODO 1060 stage 3). */
  const loadValues = useCallback((): void => {
    void window.aios.settings.snapshot().then(setSnapshot)
    void window.aios.approvals.getPolicy().then(setPolicy)
    void window.aios.notifications.getEnabled().then(setNotifyEnabled)
    void window.aios.agent.getAutoLogin().then(setAutoLogin)
    void window.aios.input.getAsciiForSearch().then(setAsciiForSearch)
    void window.aios.recent.getScreenshotOfferEnabled().then(setScreenshotOffer)
    void window.aios.releaseNotes.getAuto().then(setReleaseNotesAuto)
    void window.aios.osSettings.get().then(setOsSettings)
    void window.aios.voice.getLocale().then(setVoiceLocale)
    void window.aios.gmailDraftFont.get().then(setGmailDraftFont)
    void window.aios.agent.getSettings().then((next) => useThreads.setState({ settings: next }))
    void useEditor.getState().init()
  }, [])

  // The settings screen's own changes and notifications that follow (about 9 IPC calls) are combined into one with a 100 ms debounce (review of TODO 1060).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.aios.settings.onChanged(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        loadValues()
      }, 100)
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      off()
    }
  }, [loadValues])

  useEffect(() => {
    loadValues()
    loadOptions()
    // As in VS Code, focus the search field when opened.
    search.current?.focus()
  }, [loadOptions, loadValues])

  const applyPolicy = useCallback((patch: ApprovalPolicyPatch): void => {
    void window.aios.approvals.setPolicy(patch).then((next) => {
      setPolicy(next)
      setWriteDropped((next.sandboxWriteDropped ?? []).map((drop) => drop.path))
      setPatternsText(null)
    })
  }, [])

  const applyNotify = useCallback((next: boolean): void => {
    setNotifyEnabled(next)
    void window.aios.notifications.setEnabled(next).then(setNotifyEnabled)
  }, [])

  const applyAutoLogin = useCallback((next: boolean): void => {
    setAutoLogin(next)
    void window.aios.agent.setAutoLogin(next).then(setAutoLogin)
  }, [])

  const applyReleaseNotesAuto = useCallback((next: boolean): void => {
    setReleaseNotesAuto(next)
    void window.aios.releaseNotes.setAuto(next).then(setReleaseNotesAuto)
  }, [])

  const applyOpenAtLogin = useCallback((next: boolean): void => {
    void window.aios.osSettings.setOpenAtLogin(next).then(setOsSettings)
  }, [])

  const applyPreventSleep = useCallback((next: boolean): void => {
    void window.aios.osSettings.setPreventSleep(next).then(setOsSettings)
  }, [])

  const applyMenuBar = useCallback((next: boolean): void => {
    void window.aios.osSettings.setMenuBar(next).then(setOsSettings)
  }, [])

  const applyScreenshotOffer = useCallback((next: boolean): void => {
    setScreenshotOffer(next)
    void window.aios.recent.setScreenshotOfferEnabled(next).then(setScreenshotOffer)
  }, [])

  const applyAscii = useCallback((next: boolean): void => {
    setAsciiForSearch(next)
    void window.aios.input.setAsciiForSearch(next).then(setAsciiForSearch)
  }, [])

  const applyGmailDraftFont = useCallback((next: GmailDraftFont): void => {
    setGmailDraftFont(next)
    void window.aios.gmailDraftFont.set(next).then(setGmailDraftFont)
  }, [])

  const applyVoiceLocale = useCallback((next: VoiceLocalePreference): void => {
    setVoiceLocale(next)
    void window.aios.voice.setLocale(next).then(setVoiceLocale)
  }, [])

  /** The current values, for seeing changes from the default. Any that could not be fetched are filled with the snapshot's value. */
  const values: Partial<SettingValues> = {
    ...(snapshot?.values ?? {}),
    theme: themePreference,
    locale: localePreference,
    editor: editorId,
    autoSave: autoSaveMode,
    autoSaveDelayMs,
    threadCollapseDays,
    fileSortOrder,
    redmineBaseUrl,
    ...(updateStatus === null ? {} : { autoUpdate: updateStatus.auto }),
    ...(agentUpdateStatus === null ? {} : { agentAutoUpdate: agentUpdateStatus.auto }),
    ...(notifyEnabled === null ? {} : { notifyEnabled }),
    ...(autoLogin === null ? {} : { autoLogin }),
    ...(asciiForSearch === null ? {} : { asciiForSearch }),
    ...(screenshotOffer === null ? {} : { screenshotOffer }),
    ...(osSettings === null ? {} : { openAtLogin: osSettings.openAtLogin.enabled, preventSleep: osSettings.preventSleep.enabled, menuBar: osSettings.menuBar.enabled }),
    ...(voiceLocale === null ? {} : { voiceLocale }),
    ...(gmailDraftFont === null ? {} : { gmailDraftFont }),
    ...(settings === null
      ? {}
      : {
          maxConcurrent: settings.maxConcurrent,
          idleTimeoutMs: settings.idleTimeoutMs,
          defaultModelId: settings.defaultModelId,
          defaultThinking: settings.defaultThinking
        }),
    ...(policy === null
      ? {}
      : {
          autoAllowAll: policy.autoAllowAll,
          autoAllowTools: policy.autoAllowTools,
          bashDenyPatterns: policy.bashDenyPatterns,
          fullDelegation: policy.fullDelegation === true
        })
  }
  const defaults = snapshot?.defaults ?? null

  /** Reset to default. Writes go only through the existing setters (the owner's rule, TODO 85). */
  const reset = (key: SettingValueKey): void => {
    if (defaults === null) return
    switch (key) {
      case 'theme':
        void setTheme(defaults.theme)
        return
      case 'locale':
        void setLocale(defaults.locale)
        return
      case 'editor':
        void setEditor(defaults.editor)
        return
      case 'notifyEnabled':
        applyNotify(defaults.notifyEnabled)
        return
      case 'autoLogin':
        applyAutoLogin(defaults.autoLogin)
        return
      case 'asciiForSearch':
        applyAscii(defaults.asciiForSearch)
        return
      case 'screenshotOffer':
        applyScreenshotOffer(defaults.screenshotOffer)
        return
      case 'voiceLocale':
        applyVoiceLocale(defaults.voiceLocale)
        return
      case 'gmailDraftFont':
        applyGmailDraftFont(defaults.gmailDraftFont)
        return
      case 'autoSave':
        void updateAutoSave({ mode: defaults.autoSave })
        return
      case 'autoSaveDelayMs':
        setDelayText(null)
        void updateAutoSave({ delayMs: defaults.autoSaveDelayMs })
        return
      case 'fileSortOrder':
        void updateFileSortOrder(defaults.fileSortOrder)
        return
      case 'redmineBaseUrl':
        setRedmineText(null)
        setRedmineInvalid(false)
        void updateRedmine(defaults.redmineBaseUrl)
        return
      case 'threadCollapseDays':
        setCollapseDaysText(null)
        void updateThreadCollapseDays(defaults.threadCollapseDays)
        return
      case 'autoUpdate':
        void setAutoUpdate(defaults.autoUpdate)
        return
      case 'releaseNotesAuto':
        applyReleaseNotesAuto(defaults.releaseNotesAuto)
        return
      case 'openAtLogin':
        applyOpenAtLogin(defaults.openAtLogin)
        return
      case 'preventSleep':
        applyPreventSleep(defaults.preventSleep)
        return
      case 'menuBar':
        applyMenuBar(defaults.menuBar)
        return
      case 'agentAutoUpdate':
        void setAgentAutoUpdate(defaults.agentAutoUpdate)
        return
      case 'maxConcurrent':
      case 'idleTimeoutMs':
      case 'defaultModelId':
      case 'defaultThinking':
        void setSettings({ [key]: defaults[key] })
        return
      case 'autoAllowAll':
      case 'autoAllowTools':
      case 'bashDenyPatterns':
        applyPolicy({ [key]: defaults[key] })
        return
      case 'fullDelegation':
        // Returning to the default (OFF) narrows permissions, so it is not confirmed.
        setDelegationConfirm(false)
        applyPolicy({ fullDelegation: defaults.fullDelegation })
        return
    }
  }

  const visible = useMemo(
    () => filterSettingsItems(SETTINGS_ITEMS, query, (entry) => searchTextOf(t, entry)),
    [query, t]
  )
  const categories = useMemo(() => categoriesOf(visible), [visible])

  /** Changes the highlighted category in the table of contents to match scrolling. */
  // TODO 774: when coming from BottomBar's "agent CLI was updated", show that row (the same form as `BuildInfoSection`).
  useEffect(() => {
    if (!useAgentUpdate.getState().jumpPending || list.current === null) return
    const row = list.current.querySelector('[data-setting="agentUpdateStatus"]')
    if (row === null) return
    row.scrollIntoView?.({ block: 'start' })
    useAgentUpdate.getState().consumeJump()
  }, [agentUpdateJumpSeq, agentUpdateStatus])

  // TODO 1060 stage 2: the gateway's openSettings. Move to the field (`SETTINGS_ITEMS`, 1:1) that has the setting name as its `value`,
  // show it, then highlight it. If it is hidden by the search, empty the search and do it again on the next render.
  useEffect(() => {
    const name = useSettingsJump.getState().pending
    if (name === null || list.current === null) return
    // A field with no gear (destinations not asked about, key bindings) has `value` null, and the field's id is the same as the setting name.
    const entry = SETTINGS_ITEMS.find((item) => item.value === name) ?? SETTINGS_ITEMS.find((item) => item.id === name)
    if (entry === undefined) {
      useSettingsJump.getState().consume()
      return
    }
    if (!visible.some((item) => item.id === entry.id)) {
      setQuery('')
      return
    }
    const row = list.current.querySelector<HTMLElement>(`[data-setting="${entry.id}"]`)
    if (row === null) return
    useSettingsJump.getState().consume()
    row.scrollIntoView?.({ block: 'center' })
    row.classList.add('settings-item-flash')
    // Right after opening, the sections above (the list, usage, etc.) grow asynchronously and shift the position, so move again a little later.
    const again = window.setTimeout(() => row.scrollIntoView?.({ block: 'center' }), 300)
    const unflash = window.setTimeout(() => row.classList.remove('settings-item-flash'), 2000)
    return () => {
      window.clearTimeout(again)
      window.clearTimeout(unflash)
      row.classList.remove('settings-item-flash')
    }
  }, [settingsJumpSeq, visible])

  const onScroll = useCallback((): void => {
    const host = list.current
    if (host === null) return
    const top = host.getBoundingClientRect().top
    const tops = categories.flatMap((category) => {
      const heading = host.querySelector(`#${categoryAnchor(category)}`)
      return heading === null ? [] : [{ category, top: heading.getBoundingClientRect().top - top }]
    })
    setActiveCategory(currentCategory(tops))
  }, [categories])

  useEffect(onScroll, [onScroll])

  const jumpTo = (category: SettingsCategory): void => {
    const heading = list.current?.querySelector(`#${categoryAnchor(category)}`)
    heading?.scrollIntoView({ block: 'start' })
    setActiveCategory(category)
  }

  const primary = options?.backends.find((b) => b.id === options.defaultBackend) ?? null

  const renderItem = (entry: SettingsItem): React.JSX.Element => {
    const modified = entry.value === null ? false : isModified(entry.value, values, defaults)
    const onReset =
      entry.value === null
        ? null
        : (() => {
            const key = entry.value
            return () => reset(key)
          })()
    const common = { entry, modified, onReset }
    switch (entry.id) {
      case 'accountUsage':
        return <SettingsItemView {...common}><UsageSection /></SettingsItemView>
      case 'unattendedAuth':
        return <SettingsItemView {...common}><UnattendedAuthGuide /></SettingsItemView>
      case 'theme':
        return (
          <SettingsItemView {...common}>
            <select
              value={themePreference}
              onChange={(event) => {
                if (isThemePreference(event.target.value)) void setTheme(event.target.value)
              }}
            >
              {THEME_PREFERENCES.map((value) => (
                <option key={value} value={value}>
                  {t(`theme.${value}`)}
                </option>
              ))}
            </select>
            {themePreference === 'system' ? (
              <span className="hint">{t('settings.theme.osIs', { theme: t(`theme.${themeResolved}`) })}</span>
            ) : null}
          </SettingsItemView>
        )
      case 'locale':
        return (
          <SettingsItemView {...common}>
            <select
              value={localePreference}
              onChange={(event) => {
                if (isLocalePreference(event.target.value)) void setLocale(event.target.value)
              }}
            >
              {LOCALE_PREFERENCES.map((value) => (
                <option key={value} value={value}>
                  {value === 'system' ? t('settings.locale.system') : LOCALE_LABEL[value]}
                </option>
              ))}
            </select>
            {localePreference === 'system' ? (
              <span className="hint">{t('settings.locale.osIs', { locale: LOCALE_LABEL[localeResolved] })}</span>
            ) : null}
          </SettingsItemView>
        )
      case 'editor':
        // The display names are proper nouns (`EDITOR_LABELS`), so they are not put in the dictionary (item 115).
        return (
          <SettingsItemView {...common}>
            <select
              value={editorId}
              onChange={(event) => {
                if (isEditorId(event.target.value)) void setEditor(event.target.value)
              }}
            >
              {EDITOR_IDS.map((value) => (
                <option key={value} value={value}>
                  {EDITOR_LABELS[value]}
                </option>
              ))}
            </select>
          </SettingsItemView>
        )
      case 'autoSave':
        return (
          <SettingsItemView {...common}>
            <select
              value={autoSaveMode}
              onChange={(event) => {
                if (isAutoSaveMode(event.target.value)) void updateAutoSave({ mode: event.target.value })
              }}
            >
              {AUTO_SAVE_MODES.map((value) => (
                <option key={value} value={value}>
                  {t(`settings.autoSave.${value}`)}
                </option>
              ))}
            </select>
          </SettingsItemView>
        )
      case 'autoSaveDelay': {
        const commitDelay = (): void => {
          if (delayText === null) return
          const value = Number(delayText)
          setDelayText(null)
          if (delayText.trim() !== '' && Number.isFinite(value)) void updateAutoSave({ delayMs: value })
        }
        return (
          <SettingsItemView {...common}>
            <input
              type="number"
              className="settings-number"
              min={MIN_AUTO_SAVE_DELAY_MS}
              max={MAX_AUTO_SAVE_DELAY_MS}
              step={100}
              aria-label={t('settings.item.autoSaveDelay.title')}
              value={delayText ?? String(autoSaveDelayMs)}
              onChange={(event) => setDelayText(event.target.value)}
              onBlur={commitDelay}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitDelay()
              }}
            />
          </SettingsItemView>
        )
      }
      case 'threadListCollapseDays': {
        const commitCollapseDays = (): void => {
          if (collapseDaysText === null) return
          const value = Number(collapseDaysText)
          setCollapseDaysText(null)
          if (collapseDaysText.trim() !== '' && Number.isFinite(value)) {
            void updateThreadCollapseDays(value)
          }
        }
        return (
          <SettingsItemView {...common}>
            <input
              type="number"
              className="settings-number"
              min={MIN_COLLAPSE_OLD_AFTER_DAYS}
              max={MAX_COLLAPSE_OLD_AFTER_DAYS}
              step={1}
              aria-label={t('settings.item.threadListCollapseDays.title')}
              value={collapseDaysText ?? String(threadCollapseDays)}
              onChange={(event) => setCollapseDaysText(event.target.value)}
              onBlur={commitCollapseDays}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitCollapseDays()
              }}
            />
            <span className="hint">{t('settings.threadListCollapseDays.hint')}</span>
          </SettingsItemView>
        )
      }
      case 'notifyEnabled':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: notifyEnabled ?? true,
              disabled: notifyEnabled === null,
              onChange: applyNotify
            }}
          />
        )
      case 'screenshotOffer':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: screenshotOffer ?? true,
              disabled: screenshotOffer === null,
              onChange: applyScreenshotOffer
            }}
          />
        )
      case 'autoLogin':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: autoLogin ?? true,
              disabled: autoLogin === null,
              onChange: applyAutoLogin
            }}
          />
        )
      case 'asciiForSearch':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: asciiForSearch ?? true,
              disabled: asciiForSearch === null,
              onChange: applyAscii
            }}
          />
        )
      case 'redmineBaseUrl': {
        // Pass to main on commit (blur / Enter). Main drops unusable values, so if the returned value differs, show a notice.
        const commitRedmine = (): void => {
          if (redmineText === null) return
          const typed = redmineText.trim()
          void updateRedmine(typed).then((saved) => {
            setRedmineInvalid(typed !== '' && saved !== normalizeRedmineBase(typed))
            setRedmineText(null)
          })
        }
        return (
          <SettingsItemView {...common}>
            <input
              type="text"
              spellCheck={false}
              placeholder={t('settings.redmine.placeholder')}
              value={redmineText ?? redmineBaseUrl}
              onChange={(event) => setRedmineText(event.target.value)}
              onBlur={commitRedmine}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRedmine()
              }}
            />
            {redmineInvalid ? <p className="hint">{t('settings.redmine.invalid')}</p> : null}
          </SettingsItemView>
        )
      }
      case 'fileSortOrder':
        return (
          <SettingsItemView {...common}>
            <select
              value={fileSortOrder}
              onChange={(event) => {
                if (isFileSortOrder(event.target.value)) void updateFileSortOrder(event.target.value)
              }}
            >
              {FILE_SORT_ORDERS.map((value) => (
                <option key={value} value={value}>
                  {t(`settings.fileSortOrder.${value}`)}
                </option>
              ))}
            </select>
          </SettingsItemView>
        )
      case 'voiceLocale':
        return (
          <SettingsItemView {...common}>
            <select
              value={voiceLocale ?? 'auto'}
              disabled={voiceLocale === null}
              onChange={(event) => {
                if (isVoiceLocalePreference(event.target.value)) applyVoiceLocale(event.target.value)
              }}
            >
              {VOICE_LOCALE_PREFERENCES.map((value) => (
                <option key={value} value={value}>
                  {value === 'auto' ? t('settings.voiceLocale.auto') : LOCALE_LABEL[value]}
                </option>
              ))}
            </select>
          </SettingsItemView>
        )
      case 'gmailDraftFont':
        return (
          <SettingsItemView {...common}>
            <select
              value={gmailDraftFont ?? 'default'}
              disabled={gmailDraftFont === null}
              onChange={(event) => {
                if (isGmailDraftFont(event.target.value)) applyGmailDraftFont(event.target.value)
              }}
            >
              {GMAIL_DRAFT_FONTS.map((value) => (
                <option key={value} value={value}>
                  {t(`settings.gmailDraftFont.${value}`)}
                </option>
              ))}
            </select>
          </SettingsItemView>
        )
      case 'maxConcurrent':
        return (
          <SettingsItemView {...common}>
            {settings === null ? null : (
              <>
                <input
                  type="number"
                  className="settings-number"
                  min={1}
                  max={settings.maxConcurrentCap}
                  value={settings.maxConcurrent}
                  onChange={(event) => void setSettings({ maxConcurrent: Number(event.target.value) })}
                />
                <span className="hint">
                  {t('settings.concurrency.maxHint', {
                    cap: settings.maxConcurrentCap,
                    gb: Math.round(((settings.maxConcurrent * RSS_PER_SESSION_MB) / 1024) * 10) / 10
                  })}
                </span>
              </>
            )}
          </SettingsItemView>
        )
      case 'idleTimeout':
        return (
          <SettingsItemView {...common}>
            {settings === null ? null : (
              <input
                type="number"
                className="settings-number"
                min={1}
                value={Math.round(settings.idleTimeoutMs / 60000)}
                onChange={(event) =>
                  void setSettings({ idleTimeoutMs: Number(event.target.value) * 60000 })
                }
              />
            )}
          </SettingsItemView>
        )
      case 'defaultModel':
        return (
          <SettingsItemView {...common}>
            {settings === null || primary === null ? null : primary.modelSelect ? (
              // There is no "default" option (item 61). If not set, it is shown with the first of the list selected.
              <select
                value={resolveModelChoice(null, settings.defaultModelId, primary.models) ?? ''}
                onChange={(event) => void setSettings({ defaultModelId: event.target.value })}
              >
                {primary.models
                  .filter((m) => m.pinned !== true)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                {/* TODO 769: version-pinned models and unusable models (grayed out) go to the group below. */}
                {/* TODO 1204: a version-pinned option that points to the same model as the one above (sameAs) is shown with a "pinned" mark only when it is selected. */}
                {listedModelChoices(primary.models, settings.defaultModelId).some((m) => m.pinned === true) ? (
                  <optgroup label={t('composer.moreModels')}>
                    {listedModelChoices(primary.models, settings.defaultModelId)
                      .filter((m) => m.pinned === true)
                      .map((m) => (
                        <option key={m.id} value={m.id} disabled={m.unavailable === true}>
                          {m.unavailable === true
                            ? t('composer.modelUnavailable', { label: m.label })
                            : modelChoiceLabel(m, t)}
                        </option>
                      ))}
                  </optgroup>
                ) : null}
                {settings.defaultModelId !== null &&
                !primary.models.some((m) => m.id === settings.defaultModelId) ? (
                  <option value={settings.defaultModelId}>
                    {t('common.modelNotListed', { id: settings.defaultModelId })}
                  </option>
                ) : null}
              </select>
            ) : (
              <p className="hint">{t('settings.defaults.noModel')}</p>
            )}
          </SettingsItemView>
        )
      case 'defaultThinking':
        return (
          <SettingsItemView {...common}>
            {settings === null || primary === null ? null : primary.thinkingLevel ? (
              <select
                value={resolveThinkingChoice(null, settings.defaultThinking)}
                onChange={(event) => {
                  if (isThinkingLevel(event.target.value)) {
                    void setSettings({ defaultThinking: event.target.value })
                  }
                }}
              >
                {thinkingSelectLevels(resolveThinkingChoice(null, settings.defaultThinking)).map((level) => (
                  <option key={level} value={level}>
                    {thinkingLabel(level, false, t)}
                  </option>
                ))}
              </select>
            ) : (
              <p className="hint">{t('settings.defaults.noThinking')}</p>
            )}
          </SettingsItemView>
        )
      case 'cliAllowNotice':
        // TODO 1005 item 1: only one line of description (no control). The CLI's settings are neither read nor written (constraints 2 / 6).
        return <SettingsItemView {...common} />
      case 'autoAllowAll':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: policy?.autoAllowAll ?? true,
              disabled: policy === null,
              onChange: (checked) => applyPolicy({ autoAllowAll: checked })
            }}
          />
        )
      case 'fullDelegation':
        // TODO 1175: when checked, the description and [Enable] / [Cancel] are shown inside the field, and nothing is saved until one is pressed. Unchecking is not confirmed.
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: policy?.fullDelegation === true || delegationConfirm,
              disabled: policy === null,
              onChange: (checked) => {
                if (checked) {
                  setDelegationConfirm(true)
                  return
                }
                setDelegationConfirm(false)
                if (policy?.fullDelegation === true) applyPolicy({ fullDelegation: false })
              }
            }}
          >
            {delegationConfirm && policy?.fullDelegation !== true ? (
              <div className="full-delegation-confirm" role="alertdialog" aria-label={t('settings.item.fullDelegation.title')}>
                <p>{t('settings.fullDelegation.confirm')}</p>
                <div className="full-delegation-confirm-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setDelegationConfirm(false)
                      applyPolicy({ fullDelegation: true })
                    }}
                  >
                    {t('settings.fullDelegation.enable')}
                  </button>
                  <button type="button" onClick={() => setDelegationConfirm(false)}>
                    {t('settings.fullDelegation.cancel')}
                  </button>
                </div>
              </div>
            ) : undefined}
          </SettingsItemView>
        )
      case 'autoAllowTools': {
        if (policy === null) return <SettingsItemView {...common} />
        // The three defaults, plus unknown tool names found in the settings, are listed (so they can be removed).
        const tools = [...new Set([...DEFAULT_AUTO_ALLOW_TOOLS, ...policy.autoAllowTools])]
        return (
          <SettingsItemView {...common}>
            <ul className="approval-tool-list" aria-disabled={policy.autoAllowAll}>
              {tools.map((tool) => (
                <li key={tool}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={policy.autoAllowAll}
                      checked={policy.autoAllowAll || policy.autoAllowTools.includes(tool)}
                      onChange={(event) =>
                        applyPolicy({
                          autoAllowTools: event.target.checked
                            ? [...policy.autoAllowTools, tool]
                            : policy.autoAllowTools.filter((name) => name !== tool)
                        })
                      }
                    />
                    <span>{tool}</span>
                    {tool === 'Bash' ? (
                      <span className="hint">{t('settings.approval.bashHint')}</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </SettingsItemView>
        )
      }
      case 'bashDenyPatterns':
        return (
          <SettingsItemView {...common}>
            {policy === null ? null : (
              <textarea
                className="settings-textarea"
                rows={5}
                aria-label={t('settings.item.bashDenyPatterns.title')}
                value={patternsText ?? policy.bashDenyPatterns.join('\n')}
                onChange={(event) => setPatternsText(event.target.value)}
                onBlur={() => {
                  if (patternsText === null) return
                  applyPolicy({ bashDenyPatterns: patternsText.split('\n') })
                }}
                spellCheck={false}
              />
            )}
          </SettingsItemView>
        )
      case 'alwaysAllowed':
        return (
          <SettingsItemView {...common}>
            <AlwaysAllowedList />
          </SettingsItemView>
        )
      case 'sshAllowedHosts':
        return (
          <SettingsItemView {...common}>
            {policy === null ? null : (
              <SshHostList
                hosts={policy.sshAllowedHosts ?? []}
                addHost={(host) => applyPolicy({ sshAllowedHostsAdd: [host] })}
                removeHost={(host) => applyPolicy({ sshAllowedHostsRemove: [host] })}
              />
            )}
          </SettingsItemView>
        )
      // TODO 1106: the OS sandbox's allow table. Sent as a diff of adds and removes (the same as destinations not asked about).
      case 'sandboxAllowedDomains':
        return (
          <SettingsItemView {...common}>
            {policy === null ? null : (
              <SshHostList
                hosts={policy.sandboxAllowedDomains ?? DEFAULT_SANDBOX_ALLOWED_DOMAINS}
                addHost={(domain) => applyPolicy({ sandboxAllowedDomainsAdd: [domain] })}
                removeHost={(domain) => applyPolicy({ sandboxAllowedDomainsRemove: [domain] })}
                normalize={normalizeSandboxDomain}
                texts="settings.sandboxDomains"
              />
            )}
          </SettingsItemView>
        )
      case 'sandboxAllowWrite':
        return (
          <SettingsItemView {...common}>
            {policy === null ? null : (
              <SshHostList
                hosts={policy.sandboxAllowWrite ?? DEFAULT_SANDBOX_ALLOW_WRITE}
                addHost={(path) => applyPolicy({ sandboxAllowWriteAdd: [path] })}
                removeHost={(path) => applyPolicy({ sandboxAllowWriteRemove: [path] })}
                normalize={normalizeSandboxWritePath}
                texts="settings.sandboxWrite"
                notice={writeDropped.length === 0 ? null : t('settings.sandboxWrite.dropped', { paths: writeDropped.join(', ') })}
              />
            )}
          </SettingsItemView>
        )
      case 'cwdHistory':
        return (
          <SettingsItemView {...common}>
            <CwdHistoryList options={options} reload={loadOptions} />
          </SettingsItemView>
        )
      case 'clearAllLogs':
        return (
          <SettingsItemView {...common}>
            <div className="settings-actions">
              <button
                type="button"
                className="danger"
                onClick={() => void window.aios.threads.clearAllLogs()}
              >
                {t('settings.logs.clearAll')}
              </button>
            </div>
          </SettingsItemView>
        )
      case 'backup':
        return (
          <SettingsItemView {...common}>
            <BackupControl />
          </SettingsItemView>
        )
      case 'dataTransfer':
        return (
          <SettingsItemView {...common}>
            <DataTransferControl />
          </SettingsItemView>
        )
      case 'volumes':
        return (
          <SettingsItemView {...common}>
            <VolumeList />
          </SettingsItemView>
        )
      case 'protectedFolders':
        return (
          <SettingsItemView {...common}>
            <ProtectedFolders />
          </SettingsItemView>
        )
      case 'keybindings':
        return (
          <SettingsItemView {...common}>
            <ShortcutSettings />
          </SettingsItemView>
        )
      case 'mcpServers':
        return (
          <SettingsItemView {...common}>
            <McpSettings />
          </SettingsItemView>
        )
      case 'skills':
        return (
          <SettingsItemView {...common}>
            <SkillSettings />
          </SettingsItemView>
        )
      case 'viewerAssociations':
        return (
          <SettingsItemView {...common}>
            <ViewerAssociationList />
          </SettingsItemView>
        )
      case 'webTabReadConsent':
        return (
          <SettingsItemView {...common}>
            <WebTabReadConsent />
          </SettingsItemView>
        )
      case 'trustedCertificates':
        return (
          <SettingsItemView {...common}>
            <TrustedCertificateList />
          </SettingsItemView>
        )
      case 'loginSites':
        return (
          <SettingsItemView {...common}>
            <LoginSiteList />
          </SettingsItemView>
        )
      case 'autoUpdate':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: updateStatus?.auto ?? true,
              disabled: updateStatus === null || !updateStatus.supported,
              onChange: (checked) => void setAutoUpdate(checked)
            }}
          />
        )
      case 'updateStatus':
        return (
          <SettingsItemView {...common}>
            <UpdateInfo status={updateStatus} />
          </SettingsItemView>
        )
      case 'releaseNotesAuto':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: releaseNotesAuto ?? true,
              disabled: releaseNotesAuto === null,
              onChange: applyReleaseNotesAuto
            }}
          />
        )
      case 'openAtLogin':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: osSettings?.openAtLogin.enabled ?? false,
              disabled: osSettings === null || !osSettings.openAtLogin.supported,
              onChange: applyOpenAtLogin
            }}
          >
            {osSettings !== null && !osSettings.openAtLogin.supported ? (
              <p className="hint">{t(`settings.item.openAtLogin.unsupported.${osSettings.openAtLogin.reason ?? 'not-installed'}`)}</p>
            ) : undefined}
          </SettingsItemView>
        )
      case 'preventSleep':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: osSettings?.preventSleep.enabled ?? false,
              disabled: osSettings === null,
              onChange: applyPreventSleep
            }}
          >
            {osSettings?.preventSleep.active === true ? <p className="hint">{t('settings.item.preventSleep.active')}</p> : undefined}
          </SettingsItemView>
        )
      case 'menuBar':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: osSettings?.menuBar.enabled ?? false,
              disabled: osSettings === null || !osSettings.menuBar.supported,
              onChange: applyMenuBar
            }}
          >
            {osSettings !== null && !osSettings.menuBar.supported ? <p className="hint">{t(osSettings.menuBar.reason === 'instance' ? 'settings.item.menuBar.unsupportedInstance' : 'settings.item.menuBar.unsupported')}</p> : undefined}
          </SettingsItemView>
        )
      case 'agentAutoUpdate':
        return (
          <SettingsItemView
            {...common}
            checkbox={{
              checked: agentUpdateStatus?.auto ?? true,
              disabled: agentUpdateStatus === null || !agentUpdateStatus.supported,
              onChange: (checked) => void setAgentAutoUpdate(checked)
            }}
          />
        )
      case 'agentUpdateStatus':
        return (
          <SettingsItemView {...common}>
            <AgentUpdateInfo status={agentUpdateStatus} />
          </SettingsItemView>
        )
      case 'agentCli':
        return (
          <SettingsItemView {...common}>
            <AgentInfo />
            <OtherBackendsInfo />
          </SettingsItemView>
        )
    }
  }

  return (
    <div className="thread-pane settings-editor" role="region" aria-label={t('settings.title')}>
      <div className="settings-editor-header">
        <input
          ref={search}
          type="search"
          {...ASCII_INPUT}
          className="settings-search"
          placeholder={t('settings.search.placeholder')}
          aria-label={t('settings.search.placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // As in VS Code, Esc in the search field only clears the term (it does not close settings).
            // TODO 1141: Esc during IME composition cancels the composition. It does not clear the term.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault()
              setQuery('')
            }
          }}
          spellCheck={false}
        />
        {query.trim() === '' ? null : (
          <span className="settings-search-count" aria-live="polite">
            {t('settings.search.count', { count: visible.length })}
          </span>
        )}
        <Tooltip content={t('common.close')}>
          <button
            type="button"
            className="icon-button settings-editor-close"
            onClick={close}
            aria-label={t('common.close')}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
      <div className="settings-editor-body">
        <nav className="settings-toc" aria-label={t('settings.toc')}>
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              className={category === activeCategory ? 'active' : ''}
              aria-current={category === activeCategory ? 'true' : undefined}
              onClick={() => jumpTo(category)}
            >
              {t(`settings.category.${category}`)}
            </button>
          ))}
        </nav>
        <div className="settings-list" ref={list} onScroll={onScroll}>
          {categories.length === 0 ? (
            <p className="settings-empty">{t('settings.search.none')}</p>
          ) : (
            categories.map((category) => (
              <section key={category} className="settings-category">
                <h2 id={categoryAnchor(category)}>{t(`settings.category.${category}`)}</h2>
                {visible
                  .filter((entry) => entry.category === category)
                  .map((entry) => (
                    <Fragment key={entry.id}>{renderItem(entry)}</Fragment>
                  ))}
              </section>
            ))
          )}
          <BuildInfoSection />
        </div>
      </div>
    </div>
  )
}
