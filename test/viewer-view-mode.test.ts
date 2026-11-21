/**
 * @vitest-environment jsdom
 *
 * TODO 969 (wave 51 bundle B): the entry that shows the viewer's 'display switch' in the host's heading (ARCHITECTURE 7.4.12).
 * - `acceptViewModes` (host): checks the viewer's `view-modes` by vocabulary, destination, duplicates, and the cap.
 * - `acceptSetViewMode` (bridge): checks the host's `set-view-mode` by destination and vocabulary.
 * - bridge's `reportViewModes` / `onSetViewMode` ride on that shape over the port.
 * - display of the heading's save (`saveIndicator`): with no changes, nothing is shown; dirty shows the save button; while saving it shows that; only right after saving it shows ✅ Saved.
 *
 * Neither the model nor Electron is started.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_VIEW_MODES,
  acceptSetViewMode,
  acceptViewModes,
  isViewerDisplayMode,
  isViewerSheetMode,
  showsViewModes,
  viewModeGroup
} from '../src/shared/viewer-view-mode.js'
import { SAVED_FLASH_MS, saveIndicator } from '../src/renderer/src/viewer-save.js'
import { connect } from '../plugins/_shared/bridge.js'

describe('acceptViewModes (TODO 969, host side)', () => {
  const uri = 'file:///tmp/a.md'

  it('accepts only views within the vocabulary, addressed to the file being drawn', () => {
    expect(acceptViewModes({ uri, modes: ['preview', 'source'], current: 'source' }, uri)).toEqual({
      uri,
      modes: ['preview', 'source'],
      current: 'source'
    })
  })

  it('discards those addressed to another file, with a non-string uri, or with modes that is not an array', () => {
    expect(acceptViewModes({ uri: 'file:///tmp/b.md', modes: ['preview', 'source'], current: 'preview' }, uri)).toBeNull()
    expect(acceptViewModes({ uri: 1, modes: ['preview'], current: 'preview' }, uri)).toBeNull()
    expect(acceptViewModes({ uri, modes: 'preview', current: 'preview' }, uri)).toBeNull()
  })

  it('drops values not in the vocabulary (plugin wording) and duplicates, and cuts at the limit', () => {
    const report = acceptViewModes(
      { uri, modes: ['Save', 'preview', 'preview', '<b>x</b>', 'source', 42], current: 'preview' },
      uri
    )
    expect(report?.modes).toEqual(['preview', 'source'])
    const many = acceptViewModes({ uri, modes: Array(20).fill('source'), current: 'source' }, uri)
    expect(many?.modes.length).toBeLessThanOrEqual(MAX_VIEW_MODES)
  })

  it('null when current is not in the list (the mark for none selected)', () => {
    expect(acceptViewModes({ uri, modes: ['preview', 'source'], current: 'raw' }, uri)?.current).toBeNull()
    expect(acceptViewModes({ uri, modes: ['preview'], current: 'source' }, uri)?.current).toBeNull()
  })

  it('a temporary display (no URI) is accepted with an empty-string target', () => {
    expect(acceptViewModes({ uri: '', modes: ['preview', 'source'], current: 'preview' }, '')?.modes).toEqual([
      'preview',
      'source'
    ])
  })

  it('what the header shows is for the shown file, and only when two or more can be chosen', () => {
    const two = { uri, modes: ['preview', 'source'] as const, current: 'preview' as const }
    expect(showsViewModes(two, uri)).toBe(true)
    expect(showsViewModes(two, 'file:///tmp/other.md')).toBe(false)
    expect(showsViewModes({ uri, modes: ['source'], current: 'source' }, uri)).toBe(false)
    expect(showsViewModes({ uri, modes: [], current: null }, uri)).toBe(false)
    expect(showsViewModes(null, uri)).toBe(false)
  })

  it('TODO 1215: Table / Text of .csv are also in the vocabulary, and the set is a view (not mixed with interpolation)', () => {
    const csv = 'file:///tmp/a.csv'
    expect(acceptViewModes({ uri: csv, modes: ['table', 'text'], current: 'table' }, csv)).toEqual({
      uri: csv,
      modes: ['table', 'text'],
      current: 'table'
    })
    expect(viewModeGroup('table')).toBe('display')
    expect(viewModeGroup('text')).toBe('display')
    expect(acceptViewModes({ uri: csv, modes: ['table', 'nearest', 'text'], current: 'text' }, csv)?.modes).toEqual([
      'table',
      'text'
    ])
    expect(isViewerSheetMode('table')).toBe(true)
    expect(isViewerSheetMode('preview')).toBe(false)
    expect(isViewerDisplayMode('table')).toBe(false)
  })
})

describe('acceptSetViewMode (TODO 969, bridge side)', () => {
  it('only values in the vocabulary, addressed to the shown file', () => {
    expect(acceptSetViewMode({ uri: 'file:///a.md', mode: 'source' }, 'file:///a.md')).toBe('source')
    expect(acceptSetViewMode({ uri: 'file:///b.md', mode: 'source' }, 'file:///a.md')).toBeNull()
    expect(acceptSetViewMode({ uri: 'file:///a.md', mode: 'edit' }, 'file:///a.md')).toBeNull()
    expect(acceptSetViewMode({ uri: 'file:///a.md', mode: 'source' }, null)).toBeNull()
  })
})

describe('bridge: reportViewModes / onSetViewMode (TODO 969)', () => {
  it("the report is sent as view-modes, and the host's set-view-mode arrives only when addressed to the shown file", () => {
    const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), start: () => undefined }
    const bridge = connect('aios.markdown')
    const event = new MessageEvent('message')
    Object.defineProperty(event, 'ports', { value: [port] })
    Object.defineProperty(event, 'source', { value: window.parent })
    window.dispatchEvent(event)

    const uri = 'file:///tmp/a.md'
    bridge.reportViewModes(uri, ['preview', 'source'], 'preview')
    expect(port.postMessage).toHaveBeenCalledWith(
      { type: 'view-modes', uri, modes: ['preview', 'source'], current: 'preview' },
      []
    )

    const seen: string[] = []
    bridge.onSetViewMode((mode) => seen.push(mode))
    const deliver = (data: unknown): void => port.onmessage?.(new MessageEvent('message', { data }))
    // The resource has not arrived yet (no file is displayed), so it is discarded.
    deliver({ type: 'set-view-mode', uri, mode: 'source' })
    deliver({
      type: 'resource',
      uri,
      label: 'a.md',
      resource: { kind: 'text', text: '# a', truncated: false, size: 3 },
      editable: true,
      theme: 'light',
      locale: 'en'
    })
    deliver({ type: 'set-view-mode', uri, mode: 'source' })
    deliver({ type: 'set-view-mode', uri: 'file:///tmp/b.md', mode: 'preview' })
    deliver({ type: 'set-view-mode', uri, mode: 'bogus' })
    expect(seen).toEqual(['source'])
  })
})

describe('saveIndicator (TODO 969)', () => {
  const base = { editable: true, dirty: false, saving: false, justSaved: false }

  it('shows neither button nor text when there are no changes', () => {
    expect(saveIndicator(base)).toBe('none')
  })

  it('the save button only when dirty', () => {
    expect(saveIndicator({ ...base, dirty: true })).toBe('save')
  })

  it('dirty → saving → saved only right after saving → none after some time', () => {
    expect(saveIndicator({ ...base, dirty: true, saving: true })).toBe('saving')
    expect(saveIndicator({ ...base, justSaved: true })).toBe('saved')
    expect(saveIndicator({ ...base, justSaved: false })).toBe('none')
    expect(SAVED_FLASH_MS).toBe(1500)
  })

  it('even right after saving, typing again shows the save button (the change comes before ✅)', () => {
    expect(saveIndicator({ ...base, dirty: true, justSaved: true })).toBe('save')
  })

  it('shows nothing about saving in read-only mode (not editable)', () => {
    expect(saveIndicator({ editable: false, dirty: true, saving: true, justSaved: true })).toBe('none')
  })
})
