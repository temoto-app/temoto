// @vitest-environment jsdom
/**
 * TODO 999 / 1172: the small "recent" window of the Composer and the recent-file badges (DOM).
 *
 * - The clock button opens the small window, which lists tiles newest first (images as thumbnails, others as icon, name, location and time).
 *   A kind button re-queries `recent.list` with a filter. Choosing a tile attaches it through the same path as a Drop (`threads.resolveAttachment`) and closes the window.
 * - While it is open, it subscribes to watch diffs and re-queries when a diff concerns a file that could appear under "recent". Esc closes it.
 * - Badges show only while aios is in front: at most 3 (one is shown large). ✕ removes one; clicking the badge itself or the attach button attaches it.
 *
 * Calls neither the real CLI nor the model. `window.aios` is a fake with only the entry points used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileChangeBatch } from '../src/shared/types.js'
import type { RecentFile } from '../src/shared/recent-files.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let changeListener: ((batch: FileChangeBatch) => void) | null
const list = vi.fn()
const resolveAttachment = vi.fn()
const offers = vi.fn()

const NOW = Date.now()
const file = (name: string, kind: RecentFile['kind'], extra: Partial<RecentFile> = {}): RecentFile => ({
  uri: `file:///Users/a/Desktop/${encodeURIComponent(name)}`,
  parentUri: 'file:///Users/a/Desktop',
  name,
  ext: name.slice(name.lastIndexOf('.') + 1),
  size: 10,
  mtimeMs: NOW - 60_000,
  kind,
  ai: false,
  ...extra
})

beforeEach(async () => {
  changeListener = null
  list.mockReset()
  list.mockImplementation(async (options: { kinds?: readonly string[] }) =>
    options.kinds?.includes('code') === true ? [file('main.c', 'code')] : [file('shot.png', 'image'), file('main.c', 'code', { ai: true })]
  )
  resolveAttachment.mockReset()
  resolveAttachment.mockImplementation(async (_threadId: string, uri: string) => ({
    ok: true,
    attachment: { uri, name: 'x', kind: 'reference', mediaType: null, bytes: 1 },
    outsideAllowed: false,
    keepsThumbnail: false
  }))
  offers.mockReset()
  offers.mockResolvedValue([])
  ;(window as unknown as { aios: unknown }).aios = {
    recent: {
      list,
      thumbnail: vi.fn(async () => 'data:image/png;base64,AAAA'),
      offers
    },
    threads: { resolveAttachment },
    fs: {
      onFileChanges: (listener: (batch: FileChangeBatch) => void) => {
        changeListener = listener
        return () => {
          changeListener = null
        }
      }
    }
  }
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useThreads.setState({ attachments: {} })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = (): Promise<void> => act(async () => {})

describe('small window of recent files', () => {
  it('on open, newest-first tiles, thumbnails for images, and an AI badge; filters by kind, and choosing attaches and closes', async () => {
    const { RecentFilesButton } = await import('../src/renderer/src/components/RecentFiles.js')
    act(() => root.render(createElement(RecentFilesButton, { threadId: 't1' })))
    const button = host.querySelector('button.composer-attach') as HTMLButtonElement
    act(() => button.click())
    await settle()
    const popup = document.body.querySelector('.recent-files')!
    expect(popup).not.toBeNull()
    const tiles = [...popup.querySelectorAll('.recent-tile')]
    expect(tiles.map((tile) => tile.querySelector('.recent-tile-name')?.textContent)).toEqual(['shot.png', 'main.c'])
    expect(tiles[0]?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(tiles[1]?.querySelector('img')).toBeNull()
    expect(tiles[1]?.querySelector('.recent-tile-ai')).not.toBeNull()
    expect(tiles[0]?.textContent).toContain('/Users/a/Desktop')

    const code = [...popup.querySelectorAll('.recent-files-filter button')].find((b) => b.textContent === 'Code') as HTMLButtonElement
    act(() => code.click())
    await settle()
    expect(list).toHaveBeenLastCalledWith({ kinds: ['code'] })
    expect([...document.body.querySelectorAll('.recent-tile-name')].map((n) => n.textContent)).toEqual(['main.c'])

    act(() => (document.body.querySelector('.recent-tile') as HTMLButtonElement).click())
    await settle()
    expect(resolveAttachment).toHaveBeenCalledWith('t1', 'file:///Users/a/Desktop/main.c')
    expect(document.body.querySelector('.recent-files')).toBeNull()
  })

  it('while open it re-queries on differences, and closing stops the subscription; Esc closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { RecentFilesButton } = await import('../src/renderer/src/components/RecentFiles.js')
      act(() => root.render(createElement(RecentFilesButton, { threadId: 't1' })))
      act(() => (host.querySelector('button.composer-attach') as HTMLButtonElement).click())
      await settle()
      expect(list).toHaveBeenCalledTimes(1)
      const entry = { uri: 'file:///Users/a/Desktop/new.pdf', parentUri: 'file:///Users/a/Desktop', name: 'new.pdf', isDirectory: false, size: 1, mtimeMs: NOW, ext: 'pdf' }
      act(() => changeListener?.({ changes: [{ type: 'create', uri: entry.uri, parentUri: entry.parentUri, entry }], at: NOW }))
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(list).toHaveBeenCalledTimes(2)
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await settle()
      expect(document.body.querySelector('.recent-files')).toBeNull()
      expect(changeListener).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('recent files badge (TODO 1172)', () => {
  const fresh = (name: string, kind: RecentFile['kind'], extra: Partial<RecentFile> = {}): RecentFile =>
    file(name, kind, { mtimeMs: Date.now() - 1000, ...extra })

  it('with one item it is large (name, place, [attach]), and [attach] attaches and dismisses it', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    offers.mockResolvedValue([fresh('Screenshot 1.png', 'image')])
    const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
    act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
    await settle()
    const group = host.querySelector('.composer-recent-offers')!
    expect(group.classList.contains('single')).toBe(true)
    const card = group.querySelector('.recent-offer.single')!
    expect(card.textContent).toContain('Screenshot 1.png')
    expect(card.textContent).toContain('/Users/a/Desktop')
    expect(card.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    const attach = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Attach') as HTMLButtonElement
    act(() => attach.click())
    await settle()
    expect(resolveAttachment).toHaveBeenCalledWith('t1', 'file:///Users/a/Desktop/Screenshot%201.png')
    expect(host.querySelector('.composer-recent-offers')).toBeNull()
  })

  it('TODO 1197 / 1198: with the heading "Recent files"; 4 or more go in a grid, and even with 15 it shows up to 12', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    offers.mockResolvedValue(Array.from({ length: 15 }, (_, i) => fresh(`f${i}.png`, 'image', { uri: `file:///Users/a/Desktop/f${i}.png` })))
    const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
    act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
    await settle()
    const group = host.querySelector('.composer-recent-offers')!
    const heading = group.querySelector('.recent-offers-heading')!
    expect(heading.textContent).toBe('Recent files')
    // The name points to the visible heading (no double reading with aria-label). The grid that contains the buttons does not get role="status".
    expect(group.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(group.getAttribute('aria-label')).toBeNull()
    expect(group.getAttribute('role')).toBe('group')
    expect(group.classList.contains('grid')).toBe(true)
    expect(host.querySelectorAll('.recent-offer')).toHaveLength(12)
    expect(host.querySelector('.recent-offer.single')).toBeNull()
  })

  it('with 3 it lines them up horizontally; images are thumbnails and others icons; clicking a badge attaches, and ✕ removes just that one', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    offers.mockResolvedValue([
      fresh('IMG_2.heic', 'image'),
      fresh('notes.md', 'document'),
      fresh('main.c', 'code', { ai: true })
    ])
    const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
    act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
    await settle()
    const cards = (): Element[] => [...host.querySelectorAll('.recent-offer')]
    expect(cards().map((card) => card.querySelector('.recent-offer-name')?.textContent)).toEqual(['IMG_2.heic', 'notes.md', 'main.c'])
    expect(host.querySelector('.composer-recent-offers')?.classList.contains('single')).toBe(false)
    expect(host.querySelector('.recent-offer.single')).toBeNull()
    expect(cards()[0]?.querySelector('img')).not.toBeNull()
    expect(cards()[1]?.querySelector('img')).toBeNull()
    expect(cards()[2]?.querySelector('.recent-tile-ai')).not.toBeNull()
    // ✕ removes only one.
    act(() => (cards()[1]?.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
    await settle()
    expect(cards().map((card) => card.querySelector('.recent-offer-name')?.textContent)).toEqual(['IMG_2.heic', 'main.c'])
    // Clicking the badge itself attaches it.
    act(() => (cards()[1]?.querySelector('.recent-offer-pick') as HTMLButtonElement).click())
    await settle()
    expect(resolveAttachment).toHaveBeenCalledWith('t1', 'file:///Users/a/Desktop/main.c')
    expect(cards().map((card) => card.querySelector('.recent-offer-name')?.textContent)).toEqual(['IMG_2.heic'])
  })

  it('does not ask or show unless frontmost; when it comes to the front it asks, and asks again on a difference of files that could appear in "recent"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      offers.mockResolvedValue([fresh('Screenshot 2.png', 'image')])
      const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
      act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
      await settle()
      expect(offers).not.toHaveBeenCalled()
      expect(host.querySelector('.composer-recent-offers')).toBeNull()
      focus.mockReturnValue(true)
      act(() => window.dispatchEvent(new Event('focus')))
      await settle()
      expect(host.querySelector('.recent-offer')).not.toBeNull()
      expect(offers).toHaveBeenCalledTimes(1)
      const entry = { uri: 'file:///Users/a/w/a.ts', parentUri: 'file:///Users/a/w', name: 'a.ts', isDirectory: false, size: 1, mtimeMs: NOW, ext: 'ts' }
      act(() => changeListener?.({ changes: [{ type: 'update', uri: entry.uri, parentUri: entry.parentUri, entry }], at: NOW }))
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(offers).toHaveBeenCalledTimes(2)
      // Review of wave 75: a diff whose mtime is older than the 5-minute window (such as a scan diff) does not re-ask.
      const stale = { ...entry, uri: 'file:///Users/a/w/b.ts', name: 'b.ts', mtimeMs: Date.now() - 10 * 60_000 }
      act(() => changeListener?.({ changes: [{ type: 'update', uri: stale.uri, parentUri: stale.parentUri, entry: stale }], at: NOW }))
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(offers).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('wave 75 review: main returns more than the limit, and the next one moves up for what was removed (removing 3 of 15 brings in the 13th to 15th)', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const all = Array.from({ length: 15 }, (_, i) => `r${i + 1}.md`)
    offers.mockResolvedValue(all.map((name) => fresh(name, 'document')))
    const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
    act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
    await settle()
    const names = (): (string | null | undefined)[] =>
      [...host.querySelectorAll('.recent-offer')].map((card) => card.querySelector('.recent-offer-name')?.textContent)
    expect(names()).toEqual(all.slice(0, 12))
    for (let i = 0; i < 3; i += 1) {
      act(() => (host.querySelector('.recent-offer button[aria-label="Dismiss"]') as HTMLButtonElement).click())
      await settle()
    }
    expect(names()).toEqual(all.slice(3, 15))
  })

  it('does not show what is currently attached or what was turned off in settings (an empty response)', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const attached = fresh('already.png', 'image')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ attachments: { t1: [{ uri: attached.uri, name: 'already.png', kind: 'image', mediaType: 'image/png', bytes: 1 }] } } as never)
    offers.mockResolvedValue([attached])
    const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
    act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
    await settle()
    expect(host.querySelector('.composer-recent-offers')).toBeNull()
    offers.mockResolvedValue([])
    act(() => window.dispatchEvent(new Event('focus')))
    await settle()
    expect(host.querySelector('.composer-recent-offers')).toBeNull()
  })

  it('TODO 1136 (4): if blur happens during the query, a response arriving later does not show the badge again', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    let reply: (v: readonly RecentFile[]) => void = () => {}
    offers.mockReturnValue(new Promise<readonly RecentFile[]>((resolve) => (reply = resolve)))
    const { RecentOffers } = await import('../src/renderer/src/components/RecentOffers.js')
    act(() => root.render(createElement(RecentOffers, { threadId: 't1', hidden: false })))
    await settle()
    // Moved to the background. Also guards against a response arriving before hasFocus becomes false (judged only by the blur notification).
    act(() => window.dispatchEvent(new Event('blur')))
    reply([fresh('Screenshot 3.png', 'image')])
    await settle()
    expect(host.querySelector('.composer-recent-offers')).toBeNull()
    focus.mockReturnValue(true)
  })
})

describe('icons (wave 53 review)', () => {
  it('the "recent" button has a different shape from the "send later" clock and from Files', async () => {
    const { ComposerRecentIcon } = await import('../src/renderer/src/icons/ComposerRecentIcon.js')
    const { ComposerLaterIcon } = await import('../src/renderer/src/icons/ComposerLaterIcon.js')
    const { FilesIcon } = await import('../src/renderer/src/icons/FilesIcon.js')
    const markup = (icon: () => React.JSX.Element): string => {
      act(() => root.render(createElement(icon)))
      return host.innerHTML
    }
    const recent = markup(ComposerRecentIcon)
    expect(recent).not.toContain('<circle')
    expect(recent).not.toBe(markup(ComposerLaterIcon))
    expect(recent).not.toBe(markup(FilesIcon))
  })
})
