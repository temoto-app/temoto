/**
 * Unit tests for the Japanese tokenizer (ARCHITECTURE.md 6.4.1, spike 11a).
 *
 * **If this breaks, the decision of 6.4.1 breaks with it.**
 * In particular, 'queries of two characters or fewer can be found' is exactly why trigram was not adopted (spike 11a: trigram gave 0 hits for the words 'meeting', 'search', and 'blue' in Japanese).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildMatchQuery,
  detectLanguage,
  ensureTokenizer,
  missingQueryChars,
  shadowText
} from '../src/index-kernel/tokenize.js'

let tokenizer: Awaited<ReturnType<typeof ensureTokenizer>>

beforeAll(async () => {
  // Loading the dictionary takes about 1 second (cached afterwards).
  tokenizer = await ensureTokenizer()
}, 30_000)

describe('language detection (the Metadata stage of 6.2)', () => {
  it('a document containing Japanese is ja', () => {
    expect(detectLanguage('これは会議の議事録です')).toBe('ja')
    expect(detectLanguage('mixed 日本語 and English')).toBe('ja')
    expect(detectLanguage('カタカナのみ')).toBe('ja')
  })

  it('a document of only alphanumerics is other (unicode61 as is is fine)', () => {
    expect(detectLanguage('kubernetes deployment rollout')).toBe('other')
    expect(detectLanguage('const a = 1 // comment')).toBe('other')
  })
})

describe('word segmentation', () => {
  it('the dictionary can be read', () => {
    expect(tokenizer).not.toBeNull()
  })

  it('splits Japanese by whitespace', () => {
    const shadow = shadowText('今日の会議の議事録', 'ja', tokenizer)
    expect(shadow).toContain('会議')
    expect(shadow.split(' ').length).toBeGreaterThan(2)
    // The shadow is not a readable form. **It is not used for display** (6.5).
    expect(shadow).not.toBe('今日の会議の議事録')
  })

  it('does not segment a non-Japanese document (ASCII unchanged by NFKC stays as is)', () => {
    const text = 'kubernetes deployment rollout'
    expect(shadowText(text, 'other', tokenizer)).toBe(text)
  })

  it('full-width alphanumerics become the same term as half-width (NFKC normalization)', () => {
    expect(shadowText('ＡＷＳ の設定', 'ja', tokenizer)).toContain('AWS')
  })

  it('even for a non-Japanese (English) chunk, full-width alphanumerics become half-width by NFKC (TODO 301)', () => {
    // Previously NFKC was applied only to chunks judged 'ja', so when an English chunk contained full-width letters, the shadow went in as full-width as is.
    expect(shadowText('ｓｙｓｔｅｍ', 'other', tokenizer)).toBe('system')
    expect(shadowText('ＡＷＳ deployment', 'other', tokenizer)).toBe('AWS deployment')
  })
})

describe('query construction', () => {
  it('an empty query is null', () => {
    expect(buildMatchQuery('   ', tokenizer)).toBeNull()
    expect(buildMatchQuery('!!!', tokenizer)).toBeNull()
  })

  it('quotes each term and joins them with AND', () => {
    const match = buildMatchQuery('承認 インボックス', tokenizer)
    expect(match).toContain('AND')
    expect(match).toContain('"承認"')
  })

  it('does not break even for a query containing FTS5 syntax characters', () => {
    const match = buildMatchQuery('a "b" OR c*', tokenizer)
    expect(match).not.toBeNull()
    // Quotes are escaped, so a bare OR / * does not remain as syntax.
    expect(match?.includes(' OR ')).toBe(false)
  })

  it('symbols inside a term are not removed and are passed quoted (TODO 837)', () => {
    expect(buildMatchQuery('foo.bar', tokenizer)).toBe('"foo.bar"')
    expect(buildMatchQuery('file_name', tokenizer)).toBe('"file_name"')
    expect(buildMatchQuery('192.168.1.10', tokenizer)).toBe('"192.168.1.10"')
    expect(buildMatchQuery('foo.bar', tokenizer, true)).toBe('"foo.bar"*')
    // `*` applies to the last word of the phrase, so the P6 one-character judgment is also checked there (so that `b*` does not scan the whole vocabulary).
    expect(buildMatchQuery('foo.b', tokenizer, true)).toBe('"foo.b"')
    expect(buildMatchQuery('file_n', tokenizer, true)).toBe('"file_n"')
    // Words made only of symbols are dropped.
    expect(buildMatchQuery('foo !!! bar', tokenizer)).toBe('"foo" AND "bar"')
  })

  it('with prefix set, only the last term becomes a prefix match (incremental search in the UI)', () => {
    const match = buildMatchQuery('会議 議事', tokenizer, true)
    expect(match?.endsWith('*')).toBe(true)
  })

  it('a Japanese query of 2 characters or fewer also becomes a term (the part trigram could not look up)', () => {
    for (const query of ['会議', '検索', '青']) {
      const match = buildMatchQuery(query, tokenizer)
      expect(match).not.toBeNull()
      expect(match).toContain(query)
    }
  })

  it('a full-width alphanumeric query is NFKC-normalized into a half-width term (TODO 301)', () => {
    // The body side (shadowText) is also always NFKC-folded, so a full-width query for the word system matches 'system' in an English chunk.
    expect(buildMatchQuery('ｓｙｓｔｅｍ', tokenizer)).toBe('"system"')
    expect(buildMatchQuery('ＡＷＳ', tokenizer, true)).toBe('"AWS"*')
  })
})

/**
 * The cutoff for one-character prefix matches (P6).
 *
 * **The cost is proportional to the share that words starting with that one character take in the vocabulary**, so only Latin letters, of which there are just 26 kinds as word starts, are the ones to cut (`scripts/bench/fts-prefix-script.mjs`: with 200,000 chunks, one Latin letter took 141 ms / exact match 0 ms; one Japanese character took 17 ms / exact match 9 ms).
 */
describe('conditions for adding a prefix match (P6)', () => {
  it('does not add `*` to a single Latin letter (a form that takes 4 to 5 seconds on a real machine)', () => {
    expect(buildMatchQuery('a', tokenizer, true)).toBe('"a"')
    expect(buildMatchQuery('1', tokenizer, true)).toBe('"1"')
    // Even when the previous word is long, what is judged is **the last word**.
    expect(buildMatchQuery('kubernetes a', tokenizer, true)).toBe('"kubernetes" AND "a"')
  })

  it('adds `*` for 2 or more characters (incremental search as before)', () => {
    expect(buildMatchQuery('ab', tokenizer, true)).toBe('"ab"*')
    expect(buildMatchQuery('kube', tokenizer, true)).toBe('"kube"*')
  })

  it('counts characters by code point (a surrogate pair is 1 character)', () => {
    // U+1D41A (MATHEMATICAL BOLD SMALL A). It is 2 units in UTF-16 but is one character, so no `*` is added.
    // NFKC compatibility decomposition folds it to a plain 'a' (a side effect of always applying NFKC since TODO 301). Even when folded, its classification as a one-character Latin letter does not change, and `*` still is not added.
    const bold = '\u{1D41A}'
    expect([...bold].length).toBe(1)
    expect(bold.length).toBe(2)
    expect(buildMatchQuery(bold, tokenizer, true)).toBe('"a"')
  })

  it('adds `*` to a single Japanese character (to protect the recall of 6.4.1)', () => {
    // Word splitting makes the inflected form of 'blue' one word. If it were an exact match, spike 11a's needle 'blue' could no longer be found, and the reason trigram was not adopted would itself break.
    expect(buildMatchQuery('青', tokenizer, true)).toBe('"青"*')
    expect(buildMatchQuery('の', tokenizer, true)).toBe('"の"*')
    expect(buildMatchQuery('ア', tokenizer, true)).toBe('"ア"*')
    // Kanji outside the BMP (CJK Extension B) are also treated as one Japanese character.
    expect(buildMatchQuery('\u{20BB7}', tokenizer, true)).toBe('"\u{20BB7}"*')
  })

  it('no `*` is added at all when prefix is not set (gateway path)', () => {
    expect(buildMatchQuery('青', tokenizer)).toBe('"青"')
    expect(buildMatchQuery('kube', tokenizer)).toBe('"kube"')
  })
})

/**
 * The minimum character count (P8 / item 41, 6.4.1 'minimum character count'). It is a different layer from prefix matching (P6): this one decides whether to look up the index at all. The floor is also split by writing system: the words 'meeting' and 'blue' are guarded.
 */
describe('minimum character count (P8 / item 41)', () => {
  it('3 characters for Latin letters and digits only (1 character 141 ms / 3 characters 0 ms)', () => {
    expect(missingQueryChars('a')).toBe(2)
    expect(missingQueryChars('ab')).toBe(1)
    expect(missingQueryChars('abc')).toBe(0)
    expect(missingQueryChars('12')).toBe(1)
    expect(missingQueryChars('kubernetes')).toBe(0)
  })

  it('1 character is enough if it contains even one kanji or kana (the recall needles 「会議」「検索」「青」)', () => {
    expect(missingQueryChars('青')).toBe(0)
    expect(missingQueryChars('会議')).toBe(0)
    expect(missingQueryChars('の')).toBe(0)
    expect(missingQueryChars('ア')).toBe(0)
    // Mixed text also counts on the one-character side: one kanji is enough.
    expect(missingQueryChars('a会')).toBe(0)
    // Kanji outside the BMP (CJK Extension B).
    expect(missingQueryChars('\u{20BB7}')).toBe(0)
  })

  it('counts the whole typed query, not including surrounding whitespace', () => {
    expect(missingQueryChars('  ab  ')).toBe(1)
    expect(missingQueryChars('a b')).toBe(0) // Three characters including the space. Not counted per word.
    expect(missingQueryChars('')).toBe(0) // Empty is the 'do not search' side, not 'too short'.
    expect(missingQueryChars('   ')).toBe(0)
  })

  it('the script is judged after NFKC (full-width Latin letters, half-width kana)', () => {
    expect(missingQueryChars('ａｂ')).toBe(1)
    expect(missingQueryChars('ａｂｃ')).toBe(0)
    expect(missingQueryChars('ｱ')).toBe(0) // Half-width katakana -> katakana.
  })

  it('counts characters by code point (a surrogate pair is 1 character)', () => {
    expect(missingQueryChars('\u{1D41A}\u{1D41B}')).toBe(1)
  })
})

describe('inputs that make kuromoji fail (measured in Phase 3)', () => {
  it('does not throw even when given a lone surrogate', () => {
    // If a chunk boundary falls in the middle of an emoji, it takes this form. Plain kuromoji throws `Cannot read properties of null (reading 'length')` here.
    const broken = `会議の記録${String.fromCharCode(0xd83d)}`
    expect(() => shadowText(broken, 'ja', tokenizer)).not.toThrow()
    expect(shadowText(broken, 'ja', tokenizer)).toContain('会議')
  })

  it('can segment even a body containing NUL', () => {
    const withNul = `会議${String.fromCharCode(0)}の記録`
    expect(() => shadowText(withNul, 'ja', tokenizer)).not.toThrow()
    expect(shadowText(withNul, 'ja', tokenizer)).toContain('記録')
  })

  it('splits Japanese containing emoji into terms too', () => {
    const shadow = shadowText('今日の会議\u{1F600}は中止', 'ja', tokenizer)
    expect(shadow).toContain('会議')
  })
})
