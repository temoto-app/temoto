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

describe('通常の Markdown', () => {
  it('見出し・箇条書き・表・コードブロックを描く', () => {
    expect(render('# 見出し')).toContain('<h1>見出し</h1>')
    expect(render('- a\n- b')).toContain('<li>a</li>')
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>')
    expect(render('```ts\nconst a = 1\n```')).toContain('<code class="language-ts">')
  })

  it('リンクを張る', () => {
    const html = render('[x](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('外部リンクは title に行き先を出し、書き手の title で上書きさせない (5.1)', () => {
    expect(render('[x](https://example.com/a)')).toContain('title="https://example.com/a"')
    expect(render('[x](mailto:a@example.com)')).toContain('title="mailto:a@example.com"')
    const forged = render('[安全](https://evil.example/ "https://safe.example/")')
    expect(forged).toContain('title="https://evil.example/"')
    expect(forged).not.toContain('safe.example')
    // Not added to file: links opened inside the app (faking the destination matters only for outward links).
    expect(render('[x](file:///Users/x/a.md)')).not.toContain('title=')
  })
})

describe('生 HTML を許可しない (5.1)', () => {
  it('script タグを通さない', () => {
    const html = render('<script>alert(1)</script>\n\nあと')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)</')
  })

  it('img タグは要素にならずエスケープされる', () => {
    const html = render('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('iframe / object / form を落とす', () => {
    expect(render('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe')
    expect(render('<object data="x"></object>')).not.toContain('<object')
    expect(render('<form action="/x"><input></form>')).not.toContain('<form')
  })

  it('生の p タグは要素にならない (style 属性ごとエスケープされる)', () => {
    const html = render('<p style="position:fixed">x</p>')
    expect(html).not.toContain('<p style=')
    expect(html).toContain('&lt;p style=')
  })

  it('Markdown 由来の要素に style 属性は付かない', () => {
    expect(render('**x**')).not.toContain('style=')
  })
})

describe('危険なスキームの href を落とす', () => {
  it('javascript: はリンクにしない', () => {
    const html = render('[x](javascript:alert(1))')
    expect(html).not.toContain('href=')
  })

  it('data: はリンクにしない', () => {
    const html = render('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('href=')
  })

  it('vbscript: はリンクにしない', () => {
    expect(render('[x](vbscript:msgbox)')).not.toContain('href=')
  })

  it('file: と thread: は残す (ViewerPane が解釈する)', () => {
    expect(render('[x](file:///Users/t/a.txt)')).toContain('href="file:///Users/t/a.txt"')
    expect(render('[x](thread://s/1)')).toContain('href="thread://s/1"')
  })
})

describe('ストリーミング中の未完結コードブロック (5.1)', () => {
  it('開いたままの ``` を閉じる', () => {
    expect(closeOpenFences('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n```')
  })

  it('閉じているものは触らない', () => {
    const src = '```ts\nconst a = 1\n```'
    expect(closeOpenFences(src)).toBe(src)
  })

  it('閉じてから描くと code 要素になる', () => {
    const html = render(closeOpenFences('```\nconst a = 1'))
    expect(html).toContain('<code>')
  })
})

describe('コードブロックの構文色分け (5.1.2)', () => {
  it('言語指定ありで色分けの span が出る (属性は class ではなく data-hl)', () => {
    const html = render('```python\ndef f(x):\n    return "s"  # c\n```')
    expect(html).toContain('<code class="language-python">')
    expect(html).toContain('<span data-hl="keyword">def</span>')
    // DOMPurify does not turn `"` in text into an entity reference (only `<` / `>` / `&`).
    expect(html).toContain('<span data-hl="string">"s"</span>')
    expect(html).toContain('<span data-hl="comment"># c</span>')
    expect(html).not.toContain('<span class=')
  })

  it('代表 10 言語のどれでも span が出る', () => {
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

  it('別名が解決される (py / c++ / ts / js / sh / zsh / rs / golang / md)', () => {
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

  it('未知の言語は素通し (エスケープだけ、span 無し、例外にしない)', () => {
    for (const lang of ['cobol', 'nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveLanguage(lang), lang).toBeNull()
      const html = render(`\`\`\`${lang}\nif (a < b) { x = "y" }\n\`\`\``)
      expect(html, lang).toContain(`<code class="language-${lang}">`)
      expect(html, lang).toContain('if (a &lt; b) { x = "y" }')
      expect(html, lang).not.toContain('data-hl=')
    }
    expect(highlightCode('x', 'nope')).toBe('')
  })

  it('無指定のフェンスは自動判定しない', () => {
    const html = render('```\ndef f(): return 1\n```')
    expect(html).toContain('<code>')
    expect(html).not.toContain('data-hl=')
  })

  it('コード本文の `<span class=` は文字列のまま (class → data-hl の置換が本文に及ばない)', () => {
    const html = render('```js\nconst s = \'<span class="x">\'\n```')
    expect(html).not.toContain('<span class=')
    expect(html).toContain('&lt;span class="x"&gt;')
    expect(html).toContain('<span data-hl="string">')
  })

  it('javascript: は引き続き弾かれ、色分け付きの本文でも生 HTML は通らない', () => {
    const html = render('[x](javascript:alert(1))\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('DOMPurify を通した後も data-hl 属性が残り、style や on* は付かない', () => {
    const html = render('```ts\nconst a: number = 1 // x\n```')
    expect(html).toContain('data-hl="keyword"')
    expect(html).toContain('data-hl="number"')
    expect(html).toContain('data-hl="comment"')
    expect(html).not.toContain('style=')
    expect(html).not.toMatch(/ on\w+=/)
  })

  it('受信中 (highlight: false) は色を付けずエスケープだけする', () => {
    const src = closeOpenFences('```py\ndef f(): return "a"')
    const html = renderMarkdown(src, { highlight: false }).html
    expect(html).toContain('<code class="language-py">')
    expect(html).toContain('def f(): return "a"')
    expect(html).not.toContain('data-hl=')
    expect(renderMarkdown(src).html).toContain('data-hl="keyword"')
  })
})

describe('コードブロックの包みとコピー用の原文 (5.1.2、T17)', () => {
  /** Puts the rendered result through the DOM once and returns the code restored from `.code-block` (the same path as ThreadPane). */
  const codes = (src: string): string[] => {
    const el = document.createElement('div')
    el.innerHTML = render(src)
    return Array.from(el.querySelectorAll<HTMLElement>('.code-block')).map((node) =>
      decodeCodeBlock(node.dataset['code'])
    )
  }

  it('フェンスは code-block で包まれ、中身の色分けはそのまま', () => {
    const html = render('```python\ndef f(x):\n    return "s"\n```')
    expect(html).toContain('<div class="code-block" data-code="')
    expect(html).toContain('<pre><code class="language-python">')
    expect(html).toContain('<span data-hl="keyword">def</span>')
  })

  it('data-code から色分け前の原文がそのまま戻る', () => {
    expect(codes('```python\ndef f(x):\n    return "s"\n```')).toEqual([
      'def f(x):\n    return "s"\n'
    ])
  })

  it('1 行目の字下げと末尾の改行が残る (DOMPurify は属性値の前後の空白を削るので生では入れない)', () => {
    expect(codes('```\n    indented\nnext\n\n```')).toEqual(['    indented\nnext\n\n'])
    // If it is turned back into the raw form put into an attribute, it fails (DOMPurify trims surrounding spaces).
    expect(render('```\n    indented\n```')).not.toContain('data-code="    ')
  })

  it('引用符・山括弧・& を含むコードでも属性を閉じられず、要素も増えない', () => {
    const code = 'a = "<b>&\'x\'</b>" // ">< img src=x>\n'
    const el = document.createElement('div')
    el.innerHTML = render(`\`\`\`js\n${code}\`\`\``)
    expect(el.querySelectorAll('.code-block')).toHaveLength(1)
    expect(el.querySelectorAll('img')).toHaveLength(0)
    expect(el.querySelector<HTMLElement>('.code-block')?.children).toHaveLength(1)
    expect(decodeCodeBlock(el.querySelector<HTMLElement>('.code-block')?.dataset['code'])).toBe(code)
  })

  it('日本語と絵文字も往復する', () => {
    expect(codes('```\n日本語の行 🍣\n```')).toEqual(['日本語の行 🍣\n'])
  })

  it('ボタンは描画結果に入らない (DOMPurify が button を落とす。UI は ThreadPane が重ねる)', () => {
    expect(render('```js\nconst a = 1\n```')).not.toContain('<button')
  })

  it('複数のフェンスはそれぞれ別の包みになり、インラインコードは包まない', () => {
    const el = document.createElement('div')
    el.innerHTML = render('```js\na\n```\n\n本文 `x` です\n\n```py\nb\n```')
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('.code-block')).map((b) =>
        decodeCodeBlock(b.dataset['code'])
      )
    ).toEqual(['a\n', 'b\n'])
    expect(el.querySelectorAll('code:not(pre code)')).toHaveLength(1)
  })

  it('受信中 (highlight: false) でも包みと data-code は同じ形', () => {
    const el = document.createElement('div')
    el.innerHTML = renderMarkdown(closeOpenFences('```ts\nconst a = 1'), { highlight: false }).html
    const block = el.querySelector<HTMLElement>('.code-block')
    expect(decodeCodeBlock(block?.dataset['code'])).toBe('const a = 1\n')
    expect(block?.innerHTML).not.toContain('data-hl=')
  })

  it('壊れた data-code は空文字になる (例外にしない)', () => {
    expect(decodeCodeBlock('%E0%A4%A')).toBe('')
    expect(decodeCodeBlock(undefined)).toBe('')
  })
})

describe('字下げ記法のコードブロックも包む (5.1.2.1、T25)', () => {
  const codes = (src: string): string[] => {
    const el = document.createElement('div')
    el.innerHTML = render(src)
    return Array.from(el.querySelectorAll<HTMLElement>('.code-block')).map((node) =>
      decodeCodeBlock(node.dataset['code'])
    )
  }

  it('4 スペース字下げのブロックが code-block で包まれる', () => {
    const html = render('本文\n\n    const a = 1\n')
    expect(html).toContain('<div class="code-block" data-code="')
    expect(html).toContain('<pre><code>')
  })

  it('data-code は fence と同じ作り (字下げを外した原文が往復する)', () => {
    expect(codes('本文\n\n    const a = 1\n    const b = 2\n')).toEqual([
      'const a = 1\nconst b = 2\n'
    ])
  })

  it('入れ子の字下げ (先頭の空白) と末尾の改行が残る', () => {
    // What is left after removing four spaces starts with "  deeper". This is what disappears when passed raw to DOMPurify.
    expect(codes('本文\n\n      deeper\n    back\n')).toEqual(['  deeper\nback\n'])
    expect(render('本文\n\n      deeper\n')).not.toContain('data-code="  ')
  })

  it('字下げ記法には色分けを付けない (markdown-it の highlight は fence だけ)', () => {
    expect(render('本文\n\n    def f(x):\n')).not.toContain('data-hl=')
  })

  it('引用符や山括弧を含む字下げブロックでも要素が増えない', () => {
    const el = document.createElement('div')
    el.innerHTML = render('本文\n\n    a = "<img src=x>"\n')
    expect(el.querySelectorAll('.code-block')).toHaveLength(1)
    expect(el.querySelectorAll('img')).toHaveLength(0)
    expect(codes('本文\n\n    a = "<img src=x>"\n')).toEqual(['a = "<img src=x>"\n'])
  })

  it('ボタンは描画結果に入らない (UI は host 側が重ねる)', () => {
    expect(render('本文\n\n    const a = 1\n')).not.toContain('<button')
  })
})
