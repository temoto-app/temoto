// @vitest-environment jsdom
/**
 * TODO 876: local images in an answer. Before rendering, the src is set aside (so a load that CSP would block is not started),
 * and after rendering the aios-res:// URL that main issues is applied. An image that was refused turns into its alt text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalImageCache,
  deferLocalImages,
  isLocalImageSrc,
  resolveLocalImages
} from '../src/renderer/src/markdown-images.js'

const timelineImage = vi.fn<(threadId: string, src: string) => Promise<string | null>>()

beforeEach(() => {
  clearLocalImageCache()
  timelineImage.mockReset()
  ;(window as unknown as { aios?: unknown }).aios = { threads: { timelineImage } }
})

afterEach(() => {
  delete (window as unknown as { aios?: unknown }).aios
})

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

describe('isLocalImageSrc', () => {
  it('local: absolute, relative, ~/, file:. outside: http(s), data:, aios-res:, //', () => {
    for (const src of ['/abs/x.png', 'img/x.png', './x.png', '~/x.png', 'file:///abs/x.png']) {
      expect(isLocalImageSrc(src)).toBe(true)
    }
    for (const src of [
      'https://a/x.png',
      'http://a/x.png',
      'data:image/png;base64,AA',
      'aios-res://local/t/x',
      '//a/x.png',
      '',
      '#x'
    ]) {
      expect(isLocalImageSrc(src)).toBe(false)
    }
  })
})

describe('deferLocalImages', () => {
  it('a local src is moved to data-local-src and external images are untouched', () => {
    const out = deferLocalImages('<p><img src="/abs/x.png" alt="a"><img src="https://e.com/y.png" alt="b"></p>')
    const doc = new DOMParser().parseFromString(out, 'text/html')
    const [local, remote] = Array.from(doc.querySelectorAll('img'))
    expect(local?.getAttribute('src')).toBeNull()
    expect(local?.getAttribute('data-local-src')).toBe('/abs/x.png')
    expect(remote?.getAttribute('src')).toBe('https://e.com/y.png')
  })

  it('with no images the input is returned as is', () => {
    const html = '<p>text</p>'
    expect(deferLocalImages(html)).toBe(html)
  })
})

describe('resolveLocalImages', () => {
  function mount(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = deferLocalImages(html)
    document.body.append(host)
    return host
  }

  it('when main returns a URL it is applied to src', async () => {
    timelineImage.mockResolvedValue('aios-res://local/' + 'a'.repeat(32) + '/x.png')
    const host = mount('<img src="/abs/x.png" alt="a">')
    resolveLocalImages(host, 't1', () => true)
    await flush()
    expect(timelineImage).toHaveBeenCalledWith('t1', '/abs/x.png')
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^aios-res:\/\/local\//)
    host.remove()
  })

  it('a refused image becomes its alt text (no broken image is shown)', async () => {
    timelineImage.mockResolvedValue(null)
    const host = mount('<img src="/etc/x.png" alt="図1">')
    resolveLocalImages(host, 't1', () => true)
    await flush()
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.markdown-image-missing')?.textContent).toContain('図1')
    host.remove()
  })

  it('with no thread it does not ask and uses alt', () => {
    const host = mount('<img src="x.png" alt="">')
    resolveLocalImages(host, null, () => true)
    expect(timelineImage).not.toHaveBeenCalled()
    expect(host.querySelector('.markdown-image-missing')).not.toBeNull()
    host.remove()
  })

  it('does not touch anything once alive is false', async () => {
    timelineImage.mockResolvedValue('aios-res://local/' + 'a'.repeat(32) + '/x.png')
    const host = mount('<img src="x.png" alt="">')
    resolveLocalImages(host, 't1', () => false)
    await flush()
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull()
    host.remove()
  })
})

describe('how URLs are remembered (code-review)', () => {
  const URL1 = 'aios-res://local/' + 'a'.repeat(32) + '/x.png'
  const URL2 = 'aios-res://local/' + 'b'.repeat(32) + '/x.png'
  function mount(html: string, threadId: string | null = null): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = deferLocalImages(html, threadId)
    document.body.append(host)
    return host
  }

  it('on a load failure, drops the remembered URL and fetches again only once; if that fails, alt', async () => {
    timelineImage.mockResolvedValueOnce(URL1).mockResolvedValueOnce(URL2)
    const host = mount('<img src="/abs/x.png" alt="a">')
    resolveLocalImages(host, 't1', () => true)
    await flush()
    host.querySelector('img')?.dispatchEvent(new Event('error'))
    await flush()
    expect(timelineImage).toHaveBeenCalledTimes(2)
    expect(host.querySelector('img')?.getAttribute('src')).toBe(URL2)
    host.querySelector('img')?.dispatchEvent(new Event('error'))
    await flush()
    expect(timelineImage).toHaveBeenCalledTimes(2)
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.markdown-image-missing')).not.toBeNull()
    host.remove()
  })

  it('an unresolved result is remembered for a short time, and redrawing does not fire IPC', async () => {
    timelineImage.mockResolvedValue(null)
    for (let i = 0; i < 3; i += 1) {
      const host = mount('<img src="/etc/x.png" alt="a">', 't1')
      resolveLocalImages(host, 't1', () => true)
      await flush()
      host.remove()
    }
    expect(timelineImage).toHaveBeenCalledTimes(1)
  })

  it('a resolved image applies src directly on redraw (no flicker)', async () => {
    timelineImage.mockResolvedValue(URL1)
    const first = mount('<img src="/abs/x.png" alt="a">', 't1')
    resolveLocalImages(first, 't1', () => true)
    await flush()
    first.remove()
    const second = mount('<img src="/abs/x.png" alt="a">', 't1')
    expect(second.querySelector('img')?.getAttribute('src')).toBe(URL1)
    resolveLocalImages(second, 't1', () => true)
    await flush()
    expect(timelineImage).toHaveBeenCalledTimes(1)
    second.remove()
  })
})
