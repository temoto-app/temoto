// @vitest-environment jsdom
/**
 * TODO 1146 (wave 72 bundle A): restores the scroll position on the viewer's back / forward. The display position is kept per document (URI).
 *
 * - checks (`shared/viewer-position.ts`): `acceptViewerPosition` / `prunePositions`.
 * - renderer pure functions (`viewer-history.ts`): `setPosition`, the position of the destination of ← →, and steps with the same URI share the same position,
 *   and the round trip of `toSnapshot` / `fromSnapshot` / `adoptStored`.
 * - main (`session/viewer-history.ts`): the check on save (the key keeps only the URIs of the steps kept, broken values are dropped), and the round trip through ThreadStore.
 * - the entry point for instructions (`viewer-line.ts` / the store's `select`) and the wiring of ← → (`navigateViewer`).
 * - bridge: `acceptRestorePosition`, and the thinning of notices (`createPositionReporter`).
 * - editor: rounding to the line range (`topLinePosition`) and `restoreTopLine`.
 *
 * Neither the model nor electron is used. The DB is a real in-memory one (with migrations).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ViewerGuestMessage, ViewerScrollPosition } from '../src/shared/plugin.js'
import { acceptViewerPosition, prunePositions } from '../src/shared/viewer-position.js'
import {
  EMPTY_HISTORY,
  adoptStored,
  fromSnapshot,
  recordVisit,
  setPosition,
  stepHistory,
  toSnapshot,
  type ViewerHistory
} from '../src/renderer/src/viewer-history.js'
import { revealMessageFor, viewerRestoreRequest } from '../src/renderer/src/viewer-line.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import {
  ViewerHistoryService,
  parseStoredHistory,
  sanitizeViewerHistory
} from '../src/main/session/viewer-history.js'
import { acceptGeneration, acceptRestorePosition, createPositionReporter } from '../plugins/_shared/bridge.js'
import { createEditor, topLinePosition, type Editor } from '../plugins/_shared/editor.js'

const line = (value: number): ViewerScrollPosition => ({ kind: 'line', value })
const A = 'file:///Users/tester/work/a.txt'
const B = 'file:///Users/tester/work/b.txt'
const C = 'file:///Users/tester/work/c.txt'

/** Opened A → B → C (now at C). */
function visited(...uris: string[]): ViewerHistory {
  return uris.reduce(
    (history, uri, i) => recordVisit(history, { uri, highlight: null, now: i * 10_000, byKeys: false }),
    EMPTY_HISTORY
  )
}

describe('acceptViewerPosition / prunePositions', () => {
  it('line / page are safe integers of 1 or more, and offset is rounded to an integer of 0 or more', () => {
    expect(acceptViewerPosition({ kind: 'line', value: 3000 })).toEqual(line(3000))
    expect(acceptViewerPosition({ kind: 'page', value: 2 })).toEqual({ kind: 'page', value: 2 })
    expect(acceptViewerPosition({ kind: 'offset', value: 12.6 })).toEqual({ kind: 'offset', value: 13 })
    expect(acceptViewerPosition({ kind: 'offset', value: 0 })).toEqual({ kind: 'offset', value: 0 })
  })

  it('discards broken values', () => {
    for (const raw of [
      null,
      'line',
      [],
      { kind: 'line', value: 0 },
      { kind: 'line', value: 1.5 },
      { kind: 'page', value: -1 },
      { kind: 'offset', value: -3 },
      { kind: 'offset', value: Number.POSITIVE_INFINITY },
      { kind: 'line', value: Number.NaN },
      { kind: 'line', value: '3' },
      { kind: 'column', value: 3 },
      { value: 3 }
    ]) {
      expect(acceptViewerPosition(raw)).toBeNull()
    }
  })

  it('the table keeps only the passed URIs and only readable values; undefined when nothing remains', () => {
    expect(prunePositions({ [A]: line(5), [B]: { kind: 'line', value: 0 }, [C]: line(9) }, [A, B])).toEqual({
      [A]: line(5)
    })
    expect(prunePositions({ [B]: line(5) }, [A])).toBeUndefined()
    expect(prunePositions(null, [A])).toBeUndefined()
    expect(prunePositions(JSON.parse('{"__proto__": {"kind": "line", "value": 3}}') as unknown, ['__proto__'])).toEqual({
      ['__proto__']: line(3)
    })
  })
})

describe('setPosition and the destination of ← → (renderer pure functions)', () => {
  it("around line 3000 → another document → ← gives line 3000, → gives the other document's position", () => {
    let history = visited(A)
    history = setPosition(history, A, line(3000))
    history = recordVisit(history, { uri: B, highlight: null, now: 20_000, byKeys: false })
    history = setPosition(history, B, line(42))
    const back = stepHistory(history, B, 'back')
    expect(back?.entry.uri).toBe(A)
    expect(back?.position).toEqual(line(3000))
    const forward = stepHistory(back!.history, A, 'forward')
    expect(forward?.entry.uri).toBe(B)
    expect(forward?.position).toEqual(line(42))
  })

  it('a document with no known position is null (from the top)', () => {
    const history = visited(A, B)
    expect(stepHistory(history, B, 'back')?.position).toBeNull()
  })

  it('returns to the same position even if the same URI appears in several steps (per URI)', () => {
    let history = visited(A, B, A, C)
    history = setPosition(history, A, line(77))
    const back1 = stepHistory(history, C, 'back')
    expect(back1?.entry.uri).toBe(A)
    expect(back1?.position).toEqual(line(77))
    const back2 = stepHistory(back1!.history, A, 'back')
    const back3 = stepHistory(back2!.history, B, 'back')
    expect(back3?.entry.uri).toBe(A)
    expect(back3?.position).toEqual(line(77))
  })

  it('does not remember a URI that is not in a step; the same value returns the same history (does not write the store)', () => {
    const history = setPosition(visited(A), A, line(10))
    expect(setPosition(history, B, line(5))).toBe(history)
    expect(setPosition(history, A, line(10))).toBe(history)
    expect(setPosition(history, A, line(11)).positions).toEqual({ [A]: line(11) })
  })

  it('the position carries over when pushing, going back, or replacing a step', () => {
    let history = setPosition(visited(A, B), A, line(3))
    history = recordVisit(history, { uri: C, highlight: 'x', now: 99_000, byKeys: false })
    expect(history.positions).toEqual({ [A]: line(3) })
    history = recordVisit(history, { uri: C, highlight: 'y', now: 99_500, byKeys: false })
    expect(history.positions).toEqual({ [A]: line(3) })
    expect(stepHistory(history, C, 'back')?.history.positions).toEqual({ [A]: line(3) })
  })
})

describe('shape of the saved data (toSnapshot / fromSnapshot / adoptStored)', () => {
  it('sends only for the step URIs; omits positions when there are none (same as the earlier shape)', () => {
    let history = visited(A, B)
    expect(toSnapshot(history)).toEqual({
      entries: [
        { uri: A, highlight: null },
        { uri: B, highlight: null }
      ],
      index: 1
    })
    expect('positions' in toSnapshot(history)).toBe(false)
    history = { ...setPosition(history, A, line(3000)), positions: { [A]: line(3000), [C]: line(1) } }
    expect(toSnapshot(history).positions).toEqual({ [A]: line(3000) })
  })

  it('even a restored history goes to the previous position with ← (after a restart)', () => {
    const snapshot = toSnapshot(setPosition(setPosition(visited(A, B), A, line(3000)), B, line(8)))
    const restored = fromSnapshot(JSON.parse(JSON.stringify(snapshot)) as typeof snapshot)
    const back = stepHistory(restored, B, 'back')
    expect(back?.position).toEqual(line(3000))
    expect(stepHistory(back!.history, A, 'forward')?.position).toEqual(line(8))
  })

  it('a position reported while waiting for the readback wins over the saved one', () => {
    const stored = toSnapshot(setPosition(setPosition(visited(A, B), A, line(3000)), B, line(8)))
    const current = setPosition(visited(B), B, line(99))
    const adopted = adoptStored(current, stored)
    expect(adopted?.positions).toEqual({ [A]: line(3000), [B]: line(99) })
  })
})

describe('main storage (sanitizeViewerHistory / ViewerHistoryService)', () => {
  const fs = {
    isReferenceable: (path: string): boolean => !path.includes('/excluded/'),
    isViewable: (path: string): boolean => !path.includes('/excluded/')
  }
  const excluded = 'file:///Users/tester/excluded/secret.txt'

  it('keys are only the kept step URIs, values only the readable ones', () => {
    const out = sanitizeViewerHistory(
      {
        entries: [
          { uri: A, highlight: null },
          { uri: excluded, highlight: null },
          { uri: 'https://example.com/docs', highlight: null },
          { uri: B, highlight: null }
        ],
        index: 3,
        positions: {
          [A]: line(3000),
          [excluded]: line(5),
          'https://example.com/docs': { kind: 'offset', value: 10 },
          [B]: { kind: 'line', value: -1 },
          [C]: line(9)
        }
      },
      fs
    )
    expect(out?.positions).toEqual({ [A]: line(3000) })
  })

  it('does not write positions when there are none or all are broken', () => {
    expect(sanitizeViewerHistory({ entries: [{ uri: A, highlight: null }], index: 0 }, fs)).toEqual({
      entries: [{ uri: A, highlight: null }],
      index: 0
    })
    const broken = sanitizeViewerHistory(
      { entries: [{ uri: A, highlight: null }], index: 0, positions: { [A]: 'line 3' } },
      fs
    )
    expect(broken !== null && 'positions' in broken).toBe(false)
    expect(
      sanitizeViewerHistory({ entries: [{ uri: A, highlight: null }], index: 0, positions: [line(3)] }, fs)?.positions
    ).toBeUndefined()
  })

  it('does not keep positions for steps cut at 50', () => {
    const uris = Array.from({ length: 55 }, (_, i) => `file:///Users/tester/work/f${i}.txt`)
    const out = sanitizeViewerHistory(
      {
        entries: uris.map((uri) => ({ uri, highlight: null })),
        index: 54,
        positions: { [uris[0]!]: line(1), [uris[54]!]: line(54) }
      },
      fs
    )
    expect(out?.positions).toEqual({ [uris[54]!]: line(54) })
  })

  it('re-points positions even for steps whose URI shape changed on re-validation', () => {
    const raw = 'file:///Users/tester/work/./a.txt'
    const out = sanitizeViewerHistory({ entries: [{ uri: raw, highlight: null }], index: 0, positions: { [raw]: line(7) } }, fs)
    expect(out?.entries[0]?.uri).toBe(A)
    expect(out?.positions).toEqual({ [A]: line(7) })
  })

  it('JSON round trip (parseStoredHistory)', () => {
    const snapshot = { entries: [{ uri: A, highlight: null }], index: 0, positions: { [A]: line(3000) } }
    expect(parseStoredHistory(JSON.stringify(snapshot), fs)).toEqual(snapshot)
  })

  describe('round trip through ThreadStore (returns even after a restart)', () => {
    let db: Db
    let service: ViewerHistoryService
    beforeEach(() => {
      db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      store.createThread({
        id: 't1',
        title: '',
        titleAuto: true,
        cwd: '/Users/tester/work',
        allowedDirs: ['/Users/tester/work'],
        retention: 'forever',
        backend: 'fake',
        modelId: null,
        thinking: null
      })
      service = new ViewerHistoryService({ store, fs })
    })
    afterEach(() => db.close())

    it('writing and reading back the renderer history returns to line 3000 with ←', () => {
      const history = setPosition(setPosition(visited(A, B), A, line(3000)), B, line(12))
      service.set('t1', toSnapshot(history))
      const stored = service.get('t1')
      expect(stored?.positions).toEqual({ [A]: line(3000), [B]: line(12) })
      const restored = fromSnapshot(stored!)
      expect(stepHistory(restored, B, 'back')?.position).toEqual(line(3000))
    })
  })
})

describe('sending the request (viewer-line.ts)', () => {
  it('a restore request is sent as restore-position, once, addressed to the file the viewer is drawing', () => {
    const request = viewerRestoreRequest(A, { restore: line(3000) }, 4)
    expect(request).toEqual({ uri: A, position: line(3000), nonce: 4 })
    expect(revealMessageFor(request, A, 3)).toEqual({ type: 'restore-position', uri: A, position: line(3000) })
    expect(revealMessageFor(request, A, 4)).toBeNull()
    expect(revealMessageFor(request, B, 3)).toBeNull()
    expect(revealMessageFor(request, null, 3)).toBeNull()
  })

  it('no request when the position is missing or broken', () => {
    expect(viewerRestoreRequest(A, undefined, 1)).toBeNull()
    expect(viewerRestoreRequest(A, { restore: null }, 1)).toBeNull()
    expect(viewerRestoreRequest(null, { restore: line(3) }, 1)).toBeNull()
    expect(viewerRestoreRequest(A, { restore: { kind: 'line', value: 0 } }, 1)).toBeNull()
  })
})

describe('wiring of ← → (navigateViewer / recordViewerPosition)', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { viewerHistory: vi.fn(async () => null), setViewerHistory: vi.fn(async () => undefined) },
      fs: { stat: vi.fn(async () => null) }
    }
  })

  it('remembers the reported position, and ← raises a restore request for that position; so does →', async () => {
    const store = await import('../src/renderer/src/store.js')
    const threads = await import('../src/renderer/src/threadStore.js')
    const mod = await import('../src/renderer/src/viewerHistory.js')
    threads.useThreads.setState({ activeThreadId: 't1' } as never)
    store.useStore.setState({ viewerHistories: { t1: visited(A, B) }, selectedUri: B, transient: null } as never)
    mod.recordViewerPosition(B, line(12))
    mod.recordViewerPosition(C, line(1)) // A URI not in the steps is not remembered
    store.useStore.setState({
      viewerHistories: { t1: setPosition(store.useStore.getState().viewerHistories['t1']!, A, line(3000)) }
    } as never)
    expect(store.useStore.getState().viewerHistories['t1']?.positions).toEqual({ [B]: line(12), [A]: line(3000) })

    expect(mod.navigateViewer('back')).toBe(true)
    let state = store.useStore.getState()
    expect(state.selectedUri).toBe(A)
    expect(state.viewerLine).toMatchObject({ uri: A, position: line(3000) })

    expect(mod.navigateViewer('forward')).toBe(true)
    state = store.useStore.getState()
    expect(state.selectedUri).toBe(B)
    expect(state.viewerLine).toMatchObject({ uri: B, position: line(12) })
  })

  it('files a position under the conversation its generation names, even after the active conversation changed (TODO 1337 item 12)', async () => {
    const store = await import('../src/renderer/src/store.js')
    const threads = await import('../src/renderer/src/threadStore.js')
    const mod = await import('../src/renderer/src/viewerHistory.js')
    // Both conversations show the same file A.
    store.useStore.setState({ viewerHistories: { t1: visited(A), t2: visited(A) }, selectedUri: A, transient: null } as never)
    threads.useThreads.setState({ activeThreadId: 't1' } as never)
    const g1 = mod.activeViewerGeneration()!
    threads.useThreads.setState({ activeThreadId: 't2' } as never)
    const g2 = mod.activeViewerGeneration()!
    expect(g1).not.toBe(g2)
    expect(mod.activeViewerGeneration()).toBe(g2)
    // The scroll was made in t1, and arrives after the switch to t2.
    mod.recordViewerPosition(A, line(77), g1)
    expect(store.useStore.getState().viewerHistories['t1']?.positions).toEqual({ [A]: line(77) })
    expect(store.useStore.getState().viewerHistories['t2']?.positions ?? {}).toEqual({})
    // An unknown generation falls back to the conversation on screen.
    mod.recordViewerPosition(A, line(5), 'nope')
    expect(store.useStore.getState().viewerHistories['t2']?.positions).toEqual({ [A]: line(5) })
  })

  it('does not raise a restore request for a document with no known position', async () => {
    const store = await import('../src/renderer/src/store.js')
    const threads = await import('../src/renderer/src/threadStore.js')
    const mod = await import('../src/renderer/src/viewerHistory.js')
    threads.useThreads.setState({ activeThreadId: 't1' } as never)
    store.useStore.setState({ viewerHistories: { t1: visited(A, B) }, selectedUri: B, transient: null } as never)
    expect(mod.navigateViewer('back')).toBe(true)
    expect(store.useStore.getState().viewerLine).toBeNull()
  })

  it('a line request (link in the body) wins over restore', async () => {
    const store = await import('../src/renderer/src/store.js')
    store.useStore.getState().select(A, { line: 5, restore: line(3000) })
    expect(store.useStore.getState().viewerLine).toMatchObject({ uri: A, line: 5 })
  })
})

describe('bridge', () => {
  it('acceptRestorePosition: only for the shown file and only a readable position', () => {
    expect(acceptRestorePosition({ uri: A, position: line(3) }, A)).toEqual({ uri: A, position: line(3) })
    expect(acceptRestorePosition({ uri: A, position: line(3) }, B)).toBeNull()
    expect(acceptRestorePosition({ uri: A, position: { kind: 'line', value: 0 } }, A)).toBeNull()
    expect(acceptRestorePosition({ uri: 1, position: line(3) }, A)).toBeNull()
  })

  function reporter(): {
    sent: ViewerGuestMessage[]
    report: ReturnType<typeof createPositionReporter>
    fire: () => void
  } {
    const sent: ViewerGuestMessage[] = []
    let pending: (() => void) | null = null
    const report = createPositionReporter(
      (message) => sent.push(message),
      {
        set: (fn) => {
          pending = fn
          return fn
        },
        clear: () => {
          pending = null
        }
      },
      200
    )
    return {
      sent,
      report,
      fire: () => {
        const fn = pending
        pending = null
        fn?.()
      }
    }
  }

  it('consecutive reports send only the last; the same value is not resent', () => {
    const { sent, report, fire } = reporter()
    report.report(A, line(10))
    report.report(A, line(20))
    report.report(A, line(3000))
    fire()
    expect(sent).toEqual([{ type: 'scroll-position', uri: A, position: line(3000) }])
    report.report(A, line(3000))
    fire()
    expect(sent).toHaveLength(1)
  })

  it("when a report for another file arrives, sends the previous file's last position right away", () => {
    const { sent, report, fire } = reporter()
    report.report(A, line(3000))
    report.report(B, line(1))
    expect(sent).toEqual([{ type: 'scroll-position', uri: A, position: line(3000) }])
    fire()
    expect(sent[1]).toEqual({ type: 'scroll-position', uri: B, position: line(1) })
  })

  it('flush sends what is waiting right away (before switching)', () => {
    const { sent, report } = reporter()
    report.report(A, line(5))
    report.flush()
    expect(sent).toEqual([{ type: 'scroll-position', uri: A, position: line(5) }])
    report.flush()
    expect(sent).toHaveLength(1)
  })

  it('stamps the generation when the scroll happened, so a report that goes out after a conversation switch keeps the old one (TODO 1337 item 12)', () => {
    const sent: ViewerGuestMessage[] = []
    let timer: (() => void) | null = null
    let generation: string | undefined = 'gA'
    const report = createPositionReporter(
      (message) => sent.push(message),
      { set: (fn) => ((timer = fn), fn), clear: () => (timer = null) },
      200,
      () => generation
    )
    report.report(A, line(40))
    // The conversation switches inside the 200 ms wait; the timer then fires.
    generation = 'gB'
    ;(timer as (() => void) | null)?.()
    expect(sent).toEqual([{ type: 'scroll-position', uri: A, position: line(40), generation: 'gA' }])
    // The same position in the new conversation is a new fact and is sent again, under the new generation.
    report.report(A, line(40))
    ;(timer as (() => void) | null)?.()
    expect(sent[1]).toEqual({ type: 'scroll-position', uri: A, position: line(40), generation: 'gB' })
  })

  it('sends the pending one under the old generation when a scroll arrives under a new one', () => {
    const sent: ViewerGuestMessage[] = []
    let generation: string | undefined = 'gA'
    const report = createPositionReporter(
      (message) => sent.push(message),
      { set: (fn) => fn, clear: () => undefined },
      200,
      () => generation
    )
    report.report(A, line(10))
    generation = 'gB'
    report.report(A, line(20))
    expect(sent).toEqual([{ type: 'scroll-position', uri: A, position: line(10), generation: 'gA' }])
  })

  it('without a generation the message has no such field (a viewer / host that does not use it)', () => {
    const { sent, report } = reporter()
    report.report(A, line(5))
    report.flush()
    expect(sent[0]).not.toHaveProperty('generation')
  })

  it('acceptGeneration takes only a short non-empty string', () => {
    expect(acceptGeneration('g1')).toBe('g1')
    expect(acceptGeneration('')).toBeUndefined()
    expect(acceptGeneration(3)).toBeUndefined()
    expect(acceptGeneration('x'.repeat(65))).toBeUndefined()
  })
})

describe('editor (line of aios.text)', () => {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  }
  const editors: Editor[] = []
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy()
    document.body.innerHTML = ''
  })

  it('topLinePosition: a line out of range goes to the last line (the line count dropped after an external rewrite), 0 or less goes to the top', () => {
    const doc = EditorState.create({ doc: 'a\nbb\nccc' }).doc
    expect(topLinePosition(doc, 2)).toBe(2)
    expect(topLinePosition(doc, 3000)).toBe(5)
    expect(topLinePosition(doc, 0)).toBe(0)
  })

  it('restoreTopLine moves neither the cursor nor the selection', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n')
    const editor = createEditor(host, {
      value: text,
      filename: 'a.txt',
      readOnly: false,
      theme: 'light',
      onChange: () => undefined,
      onTopLine: () => undefined
    })
    editors.push(editor)
    const view = EditorView.findFromDOM(host)!
    const before = view.state.selection.main.head
    editor.restoreTopLine(3000)
    editor.restoreTopLine(999_999)
    expect(view.state.selection.main.head).toBe(before)
  })
})
