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

describe('acceptViewModes (TODO 969、host 側)', () => {
  const uri = 'file:///tmp/a.md'

  it('描いているファイル宛ての、語彙の中の表示だけを受ける', () => {
    expect(acceptViewModes({ uri, modes: ['preview', 'source'], current: 'source' }, uri)).toEqual({
      uri,
      modes: ['preview', 'source'],
      current: 'source'
    })
  })

  it('別のファイル宛て・uri が文字列でない・modes が配列でないものは捨てる', () => {
    expect(acceptViewModes({ uri: 'file:///tmp/b.md', modes: ['preview', 'source'], current: 'preview' }, uri)).toBeNull()
    expect(acceptViewModes({ uri: 1, modes: ['preview'], current: 'preview' }, uri)).toBeNull()
    expect(acceptViewModes({ uri, modes: 'preview', current: 'preview' }, uri)).toBeNull()
  })

  it('語彙に無い値 (plugin の文言) と重複は落とし、上限で切る', () => {
    const report = acceptViewModes(
      { uri, modes: ['Save', 'preview', 'preview', '<b>x</b>', 'source', 42], current: 'preview' },
      uri
    )
    expect(report?.modes).toEqual(['preview', 'source'])
    const many = acceptViewModes({ uri, modes: Array(20).fill('source'), current: 'source' }, uri)
    expect(many?.modes.length).toBeLessThanOrEqual(MAX_VIEW_MODES)
  })

  it('current が一覧に無ければ null (どれも選ばれていない印)', () => {
    expect(acceptViewModes({ uri, modes: ['preview', 'source'], current: 'raw' }, uri)?.current).toBeNull()
    expect(acceptViewModes({ uri, modes: ['preview'], current: 'source' }, uri)?.current).toBeNull()
  })

  it('一時表示 (URI なし) は空文字の宛先で受ける', () => {
    expect(acceptViewModes({ uri: '', modes: ['preview', 'source'], current: 'preview' }, '')?.modes).toEqual([
      'preview',
      'source'
    ])
  })

  it('見出しに出すのは表示中のファイルの分で、2 つ以上選べるときだけ', () => {
    const two = { uri, modes: ['preview', 'source'] as const, current: 'preview' as const }
    expect(showsViewModes(two, uri)).toBe(true)
    expect(showsViewModes(two, 'file:///tmp/other.md')).toBe(false)
    expect(showsViewModes({ uri, modes: ['source'], current: 'source' }, uri)).toBe(false)
    expect(showsViewModes({ uri, modes: [], current: null }, uri)).toBe(false)
    expect(showsViewModes(null, uri)).toBe(false)
  })

  it('TODO 1215: .csv の Table / Text も語彙にあり、組は表示 (補間とは混ぜない)', () => {
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

describe('acceptSetViewMode (TODO 969、bridge 側)', () => {
  it('表示中のファイル宛て・語彙の中の値だけ', () => {
    expect(acceptSetViewMode({ uri: 'file:///a.md', mode: 'source' }, 'file:///a.md')).toBe('source')
    expect(acceptSetViewMode({ uri: 'file:///b.md', mode: 'source' }, 'file:///a.md')).toBeNull()
    expect(acceptSetViewMode({ uri: 'file:///a.md', mode: 'edit' }, 'file:///a.md')).toBeNull()
    expect(acceptSetViewMode({ uri: 'file:///a.md', mode: 'source' }, null)).toBeNull()
  })
})

describe('bridge: reportViewModes / onSetViewMode (TODO 969)', () => {
  it('知らせは view-modes で送り、host の set-view-mode は表示中のファイル宛てだけ届く', () => {
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

  it('変更が無いときはボタンも文字も出さない', () => {
    expect(saveIndicator(base)).toBe('none')
  })

  it('dirty のときだけ保存ボタン', () => {
    expect(saveIndicator({ ...base, dirty: true })).toBe('save')
  })

  it('dirty → saving → 保存の直後だけ saved → 時間が経てば none', () => {
    expect(saveIndicator({ ...base, dirty: true, saving: true })).toBe('saving')
    expect(saveIndicator({ ...base, justSaved: true })).toBe('saved')
    expect(saveIndicator({ ...base, justSaved: false })).toBe('none')
    expect(SAVED_FLASH_MS).toBe(1500)
  })

  it('保存の直後でも、また打てば保存ボタン (✅ より変更が先)', () => {
    expect(saveIndicator({ ...base, dirty: true, justSaved: true })).toBe('save')
  })

  it('読み取り専用 (editable でない) では保存まわりを出さない', () => {
    expect(saveIndicator({ editable: false, dirty: true, saving: true, justSaved: true })).toBe('none')
  })
})
