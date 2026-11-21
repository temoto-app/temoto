// @vitest-environment jsdom
/**
 * Item 319 (wave 17 bundle F): sorts ⌘V in the prompt field into three cases in the real Composer.
 *
 * - A file with a path -> `addAttachment` as before (the same route as Drop)
 * - An image without a path -> `window.aios.paste.image` (main reads it) -> a chip with a sequential name
 * - Text only / text and image -> the default paste (no `preventDefault`)
 *
 * The preload is a fake. It touches neither the real clipboard, Electron, nor the model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachOutcome } from '../src/renderer/src/threadStore.js'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AttachmentResolution } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const addAttachment = vi.fn<(threadId: string, uri: string) => Promise<AttachOutcome>>(async () => ({ ok: true, outside: null }))
let clipboardResults: AttachmentResolution[] = []
const pasteImage = vi.fn(async (): Promise<AttachmentResolution> => {
  const next = clipboardResults.shift()
  if (next === undefined) throw new Error('no fake result')
  return next
})

let root: Root
let host: HTMLDivElement

function clipped(n: number): AttachmentResolution {
  return {
    ok: true,
    attachment: {
      uri: `aios-clipboard:${n}`,
      name: 'image.png',
      kind: 'image',
      mediaType: 'image/png',
      base64: 'AAAA',
      bytes: 3
    },
    outsideAllowed: false,
    keepsThumbnail: true
  }
}

beforeEach(() => {
  addAttachment.mockClear()
  pasteImage.mockClear()
  clipboardResults = []
  ;(window as unknown as { aios: unknown }).aios = {
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '' },
    attachments: { pick: vi.fn(async () => []) },
    paste: { image: pasteImage },
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

async function render(): Promise<HTMLTextAreaElement> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useThreads.setState({ addAttachment, drafts: {}, attachments: {}, error: null })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  act(() => root.render(createElement(Composer, { threadId: 't1' })))
  return host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
}

interface FakeClipboard {
  files: { type: string; uri?: string }[]
  items: { kind: string; type: string }[]
  getData(format: string): string
}

function clipboard(input: { files?: { type: string; uri?: string }[]; text?: string }): FakeClipboard {
  const files = input.files ?? []
  return {
    files,
    items: [
      ...files.map((file) => ({ kind: 'file', type: file.type })),
      ...(input.text === undefined ? [] : [{ kind: 'string', type: 'text/plain' }])
    ],
    getData: (format) => (format === 'text/plain' ? (input.text ?? '') : '')
  }
}

function paste(target: Element, data: FakeClipboard): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const settle = (): Promise<void> => act(async () => {})
const chips = (): string[] =>
  Array.from(host.querySelectorAll('.composer-attachments .chip')).map((chip) => chip.textContent ?? '')

describe('⌘V の振り分け (項目 319)', () => {
  it('パスのあるファイル (Finder でコピー) は今までどおり添付の経路', async () => {
    const textarea = await render()
    const event = paste(textarea, clipboard({ files: [{ type: 'image/png', uri: 'file:///Users/me/a.png' }], text: 'a.png' }))
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(addAttachment.mock.calls).toEqual([['t1', 'file:///Users/me/a.png']])
    expect(pasteImage).not.toHaveBeenCalled()
  })

  it('パスの無い画像は main に読ませて、連番の名前のチップになる', async () => {
    clipboardResults = [clipped(1), clipped(2)]
    const textarea = await render()
    const first = paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    expect(first.defaultPrevented).toBe(true)
    expect(pasteImage).toHaveBeenCalledTimes(2)
    expect(addAttachment).not.toHaveBeenCalled()
    expect(chips()).toEqual([
      expect.stringContaining('Pasted image 1.png'),
      expect.stringContaining('Pasted image 2.png')
    ])
    // TODO 461: an image chip shows a thumbnail (an `<img>` with `data:`) in place of 🖼.
    const thumb = host.querySelector('.composer-attachments .chip.chip-image img.attachment-thumb')
    expect(thumb?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  })

  it('途中の 1 枚を ✕ しても番号は詰めない。全部外すと 1 に戻る', async () => {
    clipboardResults = [clipped(1), clipped(2), clipped(3), clipped(4)]
    const textarea = await render()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    act(() => useThreads.getState().removeAttachment('t1', 'aios-clipboard:1'))
    paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    expect(chips().map((c) => c.match(/Pasted image \d/)?.[0])).toEqual(['Pasted image 2', 'Pasted image 3'])
    act(() => useThreads.setState({ attachments: {} }))
    paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    expect(chips().map((c) => c.match(/Pasted image \d/)?.[0])).toEqual(['Pasted image 1'])
  })

  it('main が断った (空・大きすぎ) ときはチップを足さず、理由コードを error に出す', async () => {
    clipboardResults = [{ ok: false, reason: 'paste-too-large' }]
    const textarea = await render()
    paste(textarea, clipboard({ files: [{ type: 'image/png' }] }))
    await settle()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    expect(chips()).toEqual([])
    expect(useThreads.getState().error).toBe('paste-too-large')
  })

  it('文字だけ・文字と画像の両方は既定の貼り付け (どちらの口も呼ばない)', async () => {
    const textarea = await render()
    const text = paste(textarea, clipboard({ text: 'hello' }))
    const both = paste(textarea, clipboard({ files: [{ type: 'image/png' }], text: 'セルの値' }))
    await settle()
    expect(text.defaultPrevented).toBe(false)
    expect(both.defaultPrevented).toBe(false)
    expect(pasteImage).not.toHaveBeenCalled()
    expect(addAttachment).not.toHaveBeenCalled()
  })
})
