/**
 * TODO 606 (wave 29 bundle B): the unsaved viewer drafts when a window is closed or the app quits, the renderer side's queueing and writing out
 * (`src/renderer/src/viewer-drafts-close.ts`). Tested directly, without depending on electron or React. Does not call the model.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  flushDrafts,
  installViewerDraftsClose,
  listDrafts,
  registerPaneSaver,
  settleInFlightSaves,
  trackSave,
  type DraftsCloseDeps,
  type PaneSaver
} from '../src/renderer/src/viewer-drafts-close.js'
import type { DraftTable } from '../src/renderer/src/viewer-drafts.js'
import type { TextWriteResult } from '../src/shared/types.js'
import type { ViewerDraftsReply, ViewerDraftsRequest } from '../src/shared/viewer-drafts-close.js'

const A = 'file:///w/a.ts'
const B = 'file:///w/b.ts'
const C = 'file:///w/c.ts'

const ok = (mtimeMs = 500): TextWriteResult => ({ ok: true, mtimeMs, size: 1, reason: null })
const refused = (reason: TextWriteResult['reason']): TextWriteResult => ({ ok: false, mtimeMs: 0, size: 0, reason })

function harness(initial: DraftTable, over: Partial<DraftsCloseDeps> = {}) {
  let table: DraftTable = initial
  const opened: string[] = []
  const closed: string[] = []
  const write = vi.fn<DraftsCloseDeps['write']>(async () => ok())
  const deps: DraftsCloseDeps = {
    table: () => table,
    conflictUri: () => null,
    forget: (uri, text) => {
      if (table[uri]?.text !== text) return
      const next = { ...table }
      delete next[uri]
      table = next
    },
    pane: () => null,
    open: async (uri) => {
      opened.push(uri)
      return { pluginId: 'aios.text', url: 'aios-plugin://aios.text/index.html', editable: true } as never
    },
    write,
    close: (_pluginId, uri) => {
      closed.push(uri)
    },
    ...over
  }
  return {
    deps,
    write,
    opened,
    closed,
    get table() {
      return table
    }
  }
}

describe('listDrafts (TODO 606)', () => {
  it('表の URI を並べる (本文は返さない)。衝突の帯のファイルには印', () => {
    const h = harness(
      { [A]: { text: 'a', baseMtimeMs: 1 }, [B]: { text: 'b', baseMtimeMs: 2 } },
      { conflictUri: () => B }
    )
    expect(listDrafts(h.deps)).toEqual({
      unsaved: [
        { uri: A, conflict: false },
        { uri: B, conflict: true }
      ]
    })
  })

  it('出しているファイルの下書きが表にまだ写っていなければ足す', () => {
    const pane: PaneSaver = { uri: () => C, dirty: () => true, save: async () => 'saved' }
    const h = harness({ [A]: { text: 'a', baseMtimeMs: 1 } }, { pane: () => pane })
    expect(listDrafts(h.deps).unsaved.map((entry) => entry.uri)).toEqual([A, C])
  })
})

describe('flushDrafts (TODO 606)', () => {
  it('離れたファイルは open → 土台の mtime で write → close。書けたら表から消す', async () => {
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 }, [B]: { text: 'b2', baseMtimeMs: 20 } })
    expect(await flushDrafts(h.deps)).toEqual({ unsaved: [] })
    expect(h.write.mock.calls).toEqual([
      ['aios.text', A, 'a2', 10],
      ['aios.text', B, 'b2', 20]
    ])
    expect(h.opened).toEqual([A, B])
    expect(h.closed).toEqual([A, B])
    expect(h.table).toEqual({})
  })

  it('衝突 (ディスク側が変わっていた) と書けないものは残して返す。表にも残る', async () => {
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 }, [B]: { text: 'b2', baseMtimeMs: 20 } })
    h.write.mockImplementation(async (_p, uri) => (uri === A ? refused('conflict') : refused('io')))
    expect(await flushDrafts(h.deps)).toEqual({
      unsaved: [
        { uri: A, conflict: true },
        { uri: B, conflict: false }
      ]
    })
    expect(Object.keys(h.table)).toEqual([A, B])
    expect(h.closed).toEqual([A, B])
  })

  it('衝突の帯が出ているファイルは書きにいかない', async () => {
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } }, { conflictUri: () => A })
    expect(await flushDrafts(h.deps)).toEqual({ unsaved: [{ uri: A, conflict: true }] })
    expect(h.write).not.toHaveBeenCalled()
  })

  it('viewer が開けない (除外・拡張が無い) なら書けなかったとして返す', async () => {
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } }, { open: async () => null })
    expect(await flushDrafts(h.deps)).toEqual({ unsaved: [{ uri: A, conflict: false }] })
  })

  it('出しているファイルは ViewerPane に保存させ、表から二重に書かない', async () => {
    const save = vi.fn(async () => 'saved' as const)
    const pane: PaneSaver = { uri: () => A, dirty: () => true, save }
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 }, [B]: { text: 'b2', baseMtimeMs: 20 } }, { pane: () => pane })
    expect(await flushDrafts(h.deps)).toEqual({ unsaved: [] })
    expect(save).toHaveBeenCalledTimes(1)
    expect(h.write.mock.calls.map((call) => call[1])).toEqual([B])
  })

  it('ViewerPane が衝突・失敗と答えたら残す。skip (中身が揃っていない) なら表から書く', async () => {
    const conflict: PaneSaver = { uri: () => A, dirty: () => true, save: async () => 'conflict' }
    const h1 = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } }, { pane: () => conflict })
    expect(await flushDrafts(h1.deps)).toEqual({ unsaved: [{ uri: A, conflict: true }] })
    expect(h1.write).not.toHaveBeenCalled()

    const skip: PaneSaver = { uri: () => A, dirty: () => true, save: async () => 'skip' }
    const h2 = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } }, { pane: () => skip })
    expect(await flushDrafts(h2.deps)).toEqual({ unsaved: [] })
    expect(h2.write.mock.calls.map((call) => call[1])).toEqual([A])
  })

  it('書き込みの最中 (自動保存・裏の保存) が終わるのを待ってから始める', async () => {
    let release: (value: TextWriteResult) => void = () => undefined
    const pending = trackSave(new Promise<TextWriteResult>((resolve) => (release = resolve)))
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } })
    const flushing = flushDrafts(h.deps)
    await Promise.resolve()
    expect(h.write).not.toHaveBeenCalled()
    release(ok())
    await pending
    await flushing
    expect(h.write).toHaveBeenCalledTimes(1)
    await settleInFlightSaves()
  })

  it('registerPaneSaver の外しは、後から登録したものを消さない', () => {
    const first: PaneSaver = { uri: () => A, dirty: () => false, save: async () => 'skip' }
    const second: PaneSaver = { uri: () => B, dirty: () => false, save: async () => 'skip' }
    const off1 = registerPaneSaver(first)
    const off2 = registerPaneSaver(second)
    off1()
    off2()
  })
})

describe('installViewerDraftsClose (TODO 606)', () => {
  it('頼みに番号付きで答える。口が無ければ何もしない', async () => {
    let listener: ((request: ViewerDraftsRequest) => void) | null = null
    const replies: Array<[number, ViewerDraftsReply]> = []
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } })
    installViewerDraftsClose(
      {
        onDraftsRequest: (l) => {
          listener = l
        },
        replyDrafts: async (id, reply) => {
          replies.push([id, reply])
        }
      },
      h.deps
    )
    listener!({ id: 1, action: 'list' })
    listener!({ id: 2, action: 'save' })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies).toContainEqual([1, { unsaved: [{ uri: A, conflict: false }] }])
    expect(replies).toContainEqual([2, { unsaved: [] }])
    expect(() => installViewerDraftsClose(undefined, h.deps)).not.toThrow()
    expect(() => installViewerDraftsClose({}, h.deps)).not.toThrow()
  })

  it('code-review: save は書き始める前に「受け取った」(書きにいく下書きの並び) を返す。list には返さない', async () => {
    let listener: ((request: ViewerDraftsRequest) => void) | null = null
    const order: string[] = []
    const acks: Array<[number, ViewerDraftsReply]> = []
    const h = harness({ [A]: { text: 'a2', baseMtimeMs: 10 } })
    installViewerDraftsClose(
      {
        onDraftsRequest: (l) => {
          listener = l
        },
        replyDrafts: async (id) => {
          order.push(`reply ${id}`)
        },
        ackDrafts: async (id, pending) => {
          order.push(`ack ${id}`)
          acks.push([id, pending])
        }
      },
      h.deps
    )
    listener!({ id: 1, action: 'list' })
    listener!({ id: 2, action: 'save' })
    await vi.waitFor(() => expect(order.filter((o) => o.startsWith('reply'))).toHaveLength(2))
    expect(acks).toEqual([[2, { unsaved: [{ uri: A, conflict: false }] }]])
    expect(order.indexOf('ack 2')).toBeLessThan(order.indexOf('reply 2'))
  })
})
