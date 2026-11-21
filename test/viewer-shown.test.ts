/**
 * TODO 1061 (3): the notice of 'what ViewerPane is showing in front now'. The renderer's assembly (`viewerShownReport`),
 * the box that does not resend the same value (`ViewerShownReporter`), and the re-check in main (`parseViewerShownReport`).
 */
import { describe, expect, it } from 'vitest'
import { clipShownSelection, parseViewerShownReport, MAX_SHOWN_ENTRY, MAX_SHOWN_SELECTION_TEXT, MAX_VIEWER_SHOWN_URI, type ViewerShownReport } from '../src/shared/viewer-shown.js'
import { MAX_TRANSIENT_FILE_NAME } from '../src/shared/plugin.js'
import { viewerShownReport, ViewerShownReporter } from '../src/renderer/src/viewer-shown.js'

describe('viewerShownReport (TODO 1061)', () => {
  const base = { activeThreadId: 'th1', selectedUri: null, hasTransient: false }
  it('decides in the order temporary display > Web > file > closed', () => {
    expect(viewerShownReport({ ...base, activeThreadId: null })).toBeNull()
    expect(viewerShownReport(base)).toEqual({ threadId: 'th1', kind: 'none', uri: null })
    expect(viewerShownReport({ ...base, selectedUri: 'file:///a.md' })).toEqual({ threadId: 'th1', kind: 'file', uri: 'file:///a.md' })
    expect(viewerShownReport({ ...base, selectedUri: 'https://e.example/' })).toEqual({
      threadId: 'th1',
      kind: 'web',
      uri: 'https://e.example/'
    })
    expect(viewerShownReport({ ...base, selectedUri: 'about:blank' })).toMatchObject({ kind: 'web' })
    expect(viewerShownReport({ ...base, selectedUri: 'file:///a.md', hasTransient: true })).toEqual({
      threadId: 'th1',
      kind: 'diff',
      uri: null
    })
  })

  it('TODO 1094: a temporary display of a file inside an archive is file + archive URI + inner path, not diff', () => {
    const zip = { ...base, selectedUri: 'file:///a.zip', hasTransient: true }
    expect(viewerShownReport({ ...zip, transientEntry: 'dir/b.txt' })).toEqual({
      threadId: 'th1',
      kind: 'file',
      uri: 'file:///a.zip',
      entry: 'dir/b.txt'
    })
    // The temporary diff view (with no path inside) is as before
    expect(viewerShownReport({ ...zip, transientEntry: null })).toEqual({ threadId: 'th1', kind: 'diff', uri: null })
    // If the path inside changes, it is sent again
    const sent: (ViewerShownReport | null)[] = []
    const reporter = new ViewerShownReporter((report) => sent.push(report))
    reporter.update({ ...zip, transientEntry: 'x' })
    reporter.update({ ...zip, transientEntry: 'x' })
    reporter.update({ ...zip, transientEntry: 'y' })
    expect(sent).toHaveLength(2)
  })

  it('sends only when it changes', () => {
    const sent: (ViewerShownReport | null)[] = []
    const reporter = new ViewerShownReporter((report) => sent.push(report))
    reporter.update(base)
    reporter.update(base)
    reporter.update({ ...base, selectedUri: 'file:///a.md' })
    reporter.update({ ...base, selectedUri: 'file:///a.md' })
    reporter.update({ ...base, activeThreadId: null })
    reporter.update({ ...base, activeThreadId: null })
    expect(sent).toEqual([
      { threadId: 'th1', kind: 'none', uri: null },
      { threadId: 'th1', kind: 'file', uri: 'file:///a.md' },
      null
    ])
  })
})

describe("parseViewerShownReport (TODO 1061, the renderer's value is re-validated)", () => {
  it("TODO 1094: a long path inside an archive also passes up to the renderer's limit (4096)", () => {
    expect(MAX_SHOWN_ENTRY).toBe(MAX_TRANSIENT_FILE_NAME)
    const entry = 'd/'.repeat(1500) + 'f.txt'
    expect(parseViewerShownReport({ threadId: 't', kind: 'file', uri: 'file:///a.zip', entry })).toMatchObject({ entry })
  })

  it('TODO 1094: entry only for file; empty, too long, or NUL is discarded (no page or selection is attached)', () => {
    const sel = { text: 'a', fromLine: 1, toLine: 1 }
    expect(parseViewerShownReport({ threadId: 't', kind: 'file', uri: 'file:///a.zip', entry: 'd/b.txt', page: 2, selection: sel })).toEqual({
      threadId: 't',
      kind: 'file',
      uri: 'file:///a.zip',
      entry: 'd/b.txt'
    })
    for (const entry of ['', 'x'.repeat(MAX_SHOWN_ENTRY + 1), 'a\0b', 5]) {
      expect(parseViewerShownReport({ threadId: 't', kind: 'file', uri: 'file:///a.zip', entry })).toEqual({
        threadId: 't',
        kind: 'file',
        uri: 'file:///a.zip'
      })
    }
    expect(parseViewerShownReport({ threadId: 't', kind: 'web', uri: 'https://e.example/', entry: 'x' })).toEqual({
      threadId: 't',
      kind: 'web',
      uri: 'https://e.example/'
    })
  })

  it('passes only the correct shape', () => {
    expect(parseViewerShownReport({ threadId: 't', kind: 'file', uri: 'file:///a' })).toEqual({
      threadId: 't',
      kind: 'file',
      uri: 'file:///a'
    })
    // A diff / none uri is discarded.
    expect(parseViewerShownReport({ threadId: 't', kind: 'diff', uri: 'file:///a' })).toEqual({ threadId: 't', kind: 'diff', uri: null })
    for (const bad of [
      null,
      'x',
      {},
      { threadId: '', kind: 'file', uri: 'file:///a' },
      { threadId: 't', kind: 'other', uri: 'file:///a' },
      { threadId: 't', kind: 'file', uri: null },
      { threadId: 't', kind: 'web', uri: '' },
      { threadId: 't', kind: 'web', uri: 'https://a/\0' },
      { threadId: 't', kind: 'file', uri: `file:///${'a'.repeat(MAX_VIEWER_SHOWN_URI)}` },
      { threadId: 'x'.repeat(201), kind: 'none', uri: null }
    ]) {
      expect(parseViewerShownReport(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull()
    }
  })
})

describe('TODO 1061 part 2: where the user is looking (PDF page, selection)', () => {
  const base = { activeThreadId: 'th1', selectedUri: 'file:///a.pdf', hasTransient: false }
  const sel = { uri: 'file:///a.pdf', text: 'hello', fromLine: 2, toLine: 3, truncated: false }

  it('renderer: attaches page / selection only for the shown file (a switching mismatch is discarded)', () => {
    expect(viewerShownReport({ ...base, page: { uri: 'file:///a.pdf', page: 4 } })).toEqual({
      threadId: 'th1',
      kind: 'file',
      uri: 'file:///a.pdf',
      page: 4
    })
    expect(
      viewerShownReport({ ...base, page: { uri: 'file:///old.pdf', page: 4 }, selection: { ...sel, uri: 'file:///old.pdf' } })
    ).toEqual({ threadId: 'th1', kind: 'file', uri: 'file:///a.pdf' })
    expect(viewerShownReport({ ...base, selection: sel })).toMatchObject({
      selection: { text: 'hello', fromLine: 2, toLine: 3, truncated: false }
    })
    const long = viewerShownReport({ ...base, selection: { ...sel, text: 'x'.repeat(MAX_SHOWN_SELECTION_TEXT + 10) } })
    expect(long?.selection?.text.length).toBe(MAX_SHOWN_SELECTION_TEXT)
    expect(long?.selection?.truncated).toBe(true)
  })

  it('resends when the page changes', () => {
    const sent: (ViewerShownReport | null)[] = []
    const reporter = new ViewerShownReporter((report) => sent.push(report))
    reporter.update({ ...base, page: { uri: 'file:///a.pdf', page: 1 } })
    reporter.update({ ...base, page: { uri: 'file:///a.pdf', page: 1 } })
    reporter.update({ ...base, page: { uri: 'file:///a.pdf', page: 2 } })
    expect(sent.map((r) => r?.page)).toEqual([1, 2])
  })

  it('main: parse re-validates page / selection and discards them for anything but file', () => {
    const good = { threadId: 't', kind: 'file', uri: 'file:///a.pdf', page: 3, selection: { text: 'abc', fromLine: 1, toLine: 1 } }
    expect(parseViewerShownReport(good)).toEqual({
      threadId: 't',
      kind: 'file',
      uri: 'file:///a.pdf',
      page: 3,
      selection: { text: 'abc', fromLine: 1, toLine: 1, truncated: false }
    })
    expect(parseViewerShownReport({ ...good, page: 0, selection: { text: 'abc', fromLine: 3, toLine: 1 } })).toEqual({
      threadId: 't',
      kind: 'file',
      uri: 'file:///a.pdf'
    })
    expect(parseViewerShownReport({ ...good, page: '3', selection: { text: '  ' } })).toEqual({
      threadId: 't',
      kind: 'file',
      uri: 'file:///a.pdf'
    })
    expect(parseViewerShownReport({ ...good, kind: 'web', uri: 'https://e.example/' })).toEqual({
      threadId: 't',
      kind: 'web',
      uri: 'https://e.example/'
    })
    const clipped = parseViewerShownReport({ ...good, selection: { text: 'y'.repeat(MAX_SHOWN_SELECTION_TEXT + 1) } })
    expect(clipped?.selection?.text.length).toBe(MAX_SHOWN_SELECTION_TEXT)
    expect(clipped?.selection?.truncated).toBe(true)
  })
})

describe('TODO 1091 part 2: diff selection', () => {
  const selection = { text: 'x'.repeat(5000), fromLine: null, toLine: null, truncated: false }

  it("cuts the temporary diff's selection at 4000 characters and attaches it; nothing when there is none", () => {
    const report = viewerShownReport({
      activeThreadId: 'th1',
      selectedUri: 'file:///a.md',
      hasTransient: true,
      transientSelection: selection
    })
    expect(report).toMatchObject({ kind: 'diff', uri: null, selection: { truncated: true } })
    expect(report?.selection?.text.length).toBe(4000)
    expect(
      viewerShownReport({ activeThreadId: 'th1', selectedUri: null, hasTransient: true, transientSelection: null })
    ).toEqual({ threadId: 'th1', kind: 'diff', uri: null })
  })

  it('re-validated in main: a diff selection only if the shape fits; the body is cut at 4000 characters', () => {
    const parsed = parseViewerShownReport({ threadId: 't', kind: 'diff', uri: 'x', selection })
    expect(parsed).toMatchObject({ kind: 'diff', uri: null, selection: { truncated: true } })
    expect(parsed?.selection?.text.length).toBe(4000)
    expect(parseViewerShownReport({ threadId: 't', kind: 'diff', uri: null, selection: { text: '  ' } })).toEqual({
      threadId: 't',
      kind: 'diff',
      uri: null
    })
    expect(
      parseViewerShownReport({ threadId: 't', kind: 'diff', uri: null, selection: { text: 'a', fromLine: 3, toLine: 1 } })
    ).toEqual({ threadId: 't', kind: 'diff', uri: null })
  })
})

describe('clipShownSelection (TODO 1091)', () => {
  it('cuts and sets truncated when over the limit, and leaves as is otherwise', () => {
    const long = { text: 'x'.repeat(MAX_SHOWN_SELECTION_TEXT + 5), fromLine: 1, toLine: 2, truncated: false }
    const clipped = clipShownSelection(long)
    expect(clipped.text).toHaveLength(MAX_SHOWN_SELECTION_TEXT)
    expect(clipped.truncated).toBe(true)
    const short = { text: 'abc', fromLine: null, toLine: null, truncated: true }
    expect(clipShownSelection(short)).toEqual(short)
  })
})
