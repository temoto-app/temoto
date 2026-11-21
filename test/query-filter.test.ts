import { describe, expect, it } from 'vitest'
import {
  asNameTerms,
  asTextTerms,
  isPlainQuery,
  likeContains,
  parseQueryFilter
} from '../src/index-kernel/query-filter.js'

describe('parseQueryFilter (TODO 813)', () => {
  it('a query without a filter is left as it is', () => {
    const f = parseQueryFilter('会議 の 記録')
    expect(f).toEqual({ text: '会議 の 記録', exts: [], names: [], images: false })
    expect(isPlainQuery(f)).toBe(true)
  })

  it('empty or whitespace only', () => {
    expect(parseQueryFilter('')).toEqual({ text: '', exts: [], names: [], images: false })
    expect(parseQueryFilter('   　 ')).toEqual({ text: '', exts: [], names: [], images: false })
  })

  it('ext: is folded to lowercase and a leading dot is ignored', () => {
    expect(parseQueryFilter('ext:md').exts).toEqual(['md'])
    expect(parseQueryFilter('EXT:MD').exts).toEqual(['md'])
    expect(parseQueryFilter('ext:.md').exts).toEqual(['md'])
    expect(parseQueryFilter('ext:..md').exts).toEqual(['md'])
  })

  it('multiple ext: or comma separated is OR (duplicates become one)', () => {
    expect(parseQueryFilter('ext:md ext:txt').exts).toEqual(['md', 'txt'])
    expect(parseQueryFilter('ext:md,.TXT,md').exts).toEqual(['md', 'txt'])
  })

  it('a mix of name: and body words', () => {
    const f = parseQueryFilter('設計 name:22719 ext:md レビュー')
    expect(f).toEqual({ text: '設計 レビュー', exts: ['md'], names: ['22719'], images: false })
    expect(isPlainQuery(f)).toBe(false)
  })

  it('name: is lowercase and multiple are AND', () => {
    expect(parseQueryFilter('name:Foo name:bar').names).toEqual(['foo', 'bar'])
  })

  it('*.md after a word is regarded as ext:md', () => {
    expect(parseQueryFilter('22719 *.md')).toEqual({ text: '22719', exts: ['md'], names: [], images: false })
    expect(parseQueryFilter('*.MD')).toEqual({ text: '', exts: ['md'], names: [], images: false })
  })

  it('a word containing * other than *.md stays a body word', () => {
    expect(parseQueryFilter('a*b *. *.m-d').text).toBe('a*b *. *.m-d')
  })

  it('ext: / name: with an empty value (mid-typing) is dropped', () => {
    expect(parseQueryFilter('22719 ext: name:')).toEqual({ text: '22719', exts: [], names: [], images: false })
    expect(parseQueryFilter('ext:.')).toEqual({ text: '', exts: [], names: [], images: false })
  })

  it('the value stays folded the same way as name_folded (NFC + lowercase), not NFKC', () => {
    expect(parseQueryFilter('name:ｶﾀﾛｸﾞ').names).toEqual(['ｶﾀﾛｸﾞ'])
    expect(parseQueryFilter('name:①').names).toEqual(['①'])
    expect(parseQueryFilter('ｎａｍｅ：ＡＢＣ').names).toEqual(['ａｂｃ'])
    // Only the value of the file extension is NFKC-normalized, to rescue full-width IME input (file extensions are effectively ASCII).
    expect(parseQueryFilter('ext:ＭＤ').exts).toEqual(['md'])
  })

  it('a full-width prefix also works', () => {
    expect(parseQueryFilter('ｅｘｔ：ｍｄ').exts).toEqual(['md'])
  })

  it('a word that only resembles a prefix is a body word', () => {
    expect(parseQueryFilter('extra: names:x text').text).toBe('extra: names:x text')
  })
})

describe('conversion', () => {
  it('conversation: puts the filter back into body words', () => {
    expect(asTextTerms(parseQueryFilter('22719 ext:md'))).toBe('22719 md')
    expect(asTextTerms(parseQueryFilter('name:abc'))).toBe('abc')
  })

  it('file name search: ext is a partial match on .extension', () => {
    expect(asNameTerms(parseQueryFilter('22719 ext:md'))).toBe('22719 .md')
    expect(asNameTerms(parseQueryFilter('ext:md,txt'))).toBe('.md')
    expect(asNameTerms(parseQueryFilter('abc'))).toBe('abc')
  })

  it('the LIKE needle escapes % _ \\', () => {
    expect(likeContains('a_b%c\\d')).toBe('%a\\_b\\%c\\\\d%')
  })
})
