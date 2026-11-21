// @vitest-environment jsdom
/**
 * TODO 1007: 'Show in aios Files' in the viewer header.
 * Covers: when it is shown (only for file://), the sidebar switch on press and the reveal in the store, the EN / JA labels, and that exactly one is placed in the header.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { canShowInFiles, showInFiles } from '../src/renderer/src/show-in-files.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { ShowInFilesIcon } from '../src/renderer/src/icons/ShowInFilesIcon.js'
import { en, ja } from './helpers/i18n.js'

describe('TODO 1007: canShowInFiles', () => {
  it('file:// の実体だけ。一時表示・会話・null は出さない', () => {
    expect(canShowInFiles('file:///Users/x/a.md')).toBe(true)
    expect(canShowInFiles('thread://abc')).toBe(false)
    expect(canShowInFiles('diff://x')).toBe(false)
    expect(canShowInFiles(null)).toBe(false)
  })
})

describe('TODO 1007: showInFiles', () => {
  const reveal = vi.fn(async () => undefined)
  beforeEach(() => {
    reveal.mockClear()
    useStore.setState({ reveal } as never)
  })

  it('別のモードからは Files に切り替えて reveal(uri)', () => {
    useThreads.setState({ mode: 'threads', sidebarCollapsed: false })
    showInFiles('file:///Users/x/a.md')
    expect(useThreads.getState().mode).toBe('files')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    expect(reveal).toHaveBeenCalledWith('file:///Users/x/a.md')
  })

  it('Files のまま畳んでいれば開く。開いていれば畳まない', () => {
    useThreads.setState({ mode: 'files', sidebarCollapsed: true })
    showInFiles('file:///Users/x/a.md')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    showInFiles('file:///Users/x/b.md')
    expect(useThreads.getState().mode).toBe('files')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    expect(reveal).toHaveBeenCalledTimes(2)
  })

  it('畳んでいる別のモードからも Files で開く', () => {
    useThreads.setState({ mode: 'search', sidebarCollapsed: true })
    showInFiles('file:///Users/x/a.md')
    expect(useThreads.getState().mode).toBe('files')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
  })
})

describe('TODO 1007: 見出しのボタンと文言', () => {
  it('EN / JA の鍵があり、Finder で表示と別の文言', () => {
    expect(en['viewer.showInFiles']).toBe('Show in Temoto Files')
    expect(ja['viewer.showInFiles']).toContain('Files')
    expect(en['viewer.showInFiles']).not.toBe(en['path.revealMac'])
  })

  it('アイコンは currentColor だけ (色の直書きなし) で、Finder のアイコンとは別の形', () => {
    const html = renderToStaticMarkup(createElement(ShowInFilesIcon))
    expect(html).toContain('stroke="currentColor"')
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i)
    expect(html).toContain('<rect')
  })

  it('ViewerPane の見出しは canShowInFiles で出し分け、FileViewerPane 側にだけある (一時表示は別の pane)', () => {
    const src = readFileSync('src/renderer/src/components/ViewerPane.tsx', 'utf8')
    expect(src).toContain('canShowInFiles(uri) ?')
    expect(src).toContain('onClick={() => showInFiles(uri)}')
    expect(src.match(/viewer-show-in-files/g)?.length).toBe(1)
    const transient = readFileSync('src/renderer/src/components/TransientViewerPane.tsx', 'utf8')
    expect(transient).not.toContain('showInFiles')
  })
})
