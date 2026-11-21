// @vitest-environment jsdom
/**
 * TODO 299 (wave 17 bundle C): gathers into the right-click menu (search result rows, file tree rows, viewer headings) the items
 * "open in editor / copy path / show in Finder / new chat here".
 *
 * - `pathContextMenuItems` in `path-context-menu.ts`: the order and wording of items, and that each item calls its function with the correct URI / cwd.
 *   For a folder the cwd is that folder; for a file it is the parent folder (same as 263). At the file system root, "new chat here" is not shown.
 * - `ContextMenu.tsx` (jsdom): right-click opens it; Esc and an outside click close it; ↑↓ Enter selects; a click also selects and closes.
 *   The native `Menu.popup` is not used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { openButtonLabelKey, pathContextMenuItems } from '../src/renderer/src/path-context-menu.js'
import {
  ContextMenu,
  placeContextMenu,
  useContextMenuState
} from '../src/renderer/src/components/ContextMenu.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
  translate('en', key, params)

describe('辞書: contextMenu.* (TODO 299)', () => {
  it('EN / JA の両方に鍵がある', () => {
    expect(en['contextMenu.newChatHere']).toBeTruthy()
    expect(ja['contextMenu.newChatHere']).toBeTruthy()
  })
})

describe('pathContextMenuItems: 項目と cwd (TODO 299)', () => {
  it('ファイルは 4 項目、「ここで新しいチャット」の cwd は親フォルダ', () => {
    const openInEditor = vi.fn(async () => true)
    const reveal = vi.fn(async () => true)
    const createThreadInFolder = vi.fn(async () => true)
    const copy = vi.fn(async () => true)
    const items = pathContextMenuItems(
      'file:///Users/alice/git/aios/a.ts',
      false,
      t,
      'darwin',
      { openInEditor, openInDefaultApp: vi.fn(async () => true), reveal, createThreadInFolder, copy }
    )
    expect(items.map((item) => item.key)).toEqual(['open-editor', 'copy-path', 'reveal', 'new-chat'])
    expect(items[2]!.label).toBe(t('path.revealMac'))

    items[0]!.onSelect()
    expect(openInEditor).toHaveBeenCalledWith('file:///Users/alice/git/aios/a.ts')

    items[1]!.onSelect()
    expect(copy).toHaveBeenCalledWith('/Users/alice/git/aios/a.ts')

    items[2]!.onSelect()
    expect(reveal).toHaveBeenCalledWith('file:///Users/alice/git/aios/a.ts', false)

    items[3]!.onSelect()
    expect(createThreadInFolder).toHaveBeenCalledWith('file:///Users/alice/git/aios')
  })

  it('フォルダは「ここで新しいチャット」の cwd がそのフォルダ自身', () => {
    const createThreadInFolder = vi.fn(async () => true)
    const items = pathContextMenuItems('file:///Users/alice/git/aios', true, t, 'darwin', {
      openInEditor: vi.fn(async () => true),
      openInDefaultApp: vi.fn(async () => true),
      reveal: vi.fn(async () => true),
      createThreadInFolder,
      copy: vi.fn(async () => true)
    })
    const newChat = items.find((item) => item.key === 'new-chat')
    expect(newChat).toBeDefined()
    newChat!.onSelect()
    expect(createThreadInFolder).toHaveBeenCalledWith('file:///Users/alice/git/aios')
  })

  it('ファイルシステムのルートでは「ここで新しいチャット」を出さない', () => {
    const items = pathContextMenuItems('file:///', true, t, 'darwin', {
      openInEditor: vi.fn(async () => true),
      openInDefaultApp: vi.fn(async () => true),
      reveal: vi.fn(async () => true),
      createThreadInFolder: vi.fn(async () => true)
    })
    expect(items.map((item) => item.key)).toEqual(['open-editor', 'copy-path', 'reveal'])
  })

  it('OS ごとに Finder / Explorer / フォルダを開く、に文言が変わる', () => {
    const base = {
      openInEditor: vi.fn(async () => true),
      openInDefaultApp: vi.fn(async () => true),
      reveal: vi.fn(async () => true),
      createThreadInFolder: vi.fn(async () => true)
    }
    const win = pathContextMenuItems('file:///c/a.ts', false, t, 'win32', base)
    expect(win.find((item) => item.key === 'reveal')!.label).toBe(t('path.revealWin'))
    const linux = pathContextMenuItems('file:///a.ts', false, t, 'linux', base)
    expect(linux.find((item) => item.key === 'reveal')!.label).toBe(t('path.revealOther'))
  })
})

describe('TODO 1214: 「既定のアプリで開く」と「エディタで開く」の 2 行', () => {
  const deps = () => ({
    openInEditor: vi.fn(async () => true),
    openInDefaultApp: vi.fn(async () => true),
    reveal: vi.fn(async () => true),
    createThreadInFolder: vi.fn(async () => true),
    copy: vi.fn(async () => true)
  })

  it('表の拡張子 (.xlsx / .pdf / .PNG) のファイルは先頭に「既定のアプリで開く」、次に「エディタで開く」', () => {
    for (const name of ['book.xlsx', 'paper.pdf', 'Shot.PNG', 'a.b.docx']) {
      const d = deps()
      const items = pathContextMenuItems(`file:///Users/alice/${name}`, false, t, 'darwin', d)
      expect(items.map((item) => item.key).slice(0, 2)).toEqual(['open-default-app', 'open-editor'])
      expect(items[0]!.label).toBe(t('path.openInDefaultApp'))
      expect(items[1]!.label).toBe(t('search.openInEditor'))
      items[0]!.onSelect()
      expect(d.openInDefaultApp).toHaveBeenCalledWith(`file:///Users/alice/${name}`)
      expect(d.openInEditor).not.toHaveBeenCalled()
      items[1]!.onSelect()
      expect(d.openInEditor).toHaveBeenCalledWith(`file:///Users/alice/${name}`)
    }
  })

  it('テキスト類・拡張子なし・実行されうる型・フォルダには「既定のアプリで開く」を出さない', () => {
    for (const [uri, dir] of [
      ['file:///a/b.ts', false],
      ['file:///a/README.md', false],
      ['file:///a/Makefile', false],
      ['file:///a/run.command', false],
      ['file:///a/Tool.app', false],
      ['file:///a/x.svg', false],
      ['file:///a/macro.xlsm', false],
      ['file:///a/photos.pdf', true]
    ] as const) {
      const items = pathContextMenuItems(uri, dir, t, 'darwin', deps())
      expect(items.some((item) => item.key === 'open-default-app')).toBe(false)
      expect(items[0]!.key).toBe('open-editor')
    }
  })

  it('openButtonLabelKey: ボタン 1 つの文言は振り分けの先に合わせる', () => {
    expect(openButtonLabelKey('file:///a/b.xlsx', {}, 'viewer.openInEditor')).toBe('path.openInDefaultApp')
    expect(openButtonLabelKey('file:///a/b.ts', {}, 'viewer.openInEditor')).toBe('viewer.openInEditor')
    // With a line number (the first line of the selection) it stays in the editor.
    expect(openButtonLabelKey('file:///a/b.pdf', { line: 3 }, 'viewer.openInEditor')).toBe('viewer.openInEditor')
    expect(openButtonLabelKey('file:///a/b.pdf', { line: null }, 'search.openInEditor')).toBe('path.openInDefaultApp')
    expect(openButtonLabelKey('file:///a/b.pdf', { asDirectory: true }, 'search.openInEditor')).toBe('search.openInEditor')
  })

  it('辞書: EN / JA の両方に鍵がある', () => {
    expect(en['path.openInDefaultApp']).toBeTruthy()
    expect(ja['path.openInDefaultApp']).toBeTruthy()
    expect(translate('ja', 'path.openInDefaultApp')).toBe('既定のアプリで開く')
  })
})

describe('placeContextMenu: 画面端で折り返す (純関数)', () => {
  it('収まるときは押した点そのまま', () => {
    expect(
      placeContextMenu({ x: 50, y: 50 }, { width: 180, height: 120 }, { width: 1000, height: 800 })
    ).toEqual({ left: 50, top: 50 })
  })

  it('右端 / 下端を超えるときは内側へ折り返す', () => {
    expect(
      placeContextMenu({ x: 990, y: 790 }, { width: 180, height: 120 }, { width: 1000, height: 800 })
    ).toEqual({ left: 1000 - 180 - 4, top: 800 - 120 - 4 })
  })
})

describe('ContextMenu (jsdom)', () => {
  let root: Root
  let host: HTMLDivElement

  function Harness({
    items
  }: {
    readonly items: readonly { key: string; label: string; onSelect: () => void }[]
  }): React.JSX.Element {
    const { point, items: openItems, openMenu, closeMenu } = useContextMenuState()
    return createElement(
      'div',
      null,
      createElement('button', {
        'data-testid': 'target',
        onContextMenu: (event: React.MouseEvent) => openMenu(event, items)
      }),
      createElement('button', { 'data-testid': 'outside' }),
      createElement(ContextMenu, { point, items: openItems, onClose: closeMenu })
    )
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function contextMenuEvent(clientX = 10, clientY = 10): Partial<MouseEvent> {
    return { clientX, clientY, bubbles: true, cancelable: true } as Partial<MouseEvent>
  }

  it('右クリックで開き、項目を押すと onSelect を呼んで閉じる', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(createElement(Harness, { items: [{ key: 'a', label: 'エディタで開く', onSelect }] }))
    })
    const target = host.querySelector('[data-testid="target"]')!
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    const menuItem = document.querySelector('.context-menu-item')
    expect(menuItem).not.toBeNull()
    expect(menuItem!.textContent).toBe('エディタで開く')
    await act(async () => {
      ;(menuItem as HTMLButtonElement).click()
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('Esc で閉じる', async () => {
    await act(async () => {
      root.render(createElement(Harness, { items: [{ key: 'a', label: 'x', onSelect: vi.fn() }] }))
    })
    const target = host.querySelector('[data-testid="target"]')!
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    expect(document.querySelector('.context-menu')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('外側をクリックすると閉じ、外側のボタンのクリックは効く (握りつぶさない)', async () => {
    await act(async () => {
      root.render(createElement(Harness, { items: [{ key: 'a', label: 'x', onSelect: vi.fn() }] }))
    })
    const target = host.querySelector('[data-testid="target"]')!
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    expect(document.querySelector('.context-menu')).not.toBeNull()
    const outside = host.querySelector('[data-testid="outside"]') as HTMLButtonElement
    await act(async () => {
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('開いた後は visibility: hidden のまま残らず、最初の項目に focus が入る (333-1)', async () => {
    await act(async () => {
      root.render(
        createElement(Harness, {
          items: [{ key: 'a', label: 'first', onSelect: vi.fn() }]
        })
      )
    })
    const target = host.querySelector('[data-testid="target"]')!
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    const menu = document.querySelector('.context-menu') as HTMLDivElement
    expect(menu).not.toBeNull()
    expect(menu.style.visibility).not.toBe('hidden')
    expect(menu.style.top).not.toBe('')
    expect(menu.style.left).not.toBe('')
    expect(document.activeElement).toBe(menu)
  })

  it('365-1: focus は位置が決まって見えるようになってから入れる (visibility: hidden の間は呼ばない)', async () => {
    const seen: string[] = []
    const original = HTMLElement.prototype.focus
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (this.classList.contains('context-menu')) seen.push(this.style.visibility)
      original.call(this, options)
    })
    try {
      await act(async () => {
        root.render(createElement(Harness, { items: [{ key: 'a', label: 'first', onSelect: vi.fn() }] }))
      })
      const target = host.querySelector('[data-testid="target"]')!
      await act(async () => {
        target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
      })
      expect(seen.length).toBeGreaterThan(0)
      expect(seen).not.toContain('hidden')
      expect(document.activeElement).toBe(document.querySelector('.context-menu'))
    } finally {
      spy.mockRestore()
    }
  })

  it('365-1: 閉じたら開く前に focus があった場所へ戻す (Esc・項目の選択)', async () => {
    await act(async () => {
      root.render(createElement(Harness, { items: [{ key: 'a', label: 'first', onSelect: vi.fn() }] }))
    })
    const target = host.querySelector('[data-testid="target"]') as HTMLButtonElement
    act(() => target.focus())
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    expect(document.activeElement).toBe(document.querySelector('.context-menu'))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.activeElement).toBe(target)

    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    const menu = document.querySelector('.context-menu') as HTMLDivElement
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.querySelector('.context-menu')).toBeNull()
    expect(document.activeElement).toBe(target)
  })

  it('↑↓ で選択が動き、Enter で選んだ項目の onSelect を呼ぶ', async () => {
    const first = vi.fn()
    const second = vi.fn()
    await act(async () => {
      root.render(
        createElement(Harness, {
          items: [
            { key: 'a', label: 'first', onSelect: first },
            { key: 'b', label: 'second', onSelect: second }
          ]
        })
      )
    })
    const target = host.querySelector('[data-testid="target"]')!
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', contextMenuEvent()))
    })
    const menu = document.querySelector('.context-menu') as HTMLDivElement
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
