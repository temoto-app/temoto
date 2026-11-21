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
  it('closes immediately without asking anything for a window with no drafts', async () => {
    const d = deps({ hasDrafts: () => false })
    expect(await settleViewerDrafts(1, d)).toBe('proceed')
    expect(d.ask).not.toHaveBeenCalled()
  })

  it('autosave ON: writes everything out silently (does not ask)', async () => {
    for (const mode of ['afterDelay', 'onFocusChange'] as const) {
      const d = deps({ mode })
      expect(await settleViewerDrafts(1, d)).toBe('proceed')
      expect(d.ask).toHaveBeenCalledWith(1, 'save')
      expect(d.ask).toHaveBeenCalledTimes(1)
      expect(d.confirmSave).not.toHaveBeenCalled()
      expect(d.confirmUnsaved).not.toHaveBeenCalled()
    }
  })

  it('autosave ON still asks when something is left unwritten (conflict); cancel does not close, closing without saving closes', async () => {
    const left: ViewerDraftsReply = { unsaved: [{ uri: A, conflict: true }] }
    const cancel = deps({ mode: 'afterDelay', ask: vi.fn(async () => left) })
    expect(await settleViewerDrafts(1, cancel)).toBe('cancel')
    expect(cancel.confirmUnsaved).toHaveBeenCalledWith(1, left.unsaved)
    const discard = deps({ mode: 'afterDelay', ask: vi.fn(async () => left), confirmUnsaved: vi.fn(async () => 'discard') })
    expect(await settleViewerDrafts(1, discard)).toBe('proceed')
  })

  it('autosave OFF: lists the drafts and asks 「保存しますか」; save writes everything out, do not save closes, cancel does not close', async () => {
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

  it('autosave OFF still asks when something is left unwritten even after choosing 「保存」', async () => {
    const d = deps({
      ask: vi.fn(async (_id: number, action: string) => ({ unsaved: [{ uri: A, conflict: action === 'save' }] }))
    })
    expect(await settleViewerDrafts(1, d)).toBe('cancel')
    expect(d.confirmUnsaved).toHaveBeenCalledWith(1, [{ uri: A, conflict: true }])
  })

  it('closes without asking when the OFF listing comes back empty (count notice out of step)', async () => {
    const d = deps({ ask: vi.fn(async () => ({ unsaved: [] })) })
    expect(await settleViewerDrafts(1, d)).toBe('proceed')
    expect(d.confirmSave).not.toHaveBeenCalled()
  })

  it('closes when the renderer does not reply (null), since a window that cannot close is worse', async () => {
    expect(await settleViewerDrafts(1, deps({ ask: vi.fn(async () => null) }))).toBe('proceed')
    expect(await settleViewerDrafts(1, deps({ mode: 'afterDelay', ask: vi.fn(async () => null) }))).toBe('proceed')
  })

  it('quit: settles windows in order and cancels the quit if any one cancels (later windows are not asked)', async () => {
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

describe('ViewerDraftsRequests (requests and replies, main → renderer)', () => {
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

  it('accepts only a reply with the same number from the window it was sent to (the reply is re-validated)', async () => {
    const requests = new ViewerDraftsRequests('ch')
    const t = target(7)
    const pending = requests.request(t, 'list')
    expect(t.sent).toEqual([{ channel: 'ch', request: { id: 1, action: 'list' } }])
    requests.reply(8, 1, { unsaved: [{ uri: A }] }) // Another window
    requests.reply(7, 2, { unsaved: [{ uri: A }] }) // Unknown number
    requests.reply(7, 1, { unsaved: [{ uri: A }, { uri: 3 }, null, { uri: B, conflict: true }] })
    expect(await pending).toEqual({ unsaved: [{ uri: A, conflict: false }, { uri: B, conflict: true }] })
  })

  it('returns null on timeout, when the window closed, or when there is no window', async () => {
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

  it('code-review: a window that acknowledged the save request keeps waiting for the write to finish past the (shorter) limit and receives the reply', async () => {
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

  it('code-review: when the long limit also passes after the acknowledgement, returns the queued drafts as left unwritten', async () => {
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

  it('code-review: a malformed acknowledgement is not treated as one (null at the short limit)', async () => {
    vi.useFakeTimers()
    const requests = new ViewerDraftsRequests('ch', 100, 1000)
    const late = requests.request(target(5), 'save')
    requests.ack(5, 1, 'nope')
    await vi.advanceTimersByTimeAsync(100)
    expect(await late).toBeNull()
  })

  it('code-review: drafts that did not finish writing fall to 「保存できませんでした」 (the window does not close silently)', async () => {
    const d = deps({
      mode: 'afterDelay',
      ask: vi.fn(async (): Promise<ViewerDraftsReply | null> => ({ unsaved: [{ uri: A, conflict: false }] }))
    })
    expect(await settleViewerDrafts(1, d)).toBe('cancel')
    expect(d.confirmUnsaved).toHaveBeenCalledWith(1, [{ uri: A, conflict: false }])
  })

  it('the long limit is inside shutdownWithin (30 seconds)', () => {
    expect(VIEWER_DRAFTS_SAVE_TIMEOUT_MS).toBeLessThan(30_000)
    expect(VIEWER_DRAFTS_SAVE_TIMEOUT_MS).toBeGreaterThan(VIEWER_DRAFTS_TIMEOUT_MS)
  })

  it('a malformed reply is null', () => {
    expect(sanitizeViewerDraftsReply(null)).toBeNull()
    expect(sanitizeViewerDraftsReply({ unsaved: 'x' })).toBeNull()
    expect(sanitizeViewerDraftsReply({ unsaved: [] })).toEqual({ unsaved: [] })
  })
})

describe('dialog wording (TODO 606)', () => {
  it('fills in names and counts; lists names up to a limit and the rest as a count', () => {
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

describe('reloadWithDrafts (TODO 636: drafts before a window reload)', () => {
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

  it('reloads a window with no drafts right away without settling (the kind is kept)', async () => {
    const g = gate({ needsSettle: () => false })
    expect(await reloadWithDrafts('ignoreCache', g)).toBe('reloaded')
    expect(g.settle).not.toHaveBeenCalled()
    expect(g.reload).toHaveBeenCalledWith('ignoreCache')
    expect(g.busyLog).toEqual([])
  })

  it('reloads a window whose renderer crashed without settling, even if a count notice remains, since its drafts are already gone', async () => {
    const g = gate({ isCrashed: () => true })
    expect(await reloadWithDrafts('normal', g)).toBe('reloaded')
    expect(g.settle).not.toHaveBeenCalled()
    expect(g.reload).toHaveBeenCalledWith('normal')
  })

  it('settles drafts first when there are any (marked as settling meanwhile), then reloads when done', async () => {
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

  it('does not reload on cancel (the drafts stay)', async () => {
    const g = gate({ settle: vi.fn(async () => 'cancel' as const) })
    expect(await reloadWithDrafts('normal', g)).toBe('cancelled')
    expect(g.reload).not.toHaveBeenCalled()
    expect(g.busyLog).toEqual([true, false])
  })

  it('does not reload when the settling itself throws (does not fall toward discarding drafts); the mark is cleared', async () => {
    const g = gate({ settle: vi.fn(async () => Promise.reject(new Error('boom'))) })
    expect(await reloadWithDrafts('normal', g)).toBe('cancelled')
    expect(g.reload).not.toHaveBeenCalled()
    expect(g.busyLog).toEqual([true, false])
  })

  it('does nothing while a close, quit, or another reload is settling (dialogs do not stack)', async () => {
    const g = gate({ isBusy: () => true })
    expect(await reloadWithDrafts('normal', g)).toBe('busy')
    expect(g.settle).not.toHaveBeenCalled()
    expect(g.reload).not.toHaveBeenCalled()
  })

  it('does not reload when there is no window or quit processing has begun (also when that changes during settling)', async () => {
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

  it('TODO 1125: drops the remembered ⌘Q / ⌘W on cancel, settle failure, or the window closing during settling; does not drop it when reloading', async () => {
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

  it('TODO 1125: after dropping on cancel, reloading a window with no drafts does not turn into a quit or close', async () => {
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

  it("TODO 1125 review: with two windows settling during ⌘Q, remembers per window; cancelling window B does not drop window A's ⌘Q", async () => {
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

  it('TODO 1125 review: does not bind ⌘Q to a window that started settling after ⌘Q; ⌘W is per window', () => {
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

  it('decides the same as closing (settleViewerDrafts); only the 「保存できませんでした」 wording is specific to reload', () => {
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

describe('reloadOrDefer (TODO 636, code-review fix)', () => {
  it('when a quit request has arrived, quit wins even if a close request has also arrived', () => {
    expect(reloadOrDefer({ quit: true, close: false })).toBe('quit')
    expect(reloadOrDefer({ quit: true, close: true })).toBe('quit')
  })

  it('closes when only a close request arrived and no quit', () => {
    expect(reloadOrDefer({ quit: false, close: true })).toBe('close')
  })

  it('reloads when neither has arrived (as before)', () => {
    expect(reloadOrDefer(NO_PENDING_RELOAD_REQUEST)).toBe('reload')
    expect(reloadOrDefer({ quit: false, close: false })).toBe('reload')
  })
})

describe('shouldDropCloseDuringQuitSettle (TODO 933)', () => {
  it('drops ⌘W during quit settling; when quit is decided, lets it through if there is nothing to settle', () => {
    expect(shouldDropCloseDuringQuitSettle({ quitApproved: false, quitSettling: true })).toBe(true)
    expect(shouldDropCloseDuringQuitSettle({ quitApproved: true, quitSettling: true })).toBe(false)
    expect(shouldDropCloseDuringQuitSettle({ quitApproved: false, quitSettling: false })).toBe(false)
  })
})
