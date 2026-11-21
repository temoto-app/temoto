// @vitest-environment jsdom
/**
 * TODO 585: a `.app` in file-name search results is also shown with the same OS icon as the Files tree (the IPC of TODO 562's
 * `app-icon.ts`, `AppBundleIcon`). A symlinked `.app` is the same (decided only by name and folder check, the same `isAppBundle` as 562).
 *
 * The virtual list is replaced with a fake that draws every row. Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchHit } from '../src/shared/search.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => options.count * 40,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 40,
        size: options.estimateSize(index),
        key: index
      })),
    scrollToIndex: () => undefined
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function hit(id: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    uri: `file:///w/${id}`,
    title: id,
    source: 'fs',
    kind: 'file',
    updatedAt: 0,
    score: 0,
    snippet: '',
    threadId: null,
    eventId: null,
    context: '',
    contextCode: null,
    ...extra
  }
}

let reactRoot: Root
let host: HTMLDivElement
let appIcon: ReturnType<typeof vi.fn>

beforeEach(async () => {
  appIcon = vi.fn(async () => 'data:image/png;base64,AAAA')
  ;(window as unknown as { aios: unknown }).aios = {
    // TODO 896: SearchMode takes the list so that it can show the plugin's search section (there is no section here).
    plugins: { list: async () => [], onChanged: () => () => undefined },
    editor: { reveal: vi.fn() },
    fs: { appIcon }
  }
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  useSearch.setState({
    fileQuery: '',
    fileHits: [],
    fileCwd: null,
    nameQuery: 'xcode',
    nameHits: [
      hit('Xcode.app', { uri: 'file:///Applications/Xcode.app', kind: 'directory' }),
      hit('readme.txt', { uri: 'file:///w/readme.txt', kind: 'file' })
    ],
    nameOutcome: { total: 2, truncated: false, scanTruncated: false },
    nameCwd: null,
    conversationHits: [],
    focusRequest: null,
    setFileQuery: () => undefined,
    setNameQuery: () => undefined,
    setConversationQuery: () => undefined,
    refreshForCwd: () => undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
  await act(async () => {
    reactRoot.render(createElement(SearchMode))
    // Use up the microtasks of `AppBundleIcon`'s `requestIcon` → `appIcon` → `setSrc`
    // (in this test it is resolved at mount, and each test's body only looks at the result).
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

function row(name: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('.search-hit-name')].find(
    (el) => el.textContent === name
  )
  if (found === undefined) throw new Error(`no row ${name}`)
  const parent = found.closest('.search-hit-title')
  if (parent === null) throw new Error(`no title wrapper for ${name}`)
  return parent as HTMLElement
}

describe('TODO 585: `.app` icon in file name search', () => {
  it('a `.app` row fetches AppBundleIcon (not the Seti folder). Once fetched it is replaced by an <img>', () => {
    expect(appIcon).toHaveBeenCalledWith('file:///Applications/Xcode.app')
    expect(row('Xcode.app').querySelector('img.file-icon-app')).not.toBeNull()
  })

  it('a file that is not `.app` keeps the Seti icon as before and does not call `appIcon`', () => {
    expect(row('readme.txt').querySelector('.file-icon-app')).toBeNull()
    expect(appIcon).not.toHaveBeenCalledWith('file:///w/readme.txt')
  })
})
