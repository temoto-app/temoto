// @vitest-environment jsdom
/**
 * TODO 1300: Files follows the local file the viewer shows (`files-follow-viewer.ts`).
 *
 * - `filesFollowTarget`: only `file://`, and nothing while a temporary view is in front.
 * - `useFilesFollowViewer`: a change of the shown file becomes the Files selection (overwriting it), back / forward
 *   included; Web, `thread://` and temporary views leave it alone; the sidebar mode is never switched.
 * - `followShownFile` (focus): selects and reveals without switching the mode.
 * - `watchFrameFocusEnter`: the parent's blur with the iframe as `activeElement` is "focus went into the viewer".
 *
 * Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  filesFollowTarget,
  followShownFile,
  useFilesFollowViewer,
  watchFrameFocusEnter
} from '../src/renderer/src/files-follow-viewer.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { pickFilerRow, useFiler } from '../src/renderer/src/filerHistory.js'
import { currentFilerUri, EMPTY_FILER } from '../src/renderer/src/filer-history.js'
import { withNavigating } from '../src/renderer/src/navigating.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = 'file:///Users/me/a.md'
const B = 'file:///Users/me/b.md'

function filesSelection(): string | null {
  return currentFilerUri(useFiler.getState().histories.t1 ?? EMPTY_FILER)
}

describe('filesFollowTarget', () => {
  it('follows local files only, and nothing behind a temporary view', () => {
    expect(filesFollowTarget(A, false)).toBe(A)
    expect(filesFollowTarget(A, true)).toBeNull()
    expect(filesFollowTarget('https://example.com/', false)).toBeNull()
    expect(filesFollowTarget('thread://abc', false)).toBeNull()
    expect(filesFollowTarget(null, false)).toBeNull()
  })
})

describe('useFilesFollowViewer / followShownFile', () => {
  let container: HTMLDivElement
  let root: Root
  const reveal = vi.fn(async () => undefined)

  function Host(): null {
    useFilesFollowViewer()
    return null
  }

  beforeEach(async () => {
    reveal.mockClear()
    useFiler.setState({ histories: {} })
    useThreads.setState({ activeThreadId: 't1', mode: 'threads', sidebarCollapsed: false })
    useStore.setState({ selectedUri: null, transient: null, results: null, reveal } as never)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Host)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function show(uri: string | null, options: { readonly navigating?: boolean } = {}): Promise<void> {
    await act(async () => {
      const run = (): void => useStore.setState({ selectedUri: uri })
      if (options.navigating === true) withNavigating(run)
      else run()
      await Promise.resolve()
    })
  }

  it('a newly shown local file becomes the Files selection, overwriting another row, without switching the mode', async () => {
    pickFilerRow('file:///Users/me/folder')
    await show(A)
    expect(filesSelection()).toBe(A)
    expect(useThreads.getState().mode).toBe('threads')
  })

  it('follows viewer back / forward (moves under the navigating marker)', async () => {
    await show(A)
    await show(B, { navigating: true })
    expect(filesSelection()).toBe(B)
  })

  it('leaves Files alone for Web pages, conversations and temporary views', async () => {
    await show(A)
    await show('https://example.com/')
    expect(filesSelection()).toBe(A)
    await show('thread://abc')
    expect(filesSelection()).toBe(A)
    useStore.setState({ transient: { kind: 'diff' } } as never)
    await show(B)
    expect(filesSelection()).toBe(A)
  })

  it('focus on the viewer selects and reveals the shown file (no mode switch)', () => {
    useStore.setState({ selectedUri: A })
    followShownFile()
    expect(filesSelection()).toBe(A)
    expect(reveal).toHaveBeenCalledWith(A, { auto: true })
    expect(useThreads.getState().mode).toBe('threads')
  })

  it('focus does nothing for a Web page', () => {
    useStore.setState({ selectedUri: 'https://example.com/' })
    followShownFile()
    expect(filesSelection()).toBeNull()
    expect(reveal).not.toHaveBeenCalled()
  })
})

describe('watchFrameFocusEnter', () => {
  it('fires when the parent loses focus to the iframe, not to elsewhere', () => {
    vi.useFakeTimers()
    try {
      const frame = document.createElement('iframe')
      document.body.append(frame)
      const onEnter = vi.fn()
      const stop = watchFrameFocusEnter(window, () => frame, onEnter)
      const active = vi.spyOn(document, 'activeElement', 'get')
      active.mockReturnValue(document.body)
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1)
      expect(onEnter).not.toHaveBeenCalled()
      active.mockReturnValue(frame)
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1)
      expect(onEnter).toHaveBeenCalledTimes(1)
      stop()
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1)
      expect(onEnter).toHaveBeenCalledTimes(1)
      active.mockRestore()
      frame.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})
