/**
 * @vitest-environment jsdom
 *
 * File search word highlighting (ARCHITECTURE.md 7.4.3, TODO 56): the pure-function part.
 *
 *  - splitting the search box string into words (whitespace and full-width spaces; empty and duplicate words are dropped)
 *  - listing matches (case-insensitive, each word separately for multiple words, in `from` order, with a cap)
 *  - `createEditor` adds `.cm-searchHit` to matches, and removes it with `null`
 *
 * The exception for hard-coded colors (yellow background, black text) is checked by test/theme-tokens.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { createEditor } from '../plugins/_shared/editor.js'
import { findHighlightRanges, splitHighlightTerms } from '../plugins/_shared/highlight.js'

describe('検索語の切り出し', () => {
  it('空白で分け、空と重複を落とす', () => {
    expect(splitHighlightTerms('  foo  bar　foo\tbaz ')).toEqual(['foo', 'bar', 'baz'])
  })
  it('無ければ空', () => {
    expect(splitHighlightTerms(null)).toEqual([])
    expect(splitHighlightTerms(undefined)).toEqual([])
    expect(splitHighlightTerms('   ')).toEqual([])
  })
})

describe('一致箇所の列挙', () => {
  const doc = Text.of(['Foo bar', 'foo 青い空', 'FOO'])

  it('大文字小文字を区別せず、各語をそれぞれ from 順に', () => {
    const ranges = findHighlightRanges(doc, ['青', 'foo'])
    expect(ranges).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
      { from: 12, to: 13 },
      { from: 16, to: 19 }
    ])
  })
  it('語が無ければ空、当たらなければ空', () => {
    expect(findHighlightRanges(doc, [])).toEqual([])
    expect(findHighlightRanges(doc, ['zzz'])).toEqual([])
  })
  it('上限で打ち切る', () => {
    expect(findHighlightRanges(doc, ['foo'], 2)).toHaveLength(2)
  })
})

describe('createEditor.setHighlight', () => {
  function build(): { host: HTMLElement; editor: ReturnType<typeof createEditor> } {
    const host = document.createElement('div')
    document.body.append(host)
    const editor = createEditor(host, {
      value: 'alpha beta\ngamma alpha',
      filename: 'x.txt',
      readOnly: true,
      theme: 'light',
      onChange: () => {}
    })
    return { host, editor }
  }

  it('一致箇所に .cm-searchHit を付け、null で消す', () => {
    const { host, editor } = build()
    editor.setHighlight('alpha gamma')
    const hits = [...host.querySelectorAll('.cm-searchHit')].map((el) => el.textContent)
    expect(hits).toEqual(['alpha', 'gamma', 'alpha'])
    editor.setHighlight(null)
    expect(host.querySelectorAll('.cm-searchHit')).toHaveLength(0)
    editor.destroy()
  })

  it('setValue の後に呼び直せば新しい本文で光る', () => {
    const { host, editor } = build()
    editor.setHighlight('beta')
    editor.setValue('nothing here\nbeta again')
    editor.setHighlight('beta')
    expect([...host.querySelectorAll('.cm-searchHit')].map((el) => el.textContent)).toEqual(['beta'])
    editor.destroy()
  })
})
