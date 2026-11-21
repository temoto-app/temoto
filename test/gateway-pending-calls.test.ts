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

  it('応答で解決し、表から消える', async () => {
    const calls = new PendingCalls()
    const sent: number[] = []
    const promise = calls.start((id) => sent.push(id))
    expect(calls.size).toBe(1)
    calls.settle(sent[0] ?? -1, undefined, { ok: 1 })
    await expect(promise).resolves.toEqual({ ok: 1 })
    expect(calls.size).toBe(0)
  })

  it('時間切れで表から消して reject する。後から届いた応答は捨てる', async () => {
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

  it('期限内に答えればタイマーは残らない', async () => {
    const calls = new PendingCalls()
    const sent: number[] = []
    const promise = calls.start((id) => sent.push(id), 2_000)
    calls.settle(sent[0] ?? -1, 'boom', undefined)
    await expect(promise).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('タイムアウトなしの呼び出しは時間が経っても残る (承認は何時間でも待つ)', () => {
    const calls = new PendingCalls()
    void calls.start(() => undefined).catch(() => undefined)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(calls.size).toBe(1)
  })

  it('切断で全部 reject し、タイマーも止める', async () => {
    const calls = new PendingCalls()
    const a = calls.start(() => undefined, 2_000).catch((err: Error) => err.message)
    const b = calls.start(() => undefined).catch((err: Error) => err.message)
    calls.failAll('aios main disconnected')
    expect(await a).toBe('aios main disconnected')
    expect(await b).toBe('aios main disconnected')
    expect(calls.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('書き込みが投げたら表に残さず reject する', async () => {
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
