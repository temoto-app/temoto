/**
 * @vitest-environment jsdom
 *
 * Markdown renderer (ARCHITECTURE.md 5.1 / 7.4).
 * ThreadPane (Phase 2) and `aios.markdown` share it,
 * so the holes in sanitizing are closed here.
 */
import { describe, expect, it } from 'vitest'
import { closeOpenFences, decodeCodeBlock, renderMarkdown } from '../src/shared/markdown/render.js'
import { HIGHLIGHT_LANGUAGES, highlightCode, resolveLanguage } from '../src/shared/markdown/highlight.js'

const render = (src: string): string => renderMarkdown(src).html

describe('plain Markdown', () => {
  it('renders headings, bullet lists, tables and code blocks', () => {
    expect(render('# 見出し')).toContain('<h1>見出し</h1>')
    expect(render('- a\n- b')).toContain('<li>a</li>')
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>')
    expect(render('```ts\nconst a = 1\n```')).toContain('<code class="language-ts">')
  })

  it('makes links', () => {
    const html = render('[x](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("puts the destination in the title of external links and does not let the author's title override it (5.1)", () => {
    expect(render('[x](https://example.com/a)')).toContain('title="https://example.com/a"')
    expect(render('[x](mailto:a@example.com)')).toContain('title="mailto:a@example.com"')
    const forged = render('[安全](https://evil.example/ "https://safe.example/")')
    expect(forged).toContain('title="https://evil.example/"')
    expect(forged).not.toContain('safe.example')
    // Not added to file: links opened inside the app (faking the destination matters only for outward links).
    expect(render('[x](file:///Users/x/a.md)')).not.toContain('title=')
  })
})

describe('disallows raw HTML (5.1)', () => {
  it('does not let a script tag through', () => {
    const html = render('<script>alert(1)</script>\n\nあと')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)</')
  })

  it('escapes an img tag instead of making an element', () => {
    const html = render('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('drops iframe / object / form', () => {
    expect(render('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe')
    expect(render('<object data="x"></object>')).not.toContain('<object')
    expect(render('<form action="/x"><input></form>')).not.toContain('<form')
  })

  it('does not make an element of a raw p tag (escaped with its style attribute)', () => {
    const html = render('<p style="position:fixed">x</p>')
    expect(html).not.toContain('<p style=')
    expect(html).toContain('&lt;p style=')
  })

  it('adds no style attribute to elements from Markdown', () => {
    expect(render('**x**')).not.toContain('style=')
  })
})

describe('drops href with dangerous schemes', () => {
  it('does not link javascript:', () => {
    const html = render('[x](javascript:alert(1))')
    expect(html).not.toContain('href=')
  })

  it('does not link data:', () => {
    const html = render('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('href=')
  })

  it('does not link vbscript:', () => {
    expect(render('[x](vbscript:msgbox)')).not.toContain('href=')
  })

  it('keeps file: and thread: (interpreted by ViewerPane)', () => {
    expect(render('[x](file:///Users/t/a.txt)')).toContain('href="file:///Users/t/a.txt"')
    expect(render('[x](thread://s/1)')).toContain('href="thread://s/1"')
  })
})

describe('unterminated code block while streaming (5.1)', () => {
  it('closes a ``` left open', () => {
    expect(closeOpenFences('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n```')
  })

  it('leaves a closed one alone', () => {
    const src = '```ts\nconst a = 1\n```'
    expect(closeOpenFences(src)).toBe(src)
  })

  it('becomes a code element when rendered after closing', () => {
    const html = render(closeOpenFences('```\nconst a = 1'))
    expect(html).toContain('<code>')
  })
})

describe('syntax highlighting of code blocks (5.1.2)', () => {
  it('emits highlight spans when a language is given (attribute is data-hl, not class)', () => {
    const html = render('```python\ndef f(x):\n    return "s"  # c\n```')
    expect(html).toContain('<code class="language-python">')
    expect(html).toContain('<span data-hl="keyword">def</span>')
    // DOMPurify does not turn `"` in text into an entity reference (only `<` / `>` / `&`).
    expect(html).toContain('<span data-hl="string">"s"</span>')
    expect(html).toContain('<span data-hl="comment"># c</span>')
    expect(html).not.toContain('<span class=')
  })

  it('emits spans for each of the 10 representative languages', () => {
    const sample: Record<string, string> = {
      python: 'import os',
      c: '#include <stdio.h>\nint main(void) { return 0; }',
      cpp: 'template <typename T> class A {};',
      typescript: 'const a: number = 1',
      javascript: 'const a = 1',
      bash: 'for f in *; do echo "$f"; done',
      json: '{ "a": 1 }',
      rust: 'fn main() { let x = 1; }',
      go: 'func main() { fmt.Println("x") }',
      markdown: '# Title\n\n- a'
    }
    expect(Object.keys(sample).sort()).toEqual([...HIGHLIGHT_LANGUAGES].sort())
    for (const [lang, code] of Object.entries(sample)) {
      expect(render(`\`\`\`${lang}\n${code}\n\`\`\``), lang).toContain('<span data-hl="')
    }
  })

  it('resolves aliases (py / c++ / ts / js / sh / zsh / rs / golang / md)', () => {
    expect(resolveLanguage('py')).toBe('python')
    expect(resolveLanguage('Python3')).toBe('python')
    expect(resolveLanguage('c++')).toBe('cpp')
    expect(resolveLanguage('h')).toBe('c')
    expect(resolveLanguage('ts')).toBe('typescript')
    expect(resolveLanguage('tsx')).toBe('typescript')
    expect(resolveLanguage('js')).toBe('javascript')
    expect(resolveLanguage('sh')).toBe('bash')
    expect(resolveLanguage('zsh')).toBe('bash')
    expect(resolveLanguage('shell')).toBe('bash')
    expect(resolveLanguage('rs')).toBe('rust')
    expect(resolveLanguage('golang')).toBe('go')
    expect(resolveLanguage('md')).toBe('markdown')
    // The info string is read only for its first word
    expect(resolveLanguage('ts title="a.ts"')).toBe('typescript')
    expect(render('```sh\necho hi\n```')).toContain('<span data-hl="built_in">echo</span>')
  })

  it('passes unknown languages through (escape only, no span, no exception)', () => {
    for (const lang of ['cobol', 'nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveLanguage(lang), lang).toBeNull()
      const html = render(`\`\`\`${lang}\nif (a < b) { x = "y" }\n\`\`\``)
      expect(html, lang).toContain(`<code class="language-${lang}">`)
      expect(html, lang).toContain('if (a &lt; b) { x = "y" }')
      expect(html, lang).not.toContain('data-hl=')
    }
    expect(highlightCode('x', 'nope')).toBe('')
  })

  it('does not auto-detect a fence without a language', () => {
    const html = render('```\ndef f(): return 1\n```')
    expect(html).toContain('<code>')
    expect(html).not.toContain('data-hl=')
  })

  it('keeps `<span class=` in the code body as a string (the class to data-hl replacement does not reach the body)', () => {
    const html = render('```js\nconst s = \'<span class="x">\'\n```')
    expect(html).not.toContain('<span class=')
    expect(html).toContain('&lt;span class="x"&gt;')
    expect(html).toContain('<span data-hl="string">')
  })

  it('still rejects javascript: and lets no raw HTML through even in highlighted bodies', () => {
    const html = render('[x](javascript:alert(1))\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps the data-hl attribute after DOMPurify and adds no style or on*', () => {
    const html = render('```ts\nconst a: number = 1 // x\n```')
    expect(html).toContain('data-hl="keyword"')
    expect(html).toContain('data-hl="number"')
    expect(html).toContain('data-hl="comment"')
    expect(html).not.toContain('style=')
    expect(html).not.toMatch(/ on\w+=/)
  })

  it('only escapes without coloring while receiving (highlight: false)', () => {
    const src = closeOpenFences('```py\ndef f(): return "a"')
    const html = renderMarkdown(src, { highlight: false }).html
    expect(html).toContain('<code class="language-py">')
    expect(html).toContain('def f(): return "a"')
    expect(html).not.toContain('data-hl=')
    expect(renderMarkdown(src).html).toContain('data-hl="keyword"')
  })
})

describe('code block wrapper and the original text for copying (5.1.2, T17)', () => {
  /** Puts the rendered result through the DOM once and returns the code restored from `.code-block` (the same path as ThreadPane). */
  const codes = (src: string): string[] => {
    const el = document.createElement('div')
    el.innerHTML = render(src)
    return Array.from(el.querySelectorAll<HTMLElement>('.code-block')).map((node) =>
      decodeCodeBlock(node.dataset['code'])
    )
  }

  it('wraps a fence in code-block and leaves the highlighting inside unchanged', () => {
    const html = render('```python\ndef f(x):\n    return "s"\n```')
    expect(html).toContain('<div class="code-block" data-code="')
    expect(html).toContain('<pre><code class="language-python">')
    expect(html).toContain('<span data-hl="keyword">def</span>')
  })

  it('restores the original text before highlighting from data-code as is', () => {
    expect(codes('```python\ndef f(x):\n    return "s"\n```')).toEqual([
      'def f(x):\n    return "s"\n'
    ])
  })

  it("keeps the first line's indentation and the trailing newline (DOMPurify trims whitespace around attribute values, so they are not put in raw)", () => {
    expect(codes('```\n    indented\nnext\n\n```')).toEqual(['    indented\nnext\n\n'])
    // If it is turned back into the raw form put into an attribute, it fails (DOMPurify trims surrounding spaces).
    expect(render('```\n    indented\n```')).not.toContain('data-code="    ')
  })

  it('cannot close the attribute and adds no elements even for code with quotes, angle brackets and &', () => {
    const code = 'a = "<b>&\'x\'</b>" // ">< img src=x>\n'
    const el = document.createElement('div')
    el.innerHTML = render(`\`\`\`js\n${code}\`\`\``)
    expect(el.querySelectorAll('.code-block')).toHaveLength(1)
    expect(el.querySelectorAll('img')).toHaveLength(0)
    expect(el.querySelector<HTMLElement>('.code-block')?.children).toHaveLength(1)
    expect(decodeCodeBlock(el.querySelector<HTMLElement>('.code-block')?.dataset['code'])).toBe(code)
  })

  it('round-trips Japanese text and emoji', () => {
    expect(codes('```\n日本語の行 🍣\n```')).toEqual(['日本語の行 🍣\n'])
  })

  it('keeps the button out of the rendered output (DOMPurify drops button; ThreadPane overlays the UI)', () => {
    expect(render('```js\nconst a = 1\n```')).not.toContain('<button')
  })

  it('makes a separate wrapper for each fence and does not wrap inline code', () => {
    const el = document.createElement('div')
    el.innerHTML = render('```js\na\n```\n\n本文 `x` です\n\n```py\nb\n```')
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('.code-block')).map((b) =>
        decodeCodeBlock(b.dataset['code'])
      )
    ).toEqual(['a\n', 'b\n'])
    expect(el.querySelectorAll('code:not(pre code)')).toHaveLength(1)
  })

  it('keeps the wrapper and data-code the same shape even while receiving (highlight: false)', () => {
    const el = document.createElement('div')
    el.innerHTML = renderMarkdown(closeOpenFences('```ts\nconst a = 1'), { highlight: false }).html
    const block = el.querySelector<HTMLElement>('.code-block')
    expect(decodeCodeBlock(block?.dataset['code'])).toBe('const a = 1\n')
    expect(block?.innerHTML).not.toContain('data-hl=')
  })

  it('turns a broken data-code into an empty string (no exception)', () => {
    expect(decodeCodeBlock('%E0%A4%A')).toBe('')
    expect(decodeCodeBlock(undefined)).toBe('')
  })
})

describe('also wraps indented code blocks (5.1.2.1, T25)', () => {
  const codes = (src: string): string[] => {
    const el = document.createElement('div')
    el.innerHTML = render(src)
    return Array.from(el.querySelectorAll<HTMLElement>('.code-block')).map((node) =>
      decodeCodeBlock(node.dataset['code'])
    )
  }

  it('wraps a 4-space indented block in code-block', () => {
    const html = render('本文\n\n    const a = 1\n')
    expect(html).toContain('<div class="code-block" data-code="')
    expect(html).toContain('<pre><code>')
  })

  it('builds data-code the same as a fence (the original text without indentation round-trips)', () => {
    expect(codes('本文\n\n    const a = 1\n    const b = 2\n')).toEqual([
      'const a = 1\nconst b = 2\n'
    ])
  })

  it('keeps nested indentation (leading whitespace) and the trailing newline', () => {
    // What is left after removing four spaces starts with "  deeper". This is what disappears when passed raw to DOMPurify.
    expect(codes('本文\n\n      deeper\n    back\n')).toEqual(['  deeper\nback\n'])
    expect(render('本文\n\n      deeper\n')).not.toContain('data-code="  ')
  })

  it('does not highlight indented code (the markdown-it highlight applies to fences only)', () => {
    expect(render('本文\n\n    def f(x):\n')).not.toContain('data-hl=')
  })

  it('adds no elements even for an indented block containing quotes or angle brackets', () => {
    const el = document.createElement('div')
    el.innerHTML = render('本文\n\n    a = "<img src=x>"\n')
    expect(el.querySelectorAll('.code-block')).toHaveLength(1)
    expect(el.querySelectorAll('img')).toHaveLength(0)
    expect(codes('本文\n\n    a = "<img src=x>"\n')).toEqual(['a = "<img src=x>"\n'])
  })

  it('keeps the button out of the rendered output (the host overlays the UI)', () => {
    expect(render('本文\n\n    const a = 1\n')).not.toContain('<button')
  })
})
