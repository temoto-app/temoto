/**
 * TODO 1267: the dictation request that the hotkey hands to the Composer. It is consumed once, only for its own thread, and only while fresh,
 * so pressing the hotkey while already recording (the request is consumed and the idle check in VoiceButton refuses) never starts twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DICTATE_REQUEST_FRESH_MS, useThreads } from '../src/renderer/src/threadStore.js'

afterEach(() => {
  vi.useRealTimers()
  useThreads.setState({ dictateRequest: null })
})

describe('dictateRequest', () => {
  it('can be taken only once and is not handed to another conversation', () => {
    useThreads.setState({ dictateRequest: { threadId: 'a', at: Date.now() } })
    expect(useThreads.getState().takeDictateRequest('b')).toBe(false)
    expect(useThreads.getState().takeDictateRequest('a')).toBe(true)
    expect(useThreads.getState().takeDictateRequest('a')).toBe(false)
  })

  it('an old request has no effect (it is still consumed)', () => {
    vi.useFakeTimers()
    useThreads.setState({ dictateRequest: { threadId: 'a', at: Date.now() } })
    vi.advanceTimersByTime(DICTATE_REQUEST_FRESH_MS + 1)
    expect(useThreads.getState().takeDictateRequest('a')).toBe(false)
    expect(useThreads.getState().dictateRequest).toBeNull()
  })
})
