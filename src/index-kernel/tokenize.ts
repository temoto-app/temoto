/**
 * Japanese tokenizer (ARCHITECTURE.md 6.4.1, the decision of spike 11).
 *
 * **A custom FTS5 tokenizer needs C's `fts5_api` and cannot be
 * registered from better-sqlite3.** So the morphological approach takes the form "segment words on the JS side and index
 * the space-separated shadow text with `unicode61`". This constraint dictates the approach.
 *
 * Recall is 7/7 (trigram is 5/7 and **cannot look up queries of 2 characters or fewer**).
 * The cost of word segmentation is negligible (21,810 documents/s = 0.05 ms per incremental document).
 *
 * The shadow text is not in a readable form (a Japanese phrase split into space-separated words), so
 * **it is not used for display snippets** — they are cut from the canonical copy (6.5).
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { log, errorFields } from '../common/logger.js'

export type DocumentLanguage = 'ja' | 'other'

interface KuromojiToken {
  readonly surface_form: string
}

interface KuromojiTokenizer {
  tokenize(text: string): KuromojiToken[]
}

interface KuromojiBuilder {
  build(callback: (err: Error | null, tokenizer: KuromojiTokenizer) => void): void
}

interface KuromojiModule {
  builder(options: { dicPath: string }): KuromojiBuilder
}

/** Hiragana, katakana, kanji (CJK unified ideographs and compatibility ideographs). */
const JAPANESE = new RegExp('[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')

/**
 * Characters kuromoji cannot handle (measured in Phase 3).
 *
 * **Passing an unpaired surrogate or NUL makes kuromoji throw**
 * (`Cannot read properties of null (reading 'length')`). It happens when a chunk boundary falls in the
 * middle of a surrogate pair, so the boundary side (chunk.ts) also avoids it, but
 * the canonical copy itself may contain broken sequences, so we drop them here too.
 */
const UNPAIRED_SURROGATE = new RegExp(
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'g'
)
/** Writing NUL as a literal in a regular expression trips lint (no-control-regex). */
const NUL = String.fromCharCode(0)

/** Upper limit per word-segmentation call. The premise is that large bodies are called chunk by chunk. */
const MAX_SEGMENT_CHARS = 64 * 1024

let tokenizerPromise: Promise<KuromojiTokenizer | null> | null = null

function dictionaryPath(): string {
  const require = createRequire(import.meta.url)
  // kuromoji/src/kuromoji.js → kuromoji/dict
  return join(dirname(dirname(require.resolve('kuromoji'))), 'dict')
}

/**
 * Loads the dictionary. It takes **about 1 second, only the first time**, so call it once before the index build starts and
 * wait for it. If it could not be loaded it returns null, and the caller indexes
 * the original text as is (Japanese recall drops, but search itself keeps working).
 */
export function ensureTokenizer(): Promise<KuromojiTokenizer | null> {
  if (tokenizerPromise !== null) return tokenizerPromise
  tokenizerPromise = new Promise<KuromojiTokenizer | null>((resolve) => {
    const started = Date.now()
    let kuromoji: KuromojiModule
    try {
      kuromoji = createRequire(import.meta.url)('kuromoji') as KuromojiModule
    } catch (err) {
      log.error('index.tokenizer.unavailable', errorFields(err))
      resolve(null)
      return
    }
    kuromoji.builder({ dicPath: dictionaryPath() }).build((err, tokenizer) => {
      if (err !== null) {
        log.error('index.tokenizer.failed', errorFields(err))
        resolve(null)
        return
      }
      log.info('index.tokenizer.ready', { ms: Date.now() - started })
      resolve(tokenizer)
    })
  })
  return tokenizerPromise
}

/**
 * Language detection (the Metadata stage of 6.2). Documents with no Japanese are not word-segmented and are
 * indexed with `unicode61` as is — the index is smaller, and it is enough for alphanumerics (6.4.1).
 */
export function detectLanguage(text: string): DocumentLanguage {
  return JAPANESE.test(text) ? 'ja' : 'other'
}

/**
 * Makes the shadow text. For Japanese, word segmentation; otherwise the original text as is.
 *
 * **NFKC normalization is always applied regardless of language** (TODO 301) — so that full-width and half-width
 * alphanumerics can be looked up as the same term. Previously it was applied only to chunks judged Japanese, so a query in full-width
 * Latin letters did not match an English body.
 * Normalization affects only the shadow side and **does not affect the canonical byte positions** — a chunk's
 * `byte_start` / `byte_end` are computed against the canonical raw text.
 * Re-indexing was not done — existing English chunks get fixed at the next ingestion (TODO 301's handling).
 */
export function shadowText(
  text: string,
  lang: DocumentLanguage,
  tokenizer: KuromojiTokenizer | null
): string {
  const normalized = text.normalize('NFKC').replace(UNPAIRED_SURROGATE, ' ').replaceAll(NUL, ' ')
  if (lang !== 'ja' || tokenizer === null) return normalized
  const source =
    normalized.length > MAX_SEGMENT_CHARS ? normalized.slice(0, MAX_SEGMENT_CHARS) : normalized
  try {
    return tokenizer
      .tokenize(source)
      .map((token) => token.surface_form)
      .join(' ')
  } catch (err) {
    // A missing dictionary, etc. Index the original text as is and keep search itself running.
    log.warn('index.tokenize.failed', errorFields(err))
    return normalized
  }
}

/**
 * Case boundaries (TODO 1152): an uppercase letter after a lowercase letter or digit (`ageScore` → `age Score`, `MD5Hash` → `MD5 Hash`), and
 * before the last letter of a run of uppercase letters (`AGESound` → `AGE Sound`). It does not split before a digit (`Volume2` stays as is).
 */
const CAMEL_BOUNDARY = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu

/** Splits a term into whitespace at case boundaries (TODO 1152). Returns the same string if there is no boundary. */
export function splitCamel(token: string): string {
  return token.replace(CAMEL_BOUNDARY, ' ')
}

/**
 * Version of how the shadow text is made (TODO 1152). When raised, the idle cleanup (`upkeep.ts`'s 965 rebuild entry point) re-indexes documents that have
 * chunks indexed before it.
 */
export const SHADOW_EPOCH = 1

/**
 * Shadow text to put in the index (TODO 1152). After `shadowText`, appends the form of terms with case boundaries (camelCase /
 * PascalCase identifiers) split at the boundaries.
 *
 * unicode61 makes `ageScoreMgrEraseColorGroupOwner` a single term, so
 * `ScoreMgrEraseColorGroupOwner`, which starts in the middle of a term, could not be found even by prefix match (the repro from the owner's report). Adding the split form
 * (`age Score Mgr Erase Color Group Owner`) lets the query side (`buildMatchQuery`) look it up with a phrase split the same way.
 * The original term is kept, so whole-term and from-the-start prefix matches work as before.
 *
 * **Append at the end** (do not insert next to the term): inserting would break the order of phrases such as `fooBar.baz` (`foobar baz`).
 * The appended order may let a phrase match across identifiers (`OwnerAge` matching the tail and head of two adjacent identifiers), but
 * a query using split phrases always contains uppercase, so smart case's re-check (`CaseFilter`) drops those using the canonical copy's words with case as is.
 * It is not used for queries (for queries, `buildMatchQuery` makes an OR of the original term and the split phrase per term).
 */
export function indexShadowText(
  text: string,
  lang: DocumentLanguage,
  tokenizer: KuromojiTokenizer | null
): string {
  const shadow = shadowText(text, lang, tokenizer)
  const parts: string[] = []
  for (const token of shadow.split(TOKEN_SPLIT)) {
    if (token === '') continue
    const split = splitCamel(token)
    if (split !== token) parts.push(split)
  }
  return parts.length === 0 ? shadow : `${shadow} ${parts.join(' ')}`
}

/** The shortest term length to which prefix matching may be applied (P6). */
const MIN_PREFIX_CHARS = 2

/**
 * A term made only of kanji, hiragana and katakana. **Even one character stands as a term**.
 * Unlike `JAPANESE` (for language detection), we want to include CJK Extension B (kanji outside the BMP such as `\u{20BB7}`),
 * so it is written with the `Script` property.
 */
const JAPANESE_WORD = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u

/**
 * Whether `*` may be added to the last term (P6).
 *
 * **A one-character prefix match pulls all terms "starting with that one character" from the vocabulary**, so the cost is
 * proportional to that share. The share is decided by the number of kinds of characters that can start a term, and that differs
 * by two orders of magnitude between scripts:
 *
 * | Kinds of initial | Vocabulary taken by 1 character | Exact match | Prefix match |
 * |---|---|---|---|
 * | Latin letters (26) | 1,330 / 30,000 | 0 ms | **141 ms** |
 * | Japanese (281, actually many more) | 105 / 30,000 | 9 ms | 17 ms |
 *
 * (200,000 chunks, `scripts/bench/fts-prefix-script.mjs`. On a real machine, 7.1 million chunks
 * keep the same ratio and take several seconds — fact 7.)
 *
 * So what must be stopped is **a single small Latin letter** only, and a single Japanese character
 * can stay a prefix match. Moreover for Japanese it cannot be removed: word segmentation makes a word meaning "blue (adjective)" a single term,
 * so an exact match on the single kanji for "blue" cannot find spike 11a's needle, the single kanji for "blue"
 * (this is exactly the reason 6.4.1's "2 characters or fewer can be looked up" = trigram was not adopted).
 */
function canPrefix(token: string): boolean {
  if ([...token].length >= MIN_PREFIX_CHARS) return true
  return JAPANESE_WORD.test(token)
}

/** Minimum number of characters for a query with no kanji or kana at all (Latin letters, digits, etc.) (P8 / item 41). */
export const MIN_QUERY_CHARS = 3

/** Whether it contains even one kanji, hiragana or katakana. The same character set as `JAPANESE_WORD` (so as not to have two rules). */
const HAS_JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * How many more characters are needed to search (P8 / item 41, 6.4.1 "minimum characters"). 0 means searching is allowed.
 *
 * The lower bound is **split by script**: if it has even one kanji or kana, 1 character (needles such as a single kanji for "blue" or the word for "meeting"),
 * and if only Latin letters and digits, `MIN_QUERY_CHARS`. What is counted is not the terms after word segmentation but
 * **the whole typed query** (a unit that lets the screen say "N more characters"). The script is judged
 * after NFKC normalization (full-width Latin `abc` counts as 3 Latin letters). It is a different layer from `canPrefix`:
 * this one is about "whether to query the index at all". It is not applied to the gateway (`forAgent`) or to file name search (6.6).
 */
export function missingQueryChars(query: string): number {
  const trimmed = query.trim().normalize('NFKC')
  if (trimmed === '') return 0
  if (HAS_JAPANESE.test(trimmed)) return 0
  return Math.max(0, MIN_QUERY_CHARS - [...trimmed].length)
}

/** Makes a safe term that contains no FTS5 syntax characters. */
function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

// `\s` also includes the full-width space (U+3000).
const TOKEN_SPLIT = /\s+/

/**
 * The last part of a term after cutting at symbols inside it (`foo.b` → `b`). FTS5 applies a phrase's `*` only to the last term,
 * so `canPrefix` (P6) is judged there too — `"foo.b"*` becomes `b*` and sweeps the whole vocabulary.
 */
function lastSubToken(token: string): string {
  const parts = token.split(/[^\p{L}\p{N}\p{M}]+/u).filter((part) => part !== '')
  return parts[parts.length - 1] ?? ''
}

/**
 * Converts a search query into an FTS5 MATCH expression.
 *
 * It goes through the same `shadowText` as the body, so **queries of 2 characters or fewer (the word for "meeting", a single kanji for "blue") can be looked up**
 * (the part trigram could not — spike 11a), and **full-width alphanumeric queries are always NFKC-normalized**
 * (TODO 301), so they match a half-width body.
 * With `prefix` set, `*` is added to the last term. This is to pick up
 * a term typed halfway in incremental search, and is not used for searches from the gateway.
 * **It is not added to a single Latin letter etc.** — see `canPrefix` (P6).
 */
export function buildMatchQuery(
  query: string,
  tokenizer: KuromojiTokenizer | null,
  prefix = false
): string | null {
  const trimmed = query.trim()
  if (trimmed === '') return null

  const lang = detectLanguage(trimmed)
  const segmented = shadowText(trimmed, lang, tokenizer)
  const tokens = segmented
    .split(TOKEN_SPLIT)
    // Drop terms made only of symbols that unicode61 discards. If everything is dropped, do not search.
    // Symbols inside a term (`foo.bar` / `file_name` / IP) are **not removed** and are passed quoted (TODO 837):
    // the index side cuts terms at symbols when putting them in, so FTS5 cuts the inside of the quote with the same tokenizer and matches it as a phrase.
    .filter((token) => /[\p{L}\p{N}\p{M}]/u.test(token))
  if (tokens.length === 0) return null

  const last = tokens.length - 1
  const term = (token: string, i: number): string =>
    prefix && i === last && canPrefix(lastSubToken(token)) ? `${quote(token)}*` : quote(token)
  return tokens
    .map((token, i) => {
      // A term with case boundaries (TODO 1152) only needs to match either the original term or the phrase split at the boundaries (the order `indexShadowText` appended at the end).
      // A term that starts in the middle of an identifier (`ScoreMgr…` → `ageScoreMgr…`) matches via the split phrase.
      const split = splitCamel(token)
      return split === token ? term(token, i) : `(${term(token, i)} OR ${term(split, i)})`
    })
    .join(' AND ')
}
