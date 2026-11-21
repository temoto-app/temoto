// @vitest-environment jsdom
/**
 * Item 187 (wave 14 bundle B): make the settings editor look like VS Code's settings editor.
 *
 * - The item table (`SETTINGS_ITEMS`) and the category order (`SETTINGS_CATEGORIES`). The diagnostic info comes last.
 * - Search (title, description, key name; keeps only items that contain all the words).
 * - Judging whether a value differs from the default (keys compared as sets; keys that do not count empty lines).
 * - main's defaults (`settingDefaults`) match each key's `parse(null)`.
 * - Actually render: changed items get a mark, the gear's 'reset to default' calls the existing setter with the default value, and search narrows the items. Per-thread settings are not in the settings editor.
 *
 * Neither a model nor Electron is used.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ApprovalPolicy, ApprovalPolicyPatch, ThreadCreateOptions } from '../src/shared/thread.js'
import { applySshHostsPatch } from '../src/shared/ssh-hosts.js'
import { SETTING_KEYS_WITHOUT_RESET, type SettingValues, type SettingsSnapshot } from '../src/shared/settings.js'
import {
  SETTINGS_CATEGORIES,
  SETTINGS_ITEMS,
  categoriesOf,
  countModified,
  currentCategory,
  filterSettingsItems,
  foldForSearch,
  isModified,
  type SettingsItem
} from '../src/renderer/src/settings-model.js'
import { settingDefaults, settingsSnapshot } from '../src/main/settings-snapshot.js'
import {
  APPROVAL_AUTO_ALLOW_ALL,
  APPROVAL_AUTO_ALLOW_TOOLS,
  APPROVAL_BASH_DENY_PATTERNS,
  EDITOR_ID,
  INPUT_ASCII_FOR_SEARCH,
  NOTIFY_ENABLED,
  SESSION_SETTINGS,
  UI_LOCALE,
  UI_THEME,
  VIEWER_AUTO_SAVE,
  VIEWER_AUTO_SAVE_DELAY,
  UPDATE_AUTO,
  AGENT_UPDATE_AUTO,
  VOICE_LOCALE,
  THREADS_COLLAPSE_OLD_AFTER_DAYS
} from '../src/common/settings-keys.js'
import { DEFAULT_SESSION_SETTINGS } from '../src/common/settings-keys.js'
import { en, ja } from './helpers/i18n.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULTS = settingDefaults()

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe('table of items and categories (item 187)', () => {
  it('items are grouped in category order, and the diagnostics information (about) is last', () => {
    const order = SETTINGS_ITEMS.map((entry) => SETTINGS_CATEGORIES.indexOf(entry.category))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(SETTINGS_CATEGORIES.at(-1)).toBe('about')
    expect(SETTINGS_ITEMS.at(-1)?.id).toBe('agentCli')
    expect(categoriesOf(SETTINGS_ITEMS)).toEqual(SETTINGS_CATEGORIES)
  })

  it('ids are unique, every item has a title and description in EN / JA, and every category has a name', () => {
    const ids = SETTINGS_ITEMS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const dict of [en, ja] as const) {
      const table = dict as Readonly<Record<string, string>>
      for (const entry of SETTINGS_ITEMS) {
        expect(table[`settings.item.${entry.id}.title`]).toBeTruthy()
        expect(table[`settings.item.${entry.id}.description`]).toBeTruthy()
      }
      for (const category of SETTINGS_CATEGORIES) {
        expect(table[`settings.category.${category}`]).toBeTruthy()
      }
    }
  })

  it('an item that can be reset to default has one value key each, with no overlap. A checkbox item is a boolean', () => {
    const values = SETTINGS_ITEMS.flatMap((entry) => (entry.value === null ? [] : [entry.value]))
    expect(new Set(values).size).toBe(values.length)
    // Values without a gear (ones with a dedicated control, or with no item on the screen) are listed in `SETTING_KEYS_WITHOUT_RESET`.
    expect(new Set([...values, ...SETTING_KEYS_WITHOUT_RESET])).toEqual(new Set(Object.keys(DEFAULTS)))
    for (const key of SETTING_KEYS_WITHOUT_RESET) expect(values).not.toContain(key)
    for (const entry of SETTINGS_ITEMS.filter((e) => e.kind === 'checkbox')) {
      expect(entry.value).not.toBeNull()
      expect(typeof DEFAULTS[entry.value as keyof SettingValues]).toBe('boolean')
    }
  })

  it('per-thread settings (retention period, log deletion, strict mode) are not in the table', () => {
    const ids: readonly string[] = SETTINGS_ITEMS.map((entry) => entry.id)
    for (const threadOnly of ['retention', 'clearThreadLog', 'strict', 'approvalStrict']) {
      expect(ids).not.toContain(threadOnly)
    }
  })
})

describe('search (item 187)', () => {
  const textOf = (entry: SettingsItem): string =>
    [
      en[`settings.category.${entry.category}`],
      en[`settings.item.${entry.id}.title`],
      en[`settings.item.${entry.id}.description`],
      entry.storageKey ?? ''
    ].join('\n')

  it('an empty term gives everything', () => {
    expect(filterSettingsItems(SETTINGS_ITEMS, '', textOf)).toBe(SETTINGS_ITEMS)
    expect(filterSettingsItems(SETTINGS_ITEMS, '   ', textOf)).toBe(SETTINGS_ITEMS)
  })

  it('「skill」 shows the Skills section (TODO 773). Also with the Japanese dictionary', () => {
    expect(filterSettingsItems(SETTINGS_ITEMS, 'skill', textOf).map((e) => e.id)).toEqual(['skills'])
    const jaText = (entry: SettingsItem): string =>
      [ja[`settings.category.${entry.category}`], ja[`settings.item.${entry.id}.title`], ja[`settings.item.${entry.id}.description`]].join('\n')
    expect(filterSettingsItems(SETTINGS_ITEMS, 'skill', jaText).map((e) => e.id)).toEqual(['skills'])
  })

  it('remains if it hits any of the title, description and key name. Case and full-width forms are ignored', () => {
    expect(filterSettingsItems(SETTINGS_ITEMS, 'THEME', textOf).map((e) => e.id)).toContain('theme')
    expect(filterSettingsItems(SETTINGS_ITEMS, 'ｔｈｅｍｅ', textOf).map((e) => e.id)).toContain('theme')
    // Key name (corresponds to the VS Code setting ID)
    expect(filterSettingsItems(SETTINGS_ITEMS, 'notify.enabled', textOf).map((e) => e.id)).toEqual([
      'notifyEnabled'
    ])
  })

  it('the terms must all be contained (AND)', () => {
    const hits = filterSettingsItems(SETTINGS_ITEMS, 'shell stop', textOf).map((e) => e.id)
    expect(hits).toEqual(['bashDenyPatterns'])
    expect(filterSettingsItems(SETTINGS_ITEMS, 'theme zzzz', textOf)).toEqual([])
  })

  it('only the categories of hit items remain in the table of contents', () => {
    const hits = filterSettingsItems(SETTINGS_ITEMS, 'model', textOf)
    expect(categoriesOf(hits)).toContain('newThread')
    expect(categoriesOf(hits)).not.toContain('mcp')
  })

  it('foldForSearch is NFKC + lowercase', () => {
    expect(foldForSearch('ＡＢＣ')).toBe('abc')
  })
})

describe('changed from default (item 187)', () => {
  it('unchanged if the value equals the default, changed if different', () => {
    expect(isModified('theme', { theme: DEFAULTS.theme }, DEFAULTS)).toBe(false)
    expect(isModified('theme', { theme: DEFAULTS.theme === 'dark' ? 'light' : 'dark' }, DEFAULTS)).toBe(true)
    expect(isModified('maxConcurrent', { maxConcurrent: DEFAULTS.maxConcurrent + 1 }, DEFAULTS)).toBe(true)
    expect(isModified('defaultModelId', { defaultModelId: null }, DEFAULTS)).toBe(false)
    expect(isModified('defaultModelId', { defaultModelId: 'opus' }, DEFAULTS)).toBe(true)
  })

  it('treated as unchanged while the value or default does not exist yet', () => {
    expect(isModified('theme', {}, DEFAULTS)).toBe(false)
    expect(isModified('theme', { theme: 'dark' }, null)).toBe(false)
  })

  it('auto-allowed tools are compared as an unordered set', () => {
    const reversed = [...DEFAULTS.autoAllowTools].reverse()
    expect(isModified('autoAllowTools', { autoAllowTools: reversed }, DEFAULTS)).toBe(false)
    expect(isModified('autoAllowTools', { autoAllowTools: reversed.slice(1) }, DEFAULTS)).toBe(true)
  })

  it('stop patterns do not count blank lines or surrounding whitespace', () => {
    expect(isModified('bashDenyPatterns', { bashDenyPatterns: ['', '  '] }, DEFAULTS)).toBe(false)
    expect(isModified('bashDenyPatterns', { bashDenyPatterns: ['rm -rf'] }, DEFAULTS)).toBe(true)
  })

  it('countModified counts only items that have values', () => {
    expect(countModified(SETTINGS_ITEMS, DEFAULTS, DEFAULTS)).toBe(0)
    expect(
      countModified(SETTINGS_ITEMS, { ...DEFAULTS, notifyEnabled: !DEFAULTS.notifyEnabled, maxConcurrent: 1 }, DEFAULTS)
    ).toBe(2)
  })
})

describe('highlighted category in the table of contents (item 187)', () => {
  it('takes the last heading past the top edge. The first if none is past it', () => {
    const tops = [
      { category: 'appearance' as const, top: -300 },
      { category: 'editor' as const, top: -20 },
      { category: 'notifications' as const, top: 120 }
    ]
    expect(currentCategory(tops)).toBe('editor')
    expect(currentCategory([{ category: 'mcp', top: 40 }])).toBe('mcp')
    expect(currentCategory([])).toBeNull()
  })
})

describe('main defaults (item 187)', () => {
  it('returns the same value as parse(null) of each key (does not write the default in 2 places)', () => {
    const session = SESSION_SETTINGS.parse(null)
    expect(DEFAULTS).toEqual({
      theme: UI_THEME.parse(null),
      locale: UI_LOCALE.parse(null),
      editor: EDITOR_ID.parse(null),
      notifyEnabled: NOTIFY_ENABLED.parse(null),
      autoLogin: true,
      asciiForSearch: INPUT_ASCII_FOR_SEARCH.parse(null),
      autoSave: VIEWER_AUTO_SAVE.parse(null),
      autoSaveDelayMs: VIEWER_AUTO_SAVE_DELAY.parse(null),
      autoUpdate: UPDATE_AUTO.parse(null),
      agentAutoUpdate: AGENT_UPDATE_AUTO.parse(null),
      voiceLocale: VOICE_LOCALE.parse(null),
      gmailDraftFont: 'default',
      threadCollapseDays: THREADS_COLLAPSE_OLD_AFTER_DAYS.parse(null),
      fileSortOrder: 'modified',
      redmineBaseUrl: '',
      screenshotOffer: true,
      releaseNotesAuto: true,
      openAtLogin: false,
      preventSleep: false,
      menuBar: false,
      maxConcurrent: session.maxConcurrent,
      idleTimeoutMs: session.idleTimeoutMs,
      defaultModelId: session.defaultModelId,
      defaultThinking: session.defaultThinking,
      autoAllowAll: APPROVAL_AUTO_ALLOW_ALL.parse(null),
      autoAllowTools: APPROVAL_AUTO_ALLOW_TOOLS.parse(null),
      bashDenyPatterns: APPROVAL_BASH_DENY_PATTERNS.parse(null),
      // TODO 1175: full delegation mode is off by default.
      fullDelegation: false,
      sshAllowedHosts: [],
      hiddenFiles: false,
      keybindings: {},
      bundleMax: 5
    })
    // The defaults of item 167 (stop patterns are empty) and of T40 (ask as little as possible) are visible as they are.
    expect(DEFAULTS.bashDenyPatterns).toEqual([])
    expect(DEFAULTS.autoAllowAll).toBe(true)
  })

  it('snapshot reads the current values from each entry point and returns them alongside the defaults', () => {
    const snapshot = settingsSnapshot({
      theme: () => 'dark',
      locale: () => 'ja',
      editor: () => DEFAULTS.editor,
      notifyEnabled: () => false,
      autoLogin: () => true,
      asciiForSearch: () => false,
      autoSave: () => ({ mode: 'afterDelay', delayMs: 1500 }),
      autoUpdate: () => false,
      agentAutoUpdate: () => true,
      voiceLocale: () => 'ja',
      gmailDraftFont: () => 'monospace',
      threadCollapseDays: () => 3,
      fileSortOrder: () => 'name',
      redmineBaseUrl: () => 'https://r.example.com',
      screenshotOffer: () => false,
      releaseNotesAuto: () => false,
      openAtLogin: () => true,
      preventSleep: () => false,
      menuBar: () => false,
      session: () => ({ maxConcurrent: 3, idleTimeoutMs: 60_000, defaultModelId: 'opus', defaultThinking: 'high' }),
      approval: () => ({ autoAllowAll: false, autoAllowTools: ['Bash'], bashDenyPatterns: ['sudo'], sshAllowedHosts: ['h1'] }),
      hiddenFiles: () => true,
      keybindings: () => ({ 'web.reload': null }),
      bundleMax: () => 3
    })
    expect(snapshot.defaults).toEqual(DEFAULTS)
    expect(snapshot.values).toMatchObject({
      theme: 'dark',
      locale: 'ja',
      notifyEnabled: false,
      autoLogin: true,
      asciiForSearch: false,
      autoSave: 'afterDelay',
      autoSaveDelayMs: 1500,
      autoUpdate: false,
      voiceLocale: 'ja',
      gmailDraftFont: 'monospace',
      threadCollapseDays: 3,
      fileSortOrder: 'name',
      redmineBaseUrl: 'https://r.example.com',
      screenshotOffer: false,
      sshAllowedHosts: ['h1'],
      hiddenFiles: true,
      keybindings: { 'web.reload': null },
      bundleMax: 3,
      maxConcurrent: 3,
      defaultModelId: 'opus',
      autoAllowAll: false,
      bashDenyPatterns: ['sudo']
    })
    expect(countModified(SETTINGS_ITEMS, snapshot.values, snapshot.defaults)).toBeGreaterThanOrEqual(8)
  })
})

// ---------------------------------------------------------------------------
// Rendering (jsdom)
// ---------------------------------------------------------------------------

const setPolicy = vi.fn(async (patch: ApprovalPolicyPatch): Promise<ApprovalPolicy> => {
  const next: ApprovalPolicy = {
    autoAllowAll: patch.autoAllowAll ?? policy.autoAllowAll,
    autoAllowTools: patch.autoAllowTools ?? policy.autoAllowTools,
    bashDenyPatterns: patch.bashDenyPatterns ?? policy.bashDenyPatterns,
    sshAllowedHosts: applySshHostsPatch(policy.sshAllowedHosts ?? [], patch),
    // TODO 1175: full delegation mode.
    ...(patch.fullDelegation === undefined && policy.fullDelegation === undefined
      ? {}
      : { fullDelegation: patch.fullDelegation ?? policy.fullDelegation })
  }
  return next
})
const setEnabled = vi.fn(async (enabled: boolean) => enabled)
let policy: ApprovalPolicy
/** A mock of the values main holds (TODO 1060 stage 3: values that change while the settings screen is open). */
let notifyNow = true
let editorNow: string = DEFAULTS.editor
const changedListeners = new Set<() => void>()

const options: ThreadCreateOptions = {
  backends: [],
  defaultBackend: 'x',
  cwdHistory: []
} as unknown as ThreadCreateOptions

function stubApi(): void {
  const snapshot: SettingsSnapshot = {
    values: { ...DEFAULTS, autoAllowAll: false },
    defaults: DEFAULTS
  }
  ;(window as unknown as { aios: unknown }).aios = {
    settings: {
      snapshot: async () => snapshot,
      onChanged: (listener: () => void) => {
        changedListeners.add(listener)
        return () => changedListeners.delete(listener)
      }
    },
    editor: { get: async () => editorNow, set: async (id: string) => id },
    approvals: {
      getPolicy: async () => policy,
      setPolicy,
      rules: async () => [],
      removeRule: async () => {}
    },
    notifications: { getEnabled: async () => notifyNow, setEnabled },
    input: { getAsciiForSearch: async () => true, setAsciiForSearch: async (enabled: boolean) => enabled },
    gmailDraftFont: { get: async () => 'default', set: async (font: string) => font },
    voice: {
      getLocale: async () => 'auto',
      setLocale: async (preference: string) => preference
    },
    threads: {
      createOptions: async () => options,
      removeCwdHistory: async () => {},
      clearCwdHistory: async () => {},
      clearAllLogs: async () => {}
    },
    fs: { volumes: async () => [], setVolumeAllowed: async () => [] },
    mcp: { report: async () => null, onReport: () => () => {} },
    // TODO 773: the Skills section. An empty list.
    skills: {
      list: async () => ({ skills: [], projectChecked: false }),
      trash: async () => ({ ok: true }),
      // TODO 1099: 'Install a CLI plugin' below the Skills section.
      pluginCatalog: async () => ({
        entries: [],
        matched: 0,
        total: 0,
        fetchedAt: null,
        unavailable: 'no-cache',
        refreshCommand: null,
        installed: [],
        opsDisabled: null
      }),
      pluginInstall: async () => ({ ok: true, already: false }),
      pluginUninstall: async () => ({ ok: true, already: false })
    },
    plugins: { list: async () => [], onChanged: () => () => {}, audit: async () => [] },
    agent: { getSettings: async () => ({ ...DEFAULT_SESSION_SETTINGS }), recheck: async () => null, backends: async () => [], getAutoLogin: async () => false, setAutoLogin: async (value: boolean) => value },
    // TODO 999: the new screenshot badge (on by default).
    recent: { getScreenshotOfferEnabled: async () => true, setScreenshotOfferEnabled: async (value: boolean) => value },
    // TODO 1186: open the change history after an update (on by default).
    releaseNotes: { getAuto: async () => true, setAuto: async (value: boolean) => value },
    osSettings: {
      get: async () => ({
        openAtLogin: { enabled: false, supported: false, reason: 'dev' },
        preventSleep: { enabled: false, active: false },
        menuBar: { enabled: false, supported: true }
      }),
      setOpenAtLogin: async () => ({
        openAtLogin: { enabled: false, supported: false, reason: 'dev' },
        preventSleep: { enabled: false, active: false },
        menuBar: { enabled: false, supported: true }
      }),
      setPreventSleep: async () => ({
        openAtLogin: { enabled: false, supported: false, reason: 'dev' },
        preventSleep: { enabled: false, active: false },
        menuBar: { enabled: false, supported: true }
      })
    },
    // Wave 18 bundle A: the list of scheduled runs (TODO 323). Empty.
    schedule: { list: async () => ({ jobs: [], autoRun: true }), onChanged: () => () => {} }
  }
}

describe('rendering the settings editor (item 187)', () => {
  let container: HTMLDivElement
  let root: Root
  let Settings: () => React.JSX.Element

  beforeAll(async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    stubApi()
    ;({ Settings } = await import('../src/renderer/src/components/Settings.js'))
  })

  beforeEach(async () => {
    policy = { autoAllowAll: false, autoAllowTools: ['Bash'], bashDenyPatterns: [] }
    notifyNow = true
    editorNow = DEFAULTS.editor
    changedListeners.clear()
    setPolicy.mockClear()
    stubApi()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(Settings))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const item = (id: string): HTMLElement => {
    const found = container.querySelector<HTMLElement>(`[data-setting="${id}"]`)
    if (found === null) throw new Error(`no item ${id}`)
    return found
  }

  it('shows the heading and table of contents per category, and the item title (category: name) and description', () => {
    const headings = [...container.querySelectorAll('.settings-category h2')].map((h) => h.textContent)
    expect(headings).toEqual(SETTINGS_CATEGORIES.map((c) => en[`settings.category.${c}`]))
    const toc = [...container.querySelectorAll('.settings-toc button')].map((b) => b.textContent)
    expect(toc).toEqual(headings)
    expect(item('theme').querySelector('.settings-item-title')?.textContent).toContain(
      `${en['settings.category.appearance']}: ${en['settings.item.theme.title']}`
    )
    expect(item('theme').querySelector('.settings-item-description')?.textContent).toBe(
      en['settings.item.theme.description']
    )
  })

  it("TODO 1060 stage 3: when a settings change is notified while open (the AI's setSetting, another window), the display of that item changes", async () => {
    const checkbox = (id: string): HTMLInputElement => {
      const input = item(id).querySelector<HTMLInputElement>('input[type="checkbox"]')
      if (input === null) throw new Error(`no checkbox ${id}`)
      return input
    }
    expect(checkbox('notifyEnabled').checked).toBe(true)
    expect(checkbox('autoAllowAll').checked).toBe(false)
    expect(item('autoAllowAll').classList.contains('modified')).toBe(true)
    expect(changedListeners.size).toBeGreaterThan(0)

    // The value on the main side changes, and a notice is sent.
    notifyNow = false
    policy = { ...policy, autoAllowAll: true }
    await act(async () => {
      for (const listener of changedListeners) listener()
      // Notices that arrive in a row are merged into one by the 100 ms debounce.
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    expect(checkbox('notifyEnabled').checked).toBe(false)
    expect(checkbox('autoAllowAll').checked).toBe(true)
    expect(item('autoAllowAll').classList.contains('modified')).toBe(false)
    expect(item('notifyEnabled').classList.contains('modified')).toBe(true)
  })

  it('closing also drops the notification subscription', () => {
    expect(changedListeners.size).toBeGreaterThan(0)
    act(() => root.unmount())
    expect(changedListeners.size).toBe(0)
    root = createRoot(container)
  })

  it('there is no Plugins section (TODO 367: moved to the extension view)', () => {
    expect(container.querySelector('[data-setting="plugins"]')).toBeNull()
    expect(container.querySelector('.plugin-table')).toBeNull()
  })

  it('a boolean item places the checkbox at the start of the description line', () => {
    const label = item('autoAllowAll').querySelector('label.settings-item-description')
    expect(label?.firstElementChild?.tagName).toBe('INPUT')
    expect(label?.textContent).toBe(en['settings.item.autoAllowAll.description'])
  })

  it("only items changed from default get a vertical line, and the gear's 「既定に戻す」 calls the setter with the default value", async () => {
    expect(item('autoAllowAll').classList.contains('modified')).toBe(true)
    expect(item('theme').classList.contains('modified')).toBe(false)
    expect(item('autoAllowAll').querySelector('.settings-item-modified')).not.toBeNull()

    const gear = item('autoAllowAll').querySelector<HTMLButtonElement>('.settings-item-gear button')
    await act(async () => gear?.click())
    const reset = item('autoAllowAll').querySelector<HTMLButtonElement>('[role="menuitem"]')
    expect(reset?.textContent).toBe(en['settings.reset'])
    expect(reset?.disabled).toBe(false)
    await act(async () => reset?.click())
    expect(setPolicy).toHaveBeenCalledWith({ autoAllowAll: DEFAULTS.autoAllowAll })
    expect(item('autoAllowAll').classList.contains('modified')).toBe(false)
  })

  it('「既定に戻す」 of an unchanged item cannot be pressed. An item with no value has no gear', async () => {
    const gear = item('theme').querySelector<HTMLButtonElement>('.settings-item-gear button')
    await act(async () => gear?.click())
    expect(item('theme').querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(true)
    expect(item('alwaysAllowed').querySelector('.settings-item-gear')).toBeNull()
    expect(item('agentCli').querySelector('.settings-item-gear')).toBeNull()
  })

  it('search narrows the items and table of contents, and shows 「該当なし」 if nothing matches', async () => {
    const search = container.querySelector<HTMLInputElement>('.settings-search')
    if (search === null) throw new Error('no search')
    const type = async (value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(search, value)
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await type('shell stop')
    expect([...container.querySelectorAll('[data-setting]')].map((e) => e.getAttribute('data-setting'))).toEqual([
      'bashDenyPatterns'
    ])
    expect(container.querySelectorAll('.settings-toc button')).toHaveLength(1)
    await type('no-such-setting-xyz')
    expect(container.querySelector('.settings-empty')?.textContent).toBe(en['settings.search.none'])
  })

  it('TODO 372: scheduled runs are not in settings (moved to the activity bar. One entry point)', () => {
    expect((SETTINGS_CATEGORIES as readonly string[]).includes('schedule')).toBe(false)
    expect(container.querySelector('[data-setting="scheduledJobs"]')).toBeNull()
    expect(container.querySelector('.schedule-settings, .schedule-form, .schedule-row')).toBeNull()
    expect(container.textContent).not.toContain(en['sidebar.mode.schedule'])
  })

  it("per-thread settings (strict mode, this thread's log) do not appear in the settings editor", () => {
    const text = container.textContent ?? ''
    expect(text).not.toContain(en['threadSettings.strict.title'])
    expect(text).not.toContain(en['threadSettings.clearLog'])
  })

  it("TODO 1005 part 1: one line at the top of the approvals section notes the CLI's own allow list (no control or gear)", () => {
    const notice = item('cliAllowNotice')
    expect(notice.querySelector('.settings-item-description')?.textContent).toBe(
      en['settings.item.cliAllowNotice.description']
    )
    expect(notice.querySelector('.settings-item-control')).toBeNull()
    expect(notice.querySelector('.settings-item-gear')).toBeNull()
    const approvalIds = SETTINGS_ITEMS.filter((entry) => entry.category === 'approval').map((entry) => entry.id)
    expect(approvalIds[0]).toBe('cliAllowNotice')
  })

  it('TODO 1175: full delegation mode shows a confirmation inside the field on check and sends only on 「有効にする」. 「やめる」 does not send. Turning it off is not confirmed', async () => {
    const entry = item('fullDelegation')
    expect(entry.querySelector('.settings-item-title')?.textContent).toContain(en['settings.item.fullDelegation.title'])
    const checkbox = (): HTMLInputElement => item('fullDelegation').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox().checked).toBe(false)
    expect(item('fullDelegation').querySelector('.full-delegation-confirm')).toBeNull()

    // Checking the box shows a confirmation, but does not send yet.
    await act(async () => checkbox().click())
    const confirm = item('fullDelegation').querySelector('.full-delegation-confirm')
    expect(confirm?.textContent).toContain(en['settings.fullDelegation.confirm'])
    expect(setPolicy).not.toHaveBeenCalled()
    const button = (label: string): HTMLButtonElement =>
      [...item('fullDelegation').querySelectorAll<HTMLButtonElement>('.full-delegation-confirm button')].find(
        (b) => b.textContent === label
      ) as HTMLButtonElement

    // [Cancel] closes the confirmation without sending, and the box is unchecked too.
    await act(async () => button(en['settings.fullDelegation.cancel']).click())
    expect(setPolicy).not.toHaveBeenCalled()
    expect(item('fullDelegation').querySelector('.full-delegation-confirm')).toBeNull()
    expect(checkbox().checked).toBe(false)

    // Check it again and press [Enable].
    await act(async () => checkbox().click())
    await act(async () => button(en['settings.fullDelegation.enable']).click())
    expect(setPolicy).toHaveBeenCalledWith({ fullDelegation: true })
    expect(item('fullDelegation').querySelector('.full-delegation-confirm')).toBeNull()
    expect(checkbox().checked).toBe(true)
    expect(item('fullDelegation').classList.contains('modified')).toBe(true)

    // Unchecking sends right away, without checking first.
    setPolicy.mockClear()
    await act(async () => checkbox().click())
    expect(setPolicy).toHaveBeenCalledWith({ fullDelegation: false })
    expect(item('fullDelegation').querySelector('.full-delegation-confirm')).toBeNull()
  })

  it('TODO 1031: the list of push destinations not asked about is collapsed (no item)', () => {
    expect(SETTINGS_ITEMS.some((entry) => (entry.id as string) === 'pushAllowedRemotes')).toBe(false)
  })

  it('TODO 1029: destinations not asked about are added (normalized) / removed, and an unreadable host is not added but gets a short message', async () => {
    const control = item('sshAllowedHosts')
    expect(control.textContent).toContain(en['settings.sshHosts.none'])
    const input = control.querySelector('input') as HTMLInputElement
    const type = async (value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
    }
    await type('host:22')
    expect(setPolicy).not.toHaveBeenCalled()
    expect(control.textContent).toContain(en['settings.sshHosts.invalid'])
    await type('kzm@WinBox')
    // Send a diff, not the whole list (so the stale list from when it was opened does not erase other additions).
    expect(setPolicy).toHaveBeenCalledWith({ sshAllowedHostsAdd: ['kzm@winbox'] })
    await vi.waitFor(() => expect(control.querySelector('.allow-list-value')?.textContent).toBe('kzm@winbox'))
    policy = { ...policy, sshAllowedHosts: ['kzm@winbox'] }
    setPolicy.mockClear()
    const remove = control.querySelector<HTMLButtonElement>('.allow-list-items button')
    await act(async () => remove?.click())
    expect(setPolicy).toHaveBeenCalledWith({ sshAllowedHostsRemove: ['kzm@winbox'] })
    expect(control.querySelector('.settings-item-gear')).toBeNull()
  })

  it('TODO 555: autosave is off by default. Choosing it sets the changed mark, and the wait time is passed clamped to the range on commit (Enter)', async () => {
    const { useAutoSave } = await import('../src/renderer/src/autoSaveStore.js')
    const select = item('autoSave').querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('off')
    expect([...select.options].map((o) => o.textContent)).toEqual([
      en['settings.autoSave.off'],
      en['settings.autoSave.afterDelay'],
      en['settings.autoSave.onFocusChange']
    ])
    expect(item('autoSave').classList.contains('modified')).toBe(false)
    await act(async () => {
      select.value = 'afterDelay'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useAutoSave.getState().mode).toBe('afterDelay')
    expect(item('autoSave').classList.contains('modified')).toBe(true)
    const input = item('autoSaveDelay').querySelector('input') as HTMLInputElement
    expect(input.value).toBe('1000')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(useAutoSave.getState().delayMs).toBe(100)
    expect(item('autoSaveDelay').classList.contains('modified')).toBe(true)
    useAutoSave.setState({ mode: 'off', delayMs: 1000 })
  })

  it("TODO 626: the voice input recognition language is auto by default, and choosing one calls main's setLocale", async () => {
    const select = item('voiceLocale').querySelector('select') as HTMLSelectElement
    await vi.waitFor(() => expect(select.value).toBe('auto'))
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'ja', 'en'])
    expect(item('voiceLocale').classList.contains('modified')).toBe(false)
    await act(async () => {
      select.value = 'ja'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(select.value).toBe('ja')
    expect(item('voiceLocale').classList.contains('modified')).toBe(true)
  })

  it('TODO 103: the 「更新」 section shows the current and latest versions and 「更新を確認」. If an installed version exists, 「再起動して更新」. OFF is the changed mark', async () => {
    const { useUpdate } = await import('../src/renderer/src/updateStore.js')
    const base = {
      supported: true,
      unsupportedReason: null,
      auto: true,
      current: '0.28.0',
      latest: null,
      staged: null,
      phase: 'idle' as const,
      checkedAt: null,
      failure: null,
      failureParams: null,
      held: null,
      justUpdated: null,
      keychainPromptExpected: false
    }
    const check = vi.fn(async () => ({ ...base, phase: 'up-to-date' as const, latest: '0.28.0', checkedAt: 1 }))
    ;(window as unknown as { aios: Record<string, unknown> }).aios['update'] = { check }
    await act(async () => useUpdate.setState({ status: base }))
    const section = item('updateStatus')
    expect(section.textContent).toContain(en['update.current'].replace('{version}', '0.28.0'))
    expect(section.textContent).toContain(en['update.latestUnknown'])
    const button = [...section.querySelectorAll('button')].find((b) => b.textContent === en['update.check'])
    await act(async () => button?.click())
    expect(check).toHaveBeenCalledTimes(1)
    expect(item('updateStatus').textContent).toContain(en['update.phase.upToDate'])
    expect(item('autoUpdate').classList.contains('modified')).toBe(false)

    await act(async () => useUpdate.setState({ status: { ...base, auto: false, phase: 'staged', staged: '0.29.0' } }))
    expect(item('autoUpdate').classList.contains('modified')).toBe(true)
    expect(item('updateStatus').textContent).toContain(en['update.restart'])
    // TODO 1090: only for an update that changes the signing principal, explain the keychain before the restart
    expect(item('updateStatus').textContent).not.toContain(en['update.keychain.intro'].replace('{keychainItem}', 'Temoto Safe Storage'))
    await act(async () =>
      useUpdate.setState({ status: { ...base, auto: false, phase: 'staged', staged: '0.29.0', keychainPromptExpected: true } })
    )
    expect(item('updateStatus').textContent).toContain(en['update.keychain.intro'].replace('{keychainItem}', 'Temoto Safe Storage'))
    expect(item('updateStatus').textContent).toContain(en['update.keychain.always'])

    // code-review: show the hold that install-temoto.sh returned for --version
    await act(async () =>
      useUpdate.setState({ status: { ...base, phase: 'held', latest: '0.30.0', held: '0.30.0' } })
    )
    expect(item('updateStatus').textContent).toContain(en['update.held'].replaceAll('{version}', '0.30.0'))
    expect(item('updateStatus').textContent).toContain(en['update.phase.held'].replace('{version}', '0.30.0'))
    expect(item('updateStatus').textContent).not.toContain(en['update.install'])

    // A form that does not work shows the reason and cannot be operated
    await act(async () =>
      useUpdate.setState({ status: { ...base, supported: false, unsupportedReason: 'dev-shell' } })
    )
    expect(item('updateStatus').textContent).toContain(en['update.unsupported.dev-shell'])
    expect((item('autoUpdate').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    useUpdate.setState({ status: null })
  })

  it('TODO 774: the agent CLI version, unverified version and 「今すぐ更新」. 「前の版に戻す」 only when the check fails', async () => {
    const { useAgentUpdate } = await import('../src/renderer/src/agentUpdateStore.js')
    const base = {
      supported: true,
      unsupportedReason: null,
      auto: true,
      autoBlockedByBackend: false,
      heldFrom: null,
      heldUntil: null,
      current: '2.1.296',
      unverified: false,
      phase: 'idle' as const,
      checkedAt: null,
      nextCheckAt: null,
      waiting: null,
      failure: null,
      failureParams: null,
      lastUpdate: null,
      revertTo: null,
      notice: null
    }
    const updated = {
      ...base,
      phase: 'updated' as const,
      current: '2.1.300',
      unverified: true,
      checkedAt: 1,
      lastUpdate: { from: '2.1.296', to: '2.1.300', at: 1 }
    }
    const run = vi.fn(async () => updated)
    const HELD_UNTIL = Date.UTC(2026, 9, 20, 12)
    const revert = vi.fn(async () => ({ ...base, phase: 'reverted' as const, heldFrom: '2.1.300', heldUntil: HELD_UNTIL }))
    ;(window as unknown as { aios: Record<string, unknown> }).aios['agentUpdate'] = { run, revert }
    await act(async () => useAgentUpdate.setState({ status: base }))
    const section = item('agentUpdateStatus')
    expect(section.textContent).toContain(en['agentUpdate.current'].replace('{version}', '2.1.296'))
    expect(section.textContent).not.toContain(en['agentUpdate.unverified'])
    const runButton = [...section.querySelectorAll('button')].find((b) => b.textContent === en['agentUpdate.run'])
    await act(async () => runButton?.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(item('agentUpdateStatus').textContent).toContain(en['agentUpdate.unverified'])
    expect(item('agentUpdateStatus').textContent).toContain(
      en['agentUpdate.phase.updated'].replace('{from}', '2.1.296').replace('{to}', '2.1.300')
    )
    const revertLabel = en['agentUpdate.revert'].replace('{version}', '2.1.296')
    expect(item('agentUpdateStatus').textContent).not.toContain(revertLabel)

    await act(async () => useAgentUpdate.setState({ status: { ...updated, revertTo: '2.1.296' } }))
    const revertButton = [...item('agentUpdateStatus').querySelectorAll('button')].find(
      (b) => b.textContent === revertLabel
    )
    await act(async () => revertButton?.click())
    expect(revert).toHaveBeenCalledTimes(1)
    expect(item('agentUpdateStatus').textContent).toContain(en['agentUpdate.held']
        .replace('{version}', '2.1.300')
        .replace('{date}', new Date(HELD_UNTIL).toLocaleDateString())
    )

    // TODO 1143: while waiting, and the next confirmation
    await act(async () => useAgentUpdate.setState({ status: { ...base, waiting: 'session' } }))
    expect(item('agentUpdateStatus').textContent).toContain(en['agentUpdate.waiting.hint'])
    const NEXT = Date.now() + 3_600_000
    await act(async () => useAgentUpdate.setState({ status: { ...base, nextCheckAt: NEXT } }))
    expect(item('agentUpdateStatus').textContent).toContain(
      en['agentUpdate.nextCheck'].replace('{when}', new Date(NEXT).toLocaleString())
    )
    // If the deadline has passed, show 'soon' rather than a past time; while it is running, show 'checking'
    const PAST = Date.now() - 60_000
    await act(async () => useAgentUpdate.setState({ status: { ...base, nextCheckAt: PAST } }))
    expect(item('agentUpdateStatus').textContent).toContain(en['agentUpdate.nextCheckSoon'])
    expect(item('agentUpdateStatus').textContent).not.toContain(new Date(PAST).toLocaleString())
    await act(async () => useAgentUpdate.setState({ status: { ...base, phase: 'updating' as const, nextCheckAt: PAST } }))
    expect(item('agentUpdateStatus').textContent).toContain(en['agentUpdate.checkingNow'])
    expect(item('agentUpdateStatus').textContent).not.toContain(en['agentUpdate.nextCheckSoon'])

    // A form that does not work shows the reason and cannot be operated
    await act(async () => useAgentUpdate.setState({ status: { ...base, supported: false, unsupportedReason: 'instance' } }))
    expect(item('agentUpdateStatus').textContent).toContain(en['agentUpdate.unsupported.instance'])
    expect((item('agentAutoUpdate').querySelector('input') as HTMLInputElement).disabled).toBe(true)
    useAgentUpdate.setState({ status: null })
  })

  // code-review fix (TODO 697): if deleting fails, re-fetch the list and show a short message.
  it('TODO 697: if clearing logged-in sites fails, re-fetches the list and shows the message', async () => {
    let sites = [{ domain: 'google.com', hostCount: 2, cookieCount: 3 }]
    const loginSites = vi.fn(async () => sites)
    const clearLoginSite = vi.fn(async () => {
      sites = []
      throw new Error('boom')
    })
    ;(window as unknown as { aios: Record<string, unknown> }).aios['web'] = {
      loginSites,
      clearLoginSite,
      clearAllLoginSites: async () => [],
      trustedCertificates: async () => []
    }
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(Settings))
    })
    const section = item('loginSites')
    expect(section.textContent).toContain('google.com')
    expect(section.querySelector('.login-sites-failed')).toBeNull()
    const clear = section.querySelector<HTMLButtonElement>('.login-site-clear')
    await act(async () => clear?.click())
    expect(clearLoginSite).toHaveBeenCalledWith('google.com')
    expect(loginSites).toHaveBeenCalledTimes(2)
    expect(item('loginSites').querySelector('.login-sites-failed')?.textContent).toBe(
      en['settings.loginSites.clearFailed']
    )
    expect(item('loginSites').textContent).not.toContain('google.com')
    expect(ja['settings.loginSites.clearFailed']).toBeTruthy()
  })
})
