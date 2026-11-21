/**
 * TODO 1215: a small parser for `.csv` / `.tsv` (`plugins/_shared/csv.ts`), the judgment of when to show as a table (`plugins/aios.text/viewer/sheet-mode.ts`),
 * and right-aligning of string cells (`looksNumericText` in `plugins/_shared/sheet.ts`).
 */
import { describe, expect, it } from 'vitest'
import { parseDelimited, tableRowsOf } from '../plugins/_shared/csv.js'
import { looksNumericText } from '../plugins/_shared/sheet.js'
import {
  INITIAL_SHEET_MODE,
  SHEET_VIEW_MODES,
  delimiterOf,
  sheetAcceptsInsert
} from '../plugins/aios.text/viewer/sheet-mode.js'

const rows = (text: string, delimiter: ',' | '\t' = ','): string[][] => parseDelimited(text, delimiter).rows

describe('parseDelimited (RFC 4180)', () => {
  it('素の欄と行', () => {
    expect(rows('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('引用の中のカンマ・改行・"" (エスケープした引用符)', () => {
    expect(rows('"a,b","line1\nline2","say ""hi"""\n')).toEqual([['a,b', 'line1\nline2', 'say "hi"']])
    expect(rows('"x\r\ny",z\r\n')).toEqual([['x\r\ny', 'z']])
  })

  it('CRLF / LF / CR、混ざっていても行に分ける', () => {
    expect(rows('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(rows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('末尾の改行の有無で行の数は変わらない', () => {
    expect(rows('a,b\n1,2')).toEqual(rows('a,b\n1,2\n'))
    expect(rows('a,b\n1,2\r\n')).toEqual(rows('a,b\n1,2'))
    expect(parseDelimited('a\n', ',').terminated).toBe(true)
    expect(parseDelimited('a', ',').terminated).toBe(false)
  })

  it('行ごとに欄の数が違ってよい', () => {
    expect(rows('a\n1,2,3\nx,y\n')).toEqual([['a'], ['1', '2', '3'], ['x', 'y']])
  })

  it('空の欄・区切りで終わる行・途中の空の行', () => {
    expect(rows(',a,,\n')).toEqual([['', 'a', '', '']])
    expect(rows('a,')).toEqual([['a', '']])
    expect(rows('a\n\nb\n')).toEqual([['a'], [''], ['b']])
    expect(rows('"",""\n')).toEqual([['', '']])
  })

  it('空のファイルと BOM だけのファイルは 0 行', () => {
    expect(parseDelimited('', ',')).toEqual({ rows: [], terminated: true })
    expect(rows('\ufeff')).toEqual([])
  })

  it('先頭の BOM は値に入れない (引用の欄でも)', () => {
    expect(rows('\ufeffname,age\n')).toEqual([['name', 'age']])
    expect(rows('\ufeff"name",age\n')).toEqual([['name', 'age']])
  })

  it('日本語はそのまま', () => {
    expect(rows('氏名,住所\n山田,"東京都,千代田区"\n')).toEqual([
      ['氏名', '住所'],
      ['山田', '東京都,千代田区']
    ])
  })

  it('崩れた形にも寛容: 閉じた引用の後の文字は足す・欄の途中の引用符はただの文字・閉じない引用は終わりまで', () => {
    expect(rows('"a"b,c\n')).toEqual([['ab', 'c']])
    expect(rows('a"b,c\n')).toEqual([['a"b', 'c']])
    expect(rows('"abc,def\nghi')).toEqual([['abc,def\nghi']])
  })

  it('TSV はタブで区切り、カンマは区切らない', () => {
    expect(rows('a\tb,c\n"x\ty"\tz\n', '\t')).toEqual([
      ['a', 'b,c'],
      ['x\ty', 'z']
    ])
  })

  it('大きな表も線形に読む (10 万行)', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => `${i},"name ${i}",${i * 2}`).join('\n')
    const started = Date.now()
    const out = rows(big)
    expect(out.length).toBe(100_000)
    expect(out[99_999]).toEqual(['99999', 'name 99999', '199998'])
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('tableRowsOf (host が先頭だけ渡したとき)', () => {
  it('truncated なら改行で終わっていない最後の行を落とす', () => {
    expect(tableRowsOf('a,b\n1,2\n3,', ',', true)).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    // A line cut off in the middle of a quote is also dropped.
    expect(tableRowsOf('a\n"multi\nline', ',', true)).toEqual([['a']])
    // If it ends with a line break, it is kept.
    expect(tableRowsOf('a\n1\n', ',', true)).toEqual([['a'], ['1']])
  })

  it('truncated でなければ最後の行も残す', () => {
    expect(tableRowsOf('a\n3,', ',', false)).toEqual([['a'], ['3', '']])
  })
})

describe('sheet-mode (aios.text の Table / Text)', () => {
  it('既定は表、切替は Table → Text の順', () => {
    expect(INITIAL_SHEET_MODE).toBe('table')
    expect(SHEET_VIEW_MODES).toEqual(['table', 'text'])
  })

  it('拡張子で区切り文字を決める (大文字も)。それ以外は表にしない', () => {
    expect(delimiterOf('data.csv')).toBe(',')
    expect(delimiterOf('DATA.CSV')).toBe(',')
    expect(delimiterOf('/tmp/x/list.tsv')).toBe('\t')
    expect(delimiterOf('C:\\x\\list.Tsv')).toBe('\t')
    expect(delimiterOf('notes.txt')).toBeNull()
    expect(delimiterOf('csv')).toBeNull()
    expect(delimiterOf('.csv')).toBeNull()
    expect(delimiterOf('a.csv.bak')).toBeNull()
  })

  it('表の間は drop の挿入を受けない', () => {
    expect(sheetAcceptsInsert('table')).toBe(false)
    expect(sheetAcceptsInsert('text')).toBe(true)
    expect(sheetAcceptsInsert(null)).toBe(true)
  })
})

describe('looksNumericText (文字列のセルの右寄せ)', () => {
  it('数に見えるもの', () => {
    for (const text of ['0', '-12', '+3.5', '1,234,567', '1,234.50', '.5', '1e10', '2.5E-3', '45%', ' 7 ']) {
      expect(looksNumericText(text), text).toBe(true)
    }
  })
  it('見えないもの', () => {
    for (const text of ['', ' ', 'abc', '1.2.3', '12,34', 'e5', '-', '1-2', '2026-01-02', '０１２']) {
      expect(looksNumericText(text), text).toBe(false)
    }
  })
})
