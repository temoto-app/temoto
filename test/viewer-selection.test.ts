/**
 * @vitest-environment jsdom
 *
 * ViewerPane selection attached to the submission (item 97, ARCHITECTURE.md 4.5 / 7.4.5): the pure part.
 *
 *  - viewer (plugins/_shared/selection.ts): CodeMirror selection → the form to notify (line, truncation, empty selection)
 *  - editor: `onSelection` is called when the selection changes (the real CodeMirror in jsdom)
 *  - host (renderer/viewer-selection.ts): checks the viewer's notice without trusting it, and the selection shown in the chip
 *  - main (session/viewer-tools.ts): re-checked at submission, and how it is embedded in the prompt
 *  - handling of 'open / close' from main (`planViewerCommand` in renderer/viewer-memory.ts)
 *
 * Neither the model nor Electron is started.
 */
import { describe, expect, it, vi } from 'vitest'
import { EditorSelection, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { MAX_SELECTION_TEXT } from '../src/shared/plugin.js'
import type { ViewerSelection } from '../src/shared/thread.js'
import {
  clipSelectionText,
  plainSelection,
  sameSelection,
  selectionOf
} from '../plugins/_shared/selection.js'
import { createEditor } from '../plugins/_shared/editor.js'
import {
  acceptViewerSelection,
  effectiveSelection,
  selectionKey,
  selectionLabel
} from '../src/renderer/src/viewer-selection.js'
import { planViewerCommand } from '../src/renderer/src/viewer-memory.js'
import {
  checkSelection,
  fenceFor,
  formatSelection,
  resolveToolPath
} from '../src/main/session/viewer-tools.js'

const doc = Text.of(['one', 'two', 'three', 'four'])
// Positions: one=0..3, \n, two=4..7, \n, three=8..13, \n, four=14..18

describe('viewer: selection → shape to report (item 97)', () => {
  it('lines are 1-based and inclusive at both ends; a reverse selection is the same', () => {
    expect(selectionOf(doc, 4, 13)).toEqual({ text: 'two\nthree', fromLine: 2, toLine: 3, truncated: false })
    expect(selectionOf(doc, 13, 4)).toEqual(selectionOf(doc, 4, 13))
    expect(selectionOf(doc, 5, 6)).toEqual({ text: 'w', fromLine: 2, toLine: 2, truncated: false })
  })

  it('a selection that sweeps whole lines downward (ending at the next line start) does not include that next line', () => {
    expect(selectionOf(doc, 4, 8)).toMatchObject({ text: 'two\n', fromLine: 2, toLine: 2 })
  })

  it('a cursor only or whitespace only is null', () => {
    expect(selectionOf(doc, 5, 5)).toBeNull()
    expect(selectionOf(Text.of(['a', '   ', 'b']), 2, 5)).toBeNull()
  })

  it('cuts the body at the limit and does not cut in the middle of a surrogate pair', () => {
    const long = 'a'.repeat(MAX_SELECTION_TEXT + 10)
    expect(clipSelectionText(long)).toEqual({ text: 'a'.repeat(MAX_SELECTION_TEXT), truncated: true })
    const emoji = `${'a'.repeat(4)}😀`
    expect(clipSelectionText(emoji, 5)).toEqual({ text: 'aaaa', truncated: true })
    const big = Text.of([long])
    expect(selectionOf(big, 0, big.length)).toMatchObject({ truncated: true, fromLine: 1, toLine: 1 })
  })

  it('a preview selection has no lines; the check that does not resend the same selection', () => {
    expect(plainSelection('見出し')).toEqual({ text: '見出し', fromLine: null, toLine: null, truncated: false })
    expect(plainSelection(' \n ')).toBeNull()
    expect(sameSelection(selectionOf(doc, 4, 7), selectionOf(doc, 4, 7))).toBe(true)
    expect(sameSelection(selectionOf(doc, 4, 7), null)).toBe(false)
    expect(sameSelection(null, null)).toBe(true)
  })

  it('the editor calls onSelection when the selection changes (null when emptied)', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const onSelection = vi.fn()
    const editor = createEditor(parent, {
      value: 'alpha\nbeta\ngamma',
      filename: 'a.txt',
      readOnly: true,
      theme: 'light',
      onChange: () => undefined,
      onSelection
    })
    const root = parent.querySelector('.cm-editor')
    const view = root instanceof HTMLElement ? EditorView.findFromDOM(root) : null
    expect(view).not.toBeNull()
    view?.dispatch({ selection: EditorSelection.range(6, 16) })
    expect(onSelection).toHaveBeenLastCalledWith({
      text: 'beta\ngamma',
      fromLine: 2,
      toLine: 3,
      truncated: false
    })
    view?.dispatch({ selection: EditorSelection.cursor(0) })
    expect(onSelection).toHaveBeenLastCalledWith(null)
    editor.destroy()
  })
})

describe("host: validating the viewer's report (item 97)", () => {
  const uri = 'file:///Users/me/a.ts'

  it('ignores a URI different from the shown one or a malformed shape (undefined); null means "no selection"', () => {
    expect(acceptViewerSelection({ uri: 'file:///other', selection: null }, uri)).toBeUndefined()
    expect(acceptViewerSelection({ uri, selection: null }, null)).toBeUndefined()
    expect(acceptViewerSelection({ uri, selection: null }, uri)).toBeNull()
    for (const bad of [
      'x',
      { text: 1, fromLine: 1, toLine: 1 },
      { text: 'a', fromLine: 0, toLine: 1 },
      { text: 'a', fromLine: 1.5, toLine: 2 },
      { text: 'a', fromLine: 3, toLine: 2 },
      { text: 'a', fromLine: 1, toLine: null }
    ]) {
      expect(acceptViewerSelection({ uri, selection: bad }, uri)).toBeUndefined()
    }
  })

  it("cuts the body again at the limit and uses the host's value for the URI", () => {
    const got = acceptViewerSelection(
      { uri, selection: { text: 'x'.repeat(MAX_SELECTION_TEXT + 5), fromLine: 1, toLine: 1 } },
      uri
    )
    expect(got?.text.length).toBe(MAX_SELECTION_TEXT)
    expect(got?.truncated).toBe(true)
    expect(got?.uri).toBe(uri)
  })

  it('selection shown in the chip: the restored selection comes first; not shown when removed or equal to the key already sent', () => {
    const live: ViewerSelection = { uri, text: 'abc', fromLine: 3, toLine: 4, truncated: false }
    const held: ViewerSelection = { ...live, text: 'held' }
    expect(effectiveSelection(undefined, live, undefined)).toBe(live)
    expect(effectiveSelection(held, live, selectionKey(held))).toBe(held)
    expect(effectiveSelection(undefined, live, selectionKey(live))).toBeNull()
    // Choosing again (when the key changes) it shows again.
    expect(effectiveSelection(undefined, { ...live, toLine: 5 }, selectionKey(live))).not.toBeNull()
    expect(effectiveSelection(undefined, null, undefined)).toBeNull()
  })

  it('the chip shows the name and lines', () => {
    const base: ViewerSelection = { uri: 'file:///x/%E3%81%82.ts', text: 't', fromLine: 3, toLine: 3, truncated: false }
    expect(selectionLabel(base)).toBe('あ.ts:3')
    expect(selectionLabel({ ...base, toLine: 9 })).toBe('あ.ts:3–9')
    expect(selectionLabel({ ...base, fromLine: null, toLine: null })).toBe('あ.ts')
  })
})

describe('main: re-validating the selection and embedding it in the prompt (item 97)', () => {
  const gate = {
    assertAllowed: (uri: string): string => {
      if (uri.includes('secret')) throw new Error('除外対象です')
      return decodeURIComponent(uri.replace('file://', ''))
    }
  }
  const selection: ViewerSelection = {
    uri: 'file:///work/src/a.ts',
    text: 'const a = 1',
    fromLine: 10,
    toLine: 12,
    truncated: false
  }

  it('a URI that matches an exclusion or a broken line is invalid-value; whitespace only is not attached', () => {
    expect(() => checkSelection({ ...selection, uri: 'file:///home/.secret/x' }, gate)).toThrow(
      'aios-reason:invalid-value'
    )
    expect(() => checkSelection({ ...selection, fromLine: 0 }, gate)).toThrow('aios-reason:invalid-value')
    expect(() => checkSelection({ ...selection, fromLine: 5, toLine: 4 }, gate)).toThrow(
      'aios-reason:invalid-value'
    )
    expect(() => checkSelection({ ...selection, toLine: null }, gate)).toThrow('aios-reason:invalid-value')
    expect(checkSelection({ ...selection, text: '  \n' }, gate)).toBeNull()
    const long = checkSelection({ ...selection, text: 'y'.repeat(MAX_SELECTION_TEXT + 1) }, gate)
    expect(long?.text.length).toBe(MAX_SELECTION_TEXT)
    expect(long?.truncated).toBe(true)
  })

  it('the heading is the path relative to cwd plus the lines; the body is wrapped in a longer fence than it', () => {
    expect(formatSelection(selection, '/work')).toBe(
      'Selected in src/a.ts (lines 10-12):\n```\nconst a = 1\n```'
    )
    expect(formatSelection({ ...selection, toLine: 10 }, '/elsewhere')).toContain(
      'Selected in /work/src/a.ts (line 10):'
    )
    expect(formatSelection({ ...selection, fromLine: null, toLine: null, truncated: true }, '/work')).toMatch(
      /^Selected in src\/a\.ts \[truncated\]:/
    )
    expect(fenceFor('a ```` b')).toBe('`````')
    const inner = formatSelection({ ...selection, text: 'x\n```\ny\n' }, '/work')
    expect(inner).toBe('Selected in src/a.ts (lines 10-12):\n````\nx\n```\ny\n````')
  })

  it('tool paths: absolute, file:, relative to cwd; empty, NUL, and other schemes are null', () => {
    expect(resolveToolPath('/a/b.ts', '/work')).toBe('/a/b.ts')
    expect(resolveToolPath('src/../b.ts', '/work')).toBe('/work/b.ts')
    expect(resolveToolPath('file:///a/%E3%81%82.md', '/work')).toBe('/a/あ.md')
    for (const bad of ['', '   ', 'a\0b', 'thread://x/y', 42, null, 'x'.repeat(5000)]) {
      expect(resolveToolPath(bad, '/work')).toBeNull()
    }
  })
})

describe('renderer: "open / close" from main (item 97)', () => {
  const open = { kind: 'open', threadId: 't1', uri: 'file:///a', highlight: null } as const
  const close = { kind: 'close', threadId: 't1', uri: 'file:///a' } as const

  it('ignored when the shown thread differs (main has written the memory)', () => {
    expect(planViewerCommand(open, { activeThreadId: 't2', selectedUri: null, dirty: false })).toEqual({
      kind: 'ignore'
    })
  })

  it('an open with page puts page in the plan, and without it nothing is put (TODO 1091 part 1)', () => {
    const state = { activeThreadId: 't1', selectedUri: null, dirty: false }
    expect(planViewerCommand({ ...open, page: 5 }, state)).toMatchObject({ kind: 'select', page: 5 })
    expect(planViewerCommand(open, state)).not.toHaveProperty('page')
  })

  it('open: with unsaved edits does not comply and restores the memory; complies for the same file', () => {
    expect(planViewerCommand(open, { activeThreadId: 't1', selectedUri: null, dirty: false })).toEqual({
      kind: 'select',
      uri: 'file:///a',
      highlight: null,
      line: null
    })
    expect(planViewerCommand(open, { activeThreadId: 't1', selectedUri: 'file:///b', dirty: true })).toEqual({
      kind: 'keep'
    })
    expect(planViewerCommand(open, { activeThreadId: 't1', selectedUri: 'file:///a', dirty: true })).toMatchObject({
      kind: 'select'
    })
  })

  it('open: an http(s) URL (openUrl) complies even with a draft (a Web tab does not break the file viewer)', () => {
    const url = { kind: 'open', threadId: 't1', uri: 'https://example.com/x', highlight: null } as const
    expect(planViewerCommand(url, { activeThreadId: 't1', selectedUri: 'file:///b', dirty: true })).toMatchObject({
      kind: 'select',
      uri: 'https://example.com/x'
    })
  })

  it('close: does not comply for a file different from the shown one or with unsaved edits', () => {
    expect(planViewerCommand(close, { activeThreadId: 't1', selectedUri: 'file:///a', dirty: false })).toEqual({
      kind: 'select',
      uri: null,
      highlight: null,
      line: null
    })
    expect(planViewerCommand(close, { activeThreadId: 't1', selectedUri: 'file:///b', dirty: false })).toEqual({
      kind: 'keep'
    })
    expect(planViewerCommand(close, { activeThreadId: 't1', selectedUri: 'file:///a', dirty: true })).toEqual({
      kind: 'keep'
    })
    expect(planViewerCommand(close, { activeThreadId: 't1', selectedUri: null, dirty: false })).toEqual({
      kind: 'ignore'
    })
  })
})
