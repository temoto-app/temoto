/**
 * TODO 606 (wave 29 bundle B): at quit or window close, the unsaved viewer drafts: main's decision (`settleViewerDrafts`), the matching of the requests
 * to the renderer (`ViewerDraftsRequests`), and inserting the native text. Does not call the model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listedNames,
  NO_PENDING_RELOAD_REQUEST,
  reloadOrDefer,
  reloadWithDrafts,
  ReloadPendingRequests,
  settleAllViewerDrafts,
  unsavedDialogKeys,
  settleViewerDrafts,
  shouldDropCloseDuringQuitSettle,
  ViewerDraftsRequests,
  MAX_LISTED_NAMES,
  VIEWER_DRAFTS_SAVE_TIMEOUT_MS,
  VIEWER_DRAFTS_TIMEOUT_MS,
  type ReloadGateDeps,
  type ViewerDraftsCloseDeps
} from '../src/main/viewer-drafts-close.js'
import { NATIVE_DICTIONARIES, nativeFormat } from '../src/main/i18n-native.js'
import { sanitizeViewerDraftsReply, type ViewerDraftsReply } from '../src/shared/viewer-drafts-close.js'
import type { AutoSaveMode } from '../src/shared/auto-save.js'

const A = 'file:///w/a.ts'
const B = 'file:///w/b.ts'

interface Over {
  readonly mode?: AutoSaveMode
  readonly hasDrafts?: (viewId: number) => boolean
  readonly ask?: unknown
  readonly confirmSave?: unknown
  readonly confirmUnsaved?: unknown
}

function deps(over: Over = {}): ViewerDraftsCloseDeps & {
  ask: ReturnType<typeof vi.fn>
  confirmSave: ReturnType<typeof vi.fn>
  confirmUnsaved: ReturnType<typeof vi.fn>
} {
  const { mode, ...rest } = over
  return {
    mode: () => mode ?? 'off',
    hasDrafts: () => true,
    ask: vi.fn(async (): Promise<ViewerDraftsReply | null> => ({ unsaved: [] })),
    confirmSave: vi.fn(async () => 'save' as const),
    confirmUnsaved: vi.fn(async () => 'cancel' as const),
    ...rest
  } as never
}

describe('settleViewerDrafts (TODO 606)', () => {
  it('下書きの無い窓には何も頼まず、すぐ閉じてよい', async () => {
    const d = deps({ hasDrafts: () => false })
    expect(await settleViewerDrafts(1, d)).toBe('proceed')
    expect(d.ask).not.toHaveBeenCalled()
  })

  it('自動保存 ON: 黙って書き切る (聞かない)', async () => {
    for (const mode of ['afterDelay', 'onFocusChange'] as const) {
      const d = deps({ mode })
      expect(await settleViewerDrafts(1, d)).toBe('proceed')
      expect(d.ask).toHaveBeenCalledWith(1, 'save')
      expect(d.ask).toHaveBeenCalledTimes(1)
      expect(d.confirmSave).not.toHaveBeenCalled()
      expect(d.confirmUnsaved).not.toHaveBeenCalled()
    }
  })

  it('自動保存 ON でも、書けずに残った (衝突) なら聞く。キャンセルなら閉じない・保存せずに閉じるなら閉じる', async () => {
    const left: ViewerDraftsReply = { unsaved: [{ uri: A, conflict: true }] }
    const cancel = deps({ mode: 'afterDelay', ask: vi.fn(async () => left) })
    expect(await settleViewerDrafts(1, cancel)).toBe('cancel')
    expect(cancel.confirmUnsaved).toHaveBeenCalledWith(1, left.unsaved)
    const discard = deps({ mode: 'afterDelay', ask: vi.fn(async () => left), confirmUnsaved: vi.fn(async () => 'discard') })
    expect(await settleViewerDrafts(1, discard)).toBe('proceed')
  })

  it('自動保存 OFF: 並べて「保存しますか」。保存 → 書き切る、保存しない → 閉じる、キャンセル → 閉じない', async () => {
    const listed: ViewerDraftsReply = { unsaved: [{ uri: A, conflict: false }, { uri: B, conflict: false }] }
    const ask = (): ReturnType<typeof vi.fn> =>
      vi.fn(async (_id: number, action: string) => (action === 'list' ? listed : { unsaved: [] }))

    const save = deps({ ask: ask() })
    expect(await settleViewerDrafts(1, save)).toBe('proceed')
    expect(save.confirmSave).toHaveBeenCalledWith(1, listed.unsaved)
    expect(save.ask.mock.calls.map((call) => call[1])).toEqual(['list', 'save'])

    const discard = deps({ ask: ask(), confirmSave: vi.fn(async () => 'discard') })
    expect(await settleViewerDrafts(1, discard)).toBe('proceed')
    expect(discard.ask.mock.calls.map((call) => call[1])).toEqual(['list'])

    const cancel = deps({ ask: ask(), confirmSave: vi.fn(async () => 'cancel') })
    expect(await settleViewerDrafts(1, cancel)).toBe('cancel')
    expect(cancel.ask.mock.calls.map((call) => call[1])).toEqual(['list'])
  })

  it('自動保存 OFF で「保存」を選んでも、書けずに残れば聞く', async () => {
    const d = deps({
      ask: vi.fn(async (_id: number, action: string) => ({ unsaved: [{ uri: A, conflict: action === 'save' }] }))
    })
    expect(await settleViewerDrafts(1, d)).toBe('cancel')
    expect(d.confirmUnsaved).toHaveBeenCalledWith(1, [{ uri: A, conflict: true }])
  })

  it('OFF で並べた結果が空 (件数の知らせの行き違い) なら聞かずに閉じる', async () => {
    const d = deps({ ask: vi.fn(async () => ({ unsaved: [] })) })
    expect(await settleViewerDrafts(1, d)).toBe('proceed')
    expect(d.confirmSave).not.toHaveBeenCalled()
  })

  it('renderer が返事をしない (null) なら閉じる — 窓が閉じられない方が困る', async () => {
    expect(await settleViewerDrafts(1, deps({ ask: vi.fn(async () => null) }))).toBe('proceed')
    expect(await settleViewerDrafts(1, deps({ mode: 'afterDelay', ask: vi.fn(async () => null) }))).toBe('proceed')
  })

  it('終了: 窓を順に片付け、1 枚でもキャンセルなら終了をやめる (それより後の窓には頼まない)', async () => {
    const d = deps({
      hasDrafts: (viewId) => viewId !== 2,
      ask: vi.fn(async () => ({ unsaved: [{ uri: A, conflict: false }] })),
      confirmSave: vi.fn(async (viewId: number) => (viewId === 3 ? 'cancel' : 'discard'))
    })
    expect(await settleAllViewerDrafts([1, 2, 3, 4], d)).toBe('cancel')
    expect(d.ask.mock.calls.map((call) => call[0])).toEqual([1, 3])
    const ok = deps({ confirmSave: vi.fn(async () => 'discard'), ask: vi.fn(async () => ({ unsaved: [{ uri: A, conflict: false }] })) })
    expect(await settleAllViewerDrafts([1, 2], ok)).toBe('proceed')
  })
})

describe('ViewerDraftsRequests (main → renderer の頼みと返事)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function target(id: number) {
    const sent: Array<{ channel: string; request: { id: number; action: string } }> = []
    return {
      sent,
      id,
      isDestroyed: () => false,
      send: (channel: string, request: { id: number; action: string }) => {
        sent.push({ channel, request })
      }
    }
  }

  it('送った窓からの、同じ番号の返事だけを受ける (返事は検め直す)', async () => {
    const requests = new ViewerDraftsRequests('ch')
    const t = target(7)
    const pending = requests.request(t, 'list')
    expect(t.sent).toEqual([{ channel: 'ch', request: { id: 1, action: 'list' } }])
    requests.reply(8, 1, { unsaved: [{ uri: A }] }) // Another window
    requests.reply(7, 2, { unsaved: [{ uri: A }] }) // Unknown number
    requests.reply(7, 1, { unsaved: [{ uri: A }, { uri: 3 }, null, { uri: B, conflict: true }] })
    expect(await pending).toEqual({ unsaved: [{ uri: A, conflict: false }, { uri: B, conflict: true }] })
  })

  it('時間切れ・窓が閉じた・窓が無いなら null', async () => {
    vi.useFakeTimers()
    const requests = new ViewerDraftsRequests('ch', 100)
    const late = requests.request(target(1), 'save')
    vi.advanceTimersByTime(100)
    expect(await late).toBeNull()
    const closed = requests.request(target(2), 'save')
    requests.forget(2)
    expect(await closed).toBeNull()
    expect(await requests.request(null, 'list')).toBeNull()
    expect(await requests.request({ ...target(3), isDestroyed: () => true }, 'list')).toBeNull()
  })

  it('code-review: save を受け取った窓は、上限 (短い方) を過ぎても書き終わりを待ち、返事を受ける', async () => {
    vi.useFakeTimers()
    const requests = new ViewerDraftsRequests('ch', 100, 1000)
    const t = target(5)
    let settled: ViewerDraftsReply | null | undefined
    void requests.request(t, 'save').then((reply) => {
      settled = reply
    })
    requests.ack(6, 1, { unsaved: [{ uri: A }] }) // An acknowledgement from another window has no effect
    requests.ack(5, 1, { unsaved: [{ uri: A }] })
    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBeUndefined()
    requests.reply(5, 1, { unsaved: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toEqual({ unsaved: [] })
  })

  it('code-review: 受け取った後に長い上限も過ぎたら、受け取りに並んだ下書きを「書けずに残った」として返す', async () => {
    vi.useFakeTimers()
    const requests = new ViewerDraftsRequests('ch', 100, 1000)
    const late = requests.request(target(5), 'save')
    await vi.advanceTimersByTimeAsync(50)
    requests.ack(5, 1, { unsaved: [{ uri: A }, { uri: B, conflict: true }] })
    // The long limit is counted from the time it was requested (50 + 950)
    await vi.advanceTimersByTimeAsync(949)
    await vi.advanceTimersByTimeAsync(1)
    expect(await late).toEqual({ unsaved: [{ uri: A, conflict: false }, { uri: B, conflict: true }] })
    // A late reply is discarded
    expect(() => requests.reply(5, 1, { unsaved: [] })).not.toThrow()
  })

  it('code-review: 形の違う受け取りは受け取りとして扱わない (短い上限で null)', async () => {
    vi.useFakeTimers()
    const requests = new ViewerDraftsRequests('ch', 100, 1000)
    const late = requests.request(target(5), 'save')
    requests.ack(5, 1, 'nope')
    await vi.advanceTimersByTimeAsync(100)
    expect(await late).toBeNull()
  })

  it('code-review: 書き終わらなかった下書きは「保存できませんでした」に回る (黙って閉じない)', async () => {
    const d = deps({
      mode: 'afterDelay',
      ask: vi.fn(async (): Promise<ViewerDraftsReply | null> => ({ unsaved: [{ uri: A, conflict: false }] }))
    })
    expect(await settleViewerDrafts(1, d)).toBe('cancel')
    expect(d.confirmUnsaved).toHaveBeenCalledWith(1, [{ uri: A, conflict: false }])
  })

  it('長い上限は shutdownWithin (30 秒) の内側', () => {
    expect(VIEWER_DRAFTS_SAVE_TIMEOUT_MS).toBeLessThan(30_000)
    expect(VIEWER_DRAFTS_SAVE_TIMEOUT_MS).toBeGreaterThan(VIEWER_DRAFTS_TIMEOUT_MS)
  })

  it('形の違う返事は null', () => {
    expect(sanitizeViewerDraftsReply(null)).toBeNull()
    expect(sanitizeViewerDraftsReply({ unsaved: 'x' })).toBeNull()
    expect(sanitizeViewerDraftsReply({ unsaved: [] })).toEqual({ unsaved: [] })
  })
})

describe('ダイアログの文言 (TODO 606)', () => {
  it('名前と件数を差し込む。並べる名前は上限まで、残りは件数', () => {
    expect(nativeFormat('ja', 'dialog.saveDrafts.one', { name: 'a.ts' })).toBe('「a.ts」への変更を保存しますか?')
    expect(nativeFormat('en', 'dialog.saveDrafts.many', { count: 3 })).toBe(
      'Do you want to save the changes to the following 3 files?'
    )
    expect(nativeFormat('en', 'dialog.more', {})).toBe('and {count} more')
    const entries = Array.from({ length: MAX_LISTED_NAMES + 2 }, (_, i) => ({ uri: `file:///w/f${i}.ts`, conflict: false }))
    const listed = listedNames(entries, (uri) => uri.slice(uri.lastIndexOf('/') + 1))
    expect(listed.names).toHaveLength(MAX_LISTED_NAMES)
    expect(listed.names[0]).toBe('f0.ts')
    expect(listed.more).toBe(2)
  })
})

describe('reloadWithDrafts (TODO 636: 窓の再読み込みの前の下書き)', () => {
  function gate(over: Partial<ReloadGateDeps> = {}): ReloadGateDeps & {
    reload: ReturnType<typeof vi.fn>
    settle: ReturnType<typeof vi.fn>
    dropPending: ReturnType<typeof vi.fn>
    busyLog: boolean[]
  } {
    const busyLog: boolean[] = []
    return {
      isGone: () => false,
      isCrashed: () => false,
      isBusy: () => false,
      needsSettle: () => true,
      setBusy: (busy: boolean) => {
        busyLog.push(busy)
      },
      settle: vi.fn(async () => 'proceed' as const),
      quitting: () => false,
      reload: vi.fn(),
      dropPending: vi.fn(),
      busyLog,
      ...over
    } as never
  }

  it('下書きの無い窓は片付けずにすぐ読み直す (種類はそのまま)', async () => {
    const g = gate({ needsSettle: () => false })
    expect(await reloadWithDrafts('ignoreCache', g)).toBe('reloaded')
    expect(g.settle).not.toHaveBeenCalled()
    expect(g.reload).toHaveBeenCalledWith('ignoreCache')
    expect(g.busyLog).toEqual([])
  })

  it('renderer が落ちた窓は下書きが既に無いので、件数の知らせが残っていても片付けずに読み直す', async () => {
    const g = gate({ isCrashed: () => true })
    expect(await reloadWithDrafts('normal', g)).toBe('reloaded')
    expect(g.settle).not.toHaveBeenCalled()
    expect(g.reload).toHaveBeenCalledWith('normal')
  })

  it('下書きがあれば先に片付け (その間は片付けの最中の印)、済めば読み直す', async () => {
    const order: string[] = []
    const g = gate({
      settle: vi.fn(async () => {
        order.push('settle')
        return 'proceed' as const
      }),
      reload: vi.fn(() => {
        order.push('reload')
      })
    })
    expect(await reloadWithDrafts('normal', g)).toBe('reloaded')
    expect(order).toEqual(['settle', 'reload'])
    expect(g.busyLog).toEqual([true, false])
  })

  it('キャンセルなら読み直さない (下書きは残る)', async () => {
    const g = gate({ settle: vi.fn(async () => 'cancel' as const) })
    expect(await reloadWithDrafts('normal', g)).toBe('cancelled')
    expect(g.reload).not.toHaveBeenCalled()
    expect(g.busyLog).toEqual([true, false])
  })

  it('片付けそのものが投げたら読み直さない (下書きを捨てる方に倒さない)。印は下ろす', async () => {
    const g = gate({ settle: vi.fn(async () => Promise.reject(new Error('boom'))) })
    expect(await reloadWithDrafts('normal', g)).toBe('cancelled')
    expect(g.reload).not.toHaveBeenCalled()
    expect(g.busyLog).toEqual([true, false])
  })

  it('閉じる・終了・別の再読み込みの片付けの最中は何もしない (ダイアログを重ねない)', async () => {
    const g = gate({ isBusy: () => true })
    expect(await reloadWithDrafts('normal', g)).toBe('busy')
    expect(g.settle).not.toHaveBeenCalled()
    expect(g.reload).not.toHaveBeenCalled()
  })

  it('窓が無い・終了処理に入った後は読み直さない (片付けの間に変わった場合も)', async () => {
    expect(await reloadWithDrafts('normal', gate({ isGone: () => true }))).toBe('gone')
    expect(await reloadWithDrafts('normal', gate({ quitting: () => true }))).toBe('gone')
    let closed = false
    const g = gate({
      isGone: () => closed,
      settle: vi.fn(async () => {
        closed = true
        return 'proceed' as const
      })
    })
    expect(await reloadWithDrafts('normal', g)).toBe('gone')
    expect(g.reload).not.toHaveBeenCalled()
  })

  it('TODO 1125: キャンセル・片付けの失敗・片付けの間に窓が閉じたら、覚えた ⌘Q / ⌘W を捨てる。読み直すときは捨てない', async () => {
    const cancelled = gate({ settle: vi.fn(async () => 'cancel' as const) })
    expect(await reloadWithDrafts('normal', cancelled)).toBe('cancelled')
    expect(cancelled.dropPending).toHaveBeenCalledTimes(1)

    const failed = gate({ settle: vi.fn(async () => Promise.reject(new Error('boom'))) })
    expect(await reloadWithDrafts('normal', failed)).toBe('cancelled')
    expect(failed.dropPending).toHaveBeenCalledTimes(1)

    let closed = false
    const gone = gate({
      isGone: () => closed,
      settle: vi.fn(async () => {
        closed = true
        return 'proceed' as const
      })
    })
    expect(await reloadWithDrafts('normal', gone)).toBe('gone')
    expect(gone.dropPending).toHaveBeenCalledTimes(1)

    // Re-read (the remembered requests are used by `reloadOrDefer` inside `reload`). Not discarded if it does not go on to cleanup
    const proceeded = gate()
    expect(await reloadWithDrafts('normal', proceeded)).toBe('reloaded')
    expect(proceeded.dropPending).not.toHaveBeenCalled()
    const busy = gate({ isBusy: () => true })
    expect(await reloadWithDrafts('normal', busy)).toBe('busy')
    expect(busy.dropPending).not.toHaveBeenCalled()
    const goneBefore = gate({ isGone: () => true })
    expect(await reloadWithDrafts('normal', goneBefore)).toBe('gone')
    expect(goneBefore.dropPending).not.toHaveBeenCalled()
  })

  it('TODO 1125: キャンセルで捨てた後の、下書きの無い窓の再読み込みは終了・閉じるに化けない', async () => {
    // Flag and entry point in the same form as `reloadWindow` in index.ts
    let pendingQuit = false
    let pendingClose = false
    const actions: string[] = []
    const wire = (over: Partial<ReloadGateDeps>): ReloadGateDeps =>
      gate({
        dropPending: vi.fn(() => {
          pendingQuit = false
          pendingClose = false
        }),
        reload: vi.fn(() => {
          actions.push(reloadOrDefer({ quit: pendingQuit, close: pendingClose }))
        }),
        ...over
      })
    // While the 'save?' prompt is up, ⌘Q and ⌘W arrive (before-quit / close set the flag), and the user cancels
    expect(
      await reloadWithDrafts(
        'normal',
        wire({
          settle: vi.fn(async () => {
            pendingQuit = true
            pendingClose = true
            return 'cancel' as const
          })
        })
      )
    ).toBe('cancelled')
    // Later, re-read the window that has no drafts
    expect(await reloadWithDrafts('normal', wire({ needsSettle: () => false }))).toBe('reloaded')
    expect(actions).toEqual(['reload'])
  })

  it('TODO 1125 の review: 2 つの窓が片付けの最中の ⌘Q は窓ごとに覚え、窓 B のキャンセルでは窓 A の ⌘Q を捨てない', async () => {
    // Same wiring as `reloadWindow` in index.ts (per-window `ReloadPendingRequests`)
    const pending = new ReloadPendingRequests<{ name: string }>()
    const winA = { name: 'A' }
    const winB = { name: 'B' }
    const actions: string[] = []
    const wire = (window: { name: string }, over: Partial<ReloadGateDeps>): ReloadGateDeps =>
      gate({
        dropPending: vi.fn(() => {
          pending.drop(window)
        }),
        reload: vi.fn(() => {
          const action = reloadOrDefer(pending.pendingFor(window))
          pending.forget(window)
          if (action === 'quit') pending.forgetQuit()
          actions.push(`${window.name}:${action}`)
        }),
        ...over
      })
    let answerA: (verdict: 'proceed' | 'cancel') => void = () => undefined
    let answerB: (verdict: 'proceed' | 'cancel') => void = () => undefined
    const runA = reloadWithDrafts('normal', wire(winA, { settle: vi.fn(() => new Promise<'proceed' | 'cancel'>((r) => (answerA = r))) }))
    const runB = reloadWithDrafts('normal', wire(winB, { settle: vi.fn(() => new Promise<'proceed' | 'cancel'>((r) => (answerB = r))) }))
    await Promise.resolve()
    // While both 'save?' prompts are up, ⌘Q (before-quit remembers it for the window being cleaned up at that moment)
    pending.requestQuit([winA, winB])
    // B cancels: only B's part is discarded
    answerB('cancel')
    expect(await runB).toBe('cancelled')
    expect(pending.pendingFor(winA)).toEqual({ quit: true, close: false })
    expect(pending.pendingFor(winB)).toEqual({ quit: false, close: false })
    // A chooses save: quit as the remembered ⌘Q says
    answerA('proceed')
    expect(await runA).toBe('reloaded')
    expect(actions).toEqual(['A:quit'])
    expect(pending.pendingFor(winA)).toEqual({ quit: false, close: false })
  })

  it('TODO 1125 の review: ⌘Q の後に片付けを始めた窓には ⌘Q を紐づけない。⌘W は窓ごと', () => {
    const pending = new ReloadPendingRequests<{ name: string }>()
    const winA = { name: 'A' }
    const winB = { name: 'B' }
    pending.requestQuit([winA])
    pending.requestClose(winB)
    expect(pending.pendingFor(winB)).toEqual({ quit: false, close: true })
    // B's cancel discards only B's ⌘W
    expect(pending.drop(winB)).toBe(true)
    expect(pending.drop(winB)).toBe(false)
    expect(pending.pendingFor(winA)).toEqual({ quit: true, close: false })
  })

  it('判断は閉じるのと同じ (settleViewerDrafts)。「保存できませんでした」の語だけが再読み込み用', () => {
    expect(unsavedDialogKeys('close')).toEqual({
      detail: 'dialog.unsavedDrafts.detail',
      discard: 'dialog.unsavedDrafts.discard'
    })
    const reload = unsavedDialogKeys('reload')
    expect(NATIVE_DICTIONARIES.ja[reload.discard]).toBe('保存せずに再読み込み')
    expect(NATIVE_DICTIONARIES.en[reload.discard]).toBe('Reload Without Saving')
    expect(NATIVE_DICTIONARIES.ja[reload.detail]).toMatch(/再読み込み/)
    expect(NATIVE_DICTIONARIES.en[reload.detail]).toMatch(/reload/)
  })
})

describe('reloadOrDefer (TODO 636、code-review の直し)', () => {
  it('終了の要求が来ていれば、閉じるの要求も来ていても終了が勝つ', () => {
    expect(reloadOrDefer({ quit: true, close: false })).toBe('quit')
    expect(reloadOrDefer({ quit: true, close: true })).toBe('quit')
  })

  it('終了は無く閉じるの要求だけ来ていれば閉じる', () => {
    expect(reloadOrDefer({ quit: false, close: true })).toBe('close')
  })

  it('どちらも来ていなければ読み直す (今までどおり)', () => {
    expect(reloadOrDefer(NO_PENDING_RELOAD_REQUEST)).toBe('reload')
    expect(reloadOrDefer({ quit: false, close: false })).toBe('reload')
  })
})

describe('shouldDropCloseDuringQuitSettle (TODO 933)', () => {
  it('終了の片付けの最中の ⌘W は落とす。終了が決まっていれば、片付けが無ければ通す', () => {
    expect(shouldDropCloseDuringQuitSettle({ quitApproved: false, quitSettling: true })).toBe(true)
    expect(shouldDropCloseDuringQuitSettle({ quitApproved: true, quitSettling: true })).toBe(false)
    expect(shouldDropCloseDuringQuitSettle({ quitApproved: false, quitSettling: false })).toBe(false)
  })
})
