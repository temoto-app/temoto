/**
 * Item 319 (wave 17 bundle F): pasting an image from the clipboard as an attachment with ⌘V. The part that does not depend on the DOM or Electron.
 *
 * - `pasteAction`: a file with a path → attachment; text → default; an image without a path → main reads it
 * - `readClipboardImage`: replaces electron's `clipboard` (a W3C-style `read()`) and checks the empty case, the limit, and the type priority
 *
 * The real clipboard is not read. The model is not called either.
 */
import { describe, expect, it } from 'vitest'
import { pasteAction, type PasteData } from '../src/renderer/src/paste-image.js'
import {
  readClipboardImage,
  type ClipboardImageItem,
  type ClipboardImageSource
} from '../src/main/paste/clipboard-image.js'
import { CLIPBOARD_ATTACHMENT_PREFIX } from '../src/shared/thread.js'

interface FakeFile {
  readonly type: string
  readonly uri?: string
}

function data(input: { files?: FakeFile[]; text?: string; items?: { kind: string; type: string }[] }): PasteData {
  return {
    files: input.files ?? [],
    ...(input.items === undefined ? {} : { items: input.items }),
    getData: (format) => (format === 'text/plain' ? (input.text ?? '') : '')
  }
}
const uriFor = (file: unknown): string => (file as FakeFile).uri ?? ''

describe('pasteAction (項目 319)', () => {
  it('パスのあるファイル (Finder でコピー) は今までどおり添付の経路。文字 (ファイル名) があっても添付', () => {
    const action = pasteAction(
      data({ files: [{ type: 'image/png', uri: 'file:///Users/me/a.png' }, { type: '', uri: 'file:///Users/me/a.png' }], text: 'a.png' }),
      uriFor
    )
    expect(action).toEqual({ kind: 'attach', uris: ['file:///Users/me/a.png'] })
  })

  it('パスの無い画像 (スクリーンショット) は main に読ませる', () => {
    expect(pasteAction(data({ files: [{ type: 'image/png' }] }), uriFor)).toEqual({ kind: 'image' })
    // The same when files is empty but items has an image (the browser's "copy image")
    expect(pasteAction(data({ items: [{ kind: 'file', type: 'image/jpeg' }] }), uriFor)).toEqual({ kind: 'image' })
  })

  it('文字だけなら既定の貼り付け', () => {
    expect(pasteAction(data({ text: 'hello' }), uriFor)).toEqual({ kind: 'default' })
  })

  it('画像と文字が両方あるときは文字を優先する (画像は無視)', () => {
    expect(pasteAction(data({ files: [{ type: 'image/png' }], text: 'セルの値' }), uriFor)).toEqual({ kind: 'default' })
  })

  it('画像でないパスの無いファイル・何も無いときは既定', () => {
    expect(pasteAction(data({ files: [{ type: 'application/pdf' }] }), uriFor)).toEqual({ kind: 'default' })
    expect(pasteAction(data({ items: [{ kind: 'string', type: 'image/png' }] }), uriFor)).toEqual({ kind: 'default' })
    expect(pasteAction(data({}), uriFor)).toEqual({ kind: 'default' })
  })
})

/** A fake `ClipboardItem` whose `getType` returns a Blob. */
function item(payload: Record<string, Uint8Array>): ClipboardImageItem {
  return {
    types: Object.keys(payload),
    getType: async (type) => new Blob([payload[type] as BlobPart])
  }
}
function source(items: ClipboardImageItem[] | Error): ClipboardImageSource {
  return {
    read: async () => {
      if (items instanceof Error) throw items
      return items
    }
  }
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

describe('readClipboardImage (項目 319)', () => {
  it('PNG を base64 の画像添付にする。uri はファイルを指さない印', async () => {
    const result = await readClipboardImage(source([item({ 'image/png': PNG })]), 1024)
    if (!result.ok) throw new Error(result.reason)
    expect(result.attachment).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      name: 'image.png',
      bytes: PNG.length,
      base64: Buffer.from(PNG).toString('base64')
    })
    expect(result.attachment.uri.startsWith(CLIPBOARD_ATTACHMENT_PREFIX)).toBe(true)
    expect(result.outsideAllowed).toBe(false)
    // TODO 591: it does not point at a file, so main is the side that keeps the renderer's shrunken version.
    expect(result.keepsThumbnail).toBe(true)
  })

  it('同じ画像を複数の型で持つときは PNG を取る。TIFF だけ (送れない型) は空と同じ', async () => {
    const both = await readClipboardImage(
      source([item({ 'image/tiff': new Uint8Array([9, 9]), 'image/jpeg': new Uint8Array([7]), 'image/png': PNG })]),
      1024
    )
    expect(both.ok && both.attachment.mediaType).toBe('image/png')
    const jpeg = await readClipboardImage(source([item({ 'image/jpeg': new Uint8Array([7, 7]) })]), 1024)
    expect(jpeg.ok && jpeg.attachment.name).toBe('image.jpg')
    expect(await readClipboardImage(source([item({ 'image/tiff': new Uint8Array([9]) })]), 1024)).toEqual({
      ok: false,
      reason: 'paste-empty'
    })
  })

  it('画像が無い・0 バイト・読めないときは断る (投げない)', async () => {
    expect(await readClipboardImage(source([]), 1024)).toEqual({ ok: false, reason: 'paste-empty' })
    expect(await readClipboardImage(source([item({ 'text/plain': new Uint8Array([65]) })]), 1024)).toEqual({
      ok: false,
      reason: 'paste-empty'
    })
    expect(await readClipboardImage(source([item({ 'image/png': new Uint8Array() })]), 1024)).toEqual({
      ok: false,
      reason: 'paste-empty'
    })
    expect(await readClipboardImage(source(new Error('denied')), 1024)).toEqual({ ok: false, reason: 'paste-empty' })
  })

  it('上限 (Drop の画像添付と同じ) を超える画像は断る。ちょうど上限は通す', async () => {
    expect(await readClipboardImage(source([item({ 'image/png': PNG })]), PNG.length - 1)).toEqual({
      ok: false,
      reason: 'paste-too-large'
    })
    expect((await readClipboardImage(source([item({ 'image/png': PNG })]), PNG.length)).ok).toBe(true)
  })
})
