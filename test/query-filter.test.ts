import { describe, expect, it } from 'vitest'
import {
  asNameTerms,
  asTextTerms,
  isPlainQuery,
  likeContains,
  parseQueryFilter
} from '../src/index-kernel/query-filter.js'

describe('parseQueryFilter (TODO 813)', () => {
  it('絞り込みの無いクエリはそのまま', () => {
    const f = parseQueryFilter('会議 の 記録')
    expect(f).toEqual({ text: '会議 の 記録', exts: [], names: [], images: false })
    expect(isPlainQuery(f)).toBe(true)
  })

  it('空・空白だけ', () => {
    expect(parseQueryFilter('')).toEqual({ text: '', exts: [], names: [], images: false })
    expect(parseQueryFilter('   　 ')).toEqual({ text: '', exts: [], names: [], images: false })
  })

  it('ext: は小文字に畳み、先頭のドットを無視する', () => {
    expect(parseQueryFilter('ext:md').exts).toEqual(['md'])
    expect(parseQueryFilter('EXT:MD').exts).toEqual(['md'])
    expect(parseQueryFilter('ext:.md').exts).toEqual(['md'])
    expect(parseQueryFilter('ext:..md').exts).toEqual(['md'])
  })

  it('ext: が複数・カンマ区切りなら OR (重複は 1 つ)', () => {
    expect(parseQueryFilter('ext:md ext:txt').exts).toEqual(['md', 'txt'])
    expect(parseQueryFilter('ext:md,.TXT,md').exts).toEqual(['md', 'txt'])
  })

  it('name: と本文の語の混在', () => {
    const f = parseQueryFilter('設計 name:22719 ext:md レビュー')
    expect(f).toEqual({ text: '設計 レビュー', exts: ['md'], names: ['22719'], images: false })
    expect(isPlainQuery(f)).toBe(false)
  })

  it('name: は小文字・複数は AND', () => {
    expect(parseQueryFilter('name:Foo name:bar').names).toEqual(['foo', 'bar'])
  })

  it('語の後ろの *.md は ext:md とみなす', () => {
    expect(parseQueryFilter('22719 *.md')).toEqual({ text: '22719', exts: ['md'], names: [], images: false })
    expect(parseQueryFilter('*.MD')).toEqual({ text: '', exts: ['md'], names: [], images: false })
  })

  it('*.md 以外の * を含む語は本文の語のまま', () => {
    expect(parseQueryFilter('a*b *. *.m-d').text).toBe('a*b *. *.m-d')
  })

  it('値が空の ext: / name: (入力の途中) は捨てる', () => {
    expect(parseQueryFilter('22719 ext: name:')).toEqual({ text: '22719', exts: [], names: [], images: false })
    expect(parseQueryFilter('ext:.')).toEqual({ text: '', exts: [], names: [], images: false })
  })

  it('値は name_folded と同じ畳み方 (NFC + 小文字) のまま、NFKC にしない', () => {
    expect(parseQueryFilter('name:ｶﾀﾛｸﾞ').names).toEqual(['ｶﾀﾛｸﾞ'])
    expect(parseQueryFilter('name:①').names).toEqual(['①'])
    expect(parseQueryFilter('ｎａｍｅ：ＡＢＣ').names).toEqual(['ａｂｃ'])
    // Only the value of the file extension is NFKC-normalized, to rescue full-width IME input (file extensions are effectively ASCII).
    expect(parseQueryFilter('ext:ＭＤ').exts).toEqual(['md'])
  })

  it('全角の接頭辞も効く', () => {
    expect(parseQueryFilter('ｅｘｔ：ｍｄ').exts).toEqual(['md'])
  })

  it('接頭辞に似ているだけの語は本文の語', () => {
    expect(parseQueryFilter('extra: names:x text').text).toBe('extra: names:x text')
  })
})

describe('変換', () => {
  it('会話: 絞り込みを本文の語に戻す', () => {
    expect(asTextTerms(parseQueryFilter('22719 ext:md'))).toBe('22719 md')
    expect(asTextTerms(parseQueryFilter('name:abc'))).toBe('abc')
  })

  it('ファイル名検索: ext は .拡張子 の部分一致', () => {
    expect(asNameTerms(parseQueryFilter('22719 ext:md'))).toBe('22719 .md')
    expect(asNameTerms(parseQueryFilter('ext:md,txt'))).toBe('.md')
    expect(asNameTerms(parseQueryFilter('abc'))).toBe('abc')
  })

  it('LIKE の針は % _ \\ を逃がす', () => {
    expect(likeContains('a_b%c\\d')).toBe('%a\\_b\\%c\\\\d%')
  })
})
