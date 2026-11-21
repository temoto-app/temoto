// @vitest-environment jsdom
/**
 * TODO 970 (wave 51 bundle B): the address bar in the header of a file viewer.
 *
 * - `viewerAddressTarget`: without a scheme, a dotted host name is https, anything else is a path. Schemes other than http(s) are not opened.
 * - `ViewerAddressBar` (jsdom): normally shows the path. Typing and pressing Enter opens a URL by adding a Web tab (`web.newTab`), and a path is passed
 *   to `fs.resolveLink` (the main choke point). Esc discards the partly typed text. Non-http(s) is not opened and the reason is shown. Right-click goes to the caller.
 *
 * Neither the model nor Electron is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { viewerAddressTarget } from '../src/shared/viewer-address.js'
import { ViewerAddressBar } from '../src/renderer/src/components/ViewerAddressBar.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('viewerAddressTarget (TODO 970)', () => {
  it('http(s) の URL はそのまま Web', () => {
    expect(viewerAddressTarget('https://example.com/a?b=1')).toEqual({ kind: 'web', url: 'https://example.com/a?b=1' })
    expect(viewerAddressTarget('  http://localhost:3000/  ')).toEqual({ kind: 'web', url: 'http://localhost:3000/' })
  })

  it('スキーム無しのドット付きの名前は hostOrPath (先にパス、無ければ https)。localhost / IPv4 は直接 Web', () => {
    expect(viewerAddressTarget('example.com')).toEqual({ kind: 'hostOrPath', href: 'example.com', url: 'https://example.com' })
    expect(viewerAddressTarget('docs.example.co.jp/guide#top')).toEqual({
      kind: 'hostOrPath',
      href: 'docs.example.co.jp/guide#top',
      url: 'https://docs.example.co.jp/guide#top'
    })
    expect(viewerAddressTarget('localhost:5173')).toEqual({ kind: 'web', url: 'http://localhost:5173' })
    expect(viewerAddressTarget('127.0.0.1:8080/x')).toEqual({ kind: 'web', url: 'http://127.0.0.1:8080/x' })
    expect(viewerAddressTarget('192.168.1.10')).toEqual({ kind: 'web', url: 'https://192.168.1.10' })
  })

  it('ファイル名に見える語 (拡張子の表に無いものも・行つき・アンカーつきも) は hostOrPath で、パスの解決が先', () => {
    for (const name of ['README.md', 'App.vue', 'notes.org', 'paper.tex', 'main.dart', 'x.ipynb', 'config.bak', 'main.ts:42', 'README.md#L10']) {
      expect(viewerAddressTarget(name)).toEqual({ kind: 'hostOrPath', href: name, url: `https://${name}` })
    }
    expect(viewerAddressTarget('main.ts:42:5')).toEqual({ kind: 'path', href: 'main.ts:42:5' })
  })

  it('ホスト名の形でないものはパス', () => {
    expect(viewerAddressTarget('src/main.ts')).toEqual({ kind: 'path', href: 'src/main.ts' })
    expect(viewerAddressTarget('notes')).toEqual({ kind: 'path', href: 'notes' })
    expect(viewerAddressTarget('ゲーム デザイン.md')).toEqual({ kind: 'path', href: 'ゲーム デザイン.md' })
    expect(viewerAddressTarget('example.com docs')).toEqual({ kind: 'path', href: 'example.com docs' })
  })

  it('~ / 絶対パス / file: はパス', () => {
    expect(viewerAddressTarget('~/git/aios/TODO.md')).toEqual({ kind: 'path', href: '~/git/aios/TODO.md' })
    expect(viewerAddressTarget('/etc/hosts')).toEqual({ kind: 'path', href: '/etc/hosts' })
    expect(viewerAddressTarget('file:///tmp/a.md')).toEqual({ kind: 'path', href: 'file:///tmp/a.md' })
  })

  it('http(s) 以外のスキームは開かない', () => {
    expect(viewerAddressTarget('javascript:alert(1)')).toEqual({ kind: 'unsupported' })
    expect(viewerAddressTarget('data:text/html,<b>x</b>')).toEqual({ kind: 'unsupported' })
    expect(viewerAddressTarget('mailto:a@example.com')).toEqual({ kind: 'unsupported' })
    expect(viewerAddressTarget('ftp://example.com')).toEqual({ kind: 'unsupported' })
  })

  it('空は何もしない', () => {
    expect(viewerAddressTarget('   ')).toEqual({ kind: 'none' })
  })
})

describe('ViewerAddressBar (TODO 970、jsdom)', () => {
  const FILE = 'file:///Users/me/git/aios/docs/a.md'
  let container: HTMLDivElement
  let root: Root
  let newTab: ReturnType<typeof vi.fn>
  let resolveLink: ReturnType<typeof vi.fn>
  let contextMenus: number

  beforeEach(async () => {
    newTab = vi.fn(async () => ({ tabs: [], activeId: null }))
    resolveLink = vi.fn(async () => ({ ok: true, uri: 'file:///Users/me/git/aios/docs/b.md' }))
    contextMenus = 0
    ;(window as unknown as { aios: unknown }).aios = {
      web: { newTab, resolveLink: async (url: string) => url },
      fs: { resolveLink },
      app: { openExternal: async () => undefined }
    }
    useLocale.setState({ resolved: 'en' } as never)
    useStore.setState({ selectedUri: FILE })
    useThreads.setState({ error: null })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(ViewerAddressBar, {
          uri: FILE,
          homeUri: 'file:///Users/me',
          onContextMenu: () => {
            contextMenus += 1
          }
        })
      )
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const field = (): HTMLInputElement => {
    const input = container.querySelector<HTMLInputElement>('input.viewer-address')
    if (input === null) throw new Error('no address bar')
    return input
  }

  async function type(text: string): Promise<void> {
    const input = field()
    await act(async () => {
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function press(key: string): Promise<void> {
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('普段は表示中のパス (~/…) を出し、入力欄として打てる', () => {
    expect(field().value).toBe('~/git/aios/docs/a.md')
    expect(field().readOnly).toBe(false)
    expect(field().getAttribute('aria-label')).toBe(en['viewer.address.label'])
  })

  it('URL を打って Enter → Web のタブを足して開く (ファイルの viewer は履歴に残る)', async () => {
    await type('https://example.com/page')
    await press('Enter')
    expect(newTab).toHaveBeenCalledWith('https://example.com/page')
    expect(useStore.getState().selectedUri).toBe('https://example.com/page')
    expect(resolveLink).not.toHaveBeenCalled()
  })

  it('パスを打って Enter → main の fs.resolveLink に、表示中のファイルを基準に渡す', async () => {
    await type('b.md')
    await press('Enter')
    expect(resolveLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'b.md', baseUri: FILE }))
    expect(newTab).not.toHaveBeenCalled()
  })

  it('http(s) 以外のスキームは開かずに、欄に印を付けて理由を出す', async () => {
    await type('javascript:alert(1)')
    await press('Enter')
    expect(newTab).not.toHaveBeenCalled()
    expect(resolveLink).not.toHaveBeenCalled()
    expect(field().classList.contains('invalid')).toBe(true)
    expect(useThreads.getState().error).toBe(en['viewer.address.unsupported'])
  })

  it('ホスト名の形は先にパスとして解き、見つからなければ https の Web タブ', async () => {
    resolveLink.mockResolvedValueOnce({ ok: false, reason: 'link-not-found' })
    await type('example.com')
    await press('Enter')
    expect(resolveLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'example.com', baseUri: FILE }))
    expect(newTab).toHaveBeenCalledWith('https://example.com')
  })

  it('ホスト名の形でも実在するファイルならファイルを開く (App.vue / 行つき)', async () => {
    resolveLink.mockResolvedValueOnce({ ok: true, uri: 'file:///Users/me/git/aios/docs/App.vue', line: 42 })
    await type('App.vue:42')
    await press('Enter')
    expect(newTab).not.toHaveBeenCalled()
    expect(useStore.getState().selectedUri).toBe('file:///Users/me/git/aios/docs/App.vue')
  })

  it('欄の外をクリック (blur) すると打ちかけを捨てて元の表示へ戻す', async () => {
    await type('something else')
    await act(async () => {
      field().blur()
    })
    expect(field().value).toBe('~/git/aios/docs/a.md')
  })

  it('Esc で打ちかけを捨てて元の表示へ戻す', async () => {
    await type('something else')
    expect(field().value).toBe('something else')
    await press('Escape')
    expect(field().value).toBe('~/git/aios/docs/a.md')
    expect(newTab).not.toHaveBeenCalled()
    expect(resolveLink).not.toHaveBeenCalled()
  })

  it('右クリックは呼び出し側のパスのメニュー (TODO 299) に渡す', async () => {
    await act(async () => {
      field().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    expect(contextMenus).toBe(1)
  })
})
