/**
 * Splits the streamed payload of an export file into its JSON lines (TODO 1318, ARCHITECTURE 8.6). Pure, independent of electron.
 *
 * - Lines end at a newline byte (a newline inside a JSON string is escaped, so it never appears raw). A segment after the last newline
 *   is a line only if it is not empty; an empty segment between two newlines is an (empty, invalid) line - the same cut as before.
 * - **Memory is bounded per line, not per file** (`maxBytes`): only the current line is held. A line over the limit throws
 *   `LineTooLong` without being held whole (the file comes from outside; this is also below V8's string limit before `JSON.parse`).
 */

/** A line exceeded the limit. `index` counts from 0 (line 0 is the head, line n is thread n). */
export class LineTooLong extends Error {
  constructor(readonly index: number) {
    super(`data-transfer: line ${index} exceeds the limit`)
    this.name = 'LineTooLong'
  }
}

export class LineSplitter {
  private parts: Buffer[] = []
  private bytes = 0
  private index = 0

  /** `onLine` receives each line (without its newline) and its index; false = no more lines are wanted. */
  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: Buffer, index: number) => Promise<boolean | void>
  ) {}

  /** Feeds the next piece. Resolves false once `onLine` asked to stop. */
  async push(chunk: Buffer): Promise<boolean> {
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline === -1) {
        this.append(chunk.subarray(start))
        return true
      }
      this.append(chunk.subarray(start, newline))
      if (!(await this.emit())) return false
      start = newline + 1
    }
  }

  /** The end of the payload: the last line, if it did not end with a newline. */
  async end(): Promise<boolean> {
    return this.bytes > 0 ? this.emit() : true
  }

  private append(piece: Buffer): void {
    if (piece.length === 0) return
    if (this.bytes + piece.length > this.maxBytes) throw new LineTooLong(this.index)
    this.parts.push(piece)
    this.bytes += piece.length
  }

  private async emit(): Promise<boolean> {
    const line = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.bytes)
    this.parts = []
    this.bytes = 0
    const index = this.index
    this.index += 1
    return (await this.onLine(line, index)) !== false
  }
}
