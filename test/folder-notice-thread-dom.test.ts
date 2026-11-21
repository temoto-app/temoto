// @vitest-environment jsdom
/**
 * TODO 1118: also show the first-folder notice (item 123) above the Composer of a conversation with no messages (`placement="thread"`).
 * A conversation opened with `aios://new?cwd=…` does not pass through the creation dialog, so this becomes the only notice. The decision is main's `folderNotice` (a fake here). Only the visual class and the last sentence change with the placement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FolderNotice as Notice } from '../src/shared/thread.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FolderNotice の置き場所 (TODO 1118)', () => {
  let container: HTMLDivElement
  let root: Root
  let asked: string[]

  beforeEach(() => {
    asked = []
    const notice: Notice = { hooks: [{ uri: 'file:///work/proj/.agent/settings.json', names: ['SessionStart'] }], mcp: [] }
    ;(window as unknown as { aios: unknown }).aios = {
      threads: {
        folderNotice: async (cwdUri: string) => {
          asked.push(cwdUri)
          return notice
        }
      }
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { aios?: unknown }).aios
  })

  async function render(placement: 'dialog' | 'thread' | undefined): Promise<HTMLElement | null> {
    const { FolderNotice } = await import('../src/renderer/src/components/FolderNotice.js')
    await act(async () => {
      root.render(createElement(FolderNotice, { cwdUri: 'file:///work/proj', ...(placement === undefined ? {} : { placement }) }))
    })
    await act(async () => {})
    return container.querySelector<HTMLElement>('.folder-notice')
  }

  it('会話の上では in-thread の見た目で、末尾は「送る前に確かめる」の一文', async () => {
    const band = await render('thread')
    expect(asked).toEqual(['file:///work/proj'])
    expect(band?.classList.contains('in-thread')).toBe(true)
    const footer = band?.querySelector('.folder-notice-footer')?.textContent
    expect([en['thread.folderNotice.footer'], ja['thread.folderNotice.footer']]).toContain(footer)
    expect(band?.textContent).toContain('.agent/settings.json')
  })

  it('既定 (作成ダイアログ) は今までどおり', async () => {
    const band = await render(undefined)
    expect(band?.classList.contains('in-thread')).toBe(false)
    const footer = band?.querySelector('.folder-notice-footer')?.textContent
    expect([en['newThread.folderNotice.footer'], ja['newThread.folderNotice.footer']]).toContain(footer)
  })
})

describe('会話の帯を出す条件 (TODO 1118 の review の直し)', () => {
  it('印のある発言の無い会話だけに出す。印が無ければ (作成ダイアログで作り、履歴から消した会話も) 出さない', async () => {
    const { threadFolderNoticeVisible } = await import('../src/renderer/src/components/FolderNotice.js')
    expect(threadFolderNoticeVisible({ cwdHistoryDeferred: true, lastEventAt: null }, false)).toBe(true)
    expect(threadFolderNoticeVisible({ lastEventAt: null }, false)).toBe(false)
    expect(threadFolderNoticeVisible({ cwdHistoryDeferred: true, lastEventAt: 1 }, false)).toBe(false)
    expect(threadFolderNoticeVisible({ cwdHistoryDeferred: true, lastEventAt: null }, true)).toBe(false)
  })
})
