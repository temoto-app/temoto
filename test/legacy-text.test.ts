/**
 * TODO 1215 code review (wave 83 Y4): whether to read non-UTF-8 text as EUC-JP or Shift_JIS (`decodeLegacyJapanese`).
 * It is called only when the Broker's `fs.read` finds the bytes invalid as UTF-8, so here byte sequences that are invalid as UTF-8 are passed in.
 */
import { describe, expect, it } from 'vitest'
import { decodeLegacyJapanese } from '../src/main/capability/legacy-text.js'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const decode = (buffer: Uint8Array, truncated = false): string | null => decodeLegacyJapanese(buffer, truncated)

describe('decodeLegacyJapanese', () => {
  it('Shift_JIS of half-width kana only (「ﾌﾘｺﾐ,100」) is not mistaken for EUC-JP kanji (「蒙歳」)', () => {
    expect(decode(bytes(0xcc, 0xd8, 0xba, 0xd0, 0x2c, 0x31, 0x30, 0x30, 0x0a))).toBe('ﾌﾘｺﾐ,100\n')
  })

  it('Shift_JIS of kanji only (「東京」) is read as Shift_JIS', () => {
    expect(decode(bytes(0x93, 0x8c, 0x8b, 0x9e, 0x0a))).toBe('東京\n')
  })

  it('Shift_JIS mixed with kana (「東京,あ」 CRLF) is read as Shift_JIS', () => {
    expect(decode(bytes(0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x82, 0xa0, 0x0d, 0x0a))).toBe('東京,あ\r\n')
  })

  it('EUC-JP mixed with kana (「東京,あ」) is read as EUC-JP', () => {
    expect(decode(bytes(0xc5, 0xec, 0xb5, 0xfe, 0x2c, 0xa4, 0xa2, 0x0a))).toBe('東京,あ\n')
  })

  it('EUC-JP hiragana readable both ways (「あい」) takes EUC-JP by the kana ratio (in Shift_JIS it would be a run of half-width kana)', () => {
    expect(decode(bytes(0xa4, 0xa2, 0xa4, 0xa4, 0x0a))).toBe('あい\n')
  })

  it('GBK 「你好,世界」 is null rather than random kanji (the caller uses U+FFFD)', () => {
    expect(decode(bytes(0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7))).toBeNull()
  })

  it('EUC-KR 「안녕하세요」 is also null rather than random kanji', () => {
    expect(decode(bytes(0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4, 0x0a))).toBeNull()
  })

  it('EUC-JP without kana (kanji only) is not read (limit: it cannot be told apart from GBK / EUC-KR)', () => {
    // EUC-JP bytes for the word for Tokyo. Invalid as Shift_JIS.
    expect(decode(bytes(0xc5, 0xec, 0xb5, 0xfe, 0x0a))).toBeNull()
  })

  it('Latin-1 that cannot be read as either (「café !」) is null', () => {
    expect(decode(bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x21, 0x0a))).toBeNull()
  })

  it('a lone 0x80 that becomes a C1 control character is treated as unreadable', () => {
    expect(decode(bytes(0x61, 0x80, 0x62))).toBeNull()
  })

  it('if the truncated end is in the middle of a Shift_JIS character, drops the partial character and reads', () => {
    // The 2-byte kanji for east, then the first byte of the next kanji.
    expect(decode(bytes(0x93, 0x8c, 0x8b), true)).toBe('東')
    // Unless it is a truncation, a missing character is an error.
    expect(decode(bytes(0x93, 0x8c, 0x8b), false)).toBeNull()
  })

  it('even if the truncated end is in the middle of an EUC-JP character, reads it as EUC-JP if there is kana', () => {
    // Two kana, then the first byte of the third kana.
    expect(decode(bytes(0xa4, 0xa2, 0xa4, 0xa4, 0xa4), true)).toBe('あい')
  })
})
