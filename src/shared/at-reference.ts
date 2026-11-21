/**
 * How to write an `@path` reference in a prompt (TODO 917). The renderer's `@` completion (`composer-at.ts`) and main's attachment
 * assembly (`session/attachments.ts`) use the same form. A path containing whitespace is wrapped as `@"…"`
 * (without wrapping, the reference is cut at the whitespace and the attachment is silently ignored).
 */
export function atReferenceText(path: string): string | null {
  if (!/\s/.test(path)) return `@${path}`
  // The CLI's regular expression is `@"([^"]+)"`, and there is no way to escape a `"` inside the quotes (docs/notes/composer.md).
  // A path containing both whitespace and `"` cannot be made into a reference (wave 49 review).
  return path.includes('"') ? null : `@"${path}"`
}

/**
 * A path that cannot be a reference is written as a plain path string without `@` (the model can open it with Read). It is better for the path to stay in the text
 * than for the `@` reference to silently break and the attachment to be ignored.
 */
export function atReferenceOrPlain(path: string): string {
  return atReferenceText(path) ?? path
}
