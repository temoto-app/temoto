/**
 * Preserves the line endings of the opened file (TODO 852, same as VS Code).
 *
 * CodeMirror's doc splits lines on any of `\r\n` / `\r` / `\n`, and `doc.toString()` joins with `\n`.
 * Saving as is would rewrite every line of a CRLF file to LF, so the editor remembers **the line ending at open time** and
 * rejoins the values passed to the host (`getValue` / `onChange`) with it. Mixed endings go to the majority (a tie is LF).
 */
export type Eol = '\n' | '\r\n' | '\r'

/** The line ending with the most occurrences. `\n` if there are none or on a tie. */
export function detectEol(text: string): Eol {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf += 1
        i += 1
      } else cr += 1
    } else if (c === 10) lf += 1
  }
  if (crlf > lf && crlf >= cr) return '\r\n'
  if (cr > lf && cr > crlf) return '\r'
  return '\n'
}

/** Normalizes all line endings to `\n` (the form CodeMirror's doc sees). */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Rejoins a body joined with `\n` using `eol`. */
export function applyEol(text: string, eol: Eol): string {
  return eol === '\n' ? text : text.replace(/\n/g, eol)
}
