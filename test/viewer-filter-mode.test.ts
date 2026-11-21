/**
 * @vitest-environment jsdom
 *
 * TODO 1200 (wave 81 bundle C): moved the switch of image / video viewer interpolation (Nearest / Bilinear) to the host's heading (ARCHITECTURE 7.4.12).
 * A plugin declares the set of interpolations with `view-modes`, the host draws it as `ViewerModeSwitch` (the same `SegmentedControl` as the Model choice in Composer),
 * and the chosen value is returned to the plugin with `set-view-mode`. The plugin only switches `image-rendering`. Here it checks the round trip:
 * declare -> host check and draw -> choice -> plugin applies, and the default Nearest (not remembered).
 *
 * Neither the model nor Electron is started.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  VIEWER_FILTER_MODES,
  acceptSetViewMode,
  acceptViewModes,
  showsViewModes,
  viewModeGroup
} from '../src/shared/viewer-view-mode.js'
import { ViewerModeSwitch } from '../src/renderer/src/components/ViewerModeSwitch.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { DEFAULT_FILTER, connectFilterModes, filterRendering, mountZoom, reportFilterModes } from '../plugins/_shared/zoom.js'
import { connect } from '../plugins/_shared/bridge.js'
import { VIEWER_DICTIONARIES } from '../plugins/_shared/i18n.js'

beforeAll(() => {
  useLocale.setState({ resolved: 'en' })
})

describe('語彙の組 (host 側の検め)', () => {
  const uri = 'file:///tmp/a.png'

  it('補間の組 (nearest / bilinear) を受ける', () => {
    expect(acceptViewModes({ uri, modes: ['nearest', 'bilinear'], current: 'nearest' }, uri)).toEqual({
      uri,
      modes: ['nearest', 'bilinear'],
      current: 'nearest'
    })
    expect(viewModeGroup('nearest')).toBe('filter')
    expect(viewModeGroup('bilinear')).toBe('filter')
    expect(viewModeGroup('preview')).toBe('display')
  })

  it('1 通に 2 つの組は混ぜない (先頭の組と違う値は落とす)', () => {
    const report = acceptViewModes({ uri, modes: ['nearest', 'source', 'bilinear', 'preview'], current: 'source' }, uri)
    expect(report?.modes).toEqual(['nearest', 'bilinear'])
    expect(report?.current).toBeNull()
    expect(acceptViewModes({ uri, modes: ['preview', 'nearest', 'source'], current: 'preview' }, uri)?.modes).toEqual([
      'preview',
      'source'
    ])
  })

  it('一時表示 (書庫の中の画像、URI なし) も空文字の宛先で受ける', () => {
    const report = acceptViewModes({ uri: '', modes: ['nearest', 'bilinear'], current: 'bilinear' }, '')
    expect(showsViewModes(report, '')).toBe(true)
    expect(acceptSetViewMode({ uri: '', mode: 'bilinear' }, '')).toBe('bilinear')
  })
})

describe('ViewerModeSwitch で補間を描く (Model の選択と同じ部品)', () => {
  it('SegmentedControl の radiogroup に Nearest / Bilinear を並べ、読み上げ名は「補間」、説明は title', () => {
    const html = renderToStaticMarkup(
      createElement(ViewerModeSwitch, {
        report: { uri: 'file:///tmp/a.png', modes: ['nearest', 'bilinear'], current: 'nearest' },
        onChange: () => undefined
      })
    )
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const group = doc.querySelector('[role="radiogroup"]')
    expect(group?.className).toBe('segmented viewer-mode-switch')
    expect(group?.getAttribute('aria-label')).toBe('Interpolation')
    const buttons = Array.from(doc.querySelectorAll('button[role="radio"]'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Nearest', 'Bilinear'])
    expect(buttons.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(buttons[0]?.className).toBe('on')
    expect(buttons[0]?.getAttribute('title')).toBe('Enlarge without blurring the pixels')
    expect(buttons[1]?.getAttribute('title')).toBe('Smooth interpolation')
  })

  it('Source / Preview は従来どおり「View」で title なし', () => {
    const html = renderToStaticMarkup(
      createElement(ViewerModeSwitch, {
        report: { uri: 'file:///tmp/a.md', modes: ['preview', 'source'], current: 'source' },
        onChange: () => undefined
      })
    )
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('View')
    expect(Array.from(doc.querySelectorAll('button')).some((b) => b.hasAttribute('title'))).toBe(false)
  })
})

describe('mountZoom: 補間は host から受け、帯には描かない', () => {
  function mount(): { bar: HTMLElement; img: HTMLImageElement; zoom: ReturnType<typeof mountZoom> } {
    const bar = document.createElement('div')
    const stage = document.createElement('div')
    const img = document.createElement('img')
    stage.append(img)
    document.body.append(bar, stage)
    return { bar, img, zoom: mountZoom(bar, stage, img) }
  }

  it('帯は +/- と倍率だけ (Nearest / Bilinear のボタンは無い)', () => {
    const { bar } = mount()
    expect(Array.from(bar.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['−', '100%', '+'])
    expect(bar.textContent).not.toMatch(/Nearest|Bilinear/)
  })

  it('既定は Nearest (pixelated)。setFilter で Bilinear (auto)、開き直すと Nearest に戻る (記憶しない)', () => {
    expect(DEFAULT_FILTER).toBe('nearest')
    expect(filterRendering('nearest')).toBe('pixelated')
    expect(filterRendering('bilinear')).toBe('auto')
    const first = mount()
    expect(first.zoom.filter).toBe('nearest')
    first.zoom.setNatural(16, 16)
    expect(first.img.style.imageRendering).toBe('pixelated')
    first.zoom.setFilter('bilinear')
    expect(first.zoom.filter).toBe('bilinear')
    expect(first.img.style.imageRendering).toBe('auto')
    // Even if the size is known later (video loadedmetadata), the chosen interpolation is kept
    first.zoom.setNatural(32, 32)
    expect(first.img.style.imageRendering).toBe('auto')
    const second = mount()
    second.zoom.setNatural(16, 16)
    expect(second.zoom.filter).toBe('nearest')
    expect(second.img.style.imageRendering).toBe('pixelated')
  })

  it('大きさが分かる前に選ばれた補間も、分かった時に当たる', () => {
    const { img, zoom } = mount()
    zoom.setFilter('bilinear')
    zoom.setNatural(400, 300)
    expect(img.style.imageRendering).toBe('auto')
  })

  it('plugin の辞書から補間の文言が消えている (host の辞書へ移った)', () => {
    for (const dict of Object.values(VIEWER_DICTIONARIES)) {
      expect(Object.keys(dict).filter((k) => /Nearest|Bilinear/.test(k))).toEqual([])
    }
  })
})

describe('往復: 申告 → host → set-view-mode → plugin', () => {
  it('reportFilterModes が補間の組を申告し、host が選んだ値が plugin の setFilter まで届く', () => {
    const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), start: () => undefined }
    const bridge = connect('aios.image')
    const event = new MessageEvent('message')
    Object.defineProperty(event, 'ports', { value: [port] })
    Object.defineProperty(event, 'source', { value: window.parent })
    window.dispatchEvent(event)
    const deliver = (data: unknown): void => port.onmessage?.(new MessageEvent('message', { data }))

    const uri = 'file:///tmp/dot.png'
    deliver({
      type: 'resource',
      uri,
      label: 'dot.png',
      resource: { kind: 'binary', resourceUrl: 'aios-res://x', size: 10 },
      editable: false,
      theme: 'light',
      locale: 'en'
    })
    const bar = document.createElement('div')
    const stage = document.createElement('div')
    const img = document.createElement('img')
    stage.append(img)
    const zoom = mountZoom(bar, stage, img)
    zoom.setNatural(16, 16)
    // The same one line as image / video (review Y: the record and the handler were moved to `connectFilterModes` in zoom.ts)
    const showFilterModes = connectFilterModes(bridge)
    const lastReport = (): { type: string } | undefined =>
      port.postMessage.mock.calls.map((call) => call[0] as { type: string }).filter((m) => m.type === 'view-modes').at(-1)
    const viewModesCount = (): number =>
      port.postMessage.mock.calls.filter((call) => (call[0] as { type: string }).type === 'view-modes').length

    // 1) Declare: Nearest right after opening
    showFilterModes(uri, zoom)
    const first = lastReport()
    expect(first).toEqual({ type: 'view-modes', uri, modes: [...VIEWER_FILTER_MODES], current: 'nearest' })

    // 2) Host: check it and show it in the heading
    const report = acceptViewModes(first as { uri?: unknown; modes?: unknown; current?: unknown }, uri)
    expect(showsViewModes(report, uri)).toBe(true)
    expect(report?.current).toBe('nearest')

    // 3) Choice: the host's set-view-mode reaches the plugin, image-rendering changes, and it declares again
    deliver({ type: 'set-view-mode', uri, mode: 'bilinear' })
    expect(img.style.imageRendering).toBe('auto')
    const again = port.postMessage.mock.calls.map((call) => call[0] as { type: string }).filter((m) => m.type === 'view-modes').at(-1)
    expect(again).toEqual({ type: 'view-modes', uri, modes: ['nearest', 'bilinear'], current: 'bilinear' })

    // A value from a set not declared (Source), or one addressed to another file, does not arrive
    const before = viewModesCount()
    deliver({ type: 'set-view-mode', uri, mode: 'source' })
    expect(img.style.imageRendering).toBe('auto')
    // review Y: a dropped choice is re-sent with the display last declared for that file, so the host's heading comes back (the host does not move the mark optimistically,
    // but when it did, it matches the viewer's current value).
    expect(viewModesCount()).toBe(before + 1)
    const restored = acceptViewModes(lastReport() as { uri?: unknown; modes?: unknown; current?: unknown }, uri)
    expect(restored?.current).toBe('bilinear')
    // Addressed to a file not declared, it is not re-sent either (the host does not draw that file)
    deliver({ type: 'set-view-mode', uri: 'file:///tmp/other.png', mode: 'nearest' })
    expect(img.style.imageRendering).toBe('auto')
    expect(viewModesCount()).toBe(before + 1)

    // With an empty list (cannot open), no switch is shown
    showFilterModes(uri, null)
    const cleared = lastReport()
    expect(showsViewModes(acceptViewModes(cleared as { uri?: unknown; modes?: unknown; current?: unknown }, uri), uri)).toBe(false)
    deliver({ type: 'set-view-mode', uri, mode: 'nearest' })
    expect(img.style.imageRendering).toBe('auto')
    // The empty list is re-sent for a dropped Nearest choice too (the switch does not come back in the heading)
    expect(showsViewModes(acceptViewModes(lastReport() as { uri?: unknown; modes?: unknown; current?: unknown }, uri), uri)).toBe(false)
  })

  it('reportFilterModes は拡縮が無ければ空の一覧を申告する', () => {
    const reportViewModes = vi.fn()
    reportFilterModes({ reportViewModes }, 'file:///tmp/x.png', null)
    expect(reportViewModes).toHaveBeenCalledWith('file:///tmp/x.png', [], DEFAULT_FILTER)
  })
})
