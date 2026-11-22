/**
 * Pure functions and list subscription for the extensions view (TODO 367, ARCHITECTURE.md 5.3 / 7.1). The React rendering is in
 * `components/ExtensionsMode.tsx` (sidebar) and `components/ExtensionDetailPane.tsx` (where ThreadPane is, TODO 458; open/close is in `mainPanel.ts`).
 *
 * The user-facing name is "Extensions" (same as VS Code). The internal words (plugin, manifest) are not changed.
 */
import { useEffect, useState } from 'react'
import type { CapabilityName, PluginSummary } from '@shared/plugin.js'
import type { PluginUpdateAllResult, PluginUpdateInfo, PluginUpdateUnknownReason } from '@shared/plugin-update.js'
import { parseReason } from '@shared/reason.js'
import { describeReason, type MessageKey, type Translate } from './i18n/index.js'

/** Capability name -> dictionary key (7.4.4). */
export const CAPABILITY_LABELS: Readonly<Record<CapabilityName, MessageKey>> = {
  credentials: 'plugins.capability.credentials',
  network: 'plugins.capability.network',
  fs: 'plugins.capability.fs',
  index: 'plugins.capability.index',
  ui: 'plugins.capability.ui',
  browser: 'plugins.capability.browser',
  triggers: 'plugins.capability.triggers',
  git: 'plugins.capability.git'
}

/** The state shown in a list row and in the detail. */
export type ExtensionStatus = 'disabled' | 'running' | 'none' | 'idle' | 'crashed'

/**
 * How the state is presented (owner decision: running / no process needed / abnormal). A plugin that has a process but has not been called even once
 * (`stopped`; unlike viewer-only plugins it starts when called) is shown separately as "standby": calling it "abnormal" would make
 * aios.markdown look abnormal right after launch.
 */
export function extensionStatus(plugin: Pick<PluginSummary, 'enabled' | 'host'>): ExtensionStatus {
  if (!plugin.enabled) return 'disabled'
  switch (plugin.host) {
    case 'running':
      return 'running'
    case 'none':
      return 'none'
    case 'crashed':
      return 'crashed'
    case 'stopped':
      return 'idle'
  }
}

export const STATUS_LABELS: Readonly<Record<ExtensionStatus, MessageKey>> = {
  disabled: 'extensions.status.disabled',
  running: 'extensions.status.running',
  none: 'extensions.status.none',
  idle: 'extensions.status.idle',
  crashed: 'extensions.status.crashed'
}

/** TODO 1144 stage 1: reason for "cannot check" -> dictionary key. */
const UPDATE_REASON_LABELS: Readonly<Record<PluginUpdateUnknownReason, MessageKey>> = {
  'not-bundled': 'extensions.update.reason.not-bundled',
  unsupported: 'extensions.update.reason.unsupported',
  'not-checked': 'extensions.update.reason.not-checked',
  'check-failed': 'extensions.update.reason.check-failed',
  'no-table': 'extensions.update.reason.no-table',
  'not-listed': 'extensions.update.reason.not-listed',
  'invalid-version': 'extensions.update.reason.invalid-version'
}

/** TODO 1144 stage 1: the short badge for update state in list rows and the detail (latest / update available / cannot check; stage 2 adds updating / failed). */
export function updateLabel(t: Translate, info: PluginUpdateInfo): string {
  switch (info.state) {
    case 'up-to-date':
      return t('extensions.update.upToDate')
    case 'available':
      return t('extensions.update.available', { version: info.latest })
    case 'updating':
      return t('extensions.update.updating', { version: info.latest })
    case 'failed':
      return t('extensions.update.failed', { version: info.latest })
    case 'unknown':
      return t('extensions.update.unknown')
  }
}

/** TODO 1144 stage 2: whether to show the detail's "Update" button (update available and an asset exists, or the previous update failed). */
export function canUpdate(info: PluginUpdateInfo): boolean {
  return (info.state === 'available' && info.installable) || info.state === 'failed'
}

/**
 * TODO 1144 stage 1: the explanation attached to the badge (the detail's "Update" field and the tooltip of the list badge). Latest / update available show the version from the version table; cannot check shows the reason.
 * Stage 2: also updating / failed (the reason-code sentence).
 * Where the app's own auto-update does not work, the 8.5 reason sentence (`update.unsupported.*`) is followed by the reason-code sentence for "could not fetch".
 */
export function updateDetail(t: Translate, info: PluginUpdateInfo): string {
  // Stage 2: for a failure, append the reason-code sentence. For "update available" with no asset, add that it comes in with the app update.
  if (info.state === 'failed') return `${t('extensions.update.failedDetail')} ${describeReason(t, info.failure)}`
  if (info.state === 'updating') return t('extensions.update.updatingDetail')
  if (info.state === 'available' && !info.installable) {
    return `${t('extensions.update.latestVersion', { version: info.latest })} ${t('extensions.update.notInstallable')}`
  }
  if (info.state !== 'unknown') return t('extensions.update.latestVersion', { version: info.latest })
  const base = t(UPDATE_REASON_LABELS[info.reason])
  if (info.reason === 'unsupported' && info.updateUnsupported !== null) {
    return `${base} ${t(`update.unsupported.${info.updateUnsupported}`)}`
  }
  if (info.reason === 'check-failed' && info.failure !== null) return `${base} ${describeReason(t, info.failure)}`
  return base
}

/**
 * Wave 73 review: the one sentence for when main refused to start an "Update" (a `plugins.update` reject). For a reason code
 * (`update-unsupported` / `plugin-update-unavailable`, etc.) it is that sentence; for an exception with no code (in the middle of shutdown, an id not in the list) it is
 * a fixed sentence, without showing the raw text (`Error invoking remote method …`).
 */
export function updateRejectDetail(t: Translate, message: string): string {
  const reason = parseReason(message) === null ? t('extensions.update.rejectedUnknown') : describeReason(t, message)
  return `${t('extensions.update.failedDetail')} ${reason}`
}

/** TODO 1144 stage 3: the targets of "Update all" (bundled ones whose detail shows "Update" / "Update again"). The same condition as main's `updateAll`. */
export function updatablePlugins(list: readonly PluginSummary[]): readonly PluginSummary[] {
  return list.filter((plugin) => plugin.bundled && canUpdate(plugin.update))
}

/** TODO 1144 stage 3: one line of the result of "Update all". The name is the current list's display name (the id if none). */
export function updateAllResultLine(t: Translate, result: PluginUpdateAllResult, list: readonly PluginSummary[]): string {
  const name = list.find((plugin) => plugin.id === result.id)?.displayName ?? result.id
  if (result.outcome === 'updated') return t('extensions.updateAll.updated', { name, version: result.to })
  return `${t('extensions.updateAll.failed', { name })} ${describeReason(t, result.failure)}`
}

/** Split by heading: "Installed" (what the user installed) and "Built-in" (bundled). Each in name order. */
export function groupExtensions(list: readonly PluginSummary[]): {
  readonly installed: readonly PluginSummary[]
  readonly builtin: readonly PluginSummary[]
} {
  const byName = (a: PluginSummary, b: PluginSummary): number =>
    a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
  return {
    installed: list.filter((plugin) => !plugin.bundled).sort(byName),
    builtin: list.filter((plugin) => plugin.bundled).sort(byName)
  }
}

/** Make the empty array a module constant (the React #185 pitfall). */
export const NO_PLUGINS: readonly PluginSummary[] = []

/**
 * Rows of plugins shown in the Activity Bar (TODO 523). **Enabled plugins only**: no icon while disabled
 * (460's disabling takes effect as it is). In display-name order (the same ordering as `groupExtensions`).
 */
export interface ActivityBarPlugin {
  readonly id: string
  readonly iconUrl: string | null
  readonly title: string
  readonly openUrl: string
  /** TODO 721: `'web'` (Web view) or `'external'` (the default browser). `'web'` if absent. */
  readonly openWith: 'web' | 'external'
  /** TODO 1039: pressing shows the plugin's own list in the sidebar (no URL is opened). */
  readonly sidebarView: boolean
}

export function activityBarPlugins(list: readonly PluginSummary[]): readonly ActivityBarPlugin[] {
  return list
    .filter((plugin) => plugin.enabled && (plugin.activityBar !== null || plugin.sidebarView !== undefined))
    .map((plugin) => ({
      id: plugin.id,
      iconUrl: plugin.iconUrl,
      title: plugin.sidebarView?.title ?? plugin.activityBar?.title ?? plugin.displayName,
      openUrl: plugin.activityBar?.openUrl ?? '',
      openWith: plugin.activityBar?.openWith ?? 'web',
      sidebarView: plugin.sidebarView !== undefined
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

/**
 * Fetch the plugin list from main and swap it in when it changes (enabled / disabled, consent, process start and crash).
 * The list and the detail are small enough to share one subscription (4 bundled + what the user installed).
 */
export function usePluginList(): readonly PluginSummary[] | null {
  const [list, setList] = useState<readonly PluginSummary[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.aios.plugins.list().then(
      (next) => {
        if (!cancelled) setList(next)
      },
      () => {
        if (!cancelled) setList(NO_PLUGINS)
      }
    )
    const unsubscribe = window.aios.plugins.onChanged((next) => setList(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return list
}
