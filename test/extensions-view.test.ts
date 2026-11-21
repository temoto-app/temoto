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

describe('Activity Bar と ⌘⇧X (TODO 367)', () => {
  it('「拡張」は検索の後ろに並び、押すとサイドバーが一覧になる', async () => {
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

  it('⌘⇧X (メニューの showExtensions) は拡張ビューを開いた状態にし、キーでは畳まない', async () => {
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

describe('一覧 (ExtensionsMode)', () => {
  async function renderList(): Promise<void> {
    const { ExtensionsMode } = await import('../src/renderer/src/components/ExtensionsMode.js')
    act(() => reactRoot.render(createElement(ExtensionsMode)))
    await flush()
  }

  it('見出しは インストール済み → 組み込み。行は名前・版・一行説明・id・状態', async () => {
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
    expect(row?.querySelector('.extension-row-id')?.textContent).toBe('aios.markdown')
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

  it('アイコンは iconUrl を <img> で描き (SVG を inline にしない)、無ければ・読めなければ既定のアイコン (TODO 524)', async () => {
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

  it('組み込みしか無ければ「インストール済み」は空の知らせ', async () => {
    plugins = [text]
    await renderList()
    expect(host.querySelector('.extensions-section .extensions-empty')?.textContent).toBe(en['extensions.installedEmpty'])
  })

  it('行を押すと詳細を ThreadPane の場所に開き (TODO 458)、その行が選ばれる。監査ログ (全体) の口もある', async () => {
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

describe('詳細 (ThreadPane の場所、TODO 458)', () => {
  async function renderDetail(pluginId: string): Promise<void> {
    const { ExtensionPanel } = await import('../src/renderer/src/components/ExtensionDetailPane.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useExtensionPane.getState().openExtension(pluginId)
    act(() => reactRoot.render(createElement(ExtensionPanel)))
    await flush()
  }
  const tabs = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panel = (): HTMLElement | null => host.querySelector('[role="tabpanel"]')

  it('見出しと 4 つのタブ。既定は概要', async () => {
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
    expect(host.querySelector('.extension-editor-id')?.textContent).toBe('aios.markdown')
  })

  it('機能の寄与: 拡張子・編集・優先度・command', async () => {
    await renderDetail('aios.markdown')
    await act(async () => tabs()[1]?.click())
    const content = panel()?.textContent ?? ''
    expect(content).toContain('.md, .markdown')
    expect(content).toContain(en['extensions.contrib.editableYes'])
    expect(content).toContain('outline')
    expect(content).toContain(en['extensions.contrib.priorityValue'].replace('{priority}', '20'))
  })

  it('権限: 宣言した能力と同意。fs の範囲が空なら「開いたファイルだけ」。組み込みは切り替えを出さない', async () => {
    await renderDetail('aios.markdown')
    await act(async () => tabs()[2]?.click())
    const fs = host.querySelector('[data-capability="fs"]')
    expect(fs?.textContent).toContain(en['plugins.capability.fs'])
    expect(fs?.textContent).toContain(en['extensions.perm.fsOpened'])
    expect(fs?.textContent).toContain(en['extensions.perm.granted'])
    expect(host.querySelector('.extension-consent-toggle')).toBeNull()
    expect(panel()?.textContent).toContain(en['extensions.perm.builtinConsent'])
  })

  it('実行状況: プロセスの状態とクラッシュ回数、その拡張だけの監査ログ', async () => {
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

  it('タブは ← → で移れる', async () => {
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

  it('TODO 460: 組み込みでも受け皿でなければ「無効にする」を押せる', async () => {
    await renderDetail('aios.markdown')
    const action = host.querySelector<HTMLButtonElement>('.extension-action')
    expect(action?.hasAttribute('aria-disabled')).toBe(false)
    expect(action?.classList.contains('disabled')).toBe(false)
    await act(async () => action?.click())
    expect(api.setEnabled).toHaveBeenCalledWith('aios.markdown', false)
    expect(host.querySelector('.extension-action-note')).toBeNull()
  })

  it('TODO 460: 無効にした組み込みは「有効にする」と、行き先の一文を出す', async () => {
    plugins = [text, { ...markdown, enabled: false }, extra]
    await renderDetail('aios.markdown')
    const action = host.querySelector<HTMLButtonElement>('.extension-action')
    expect(action?.textContent).toBe(en['plugins.enable'])
    expect(host.querySelector('.extension-action-note')?.textContent).toBe(en['extensions.disabledNote'])
    expect(host.querySelector('.extension-detail-meta .extension-status')?.textContent).toBe(en['extensions.status.disabled'])
    await act(async () => action?.click())
    expect(api.setEnabled).toHaveBeenCalledWith('aios.markdown', true)
  })

  it('最後の受け皿 (aios.text) の「無効にする」は押せない形で、押しても呼ばず、理由は横の一文と吹き出しに出る', async () => {
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

  it('組み込みでない拡張は無効にでき、同意を切り替えられる', async () => {
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

  it('TODO 1233: 組み込みでない拡張には「アンインストール」があり、確認なしで消して詳細を閉じる。組み込みには出さない', async () => {
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

  it('TODO 1233: アンインストールを断られたら理由を出し、詳細は開いたまま', async () => {
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

  it('第 86 波 直し Y: 同意の記録を断られたら (同一性を確かめられない) 理由を出す — 黙って何も起きないように見せない', async () => {
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

  it('TODO 459: 概要の右の欄に、拡張そのもののライセンスと同梱ライブラリ (THIRD_PARTY_NOTICES.md の「使う拡張」) を出す', async () => {
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

  it('知らない id は「見つからない」', async () => {
    await renderDetail('no.such')
    expect(host.textContent).toContain(en['extensions.notFound'])
  })

  it('監査ログ (全体) は plugin の列つきで新しい順に引く', async () => {
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

  it('✕ で閉じる (設定エディタと同じ閉じるボタン)', async () => {
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    await renderDetail('aios.text')
    const close = host.querySelector<HTMLButtonElement>('.settings-editor-close')
    expect(close?.getAttribute('aria-label')).toBe(en['common.close'])
    await act(async () => close?.click())
    expect(useExtensionPane.getState().view).toBeNull()
    expect(host.querySelector('.extension-detail')).toBeNull()
  })
})

describe('ThreadPane の場所の優先 (TODO 458、mainPanel.ts)', () => {
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

  it('拡張を開くと設定と定期実行の編集が閉じる (後から開いたものが勝つ)', async () => {
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

  it('設定を開くと拡張の画面が閉じる', async () => {
    const { useExtensionPane, useSettingsEditor } = await stores()
    useExtensionPane.getState().openExtension('aios.text')
    useSettingsEditor.getState().openEditor()
    expect(useExtensionPane.getState().view).toBeNull()
  })

  it('スレッドを選ぶと閉じる (いまのスレッドをもう一度押しても)。selectionSeq が進まない更新では閉じない', async () => {
    const { useExtensionPane, useThreads } = await stores()
    useExtensionPane.getState().openExtension('aios.text')
    useThreads.setState({ highlightEventId: 'e1' })
    expect(useExtensionPane.getState().view).not.toBeNull()
    useThreads.setState((state) => ({ selectionSeq: state.selectionSeq + 1 }))
    expect(useExtensionPane.getState().view).toBeNull()
  })

  it('useMainPanel は開いている 1 つを返す', async () => {
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

describe('設定から Plugins 節を外した (TODO 367)', () => {
  it('分類にも項目にも plugins が無い', () => {
    expect(SETTINGS_CATEGORIES as readonly string[]).not.toContain('plugins')
    expect(SETTINGS_ITEMS.map((item) => item.id as string)).not.toContain('plugins')
    expect(Object.keys(en).filter((key) => key.startsWith('settings.category.plugins') || key.startsWith('settings.item.plugins'))).toEqual([])
  })
})

describe('TODO 523 / 721: activityBarPlugins (Activity Bar に出す plugin の行)', () => {
  it('有効で activityBar を持つものだけ、表示名の順に出す。openWith はそのまま伝わる', async () => {
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

  it('TODO 721: openWith が無い (undefined) plugin は既定で web', async () => {
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

describe('TODO 1144 段 1: 拡張機能ごとの版と更新状態', () => {
  it('一覧の行は版の横に 最新 / 更新あり (新しい版) / 確認できない を出す', async () => {
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

  it('詳細の概要の「更新」は札と、確認できない理由 (本体の自動更新が動かない形はその理由の文も) を出す', async () => {
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

  it('updateDetail: 取れなかったは理由コードの文、最新 / 更新ありは版表の版', async () => {
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

describe('TODO 1144 段 2: 拡張機能ごとの「更新」', () => {
  async function openDetail(): Promise<void> {
    const { ExtensionPanel } = await import('../src/renderer/src/components/ExtensionDetailPane.js')
    const { useExtensionPane } = await import('../src/renderer/src/mainPanel.js')
    useExtensionPane.getState().openExtension('aios.markdown')
    act(() => reactRoot.render(createElement(ExtensionPanel)))
    await flush()
  }
  const button = (): HTMLButtonElement | null => host.querySelector('.extension-update-action')

  it('更新ありで資産があるときだけ「更新」を出し、押すとその拡張機能の id で main に頼む', async () => {
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: true } }]
    await openDetail()
    expect(button()?.textContent).toBe(en['extensions.update.button'])
    act(() => button()?.click())
    await flush()
    expect(api.update).toHaveBeenCalledWith('aios.markdown')
  })

  it('資産の無い「更新あり」・最新・更新中にはボタンを出さない (資産の無い行は本体の更新で入ると添える)', async () => {
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

  it('失敗は札と理由コードの文、ボタンは「もう一度更新」', async () => {
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

  it('第 73 波 review: main が始めずに断った (reject) 理由を出す。理由コードはその文、コードの無い例外は定まった文', async () => {
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

describe('TODO 1144 段 3: 一括の「すべて更新」', () => {
  async function renderList(): Promise<void> {
    const { ExtensionsMode } = await import('../src/renderer/src/components/ExtensionsMode.js')
    act(() => reactRoot.render(createElement(ExtensionsMode)))
    await flush()
  }
  const bar = (): HTMLElement | null => host.querySelector('.extensions-update-all')
  const button = (): HTMLButtonElement | null => host.querySelector('.extensions-update-all-action')

  it('更新できるもの (資産のある更新あり・失敗) が無ければ出さない', async () => {
    plugins = [{ ...markdown, update: { state: 'available', latest: '1.2.0', installable: false } }, text]
    await renderList()
    expect(bar()).toBeNull()
  })

  it('数と「すべて更新」を出し、押すと main に頼み、拡張機能ごとの結果 (更新した版 / 失敗の理由) を出す', async () => {
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

  it('main が始めずに断った理由を出す (動かない形)', async () => {
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
