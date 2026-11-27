/**
 * @vitest-environment jsdom
 *
 * LaTeX math in answers (TODO 1342, ARCHITECTURE 5.1.10).
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/shared/markdown/render.js'
import { MAX_MATH_LENGTH } from '../src/shared/markdown/math.js'

const math = (src: string): string => renderMarkdown(src, { math: true }).html
const hasMath = (html: string): boolean => html.includes('class="katex')
/** Number of elements matching `selector` in the output. */
const tags = (html: string, selector: string): number =>
  new DOMParser().parseFromString(html, 'text/html').querySelectorAll(selector).length
const count = (html: string): number => html.match(/class="katex"/g)?.length ?? 0

describe('delimiters', () => {
  it('draws inline $…$', () => {
    const html = math('so $x^2$ here')
    expect(hasMath(html)).toBe(true)
    expect(html).not.toContain('katex-display')
    expect(html).toContain('<p>so <span class="katex">')
  })
  it('draws inline \\(…\\) even though markdown-it escapes backslashes', () => {
    const html = math('so \\(x^2\\) here')
    expect(hasMath(html)).toBe(true)
    expect(html).not.toContain('(x^2)')
  })
  it('draws block $$…$$ and \\[…\\] in the three shapes', () => {
    expect(math('$$\\sum_{n=1}^{\\infty}\\frac{1}{n^s}$$')).toContain('katex-display')
    expect(math('\\[ x = 1 \\]')).toContain('katex-display')
    expect(math('$$\n\\frac{a}{b}\n$$')).toContain('katex-display')
    expect(math('before\n$$\na+b\n$$\nafter')).toContain('katex-display')
    expect(math('text\n\\[\nx\n\\]')).toContain('katex-display')
  })
  it('draws $$…$$ inside a sentence as display math', () => {
    expect(math('so $$x+1$$ here')).toContain('katex-display')
  })
  it('does not draw without the math option', () => {
    const html = renderMarkdown('$x^2$ and \\(y\\)').html
    expect(hasMath(html)).toBe(false)
    expect(html).toContain('$x^2$')
  })
})

describe('output shape', () => {
  it('keeps the TeX source as the MathML annotation (selection, find and screen readers see it)', () => {
    const html = math('$x_i^2$')
    expect(html).toContain('<annotation encoding="application/x-tex">x_i^2</annotation>')
  })
})

describe('money and escapes', () => {
  it('leaves prices and spaced dollars as text', () => {
    for (const src of ['$5 と $10', '$5-$10', 'US$100 だけ', '費用は $20、$30 です', '$ 5 $']) {
      expect(hasMath(math(src)), src).toBe(false)
    }
  })
  it('still finds a formula after a price', () => {
    expect(count(math('costs $5 and $x$ cheaper'))).toBe(1)
  })
  it('draws next to Japanese text', () => {
    expect(hasMath(math('式$x_i$です'))).toBe(true)
    expect(hasMath(math('関数\\(f(x)\\)を使う'))).toBe(true)
  })
  it('does not treat \\$ as a delimiter', () => {
    expect(hasMath(math('\\$x\\$ and \\$y\\$'))).toBe(false)
    expect(math('a \\$5 and $x$')).toContain('$5')
  })
})

describe('code is never math', () => {
  it('skips fences, indented code and inline code', () => {
    expect(hasMath(math('```\n$x^2$\n\\(y\\)\n$$\nz\n$$\n```'))).toBe(false)
    expect(hasMath(math('    $x^2$'))).toBe(false)
    expect(hasMath(math('use `$x$` and `\\(y\\)` here'))).toBe(false)
    expect(hasMath(math('a `b $x` c$'))).toBe(false)
  })
})

describe('structure', () => {
  it('works in tables, lists, quotes and headings', () => {
    expect(hasMath(math('| a | b |\n|---|---|\n| $x^2$ | \\(y\\) |'))).toBe(true)
    expect(math('| a |\n|---|\n| $x^2$ |')).toContain('<td><span class="katex">')
    expect(hasMath(math('- item $x^2$\n- two'))).toBe(true)
    expect(hasMath(math('> quote $x^2$'))).toBe(true)
    expect(hasMath(math('# Title $x^2$'))).toBe(true)
    expect(math('- list\n\n  $$\n  a+b\n  $$\n')).toContain('katex-display')
    expect(math('> $$\n> a+b\n> $$')).toContain('katex-display')
  })
  it('does not turn _ and * inside math into emphasis', () => {
    const html = math('see $a_i * b_j$ and $c_k * d_l$ end')
    expect(html).not.toContain('<em>')
    expect(count(html)).toBe(2)
  })
})

describe('streaming and invalid input', () => {
  it.each(['$$\n\\frac{a}{b}', '\\[ x', '$x', '\\(x', '$$ x', 'text\n$$\na+b'])('keeps unterminated "%s" as text', (src) => {
    expect(hasMath(math(src))).toBe(false)
  })
  it('becomes math as soon as it closes', () => {
    expect(hasMath(math('$$\na+b'))).toBe(false)
    expect(hasMath(math('$$\na+b\n$$'))).toBe(true)
  })
  it('shows the original characters for bad LaTeX (no KaTeX error markup)', () => {
    for (const src of ['$\\frac{1$', '$\\notacommand{x}$', '\\(\\frac\\)']) {
      const html = math(src)
      expect(hasMath(html)).toBe(false)
      expect(html).not.toContain('katex-error')
      expect(html).toContain('math-raw')
    }
    expect(math('$\\frac{1$')).toContain('$\\frac{1$')
    expect(math('$$\n\\begin{foo}\n$$')).toContain('math-raw')
  })
  it('keeps over-long sources as text', () => {
    expect(hasMath(math(`$${'x+'.repeat(MAX_MATH_LENGTH)}1$`))).toBe(false)
  })
  it('keeps nesting bombs and expansion loops from throwing', () => {
    expect(() => math(`$${'{'.repeat(3000)}x${'}'.repeat(3000)}$`)).not.toThrow()
    expect(() => math('$\\def\\a{\\a\\a}\\a$')).not.toThrow()
    expect(hasMath(math('$\\def\\a{\\a\\a}\\a$'))).toBe(false)
  })
  it('gives the same output when the same source is drawn twice', () => {
    expect(math('$x^2$')).toBe(math('$x^2$'))
  })
})

describe('safety', () => {
  it.each([
    '$\\href{javascript:alert(1)}{x}$',
    '$\\url{https://example.com}$',
    '$\\includegraphics{https://example.com/a.png}$',
    '$\\htmlClass{evil}{x}$',
    '$\\htmlId{evil}{x}$',
    '$\\htmlStyle{color:red}{x}$',
    '$\\htmlData{a=b}{x}$'
  ])('does not let %s through', (src) => {
    const html = math(src)
    expect(hasMath(html)).toBe(false)
    expect(html).toContain('math-raw')
    expect(html).not.toContain('aiosKatexError')
    expect(tags(html, 'a, img, [class~="evil"], [id="evil"]')).toBe(0)
  })
  it('keeps raw HTML and slot look-alikes out', () => {
    const html = math('<span data-math-slot="0"></span> <img src=x onerror=alert(1)> $x$ <b style="color:red">y</b>')
    expect(tags(html, 'img, b, [data-math-slot]')).toBe(0)
    expect(tags(html, '[style]:not(.katex *)')).toBe(0)
    expect(count(html)).toBe(1)
  })
  it('does not widen the sanitizer for text around the math', () => {
    const html = math('[x](javascript:alert(1)) $x$ ![i](data:image/png;base64,AAAA)')
    expect(tags(html, 'a, img')).toBe(0)
    // The only style attributes in the output are inside KaTeX's own subtree.
    const doc = new DOMParser().parseFromString(html, 'text/html')
    for (const node of Array.from(doc.querySelectorAll('[style]'))) expect(node.closest('.katex')).not.toBeNull()
    expect(doc.querySelectorAll('script, iframe, a[href^="javascript"]').length).toBe(0)
  })
  it('emits no script or event handler from the math itself', () => {
    const html = math('$$\\text{<img src=x onerror=alert(1)>}$$ $\\text{</span><script>alert(1)</script>}$')
    expect(tags(html, 'script, img, [onerror]')).toBe(0)
  })
})

describe('an opener line does not swallow what follows (review X1)', () => {
  it('keeps `$$` at the start of a line from eating paragraphs, fences, lists', () => {
    const html = math('$$ is the shell PID.\n\nSome paragraph.\n\n```sh\necho hi\n```\n\n- item\n\nUse echo $$')
    expect(html).not.toContain('katex')
    expect(html).not.toContain('math-raw')
    expect(html).toContain('<li>item</li>')
    expect(html).toContain('language-sh')
  })
  it('keeps `\\[draft\\] title` from swallowing a table', () => {
    const html = math('\\[draft\\] title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nsee arr\\[i\\]')
    expect(html).toContain('<table>')
    expect(html).not.toContain('math-raw')
  })
  it('hands `$$a$$ is …` lines to the inline rule (inline $$ stays display-looking)', () => {
    const html = math('$$a$$ is defined, and\nthe other is $$b$$')
    expect(count(html)).toBe(2)
    expect(html).not.toContain('math-raw')
  })
  it('does not draw the paragraph after a still-open $$ while streaming', () => {
    const html = math('$$\n\\frac{a}{b}\n\nNext paragraph with a closer $$')
    expect(html).not.toContain('katex')
    expect(html).toContain('<p>Next paragraph')
  })
})

describe('shell and PHP variables are not math (review X2)', () => {
  it('leaves two variables in one sentence alone', () => {
    for (const src of [
      'Add $HOME/bin:$PATH to it',
      'set $FOO=$BAR then',
      'In PHP, $a+$b is a sum',
      'use ${HOME}/x:${PATH} here',
      'run $(pwd)/a:$(whoami) now'
    ]) {
      const html = math(src)
      expect(hasMath(html), src).toBe(false)
      expect(html, src).toContain('$')
    }
  })
  it('still closes before CJK, punctuation, spaces, ) and -', () => {
    for (const src of ['式$x_i$です', '$x$と$y$', '($a+b$)', '$a$, $b$ and $c$.', '$E=mc^2$.', '$x$-axis']) {
      expect(hasMath(math(src)), src).toBe(true)
    }
    expect(count(math('$x$と$y$'))).toBe(2)
    expect(count(math('$a$, $b$ and $c$.'))).toBe(3)
  })
})
