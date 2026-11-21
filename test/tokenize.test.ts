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

describe('言語判定 (6.2 の Metadata 段)', () => {
  it('日本語を含む文書は ja', () => {
    expect(detectLanguage('これは会議の議事録です')).toBe('ja')
    expect(detectLanguage('mixed 日本語 and English')).toBe('ja')
    expect(detectLanguage('カタカナのみ')).toBe('ja')
  })

  it('英数字だけの文書は other (unicode61 のままでよい)', () => {
    expect(detectLanguage('kubernetes deployment rollout')).toBe('other')
    expect(detectLanguage('const a = 1 // comment')).toBe('other')
  })
})

describe('分かち書き', () => {
  it('辞書が読める', () => {
    expect(tokenizer).not.toBeNull()
  })

  it('日本語を空白区切りにする', () => {
    const shadow = shadowText('今日の会議の議事録', 'ja', tokenizer)
    expect(shadow).toContain('会議')
    expect(shadow.split(' ').length).toBeGreaterThan(2)
    // The shadow is not a readable form. **It is not used for display** (6.5).
    expect(shadow).not.toBe('今日の会議の議事録')
  })

  it('日本語でない文書は分かち書きしない (NFKC で変わらない ASCII はそのまま)', () => {
    const text = 'kubernetes deployment rollout'
    expect(shadowText(text, 'other', tokenizer)).toBe(text)
  })

  it('全角英数は半角と同じ語になる (NFKC 正規化)', () => {
    expect(shadowText('ＡＷＳ の設定', 'ja', tokenizer)).toContain('AWS')
  })

  it('日本語でない (英語) チャンクでも全角英数は NFKC で半角になる (TODO 301)', () => {
    // Previously NFKC was applied only to chunks judged 'ja', so when an English chunk contained full-width letters, the shadow went in as full-width as is.
    expect(shadowText('ｓｙｓｔｅｍ', 'other', tokenizer)).toBe('system')
    expect(shadowText('ＡＷＳ deployment', 'other', tokenizer)).toBe('AWS deployment')
  })
})

describe('クエリの組み立て', () => {
  it('空クエリは null', () => {
    expect(buildMatchQuery('   ', tokenizer)).toBeNull()
    expect(buildMatchQuery('!!!', tokenizer)).toBeNull()
  })

  it('語ごとに引用して AND でつなぐ', () => {
    const match = buildMatchQuery('承認 インボックス', tokenizer)
    expect(match).toContain('AND')
    expect(match).toContain('"承認"')
  })

  it('FTS5 の構文文字を含むクエリでも壊れない', () => {
    const match = buildMatchQuery('a "b" OR c*', tokenizer)
    expect(match).not.toBeNull()
    // Quotes are escaped, so a bare OR / * does not remain as syntax.
    expect(match?.includes(' OR ')).toBe(false)
  })

  it('語の中の記号は取り除かず引用のまま渡す (TODO 837)', () => {
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

  it('prefix を立てると最後の語だけ前方一致になる (UI のインクリメンタル検索)', () => {
    const match = buildMatchQuery('会議 議事', tokenizer, true)
    expect(match?.endsWith('*')).toBe(true)
  })

  it('2 文字以下の日本語クエリも語になる (trigram が引けなかった部分)', () => {
    for (const query of ['会議', '検索', '青']) {
      const match = buildMatchQuery(query, tokenizer)
      expect(match).not.toBeNull()
      expect(match).toContain(query)
    }
  })

  it('全角英数のクエリは NFKC されて半角の語になる (TODO 301)', () => {
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
describe('前方一致を付ける条件 (P6)', () => {
  it('1 文字のラテン文字には `*` を付けない (実機で 4〜5 秒かかる形)', () => {
    expect(buildMatchQuery('a', tokenizer, true)).toBe('"a"')
    expect(buildMatchQuery('1', tokenizer, true)).toBe('"1"')
    // Even when the previous word is long, what is judged is **the last word**.
    expect(buildMatchQuery('kubernetes a', tokenizer, true)).toBe('"kubernetes" AND "a"')
  })

  it('2 文字以上なら `*` を付ける (今までどおりのインクリメンタル検索)', () => {
    expect(buildMatchQuery('ab', tokenizer, true)).toBe('"ab"*')
    expect(buildMatchQuery('kube', tokenizer, true)).toBe('"kube"*')
  })

  it('文字数はコードポイントで数える (サロゲートペアは 1 文字)', () => {
    // U+1D41A (MATHEMATICAL BOLD SMALL A). It is 2 units in UTF-16 but is one character, so no `*` is added.
    // NFKC compatibility decomposition folds it to a plain 'a' (a side effect of always applying NFKC since TODO 301). Even when folded, its classification as a one-character Latin letter does not change, and `*` still is not added.
    const bold = '\u{1D41A}'
    expect([...bold].length).toBe(1)
    expect(bold.length).toBe(2)
    expect(buildMatchQuery(bold, tokenizer, true)).toBe('"a"')
  })

  it('1 文字の日本語には `*` を付ける (6.4.1 の再現率を守るため)', () => {
    // Word splitting makes the inflected form of 'blue' one word. If it were an exact match, spike 11a's needle 'blue' could no longer be found, and the reason trigram was not adopted would itself break.
    expect(buildMatchQuery('青', tokenizer, true)).toBe('"青"*')
    expect(buildMatchQuery('の', tokenizer, true)).toBe('"の"*')
    expect(buildMatchQuery('ア', tokenizer, true)).toBe('"ア"*')
    // Kanji outside the BMP (CJK Extension B) are also treated as one Japanese character.
    expect(buildMatchQuery('\u{20BB7}', tokenizer, true)).toBe('"\u{20BB7}"*')
  })

  it('prefix を立てなければ `*` は一切付かない (gateway 経路)', () => {
    expect(buildMatchQuery('青', tokenizer)).toBe('"青"')
    expect(buildMatchQuery('kube', tokenizer)).toBe('"kube"')
  })
})

/**
 * The minimum character count (P8 / item 41, 6.4.1 'minimum character count'). It is a different layer from prefix matching (P6): this one decides whether to look up the index at all. The floor is also split by writing system: the words 'meeting' and 'blue' are guarded.
 */
describe('最小文字数 (P8 / 項目 41)', () => {
  it('ラテン文字と数字だけなら 3 文字 (1 文字 141 ms / 3 文字 0 ms)', () => {
    expect(missingQueryChars('a')).toBe(2)
    expect(missingQueryChars('ab')).toBe(1)
    expect(missingQueryChars('abc')).toBe(0)
    expect(missingQueryChars('12')).toBe(1)
    expect(missingQueryChars('kubernetes')).toBe(0)
  })

  it('漢字・かなを 1 文字でも含めば 1 文字でよい (再現率の針「会議」「検索」「青」)', () => {
    expect(missingQueryChars('青')).toBe(0)
    expect(missingQueryChars('会議')).toBe(0)
    expect(missingQueryChars('の')).toBe(0)
    expect(missingQueryChars('ア')).toBe(0)
    // Mixed text also counts on the one-character side: one kanji is enough.
    expect(missingQueryChars('a会')).toBe(0)
    // Kanji outside the BMP (CJK Extension B).
    expect(missingQueryChars('\u{20BB7}')).toBe(0)
  })

  it('数えるのは打たれたクエリ全体で、前後の空白は含めない', () => {
    expect(missingQueryChars('  ab  ')).toBe(1)
    expect(missingQueryChars('a b')).toBe(0) // Three characters including the space. Not counted per word.
    expect(missingQueryChars('')).toBe(0) // Empty is the 'do not search' side, not 'too short'.
    expect(missingQueryChars('   ')).toBe(0)
  })

  it('文字体系の判定は NFKC の後 (全角のラテン文字・半角カナ)', () => {
    expect(missingQueryChars('ａｂ')).toBe(1)
    expect(missingQueryChars('ａｂｃ')).toBe(0)
    expect(missingQueryChars('ｱ')).toBe(0) // Half-width katakana -> katakana.
  })

  it('文字数はコードポイントで数える (サロゲートペアは 1 文字)', () => {
    expect(missingQueryChars('\u{1D41A}\u{1D41B}')).toBe(1)
  })
})

describe('kuromoji が落ちる入力 (Phase 3 の実測)', () => {
  it('孤立サロゲートを渡しても例外にならない', () => {
    // If a chunk boundary falls in the middle of an emoji, it takes this form. Plain kuromoji throws `Cannot read properties of null (reading 'length')` here.
    const broken = `会議の記録${String.fromCharCode(0xd83d)}`
    expect(() => shadowText(broken, 'ja', tokenizer)).not.toThrow()
    expect(shadowText(broken, 'ja', tokenizer)).toContain('会議')
  })

  it('NUL を含む本文でも分かち書きできる', () => {
    const withNul = `会議${String.fromCharCode(0)}の記録`
    expect(() => shadowText(withNul, 'ja', tokenizer)).not.toThrow()
    expect(shadowText(withNul, 'ja', tokenizer)).toContain('記録')
  })

  it('絵文字を含む日本語も語に割れる', () => {
    const shadow = shadowText('今日の会議\u{1F600}は中止', 'ja', tokenizer)
    expect(shadow).toContain('会議')
  })
})
