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
 * A region with no unique line at all (blank lines, lone braces: TODO 1341 item 4) is not left as one chunk when it is small enough:
 * its lines go through the library's Myers diff as one character per distinct line, under a time limit (`lineDiffOfRegion`). That never
 * makes the result worse than one chunk per such region: a region whose alignment would pass `MAX_COARSE_CHUNKS` stays whole, and if the
 * aligned regions together pass it, the diff is run again without aligning them.
 *
 * The budgets come in two sets (`DiffLimits`, TODO 1341 item 3): `UI_THREAD_LIMITS` keep a fallback run on the iframe's UI thread
 * short, and `WORKER_LIMITS` are wider for the run in the Web Worker (`diff-worker.ts`), where only the wait before the view appears grows.
 *
 * A line keeps its terminator (`\n`, with any `\r` before it), so the unchanged runs between chunks are character-for-character
 * equal (what `@codemirror/merge`'s `override` contract needs): `x` and `x\n` differ on the last line, and CRLF against LF differs everywhere.
 * Line ranges are 0-based and half-open.
 * Pure, with no DOM, so it is unit tested directly.
 */
import { diff, presentableDiff } from '@codemirror/merge'

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

/** How much work one run may do (TODO 1341 item 3). Every limit stays finite: an input too big for it degrades to whole-line chunks. */
export interface DiffLimits {
  /** A chunk is refined to characters only when both of its sides are at most this long. */
  readonly refineChunkChars: number
  /** Total characters (both sides, all chunks) handed to the character diff; beyond it the remaining chunks stay whole lines. */
  readonly refineTotalChars: number
  /** Wall-clock limit for the whole refinement, in milliseconds. */
  readonly refineMaxMs: number
  /** Time limit of one chunk's character diff (the library's own `timeout`: past it, that chunk comes back coarser). */
  readonly refineChunkMs: number
  /** A region with no unique line goes through the line-level Myers diff only when its two sides have at most this many lines in total. */
  readonly regionDiffLines: number
  /** Time limit of one such region (the library's `timeout`). */
  readonly regionDiffMs: number
  /** Wall-clock limit for all such regions of one input. */
  readonly regionDiffTotalMs: number
}

/**
 * For a run on the iframe's UI thread (the fallback when the worker cannot be used). The refine numbers are the ones of wave 106 fix X
 * (4,000 characters / 400,000 / 150 ms); the per-chunk limit is new and keeps one fully rewritten 4,000-character chunk (about 100 ms
 * unbounded) from taking most of the 150 ms.
 */
export const UI_THREAD_LIMITS: DiffLimits = {
  refineChunkChars: 4_000,
  refineTotalChars: 400_000,
  refineMaxMs: 150,
  refineChunkMs: 30,
  regionDiffLines: 2_000,
  regionDiffMs: 10,
  regionDiffTotalMs: 50
}

/**
 * For the run in the Web Worker (TODO 1341 item 4). Measured in docs/notes/wave109.md: a 64 K-character chunk where every line has a small
 * edit takes about 110 ms, a fully rewritten one is cut at the per-chunk limit. The totals bound the wait before the view appears.
 */
export const WORKER_LIMITS: DiffLimits = {
  refineChunkChars: 65_536,
  refineTotalChars: 4_000_000,
  refineMaxMs: 1_000,
  refineChunkMs: 250,
  regionDiffLines: 200_000,
  regionDiffMs: 200,
  regionDiffTotalMs: 1_000
}

/** The first code unit of the surrogate range, and its size (a distinct line never maps there, so no code unit is half a pair). */
const SURROGATE_START = 0xd800
const SURROGATE_SIZE = 0x800
/** Distinct lines one region can map to single code units (1..0xFFFF minus the surrogates). */
const MAX_REGION_SYMBOLS = 0xffff - SURROGATE_SIZE

/**
 * The line-level diff of one region with no unique line (TODO 1341 item 4), as line ranges relative to the region. Each distinct line becomes
 * one character and the library's Myers diff (`diff`, not the presentable one, which would move changes to word boundaries) runs on those
 * strings with `timeoutMs`; past it the library answers coarser, never wrong. `null` when the region has too many distinct lines.
 */
function lineDiffOfRegion(
  idsA: Int32Array,
  fromA: number,
  toA: number,
  idsB: Int32Array,
  fromB: number,
  toB: number,
  timeoutMs: number
): [number, number, number, number][] | null {
  const symbols = new Map<number, number>()
  const encode = (ids: Int32Array, from: number, to: number): string | null => {
    const codes = new Uint16Array(to - from)
    for (let i = from; i < to; i++) {
      const id = ids[i]!
      let code = symbols.get(id)
      if (code === undefined) {
        if (symbols.size >= MAX_REGION_SYMBOLS) return null
        code = symbols.size + 1
        if (code >= SURROGATE_START) code += SURROGATE_SIZE
        symbols.set(id, code)
      }
      codes[i - from] = code
    }
    let text = ''
    for (let at = 0; at < codes.length; at += 8192) text += String.fromCharCode(...codes.subarray(at, at + 8192))
    return text
  }
  const textA = encode(idsA, fromA, toA)
  const textB = textA === null ? null : encode(idsB, fromB, toB)
  if (textA === null || textB === null) return null
  return diff(textA, textB, { timeout: Math.max(1, Math.floor(timeoutMs)) }).map((c) => [c.fromA, c.toA, c.fromB, c.toB])
}

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
export function coarseLineDiff(a: string, b: string, limits: DiffLimits = UI_THREAD_LIMITS): LineChunk[] | null {
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
  const first = lineChunks(idsA, idsB, limits, true)
  if (first.chunks !== null || !first.aligned) return first.chunks
  // Aligning the regions with no unique line added the chunks that passed the cap (wave 109 fix X4). Without that alignment the result is
  // what it was before it existed (each such region one chunk), so give that rather than nothing.
  return lineChunks(idsA, idsB, limits, false).chunks
}

/**
 * The work of `coarseLineDiff` on interned lines. `alignRegions` turns on the line-level Myers diff of regions with no unique line;
 * `aligned` says whether it split any region (only then can a retry without it give a different answer).
 */
function lineChunks(
  idsA: Int32Array,
  idsB: Int32Array,
  limits: DiffLimits,
  alignRegions: boolean
): { readonly chunks: LineChunk[] | null; readonly aligned: boolean } {
  let aligned = false
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

  let budget = (idsA.length + idsB.length) * WORK_PER_LINE + 1000
  const regionDeadline = Date.now() + limits.regionDiffTotalMs
  // LIFO stack of regions; pushing the gaps in reverse keeps the output in order.
  const stack: [number, number, number, number][] = [[0, idsA.length, 0, idsB.length]]
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
      // No unique line here (TODO 1341 item 4). If the two sides share any line at all and the region is small enough, align the lines
      // with the library's Myers diff instead of reporting the whole region as one chunk.
      const left = regionDeadline - Date.now()
      let shared = false
      if (alignRegions && toA - fromA + (toB - fromB) <= limits.regionDiffLines && left > 0) {
        for (let j = fromB; j < toB && !shared; j++) shared = countA.has(idsB[j]!)
      }
      const parts = shared ? lineDiffOfRegion(idsA, fromA, toA, idsB, fromB, toB, Math.min(limits.regionDiffMs, left)) : null
      // A region whose alignment alone would pass the cap stays one chunk, as it was before (wave 109 fix X4).
      if (parts === null || out.length + parts.length > MAX_COARSE_CHUNKS) {
        emit(fromA, toA, fromB, toB)
        continue
      }
      if (parts.length > 1) aligned = true
      for (const [pa, qa, pb, qb] of parts) emit(fromA + pa, fromA + qa, fromB + pb, fromB + qb)
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
  return { chunks: aborted ? null : out, aligned }
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
  b: string,
  limits: DiffLimits = UI_THREAD_LIMITS
): { fromA: number; toA: number; fromB: number; toB: number }[] | null {
  const chunks = coarseLineDiff(a, b, limits)
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
export function refinedCharChanges(a: string, b: string, limits: DiffLimits = UI_THREAD_LIMITS): CharChange[] | null {
  const coarse = coarseCharChanges(a, b, limits)
  if (coarse === null) return null
  const out: CharChange[] = []
  let spent = 0
  const deadline = Date.now() + limits.refineMaxMs
  for (const c of coarse) {
    const lenA = c.toA - c.fromA
    const lenB = c.toB - c.fromB
    const left = deadline - Date.now()
    if (
      lenA === 0 ||
      lenB === 0 ||
      lenA > limits.refineChunkChars ||
      lenB > limits.refineChunkChars ||
      spent + lenA + lenB > limits.refineTotalChars ||
      left <= 0
    ) {
      out.push(c)
      continue
    }
    spent += lenA + lenB
    // The library's own time limit cuts one slow chunk short (it then answers coarser for that chunk, still exact around it).
    const timeout = Math.max(1, Math.floor(Math.min(limits.refineChunkMs, left)))
    for (const d of presentableDiff(a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB), { timeout })) {
      out.push({ fromA: c.fromA + d.fromA, toA: c.fromA + d.toA, fromB: c.fromB + d.fromB, toB: c.fromB + d.toB })
    }
  }
  return out
}
