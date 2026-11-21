/**
 * Chunk stage (ARCHITECTURE.md 6.2). Splits a body into search units.
 *
 * It keeps **only byte offsets into the canonical copy**, never the text itself (6.5).
 * Display snippets are built at search time by re-reading this range from the canonical copy
 * (the file on disk / `thread_events` / transcript lines).
 *
 * Cuts prefer line boundaries, and adjacent chunks overlap slightly: so a word that straddles a
 * boundary is not missed, and so the chunks can be used as they are for the Phase 7 embeddings
 * (6.4 stage 3).
 */

export interface Chunk {
  readonly seq: number
  /** Text to put in the index (before word segmentation). Never persisted. */
  readonly text: string
  /** Byte range inside the canonical copy (UTF-8). */
  readonly byteStart: number
  readonly byteEnd: number
  readonly chars: number
}

export interface ChunkOptions {
  /** Target number of characters per chunk. */
  readonly maxChars?: number
  /** Overlap between adjacent chunks. */
  readonly overlapChars?: number
  /** Upper bound on chunks per document. Keeps the index from ballooning on huge files. */
  readonly maxChunks?: number
}

const DEFAULT_MAX_CHARS = 1000
const DEFAULT_OVERLAP_CHARS = 100
// Exactly enough to cover a 256 KB body (the limit in extract.ts).
const DEFAULT_MAX_CHUNKS = 260

/**
 * Adjusts the end so we never cut in the middle of a surrogate pair.
 * Splitting there leaves a lone surrogate, which **makes kuromoji throw** (measured in Phase 3).
 */
function safeEnd(text: string, end: number): number {
  if (end <= 0) return 0
  if (end >= text.length) return text.length
  const code = text.charCodeAt(end - 1)
  // If the previous unit is a high surrogate, cut one character earlier.
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

interface Line {
  readonly text: string
  readonly charStart: number
  readonly byteStart: number
}

function scanLines(text: string): Line[] {
  const lines: Line[] = []
  let charStart = 0
  let byteStart = 0
  for (const raw of text.split('\n')) {
    lines.push({ text: raw, charStart, byteStart })
    charStart += raw.length + 1
    byteStart += Buffer.byteLength(raw, 'utf8') + 1
  }
  return lines
}

/**
 * Splits a body into chunks. Never produces a whitespace-only chunk.
 * A line longer than `maxChars` (minified JS, etc.) is wrapped inside that line.
 */
export function chunkText(text: string, options: ChunkOptions = {}): readonly Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const overlap = Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 2))
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS
  if (text.trim() === '') return []

  const totalBytes = Buffer.byteLength(text, 'utf8')
  const lines = scanLines(text)
  const chunks: Chunk[] = []

  let buffer = ''
  let byteStart = 0
  let started = false

  const flush = (byteEnd: number): void => {
    if (buffer.trim() !== '' && chunks.length < maxChunks) {
      chunks.push({
        seq: chunks.length,
        text: buffer,
        byteStart,
        byteEnd: Math.min(byteEnd, totalBytes),
        chars: buffer.length
      })
    }
    buffer = ''
    started = false
  }

  for (const line of lines) {
    if (chunks.length >= maxChunks) break

    // A line that is too long is wrapped inside that line.
    if (line.text.length > maxChars) {
      flush(line.byteStart)
      let offset = 0
      while (offset < line.text.length && chunks.length < maxChunks) {
        const piece = line.text.slice(offset, safeEnd(line.text, offset + maxChars))
        const pieceByteStart = line.byteStart + Buffer.byteLength(line.text.slice(0, offset), 'utf8')
        if (piece.trim() !== '') {
          chunks.push({
            seq: chunks.length,
            text: piece,
            byteStart: pieceByteStart,
            byteEnd: Math.min(pieceByteStart + Buffer.byteLength(piece, 'utf8'), totalBytes),
            chars: piece.length
          })
        }
        offset += maxChars - overlap
      }
      continue
    }

    if (!started) {
      byteStart = line.byteStart
      started = true
      buffer = line.text
      continue
    }

    if (buffer.length + 1 + line.text.length > maxChars) {
      flush(line.byteStart)
      // The overlap is taken from the end of the previous chunk, to catch words that straddle the boundary.
      const previous = chunks[chunks.length - 1]
      if (previous !== undefined && overlap > 0) {
        const tail = previous.text.slice(
          safeEnd(previous.text, Math.max(0, previous.text.length - overlap))
        )
        buffer = tail === '' ? line.text : `${tail}\n${line.text}`
        byteStart = Math.max(
          previous.byteStart,
          previous.byteEnd - Buffer.byteLength(tail, 'utf8') - 1
        )
      } else {
        buffer = line.text
        byteStart = line.byteStart
      }
      started = true
      continue
    }

    buffer = `${buffer}\n${line.text}`
  }

  flush(totalBytes)
  return chunks
}

/**
 * Text of an image (TODO 998 stage 2): line 1 is a line of words built from the classification labels, lines 2 and later are the OCR text (just one line if there is none).
 * **The word line is always its own chunk with seq 0**: search ranking weights "seq 0 = label match, seq 1 and later = text match"
 * separately (`IMAGE_OCR_SCORE_WEIGHT`). The ordinary `chunkText` would mix a short OCR text into the word line.
 * The OCR part is split exactly as `chunkText` does, with byte offsets shifted by the size of the word line.
 */
export function chunkImageText(text: string, options: ChunkOptions = {}): readonly Chunk[] {
  const newline = text.indexOf('\n')
  const head = newline < 0 ? text : text.slice(0, newline)
  const chunks: Chunk[] = []
  if (head.trim() !== '') {
    chunks.push({ seq: 0, text: head, byteStart: 0, byteEnd: Buffer.byteLength(head, 'utf8'), chars: head.length })
  }
  if (newline < 0) return chunks
  const shift = Buffer.byteLength(head, 'utf8') + 1
  for (const chunk of chunkText(text.slice(newline + 1), options)) {
    chunks.push({
      ...chunk,
      seq: chunks.length,
      byteStart: chunk.byteStart + shift,
      byteEnd: chunk.byteEnd + shift
    })
  }
  return chunks
}
