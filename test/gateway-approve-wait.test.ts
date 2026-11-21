/**
 * How the gateway waits for `approve` (TODO 632, ARCHITECTURE 7.6.5, `src/gateway/approve-wait.ts`).
 *
 * It assumes the MCP SDK behavior confirmed in spike 29 (docs/notes/wave29.md, bundle G):
 * - the peer's `notifications/cancelled` arrives as `abort(params.reason)` (reason is a string)
 * - when the transport closes, a plain `abort()` with no argument (reason is a DOMException)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROGRESS_INTERVAL_MS,
  keepAlive,
  watchCancellation,
  type ProgressNotification
} from '../src/gateway/approve-wait.js'

afterEach(() => {
  vi.useRealTimers()
})

function progressExtra(
  token: string | number | undefined,
  controller = new AbortController()
): { extra: Parameters<typeof keepAlive>[0]; sent: ProgressNotification[]; controller: AbortController } {
  const sent: ProgressNotification[] = []
  const extra = {
    signal: controller.signal,
    ...(token === undefined ? {} : { _meta: { progressToken: token } }),
    sendNotification: async (notification: ProgressNotification): Promise<void> => {
      sent.push(notification)
    }
  }
  return { extra, sent, controller }
}

describe('keepAlive (TODO 632)', () => {
  it('progressToken があれば 60 秒ごとに増える progress を送り、止めたら送らない', () => {
    vi.useFakeTimers()
    const { extra, sent } = progressExtra(7)
    const stop = keepAlive(extra)
    expect(PROGRESS_INTERVAL_MS).toBe(60_000)
    vi.advanceTimersByTime(59_999)
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(60_000)
    expect(sent.map((n) => n.params.progress)).toEqual([1, 2])
    expect(sent[0]).toMatchObject({ method: 'notifications/progress', params: { progressToken: 7 } })
    stop()
    stop()
    vi.advanceTimersByTime(600_000)
    expect(sent).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('progressToken が無ければ何も送らず、timer も張らない', () => {
    vi.useFakeTimers()
    const { extra, sent } = progressExtra(undefined)
    keepAlive(extra)
    vi.advanceTimersByTime(600_000)
    expect(sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取り消されたら自分で止まる', () => {
    vi.useFakeTimers()
    const { extra, sent, controller } = progressExtra('tok')
    keepAlive(extra)
    vi.advanceTimersByTime(60_000)
    controller.abort('SdkError: Request timed out')
    vi.advanceTimersByTime(600_000)
    expect(sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('送れなくても (transport が閉じた等) 投げない', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const stop = keepAlive({
      signal: controller.signal,
      _meta: { progressToken: 1 },
      sendNotification: async () => {
        throw new Error('Not connected')
      }
    })
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    stop()
  })
})

describe('watchCancellation (TODO 632)', () => {
  it('バックエンドの取り消し (reason が文字列) で 1 度だけ知らせる', () => {
    const controller = new AbortController()
    let calls = 0
    watchCancellation({ signal: controller.signal }, () => {
      calls += 1
    })
    controller.abort('SdkError: Request timed out')
    controller.abort('again')
    expect(calls).toBe(1)
  })

  it('transport が閉じた (引数なしの abort) ときは知らせない — main の session-exited に任せる', () => {
    const controller = new AbortController()
    let calls = 0
    watchCancellation({ signal: controller.signal }, () => {
      calls += 1
    })
    controller.abort()
    expect(calls).toBe(0)
  })

  it('外した後の取り消しは知らせない (答えが先に出た)', () => {
    const controller = new AbortController()
    let calls = 0
    const stop = watchCancellation({ signal: controller.signal }, () => {
      calls += 1
    })
    stop()
    controller.abort('late')
    expect(calls).toBe(0)
  })

  it('呼ばれた時点で取り消し済みならすぐ知らせる', () => {
    const controller = new AbortController()
    controller.abort('already')
    let calls = 0
    watchCancellation({ signal: controller.signal }, () => {
      calls += 1
    })
    expect(calls).toBe(1)
  })
})
