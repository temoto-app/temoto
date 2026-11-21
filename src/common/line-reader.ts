/**
 * Assembles a byte stream (socket, pipe) into newline-delimited lines (TODO 565).
 *
 * - **A chunk boundary can fall in the middle of a UTF-8 character.** Calling `toString('utf8')` per chunk
 *   turns the character at the boundary into U+FFFD, which is still readable as JSON, so it breaks silently.
 *   Keep one `StringDecoder` per stream and carry the leftover bytes over to the next chunk.
 * - **A partial line is only pushed onto an array** (no `split` on every chunk without a newline). Even if one huge frame
 *   (the whole `content` of an approval request's Write) arrives in 64 KiB pieces, it stays O(n).
 * - Empty lines (whitespace only) are not returned.
 * - When the partial line exceeds `maxPendingChars`, `overflow: 'split'` cuts it there as one line
 *   (log relay), and `'throw'` throws `LineTooLongError` (the approval server - the caller disconnects, TODO 569).
 *
 * Used in three places: the gateway (`src/gateway/index.ts`), the approval server (`src/main/approval/server.ts`),
 * and the child log relay (`src/common/log-relay.ts`).
 */
import { StringDecoder } from 'node:string_decoder'

export class LineTooLongError extends Error {
  constructor(readonly chars: number) {
    super('line too long')
    this.name = 'LineTooLongError'
  }
}

export interface LineReaderOptions {
  /** Upper bound on a partial line with no newline (characters). No limit if omitted. */
  readonly maxPendingChars?: number
  /** When the limit is exceeded: 'split' returns it there as one line, 'throw' throws `LineTooLongError`. Default 'split'. */
  readonly overflow?: 'split' | 'throw'
}

export class LineReader {
  private readonly decoder = new StringDecoder('utf8')
  private parts: string[] = []
  private size = 0
  private readonly max: number
  private readonly overflow: 'split' | 'throw'

  constructor(options: LineReaderOptions = {}) {
    this.max = options.maxPendingChars ?? Number.POSITIVE_INFINITY
    this.overflow = options.overflow ?? 'split'
  }

  /** Adds a chunk and returns only the lines closed by a newline. The partial line is carried over. */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    return this.take(text)
  }

  /** When the stream closes. Returns what is left in the decoder and the last line that did not end with a newline. */
  end(): string[] {
    const tail = this.decoder.end()
    const lines = tail === '' ? [] : this.take(tail)
    const rest = this.parts.join('')
    this.parts = []
    this.size = 0
    if (rest.trim() !== '') lines.push(rest)
    return lines
  }

  private take(text: string): string[] {
    if (text === '') return []
    if (!text.includes('\n')) {
      this.parts.push(text)
      this.size += text.length
      return this.checkOverflow([])
    }
    const joined = this.parts.join('') + text
    const lines = joined.split('\n')
    const rest = lines.pop() ?? ''
    this.parts = rest === '' ? [] : [rest]
    this.size = rest.length
    return this.checkOverflow(lines.filter((line) => line.trim() !== ''))
  }

  private checkOverflow(lines: string[]): string[] {
    if (this.size <= this.max) return lines
    const chars = this.size
    const rest = this.parts.join('')
    this.parts = []
    this.size = 0
    if (this.overflow === 'throw') throw new LineTooLongError(chars)
    lines.push(rest)
    return lines
  }
}
