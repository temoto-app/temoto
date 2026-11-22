// @vitest-environment jsdom
/**
 * TODO 367 (wave 20 bundle A): draw the extensions view (in the shape of the VS Code Extensions view) with jsdom.
 *
 * - "Extensions" appears in the Activity Bar after Search, and pressing it turns the sidebar into a list (⌘⇧X is `showSidebarMode`)
 * - List: the headings "Installed" and "Built-in"; each row shows the name, version, one-line description, id, and state. Pressing a row opens the details in the ThreadPane area
 *   (TODO 458. Previously a temporary display in the ViewerPane)
 * - The "Audit log (all)" heading likewise opens the whole audit log in the same area
 * - The settings editor, scheduled-job editing, and extension details share the same area, and whichever is opened last wins (`mainPanel.ts`)
 * - Details: tabs for Overview / Contributions / Permissions / Run status. Run status reads only that extension's audit log
 * - Built-in ones can also be disabled (TODO 460). Only the last fallback (aios.text) cannot be pressed (aria-disabled), and a tooltip plus a line beside it shows why
 * - Extensions that are not built-in can toggle enabled/disabled and consent
 *
 * `window.aios` is a fake. Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AuditEntry, PluginDetail, PluginSummary } from '../src/shared/plugin.js'
import { en } from './helpers/i18n.js'
import { TOOLTIP_DELAY_MS } from '../src/renderer/src/components/Tooltip.js'
import { modeKeyLabel } from '../src/renderer/src/shortcuts.js'
import { SETTINGS_CATEGORIES, SETTINGS_ITEMS } from '../src/renderer/src/settings-model.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function summary(patch: Partial<PluginSummary> & Pick<PluginSummary, 'id'>): PluginSummary {
  return {
    name: patch.id,
    displayName: patch.id,
    description: null,
    publisher: null,
    iconUrl: null,
    version: '1.0.0',
    activityBar: null,
    bundled: true,
    required: false,
    enabled: true,
    capabilities: ['fs'],
    consented: ['fs'],
    hasViewer: true,
    host: 'none',
    crashes: 0,
    update: { state: 'up-to-date', latest: '1.0.0' },
    ...patch
  }
}

const markdown = summary({
  id: 'aios.markdown',
  name: 'Markdown',
  displayName: 'Markdown',
  description: 'Renders and edits Markdown.',
  capabilities: ['fs', 'ui'],
  consented: ['fs', 'ui'],
  host: 'crashed',
  crashes: 2
})
const text = summary({ id: 'aios.text', name: 'テキスト', displayName: 'Text', description: 'Plain text.', required: true })
const extra = summary({
  id: 'acme.mail',
  name: 'Mail',
  displayName: 'Acme Mail',
  description: 'Reads mail.',
  publisher: 'acme',
  bundled: false,
  capabilities: ['network'],
  consented: [],
  hasViewer: false,
  host: 'stopped'
})

function detailOf(plugin: PluginSummary): PluginDetail {
  if (plugin.id === 'aios.markdown') {
    return {
      summary: plugin,
      contributions: {
        viewer: { extensions: ['md', 'markdown'], schemes: [], payloads: [], editable: true, priority: 20, fallback: false },
        commands: [{ id: 'outline', title: 'Outline', sideEffect: false }],
        mcp: false,
        indexer: null
      },
      permissions: [
        { capability: 'fs', consented: true, targets: [] },
        { capability: 'ui', consented: true, targets: [] }
      ],
      restartLimit: 3,
      enabledReset: false
    }
  }
  return {
    summary: plugin,
    contributions: { viewer: null, commands: [], mcp: true, indexer: { interval: '15m' } },
    permissions: [
      {
        capability: 'network',
        consented: plugin.consented.includes('network'),
        targets: [{ mode: null, value: 'api.acme.test' }]
      }
    ],
    restartLimit: 3,
    enabledReset: false
  }
}

const auditEntries: AuditEntry[] = [
  { at: 1, pluginId: 'aios.markdown', capability: 'fs', op: 'read', target: '/tmp/a.md', decision: 'allow', reason: null, ms: 1 },
  { at: 2, pluginId: 'aios.markdown', capability: 'net', op: 'fetch', target: 'x.test', decision: 'deny', reason: 'undeclared', ms: 0 }
]

let plugins: PluginSummary[]
let api: {
  list: ReturnType<typeof vi.fn>
  detail: ReturnType<typeof vi.fn>
  audit: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  setConsent: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  updateAll: ReturnType<typeof vi.fn>
  uninstall: ReturnType<typeof vi.fn>
}

function stubApi(): void {
  plugins = [text, markdown, extra]
  api = {
    list: vi.fn(async () => plugins),
    detail: vi.fn(async (id: string) => {
      const found = plugins.find((p) => p.id === id)
      return found === undefined ? null : detailOf(found)
    }),
    audit: vi.fn(async () => auditEntries),
    setEnabled: vi.fn(async () => {}),
    setConsent: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    updateAll: vi.fn(async () => []),
    uninstall: vi.fn(async () => {})
  }
  ;(window as unknown as { aios: unknown }).aios = {
    plugins: {
      ...api,
      onChanged: () => () => undefined,
      surfaces: async () => ({ sidebar: [], status: [] }),
      onSurfacesChanged: () => () => undefined
    },
    search: { getStatus: async () => null, onStatus: () => () => undefined },
    app: { onMenuCommand: () => () => undefined },
    editor: { reveal: vi.fn() },
    // Wave 20 bundle B (TODO 372): Sidebar subscribes to `schedule` for the dot of scheduled runs (added at merge).
    schedule: { list: async () => ({ jobs: [], autoRun: true }), onChanged: () => () => undefined },
    // TODO 1216: Sidebar also subscribes to the list of triggers.
    trigger: { list: async () => ({ autoRun: true, queued: 0, triggers: [] }), onChanged: () => () => undefined },
    // TODO 972: and to the role (Teammate) list.
    roles: { list: async () => [], onChanged: () => () => undefined },
    // Wave 56 bundle A (TODO 952 stage 1): the "Account" field of the overview reads the state. An extension with no declaration gets an empty list.
    pluginAccounts: { status: async () => [] },
    // TODO 1225: the "Settings" of the extension details. An extension with no declaration gets null.
    pluginSettings: { get: async () => null, save: async () => null }
  }
}

let reactRoot: Root
let host: HTMLDivElement

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  stubApi()
  const { useStore } = await import('../src/renderer/src/store.js')
  useStore.setState({ transient: null, selectedUri: null })
  const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
  useExtensionPane.setState({ view: null })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('Activity Bar and Cmd+Shift+X (TODO 367)', () => {
  it('"Extensions" is lined up after search, and pressing it turns the sidebar into a list', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    // Start from the collapsed state (so that the panel's contents, which depend on the thread list, are not drawn). Icons of another mode still open when collapsed.
    useThreads.setState({ mode: 'threads', sidebarCollapsed: true })
    const { Sidebar } = await import('../src/renderer/src/components/Sidebar.js')
    act(() => reactRoot.render(createElement(Sidebar)))
    const items = [...host.querySelectorAll<HTMLButtonElement>('.activity-bar .activity-item')]
    const labels = items.map((item) => item.getAttribute('aria-label'))
    const search = labels.indexOf(en['sidebar.mode.search'])
    const extensions = labels.indexOf(en['sidebar.mode.extensions'])
    expect(search).toBeGreaterThanOrEqual(0)
    expect(extensions).toBeGreaterThan(search)
    // Settings stays at the bottom (last).
    expect(labels[labels.length - 1]).toBe(en['settings.title'])
    // Icon-only buttons do not have an OS title (item 320).
    expect(items[extensions]?.hasAttribute('title')).toBe(false)

    await act(async () => items[extensions]?.click())
    await flush()
    expect(useThreads.getState().mode).toBe('extensions')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    expect(host.querySelector('.extensions-list')).not.toBeNull()
    // The status bar at the bottom is not shown (the scan status belongs to file mode).
    expect(host.querySelector('.status-bar')).toBeNull()
  })

  it("Cmd+Shift+X (the menu's showExtensions) leaves the extensions view open and does not fold it with the key", async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { showSidebarMode } = await import('../src/renderer/src/shortcut-actions.js')
    useThreads.setState({ mode: 'files', sidebarCollapsed: true })
    showSidebarMode('extensions')
    expect(useThreads.getState().mode).toBe('extensions')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    showSidebarMode('extensions')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    expect(modeKeyLabel('extensions', 'mac')).toBe('⇧⌘X')
    expect(modeKeyLabel('extensions', 'other')).toBe('Ctrl+Shift+X')
  })
})

describe('list (ExtensionsMode)', () => {
  async function renderList(): Promise<void> {
    const { ExtensionsMode } = await import('../src/renderer/src/components/ExtensionsMode.js')
    act(() => reactRoot.render(createElement(ExtensionsMode)))
    await flush()
  }

  it('headings go Installed → Built-in; a row shows name, version, one-line description, id and state', async () => {
    await renderList()
    const headings = [...host.querySelectorAll('.extensions-section-heading')].map(
      (h) => h.firstElementChild?.textContent
    )
    expect(headings).toEqual([en['extensions.section.installed'], en['extensions.section.builtin']])
    const sections = host.querySelectorAll('.extensions-section')
    const installedIds = [...(sections[0]?.querySelectorAll('.extension-row') ?? [])].map((r) => r.getAttribute('data-plugin-id'))
    const builtinIds = [...(sections[1]?.querySelectorAll('.extension-row') ?? [])].map((r) => r.getAttribute('data-plugin-id'))
    expect(installedIds).toEqual(['acme.mail'])
    // Built-in ones are in display-name order.
    expect(builtinIds).toEqual(['aios.markdown', 'aios.text'])

    const row = host.querySelector<HTMLElement>('[data-plugin-id="aios.markdown"]')
    expect(row?.querySelector('.extension-row-name')?.textContent).toBe('Markdown')
    expect(row?.querySelector('.extension-row-version')?.textContent).toBe('1.0.0')
    expect(row?.querySelector('.extension-row-description')?.textContent).toBe('Renders and edits Markdown.')
    expect(row?.textContent).not.toContain('aios.markdown')
    expect(row?.querySelector('.extension-status')?.textContent).toBe(
      en['extensions.status.crashed'].replace('{count}', '2')
    )
    expect(host.querySelector('[data-plugin-id="aios.text"] .extension-status')?.textContent).toBe(
      en['extensions.status.none']
    )
    expect(host.querySelector('[data-plugin-id="acme.mail"] .extension-status')?.textContent).toBe(
      en['extensions.status.idle']
    )
  })

  it('the icon draws iconUrl as an <img> (SVG is not inlined), and falls back to the default icon when absent or unreadable (TODO 524)', async () => {
    plugins = [{ ...markdown, iconUrl: 'aios-plugin://aios.markdown/icon.svg' }, text]
    await renderList()
    const img = host.querySelector<HTMLImageElement>('[data-plugin-id="aios.markdown"] .extension-row-icon img')
    expect(img?.getAttribute('src')).toBe('aios-plugin://aios.markdown/icon.svg')
    expect(host.querySelector('[data-plugin-id="aios.markdown"] .extension-row-icon svg')).toBeNull()
    expect(host.querySelector('[data-plugin-id="aios.text"] .extension-row-icon img')).toBeNull()
    expect(host.querySelector('[data-plugin-id="aios.text"] .extension-row-icon svg')).not.toBeNull()
    act(() => img?.dispatchEvent(new Event('error')))
    expect(host.querySelector('[data-plugin-id="aios.markdown"] .extension-row-icon img')).toBeNull()
    expect(host.querySelector('[data-plugin-id="aios.markdown"] .extension-row-icon svg')).not.toBeNull()
  })

  it('when there are only built-in ones, "Installed" is an empty notice', async () => {
    plugins = [text]
    await renderList()
    expect(host.querySelector('.extensions-section .extensions-empty')?.textContent).toBe(en['extensions.installedEmpty'])
  })

  it('pressing a row opens the details in the ThreadPane place (TODO 458), and that row is selected; there is also an entry point to the audit log (whole)', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useStore.setState({ selectedUri: 'file:///x/a.ts' })
    await renderList()
    const row = host.querySelector<HTMLButtonElement>('[data-plugin-id="aios.text"]')
    await act(async () => row?.click())
    expect(useExtensionPane.getState().view).toEqual({ kind: 'extension', pluginId: 'aios.text' })
    // Do not touch the ViewerPane (the open file stays as it is, and no temporary display is set up).
    expect(useStore.getState().selectedUri).toBe('file:///x/a.ts')
    expect(useStore.getState().transient).toBeNull()
    expect(host.querySelector('[data-plugin-id="aios.text"]')?.classList.contains('selected')).toBe(true)

    const audit = host.querySelector<HTMLButtonElement>('.extensions-audit')
    expect(audit?.getAttribute('aria-label')).toBe(en['extensions.auditAll'])
    expect(audit?.hasAttribute('title')).toBe(false)
    await act(async () => audit?.click())
    expect(useExtensionPane.getState().view).toEqual({ kind: 'audit' })
    expect(useStore.getState().transient).toBeNull()
  })
})

describe('details (ThreadPane place, TODO 458)', () => {
  async function renderDetail(pluginId: string): Promise<void> {
    const { ExtensionPanel } = await import('../src/renderer/src/components/ExtensionDetailPane.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useExtensionPane.getState().openExtension(pluginId)
    act(() => reactRoot.render(createElement(ExtensionPanel)))
    await flush()
  }
  const tabs = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panel = (): HTMLElement | null => host.querySelector('[role="tabpanel"]')

  it('a heading and four tabs; the default is Overview', async () => {
    await renderDetail('aios.markdown')
    expect(api.detail).toHaveBeenCalledWith('aios.markdown')
    expect(host.querySelector('.extension-detail-name')?.textContent).toContain('Markdown')
    expect(tabs().map((tab) => tab.textContent)).toEqual([
      en['extensions.tab.overview'],
      en['extensions.tab.contributions'],
      en['extensions.tab.permissions'],
      en['extensions.tab.runtime']
    ])
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')
    expect(panel()?.textContent).toContain(en['extensions.overview.isolation'])
    // Drawn in the same frame as the settings editor (`.thread-pane.settings-editor`), so the neighboring ThreadPane is hidden by CSS.
    // No longer drawn in the frame of the ViewerPane's temporary display.
    expect(host.querySelector('.thread-pane.settings-editor.extension-detail')).not.toBeNull()
    expect(host.querySelector('.viewer-transient')).toBeNull()
    expect(host.querySelector('.extension-editor-title')?.textContent).toBe('Markdown')
    expect(host.querySelector('.extension-editor-id')).toBeNull()
  })

  it('feature contributions: extension, editing, priority, command', async () => {
    await renderDetail('aios.markdown')
    await act(async () => tabs()[1]?.click())
    const content = panel()?.textContent ?? ''
    expect(content).toContain('.md, .markdown')
    expect(content).toContain(en['extensions.contrib.editableYes'])
    expect(content).toContain('outline')
    expect(content).toContain(en['extensions.contrib.priorityValue'].replace('{priority}', '20'))
  })

  it('permissions: the declared capabilities and consent; when the fs scope is empty, "only the opened file"; built-in ones show no toggle', async () => {
    await renderDetail('aios.markdown')
    await act(async () => tabs()[2]?.click())
    const fs = host.querySelector('[data-capability="fs"]')
    expect(fs?.textContent).toContain(en['plugins.capability.fs'])
    expect(fs?.textContent).toContain(en['extensions.perm.fsOpened'])
    expect(fs?.textContent).toContain(en['extensions.perm.granted'])
    expect(host.querySelector('.extension-consent-toggle')).toBeNull()
    expect(panel()?.textContent).toContain(en['extensions.perm.builtinConsent'])
  })

  it('runtime status: process state and crash count, and the audit log of only that extension', async () => {
    await renderDetail('aios.markdown')
    await act(async () => tabs()[3]?.click())
    await flush()
    expect(api.audit).toHaveBeenCalledWith(50, 'aios.markdown')
    const content = panel()?.textContent ?? ''
    expect(content).toContain(en['extensions.runtime.crashCount'].replace('{count}', '2').replace('{limit}', '3'))
    const rows = host.querySelectorAll('.audit-log > div')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.classList.contains('deny')).toBe(true)
    // This is a table for that extension alone, so no plugin column is shown.
    expect(host.querySelector('.audit-log .audit-plugin')).toBeNull()
  })

  it('tabs can be moved with ← →', async () => {
    await renderDetail('aios.markdown')
    const list = host.querySelector<HTMLElement>('[role="tablist"]')
    act(() => {
      list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(tabs()[3]?.getAttribute('aria-selected')).toBe('true')
    act(() => {
      list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('TODO 460: even a built-in one can be disabled unless it is the fallback', async () => {
    await renderDetail('aios.markdown')
    const action = host.querySelector<HTMLButtonElement>('.extension-action')
    expect(action?.hasAttribute('aria-disabled')).toBe(false)
    expect(action?.classList.contains('disabled')).toBe(false)
    await act(async () => action?.click())
    expect(api.setEnabled).toHaveBeenCalledWith('aios.markdown', false)
    expect(host.querySelector('.extension-action-note')).toBeNull()
  })

  it('TODO 460: a disabled built-in one shows "enable" and a sentence about where it goes', async () => {
    plugins = [text, { ...markdown, enabled: false }, extra]
    await renderDetail('aios.markdown')
    const action = host.querySelector<HTMLButtonElement>('.extension-action')
    expect(action?.textContent).toBe(en['plugins.enable'])
    expect(host.querySelector('.extension-action-note')?.textContent).toBe(en['extensions.disabledNote'])
    expect(host.querySelector('.extension-detail-meta .extension-status')?.textContent).toBe(en['extensions.status.disabled'])
    await act(async () => action?.click())
    expect(api.setEnabled).toHaveBeenCalledWith('aios.markdown', true)
  })

  it('"disable" for the last fallback (aios.text) is in a form that cannot be pressed, does not call when pressed, and the reason shows in the sentence beside it and a bubble', async () => {
    vi.useFakeTimers()
    await renderDetail('aios.text')
    const action = host.querySelector<HTMLButtonElement>('.extension-action')
    expect(action?.textContent).toBe(en['plugins.disable'])
    expect(action?.getAttribute('aria-disabled')).toBe('true')
    // Do not set the `disabled` attribute (if set, mouse enter and leave do not arrive, and the tooltip does not appear).
    expect(action?.disabled).toBe(false)
    act(() => action?.click())
    expect(api.setEnabled).not.toHaveBeenCalled()
    act(() => {
      action?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    })
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10)
    })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(en['extensions.disableRequiredHint'])
    expect(host.querySelector('.extension-action-note')?.textContent).toBe(en['extensions.disableRequiredHint'])
  })

  it('a non-built-in extension can be disabled and its consent can be toggled', async () => {
    await renderDetail('acme.mail')
    const action = host.querySelector<HTMLButtonElement>('.extension-action')
    expect(action?.hasAttribute('aria-disabled')).toBe(false)
    await act(async () => action?.click())
    expect(api.setEnabled).toHaveBeenCalledWith('acme.mail', false)
    expect(host.querySelector('.extension-detail-meta')?.textContent).toContain('acme')

    await act(async () => tabs()[2]?.click())
    expect(host.querySelector('[data-capability="network"]')?.textContent).toContain('api.acme.test')
    const toggle = host.querySelector<HTMLButtonElement>('.extension-consent-toggle')
    expect(toggle?.textContent).toBe(en['extensions.perm.grant'])
    await act(async () => toggle?.click())
    expect(api.setConsent).toHaveBeenCalledWith('acme.mail', 'network', true)

    await act(async () => tabs()[1]?.click())
    expect(panel()?.textContent).toContain(en['extensions.contrib.indexerInterval'].replace('{interval}', '15m'))
    expect(panel()?.textContent).toContain(en['extensions.contrib.mcpDeclared'])
  })

  it('TODO 1233: a non-built-in extension has "uninstall", which removes without confirmation and closes the details; not shown for built-in ones', async () => {
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    await renderDetail('aios.markdown')
    expect(host.querySelector('.extension-uninstall-action')).toBeNull()
    await renderDetail('acme.mail')
    const button = host.querySelector<HTMLButtonElement>('.extension-uninstall-action')
    expect(button?.textContent).toBe(en['extensions.uninstall'])
    await act(async () => button?.click())
    await flush()
    expect(api.uninstall).toHaveBeenCalledWith('acme.mail')
    expect(useExtensionPane.getState().view).toBeNull()
  })

  it('TODO 1233: when uninstall is refused, shows the reason and leaves the details open', async () => {
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    const { reasonError } = await import('../src/shared/reason.js')
    api.uninstall.mockImplementation(async () => {
      throw reasonError('plugin-uninstall-failed')
    })
    ;(window as unknown as { aios: { plugins: Record<string, unknown> } }).aios.plugins.uninstall = api.uninstall
    await renderDetail('acme.mail')
    await act(async () => host.querySelector<HTMLButtonElement>('.extension-uninstall-action')?.click())
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en['reason.plugin-uninstall-failed'])
    expect(useExtensionPane.getState().view).toEqual({ kind: 'extension', pluginId: 'acme.mail' })
  })

  it('wave 86 fix Y: when recording consent is refused (identity cannot be verified), shows the reason; does not look as if nothing silently happened', async () => {
    const { reasonError } = await import('../src/shared/reason.js')
    api.setConsent.mockImplementation(async () => {
      throw reasonError('plugin-consent-unbound')
    })
    ;(window as unknown as { aios: { plugins: Record<string, unknown> } }).aios.plugins.setConsent = api.setConsent
    await renderDetail('acme.mail')
    await act(async () => tabs()[2]?.click())
    await act(async () => host.querySelector<HTMLButtonElement>('.extension-consent-toggle')?.click())
    await flush()
    expect(host.querySelector('.extension-permissions [role="alert"]')?.textContent).toBe(en['reason.plugin-consent-unbound'])
  })

  it('TODO 459: in the right column of the overview, shows the extension\'s own license and bundled libraries ("使う拡張" of THIRD_PARTY_NOTICES.md)', async () => {
    const g = globalThis as { __AIOS_THIRD_PARTY_NOTICES_MD__?: string }
    g.__AIOS_THIRD_PARTY_NOTICES_MD__ = readFileSync(join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8')
    try {
      await renderDetail('aios.markdown')
      const aside = host.querySelector('.extension-overview-aside')
      expect(aside?.querySelector('h3')?.textContent).toBe(en['extensions.license.title'])
      expect(aside?.textContent).toContain(en['extensions.license.sameAsApp'])
      const items = [...(aside?.querySelectorAll('.extension-license summary') ?? [])].map((el) => el.textContent ?? '')
      expect(items.some((text) => text.startsWith('CodeMirror 6 (@codemirror/*)'))).toBe(true)
      expect(items.some((text) => text.startsWith('markdown-it · MIT'))).toBe(true)
      // Draw the Markdown symbols in the heading, but do not show raw backticks.
      expect(items.join('')).not.toContain('`')
      expect(aside?.querySelector('.extension-license summary code')?.textContent).toBe('@codemirror/*')
      // The full text is in a collapsed <pre>.
      const texts = [...(aside?.querySelectorAll('.extension-license-text') ?? [])].map((el) => el.textContent ?? '')
      expect(texts.some((text) => text.includes('Marijn Haverbeke'))).toBe(true)

      // An installed extension with no bundled libraries.
      act(() => reactRoot.unmount())
      reactRoot = createRoot(host)
      await renderDetail('acme.mail')
      const none = host.querySelector('.extension-overview-aside')
      expect(none?.querySelector('.extension-licenses-none')?.textContent).toBe(en['extensions.license.none'])
      expect(none?.textContent).toContain(en['extensions.license.notDeclared'])
    } finally {
      delete g.__AIOS_THIRD_PARTY_NOTICES_MD__
    }
  })

  it('an unknown id is "not found"', async () => {
    await renderDetail('no.such')
    expect(host.textContent).toContain(en['extensions.notFound'])
  })

  it('the audit log (whole) is queried newest first with a plugin column', async () => {
    const { ExtensionPanel } = await import('../src/renderer/src/components/ExtensionDetailPane.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useExtensionPane.getState().openAuditLog()
    act(() => reactRoot.render(createElement(ExtensionPanel)))
    await flush()
    expect(api.audit).toHaveBeenCalledWith(200, undefined)
    expect(host.querySelector('.thread-pane.settings-editor.audit-pane')).not.toBeNull()
    expect(host.querySelector('.extension-editor-title')?.textContent).toBe(en['extensions.auditAll'])
    expect(host.querySelectorAll('.audit-log .audit-plugin')).toHaveLength(2)
  })

  it('closes with ✕ (the same close button as the settings editor)', async () => {
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    await renderDetail('aios.text')
    const close = host.querySelector<HTMLButtonElement>('.settings-editor-close')
    expect(close?.getAttribute('aria-label')).toBe(en['common.close'])
    await act(async () => close?.click())
    expect(useExtensionPane.getState().view).toBeNull()
    expect(host.querySelector('.extension-detail')).toBeNull()
  })
})

describe('priority of the ThreadPane place (TODO 458, mainPanel.ts)', () => {
  async function stores() {
    const { useExtensionPane, useMainPanel } = await import('../src/renderer/src/mainPanel.js')
    const { useSettingsEditor } = await import('../src/renderer/src/settingsEditorStore.js')
    const { useSchedule } = await import('../src/renderer/src/scheduleStore.js')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useSettingsEditor.setState({ open: false })
    useSchedule.setState({ editing: null })
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    return { useExtensionPane, useMainPanel, useSettingsEditor, useSchedule, useThreads }
  }

  it('opening an extension closes the settings and scheduled-run editing (the later one wins)', async () => {
    const { useExtensionPane, useSettingsEditor, useSchedule } = await stores()
    useSettingsEditor.getState().openEditor()
    useExtensionPane.getState().openExtension('aios.text')
    expect(useSettingsEditor.getState().open).toBe(false)
    useSchedule.getState().openEditor('job-1')
    expect(useExtensionPane.getState().view).toBeNull()
    useExtensionPane.getState().openAuditLog()
    expect(useSchedule.getState().editing).toBeNull()
    expect(useExtensionPane.getState().view).toEqual({ kind: 'audit' })
  })

  it('opening settings closes the extension screen', async () => {
    const { useExtensionPane, useSettingsEditor } = await stores()
    useExtensionPane.getState().openExtension('aios.text')
    useSettingsEditor.getState().openEditor()
    expect(useExtensionPane.getState().view).toBeNull()
  })

  it('selecting a thread closes it (even pressing the current thread again); does not close on an update where selectionSeq does not advance', async () => {
    const { useExtensionPane, useThreads } = await stores()
    useExtensionPane.getState().openExtension('aios.text')
    useThreads.setState({ highlightEventId: 'e1' })
    expect(useExtensionPane.getState().view).not.toBeNull()
    useThreads.setState((state) => ({ selectionSeq: state.selectionSeq + 1 }))
    expect(useExtensionPane.getState().view).toBeNull()
  })

  it('useMainPanel returns the one that is open', async () => {
    const { useExtensionPane, useMainPanel, useSettingsEditor } = await stores()
    let seen: string | null = 'unset'
    function Probe(): null {
      seen = useMainPanel()
      return null
    }
    act(() => reactRoot.render(createElement(Probe)))
    expect(seen).toBeNull()
    act(() => useSettingsEditor.getState().openEditor())
    expect(seen).toBe('settings')
    act(() => useExtensionPane.getState().openExtension('aios.text'))
    expect(seen).toBe('extension')
    act(() => useExtensionPane.getState().close())
    expect(seen).toBeNull()
  })
})

describe('removed the Plugins section from settings (TODO 367)', () => {
  it('there is no plugins in either the categories or the items', () => {
    expect(SETTINGS_CATEGORIES as readonly string[]).not.toContain('plugins')
    expect(SETTINGS_ITEMS.map((item) => item.id as string)).not.toContain('plugins')
    expect(Object.keys(en).filter((key) => key.startsWith('settings.category.plugins') || key.startsWith('settings.item.plugins'))).toEqual([])
  })
})

describe('TODO 523 / 721: activityBarPlugins (plugin rows shown in the Activity Bar)', () => {
  it('shows only enabled ones that have activityBar, in order of display name; openWith is passed through as is', async () => {
    const { activityBarPlugins } = await import('../src/renderer/src/extensions.js')
    const gmail = summary({
      id: 'aios.gmail',
      displayName: 'Gmail',
      enabled: true,
      activityBar: { title: 'Gmail', openUrl: 'https://mail.google.com/', openWith: 'external' },
      hasViewer: false,
      capabilities: [],
      consented: []
    })
    const disabledGmail = { ...gmail, enabled: false }
    const noActivityBar = { ...text }
    expect(activityBarPlugins([gmail, noActivityBar])).toEqual([
      { id: 'aios.gmail', iconUrl: null, title: 'Gmail', openUrl: 'https://mail.google.com/', openWith: 'external', sidebarView: false }
    ])
    // Not shown when disabled (the disabling from item 460 works as is).
    expect(activityBarPlugins([disabledGmail, noActivityBar])).toEqual([])
  })

  it('TODO 721: a plugin without openWith (undefined) defaults to web', async () => {
    const { activityBarPlugins } = await import('../src/renderer/src/extensions.js')
    const noOpenWith = summary({
      id: 'aios.other',
      displayName: 'Other',
      enabled: true,
      activityBar: { title: 'Other', openUrl: 'https://example.com/' },
      hasViewer: false,
      capabilities: [],
      consented: []
    })
    expect(activityBarPlugins([noOpenWith])).toEqual([
      { id: 'aios.other', iconUrl: null, title: 'Other', openUrl: 'https://example.com/', openWith: 'web', sidebarView: false }
    ])
  })
})

describe('TODO 1144 stage 1: version and update state per extension', () => {
  it('a list row shows latest / update available (new version) / cannot check next to the version', async () => {
    plugins = [
      { ...markdown, update: { state: 'available', latest: '1.2.0', installable: false } },
      text,
      { ...extra, update: { state: 'unknown', reason: 'not-bundled', updateUnsupported: null, failure: null } }
    ]
    const { ExtensionsMode } = await import('../src/renderer/src/components/ExtensionsMode.js')
    act(() => reactRoot.render(createElement(ExtensionsMode)))
    await flush()
    const badge = (id: string): Element | null => host.querySelector(`[data-plugin-id="${id}"] .extension-update`)
    expect(badge('aios.markdown')?.textContent).toBe(en['extensions.update.available'].replace('{version}', '1.2.0'))
    expect(badge('aios.markdown')?.getAttribute('data-update-state')).toBe('available')
    expect(badge('aios.text')?.textContent).toBe(en['extensions.update.upToDate'])
    expect(badge('acme.mail')?.textContent).toBe(en['extensions.update.unknown'])
    // The version is shown as is (manifest.version).
    expect(host.querySelector('[data-plugin-id="aios.markdown"] .extension-row-version')?.textContent).toBe('1.0.0')
  })

  it('the "update" in the details overview shows the badge and the reason it cannot be checked (and the sentence for the reason when the app\'s own auto-update does not work)', async () => {
    plugins = [{ ...markdown, update: { state: 'unknown', reason: 'unsupported', updateUnsupported: 'dev', failure: null } }]
    const { ExtensionPanel } = await import('../src/renderer/src/components/ExtensionDetailPane.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useExtensionPane.getState().openExtension('aios.markdown')
    act(() => reactRoot.render(createElement(ExtensionPanel)))
    await flush()
    const field = host.querySelector('.extension-fields .extension-update')
    expect(field?.textContent).toBe(en['extensions.update.unknown'])
    const detail = host.querySelector('.extension-fields .extension-update-detail')?.textContent ?? ''
    expect(detail).toContain(en['extensions.update.reason.unsupported'])
    expect(detail).toContain(en['update.unsupported.dev'])
  })

  it('updateDetail: a failure to fetch is the sentence for the reason code, and latest / update available is the version in the version table', async () => {
    const { updateDetail } = await import('../src/renderer/src/extensions.js')
    const { translate } = await import('../src/renderer/src/i18n/index.js')
    const tr = (key: string, params?: Record<string, string | number>): string => translate('en', key, params)
    expect(updateDetail(tr, { state: 'unknown', reason: 'check-failed', updateUnsupported: null, failure: 'update-gh-auth' })).toBe(
      `${en['extensions.update.reason.check-failed']} ${en['reason.update-gh-auth']}`
    )
    expect(updateDetail(tr, { state: 'up-to-date', latest: '1.0.0' })).toBe(
      en['extensions.update.latestVersion'].replace('{version}', '1.0.0')
    )
    expect(updateDetail(tr, { state: 'unknown', reason: 'not-checked', updateUnsupported: null, failure: null })).toBe(
      en['extensions.update.reason.not-checked']
    )
  })
})

describe('TODO 1144 stage 2: "update" per extension', () => {
  async function openDetail(): Promise<void> {
    const { ExtensionPanel } = await import('../src/renderer/src/components/ExtensionDetailPane.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useExtensionPane.getState().openExtension('aios.markdown')
    act(() => reactRoot.render(createElement(ExtensionPanel)))
    await flush()
  }
  const button = (): HTMLButtonElement | null => host.querySelector('.extension-update-action')

  it('shows "update" only when an update is available and an asset exists, and pressing it asks main with that extension\'s id', async () => {
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: true } }]
    await openDetail()
    expect(button()?.textContent).toBe(en['extensions.update.button'])
    act(() => button()?.click())
    await flush()
    expect(api.update).toHaveBeenCalledWith('aios.markdown')
  })

  it('shows no button for "update available" without an asset, latest, or while updating (a row without an asset adds that it comes in with the app update)', async () => {
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: false } }]
    await openDetail()
    expect(button()).toBeNull()
    expect(host.querySelector('.extension-fields .extension-update-detail')?.textContent).toContain(en['extensions.update.notInstallable'])
    act(() => reactRoot.unmount())
    reactRoot = createRoot(host)
    plugins = [{ ...markdown, update: { state: 'updating', latest: '1.2.0' } }]
    await openDetail()
    expect(button()).toBeNull()
    expect(host.querySelector('.extension-fields .extension-update')?.textContent).toBe(
      en['extensions.update.updating'].replace('{version}', '1.2.0')
    )
  })

  it('a failure is the badge and the reason-code sentence, and the button is "update again"', async () => {
    plugins = [{ ...markdown, update: { state: 'failed', latest: '1.2.0', failure: 'update-checksum-mismatch' } }]
    await openDetail()
    expect(host.querySelector('.extension-fields .extension-update')?.textContent).toBe(
      en['extensions.update.failed'].replace('{version}', '1.2.0')
    )
    expect(host.querySelector('.extension-fields .extension-update-detail')?.textContent).toBe(
      `${en['extensions.update.failedDetail']} ${en['reason.update-checksum-mismatch']}`
    )
    expect(button()?.textContent).toBe(en['extensions.update.retry'])
  })

  it('wave 73 review: shows the reason main refused without starting (reject); a reason code gives its sentence, an exception without a code gives a fixed sentence', async () => {
    const { reasonError } = await import('../src/shared/reason.js')
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: true } }]
    await openDetail()
    const rejected = (): string | null | undefined => host.querySelector('.extension-update-rejected')?.textContent
    // A reject from ipcMain.handle arrives in the form `Error invoking remote method …: Error: <message>`.
    api.update.mockRejectedValueOnce(new Error(`Error invoking remote method 'aios:plugin/update': Error: ${reasonError('update-unsupported').message}`))
    act(() => button()?.click())
    await flush()
    expect(rejected()).toBe(`${en['extensions.update.failedDetail']} ${en['reason.update-unsupported']}`)
    api.update.mockRejectedValueOnce(new Error(`Error invoking remote method 'aios:plugin/update': Error: ${reasonError('plugin-update-unavailable').message}`))
    act(() => button()?.click())
    await flush()
    expect(rejected()).toBe(`${en['extensions.update.failedDetail']} ${en['reason.plugin-update-unavailable']}`)
    api.update.mockRejectedValueOnce(new Error(`Error invoking remote method 'aios:plugin/update': Error: unknown plugin`))
    act(() => button()?.click())
    await flush()
    expect(rejected()).toBe(`${en['extensions.update.failedDetail']} ${en['extensions.update.rejectedUnknown']}`)
    // If it is pressed again and starts, the message goes away.
    act(() => button()?.click())
    await flush()
    expect(rejected()).toBeUndefined()
  })
})

describe('TODO 1144 stage 3: bulk "update all"', () => {
  async function renderList(): Promise<void> {
    const { ExtensionsMode } = await import('../src/renderer/src/components/ExtensionsMode.js')
    act(() => reactRoot.render(createElement(ExtensionsMode)))
    await flush()
  }
  const bar = (): HTMLElement | null => host.querySelector('.extensions-update-all')
  const button = (): HTMLButtonElement | null => host.querySelector('.extensions-update-all-action')

  it('not shown when nothing can be updated (update available with an asset, or failed)', async () => {
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: false } }, text]
    await renderList()
    expect(bar()).toBeNull()
  })

  it('shows the count and "update all", asks main when pressed, and shows each extension\'s result (updated version / failure reason)', async () => {
    plugins = [
      { ...markdown, update: { state: 'available', latest: '1.2.0', installable: true } },
      { ...text, update: { state: 'failed', latest: '1.1.0', failure: 'update-download-failed' } },
      { ...extra, update: { state: 'unknown', reason: 'not-bundled', updateUnsupported: null, failure: null } }
    ]
    let finish: (value: unknown) => void = () => undefined
    api.updateAll.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await renderList()
    expect(host.querySelector('.extensions-update-all-count')?.textContent).toBe(en['extensions.updateAll.count'].replace('{count}', '2'))
    expect(button()?.textContent).toBe(en['extensions.updateAll.button'])
    act(() => button()?.click())
    await flush()
    expect(api.updateAll).toHaveBeenCalledTimes(1)
    // It cannot be pressed while it is running.
    expect(button()?.disabled).toBe(true)
    expect(button()?.textContent).toBe(en['extensions.updateAll.running'])
    await act(async () => {
      finish([
        { id: 'aios.markdown', from: '1.0.0', to: '1.2.0', outcome: 'updated' },
        { id: 'aios.text', from: '1.0.0', to: '1.1.0', outcome: 'failed', failure: 'update-checksum-mismatch' }
      ])
      await Promise.resolve()
    })
    await flush()
    const lines = [...host.querySelectorAll('.extensions-update-all-result')].map((li) => li.textContent)
    expect(lines).toEqual([
      en['extensions.updateAll.updated'].replace('{name}', 'Markdown').replace('{version}', '1.2.0'),
      `${en['extensions.updateAll.failed'].replace('{name}', 'Text')} ${en['reason.update-checksum-mismatch']}`
    ])
    expect(host.querySelector('.extensions-update-all-result.failed')?.getAttribute('data-plugin-id')).toBe('aios.text')
    // If something was updated, add that the view still shows the previous version until it is reopened.
    expect(bar()?.textContent).toContain(en['extensions.updateAll.reopenHint'])
  })

  it('shows the reason main refused without starting (a form that does not work)', async () => {
    const { reasonError } = await import('../src/shared/reason.js')
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: true } }]
    api.updateAll.mockRejectedValueOnce(
      new Error(`Error invoking remote method 'aios:plugin/updateAll': Error: ${reasonError('update-unsupported').message}`)
    )
    await renderList()
    act(() => button()?.click())
    await flush()
    expect(host.querySelector('.extensions-update-all .extension-update-rejected')?.textContent).toBe(
      `${en['extensions.update.failedDetail']} ${en['reason.update-unsupported']}`
    )
  })
})
