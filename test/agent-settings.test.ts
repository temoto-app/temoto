/**
 * TODO 1060 stage 1 (wave 59 bundle C, ARCHITECTURE 7.6.8): the conversation's AI reads and changes aios's own settings.
 *
 *  - Classification of keys (`AGENT_SETTING_ACCESS`): every key shown to the tool is classified; keys for the gate and updates are `gated`, and secret, consent, and internal keys are not visible
 *  - `AgentSettings`: re-checks values that came from the gateway (refuses rather than rounding); an unchanged value does nothing; reads back through the setter
 *  - `GatewayRequests`: `display` is changed without asking, and `gated` asks every time in the approval inbox (`alwaysAsk`). If refused, nothing changes.
 *    At the `approve` stage, `gated` is not queued (it does not ask twice)
 *  - Reflection into windows: making the real `ThemeController` (a fake nativeTheme) the setter sends the same notice as the settings screen
 *
 * Neither the model nor Electron is used.
 */
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import {
  AGENT_SETTING_ACCESS,
  APPROVAL_RULES,
  APPROVAL_SSH_ALLOWED_HOSTS,
  BUNDLE_MAX,
  UI_THEME,
  WEB_TAB_READ_CONSENT,
  WEB_TRUSTED_CERTIFICATES,
  WINDOW_BOUNDS
} from '../src/common/settings-keys.js'
import {
  AGENT_SETTING_NAMES,
  AgentSettings,
  accessOf,
  isGatedSettingName,
  type AgentSettingAppliers
} from '../src/main/agent-settings.js'
import { settingDefaults } from '../src/main/settings-snapshot.js'
import { ThemeController, type NativeThemeLike } from '../src/main/theme.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { ApprovalRequestInput, ApprovalResult } from '../src/main/approval/broker.js'
import {
  MIN_IDLE_TIMEOUT_MS,
  isDefaultModelIdValue,
  type SettingValueKey,
  type SettingValues,
  type SettingsSnapshot
} from '../src/shared/settings.js'
import type { ThemeState } from '../src/shared/theme.js'
import { GATEWAY_TOOL_PREFIX, type Thread } from '../src/shared/thread.js'

/** A fake setting that holds the current value and is rewritten by the setter (also records the order the setter was called in). */
function fakeSettings(): { settings: AgentSettings; values: Record<string, unknown>; applied: [string, unknown][] } {
  const values: Record<string, unknown> = { ...settingDefaults() }
  const applied: [string, unknown][] = []
  const apply = Object.fromEntries(
    AGENT_SETTING_NAMES.map((name) => [
      name,
      (value: unknown) => {
        applied.push([name, value])
        values[name] = value
      }
    ])
  ) as unknown as AgentSettingAppliers
  const settings = new AgentSettings({
    snapshot: (): SettingsSnapshot => ({ values: { ...(values as unknown as SettingValues) }, defaults: settingDefaults() }),
    apply
  })
  return { settings, values, applied }
}

describe('key classification (AGENT_SETTING_ACCESS)', () => {
  it('every key whose name is shown to the tool is classified (nothing falls to an implicit gated)', () => {
    const { settings } = fakeSettings()
    for (const view of settings.list().settings) {
      expect(Object.keys(AGENT_SETTING_ACCESS)).toContain(view.storageKey)
    }
  })

  it('every field of the settings editor is listed', () => {
    expect([...AGENT_SETTING_NAMES].sort()).toEqual(Object.keys(settingDefaults()).sort())
  })

  it('keys for approval, update, login, link, and parallel work are gated; display preferences are display', () => {
    const gated: SettingValueKey[] = [
      'autoAllowAll',
      'autoAllowTools',
      'bashDenyPatterns',
      'autoUpdate',
      'agentAutoUpdate',
      'autoLogin',
      'redmineBaseUrl',
      'maxConcurrent',
      'idleTimeoutMs',
      'defaultModelId',
      'defaultThinking',
      'sshAllowedHosts',
      'bundleMax',
      // TODO 976 review Y-1: includes the whole-OS hotkey (app.summon), so it goes through the approval inbox.
      'keybindings'
    ]
    for (const name of gated) expect(accessOf(name)).toBe('gated')
    const display: SettingValueKey[] = ['theme', 'locale', 'editor', 'fileSortOrder', 'threadCollapseDays', 'voiceLocale', 'gmailDraftFont', 'hiddenFiles']
    for (const name of display) expect(accessOf(name)).toBe('display')
  })

  it('keys for secrets, consent records, rules, and internal state have no classification and are invisible to the tool', () => {
    const { settings } = fakeSettings()
    const keys = settings.list().settings.map((view) => view.storageKey)
    for (const hidden of [WEB_TAB_READ_CONSENT, WEB_TRUSTED_CERTIFICATES, APPROVAL_RULES, WINDOW_BOUNDS]) {
      expect(AGENT_SETTING_ACCESS[hidden.key]).toBeUndefined()
      expect(keys).not.toContain(hidden.key)
    }
  })

  it('an unknown name is not called gated (the tool side refuses)', () => {
    expect(isGatedSettingName('autoAllowAll')).toBe(true)
    // TODO 1175: even full-delegation mode cannot be turned ON by the AI itself (it asks every time).
    expect(isGatedSettingName('fullDelegation')).toBe(true)
    expect(isGatedSettingName('theme')).toBe(false)
    expect(isGatedSettingName('webTabReadConsent')).toBe(false)
    expect(isGatedSettingName(42)).toBe(false)
  })
})

describe('AgentSettings (re-validating values)', () => {
  it('the list has value, default, allowed values, and whether approval is needed; names narrows it and unknown names go to unknown', () => {
    const { settings } = fakeSettings()
    const all = settings.list()
    expect(all.settings).toHaveLength(AGENT_SETTING_NAMES.length)
    const picked = settings.list(['theme', 'nope'])
    expect(picked.settings).toEqual([
      expect.objectContaining({
        name: 'theme',
        storageKey: UI_THEME.key,
        value: 'system',
        default: 'system',
        changeNeedsApproval: false
      })
    ])
    expect(picked.unknown).toEqual(['nope'])
  })

  it('refuses out-of-enum, wrong-type, and out-of-range values without rounding', () => {
    const { settings } = fakeSettings()
    const bad: [string, unknown][] = [
      ['theme', 'blue'],
      ['locale', 'fr'],
      ['notifyEnabled', 'yes'],
      ['maxConcurrent', 0],
      ['maxConcurrent', 9],
      ['maxConcurrent', 2.5],
      ['idleTimeoutMs', 1000],
      ['threadCollapseDays', -1],
      ['autoSaveDelayMs', Number.NaN],
      ['redmineBaseUrl', 'http://example.com'],
      ['redmineBaseUrl', 'https://user:pw@example.com'],
      ['defaultThinking', 'ultra'],
      ['autoAllowTools', 'Bash'],
      ['autoAllowTools', ['Read', 3]],
      ['bashDenyPatterns', Array.from({ length: 201 }, (_, i) => `p${i}`)],
      ['webTabReadConsent', true],
      ['__proto__', {}]
    ]
    for (const [name, value] of bad) {
      const result = settings.prepare(name, value)
      expect(result.ok, `${name} = ${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('allowed values pass and the Redmine URL is normalized; the same value is unchanged', () => {
    const { settings } = fakeSettings()
    const theme = settings.prepare('theme', 'dark')
    expect(theme).toMatchObject({ ok: true, value: { name: 'theme', value: 'dark', previous: 'system', access: 'display', unchanged: false } })
    const redmine = settings.prepare('redmineBaseUrl', 'https://redmine.example.com/')
    expect(redmine).toMatchObject({ ok: true, value: { value: 'https://redmine.example.com', access: 'gated' } })
    expect(settings.prepare('theme', 'system')).toMatchObject({ ok: true, value: { unchanged: true } })
    expect(settings.prepare('defaultModelId', null)).toMatchObject({ ok: true, value: { unchanged: true } })
  })

  it('commit goes through the setter and returns the re-read value', () => {
    const { settings, applied } = fakeSettings()
    const prepared = settings.prepare('fileSortOrder', 'name')
    if (!prepared.ok) throw new Error(prepared.error)
    expect(settings.commit(prepared.value)).toEqual({ name: 'fileSortOrder', value: 'name', previous: 'modified' })
    expect(applied).toEqual([['fileSortOrder', 'name']])
  })

  it('commit refuses without overwriting if the value changed after prepare (a change in the settings screen during the approval wait)', () => {
    const { settings, applied, values } = fakeSettings()
    const prepared = settings.prepare('autoAllowTools', ['Read'])
    if (!prepared.ok) throw new Error(prepared.error)
    values['autoAllowTools'] = ['Read', 'Grep']
    expect(() => settings.commit(prepared.value)).toThrow(/changed while waiting/)
    expect(applied).toEqual([])
    expect(values['autoAllowTools']).toEqual(['Read', 'Grep'])
  })

  it('stage 3: connection targets that are not asked, hidden files, key bindings, and the bundle count appear in the list and values can be validated and written', () => {
    const { settings, applied } = fakeSettings()
    const names = settings.list().settings.map((view) => view.name)
    for (const name of ['sshAllowedHosts', 'hiddenFiles', 'keybindings', 'bundleMax']) expect(names).toContain(name)
    expect(settings.list(['sshAllowedHosts']).settings[0]).toMatchObject({
      storageKey: APPROVAL_SSH_ALLOWED_HOSTS.key,
      changeNeedsApproval: true
    })
    expect(settings.list(['bundleMax']).settings[0]).toMatchObject({ storageKey: BUNDLE_MAX.key, value: 5, changeNeedsApproval: true })
    expect(settings.list(['hiddenFiles']).settings[0]).toMatchObject({ changeNeedsApproval: false })
    for (const [name, value] of [
      ['sshAllowedHosts', ['a b']],
      ['sshAllowedHosts', 'host'],
      ['hiddenFiles', 1],
      ['keybindings', { 'no.such.command': 'Cmd+K' }],
      ['keybindings', { 'web.reload': 'NotAKey+++' }],
      ['keybindings', []],
      ['bundleMax', 0],
      ['bundleMax', 9]
    ] as [string, unknown][]) {
      expect(settings.prepare(name, value).ok, `${name} = ${JSON.stringify(value)}`).toBe(false)
    }
    const hosts = settings.prepare('sshAllowedHosts', ['Dev.Example.com', 'me@Box', 'dev.example.com'])
    expect(hosts).toMatchObject({ ok: true, value: { value: ['dev.example.com', 'me@box'], access: 'gated', unchanged: false } })
    const keys = settings.prepare('keybindings', { 'web.reload': null })
    if (!keys.ok || !hosts.ok) throw new Error('prepare failed')
    expect(keys.value).toMatchObject({ access: 'gated', unchanged: false })
    settings.commit(hosts.value)
    settings.commit(keys.value)
    expect(applied).toEqual([
      ['sshAllowedHosts', ['dev.example.com', 'me@box']],
      ['keybindings', { 'web.reload': null }]
    ])
  })

  it('onChanged is called with the name after commit (a notice to open settings screens)', () => {
    const values: Record<string, unknown> = { ...settingDefaults() }
    const changed: string[] = []
    const apply = Object.fromEntries(
      AGENT_SETTING_NAMES.map((name) => [name, (value: unknown) => void (values[name] = value)])
    ) as unknown as AgentSettingAppliers
    const settings = new AgentSettings({
      snapshot: (): SettingsSnapshot => ({ values: { ...(values as unknown as SettingValues) }, defaults: settingDefaults() }),
      apply,
      onChanged: (name) => changed.push(name)
    })
    const prepared = settings.prepare('hiddenFiles', true)
    if (!prepared.ok) throw new Error(prepared.error)
    settings.commit(prepared.value)
    expect(changed).toEqual(['hiddenFiles'])
  })

  it('the rules for defaultModelId and idleTimeoutMs use constants and functions shared with the settings screen path', () => {
    const { settings } = fakeSettings()
    expect(isDefaultModelIdValue('x'.repeat(200))).toBe(true)
    expect(isDefaultModelIdValue('x'.repeat(201))).toBe(false)
    expect(settings.prepare('defaultModelId', 'x'.repeat(201))).toMatchObject({ ok: false })
    expect(settings.prepare('idleTimeoutMs', MIN_IDLE_TIMEOUT_MS - 1)).toMatchObject({ ok: false })
    expect(settings.prepare('idleTimeoutMs', MIN_IDLE_TIMEOUT_MS)).toMatchObject({ ok: true })
  })
})

function thread(): Thread {
  return { id: 't1', title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread
}

function gateway(answer: ApprovalResult, settings: AgentSettings | null): { requests: GatewayRequests; approvals: ApprovalRequestInput[] } {
  const approvals: ApprovalRequestInput[] = []
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: () => 't1',
    getThread: () => thread(),
    getLive: () => undefined,
    getAdapter: () => undefined,
    emitThread: () => undefined,
    record: () => undefined,
    hasPlanMode: () => false,
    subtaskOfToolUse: () => null,
    isQueueAwaitingResult: () => false,
    viewsOf: () => [],
    conflictingViews: () => [],
    requestApproval: async (input) => {
      approvals.push(input)
      return answer
    },
    appSettings: () => settings
  }
  return { requests: new GatewayRequests(host as GatewayRequestHost), approvals }
}

const ALLOW: ApprovalResult = { allowed: true, by: 'user', message: '' }
const DENY: ApprovalResult = { allowed: false, by: 'user', message: '', reply: { kind: 'stop' } }

describe('gateway getSettings / setSetting (GatewayRequests)', () => {
  it('getSettings returns the list', async () => {
    const { settings } = fakeSettings()
    const { requests } = gateway(ALLOW, settings)
    const result = (await requests.handle({ sessionId: 's1', kind: 'getSettings', payload: {} })) as { settings: unknown[] }
    expect(result.settings).toHaveLength(AGENT_SETTING_NAMES.length)
  })

  it('display preferences change without queueing in the approval inbox', async () => {
    const { settings, applied } = fakeSettings()
    const { requests, approvals } = gateway(DENY, settings)
    const result = await requests.handle({ sessionId: 's1', kind: 'setSetting', payload: { name: 'theme', value: 'dark' } })
    expect(result).toEqual({ ok: true, changed: true, name: 'theme', value: 'dark', previous: 'system' })
    expect(approvals).toEqual([])
    expect(applied).toEqual([['theme', 'dark']])
  })

  it('a gated key is asked in the approval inbox every time (alwaysAsk) and changed if approved', async () => {
    const { settings, applied } = fakeSettings()
    const { requests, approvals } = gateway(ALLOW, settings)
    const result = await requests.handle({
      sessionId: 's1',
      kind: 'setSetting',
      payload: { name: 'bashDenyPatterns', value: ['rm -rf'], callId: 'c1' }
    })
    expect(result).toMatchObject({ ok: true, changed: true, name: 'bashDenyPatterns', value: ['rm -rf'] })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      alwaysAsk: true,
      // TODO 1175: a change to a gate setting is marked as asking even in full-delegation mode.
      settingsGate: true,
      toolName: `${GATEWAY_TOOL_PREFIX}setSetting`,
      callId: 'c1',
      input: { name: 'bashDenyPatterns', value: ['rm -rf'] }
    })
    expect(approvals[0]?.summary).toContain('Change the aios setting bashDenyPatterns')
    expect(applied).toEqual([['bashDenyPatterns', ['rm -rf']]])
  })

  it('does not change when refused', async () => {
    const { settings, applied, values } = fakeSettings()
    const { requests, approvals } = gateway(DENY, settings)
    const result = (await requests.handle({
      sessionId: 's1',
      kind: 'setSetting',
      payload: { name: 'autoUpdate', value: false }
    })) as { error?: string }
    expect(approvals).toHaveLength(1)
    expect(result.error).toBeDefined()
    expect(applied).toEqual([])
    expect(values['autoUpdate']).toBe(true)
  })

  it('returns without asking for the same value or a value that fails validation', async () => {
    const { settings, applied } = fakeSettings()
    const { requests, approvals } = gateway(ALLOW, settings)
    expect(await requests.handle({ sessionId: 's1', kind: 'setSetting', payload: { name: 'autoAllowAll', value: true } })).toEqual({
      ok: true,
      changed: false,
      name: 'autoAllowAll',
      value: true
    })
    const bad = (await requests.handle({ sessionId: 's1', kind: 'setSetting', payload: { name: 'autoAllowAll', value: 'no' } })) as {
      error?: string
    }
    expect(bad.error).toContain('invalid value for autoAllowAll')
    expect(approvals).toEqual([])
    expect(applied).toEqual([])
  })

  it('refuses both when the path is not connected', async () => {
    const { requests } = gateway(ALLOW, null)
    expect(await requests.handle({ sessionId: 's1', kind: 'getSettings', payload: {} })).toHaveProperty('error')
    expect(await requests.handle({ sessionId: 's1', kind: 'setSetting', payload: { name: 'theme', value: 'dark' } })).toHaveProperty(
      'error'
    )
  })

  it('approve stage: setSetting for gated passes without queueing (the tool stage asks), display is handled normally', async () => {
    const { settings } = fakeSettings()
    const { requests, approvals } = gateway(ALLOW, settings)
    const toolName = `${GATEWAY_TOOL_PREFIX}setSetting`
    expect(
      await requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName, input: { name: 'autoAllowAll', value: false } } })
    ).toEqual({ allowed: true, message: '' })
    expect(approvals).toEqual([])
    await requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName, input: { name: 'theme', value: 'dark' } } })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.alwaysAsk).toBeUndefined()
  })
})

describe('gateway toolUseId / subtask handover (setSetting)', () => {
  it('the approval inbox request of the tool stage inherits the mark left by the approve stage', async () => {
    const { settings } = fakeSettings()
    const { requests, approvals } = gateway(ALLOW, settings)
    const toolName = `${GATEWAY_TOOL_PREFIX}setSetting`
    await requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName, toolUseId: 'tu1', input: { name: 'autoAllowAll', value: false } }
    })
    await requests.handle({
      sessionId: 's1',
      kind: 'setSetting',
      payload: { name: 'autoAllowAll', value: false, callId: 'c1', toolUseId: 'tu1' }
    })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ toolUseId: 'tu1', alwaysAsk: true })
  })
})

describe('reflecting to windows (notice from the existing setter)', () => {
  it('changing the theme makes ThemeController send a notice to all windows, as when changed from the settings screen, and it persists in the DB', async () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const store = new AppSettingsStore(db)
    const native: NativeThemeLike = { shouldUseDarkColors: false, themeSource: 'system', on: () => undefined }
    const pushed: ThemeState[] = []
    const theme = new ThemeController({ settings: store, native, onChanged: (state) => pushed.push(state) })
    const values: Record<string, unknown> = { ...settingDefaults() }
    const apply = Object.fromEntries(AGENT_SETTING_NAMES.map((name) => [name, vi.fn()])) as unknown as Record<string, unknown>
    apply['theme'] = (value: 'system' | 'light' | 'dark') => theme.setPreference(value)
    const settings = new AgentSettings({
      snapshot: () => ({
        values: { ...(values as unknown as SettingValues), theme: theme.state().preference },
        defaults: settingDefaults()
      }),
      apply: apply as unknown as AgentSettingAppliers
    })
    const { requests } = gateway(DENY, settings)
    const result = await requests.handle({ sessionId: 's1', kind: 'setSetting', payload: { name: 'theme', value: 'dark' } })
    expect(result).toMatchObject({ ok: true, value: 'dark' })
    expect(pushed).toEqual([{ preference: 'dark', resolved: 'dark' }])
    expect(store.readTyped(UI_THEME)).toBe('dark')
    db.close()
  })
})
