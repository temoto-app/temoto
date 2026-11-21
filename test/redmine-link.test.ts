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
  it('https だけ。末尾の / は落とし、サブパスは残す', () => {
    expect(normalizeRedmineBase('https://r.example.com/')).toBe('https://r.example.com')
    expect(normalizeRedmineBase('  https://r.example.com/redmine/ ')).toBe('https://r.example.com/redmine')
  })
  it('http・認証情報・クエリ・断片・壊れた値・空は使えない', () => {
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
  it('redmineIssueUrl は番号を検める', () => {
    expect(redmineIssueUrl(BASE, '22955')).toBe(`${BASE}/issues/22955`)
    expect(redmineIssueUrl(BASE, '0')).toBeNull()
    expect(redmineIssueUrl(BASE, '12a')).toBeNull()
    expect(redmineIssueUrl('http://x', '123')).toBeNull()
  })
})

describe('renderMarkdown — Redmine のチケット番号', () => {
  it('本文の #22955 をリンクにする。短い #12 や色は拾わない', () => {
    const html = render('進行中は #22955 と #23001。#12 と #fff は対象外。')
    expect(hrefs(html)).toEqual([`${BASE}/issues/22955`, `${BASE}/issues/23001`])
    expect(html).toContain('>#22955</a>')
  })
  it('未設定・https でない設定では何もしない', () => {
    expect(hrefs(render('#22955', null))).toEqual([])
    expect(hrefs(render('#22955', ''))).toEqual([])
    expect(hrefs(render('#22955', 'http://r.example.com'))).toEqual([])
  })
  it('表は見出しが # / チケット の列の番号だけをリンクにする', () => {
    const md = ['| # | 件名 | 数 |', '|---|---|---|', '| 22955 | 直す | 12345 |', '| #22956 | 足す | 7 |'].join('\n')
    expect(hrefs(render(md))).toEqual([`${BASE}/issues/22955`, `${BASE}/issues/22956`])
    const other = ['| ID | 件名 |', '|---|---|', '| 22955 | 直す |'].join('\n')
    expect(hrefs(render(other))).toEqual([])
    const ja = ['| チケット | 件名 |', '|---|---|', '| 5 | 直す |'].join('\n')
    expect(hrefs(render(ja))).toEqual([`${BASE}/issues/5`])
  })
  it('コード・既存のリンクの中・コードブロックは触らない', () => {
    const md = ['`#22955`', '', '[#22955](https://other.example.com/x)', '', '```', '#22955', '```'].join('\n')
    expect(hrefs(render(md))).toEqual(['https://other.example.com/x'])
  })
  it('設定が無い描画 (viewer) は今までどおり', () => {
    expect(hrefs(renderMarkdown('#22955').html)).toEqual([])
  })
})

describe('表の後の戻し (code-review)', () => {
  it('チケット列を持つ表の後の、数字だけの段落はリンクにならない', () => {
    const html = render('| タイトル | # |\n| --- | --- |\n| a | 42 |\n\n42\n')
    expect(hrefs(html)).toEqual([`${BASE}/issues/42`])
  })
})

describe('周辺書式・誤検出 (TODO 1210 a)', () => {
  const issue = (n: string): string => `${BASE}/issues/${n}`
  it.each([
    ['太字', '**#12345**'],
    ['斜体', '*#12345*'],
    ['斜体 (_)', '_#12345_'],
    ['打ち消し', '~~#12345~~'],
    ['太字の中の文', '**直した #12345 を確認**'],
    ['見出し', '## 対応 #12345'],
    ['箇条書き', '- #12345 を直す\n- 次'],
    ['番号付きリスト', '1. #12345 を直す'],
    ['引用', '> #12345 を見て'],
    ['括弧の中', '(#12345)'],
    ['文末の句読点', '#12345。'],
    ['リンクの隣', '[x](https://o.example.com/) #12345']
  ])('%s の中でリンクになる', (_name, md) => {
    expect(hrefs(render(md))).toContain(issue('12345'))
  })

  it('太字の中でも <strong> を壊さない', () => {
    const html = render('**#12345**')
    expect(html).toContain('<strong><a ')
    expect(html).toContain('>#12345</a></strong>')
  })

  it.each([
    ['リンクの文字列', '[#12345](https://o.example.com/x)', ['https://o.example.com/x']],
    ['太字のリンクの文字列', '[**#12345**](https://o.example.com/x)', ['https://o.example.com/x']],
    ['インラインコード', '`#12345`', []],
    ['コードブロック', '```\n#12345\n```', []],
    ['インデントのコード', '    #12345', []],
    ['URL の断片', 'https://x.example.com/y#12345', ['https://x.example.com/y#12345']],
    ['URL の断片 (/ の直後)', 'https://x.example.com/#12345', ['https://x.example.com/#12345']],
    ['URL の断片 (< >)', '<https://x.example.com/y#12345>', ['https://x.example.com/y#12345']],
    ['語の途中', 'abc#12345', []],
    ['HTML の数値参照', '&#12345;', []],
    ['色コード (16 進)', 'color: #fff #ff00aa #12ab56', []],
    ['2 桁以下', '#12 と #1', []],
    ['10 桁以上', '#1234567890', []],
    ['先頭が 0', '#012345', []],
    ['## の連続', '##12345', []]
  ])('%s はリンクにしない', (_name, md, expected) => {
    expect(hrefs(render(md))).toEqual(expected)
  })

  it('数字だけの色コード (#123456) は今の規則のとおり当たる', () => {
    expect(hrefs(render('#123456'))).toEqual([issue('123456')])
  })

  it('同じ番号が複数あっても全部リンクにする', () => {
    expect(hrefs(render('#12345 と #12345'))).toEqual([issue('12345'), issue('12345')])
  })
})
