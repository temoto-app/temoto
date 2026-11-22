// @vitest-environment jsdom
/**
 * TODO 1298: the completion drop-down of the file viewer's address bar.
 *
 * - pure functions (`viewer-address-suggest.ts`): when it opens, the file rows (inside the cwd, files only, at most 8),
 *   the Google row and its URL, ↑ / ↓ through "nothing picked".
 * - jsdom (`ViewerAddressBar`): the cwd-scoped lookup, Enter on a picked row, Esc closing the drop-down while keeping the
 *   input, and the Google row only for a conversation without a working folder.
 *
 * Neither the model nor Electron is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry, FileSearchResult } from '../src/shared/types.js'
import {
  ADDRESS_FILE_LIMIT,
  addressFileRows,
  addressSuggestQuery,
  addressSuggestions,
  moveAddressCursor
} from '../src/renderer/src/viewer-address-suggest.js'
import { ViewerAddressBar } from '../src/renderer/src/components/ViewerAddressBar.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CWD = 'file:///Users/me/git/aios'

function file(uri: string, isDirectory = false): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri: null, name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}

describe('addressSuggestQuery', () => {
  it('opens for words and relative paths', () => {
    expect(addressSuggestQuery('readme')).toBe('readme')
    expect(addressSuggestQuery('  docs/a ')).toBe('docs/a')
    expect(addressSuggestQuery('README.md')).toBe('README.md')
    expect(addressSuggestQuery('hello world')).toBe('hello world')
  })

  it('stays shut for nothing typed, complete URLs and paths, and refused schemes', () => {
    expect(addressSuggestQuery(null)).toBeNull()
    expect(addressSuggestQuery('   ')).toBeNull()
    expect(addressSuggestQuery('https://example.com')).toBeNull()
    expect(addressSuggestQuery('~/git/a.md')).toBeNull()
    expect(addressSuggestQuery('/etc/hosts')).toBeNull()
    expect(addressSuggestQuery('file:///tmp/a')).toBeNull()
    expect(addressSuggestQuery('javascript:alert(1)')).toBeNull()
    expect(addressSuggestQuery('localhost:3000')).toBeNull()
  })
})

describe('addressFileRows / addressSuggestions / moveAddressCursor', () => {
  it('keeps files strictly inside the cwd, drops folders, and keeps the order', () => {
    const rows = addressFileRows(
      [
        file(`${CWD}/docs/a.md`),
        file(`${CWD}/docs`, true),
        file('file:///Users/me/git/aios-stable/a.md'),
        file(`${CWD}/My%20Notes/b.md`),
        file(`${CWD}/c.md`)
      ],
      CWD
    )
    expect(rows).toEqual([
      { kind: 'file', uri: `${CWD}/docs/a.md`, name: 'a.md', path: 'docs' },
      { kind: 'file', uri: `${CWD}/My%20Notes/b.md`, name: 'b.md', path: 'My Notes' },
      { kind: 'file', uri: `${CWD}/c.md`, name: 'c.md', path: '' }
    ])
  })

  it('shows at most 8 file rows', () => {
    const many = Array.from({ length: 20 }, (_, i) => file(`${CWD}/f${i}.md`))
    expect(addressFileRows(many, CWD)).toHaveLength(ADDRESS_FILE_LIMIT)
  })

  it('ends with one Google row whose words are URL-encoded', () => {
    const rows = addressSuggestions('a&b c', [])
    expect(rows).toEqual([{ kind: 'google', query: 'a&b c', url: 'https://www.google.com/search?q=a%26b%20c' }])
  })

  it('moves through the rows and wraps through "nothing picked"', () => {
    expect(moveAddressCursor(-1, 3, 1)).toBe(0)
    expect(moveAddressCursor(2, 3, 1)).toBe(-1)
    expect(moveAddressCursor(-1, 3, -1)).toBe(2)
    expect(moveAddressCursor(0, 3, -1)).toBe(-1)
    expect(moveAddressCursor(0, 0, 1)).toBe(-1)
  })
})

describe('ViewerAddressBar drop-down (TODO 1298, jsdom)', () => {
  const FILE = `${CWD}/docs/a.md`
  let container: HTMLDivElement
  let root: Root
  let newTab: ReturnType<typeof vi.fn>
  let resolveLink: ReturnType<typeof vi.fn>
  let searchFiles: ReturnType<typeof vi.fn>

  function result(entries: readonly FileEntry[]): FileSearchResult {
    return {
      entries,
      total: entries.length,
      truncated: false,
      scanTruncated: false,
      cwd: null,
      cancelled: false,
      tookMs: 0
    }
  }

  async function mount(cwdUri: string): Promise<void> {
    useThreads.setState({
      activeThreadId: 't1',
      error: null,
      threadsById: { t1: { thread: { id: 't1', cwdUri } } as never }
    })
    await act(async () => {
      root.render(createElement(ViewerAddressBar, { uri: FILE, homeUri: 'file:///Users/me', onContextMenu: () => undefined }))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    newTab = vi.fn(async () => ({ tabs: [], activeId: null }))
    resolveLink = vi.fn(async () => ({ ok: true, uri: `${CWD}/src/App.tsx` }))
    searchFiles = vi.fn(async () => result([file(`${CWD}/src/App.tsx`), file(`${CWD}/src/app.css`)]))
    ;(window as unknown as { aios: unknown }).aios = {
      web: { newTab, resolveLink: async (url: string) => url },
      fs: { resolveLink, searchFiles },
      app: { openExternal: async () => undefined }
    }
    useLocale.setState({ resolved: 'en' } as never)
    useStore.setState({ selectedUri: FILE })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const field = (): HTMLInputElement => {
    const input = container.querySelector<HTMLInputElement>('input.viewer-address')
    if (input === null) throw new Error('no address bar')
    return input
  }
  const rows = (): string[] =>
    Array.from(container.querySelectorAll('.viewer-address-menu li')).map((li) => li.textContent ?? '')

  async function type(text: string): Promise<void> {
    const input = field()
    await act(async () => {
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Past the debounce, and let the lookup answer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
  }

  async function press(key: string): Promise<void> {
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('searches the file names inside the cwd only and lists them above the Google row', async () => {
    await mount(CWD)
    await type('app')
    expect(searchFiles).toHaveBeenCalledWith('app', expect.any(Number), null, CWD)
    expect(rows()).toEqual(['App.tsxsrc', 'app.csssrc', en['viewer.address.google'].replace('{query}', 'app')])
  })

  it('↓ + Enter opens the picked file through the same path as a typed one', async () => {
    await mount(CWD)
    await type('app')
    await press('ArrowDown')
    await press('Enter')
    expect(resolveLink).toHaveBeenCalledWith(expect.objectContaining({ href: `${CWD}/src/App.tsx`, baseUri: FILE }))
    expect(newTab).not.toHaveBeenCalled()
  })

  it('the Google row opens the search page in a new Web tab', async () => {
    await mount(CWD)
    await type('app')
    await press('ArrowUp')
    await press('Enter')
    expect(newTab).toHaveBeenCalledWith('https://www.google.com/search?q=app')
  })

  it('Enter with nothing picked opens what was typed, as before', async () => {
    await mount(CWD)
    await type('b.md')
    await press('Enter')
    expect(resolveLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'b.md', baseUri: FILE }))
  })

  it('the first Esc closes the drop-down and keeps the input; the next discards it', async () => {
    await mount(CWD)
    await type('app')
    expect(rows().length).toBeGreaterThan(0)
    await press('Escape')
    expect(rows()).toEqual([])
    expect(field().value).toBe('app')
    await press('Escape')
    expect(field().value).toBe('~/git/aios/docs/a.md')
  })

  it('without a working folder only the Google row is offered (no lookup)', async () => {
    await mount('')
    await type('app')
    expect(searchFiles).not.toHaveBeenCalled()
    expect(rows()).toEqual([en['viewer.address.google'].replace('{query}', 'app')])
  })

  it('a complete URL gets no drop-down', async () => {
    await mount(CWD)
    await type('https://example.com')
    expect(rows()).toEqual([])
    expect(searchFiles).not.toHaveBeenCalled()
  })
})
