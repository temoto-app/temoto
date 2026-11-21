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
  it('plain fields and rows', () => {
    expect(rows('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('commas, newlines and "" (escaped quotes) inside quotes', () => {
    expect(rows('"a,b","line1\nline2","say ""hi"""\n')).toEqual([['a,b', 'line1\nline2', 'say "hi"']])
    expect(rows('"x\r\ny",z\r\n')).toEqual([['x\r\ny', 'z']])
  })

  it('CRLF / LF / CR, split into rows even when mixed', () => {
    expect(rows('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(rows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('the number of rows does not change with a trailing newline', () => {
    expect(rows('a,b\n1,2')).toEqual(rows('a,b\n1,2\n'))
    expect(rows('a,b\n1,2\r\n')).toEqual(rows('a,b\n1,2'))
    expect(parseDelimited('a\n', ',').terminated).toBe(true)
    expect(parseDelimited('a', ',').terminated).toBe(false)
  })

  it('the number of fields may differ per row', () => {
    expect(rows('a\n1,2,3\nx,y\n')).toEqual([['a'], ['1', '2', '3'], ['x', 'y']])
  })

  it('empty fields, a row ending with a separator, and an empty row in the middle', () => {
    expect(rows(',a,,\n')).toEqual([['', 'a', '', '']])
    expect(rows('a,')).toEqual([['a', '']])
    expect(rows('a\n\nb\n')).toEqual([['a'], [''], ['b']])
    expect(rows('"",""\n')).toEqual([['', '']])
  })

  it('an empty file and a BOM-only file give 0 rows', () => {
    expect(parseDelimited('', ',')).toEqual({ rows: [], terminated: true })
    expect(rows('\ufeff')).toEqual([])
  })

  it('does not include a leading BOM in the value (even for a quoted field)', () => {
    expect(rows('\ufeffname,age\n')).toEqual([['name', 'age']])
    expect(rows('\ufeff"name",age\n')).toEqual([['name', 'age']])
  })

  it('Japanese is kept as is', () => {
    expect(rows('氏名,住所\n山田,"東京都,千代田区"\n')).toEqual([
      ['氏名', '住所'],
      ['山田', '東京都,千代田区']
    ])
  })

  it('tolerant of malformed input: appends characters after a closed quote, a quote in the middle of a field is a plain character, an unclosed quote runs to the end', () => {
    expect(rows('"a"b,c\n')).toEqual([['ab', 'c']])
    expect(rows('a"b,c\n')).toEqual([['a"b', 'c']])
    expect(rows('"abc,def\nghi')).toEqual([['abc,def\nghi']])
  })

  it('TSV is separated by tabs and not by commas', () => {
    expect(rows('a\tb,c\n"x\ty"\tz\n', '\t')).toEqual([
      ['a', 'b,c'],
      ['x\ty', 'z']
    ])
  })

  it('reads a large table linearly (100,000 rows)', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => `${i},"name ${i}",${i * 2}`).join('\n')
    const started = Date.now()
    const out = rows(big)
    expect(out.length).toBe(100_000)
    expect(out[99_999]).toEqual(['99999', 'name 99999', '199998'])
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('tableRowsOf (when the host passed only the head)', () => {
  it('when truncated, drops the last row that does not end in a newline', () => {
    expect(tableRowsOf('a,b\n1,2\n3,', ',', true)).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    // A line cut off in the middle of a quote is also dropped.
    expect(tableRowsOf('a\n"multi\nline', ',', true)).toEqual([['a']])
    // If it ends with a line break, it is kept.
    expect(tableRowsOf('a\n1\n', ',', true)).toEqual([['a'], ['1']])
  })

  it('when not truncated, keeps the last row too', () => {
    expect(tableRowsOf('a\n3,', ',', false)).toEqual([['a'], ['3', '']])
  })
})

describe('sheet-mode (Table / Text of aios.text)', () => {
  it('the default is the table, and switching goes Table → Text in that order', () => {
    expect(INITIAL_SHEET_MODE).toBe('table')
    expect(SHEET_VIEW_MODES).toEqual(['table', 'text'])
  })

  it('decides the delimiter by the extension (uppercase too); anything else is not a table', () => {
    expect(delimiterOf('data.csv')).toBe(',')
    expect(delimiterOf('DATA.CSV')).toBe(',')
    expect(delimiterOf('/tmp/x/list.tsv')).toBe('\t')
    expect(delimiterOf('C:\\x\\list.Tsv')).toBe('\t')
    expect(delimiterOf('notes.txt')).toBeNull()
    expect(delimiterOf('csv')).toBeNull()
    expect(delimiterOf('.csv')).toBeNull()
    expect(delimiterOf('a.csv.bak')).toBeNull()
  })

  it('does not accept a drop insertion while in the table', () => {
    expect(sheetAcceptsInsert('table')).toBe(false)
    expect(sheetAcceptsInsert('text')).toBe(true)
    expect(sheetAcceptsInsert(null)).toBe(true)
  })
})

describe('looksNumericText (right alignment of string cells)', () => {
  it('things that look numeric', () => {
    for (const text of ['0', '-12', '+3.5', '1,234,567', '1,234.50', '.5', '1e10', '2.5E-3', '45%', ' 7 ']) {
      expect(looksNumericText(text), text).toBe(true)
    }
  })
  it('things that do not look numeric', () => {
    for (const text of ['', ' ', 'abc', '1.2.3', '12,34', 'e5', '-', '1-2', '2026-01-02', '０１２']) {
      expect(looksNumericText(text), text).toBe(false)
    }
  })
})
