/**
 * @vitest-environment jsdom
 *
 * item 254: checks the raw-body side of relative links in an answer, and the split between renderer and viewer.
 *
 * The real DB cannot be read, so the working assumption from intake ("a plain string does not become a link; if it looks clickable, the model wrote `[…](memory/x.md)` and the `href` came out relative") is checked with the markdown-it settings.
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/shared/markdown/render.js'
import { hasScheme, linkAction } from '../src/shared/link.js'
import { parseThreadLink } from '../src/shared/thread-link.js'

const hrefsOf = (html: string): string[] => {
  const box = document.createElement('div')
  box.innerHTML = html
  return Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '')
}

describe('項目 254: markdown-it が作る href', () => {
  it('`[…](memory/x.md)` は相対の href の <a> になる', () => {
    const html = renderMarkdown('資料: [診断](memory/project_gsc_index_diagnosis.md)').html
    expect(hrefsOf(html)).toEqual(['memory/project_gsc_index_diagnosis.md'])
  })

  it('linkify: 素の `memory/x.md` はリンクにならない (.md は TLD でも host 部が無い)', () => {
    const html = renderMarkdown('資料: memory/project_gsc_index_diagnosis.md').html
    expect(hrefsOf(html)).toEqual([])
  })

  it('日本語の名前は % で符号化された href になる (main が解いて戻す)', () => {
    const html = renderMarkdown('[メモ](memory/日本語.md)').html
    expect(hrefsOf(html)).toEqual([`memory/${encodeURIComponent('日本語')}.md`])
  })

  it('行番号の付いた相対リンク (`src/a.ts:42` / `#L42`) もそのまま href に残る', () => {
    expect(hrefsOf(renderMarkdown('[a](src/a.ts:42)').html)).toEqual(['src/a.ts:42'])
    expect(hrefsOf(renderMarkdown('[a](src/a.ts#L42)').html)).toEqual(['src/a.ts#L42'])
  })

  it('項目 280-1: スラッシュの無い `名前.拡張子:行` も href に残る (`note.txt:` をスキームと読まない)', () => {
    expect(hrefsOf(renderMarkdown('[a](note.txt:2)').html)).toEqual(['note.txt:2'])
    expect(hrefsOf(renderMarkdown('[a](README.md:42)').html)).toEqual(['README.md:42'])
    expect(hrefsOf(renderMarkdown('[a](README.md:3:1)').html)).toEqual(['README.md:3:1'])
    expect(hrefsOf(renderMarkdown('[a](Makefile:7)').html)).toEqual(['Makefile:7'])
  })

  it('項目 280-1: 危険なスキームは数字が続いても落とす。http / mailto / file / thread は今までどおり', () => {
    for (const href of ['javascript:alert(1)', 'javascript:1', 'JavaScript:1', 'vbscript:1', 'data:text/html,x']) {
      expect(hrefsOf(renderMarkdown(`[a](${href})`).html).filter((h) => h !== ''), href).toEqual([])
    }
    // A scheme that is not allowed (markdown-it still makes an <a>, but the href is dropped at render time)
    expect(hrefsOf(renderMarkdown('[a](vscode:open)').html)).toEqual([''])
    expect(hrefsOf(renderMarkdown('[a](https://example.com/a)').html)).toEqual(['https://example.com/a'])
    expect(hrefsOf(renderMarkdown('[a](mailto:a@example.com)').html)).toEqual(['mailto:a@example.com'])
    expect(hrefsOf(renderMarkdown('[a](file:///a/b.md)').html)).toEqual(['file:///a/b.md'])
    expect(hrefsOf(renderMarkdown('[a](thread://abc)').html)).toEqual(['thread://abc'])
  })
})

describe('項目 254: クリックの振り分け (linkAction)', () => {
  it('相対・スキーム無し・file: は main に解かせる', () => {
    for (const href of ['memory/x.md', 'x.md', './a/b.ts', '../c.md', '/abs/path.md', 'src/a.ts:42', 'README.md:3:1', 'file:///a/b.md', '~/x.md']) {
      expect(linkAction(href), href).toBe('resolve')
    }
  })

  it('http(s) / mailto は外部で開く', () => {
    expect(linkAction('https://example.com/a')).toBe('external')
    expect(linkAction('mailto:a@example.com')).toBe('external')
  })

  it('ページ内の #見出し・thread:・空・null は何もしない', () => {
    for (const href of ['#top', 'thread://abc', 'javascript:alert(1)', '', '   ', null]) {
      expect(linkAction(href), String(href)).toBe('none')
    }
  })

  it('`名前:数字` はスキームとみなさない', () => {
    expect(hasScheme('README.md:42')).toBe(false)
    expect(hasScheme('a.ts:1:2')).toBe(false)
    expect(hasScheme('thread://x')).toBe(true)
    expect(hasScheme('vscode:open')).toBe(true)
  })
})

describe('TODO 1253 (d): リンクの文字が URL でも thread:// のリンクは 1 つで、会話へ移る', () => {
  const ID = '0b9a7f3e-1111-4222-8333-444455556666'

  it('[https://…](thread://…) は文字の中の URL を別のリンクにしない (href は thread:// の 1 つだけ)', () => {
    const text = 'https://www.google.com/search?sca_esv=ba24c2d2484ecd3d&gl=us'
    const html = renderMarkdown(`その会話は [${text}](thread://${ID}) です。`).html
    expect(hrefsOf(html)).toEqual([`thread://${ID}`])
  })

  it('発言まで指す形 (thread://<id>/<eventId>) も同じ', () => {
    const html = renderMarkdown(`[https://example.com/a](thread://${ID}/ev-1)`).html
    expect(hrefsOf(html)).toEqual([`thread://${ID}/ev-1`])
  })

  it('押したときの振り分け (openLinkHref) は href で決まり、文字の URL は見ない: parseThreadLink が先に拾う', () => {
    const [href] = hrefsOf(renderMarkdown(`[https://example.com](thread://${ID})`).html)
    expect(parseThreadLink(href ?? null)).toEqual({ threadId: ID, eventId: null })
    // The same text with an https href still opens in the web view (as before).
    expect(linkAction('https://example.com')).toBe('external')
  })
})
