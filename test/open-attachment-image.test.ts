import { beforeEach, describe, expect, it } from 'vitest'
import { imageNameFor, openComposerImage, openSentImage, parseImageDataUrl } from '../src/renderer/src/open-attachment-image.js'
import { useStore } from '../src/renderer/src/store.js'

// A 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('openComposerImage / openSentImage (TODO 971)', () => {
  beforeEach(() => {
    useStore.setState({ transient: null })
  })

  it('imageNameFor: adds an extension from the type when there is none', () => {
    expect(imageNameFor('shot', 'image/jpeg')).toBe('shot.jpg')
    expect(imageNameFor('', null)).toBe('image.png')
    expect(imageNameFor('a.webp', 'image/png')).toBe('a.webp')
  })

  it('parseImageDataUrl: image data URLs only', () => {
    expect(parseImageDataUrl(`data:image/png;base64,${PNG}`)?.bytes.byteLength).toBeGreaterThan(0)
    expect(parseImageDataUrl('data:text/html;base64,AAAA')).toBeNull()
    expect(parseImageDataUrl('https://x/y.png')).toBeNull()
  })

  it('a paste without a URI creates no file and goes to a temporary display', () => {
    const ok = openComposerImage({
      uri: 'aios-clipboard:1',
      name: 'pasted',
      kind: 'image',
      mediaType: 'image/png',
      base64: PNG,
      bytes: 70
    })
    expect(ok).toBe(true)
    const transient = useStore.getState().transient
    expect(transient?.kind).toBe('file')
    if (transient?.kind === 'file') expect(transient.name).toBe('pasted.png')
  })

  it('does not open a paste without a body', () => {
    expect(
      openComposerImage({ uri: 'aios-clipboard:1', name: 'x', kind: 'image', mediaType: 'image/png', bytes: 0 })
    ).toBe(false)
    expect(useStore.getState().transient).toBeNull()
  })

  it('for a sent image with only a thumbnail, puts the thumbnail in a temporary display; opens nothing when there is nothing', () => {
    expect(openSentImage({ name: 'p.png', thumbnail: `data:image/png;base64,${PNG}` })).toBe(true)
    expect(useStore.getState().transient?.kind).toBe('file')
    useStore.setState({ transient: null })
    expect(openSentImage({ name: 'p.png' })).toBe(false)
    expect(useStore.getState().transient).toBeNull()
  })
})
