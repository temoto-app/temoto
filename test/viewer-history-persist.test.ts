// @vitest-environment jsdom
/**
 * TODO 772 (wave 36 bundle B): keeps the viewer's '← →' history per conversation (renderer side).
 *
 * - pure functions: `toSnapshot` / `fromSnapshot` / `adoptStored` / `ViewerHistoryWriter` (writes are coalesced over 300 ms, and the same content is not sent).
 * - wiring: `hydrateViewerHistory` reads back from main and puts it into `useStore.viewerHistories`. Reading back opens neither a URL nor a file.
 *
 * `window.aios` is a fake. Neither the model nor main is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_HISTORY,
  VIEWER_HISTORY_WRITE_DEBOUNCE_MS,
  ViewerHistoryWriter,
  adoptStored,
  fromSnapshot,
  historySignature,
  recordVisit,
  stepHistory,
  toSnapshot,
  type ViewerHistory
} from '../src/renderer/src/viewer-history.js'
import type { ViewerHistorySnapshot } from '../src/shared/viewer-history.js'

const visit = (history: ViewerHistory, uri: string, highlight: string | null = null): ViewerHistory =>
  recordVisit(history, { uri, highlight, now: 0, byKeys: false })

const stored: ViewerHistorySnapshot = {
  entries: [
    { uri: 'file:///a', highlight: null },
    { uri: 'https://example.com/', highlight: null },
    { uri: 'file:///b', highlight: 'q' }
  ],
  index: 1
}

describe('toSnapshot / fromSnapshot', () => {
  it('往復しても同じ。読み戻した歩は 1 秒のまとめの対象にならない', () => {
    const history = fromSnapshot(stored)
    expect(history.index).toBe(1)
    expect(history.entries.every((entry) => !entry.byKeys && entry.at === 0)).toBe(true)
    expect(toSnapshot(history)).toEqual(stored)
  })

  it('空の保存は index -1', () => {
    expect(fromSnapshot({ entries: [], index: 0 })).toEqual({ entries: [], index: -1 })
  })

  it('読み戻した履歴で戻る / 進むができる (アプリを閉じたあとの復元)', () => {
    const history = fromSnapshot(stored)
    expect(stepHistory(history, 'https://example.com/', 'back')?.entry.uri).toBe('file:///a')
    expect(stepHistory(history, 'https://example.com/', 'forward')?.entry.uri).toBe('file:///b')
  })
})

describe('adoptStored', () => {
  it('保存が無ければ null (いまのまま)', () => {
    expect(adoptStored(EMPTY_HISTORY, null)).toBeNull()
    expect(adoptStored(EMPTY_HISTORY, { entries: [], index: -1 })).toBeNull()
  })

  it('いまの履歴が空なら保存をそのまま採る', () => {
    expect(toSnapshot(adoptStored(EMPTY_HISTORY, stored) as ViewerHistory)).toEqual(stored)
  })

  it('記憶の復元が積んだ 1 歩が保存の「いまの歩」と同じ URI なら、歩は増えず位置も保つ', () => {
    const current = visit(EMPTY_HISTORY, 'https://example.com/')
    expect(toSnapshot(adoptStored(current, stored) as ViewerHistory)).toEqual(stored)
  })

  it('1 歩が保存のいまの歩と違う URI なら、新しく開いたものとして積む (先の歩は捨てる)', () => {
    const current = visit(EMPTY_HISTORY, 'file:///c')
    const out = adoptStored(current, stored) as ViewerHistory
    expect(out.entries.map((entry) => entry.uri)).toEqual(['file:///a', 'https://example.com/', 'file:///c'])
    expect(out.index).toBe(2)
  })

  it('読み戻しを待つ間に 2 歩以上動いていれば、いまのものが勝つ (null)', () => {
    const current = visit(visit(EMPTY_HISTORY, 'file:///x'), 'file:///y')
    expect(adoptStored(current, stored)).toBeNull()
  })
})

describe('ViewerHistoryWriter', () => {
  let timers: Map<number, () => void>
  let next: number
  let sent: { threadId: string; snapshot: ViewerHistorySnapshot }[]
  let writer: ViewerHistoryWriter

  beforeEach(() => {
    timers = new Map()
    next = 1
    sent = []
    writer = new ViewerHistoryWriter({
      send: async (threadId, snapshot) => {
        sent.push({ threadId, snapshot })
      },
      setTimer: (fn, ms) => {
        expect(ms).toBe(VIEWER_HISTORY_WRITE_DEBOUNCE_MS)
        const id = next++
        timers.set(id, fn)
        return id
      },
      clearTimer: (handle) => {
        timers.delete(handle as number)
      }
    })
  })

  const fire = (): void => {
    const pending = [...timers.values()]
    timers.clear()
    for (const fn of pending) fn()
  }

  it('連続した変化は最後の 1 回だけ送る', () => {
    let history = visit(EMPTY_HISTORY, 'file:///a')
    writer.schedule('t1', () => history)
    history = visit(history, 'file:///b')
    writer.schedule('t1', () => history)
    history = visit(history, 'file:///c')
    writer.schedule('t1', () => history)
    expect(timers.size).toBe(1)
    fire()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.snapshot.entries.map((entry) => entry.uri)).toEqual(['file:///a', 'file:///b', 'file:///c'])
  })

  it('読み戻した内容 (markSynced) と同じなら送らない。変われば送る', () => {
    const history = fromSnapshot(stored)
    writer.markSynced('t1', history)
    writer.schedule('t1', () => history)
    fire()
    expect(sent).toEqual([])
    const moved = { entries: history.entries, index: 0 }
    writer.schedule('t1', () => moved)
    fire()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.snapshot.index).toBe(0)
  })

  it('flushAll は間引きを待たずに全部送る。会話ごとに別', () => {
    writer.schedule('t1', () => visit(EMPTY_HISTORY, 'file:///a'))
    writer.schedule('t2', () => visit(EMPTY_HISTORY, 'file:///b'))
    writer.flushAll()
    expect(sent.map((entry) => entry.threadId).sort()).toEqual(['t1', 't2'])
    expect(timers.size).toBe(0)
  })

  it('送れなかったときは印を外し、次の変化で同じ内容でも送り直す', async () => {
    let fail = true
    const calls: string[] = []
    const flaky = new ViewerHistoryWriter({
      send: async (threadId) => {
        calls.push(threadId)
        if (fail) throw new Error('ipc')
      },
      setTimer: () => 0,
      clearTimer: () => undefined
    })
    const history = visit(EMPTY_HISTORY, 'file:///a')
    flaky.schedule('t1', () => history)
    flaky.flush('t1')
    await Promise.resolve()
    await Promise.resolve()
    fail = false
    flaky.schedule('t1', () => history)
    flaky.flush('t1')
    expect(calls).toEqual(['t1', 't1'])
  })

  it('historySignature は at / byKeys を見ない', () => {
    const a: ViewerHistory = { entries: [{ uri: 'file:///a', highlight: null, at: 1, byKeys: true }], index: 0 }
    const b: ViewerHistory = { entries: [{ uri: 'file:///a', highlight: null, at: 9, byKeys: false }], index: 0 }
    expect(historySignature(a)).toBe(historySignature(b))
  })
})

describe('hydrateViewerHistory', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function setup(response: ViewerHistorySnapshot | null | 'reject'): Promise<{
    mod: typeof import('../src/renderer/src/viewerHistory.js')
    store: typeof import('../src/renderer/src/store.js')
    viewerHistory: ReturnType<typeof vi.fn>
    setViewerHistory: ReturnType<typeof vi.fn>
    select: ReturnType<typeof vi.fn>
  }> {
    const viewerHistory = vi.fn(async () => {
      if (response === 'reject') throw new Error('boom')
      return response
    })
    const setViewerHistory = vi.fn(async () => undefined)
    ;(window as unknown as { aios: unknown }).aios = { threads: { viewerHistory, setViewerHistory } }
    const store = await import('../src/renderer/src/store.js')
    const mod = await import('../src/renderer/src/viewerHistory.js')
    const select = vi.fn()
    store.useStore.setState({ viewerHistories: {}, select } as never)
    return { mod, store, viewerHistory, setViewerHistory, select }
  }

  it('保存を読み戻して store に入れる。ファイルも URL も開かない (select しない)', async () => {
    const { mod, store, viewerHistory, select } = await setup(stored)
    await mod.hydrateViewerHistory('t1')
    expect(viewerHistory).toHaveBeenCalledWith('t1')
    expect(toSnapshot(store.useStore.getState().viewerHistories['t1'] as ViewerHistory)).toEqual(stored)
    expect(select).not.toHaveBeenCalled()
  })

  it('同じ会話は 1 回しか読まない', async () => {
    const { mod, viewerHistory } = await setup(stored)
    await mod.hydrateViewerHistory('t1')
    await mod.hydrateViewerHistory('t1')
    expect(viewerHistory).toHaveBeenCalledTimes(1)
  })

  it('読み戻しが失敗したら次に開いたとき読み直して、保存済みを採る (失敗を「読み済み」にしない)', async () => {
    const { mod, store, viewerHistory, setViewerHistory } = await setup('reject')
    await mod.hydrateViewerHistory('t1')
    expect(store.useStore.getState().viewerHistories['t1']).toBeUndefined()
    // If it fails, nothing is written back (no write that would destroy the saved history appears)
    expect(setViewerHistory).not.toHaveBeenCalled()
    viewerHistory.mockImplementation(async () => stored)
    await mod.hydrateViewerHistory('t1')
    expect(viewerHistory).toHaveBeenCalledTimes(2)
    expect(toSnapshot(store.useStore.getState().viewerHistories['t1'] as ViewerHistory)).toEqual(stored)
  })

  it('保存が無い・読めない (reject) ときは何も入れず、投げない', async () => {
    for (const response of [null, 'reject'] as const) {
      const { mod, store } = await setup(response)
      await expect(mod.hydrateViewerHistory('t1')).resolves.toBeUndefined()
      expect(store.useStore.getState().viewerHistories['t1']).toBeUndefined()
    }
  })
})
