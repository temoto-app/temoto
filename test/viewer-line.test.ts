/**
 * @vitest-environment jsdom
 *
 * Moves the viewer to that line for links in the body and for `openFile` with a line (item 273, ARCHITECTURE.md 5.1 / 7.6.2).
 *
 *  - renderer: `select(uri, { line })` sets a one-time instruction (`viewerLine`, with a nonce), which is cleared by a plain `select` without a line.
 *    It does not move the values the memory subscription watches (item 63): `selectedUri` / `highlightQuery`.
 *  - host (ViewerPane's sending point `revealMessageFor`): once per number, after the viewer has drawn the file of the instruction
 *  - 'open' from main (`planViewerCommand`) carries the line
 *  - viewer (bridge's `acceptReveal`): drops a file other than the one displayed, and broken lines
 *  - editor (`revealLine`, the real CodeMirror in jsdom): the caret moves to that line, the line gets a mark, and no range is selected
 *  - `aios.markdown`: in Preview, it switches to Source first, then jumps (owner decision 2026-10-01)
 *  - items 309-2 / 303 (wave 16 bundle I): a re-send of `resource` (`ready` of a new iframe, theme, language) does not replace the body: the line mark, caret, and draft remain.
 *    The host attaches a revision (`revision`), and the same contents are not sent twice to the same port
 *
 * The check of `line` in the gateway / IPC is in `test/session-manager.test.ts` (item 273), and the line extraction is in `test/link-resolve.test.ts` (item 273).
 * Neither the model nor Electron is started.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { createEditor, revealPosition } from '../plugins/_shared/editor.js'
import { acceptReveal } from '../plugins/_shared/bridge.js'
import { revealNeedsRender } from '../plugins/aios.markdown/viewer/reveal-mode.js'
import { EditorView } from '@codemirror/view'
import {
  planResource,
  receivedOf,
  refreshEditor,
  type ReceivedResource
} from '../plugins/_shared/resource-update.js'
import { ResourceRevisions, samePush, type LoadedResource, type PushedResource } from '../src/renderer/src/viewer-route.js'
import { revealMessageFor, viewerLineRequest } from '../src/renderer/src/viewer-line.js'
import { planViewerCommand } from '../src/renderer/src/viewer-memory.js'
import { useStore } from '../src/renderer/src/store.js'
import type { ViewerSelectionRange } from '../src/shared/plugin.js'

describe('renderer: 行の指示 (viewerLineRequest / revealMessageFor)', () => {
  it('行は 1 以上の安全な整数だけ。桁だけ壊れていれば桁を落とす', () => {
    expect(viewerLineRequest('file:///a', { line: 42 }, 1)).toEqual({ uri: 'file:///a', line: 42, column: null, nonce: 1 })
    expect(viewerLineRequest('file:///a', { line: 3, column: 7 }, 2)).toEqual({
      uri: 'file:///a',
      line: 3,
      column: 7,
      nonce: 2
    })
    expect(viewerLineRequest('file:///a', { line: 3, column: 0 }, 2)?.column).toBeNull()
    for (const line of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, null, undefined]) {
      expect(viewerLineRequest('file:///a', { line }, 1), String(line)).toBeNull()
    }
    expect(viewerLineRequest(null, { line: 3 }, 1)).toBeNull()
    expect(viewerLineRequest('file:///a', undefined, 1)).toBeNull()
  })

  it('viewer が指示のファイルを描いた後に、番号ごとに 1 度だけ', () => {
    const request = { uri: 'file:///a', line: 5, column: null, nonce: 3 }
    // Not yet sent resource / another file is drawn -> do not send
    expect(revealMessageFor(request, null, 0)).toBeNull()
    expect(revealMessageFor(request, 'file:///b', 0)).toBeNull()
    expect(revealMessageFor(request, 'file:///a', 0)).toEqual({ type: 'reveal', uri: 'file:///a', line: 5 })
    // A number already sent is not sent again (switching theme and re-sending resource does not jump again)
    expect(revealMessageFor(request, 'file:///a', 3)).toBeNull()
    expect(revealMessageFor({ ...request, column: 2 }, 'file:///a', 0)).toEqual({
      type: 'reveal',
      uri: 'file:///a',
      line: 5,
      column: 2
    })
    expect(revealMessageFor(null, 'file:///a', 0)).toBeNull()
  })
})

describe('renderer: store.select の行 (項目 273)', () => {
  beforeEach(() => {
    // Put it in the searching state so that the auto reveal of `select` (item 264) does not fetch the tree list
    useStore.setState({
      selectedUri: null,
      highlightQuery: null,
      viewerLine: null,
      results: { items: [], truncated: false } as never
    })
  })

  it('同じファイル・同じ行を 2 度押しても番号が進む (2 度目も飛ぶ)', () => {
    useStore.getState().select('file:///a', { line: 10 })
    const first = useStore.getState().viewerLine
    useStore.getState().select('file:///a', { line: 10 })
    const second = useStore.getState().viewerLine
    expect(first).toMatchObject({ uri: 'file:///a', line: 10, column: null })
    expect(second).toMatchObject({ uri: 'file:///a', line: 10 })
    expect(second!.nonce).toBeGreaterThan(first!.nonce)
  })

  it('行なしの select で消える。検索語と一緒に持てる', () => {
    useStore.getState().select('file:///a', { line: 4, column: 2, highlight: 'foo' })
    expect(useStore.getState().viewerLine).toMatchObject({ line: 4, column: 2 })
    expect(useStore.getState().highlightQuery).toBe('foo')
    useStore.getState().select('file:///a')
    expect(useStore.getState().viewerLine).toBeNull()
    useStore.getState().select('file:///a', { line: 4 })
    useStore.getState().select(null)
    expect(useStore.getState().viewerLine).toBeNull()
  })

  it('記憶 (項目 63) の購読が見る値は、行だけ変わっても動かない', () => {
    useStore.getState().select('file:///a')
    const seen: string[] = []
    const off = useStore.subscribe((state, previous) => {
      if (state.selectedUri !== previous.selectedUri || state.highlightQuery !== previous.highlightQuery) {
        seen.push(String(state.selectedUri))
      }
    })
    useStore.getState().select('file:///a', { line: 7 })
    useStore.getState().select('file:///a', { line: 9 })
    off()
    expect(seen).toEqual([])
  })
})

describe('renderer: main からの「開け」が行を運ぶ (項目 273)', () => {
  it('open の line を select に渡す。無ければ null', () => {
    const state = { activeThreadId: 't1', selectedUri: null, dirty: false }
    expect(
      planViewerCommand({ kind: 'open', threadId: 't1', uri: 'file:///a', highlight: null, line: 12 }, state)
    ).toEqual({ kind: 'select', uri: 'file:///a', highlight: null, line: 12 })
    expect(planViewerCommand({ kind: 'open', threadId: 't1', uri: 'file:///a', highlight: null }, state)).toEqual({
      kind: 'select',
      uri: 'file:///a',
      highlight: null,
      line: null
    })
  })
})

describe('viewer: host の「この行へ」を検める (acceptReveal)', () => {
  it('表示中のファイル宛てで、行が 1 以上の整数のものだけ', () => {
    expect(acceptReveal({ uri: 'file:///a', line: 3 }, 'file:///a')).toEqual({ uri: 'file:///a', line: 3, column: null })
    expect(acceptReveal({ uri: 'file:///a', line: 3, column: 4 }, 'file:///a')).toEqual({
      uri: 'file:///a',
      line: 3,
      column: 4
    })
    expect(acceptReveal({ uri: 'file:///a', line: 3, column: -1 }, 'file:///a')?.column).toBeNull()
    expect(acceptReveal({ uri: 'file:///b', line: 3 }, 'file:///a')).toBeNull()
    expect(acceptReveal({ uri: 'file:///a', line: 3 }, null)).toBeNull()
    for (const line of [0, 1.5, '3', null, Number.NaN]) {
      expect(acceptReveal({ uri: 'file:///a', line }, 'file:///a'), String(line)).toBeNull()
    }
  })
})

describe('editor: revealLine (項目 273)', () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)

  function build(onSelection?: (selection: ViewerSelectionRange | null) => void): {
    host: HTMLElement
    editor: ReturnType<typeof createEditor>
  } {
    const host = document.createElement('div')
    document.body.append(host)
    const editor = createEditor(host, {
      value: lines.join('\n'),
      filename: 'x.ts',
      readOnly: false,
      theme: 'light',
      onChange: () => {},
      ...(onSelection === undefined ? {} : { onSelection })
    })
    return { host, editor }
  }

  it('位置の丸め: 行は本文の範囲、桁は行の長さまで。桁なしは行頭', () => {
    const doc = Text.of(['abc', 'de', 'fghij'])
    expect(revealPosition(doc, 2, null)).toEqual({ lineFrom: 4, head: 4 })
    expect(revealPosition(doc, 2, 2)).toEqual({ lineFrom: 4, head: 5 })
    expect(revealPosition(doc, 2, 99)).toEqual({ lineFrom: 4, head: 6 })
    expect(revealPosition(doc, 99, null)).toEqual({ lineFrom: 7, head: 7 })
    expect(revealPosition(doc, 1, 1)).toEqual({ lineFrom: 0, head: 0 })
  })

  it('カーソルがその行へ動き、行に .cm-revealedLine の印。範囲は選ばない (添付の候補にしない)', () => {
    const selections: (ViewerSelectionRange | null)[] = []
    const { host, editor } = build((selection) => selections.push(selection))
    editor.revealLine(5, 3)
    const marked = [...host.querySelectorAll('.cm-revealedLine')]
    expect(marked.map((el) => el.textContent)).toEqual(['line 5'])
    // A notice that the selection changed arrives, but it is not a range (null)
    expect(selections.at(-1)).toBeNull()
    const active = host.querySelector('.cm-activeLine')
    expect(active?.textContent).toBe('line 5')
    editor.destroy()
  })

  it('次に飛べば印は付け替わり、本文の差し替え (setValue) で消える', () => {
    const { host, editor } = build()
    editor.revealLine(2)
    editor.revealLine(3)
    expect([...host.querySelectorAll('.cm-revealedLine')].map((el) => el.textContent)).toEqual(['line 3'])
    editor.setValue('other\ntext')
    expect(host.querySelectorAll('.cm-revealedLine')).toHaveLength(0)
    editor.destroy()
  })

  it('本文より後ろの行は最終行へ', () => {
    const { host, editor } = build()
    editor.revealLine(10_000)
    expect(host.querySelector('.cm-revealedLine')?.textContent).toBe('line 200')
    editor.destroy()
  })
})

describe('aios.markdown: Preview なら Source に切り替えてから飛ぶ', () => {
  it('Preview は描き直す、Source で editor があればそのまま', () => {
    expect(revealNeedsRender('preview', false)).toBe(true)
    expect(revealNeedsRender('source', false)).toBe(true)
    expect(revealNeedsRender('source', true)).toBe(false)
  })
})

describe('項目 309-2 / 303: resource の送り直しで本文を置き換えない (planResource / refreshEditor)', () => {
  const URI = 'file:///Users/me/README.md'
  const body = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n')
  const got = (over: Partial<ReceivedResource> = {}): ReceivedResource => ({
    uri: URI,
    revision: 1,
    text: body,
    highlightQuery: null,
    ...over
  })

  function build(): { host: HTMLElement; editor: ReturnType<typeof createEditor>; drafts: string[] } {
    const host = document.createElement('div')
    document.body.append(host)
    const drafts: string[] = []
    const editor = createEditor(host, {
      value: body,
      filename: 'README.md',
      readOnly: false,
      theme: 'light',
      onChange: (next) => drafts.push(next)
    })
    return { host, editor, drafts }
  }

  /** Makes a draft from a person's input (a CodeMirror transaction). */
  function type(host: HTMLElement, text: string): void {
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)
    if (view === null) throw new Error('no view')
    view.dispatch({ changes: { from: 0, insert: text } })
  }

  it('判定: 同じ URI・同じ版は keep、別の URI・読み直した中身・本文でないものは replace', () => {
    expect(planResource(null, got(), null)).toBe('replace')
    expect(planResource(got(), got(), body)).toBe('keep')
    // Theme, language, and search word do not enter the decision (the revision is the same even when re-sent)
    expect(planResource(got(), got({ highlightQuery: 'line' }), body)).toBe('keep')
    expect(planResource(got(), got({ uri: 'file:///Users/me/b.md' }), body)).toBe('replace')
    // A re-read (the revision advanced, and the body differs from the current editor) replaces it
    expect(planResource(got(), got({ revision: 2, text: 'other' }), `DRAFT ${body}`)).toBe('replace')
    // Even if the revision advanced, if the body is the same as the current contents (right after saving), it is kept
    expect(planResource(got(), got({ revision: 2, text: `DRAFT ${body}` }), `DRAFT ${body}`)).toBe('keep')
    // For 'read again from disk' in the draft conflict, if the disk is the same as when it was read but the revision differs, replace it
    // (matching the body alone cannot tell them apart; that is the reason to attach a revision).
    expect(planResource(got(), got({ revision: 2 }), `DRAFT ${body}`)).toBe('replace')
    // A host that attaches no revision is matched by body
    expect(planResource(got({ revision: null }), got({ revision: null }), 'x')).toBe('keep')
    expect(planResource(got({ revision: null }), got({ revision: null, text: 'y' }), 'x')).toBe('replace')
    // The previous one was an error, and this one is an error
    expect(planResource(got({ text: null }), got(), null)).toBe('replace')
    expect(planResource(got(), got({ text: null }), body)).toBe('replace')
  })

  it('receivedOf: 本文でない中身は text: null', () => {
    const base = { uri: URI, revision: 3, highlightQuery: null }
    expect(receivedOf({ ...base, resource: { kind: 'text', text: 'a' } }).text).toBe('a')
    expect(receivedOf({ ...base, resource: { kind: 'error' } }).text).toBeNull()
    expect(receivedOf({ ...base, resource: { kind: 'binary' } }).revision).toBe(3)
  })

  it('新しい iframe: resource → reveal → 2 通目の resource (ready) で、行の印とカーソルが残る (309-2)', () => {
    const { host, editor } = build()
    const first = got()
    editor.revealLine(42)
    // The second one (same contents, same revision). The earlier aios.markdown recreated the editor here and went back to line 1
    const second = got()
    expect(planResource(first, second, editor.getValue())).toBe('keep')
    refreshEditor(editor, first, second, { readOnly: false, theme: 'light' })
    expect([...host.querySelectorAll('.cm-revealedLine')].map((el) => el.textContent)).toEqual(['line 42'])
    expect(host.querySelector('.cm-activeLine')?.textContent).toBe('line 42')
    editor.destroy()
  })

  it('テーマ・言語の送り直しでも行の印は残り、検索語が同じならスクロールし直さない', () => {
    const { host, editor } = build()
    const first = got({ highlightQuery: 'line 3' })
    editor.setHighlight('line 3')
    editor.revealLine(60)
    const calls: string[] = []
    const spy = {
      setReadOnly: (value: boolean) => {
        calls.push(`readOnly:${value}`)
        editor.setReadOnly(value)
      },
      setTheme: (value: 'light' | 'dark') => {
        calls.push(`theme:${value}`)
        editor.setTheme(value)
      },
      setHighlight: (value: string | null) => {
        calls.push(`highlight:${value}`)
        editor.setHighlight(value)
      }
    }
    refreshEditor(spy, first, got({ highlightQuery: 'line 3' }), { readOnly: false, theme: 'dark' })
    expect(calls).toEqual(['readOnly:false', 'theme:dark'])
    expect(host.querySelector('.cm-revealedLine')?.textContent).toBe('line 60')
    // The highlight is re-applied only when the search word changes
    refreshEditor(spy, first, got({ highlightQuery: 'line 7' }), { readOnly: true, theme: 'dark' })
    expect(calls.at(-1)).toBe('highlight:line 7')
    editor.destroy()
  })

  it('下書きがあるとき、同じ text の resource (テーマ・言語の送り直し) で下書きが残る (303)', () => {
    const { host, editor, drafts } = build()
    type(host, 'DRAFT ')
    expect(editor.getValue().startsWith('DRAFT line 1')).toBe(true)
    const before = drafts.length
    const prev = got()
    const next = got() // The body the host sends is what was read (not a draft)
    expect(planResource(prev, next, editor.getValue())).toBe('keep')
    refreshEditor(editor, prev, next, { readOnly: false, theme: 'dark' })
    expect(editor.getValue().startsWith('DRAFT line 1')).toBe(true)
    // No draft of the 'original body' is returned to the host (before, setValue -> onChange cleared dirty)
    expect(drafts.length).toBe(before)
    // Contrast: the earlier aios.text path (setValue with the contents as read) cleared the draft.
    // The body is replaced, but since it is a re-set initiated by the host, onChange (= the user's edit) is not emitted (second wave-42 code-review).
    const beforeSet = drafts.length
    editor.setValue(body)
    expect(editor.getValue()).toBe(body)
    expect(drafts.length).toBe(beforeSet)
    editor.destroy()
  })

  it('host: 中身ごとの版は送り直しで変わらず、読み直しで進む。同じ port へ同じ resource は 2 度送らない', () => {
    const revisions = new ResourceRevisions()
    const resource = { kind: 'text' as const, text: body, truncated: false, size: body.length, mtimeMs: 1 }
    const loaded: LoadedResource = { uri: URI, pluginId: 'aios.markdown', resource }
    expect(revisions.of(loaded)).toBe(1)
    expect(revisions.of(loaded)).toBe(1)
    // Save and re-read recreate the object with setLoaded
    expect(revisions.of({ ...loaded })).toBe(2)

    const port = {}
    const pushed: PushedResource = {
      port,
      uri: URI,
      revision: 1,
      editable: true,
      theme: 'light',
      locale: 'en',
      highlightQuery: null
    }
    expect(samePush(null, pushed)).toBe(false)
    // New iframe load and ready: the same, so the second one is not sent
    expect(samePush(pushed, { ...pushed })).toBe(true)
    // If any of theme, language, search word, editable, revision, or port differs, it is sent
    for (const change of [
      { theme: 'dark' },
      { locale: 'ja' },
      { highlightQuery: 'x' },
      { editable: false },
      { revision: 2 },
      { port: {} },
      { uri: 'file:///Users/me/b.md' },
      // The key assignment changed (the 33rd proxy verification, 620-1): replace the reverse-send table of the open viewer
      { keybindings: { 'search.names': 'Cmd+Alt+U' } }
    ]) {
      expect(samePush(pushed, { ...pushed, ...change }), JSON.stringify(Object.keys(change))).toBe(false)
    }
  })
})
