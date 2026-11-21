// @vitest-environment jsdom
/**
 * TODO 461 (wave 23 bundle E): an image attached to the Composer shows a thumbnail on the left of its chip, and hovering shows a larger preview in a bubble.
 * The chip for a `reference` (path reference) is still 📄 + name as before, and no `<img>` is shown.
 *
 * Neither the real CLI nor the model is called. `window.aios` is a minimal fake with only the entry points touched at render time
 * (the same approach as `test/composer-tooltip.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, ThreadSummary } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(window as unknown as { aios: unknown }).aios = {
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '' },
    attachments: { pick: vi.fn(async () => []) },
    threads: { setPlanMode: vi.fn() },
    fs: {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const PNG: Attachment = {
  uri: 'aios-clipboard:1',
  name: 'Screenshot 2026-10-04 22.36.28.png',
  kind: 'image',
  mediaType: 'image/png',
  base64: 'iVBORw0KGgo=',
  bytes: 8
}
const REF: Attachment = {
  uri: 'file:///Users/me/notes.txt',
  name: 'notes.txt',
  kind: 'reference',
  mediaType: null,
  bytes: 10
}

const settle = (): Promise<void> => act(async () => {})

async function render(attachments: readonly Attachment[]): Promise<void> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const runtime = { state: 'idle', live: false } as unknown as ThreadSummary['runtime']
  useThreads.setState({
    drafts: { t1: '' },
    attachments: { t1: attachments },
    sending: new Set(),
    error: null,
    threadsById: { t1: { thread: {}, runtime, preview: null } as unknown as ThreadSummary }
  })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  act(() => root.render(createElement(Composer, { threadId: 't1' })))
  await settle()
}

async function hover(el: Element): Promise<void> {
  act(() => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
}

describe('添付の画像のサムネイル (TODO 461)', () => {
  it('画像の添付はチップの左に data URL のサムネイルを出す', async () => {
    await render([PNG])
    const chip = host.querySelector('.composer-attachments .chip.chip-image')!
    expect(chip).not.toBeNull()
    const img = chip.querySelector('img.attachment-thumb')!
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(img.getAttribute('alt')).toBe('Preview of Screenshot 2026-10-04 22.36.28.png')
    expect(chip.querySelector('.chip-name')?.textContent).toBe(PNG.name)
    // ✕ is as before
    expect(chip.querySelector('button')?.textContent).toBe('×')
    // No emoji is shown (the thumbnail takes its place)
    expect(chip.textContent).not.toContain('🖼')
  })

  it('reference の添付は 📄 + 名前のまま、<img> を出さない', async () => {
    await render([REF])
    const chip = host.querySelector('.composer-attachments .chip')!
    expect(chip.classList.contains('chip-image')).toBe(false)
    expect(chip.querySelector('img')).toBeNull()
    expect(chip.textContent).toContain('📄')
    expect(chip.textContent).toContain('notes.txt')
  })

  it('サムネイルに乗せると吹き出しで大きいプレビューと名前が出る', async () => {
    await render([PNG])
    const img = host.querySelector('img.attachment-thumb')!
    await hover(img)
    const tip = document.body.querySelector('[role="tooltip"].attachment-preview-tip')!
    expect(tip).not.toBeNull()
    const preview = tip.querySelector('img.attachment-preview')!
    expect(preview.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(tip.textContent).toContain(PNG.name)
  })

  it('✕ で外す', async () => {
    await render([PNG, REF])
    const button = host.querySelector('.chip.chip-image button')!
    act(() => (button as HTMLButtonElement).click())
    await settle()
    expect(host.querySelector('.chip.chip-image')).toBeNull()
    expect(host.querySelectorAll('.composer-attachments .chip').length).toBe(1)
  })
})

describe('attachmentThumbnailSrc / fitAttachmentPreview (TODO 461)', () => {
  it('画像で base64 と image/* の型があるときだけ data URL を作る', async () => {
    const { attachmentThumbnailSrc } = await import('../src/renderer/src/components/Composer.js')
    expect(attachmentThumbnailSrc(PNG)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(attachmentThumbnailSrc(REF)).toBeNull()
    expect(attachmentThumbnailSrc({ ...PNG, base64: undefined })).toBeNull()
    expect(attachmentThumbnailSrc({ ...PNG, base64: '' })).toBeNull()
    expect(attachmentThumbnailSrc({ ...PNG, mediaType: 'text/html' })).toBeNull()
    expect(attachmentThumbnailSrc({ ...PNG, mediaType: null })).toBeNull()
  })

  it('縦横比を保って 300px の正方形に収め、小さい画像は拡大しない', async () => {
    const { fitAttachmentPreview } = await import('../src/renderer/src/components/Composer.js')
    expect(fitAttachmentPreview({ width: 2880, height: 1800 })).toEqual({ width: 300, height: 188 })
    expect(fitAttachmentPreview({ width: 600, height: 1200 })).toEqual({ width: 150, height: 300 })
    expect(fitAttachmentPreview({ width: 120, height: 80 })).toEqual({ width: 120, height: 80 })
    // When it has not been read yet (0 × 0), fill the frame
    expect(fitAttachmentPreview({ width: 0, height: 0 })).toEqual({ width: 300, height: 300 })
  })

  it('窓に合わせた枠 (770): 横長・縦長・小さい画像・リサイズ', async () => {
    const { fitAttachmentPreview, composerPreviewBox } = await import('../src/renderer/src/components/Composer.js')
    const box = composerPreviewBox({ width: 1000, height: 800 })
    expect(box).toEqual({ width: 786, height: 602 })
    expect(fitAttachmentPreview({ width: 2880, height: 1800 }, box)).toEqual({ width: 786, height: 491 })
    expect(fitAttachmentPreview({ width: 600, height: 2400 }, box)).toEqual({ width: 151, height: 602 })
    expect(fitAttachmentPreview({ width: 400, height: 300 }, box)).toEqual({ width: 400, height: 300 })
    const small = composerPreviewBox({ width: 500, height: 400 })
    expect(fitAttachmentPreview({ width: 2880, height: 1800 }, small)).toEqual({ width: 386, height: 241 })
    expect(fitAttachmentPreview({ width: 0, height: 0 }, small)).toEqual(small)
  })

  it('名前の上に乗せても吹き出しが出る (770)', async () => {
    await render([PNG])
    await hover(host.querySelector('.chip-name')!)
    expect(document.body.querySelector('[role="tooltip"].attachment-preview-large')).not.toBeNull()
  })

  it('チップの上の空きが狭い窓では、画像をその空きに縮める (吹き出しがチップに被らない)', async () => {
    const { fitAttachmentPreview, composerPreviewBox } = await import('../src/renderer/src/components/Composer.js')
    const viewport = { width: 1000, height: 800 }
    // If there is enough room, the same as before
    expect(composerPreviewBox(viewport, 700)).toEqual(composerPreviewBox(viewport))
    // 200px of room: fit in 148px, which is 200 minus margin 14, frame 14, and name 24
    const tight = composerPreviewBox(viewport, 200)
    expect(tight.height).toBe(148)
    expect(fitAttachmentPreview({ width: 600, height: 2400 }, tight)).toEqual({ width: 37, height: 148 })
    // Even when extremely narrow, at least 1px
    expect(composerPreviewBox(viewport, 10).height).toBe(1)
  })

  it('× の上では吹き出しを出さない (錨はサムネイルと名前だけ)', async () => {
    await render([PNG])
    await hover(host.querySelector('.chip-image button')!)
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
    await hover(host.querySelector('img.attachment-thumb')!)
    expect(document.body.querySelector('[role="tooltip"].attachment-preview-large')).not.toBeNull()
  })

  it('CSP の img-src は data: を許している (サムネイルに追加の口が要らない)', () => {
    const html = readFileSync(join(__dirname, '../src/renderer/index.html'), 'utf8')
    const imgSrc = /img-src([^;]*);/.exec(html)?.[1] ?? ''
    expect(imgSrc.split(/\s+/)).toContain('data:')
  })
})
