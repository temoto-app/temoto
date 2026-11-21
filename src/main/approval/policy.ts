/**
 * Matching the approval defaults (ARCHITECTURE.md 4.2 "default allow / stop patterns / strict mode", T12).
 *
 * This file is **pure functions only**. The Broker uses it when it decides "how to handle an incoming permission request".
 * aios cannot decide which operations go through approval (spike 9b), so what is judged here is
 * limited to requests for which the CLI showed a permission prompt.
 *
 * How matching works:
 * - A command is looked at after **whitespace is normalized** (`make  all` and `make all` are the same).
 * - Stop patterns are **prefix matches**. But they are applied not only to the start of the whole command but also to the **start of each segment**
 *   split by `|` / `&&` / `||` / `;` / newline (so the `rm -rf` of `echo x && rm -rf y` is not missed).
 * - A pattern that starts with an operator, such as `| sh`, matches only the segment immediately after that operator
 *   (`curl … | sh` is stopped, a lone `sh script.sh` is not).
 * - No match in the middle of a word (`rm -rf` does not match `rm -rfoo`).
 *
 * **Coarse is fine.** The purpose is to stop accidents, not to cover malicious commands exhaustively.
 * Where exhaustiveness is needed, use strict mode (stops everything per thread).
 */
/** Collapse whitespace into one space and trim both ends. Used for both rule keys and stop-pattern matching. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/** Shell separators. Tried from the left in order, so `||` and `&&` are placed before the one-character ones. */
const SEPARATORS = ['||', '&&', '|', ';', '\n'] as const

interface Segment {
  /** The operator just before this segment. '' for the first segment. */
  readonly operator: string
  readonly text: string
}

/** Split a command into segments. The inside of quotes is not looked at (the coarseness is by design). */
export function splitCommand(command: string): readonly Segment[] {
  const segments: Segment[] = []
  let rest = command
  let operator = ''
  while (rest.length > 0) {
    let cut = -1
    let found = ''
    for (const separator of SEPARATORS) {
      const index = rest.indexOf(separator)
      if (index >= 0 && (cut < 0 || index < cut)) {
        cut = index
        found = separator
      }
    }
    if (cut < 0) {
      segments.push({ operator, text: normalizeCommand(rest) })
      break
    }
    segments.push({ operator, text: normalizeCommand(rest.slice(0, cut)) })
    operator = found === '\n' ? ';' : found
    rest = rest.slice(cut + found.length)
  }
  return segments.filter((segment) => segment.text !== '')
}

/** A prefix match that respects word boundaries. */
function startsWithWord(text: string, prefix: string): boolean {
  if (prefix === '') return false
  if (!text.startsWith(prefix)) return false
  if (text.length === prefix.length) return true
  // If the end of the pattern is a symbol (such as `dd if=`), it matches whatever comes right after.
  const last = prefix[prefix.length - 1] ?? ''
  if (!/[A-Za-z0-9_-]/.test(last)) return true
  const next = text[prefix.length] ?? ''
  return !/[A-Za-z0-9_-]/.test(next)
}

/**
 * Whether a stop pattern matches. Returns the pattern that matched (null if none).
 * It returns the pattern itself rather than a boolean to leave "what stopped it" in the audit log.
 */
export function matchDenyPattern(
  command: string,
  patterns: readonly string[]
): string | null {
  const segments = splitCommand(command)
  for (const raw of patterns) {
    const pattern = normalizeCommand(raw)
    if (pattern === '') continue
    for (const segment of segments) {
      const operatorPattern = SEPARATORS.find((separator) => pattern.startsWith(separator))
      if (operatorPattern !== undefined) {
        // The form `| sh`: the operator matches, and the segment to its right starts with the rest of the pattern.
        if (segment.operator !== operatorPattern) continue
        const body = normalizeCommand(pattern.slice(operatorPattern.length))
        if (startsWithWord(segment.text, body)) return raw
        continue
      }
      if (startsWithWord(segment.text, pattern)) return raw
    }
  }
  return null
}

export function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const command = (input as Record<string, unknown>)['command']
  return typeof command === 'string' && command.trim() !== '' ? command : null
}
