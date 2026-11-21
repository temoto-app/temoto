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

describe('item 254: href produced by markdown-it', () => {
  it('`[…](memory/x.md)` becomes an <a> with a relative href', () => {
    const html = renderMarkdown('資料: [診断](memory/project_gsc_index_diagnosis.md)').html
    expect(hrefsOf(html)).toEqual(['memory/project_gsc_index_diagnosis.md'])
  })

  it('linkify: a bare `memory/x.md` does not become a link (.md is a TLD but has no host part)', () => {
    const html = renderMarkdown('資料: memory/project_gsc_index_diagnosis.md').html
    expect(hrefsOf(html)).toEqual([])
  })

  it('a Japanese name becomes an href encoded with % (main decodes it back)', () => {
    const html = renderMarkdown('[メモ](memory/日本語.md)').html
    expect(hrefsOf(html)).toEqual([`memory/${encodeURIComponent('日本語')}.md`])
  })

  it('relative links with line numbers (`src/a.ts:42` / `#L42`) also remain in the href as they are', () => {
    expect(hrefsOf(renderMarkdown('[a](src/a.ts:42)').html)).toEqual(['src/a.ts:42'])
    expect(hrefsOf(renderMarkdown('[a](src/a.ts#L42)').html)).toEqual(['src/a.ts#L42'])
  })

  it('item 280-1: `name.ext:line` without a slash also remains in the href (`note.txt:` is not read as a scheme)', () => {
    expect(hrefsOf(renderMarkdown('[a](note.txt:2)').html)).toEqual(['note.txt:2'])
    expect(hrefsOf(renderMarkdown('[a](README.md:42)').html)).toEqual(['README.md:42'])
    expect(hrefsOf(renderMarkdown('[a](README.md:3:1)').html)).toEqual(['README.md:3:1'])
    expect(hrefsOf(renderMarkdown('[a](Makefile:7)').html)).toEqual(['Makefile:7'])
  })

  it('item 280-1: dangerous schemes are dropped even when digits follow; http / mailto / file / thread are as before', () => {
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

describe('item 254: click routing (linkAction)', () => {
  it('relative, no scheme and file: are resolved by main', () => {
    for (const href of ['memory/x.md', 'x.md', './a/b.ts', '../c.md', '/abs/path.md', 'src/a.ts:42', 'README.md:3:1', 'file:///a/b.md', '~/x.md']) {
      expect(linkAction(href), href).toBe('resolve')
    }
  })

  it('http(s) / mailto open externally', () => {
    expect(linkAction('https://example.com/a')).toBe('external')
    expect(linkAction('mailto:a@example.com')).toBe('external')
  })

  it('in-page 「#見出し」, thread:, empty and null do nothing', () => {
    for (const href of ['#top', 'thread://abc', 'javascript:alert(1)', '', '   ', null]) {
      expect(linkAction(href), String(href)).toBe('none')
    }
  })

  it('`name:digits` is not regarded as a scheme', () => {
    expect(hasScheme('README.md:42')).toBe(false)
    expect(hasScheme('a.ts:1:2')).toBe(false)
    expect(hasScheme('thread://x')).toBe(true)
    expect(hasScheme('vscode:open')).toBe(true)
  })
})

describe('TODO 1253 (d): even when the link text is a URL, a thread:// link is a single link and moves to the conversation', () => {
  const ID = '0b9a7f3e-1111-4222-8333-444455556666'

  it('[https://…](thread://…) does not turn the URL in the text into a separate link (the href is only the single thread://)', () => {
    const text = 'https://www.google.com/search?sca_esv=ba24c2d2484ecd3d&gl=us'
    const html = renderMarkdown(`その会話は [${text}](thread://${ID}) です。`).html
    expect(hrefsOf(html)).toEqual([`thread://${ID}`])
  })

  it('the form pointing to a message (thread://<id>/<eventId>) is the same', () => {
    const html = renderMarkdown(`[https://example.com/a](thread://${ID}/ev-1)`).html
    expect(hrefsOf(html)).toEqual([`thread://${ID}/ev-1`])
  })

  it('routing on click (openLinkHref) is decided by the href and does not look at the URL in the text: parseThreadLink picks it up first', () => {
    const [href] = hrefsOf(renderMarkdown(`[https://example.com](thread://${ID})`).html)
    expect(parseThreadLink(href ?? null)).toEqual({ threadId: ID, eventId: null })
    // The same text with an https href still opens in the web view (as before).
    expect(linkAction('https://example.com')).toBe('external')
  })
})
