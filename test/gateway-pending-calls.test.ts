/**
 * The memo of gateway → main calls (`src/gateway/pending-calls.ts`, wave 45 code-review / TODO 847).
 * A timed-out call does not remain in the table, a response that arrives late is discarded, and a disconnect rejects all of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingCalls } from '../src/gateway/pending-calls.js'

describe('PendingCalls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on a response and disappears from the table', async () => {
    const calls = new PendingCalls()
    const sent: number[] = []
    const promise = calls.start((id) => sent.push(id))
    expect(calls.size).toBe(1)
    calls.settle(sent[0] ?? -1, undefined, { ok: 1 })
    await expect(promise).resolves.toEqual({ ok: 1 })
    expect(calls.size).toBe(0)
  })

  it('on timeout removes it from the table and rejects; a response arriving later is dropped', async () => {
    const calls = new PendingCalls()
    const sent: number[] = []
    const caught = calls.start((id) => sent.push(id), 2_000).catch((err: Error) => err.message)
    vi.advanceTimersByTime(1_999)
    expect(calls.size).toBe(1)
    vi.advanceTimersByTime(1)
    expect(await caught).toMatch(/did not answer in time/)
    expect(calls.size).toBe(0)
    // A response that arrives late does nothing (it does not throw).
    calls.settle(sent[0] ?? -1, undefined, { tools: [] })
    expect(calls.size).toBe(0)
  })

  it('if answered within the deadline no timer remains', async () => {
    const calls = new PendingCalls()
    const sent: number[] = []
    const promise = calls.start((id) => sent.push(id), 2_000)
    calls.settle(sent[0] ?? -1, 'boom', undefined)
    await expect(promise).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a call without a timeout remains however much time passes (approvals wait for hours)', () => {
    const calls = new PendingCalls()
    void calls.start(() => undefined).catch(() => undefined)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(calls.size).toBe(1)
  })

  it('on disconnect rejects everything and stops the timers', async () => {
    const calls = new PendingCalls()
    const a = calls.start(() => undefined, 2_000).catch((err: Error) => err.message)
    const b = calls.start(() => undefined).catch((err: Error) => err.message)
    calls.failAll('aios main disconnected')
    expect(await a).toBe('aios main disconnected')
    expect(await b).toBe('aios main disconnected')
    expect(calls.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('when the write throws, rejects without leaving it in the table', async () => {
    const calls = new PendingCalls()
    await expect(
      calls.start(() => {
        throw new Error('EPIPE')
      }, 2_000)
    ).rejects.toThrow('EPIPE')
    expect(calls.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
