// @vitest-environment jsdom
/**
 * TODO 1099: "Install a CLI plugin" in Settings → Skills (PluginCatalog). When there is no catalog, it shows the reason and the command to type in the terminal;
 * when there is one, a search field and "Install". Pressing it passes the name to main, reports the result in a band, and re-reads the list.
 * Neither the model, the CLI, nor Electron is used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PluginCatalogResult } from '../src/shared/skills.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: PluginCatalogResult = {
  entries: [],
  matched: 0,
  total: 0,
  fetchedAt: null,
  unavailable: null,
  refreshCommand: 'agent plugin marketplace update',
  installed: [],
  opsDisabled: null
}

describe('PluginCatalog', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.resetModules()
  })

  async function mount(api: Record<string, unknown>, onChanged = vi.fn()): Promise<HTMLElement> {
    Object.defineProperty(window, 'aios', { configurable: true, value: { skills: api } })
    const { PluginCatalog } = await import('../src/renderer/src/components/PluginCatalog.js')
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(PluginCatalog, { onChanged }))
    })
    // The first query comes after the timer (0 ms).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    return host
  }

  it('目録が無ければ検索欄を出さず、理由と端末で打つコマンドを出す', async () => {
    const host = await mount({ pluginCatalog: vi.fn().mockResolvedValue({ ...base, unavailable: 'stale' }) })
    expect(host.querySelector('input[type="search"]')).toBeNull()
    expect(host.textContent).toContain('agent plugin marketplace update')
  })

  it('「入れる」で名前を渡し、帯で知らせて一覧を読み直す。入っているものと command 型には出さない', async () => {
    const catalog = vi.fn().mockResolvedValue({
      ...base,
      total: 3,
      matched: 3,
      entries: [
        { name: 'frontend-design', installName: 'frontend-design', title: 'frontend-design', summary: 'UI', version: '1.1.1', publisher: null, review: 'first-party', installed: false, blocked: null },
        { name: 'superpowers', installName: 'superpowers', title: 'Superpowers', summary: 'TDD', version: null, publisher: null, review: 'partner', installed: true, blocked: null },
        { name: 'runs', installName: null, title: 'Runs', summary: '', version: null, publisher: null, review: null, installed: false, blocked: 'command-source' }
      ]
    })
    const install = vi.fn().mockResolvedValue({ ok: true, already: false })
    const onChanged = vi.fn()
    const host = await mount({ pluginCatalog: catalog, pluginInstall: install }, onChanged)
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    await act(async () => {
      buttons[0]!.click()
    })
    expect(install).toHaveBeenCalledWith('frontend-design')
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('frontend-design')
  })

  it('札は CLI に渡る名前。押すと目録の名前を返す。公式 Marketplace に無いものはボタンを出さず理由 (TODO 1177)', async () => {
    const { en } = await import('./helpers/i18n.js')
    const catalog = vi.fn().mockResolvedValue({
      ...base,
      total: 2,
      matched: 2,
      entries: [
        { name: 'code-review-official', installName: 'code-review', title: 'code-review', summary: 'Review', version: '1.0.1', publisher: null, review: 'first-party', installed: false, blocked: null },
        { name: 'code-review-other', installName: null, title: 'code-review', summary: 'Other', version: null, publisher: null, review: null, installed: false, blocked: 'not-in-marketplace' }
      ]
    })
    const install = vi.fn().mockResolvedValue({ ok: true, already: false })
    const host = await mount({ pluginCatalog: catalog, pluginInstall: install })
    const rows = [...host.querySelectorAll('.skill-settings-list li')]
    expect(rows).toHaveLength(2)
    // If the display name and the name passed to the CLI are the same, no badge is shown (the catalog's suffixed name is not shown).
    expect(rows[0]!.textContent).not.toContain('code-review-official')
    expect(rows[1]!.textContent).toContain('code-review-other')
    expect(rows[1]!.querySelector('button')).toBeNull()
    expect(rows[1]!.textContent).toContain(en['settings.skills.plugins.blocked.not-in-marketplace'])
    await act(async () => {
      rows[0]!.querySelector('button')!.click()
    })
    expect(install).toHaveBeenCalledWith('code-review-official')
  })

  it('動かない形では「入れる」「消す」を出さず理由を出す', async () => {
    const host = await mount({
      pluginCatalog: vi.fn().mockResolvedValue({
        ...base,
        total: 1,
        matched: 1,
        opsDisabled: 'dev',
        entries: [
          { name: 'a', installName: 'a', title: 'a', summary: '', version: null, publisher: null, review: null, installed: false, blocked: null }
        ],
        installed: [{ id: 'x@m', name: 'x', marketplace: 'm', scope: 'user', version: null, removable: true }]
      })
    })
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(host.textContent).toContain('npm run dev')
  })
})
