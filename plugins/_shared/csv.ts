/**
 * A small parser for delimiter-separated tables (`.csv` / `.tsv`) (TODO 1215, wave 83). A pure function independent of the DOM and of libraries
 * (`test/csv-parse.test.ts`). Drawing the table is done by `sheet.ts` / `sheet-view.ts`.
 *
 * It follows RFC 4180 and reads leniently the breakage common in real files (display only; values are never rewritten):
 *
 * - The delimiter is `,` (CSV) or tab (TSV). Line endings may be CRLF / LF / CR (even mixed).
 * - A field starting with `"` is a quoted field: delimiters and newlines inside go into the value as they are, and `""` is a single `"`. If anything other than a delimiter or newline
 *   follows the closing `"` (`"a"b`), those characters are added to the value too (the same leniency as Excel). If it ends without closing, the rest up to the end is the value.
 * - A `"` in the middle of an unquoted field is just a character.
 * - A leading BOM (U+FEFF) is not put into a value (because the host passes UTF-8 with the BOM left on; the Text view keeps it as is).
 * - No row is added after the last newline. An empty file (or only a BOM) has 0 rows. An empty line in the middle is a row with one empty field.
 * - Rows may have different numbers of fields (missing fields are drawn as empty).
 */

export type CsvDelimiter = ',' | '\t'

export interface CsvParseResult {
  readonly rows: string[][]
  /**
   * Whether the last row ended with a newline (a newline outside quotes). When the host passed only the beginning of a large file (`truncated`),
   * an unterminated last row is cut off midway, so the caller drops it.
   */
  readonly terminated: boolean
}

const QUOTE = 34 // "
const CR = 13
const LF = 10
const BOM = 0xfeff

export function parseDelimited(text: string, delimiter: CsvDelimiter): CsvParseResult {
  const rows: string[][] = []
  const sep = delimiter.charCodeAt(0)
  const length = text.length
  let i = length > 0 && text.charCodeAt(0) === BOM ? 1 : 0
  if (i >= length) return { rows, terminated: true }

  let row: string[] = []
  let terminated = false
  while (i < length) {
    // Read one field.
    let value = ''
    if (text.charCodeAt(i) === QUOTE) {
      i++
      let start = i
      for (;;) {
        const close = text.indexOf('"', i)
        if (close < 0) {
          // It ended without closing: the rest up to the end is the value.
          value += text.slice(start, length)
          i = length
          break
        }
        value += text.slice(start, close)
        if (text.charCodeAt(close + 1) === QUOTE) {
          value += '"'
          i = close + 2
          start = i
          continue
        }
        i = close + 1
        break
      }
      // After the closing `"`, characters (breakage) up to a delimiter or newline are added as they are.
      if (i < length) {
        let end = i
        while (end < length) {
          const c = text.charCodeAt(end)
          if (c === sep || c === CR || c === LF) break
          end++
        }
        if (end > i) value += text.slice(i, end)
        i = end
      }
    } else {
      let end = i
      while (end < length) {
        const c = text.charCodeAt(end)
        if (c === sep || c === CR || c === LF) break
        end++
      }
      value = text.slice(i, end)
      i = end
    }
    row.push(value)

    // After a field: a delimiter means the next field, a newline means the end of the row, the end means the last row.
    if (i >= length) {
      terminated = false
      break
    }
    const c = text.charCodeAt(i)
    if (c === sep) {
      i++
      if (i >= length) {
        // A row that ended with a delimiter has an empty last field.
        row.push('')
        terminated = false
      }
      continue
    }
    // CR / LF / CRLF
    i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1
    rows.push(row)
    row = []
    terminated = true
  }
  if (!terminated) rows.push(row)
  return { rows, terminated }
}

/**
 * Rows to draw in the table. If `truncated` (the host passed only the beginning), the last row that does not end with a newline is cut off midway, so it is dropped.
 */
export function tableRowsOf(text: string, delimiter: CsvDelimiter, truncated: boolean): string[][] {
  const { rows, terminated } = parseDelimited(text, delimiter)
  if (truncated && !terminated && rows.length > 0) rows.pop()
  return rows
}
