import { beforeEach, describe, expect, it } from 'vitest'
import { imageNameFor, openComposerImage, openSentImage, parseImageDataUrl } from '../src/renderer/src/open-attachment-image.js'
import { useStore } from '../src/renderer/src/store.js'

// A 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('openComposerImage / openSentImage (TODO 971)', () => {
  beforeEach(() => {
    useStore.setState({ transient: null })
  })

  it('imageNameFor: 拡張子が無ければ型から足す', () => {
    expect(imageNameFor('shot', 'image/jpeg')).toBe('shot.jpg')
    expect(imageNameFor('', null)).toBe('image.png')
    expect(imageNameFor('a.webp', 'image/png')).toBe('a.webp')
  })

  it('parseImageDataUrl: 画像の data URL だけ', () => {
    expect(parseImageDataUrl(`data:image/png;base64,${PNG}`)?.bytes.byteLength).toBeGreaterThan(0)
    expect(parseImageDataUrl('data:text/html;base64,AAAA')).toBeNull()
    expect(parseImageDataUrl('https://x/y.png')).toBeNull()
  })

  it('URI の無い貼り付けはファイルを作らず一時表示に載せる', () => {
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

  it('本体の無い貼り付けは開かない', () => {
    expect(
      openComposerImage({ uri: 'aios-clipboard:1', name: 'x', kind: 'image', mediaType: 'image/png', bytes: 0 })
    ).toBe(false)
    expect(useStore.getState().transient).toBeNull()
  })

  it('送信済みで縮小版だけの画像は縮小版を一時表示に載せる。何も無ければ開かない', () => {
    expect(openSentImage({ name: 'p.png', thumbnail: `data:image/png;base64,${PNG}` })).toBe(true)
    expect(useStore.getState().transient?.kind).toBe('file')
    useStore.setState({ transient: null })
    expect(openSentImage({ name: 'p.png' })).toBe(false)
    expect(useStore.getState().transient).toBeNull()
  })
})
