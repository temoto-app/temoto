/**
 * Image classification labels -> words to put in the index (TODO 998, spike 39). **Pure functions only** (OS-independent).
 *
 * 1. Labels whose confidence is at least the lower bound (`IMAGE_LABEL_MIN_CONFIDENCE`) are turned into words of the shared
 *    vocabulary (`vocabulary.json`) through the backend's mapping table (`apple-vision.json`) (the first is the translation of the label itself, the second
 *    and later are what it folds into. E.g. `beagle` -> the Japanese words for "beagle" and "dog").
 * 2. Follow each word's `broader` (wider words) transitively and add its `aliases` (other spellings, English). Duplicates are dropped.
 * 3. Words of higher-confidence labels come first (they show in the search result excerpt as "why it matched").
 *
 * Stage 2: words of high-confidence labels are repeated in the FTS shadow text (`imageBoostText`) so that they affect bm25 order. Images with an
 * extreme aspect ratio (`shape`) are not classified; only shape words (wide, tall) are added. When OCR identifies a receipt (`kind`), the Japanese word for "receipt" is added,
 * and when it identifies a document, the words of the label `receipt` are dropped and the Japanese word for "document" is used (`receipt.ts`).
 *
 * The sentence put in the index (`imageLabelText`) is one line of words separated by spaces. kuromoji and FTS handle it the same as ordinary body text.
 * When the mapping table or vocabulary is fixed, bump the `version` in each JSON - `IMAGE_TERMS_VERSION` changes, the version mark of image rows
 * changes, and they are reindexed. Labels are stored in `documents.metadata`, so Vision is not run again.
 */
import vocabularyJson from './vocabulary.json' with { type: 'json' }
import appleVisionJson from './apple-vision.json' with { type: 'json' }
import type { ImageLabel } from '../os/image-analysis.js'
import type { ImageDocKind } from './receipt.js'

/**
 * Lower bound on label confidence for the index. Spike 39 (wave 80 bundle D): at 0.3, for a dog on grass, `grass` was 0.85-0.91 while
 * `dog` was 0.29-0.30, and dog recall fell to 1/6. Fine-grained animal and food labels are hardly ever wrong even at 0.15-0.3.
 */
export const IMAGE_LABEL_MIN_CONFIDENCE = 0.15
/**
 * Lower bound on labels stored in `documents.metadata` (lower than the bound for the index). A little below is kept so that rebuilding is possible
 * without running Vision again after moving the bound (spike 39: at 0.1 and above, median 41 bytes per image, max 454 bytes).
 */
export const IMAGE_LABEL_KEEP_CONFIDENCE = 0.1
/** Upper bound on the number of labels stored per image (keeps the metadata small; spike 39's maximum was around 20). */
export const IMAGE_LABEL_KEEP_MAX = 40

interface VocabularyWord {
  readonly aliases?: readonly string[]
  readonly broader?: readonly string[]
}

interface BackendTable {
  readonly version: number
  readonly backend: string
  readonly map: Readonly<Record<string, readonly string[]>>
}

const VOCABULARY = vocabularyJson as unknown as {
  readonly version: number
  readonly words: Readonly<Record<string, VocabularyWord>>
}
const TABLES: readonly BackendTable[] = [appleVisionJson as unknown as BackendTable]

/** Name of Vision's classification label scheme (`ImageAnalyzer.backend`). */
export const APPLE_VISION_BACKEND = (appleVisionJson as unknown as BackendTable).backend

/**
 * Version of how an image's text is built (chunk splitting, how shadow text is added, shape words, kind words). Bump it when it changes - it goes into `IMAGE_TERMS_VERSION`,
 * the version mark of image rows changes and they are reindexed (Vision is not run again). 1 in stage 2.
 */
export const IMAGE_LAYOUT_VERSION = 1

/**
 * Version of the vocabulary and mapping table (vocabulary version x 1000 + the mapping table's version). It goes into the version mark of image rows (`:vlN`).
 */
export const IMAGE_TERMS_VERSION =
  VOCABULARY.version * 1000 + TABLES.reduce((sum, table) => sum + table.version, 0) + IMAGE_LAYOUT_VERSION * 10

function tableOf(backend: string): BackendTable | null {
  return TABLES.find((table) => table.backend === backend) ?? null
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** Whether the backend has a mapping table. */
export function hasImageTable(backend: string): boolean {
  return tableOf(backend) !== null
}

/** Orientation of an image with an extreme aspect ratio (`wide` = landscape, `tall` = portrait). */
export type ImageShape = 'wide' | 'tall'

/** Shape words (for images not classified because of an extreme aspect ratio). */
const SHAPE_WORDS: Readonly<Record<ImageShape, readonly string[]>> = {
  wide: ['横長', 'バナー'],
  tall: ['縦長']
}

/** Words for the kind judged by OCR (`receipt.ts`). */
const KIND_WORDS: Readonly<Record<ImageDocKind, string>> = { receipt: 'レシート', document: '書類' }

export interface ImageTermsOptions {
  /** Lower bound on labels (default `IMAGE_LABEL_MIN_CONFIDENCE`). */
  readonly minConfidence?: number
  /** Kind judged by OCR. `document` drops the words of the label `receipt`; `receipt` adds words. */
  readonly kind?: ImageDocKind | null
  /** Orientation of an image not classified because of an extreme aspect ratio. Adds shape words. */
  readonly shape?: ImageShape | null
}

/** Confidence -> word weight (how many times it is repeated in the shadow text). 3 for 0.6 and above, 2 for 0.3 and above, 1 below that. */
export function labelWeight(confidence: number): number {
  return confidence >= 0.6 ? 3 : confidence >= 0.3 ? 2 : 1
}

/** Weight of a word whose kind was decided by OCR (the heaviest, since the text backs it up). */
const KIND_WEIGHT = 3

/**
 * Label -> words and weights to put in the index (highest confidence first, no duplicates). Broader words and aliases inherit the weight of the label that led to them
 * (the one that came first = the higher-confidence label's weight remains). Labels missing from the mapping table and unknown backends yield no words
 * (putting English identifiers in as they are would make `_` splits and generic words noise. The mapping table covers the full set - spike 39's `check`).
 */
export function imageWeightedTerms(
  labels: readonly ImageLabel[],
  backend: string,
  options: ImageTermsOptions = {}
): [term: string, weight: number][] {
  const out = new Map<string, number>()
  const kind = options.kind ?? null
  // If the same word comes by several routes, take **the larger weight** (the position stays the first one). Even if a kind word backed by OCR
  // (the Japanese words for "receipt" / "document") came in earlier from a label, the heavier one overwrites it. Only when the weight goes up is it propagated to aliases and broader words (it stops even with cycles).
  const visit = (word: string, weight: number): void => {
    const current = out.get(word)
    if (current !== undefined && current >= weight) return
    out.set(word, weight)
    const entry = hasOwn(VOCABULARY.words, word) ? VOCABULARY.words[word] : undefined
    if (entry === undefined) return
    for (const alias of entry.aliases ?? []) {
      const aliasWeight = out.get(alias)
      if (aliasWeight === undefined || aliasWeight < weight) out.set(alias, weight)
    }
    for (const broader of entry.broader ?? []) visit(broader, weight)
  }
  const table = tableOf(backend)
  if (table !== null) {
    const minConfidence = options.minConfidence ?? IMAGE_LABEL_MIN_CONFIDENCE
    // Highest confidence first (equal values keep the original order).
    const sorted = [...labels].sort((a, b) => b[1] - a[1])
    for (const [id, confidence] of sorted) {
      if (!(confidence >= minConfidence)) continue
      if (!hasOwn(table.map, id)) continue
      for (const word of table.map[id] ?? []) {
        // The label `receipt` of an image judged to be a document (it is also put on photos of A4 documents) is not made a word - the Japanese word for "document" is added instead.
        if (kind === 'document' && word === KIND_WORDS.receipt) continue
        visit(word, labelWeight(confidence))
      }
    }
  }
  if (kind !== null) visit(KIND_WORDS[kind], KIND_WEIGHT)
  const shape = options.shape ?? null
  if (shape !== null) for (const word of SHAPE_WORDS[shape]) visit(word, 1)
  return [...out]
}

/** Label -> words to put in the index (highest confidence first, no duplicates). */
export function imageTerms(
  labels: readonly ImageLabel[],
  backend: string,
  minConfidence: number = IMAGE_LABEL_MIN_CONFIDENCE,
  options: Omit<ImageTermsOptions, 'minConfidence'> = {}
): string[] {
  return imageWeightedTerms(labels, backend, { ...options, minConfidence }).map(([term]) => term)
}

/** The sentence to put in the index (one line of words separated by spaces). An empty string if there are no words (= no body). */
export function imageLabelText(
  labels: readonly ImageLabel[],
  backend: string,
  options: ImageTermsOptions = {}
): string {
  return imageWeightedTerms(labels, backend, options)
    .map(([term]) => term)
    .join(' ')
}

/**
 * Repetition of high-confidence words to add to the shadow text (text that goes only into FTS). A word of weight w is repeated w - 1 times. **It is not put in the canonical sentence**
 * (so the same word does not line up in the excerpt). bm25 responds to word occurrence counts, so matches on high-confidence labels rank higher.
 */
export function imageBoostText(
  labels: readonly ImageLabel[],
  backend: string,
  options: ImageTermsOptions = {}
): string {
  const parts: string[] = []
  for (const [term, weight] of imageWeightedTerms(labels, backend, options)) {
    for (let i = 1; i < weight; i += 1) parts.push(term)
  }
  return parts.join(' ')
}

/**
 * Validates stored labels (`documents.metadata.image.labels`, a value restored from JSON). Elements with the wrong shape are dropped.
 */
export function sanitizeImageLabels(value: unknown): ImageLabel[] {
  if (!Array.isArray(value)) return []
  const out: ImageLabel[] = []
  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) continue
    const [id, confidence] = item as unknown[]
    if (typeof id !== 'string' || id === '' || id.length > 128) continue
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue
    out.push([id, confidence])
  }
  return out
}

/** Labels to store: those at or above the lower bound (`IMAGE_LABEL_KEEP_CONFIDENCE`), highest confidence first, up to the upper bound. */
export function labelsToKeep(labels: readonly ImageLabel[]): ImageLabel[] {
  return [...labels]
    .filter((label) => label[1] >= IMAGE_LABEL_KEEP_CONFIDENCE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, IMAGE_LABEL_KEEP_MAX)
}
