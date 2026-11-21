/**
 * The mark for a sent image, the Japanese word for "attachment", a colon and the name, in parentheses (4.5, TODO 519).
 *
 * main's `composeText` adds it on a line before the body, **sends it to the CLI as is, and stores it as `user_text`**
 * (stored rows have the same form). So the mark itself cannot be changed (the text the model sees, the stored rows, and the source of the title).
 * To avoid Japanese showing up in the EN display, the renderer replaces only the marks on the first line with a sentence in the display language when drawing
 * (`relabelAttachmentMarks`). The side that makes the mark and the side that reads it share this one place.
 */

const MARK_PREFIX = '(添付: '

export function attachmentMark(name: string): string {
  return `${MARK_PREFIX}${name})`
}

/**
 * One mark (the Japanese word for "attachment", a colon and the name, in parentheses). The name may contain **balanced parentheses** (`image (1).png`, `Screenshot (2).png`:
 * wave 29 code-review). We do not use a form that decides the end by "up to the `)` at the end of the line" or "the `)` followed by the next mark or `@path`":
 * the Cmd+K snippet (621, `makeSnippet`) folds newlines into spaces, so the user's text continues on the same line right after the mark.
 * With one level of balanced parentheses, the closing `)` of the mark is determined in any context. A name that is not balanced (`a).png`) is not read as a mark.
 */
const MARK_SOURCE = String.raw`\(添付: ((?:[^()\n]|\([^()\n]*\))+)\)`
const MARK_PATTERN = new RegExp(MARK_SOURCE, 'g')
const LEADING_MARK = new RegExp(String.raw`^${MARK_SOURCE}\s*`)

/**
 * Replaces the marks on the first line (the line where marks are lined up) with `label(name)`. Lines from the second on (the user's text) are untouched.
 * If there is no mark, the same string is returned.
 */
export function relabelAttachmentMarks(text: string, label: (name: string) => string): string {
  if (!text.includes(MARK_PREFIX)) return text
  const end = text.indexOf('\n')
  const first = end === -1 ? text : text.slice(0, end)
  const relabeled = first.replace(MARK_PATTERN, (_whole, name: string) => label(name))
  return end === -1 ? relabeled : `${relabeled}${text.slice(end)}`
}

/**
 * Removes the marks (the Japanese word for "attachment", a colon and the name, in parentheses) lined up from the start of a line (TODO 608, to skip the marks in the source of the title).
 * If other content (such as `@path`) follows the marks, it is kept. If there is no mark, the same string is returned.
 */
export function stripLeadingAttachmentMarks(line: string): string {
  let rest = line
  for (;;) {
    const m = LEADING_MARK.exec(rest)
    if (m === null) break
    rest = rest.slice(m[0].length)
  }
  return rest
}

/** Returns the names of the marks that appear in a line, in order (TODO 608, the source of the title when the body is only attachments). */
export function attachmentNamesInLine(line: string): string[] {
  const names: string[] = []
  for (const m of line.matchAll(MARK_PATTERN)) {
    const name = m[1]
    if (name !== undefined) names.push(name)
  }
  return names
}
