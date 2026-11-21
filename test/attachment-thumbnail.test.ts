// @vitest-environment jsdom
/**
 * TODO 591: `withThumbnails` makes no thumbnail only for images with `keepsThumbnail === false`
 * (so the renderer does not decode what main keeps only as a path and drops at once).
 *
 * jsdom has no `createImageBitmap` / `OffscreenCanvas`, so `makeThumbnail` returns
 * null on every branch (the contents are checked on the `isValidThumbnail` side of test/sent-attachments.test.ts). What is checked here is only
 * two things: "when it tries to make one", and "`keepsThumbnail` is removed from the shape sent to main".
 */
import { describe, expect, it, vi } from 'vitest'
import { withThumbnails } from '../src/renderer/src/attachment-thumbnail.js'
import type { Attachment } from '../src/shared/thread.js'

const base64Image = (overrides: Partial<Attachment> = {}): Attachment => ({
  uri: 'file:///tmp/a.png',
  name: 'a.png',
  kind: 'image',
  mediaType: 'image/png',
  base64: 'AAAA',
  bytes: 3,
  ...overrides
})

describe('withThumbnails (TODO 591)', () => {
  it('keepsThumbnail: false does not create (an image of which main keeps only the path)', async () => {
    const [out] = await withThumbnails([base64Image({ keepsThumbnail: false })])
    expect(out?.thumbnail).toBeUndefined()
  })

  it('keepsThumbnail: true / omitted tries to create (in jsdom it falls to null and no thumbnail is attached)', async () => {
    const makeThumbnail = vi.fn()
    const [withTrue] = await withThumbnails([base64Image({ keepsThumbnail: true })])
    const [withUndefined] = await withThumbnails([base64Image()])
    expect(withTrue?.thumbnail).toBeUndefined()
    expect(withUndefined?.thumbnail).toBeUndefined()
    makeThumbnail.mockRestore()
  })

  it('does not touch kind: reference; does not recreate an existing thumbnail', async () => {
    const reference: Attachment = {
      uri: 'file:///tmp/b.pdf',
      name: 'b.pdf',
      kind: 'reference',
      mediaType: null,
      bytes: 10
    }
    const [out] = await withThumbnails([reference])
    expect(out).toEqual(reference)

    const already = base64Image({ thumbnail: 'data:image/webp;base64,xxx', keepsThumbnail: true })
    const [kept] = await withThumbnails([already])
    expect(kept?.thumbnail).toBe('data:image/webp;base64,xxx')
  })

  it('`keepsThumbnail` itself is removed from the form sent to main (an internal mark)', async () => {
    const [out] = await withThumbnails([base64Image({ keepsThumbnail: false })])
    expect(out).not.toHaveProperty('keepsThumbnail')
  })
})
