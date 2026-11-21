/**
 * How the renderer holds the thread list (item 75, `src/renderer/src/thread-index.ts`). Pure functions.
 *
 * What is guarded:
 * - Rows and orders that did not change remain **the same object** (Zustand's selectors decide re-rendering by reference, so if this breaks, one update redraws every row).
 * - A row where only `runtime` changed reuses `thread` (the ThreadPane heading is not re-rendered).
 * - A row whose sort key (`threadRecency` = the last event, item 83) changed moves to its position in newest-first order. If only `updatedAt` (the time the row was touched) changes, the order does not change.
 */
import { describe, expect, it } from 'vitest'
import type { Thread, ThreadRuntime, ThreadSummary } from '../src/shared/thread.js'
import {
  EMPTY_THREAD_INDEX,
  applyThreadChange,
  indexFromList
} from '../src/renderer/src/thread-index.js'

/** `recency` is the time of the last event (the sort key of the list). */
function summary(
  id: string,
  recency: number,
  patch: { title?: string; costUsd?: number; updatedAt?: number; preview?: string | null } = {}
): ThreadSummary {
  const thread = {
    id,
    title: patch.title ?? id,
    createdAt: 0,
    updatedAt: patch.updatedAt ?? 0,
    lastEventAt: recency,
    allowedDirUris: []
  } as unknown as Thread
  const runtime = { threadId: id, state: 'idle', costUsd: patch.costUsd ?? 0 } as unknown as ThreadRuntime
  return { thread, runtime, preview: patch.preview ?? null }
}

describe('indexFromList', () => {
  it('並びは届いた順、行は id で引ける', () => {
    const index = indexFromList([summary('b', 2), summary('a', 1)])
    expect(index.order).toEqual(['b', 'a'])
    expect(index.byId['a']?.thread.id).toBe('a')
  })

  it('中身が同じ全件をもう一度受けても、同じ索引を返す (IPC で届く値は毎回新しい)', () => {
    const first = indexFromList([summary('b', 2), summary('a', 1)])
    const again = indexFromList([summary('b', 2), summary('a', 1)], first)
    expect(again).toBe(first)
  })

  it('1 行だけ違えば、他の行は使い回す', () => {
    const first = indexFromList([summary('b', 2), summary('a', 1)])
    const next = indexFromList([summary('b', 2, { title: '改名' }), summary('a', 1)], first)
    expect(next).not.toBe(first)
    expect(next.byId['a']).toBe(first.byId['a'])
    expect(next.byId['b']?.thread.title).toBe('改名')
    expect(next.order).toBe(first.order)
  })

  it('消えた行は落ちる', () => {
    const first = indexFromList([summary('b', 2), summary('a', 1)])
    const next = indexFromList([summary('a', 1)], first)
    expect(next.order).toEqual(['a'])
    expect(next.byId['b']).toBeUndefined()
  })
})

describe('applyThreadChange', () => {
  const base = indexFromList([summary('c', 3), summary('b', 2), summary('a', 1)])

  it('同じ中身なら索引ごと同じ (購読者に通知しない)', () => {
    expect(applyThreadChange(base, summary('b', 2))).toBe(base)
  })

  it('runtime だけ変わったら thread は使い回し、並びも変えない', () => {
    const next = applyThreadChange(base, summary('b', 2, { costUsd: 0.5 }))
    expect(next.byId['b']?.runtime.costUsd).toBe(0.5)
    expect(next.byId['b']?.thread).toBe(base.byId['b']?.thread)
    expect(next.byId['a']).toBe(base.byId['a'])
    expect(next.order).toBe(base.order)
  })

  it('preview だけ変わっても行は差し替わる', () => {
    const next = applyThreadChange(base, summary('b', 2, { preview: '新しい発言' }))
    expect(next.byId['b']?.preview).toBe('新しい発言')
    expect(next.byId['b']?.thread).toBe(base.byId['b']?.thread)
  })

  it('最後の出来事が動いたら新しい順の位置へ移る', () => {
    expect(applyThreadChange(base, summary('a', 10)).order).toEqual(['a', 'c', 'b'])
    // At the same time, the row that was touched comes first.
    expect(applyThreadChange(base, summary('a', 3)).order).toEqual(['a', 'c', 'b'])
    expect(applyThreadChange(base, summary('c', 0)).order).toEqual(['b', 'a', 'c'])
  })

  it('知らない行は並びに差し込む (別の窓で作られた等)', () => {
    const next = applyThreadChange(base, summary('d', 2.5))
    expect(next.order).toEqual(['c', 'd', 'b', 'a'])
  })

  it('updatedAt だけが動いても並びは変わらない (既読・設定の変更で先頭へ跳ねない — 項目 83)', () => {
    const next = applyThreadChange(base, summary('a', 1, { updatedAt: 99 }))
    expect(next.byId['a']?.thread.updatedAt).toBe(99)
    expect(next.order).toBe(base.order)
  })

  it('出来事の無いスレッドは作成時刻で並ぶ', () => {
    const fresh = {
      ...summary('d', 0),
      thread: { ...summary('d', 0).thread, lastEventAt: null, createdAt: 2.5 }
    } as ThreadSummary
    expect(applyThreadChange(base, fresh).order).toEqual(['c', 'd', 'b', 'a'])
  })

  it('空の索引にも入る', () => {
    const next = applyThreadChange(EMPTY_THREAD_INDEX, summary('a', 1))
    expect(next.order).toEqual(['a'])
  })

  it('費用だけ動いても、予約 (項目 94) の中身が同じなら同じ配列を使い回す (チップを描き直さない)', () => {
    const withQueue = (costUsd: number, previews: string[]): ThreadSummary => {
      const row = summary('a', 1, { costUsd })
      const reservations = previews.map((preview, i) => ({
        id: `r${i}`,
        preview,
        attachments: 0,
        interrupt: false,
        createdAt: 1
      }))
      return { ...row, runtime: { ...row.runtime, reservations } }
    }
    const first = applyThreadChange(base, withQueue(0, ['x']))
    const costOnly = applyThreadChange(first, withQueue(0.5, ['x']))
    expect(costOnly.byId['a']?.runtime).not.toBe(first.byId['a']?.runtime)
    expect(costOnly.byId['a']?.runtime.reservations).toBe(first.byId['a']?.runtime.reservations)
    const changed = applyThreadChange(costOnly, withQueue(0.5, ['x', 'y']))
    expect(changed.byId['a']?.runtime.reservations.map((r) => r.preview)).toEqual(['x', 'y'])
  })
})
