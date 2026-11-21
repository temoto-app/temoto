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

describe('pasteAction (item 319)', () => {
  it('a file with a path (copied in Finder) goes the attachment route as before; also attached when there is text (the file name)', () => {
    const action = pasteAction(
      data({ files: [{ type: 'image/png', uri: 'file:///Users/me/a.png' }, { type: '', uri: 'file:///Users/me/a.png' }], text: 'a.png' }),
      uriFor
    )
    expect(action).toEqual({ kind: 'attach', uris: ['file:///Users/me/a.png'] })
  })

  it('an image without a path (a screenshot) is read by main', () => {
    expect(pasteAction(data({ files: [{ type: 'image/png' }] }), uriFor)).toEqual({ kind: 'image' })
    // The same when files is empty but items has an image (the browser's "copy image")
    expect(pasteAction(data({ items: [{ kind: 'file', type: 'image/jpeg' }] }), uriFor)).toEqual({ kind: 'image' })
  })

  it('default paste when there is only text', () => {
    expect(pasteAction(data({ text: 'hello' }), uriFor)).toEqual({ kind: 'default' })
  })

  it('when both image and text exist, prefers text (the image is ignored)', () => {
    expect(pasteAction(data({ files: [{ type: 'image/png' }], text: 'セルの値' }), uriFor)).toEqual({ kind: 'default' })
  })

  it('default for a non-image file without a path and when there is nothing', () => {
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

describe('readClipboardImage (item 319)', () => {
  it('makes a PNG a base64 image attachment; the uri is a mark that does not point to a file', async () => {
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

  it('takes PNG when the same image is held in several types; TIFF only (an unsendable type) is the same as empty', async () => {
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

  it('refuses (does not throw) when there is no image, 0 bytes, or unreadable', async () => {
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

  it('refuses images over the limit (same as the drop image attachment); exactly the limit passes', async () => {
    expect(await readClipboardImage(source([item({ 'image/png': PNG })]), PNG.length - 1)).toEqual({
      ok: false,
      reason: 'paste-too-large'
    })
    expect((await readClipboardImage(source([item({ 'image/png': PNG })]), PNG.length)).ok).toBe(true)
  })
})
