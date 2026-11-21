/**
 * Syntax for filtering by file name in the search box (TODO 813, owner decision 2026-10-19). **Pure functions only**.
 *
 * - `ext:md` / `ext:.md` / `ext:MD`: files whose extension is `md` (case is folded, a leading dot is ignored).
 *   When several are written (`ext:md ext:txt`) or listed with `,` (`ext:md,txt`), they are ORed.
 * - `name:22719`: the file name contains `22719`. If several are written, they are ANDed.
 * - A term of the form `*.md` is treated as `ext:md` (`22719 *.md`). Only when it is `*.` followed by alphanumerics.
 * - Any term that is none of the above is a term for the body search (`text`). Japanese terms stay in `text` as they are, and kuromoji does not touch them.
 * - Image filtering (TODO 998, only with `options.images`): a trailing Japanese "(no) photo" / "(no) image" (the words for photo and image, with an optional
 *   genitive particle) at the end of a term, as in the Japanese for "dog photo" or "cat image", is dropped and `images` is set (the caller narrows to image extensions). The rest is split at the particle "no" into separate terms (the Japanese for
 *   "photo of a handwritten memo" becomes handwritten and memo. The line of label words has no "no". A "no" flanked by hiragana on both sides, as in "kinoko" (mushroom), is not split). A term that is only "photo", "image", `photo` or `image` is dropped only when there are other body terms
 *   (a lone photo word stays as a body term as before).
 * - A term that is just `ext:` / `name:` with an empty value (typing in progress) is dropped. The prefix is case-insensitive,
 *   and the full-width form of `ext:` is treated the same through NFKC.
 */
export interface QueryFilter {
  /** The body (FTS5) search terms, with the filter terms removed. Terms are separated by a single half-width space. */
  readonly text: string
  /** Allowed extensions (lowercase, no dot). If empty, no narrowing. */
  readonly exts: readonly string[]
  /** Terms the file name must contain (lowercase, NFC). It must contain all of them. */
  readonly names: readonly string[]
  /** Narrow to images (TODO 998, the Japanese "photo of ..." form). Set only when `images` is passed to `parseQueryFilter`. */
  readonly images: boolean
}

/** Words that say "it is an image" itself (TODO 998). Dropped when they arrive as a lone term. */
const IMAGE_WORDS = new Set(['写真', '画像', 'photo', 'photos', 'image', 'images', 'picture', 'pictures', 'pic', 'pics'])
/** A trailing "(no) photo / (no) image" at the end of a term (the Japanese words for photo and image, with an optional genitive particle). Only when something remains in front of it. */
const IMAGE_SUFFIX = /^(.+?)の?(?:写真|画像)$/u
/** The particle "no" that splits terms. A "no" with hiragana on both sides (as in "kinoko", mushroom) is regarded as part of the word and is not split. */
const NO_PARTICLE = /(?<!\p{Script=Hiragana})の|の(?!\p{Script=Hiragana})/u

const EXT_PREFIX = /^ext:$/iu
const NAME_PREFIX = /^name:$/iu
const STAR_EXT = /^\*\.([\p{L}\p{N}]+)$/u

function pushUnique(list: string[], value: string): void {
  if (value !== '' && !list.includes(value)) list.push(value)
}

export function parseQueryFilter(query: string, options: { readonly images?: boolean } = {}): QueryFilter {
  const texts: string[] = []
  const exts: string[] = []
  const names: string[] = []
  for (const raw of query.split(/\s+/u)) {
    if (raw === '') continue
    // Only the prefix check uses NFKC (the full-width form of `ext:` is treated the same). The value keeps the same folding as `name_folded` / the extension column
    // (NFC + lowercase) (only the extension uses NFKC, to rescue full-width input from an IME): if the value too went through NFKC, a half-width katakana name or `name:①` would not hit a file that actually exists.
    if (EXT_PREFIX.test(raw.slice(0, 4).normalize('NFKC'))) {
      for (const part of raw.slice(4).normalize('NFKC').split(/[,，]/u)) {
        pushUnique(exts, part.replace(/^[.．]+/u, '').toLowerCase())
      }
      continue
    }
    if (NAME_PREFIX.test(raw.slice(0, 5).normalize('NFKC'))) {
      pushUnique(names, raw.slice(5).normalize('NFC').toLowerCase())
      continue
    }
    if (raw.slice(0, 2).normalize('NFKC') === '*.') {
      const star = STAR_EXT.exec(`*.${raw.slice(2).normalize('NFKC')}`)
      if (star !== null) {
        pushUnique(exts, (star[1] as string).toLowerCase())
        continue
      }
    }
    texts.push(raw)
  }
  if (options.images !== true) return { text: texts.join(' '), exts, names, images: false }
  return { ...imageIntent(texts), exts, names }
}

/** Reads the image filter from the body terms (TODO 998). If nothing matches, the terms are left as they are. */
function imageIntent(texts: readonly string[]): { text: string; images: boolean } {
  let images = false
  const out: string[] = []
  const lone: string[] = []
  for (const raw of texts) {
    const folded = raw.normalize('NFKC').toLowerCase()
    if (IMAGE_WORDS.has(folded)) {
      lone.push(raw)
      continue
    }
    const suffix = IMAGE_SUFFIX.exec(raw.normalize('NFKC'))
    if (suffix !== null) {
      const parts = (suffix[1] as string).split(NO_PARTICLE).filter((part) => part !== '')
      if (parts.length > 0) {
        images = true
        out.push(...parts)
        continue
      }
    }
    out.push(raw)
  }
  // A term that is just "photo" / `photo` becomes an image marker only when there are other body terms (alone it stays a body term).
  if (lone.length > 0) {
    if (out.length > 0) images = true
    else out.push(...lone)
  }
  return { text: out.join(' '), images }
}

/** Whether there is no filter at all. */
export function isPlainQuery(filter: QueryFilter): boolean {
  return filter.exts.length === 0 && filter.names.length === 0 && !filter.images
}

/** The needle of `LIKE '%…%' ESCAPE '\'` (escapes `\`, `%` and `_`). */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * For conversation search (messages have no files), the filter is turned back into **body terms**: the extension `md` and
 * file-name terms require that the word appear inside the message (FTS5 AND). The dot of `.md` is
 * a word boundary in the index, so it is matched as the word `md`.
 */
export function asTextTerms(filter: QueryFilter): string {
  return [filter.text, ...filter.names, ...filter.exts].filter((s) => s !== '').join(' ')
}

/**
 * For file-name search (⌘P): turns it back into name substring terms. `ext:md` becomes `.md` and `name:X` becomes `X`. Name search is
 * a substring match with all terms ANDed, so several extensions (OR) cannot be expressed: only the first one is used.
 */
export function asNameTerms(filter: QueryFilter): string {
  const ext = filter.exts[0]
  return [filter.text, ...filter.names, ...(ext === undefined ? [] : [`.${ext}`])].filter((s) => s !== '').join(' ')
}
