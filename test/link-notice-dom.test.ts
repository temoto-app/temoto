// @vitest-environment jsdom
/**
 * wave 44 bundle B (TODO 808 / 816): the band for links that could not be opened (`LinkNotice`).
 *
 * - If `openLinkHref` has material for the next step (candidates, paths tried, the name, a URI to hand outside), it puts it in the band instead of `app-error`.
 * - Pressing a candidate opens it in ViewerPane (with the line). "Open in external editor" and "Reveal in Finder" only call the main entry points.
 * - "Search by name" asks for the name to be put in the file-name search field (`requestFocus('names', name)`). Esc or ✕ removes the band.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LinkResolution } from '../src/shared/link.js'
import { LinkNotice } from '../src/renderer/src/components/LinkNotice.js'
import { LinkPopover } from '../src/renderer/src/components/LinkPopover.js'
import { useLinkNotice, useLinkPopover } from '../src/renderer/src/linkNoticeStore.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { openLinkHref } from '../src/renderer/src/markdown-link.js'
import { useSearch } from '../src/renderer/src/searchStore.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const resolveLink = vi.fn<(input: unknown) => Promise<LinkResolution>>()
const editorOpen = vi.fn(async () => true)
const editorOpenHandoff = vi.fn(async () => true)
const editorReveal = vi.fn(async () => true)

let root: Root
let host: HTMLDivElement

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const reason = (code: string, params: Record<string, string | number>): string =>
  `aios-reason:${code} ${JSON.stringify(params)}`

beforeEach(() => {
  resolveLink.mockReset()
  editorOpen.mockClear()
  editorOpenHandoff.mockClear()
  editorReveal.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    fs: { resolveLink },
    editor: { open: editorOpen, openHandoff: editorOpenHandoff, reveal: editorReveal }
  }
  useLocale.setState({ resolved: 'en' })
  useLinkNotice.setState({ notice: null })
  useThreads.setState({ activeThreadId: 't1', error: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(LinkNotice)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')]
const byText = (text: string): HTMLButtonElement | undefined => buttons().find((b) => b.textContent === text)

describe('LinkNotice', () => {
  it('候補が複数なら一覧を出し、押した候補を行つきで開いて帯を消す', async () => {
    const select = vi.fn()
    act(() => useStore.setState({ select, appInfo: { homeUri: 'file:///Users/me', platform: 'darwin' } } as never))
    resolveLink.mockResolvedValueOnce({
      ok: false,
      reason: reason('link-ambiguous', { name: 'MMU.S', count: 2 }),
      choices: [{ uri: 'file:///Users/me/git/b/uC3/MMU.S', line: 7 }, { uri: 'file:///Users/me/git/a/uC3/MMU.S', line: 7 }]
    })
    await act(async () => {
      openLinkHref('uC3/MMU.S:7', null)
      await settle()
    })
    expect(useThreads.getState().error).toBeNull()
    expect(host.querySelector('.link-notice-reason')?.textContent).toContain('2 files match MMU.S')
    const choice = byText('~/git/b/uC3/MMU.S')
    expect(choice).toBeDefined()
    act(() => choice!.click())
    expect(select).toHaveBeenCalledWith('file:///Users/me/git/b/uC3/MMU.S', { line: 7, column: null })
    expect(host.querySelector('.link-notice')).toBeNull()
  })

  it('見つからないときは試したパスと「名前で検索」(ファイル名検索の欄に名前を入れる)', async () => {
    const requestFocus = vi.fn()
    useSearch.setState({ requestFocus } as never)
    resolveLink.mockResolvedValueOnce({
      ok: false,
      reason: reason('link-not-found', { name: 'settings.json' }),
      tried: ['/Users/me/proj/.vscode/settings.json'],
      searchName: 'settings.json'
    })
    await act(async () => {
      openLinkHref('.vscode/settings.json', null)
      await settle()
    })
    expect(host.querySelector('.link-notice-tried li')?.textContent).toBe('/Users/me/proj/.vscode/settings.json')
    act(() => byText('Search by name')!.click())
    expect(requestFocus).toHaveBeenCalledWith('names', 'settings.json')
    expect(useLinkNotice.getState().notice).toBeNull()
  })

  it('除外の場所なら「外部エディタで開く」「Finder で表示」(main の口を呼ぶだけ)。フォルダは Finder だけ', async () => {
    act(() => useStore.setState({ appInfo: { homeUri: 'file:///Users/me', platform: 'darwin' } } as never))
    const uri = 'file:///Users/me/Library/Application%20Support/Code/User/settings.json'
    act(() => useLinkNotice.getState().show({ ok: false, reason: reason('link-excluded', { name: 'settings.json' }), handoffUri: uri }))
    act(() => byText('Open in External Editor')!.click())
    // An entry point only for the band (`editor.openHandoff`). The choke point of the ordinary `editor.open` is not widened (a fix from code review).
    expect(editorOpenHandoff).toHaveBeenCalledWith(uri)
    expect(editorOpen).not.toHaveBeenCalled()
    act(() => useLinkNotice.getState().show({ ok: false, reason: 'x', handoffUri: uri }))
    act(() => byText('Reveal in Finder')!.click())
    expect(editorReveal).toHaveBeenCalledWith(uri, false)

    act(() =>
      useLinkNotice.getState().show({ ok: false, reason: 'x', handoffUri: 'file:///p/node_modules', handoffDirectory: true })
    )
    expect(byText('Open in External Editor')).toBeUndefined()
    act(() => byText('Reveal in Finder')!.click())
    expect(editorReveal).toHaveBeenLastCalledWith('file:///p/node_modules', true)
  })

  it('TODO 1214 の code-review: 除外の場所の表の拡張子 (.pdf / .xlsx) も「外部エディタで開く」(既定のアプリの文言・口は出さない)', () => {
    act(() => useStore.setState({ appInfo: { homeUri: 'file:///Users/me', platform: 'darwin' } } as never))
    for (const uri of ['file:///Users/me/Library/Caches/report.pdf', 'file:///Users/me/proj/node_modules/x/book.xlsx']) {
      act(() => useLinkNotice.getState().show({ ok: false, reason: reason('link-excluded', { name: 'x' }), handoffUri: uri }))
      expect(byText('Open in Default App')).toBeUndefined()
      act(() => byText('Open in External Editor')!.click())
      expect(editorOpenHandoff).toHaveBeenLastCalledWith(uri)
    }
    expect(editorOpen).not.toHaveBeenCalled()
  })

  it('材料の無い失敗は今までどおり app-error の 1 行。Esc で帯が消える', async () => {
    resolveLink.mockResolvedValueOnce({ ok: false, reason: 'aios-reason:path-excluded' })
    await act(async () => {
      openLinkHref('.netrc', null)
      await settle()
    })
    expect(useThreads.getState().error).toBe('aios-reason:path-excluded')
    expect(host.querySelector('.link-notice')).toBeNull()

    act(() => useLinkNotice.getState().show({ ok: false, reason: 'x', searchName: 'a' }))
    expect(host.querySelector('.link-notice')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(host.querySelector('.link-notice')).toBeNull()
  })

  it('TODO 995: 遅れて返った前のリンクの失敗では吹き出しを出さない', async () => {
    let rejectFirst: (v: LinkResolution) => void = () => undefined
    resolveLink.mockReturnValueOnce(new Promise<LinkResolution>((r) => (rejectFirst = r)))
    resolveLink.mockResolvedValueOnce({ ok: true, uri: 'file:///p/b.ts' })
    openLinkHref('a.ts', null, {}, undefined, { x: 1, y: 2 })
    await act(async () => {
      openLinkHref('b.ts', null, {}, undefined, { x: 5, y: 6 })
      await settle()
    })
    await act(async () => {
      rejectFirst({ ok: false, reason: reason('link-not-found', { name: 'a.ts' }) })
      await settle()
    })
    expect(useLinkPopover.getState().popover).toBeNull()
  })

  it('TODO 995: 吹き出しが出ている間の Esc はそこで止まり、閉じるだけ', () => {
    const popHost = document.createElement('div')
    document.body.appendChild(popHost)
    const popRoot = createRoot(popHost)
    act(() => popRoot.render(createElement(LinkPopover)))
    act(() => useLinkPopover.getState().show({ x: 1, y: 2 }, 'notFound'))
    expect(popHost.querySelector('.link-popover')).not.toBeNull()
    const other = vi.fn()
    document.addEventListener('keydown', other)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      document.body.dispatchEvent(event)
    })
    document.removeEventListener('keydown', other)
    expect(event.defaultPrevented).toBe(true)
    expect(other).not.toHaveBeenCalled()
    expect(popHost.querySelector('.link-popover')).toBeNull()
    // When it is not showing, it takes nothing.
    const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      document.body.dispatchEvent(second)
    })
    expect(second.defaultPrevented).toBe(false)
    act(() => popRoot.unmount())
    popHost.remove()
  })
})
