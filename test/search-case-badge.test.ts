// @vitest-environment jsdom
/**
 * TODO 291 (wave 16 bundle E): the `Aa` badge for smart case.
 *
 * - The badge appears only when case is distinguished, and pressing it switches nothing (a plain `span`, with the explanation in the title).
 * - Whether case is distinguished is taken from the `caseSensitive` that the index process puts in the result, which searchStore copies
 *   (the renderer does not judge). It disappears when the field is emptied.
 * Uses neither the model nor Electron. `window.aios` is a minimal fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchResponse } from '../src/shared/search.js'
import type { FileSearchResult } from '../src/shared/types.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const query = vi.fn<(...args: unknown[]) => Promise<SearchResponse>>()
const searchFiles = vi.fn<(...args: unknown[]) => Promise<FileSearchResult>>()

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  query.mockReset()
  searchFiles.mockReset()
  ;(window as unknown as { aios: unknown }).aios = {
    search: { query },
    fs: { searchFiles }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('SearchCaseBadge', () => {
  it('shows `Aa` only when shown, and keeps the description in title', async () => {
    const { SearchCaseBadge } = await import('../src/renderer/src/components/SearchCaseBadge.js')
    act(() => root.render(createElement(SearchCaseBadge, { shown: false })))
    expect(host.querySelector('.search-case-badge')).toBeNull()
    act(() => root.render(createElement(SearchCaseBadge, { shown: true })))
    const badge = host.querySelector<HTMLElement>('.search-case-badge')
    expect(badge?.textContent).toBe('Aa')
    expect(badge?.tagName).toBe('SPAN')
    expect(badge?.getAttribute('title')).not.toBe('')
  })
})

describe("searchStore mirrors the result's caseSensitive", () => {
  it('all three of body, conversation and file name are set for a case-sensitive result and cleared when emptied', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    const response = (caseSensitive: boolean): SearchResponse => ({
      hits: [],
      total: 0,
      truncated: false,
      tookMs: 1,
      ...(caseSensitive ? { caseSensitive: true } : {})
    })
    query.mockResolvedValueOnce(response(true))
    useSearch.getState().setFileQuery('System')
    await flush()
    expect(useSearch.getState().fileCaseSensitive).toBe(true)

    query.mockResolvedValueOnce(response(false))
    useSearch.getState().setFileQuery('system')
    await flush()
    expect(useSearch.getState().fileCaseSensitive).toBe(false)

    query.mockResolvedValueOnce(response(true))
    useSearch.getState().setConversationQuery('Kernel')
    await flush()
    expect(useSearch.getState().conversationCaseSensitive).toBe(true)
    useSearch.getState().setConversationQuery('')
    expect(useSearch.getState().conversationCaseSensitive).toBe(false)

    searchFiles.mockResolvedValueOnce({
      entries: [],
      total: 0,
      truncated: false,
      scanTruncated: false,
      cwd: null,
      caseSensitive: true,
      cancelled: false,
      tookMs: 1
    })
    useSearch.getState().setNameQuery('System')
    await flush()
    expect(useSearch.getState().nameCaseSensitive).toBe(true)
    useSearch.getState().setNameQuery('')
    expect(useSearch.getState().nameCaseSensitive).toBe(false)
  })
})
