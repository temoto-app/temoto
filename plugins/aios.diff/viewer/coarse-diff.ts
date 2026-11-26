/**
 * A coarse, line-level diff for inputs too large for `@codemirror/merge`'s character diff (TODO 1339).
 *
 * `@codemirror/merge` diffs by characters (Myers, O(N*D)). With its default `scanLimit` it gives up once the
 * changed middle is longer than a few thousand characters and reports ONE chunk covering everything between the first and the last
 * change; with a larger limit one run measured 0.5 s at 256 KB and 9.7 s at 2 MB (docs/notes/wave106.md). So big inputs use
 * this instead: trim the common head and tail, then split the middle on lines that occur exactly once on both sides
 * (patience-style anchors, longest increasing subsequence), and recurse into the gaps.
 *
 * Cost: hashing is linear; each level sorts only the anchors (n log n). A work budget bounds the recursion, so a nasty input
 * (few unique lines) degrades to coarser chunks, never to a long stall. More than `MAX_COARSE_CHUNKS` chunks, or more than
 * `MAX_COARSE_LINES` lines on a side, gives up (`null`) and the caller disables the jump buttons.
 *
 * A line keeps its terminator (`\n`, with any `\r` before it), so the unchanged runs between chunks are character-for-character
 * equal (what `@codemirror/merge`'s `override` contract needs): `x` and `x\n` differ on the last line, and CRLF against LF differs everywhere.
 * Line ranges are 0-based and half-open.
 * Pure, with no DOM, so it is unit tested directly.
 */
import { presentableDiff } from '@codemirror/merge'

export interface LineChunk {
  readonly fromA: number
  readonly toA: number
  readonly fromB: number
  readonly toB: number
}

export const MAX_COARSE_CHUNKS = 50_000
export const MAX_COARSE_LINES = 3_000_000
/** Total lines examined across all recursion levels, per input line. */
const WORK_PER_LINE = 40

/** Lines with their terminators. The empty text has no lines, and `a\n` has one (no phantom empty last line). */
function splitLines(text: string): string[] {
  const lines: string[] = []
  let from = 0
  while (from < text.length) {
    const at = text.indexOf('\n', from)
    const end = at === -1 ? text.length : at + 1
    lines.push(text.slice(from, end))
    from = end
  }
  return lines
}

/** Longest strictly increasing subsequence of `values` (indices into it), O(n log n). */
function lis(values: readonly number[]): number[] {
  const tails: number[] = []
  const prev: number[] = new Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const out: number[] = []
  let at = tails.length > 0 ? tails[tails.length - 1]! : -1
  while (at >= 0) {
    out.push(at)
    at = prev[at]!
  }
  return out.reverse()
}

/**
 * The changed line ranges between `a` and `b`, in order. `null` when the work is aborted (too many lines or chunks).
 * An empty array means the two are equal line by line.
 */
export function coarseLineDiff(a: string, b: string): LineChunk[] | null {
  const linesA = splitLines(a)
  const linesB = splitLines(b)
  if (linesA.length > MAX_COARSE_LINES || linesB.length > MAX_COARSE_LINES) return null
  const ids = new Map<string, number>()
  const intern = (line: string): number => {
    let id = ids.get(line)
    if (id === undefined) {
      id = ids.size
      ids.set(line, id)
    }
    return id
  }
  const idsA = Int32Array.from(linesA, intern)
  const idsB = Int32Array.from(linesB, intern)

  const out: LineChunk[] = []
  let aborted = false
  const emit = (fromA: number, toA: number, fromB: number, toB: number): void => {
    if (fromA === toA && fromB === toB) return
    const last = out[out.length - 1]
    if (last !== undefined && last.toA === fromA && last.toB === fromB) {
      out[out.length - 1] = { fromA: last.fromA, toA, fromB: last.fromB, toB }
    } else {
      out.push({ fromA, toA, fromB, toB })
    }
    if (out.length > MAX_COARSE_CHUNKS) aborted = true
  }

  let budget = (linesA.length + linesB.length) * WORK_PER_LINE + 1000
  // LIFO stack of regions; pushing the gaps in reverse keeps the output in order.
  const stack: [number, number, number, number][] = [[0, linesA.length, 0, linesB.length]]
  while (stack.length > 0 && !aborted) {
    const region = stack.pop()!
    let [fromA, toA, fromB, toB] = region
    while (fromA < toA && fromB < toB && idsA[fromA] === idsB[fromB]) {
      fromA++
      fromB++
    }
    while (fromA < toA && fromB < toB && idsA[toA - 1] === idsB[toB - 1]) {
      toA--
      toB--
    }
    if (fromA === toA || fromB === toB) {
      emit(fromA, toA, fromB, toB)
      continue
    }
    budget -= toA - fromA + (toB - fromB)
    if (budget < 0) {
      emit(fromA, toA, fromB, toB)
      continue
    }
    // Lines that occur exactly once on each side of this region.
    const countA = new Map<number, number>()
    for (let i = fromA; i < toA; i++) countA.set(idsA[i]!, (countA.get(idsA[i]!) ?? 0) + 1)
    const countB = new Map<number, number>()
    for (let j = fromB; j < toB; j++) countB.set(idsB[j]!, (countB.get(idsB[j]!) ?? 0) + 1)
    const posInB = new Map<number, number>()
    for (let j = fromB; j < toB; j++) {
      const id = idsB[j]!
      if (countB.get(id) === 1 && countA.get(id) === 1) posInB.set(id, j)
    }
    const anchorsA: number[] = []
    const anchorsB: number[] = []
    for (let i = fromA; i < toA; i++) {
      const j = posInB.get(idsA[i]!)
      if (j !== undefined) {
        anchorsA.push(i)
        anchorsB.push(j)
      }
    }
    const keep = lis(anchorsB)
    if (keep.length === 0) {
      emit(fromA, toA, fromB, toB)
      continue
    }
    // Gaps between consecutive anchors (and before the first / after the last). The anchor lines themselves are equal.
    const gaps: [number, number, number, number][] = []
    let prevA = fromA
    let prevB = fromB
    for (const k of keep) {
      gaps.push([prevA, anchorsA[k]!, prevB, anchorsB[k]!])
      prevA = anchorsA[k]! + 1
      prevB = anchorsB[k]! + 1
    }
    gaps.push([prevA, toA, prevB, toB])
    for (let g = gaps.length - 1; g >= 0; g--) stack.push(gaps[g]!)
  }
  return aborted ? null : out
}

/** Offset of the start of each line (as `splitLines` cuts them), plus a final entry for the end of the text (`lines + 1` entries). */
export function lineOffsets(text: string): number[] {
  const offsets = [0]
  let at = text.indexOf('\n')
  while (at !== -1 && at + 1 < text.length) {
    offsets.push(at + 1)
    at = text.indexOf('\n', at + 1)
  }
  if (text.length > 0) offsets.push(text.length)
  return offsets
}

/** Character ranges for `@codemirror/merge`'s `diffConfig.override`, taken from the line chunks. */
export function coarseCharChanges(
  a: string,
  b: string
): { fromA: number; toA: number; fromB: number; toB: number }[] | null {
  const chunks = coarseLineDiff(a, b)
  if (chunks === null) return null
  const offA = lineOffsets(a)
  const offB = lineOffsets(b)
  const at = (offsets: number[], line: number): number => offsets[Math.min(line, offsets.length - 1)]!
  return chunks.map((c) => ({
    fromA: at(offA, c.fromA),
    toA: at(offA, c.toA),
    fromB: at(offB, c.fromB),
    toB: at(offB, c.toB)
  }))
}

/** A chunk is refined to characters only when both of its sides are at most this long (the library's own diff is cheap there). */
export const REFINE_CHUNK_CHARS = 4_000
/** Total characters (both sides, all chunks) handed to the character diff; beyond it the remaining chunks stay whole lines. */
export const REFINE_TOTAL_CHARS = 400_000
/** Wall-clock guard on top of the character budget, in milliseconds. */
export const REFINE_MAX_MS = 150

export interface CharChange {
  readonly fromA: number
  readonly toA: number
  readonly fromB: number
  readonly toB: number
}

/**
 * The coarse line chunks, with each small chunk narrowed to the characters that really differ (the library's character diff run on
 * that chunk's substrings only). Big chunks, and chunks past the character / time budget, stay whole lines. The text between two
 * changes stays equal on both sides, because the sub-diff only splits a chunk at positions where both substrings agree.
 */
export function refinedCharChanges(a: string, b: string): CharChange[] | null {
  const coarse = coarseCharChanges(a, b)
  if (coarse === null) return null
  const out: CharChange[] = []
  let spent = 0
  const started = Date.now()
  for (const c of coarse) {
    const lenA = c.toA - c.fromA
    const lenB = c.toB - c.fromB
    if (
      lenA === 0 ||
      lenB === 0 ||
      lenA > REFINE_CHUNK_CHARS ||
      lenB > REFINE_CHUNK_CHARS ||
      spent + lenA + lenB > REFINE_TOTAL_CHARS ||
      Date.now() - started > REFINE_MAX_MS
    ) {
      out.push(c)
      continue
    }
    spent += lenA + lenB
    for (const d of presentableDiff(a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB))) {
      out.push({ fromA: c.fromA + d.fromA, toA: c.fromA + d.toA, fromB: c.fromB + d.fromB, toB: c.fromB + d.toB })
    }
  }
  return out
}
