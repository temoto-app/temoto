/**
 * @vitest-environment jsdom
 *
 * The print HTML for saving a conversation as a PDF (TODO 818) (`renderer/src/thread/export-pdf.ts`).
 */
import { describe, expect, it, vi } from 'vitest'
import { collectMermaidSources, exportDocumentHtml } from '../src/renderer/src/thread/export-pdf.js'

describe('exportDocumentHtml (TODO 818)', () => {
  const html = exportDocumentHtml({
    title: '<題名>',
    meta: 'aios · 2026/10/17',
    lang: 'ja',
    appCss: ':root { --line: x; }',
    relabel: (text) => text.replace('(添付: a.png)', '(Attached: a.png)'),
    turns: [
      { number: 1, question: { id: 'e1', ts: 1, text: '(添付: a.png)\n<script>alert(1)</script> *強調しない*' }, answers: ['**太字**\n\n```ts\nconst a = 1\n```', '<img src=x onerror=alert(1)>'] },
      { number: 0, question: null, answers: ['頭'] }
    ]
  })

  it("the user's own message is escaped plain text, and the answer goes through Markdown", () => {
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; *強調しない*')
    expect(html).toContain('(Attached: a.png)')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<strong>太字</strong>')
    expect(html).toContain('class="code-block"')
    // Raw HTML in an answer is not drawn (markdown-it's html: false + DOMPurify).
    expect(html).not.toMatch(/<img[^>]*onerror/)
    expect(html.match(/class="export-turn"/g)).toHaveLength(2)
  })

  it("escapes the title, applies the app's CSS, stops outside loading with the CSP, and adds no theme marker (light)", () => {
    expect(html).toContain('<h1>&lt;題名&gt;</h1>')
    expect(html).toContain('<title>&lt;題名&gt;</title>')
    expect(html).toContain(':root { --line: x; }')
    expect(html).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`)
    expect(html).toContain('<html lang="ja">')
    expect(html).not.toContain('data-theme')
  })

  it('a </style> inside the CSS does not break out of the style element', () => {
    const out = exportDocumentHtml({ title: 't', meta: '', lang: 'en', appCss: 'a{}</style><script>x</script>', turns: [] })
    expect(out).not.toContain('</style><script>')
  })
})

describe('HTML export of exportDocumentHtml (TODO 866)', () => {
  const turns = [
    {
      number: 1,
      question: { id: 'e1', ts: 1, text: '図を出して' },
      answers: ['![図](/tmp/aios-866-none.png) と ![外](https://example.com/x.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |']
    }
  ]

  it('the CSP allows only img-src data:, and there is no script or external link; PDF has the same CSP (TODO 1273)', () => {
    const html = exportDocumentHtml({ title: 't', meta: '', lang: 'ja', appCss: '', turns, format: 'html' })
    expect(html).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`)
    expect(html).toContain('<body class="export-pdf export-html">')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).toContain('<table>')
    expect(html).not.toContain('data-theme')
    const pdf = exportDocumentHtml({ title: 't', meta: '', lang: 'ja', appCss: '', turns })
    expect(pdf).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`)
    expect(pdf).not.toContain('export-html')
  })

  it('after main embeds images, no src that reads an external URL remains', async () => {
    const { embedImages } = await import('../src/main/export/embed-images.js')
    const html = exportDocumentHtml({ title: 't', meta: '', lang: 'ja', appCss: '', turns, format: 'html' })
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com/)
    const out = await embedImages(html, { assertAllowed: () => undefined, baseDir: null, omittedLabel: '画像を省略しました' })
    expect(out.omitted).toBe(2)
    expect(out.html).not.toMatch(/\ssrc="(?!data:)/)
    expect(out.html).toContain('[画像を省略しました: 外]')
  })
})

describe('Markdown is rendered once (TODO 880 code-review)', () => {
  it('exportDocumentHtml after collectMermaidSources does not redraw the same answer', async () => {
    const render = await import('../src/shared/markdown/render.js')
    const spy = vi.spyOn(render, 'renderMarkdown')
    const turns = [{ number: 1, question: null, answers: ['```mermaid\ngraph TD\nA-->B\n```'] }]
    expect(collectMermaidSources(turns)).toHaveLength(1)
    exportDocumentHtml({ title: 't', meta: 'm', lang: 'ja', appCss: '', turns })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
