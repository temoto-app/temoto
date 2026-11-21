/**
 * In the feature that saves a conversation as a single-file HTML (TODO 866), main embeds the images in the body as `data:` (`main/export/embed-images.ts`). Confirms the limits (5 MB per image, 25 MB in total), the choke point (`assertAllowed`), external URLs, relative paths, and that unreadable images become a note instead of a failure. The real files are made in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { embedImages, imagePathOf, scanImgTags, sniffEmbeddableImage } from '../src/main/export/embed-images.js'
import { EXPORT_IMAGE_MAX_BYTES, EXPORT_IMAGES_TOTAL_MAX_BYTES } from '../src/shared/conversation-export.js'

let dir: string
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-866-'))
  writeFileSync(join(dir, 'a.png'), PNG)
  writeFileSync(join(dir, 'secret.png'), PNG)
  writeFileSync(join(dir, 'note.txt'), 'x')
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'rel.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const pngOfSize = (size: number): Uint8Array => {
  const data = new Uint8Array(size)
  data.set(PNG_HEAD)
  return data
}

const deny = (uri: string): void => {
  if (uri.endsWith('/secret.png')) throw new Error('excluded')
}

describe('imagePathOf (TODO 866)', () => {
  it('file: URL・絶対パス・相対パスはパスに、外の URL と基点の無い相対は null', () => {
    expect(imagePathOf('file:///Users/me/a.png', null)).toBe('/Users/me/a.png')
    expect(imagePathOf('/Users/me/a%20b.png', null)).toBe('/Users/me/a b.png')
    expect(imagePathOf('docs/x.png', '/w/aios')).toBe('/w/aios/docs/x.png')
    expect(imagePathOf('docs/x.png', null)).toBeNull()
    expect(imagePathOf('https://example.com/x.png', '/w')).toBeNull()
    expect(imagePathOf('//example.com/x.png', '/w')).toBeNull()
    expect(imagePathOf('aios-res://local/t/x.png', '/w')).toBeNull()
  })
})

describe('embedImages (TODO 866)', () => {
  it('読める画像は data: に、外の URL・関門で断られた・画像でないものは注記に (失敗にしない)', async () => {
    const html = [
      `<p><img src="${join(dir, 'a.png')}" alt="図 1"></p>`,
      `<img src="${pathToFileURL(join(dir, 'a.png')).href}" alt="">`,
      '<img src="docs/rel.svg" alt="rel">',
      '<img src="https://example.com/x.png" alt="外">',
      `<img src="${join(dir, 'secret.png')}" alt="秘">`,
      `<img src="${join(dir, 'note.txt')}" alt="txt">`,
      `<img src="${join(dir, 'missing.png')}" alt="&lt;無い&gt;">`
    ].join('\n')
    const out = await embedImages(html, { assertAllowed: deny, baseDir: dir, omittedLabel: '画像を省略しました' })
    expect(out.embedded).toBe(3)
    expect(out.omitted).toBe(4)
    const b64 = Buffer.from(PNG).toString('base64')
    expect(out.html).toContain(`<img src="data:image/png;base64,${b64}" alt="図 1">`)
    expect(out.html).toContain('<img src="data:image/svg+xml;base64,')
    expect(out.html).toContain('[画像を省略しました: 外]')
    expect(out.html).toContain('[画像を省略しました: 秘]')
    expect(out.html).toContain('[画像を省略しました: &lt;無い&gt;]')
    // Neither external references nor file-path srcs remain.
    expect(out.html).not.toMatch(/<img[^>]*src="(?!data:)/)
    expect(out.html).not.toContain('https://example.com')
  })

  it('1 枚 5 MB を超える画像・合計 25 MB を超えた分は注記に', async () => {
    const big = join(dir, 'big.png')
    writeFileSync(big, pngOfSize(EXPORT_IMAGE_MAX_BYTES + 1))
    const near = join(dir, 'near.png')
    writeFileSync(near, pngOfSize(EXPORT_IMAGE_MAX_BYTES))
    const count = Math.floor(EXPORT_IMAGES_TOTAL_MAX_BYTES / EXPORT_IMAGE_MAX_BYTES) + 1
    const html = [`<img src="${big}" alt="big">`, ...Array.from({ length: count }, () => `<img src="${near}" alt="n">`)].join('')
    const out = await embedImages(html, { assertAllowed: () => undefined, baseDir: null, omittedLabel: 'Image omitted' })
    expect(out.embedded).toBe(count - 1)
    expect(out.omitted).toBe(2)
    expect(out.html).toContain('[Image omitted: big]')
  })

  it('既に data: の画像は上限だけ見てそのまま、画像でない data: は注記', async () => {
    const html = '<img src="data:image/png;base64,AAAA" alt="a"><img src="data:text/html;base64,PHNjcmlwdD4=" alt="b">'
    const out = await embedImages(html, { assertAllowed: () => undefined, baseDir: null, omittedLabel: 'Image omitted' })
    expect(out.html).toBe('<img src="data:image/png;base64,AAAA" alt="a"><span class="export-image-omitted">[Image omitted: b]</span>')
  })

  it('img が無ければそのまま返す', async () => {
    const out = await embedImages('<p>&lt;img src="x"&gt;</p>', { assertAllowed: () => undefined, baseDir: null, omittedLabel: 'x' })
    expect(out).toEqual({ html: '<p>&lt;img src="x"&gt;</p>', embedded: 0, omitted: 0 })
  })
})

describe('scanImgTags (TODO 866 code-review)', () => {
  it('引用符の中の > で切れず、単引用符・引用符なしの値も読む', () => {
    const tags = scanImgTags(`<img alt="a>b" src="x.png"><img src='y.png' alt='c>d'><img src=z.png alt=e>`)
    expect(tags.map((tag) => [tag.attrs.get('src'), tag.attrs.get('alt')])).toEqual([
      ['x.png', 'a>b'],
      ['y.png', 'c>d'],
      ['z.png', 'e']
    ])
  })

  it('他のタグの属性値・コメント・style / script の中の <img は拾わない', () => {
    const html = `<pre data-code="<img src='/etc/hosts'>">x</pre><!-- <img src="a.png"> --><style>a::after{content:"<img src=b.png>"}</style><img src="real.png">`
    expect(scanImgTags(html).map((tag) => tag.attrs.get('src'))).toEqual(['real.png'])
  })

  it('閉じない引用符は属性を捨てて次の > で切る (画像は省略になる)', () => {
    const tags = scanImgTags('<img src="x.png><p>after</p>')
    expect(tags).toHaveLength(1)
    expect(tags[0]?.attrs.size).toBe(0)
  })
})

describe('embedImages の走査と読み取り (TODO 866 code-review)', () => {
  const base = { assertAllowed: (): void => undefined, baseDir: null as string | null, omittedLabel: 'Image omitted' }

  it('alt に > があっても、単引用符・引用符なしの src でも画像が埋まり、data-code の中の <img は書き換えない', async () => {
    const png = join(dir, 'a.png')
    const html = `<pre data-code="<img src='${png}'>">c</pre><img alt="a>b" src='${png}'><img src=${png} alt=q>`
    const out = await embedImages(html, base)
    expect(out.embedded).toBe(2)
    expect(out.omitted).toBe(0)
    expect(out.html).toContain(`<pre data-code="<img src='${png}'>">c</pre>`)
    expect(out.html).toContain('alt="a&gt;b"')
  })

  it('symlink は実体にも関門を通し、中身が画像でなければ省略する', async () => {
    writeFileSync(join(dir, 'fake.png'), 'just text, not an image')
    symlinkSync(join(dir, 'secret.png'), join(dir, 'link.png'))
    symlinkSync(join(dir, 'a.png'), join(dir, 'ok-link.png'))
    const html = [
      `<img src="${join(dir, 'fake.png')}" alt="fake">`,
      `<img src="${join(dir, 'link.png')}" alt="link">`,
      `<img src="${join(dir, 'ok-link.png')}" alt="ok">`
    ].join('')
    const out = await embedImages(html, { ...base, assertAllowed: deny })
    expect(out.embedded).toBe(1)
    expect(out.html).toContain('[Image omitted: fake]')
    // The logical name is harmless, but the actual file is secret.png, which is excluded, so it is refused.
    expect(out.html).toContain('[Image omitted: link]')
    expect(out.html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="ok">/)
  })

  it('MIME は拡張子ではなく中身で決める (.svg の名前でも PNG なら image/png)', async () => {
    writeFileSync(join(dir, 'actually.svg'), PNG)
    const out = await embedImages(`<img src="${join(dir, 'actually.svg')}" alt="">`, base)
    expect(out.html).toContain('data:image/png;base64,')
  })

  it('既定の読み取りは realpath + O_NOFOLLOW で開く', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/main/export/embed-images.ts', 'utf8')
    expect(src).toContain('O_NOFOLLOW')
    expect(src).toContain('realpath(path)')
  })
})

describe('sniffEmbeddableImage (TODO 866 code-review)', () => {
  const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'))
  it('png / jpeg / gif / webp / svg / bmp / avif を中身で見分け、テキストや HTML は null', () => {
    expect(sniffEmbeddableImage(PNG)).toBe('image/png')
    expect(sniffEmbeddableImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg')
    expect(sniffEmbeddableImage(bytes('GIF89a....'))).toBe('image/gif')
    expect(sniffEmbeddableImage(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffEmbeddableImage(bytes('  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(sniffEmbeddableImage(bytes('\0\0\0\x1cftypavif....'))).toBe('image/avif')
    expect(sniffEmbeddableImage(new Uint8Array([0x42, 0x4d, ...new Array(30).fill(0)]))).toBe('image/bmp')
    expect(sniffEmbeddableImage(bytes('<html><svg></svg></html>'))).toBeNull()
    expect(sniffEmbeddableImage(bytes('password=hunter2'))).toBeNull()
  })
  it('内部サブセット付きの DOCTYPE (Illustrator) と、1024 バイトより後ろの <svg> も svg (TODO 879)', () => {
    const doctype =
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
      '\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n]>\n'
    expect(sniffEmbeddableImage(bytes('<?xml version="1.0"?>\n' + doctype + '<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    const long = `<?xml version="1.0"?>\n<!-- ${'x'.repeat(2000)} -->\n<svg xmlns="http://www.w3.org/2000/svg"/>`
    expect(sniffEmbeddableImage(bytes(long))).toBe('image/svg+xml')
    // No new false positives: if what follows DOCTYPE is not svg, return null.
    expect(sniffEmbeddableImage(bytes(doctype + '<html></html>'))).toBeNull()
    expect(sniffEmbeddableImage(bytes('<!DOCTYPE html [ <svg> ]>\n<p>x</p>'))).toBeNull()
  })
})
