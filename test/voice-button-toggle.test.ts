// @vitest-environment jsdom
/**
 * TODO 1268 (review): the keyboard shortcut's entry point `toggleRef` of `VoiceButton` is set in an effect, so under StrictMode
 * (mount -> cleanup -> mount) it is live right after mounting, and it is cleared on unmount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VoiceButton } from '../src/renderer/src/components/VoiceButton.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('VoiceButton toggleRef (TODO 1268)', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('even in StrictMode, the ⌘D receiver is alive right after mount and calls the latest onNotice; returns to null on unmount', async () => {
    ;(window as unknown as { aios: unknown }).aios = { voice: { transcribe: vi.fn() } }
    const container = document.createElement('div')
    root = createRoot(container)
    const toggleRef: { current: (() => void) | null } = { current: null }
    const first = vi.fn()
    const second = vi.fn()
    const render = (onNotice: (m: string | null) => void): void => {
      act(() => {
        root?.render(createElement(StrictMode, null, createElement(VoiceButton, { threadId: 't', onText: () => {}, onNotice, toggleRef })))
      })
    }
    render(first)
    expect(toggleRef.current).not.toBeNull()
    render(second)
    await act(async () => {
      toggleRef.current?.()
    })
    // `start` clears the notice first (the latest callback), and getUserMedia is absent in jsdom, so the notice for that follows.
    expect(second).toHaveBeenCalledWith(null)
    expect(first).not.toHaveBeenCalled()
    act(() => root?.unmount())
    root = null
    expect(toggleRef.current).toBeNull()
  })
})
