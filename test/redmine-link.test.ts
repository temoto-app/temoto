/**
 * @vitest-environment jsdom
 *
 * TODO 811 (wave 44 bundle A): linking Redmine ticket numbers in answers.
 * Checks the base URL (https only), `#22955` in the body, and only the `#` and ticket columns of tables. Does nothing if unset.
 */
import { describe, expect, it } from 'vitest'
import { normalizeRedmineBase, redmineIssueUrl } from '../src/shared/redmine-link.js'
import { renderMarkdown } from '../src/shared/markdown/render.js'

const BASE = 'https://redmine.example.com'
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)
const render = (source: string, redmineBase: string | null = BASE): string =>
  renderMarkdown(source, { redmineBase, linkPaths: true }).html

describe('normalizeRedmineBase', () => {
  it('https only; drops the trailing / and keeps the subpath', () => {
    expect(normalizeRedmineBase('https://r.example.com/')).toBe('https://r.example.com')
    expect(normalizeRedmineBase('  https://r.example.com/redmine/ ')).toBe('https://r.example.com/redmine')
  })
  it('http, credentials, query, fragment, a broken value, and empty cannot be used', () => {
    for (const bad of [
      'http://r.example.com',
      'ftp://x',
      'https://u:p@r.example.com',
      'https://r.example.com/?a=1',
      'https://r.example.com/#x',
      'nope',
      '',
      '   '
    ]) {
      expect(normalizeRedmineBase(bad)).toBeNull()
    }
    expect(normalizeRedmineBase(null)).toBeNull()
    expect(normalizeRedmineBase(42)).toBeNull()
  })
  it('redmineIssueUrl validates the number', () => {
    expect(redmineIssueUrl(BASE, '22955')).toBe(`${BASE}/issues/22955`)
    expect(redmineIssueUrl(BASE, '0')).toBeNull()
    expect(redmineIssueUrl(BASE, '12a')).toBeNull()
    expect(redmineIssueUrl('http://x', '123')).toBeNull()
  })
})

describe('renderMarkdown: Redmine ticket numbers', () => {
  it('turns #22955 in the body into a link; does not pick up a short #12 or colors', () => {
    const html = render('進行中は #22955 と #23001。#12 と #fff は対象外。')
    expect(hrefs(html)).toEqual([`${BASE}/issues/22955`, `${BASE}/issues/23001`])
    expect(html).toContain('>#22955</a>')
  })
  it('does nothing when unset or set to something that is not https', () => {
    expect(hrefs(render('#22955', null))).toEqual([])
    expect(hrefs(render('#22955', ''))).toEqual([])
    expect(hrefs(render('#22955', 'http://r.example.com'))).toEqual([])
  })
  it("in a table, only the numbers in the column headed '#' or 'チケット' become links", () => {
    const md = ['| # | 件名 | 数 |', '|---|---|---|', '| 22955 | 直す | 12345 |', '| #22956 | 足す | 7 |'].join('\n')
    expect(hrefs(render(md))).toEqual([`${BASE}/issues/22955`, `${BASE}/issues/22956`])
    const other = ['| ID | 件名 |', '|---|---|', '| 22955 | 直す |'].join('\n')
    expect(hrefs(render(other))).toEqual([])
    const ja = ['| チケット | 件名 |', '|---|---|', '| 5 | 直す |'].join('\n')
    expect(hrefs(render(ja))).toEqual([`${BASE}/issues/5`])
  })
  it('does not touch code, the inside of existing links, or code blocks', () => {
    const md = ['`#22955`', '', '[#22955](https://other.example.com/x)', '', '```', '#22955', '```'].join('\n')
    expect(hrefs(render(md))).toEqual(['https://other.example.com/x'])
  })
  it('rendering without the setting (viewer) is as before', () => {
    expect(hrefs(renderMarkdown('#22955').html)).toEqual([])
  })
})

describe('restoring after a table (code-review)', () => {
  it('a paragraph of only digits after a table with a ticket column does not become a link', () => {
    const html = render('| タイトル | # |\n| --- | --- |\n| a | 42 |\n\n42\n')
    expect(hrefs(html)).toEqual([`${BASE}/issues/42`])
  })
})

describe('surrounding formatting and false positives (TODO 1210 a)', () => {
  const issue = (n: string): string => `${BASE}/issues/${n}`
  it.each([
    ['bold', '**#12345**'],
    ['italic', '*#12345*'],
    ['italic (_)', '_#12345_'],
    ['strikethrough', '~~#12345~~'],
    ['a sentence inside bold', '**直した #12345 を確認**'],
    ['a heading', '## 対応 #12345'],
    ['a bullet list', '- #12345 を直す\n- 次'],
    ['a numbered list', '1. #12345 を直す'],
    ['a quote', '> #12345 を見て'],
    ['parentheses', '(#12345)'],
    ['trailing punctuation', '#12345。'],
    ['next to a link', '[x](https://o.example.com/) #12345']
  ])('becomes a link inside %s', (_name, md) => {
    expect(hrefs(render(md))).toContain(issue('12345'))
  })

  it('does not break <strong> even inside bold', () => {
    const html = render('**#12345**')
    expect(html).toContain('<strong><a ')
    expect(html).toContain('>#12345</a></strong>')
  })

  it.each([
    ['link text', '[#12345](https://o.example.com/x)', ['https://o.example.com/x']],
    ['bold link text', '[**#12345**](https://o.example.com/x)', ['https://o.example.com/x']],
    ['inline code', '`#12345`', []],
    ['a code block', '```\n#12345\n```', []],
    ['indented code', '    #12345', []],
    ['a URL fragment', 'https://x.example.com/y#12345', ['https://x.example.com/y#12345']],
    ['a URL fragment (right after /)', 'https://x.example.com/#12345', ['https://x.example.com/#12345']],
    ['a URL fragment (< >)', '<https://x.example.com/y#12345>', ['https://x.example.com/y#12345']],
    ['the middle of a word', 'abc#12345', []],
    ['an HTML numeric reference', '&#12345;', []],
    ['color codes (hex)', 'color: #fff #ff00aa #12ab56', []],
    ['2 digits or fewer', '#12 と #1', []],
    ['10 digits or more', '#1234567890', []],
    ['a leading 0', '#012345', []],
    ['consecutive ##', '##12345', []]
  ])('does not make %s a link', (_name, md, expected) => {
    expect(hrefs(render(md))).toEqual(expected)
  })

  it('a color code of only digits (#123456) matches as in the current rule', () => {
    expect(hrefs(render('#123456'))).toEqual([issue('123456')])
  })

  it('links all of them even if the same number appears several times', () => {
    expect(hrefs(render('#12345 と #12345'))).toEqual([issue('12345'), issue('12345')])
  })
})
