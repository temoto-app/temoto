/**
 * `!` in the prompt box (item 116, ARCHITECTURE.md 4.5.7). Pure functions independent of the DOM and node, so that
 * the renderer (appearance switching, how to send) and main (re-validating the received input) use the same judgment.
 *
 * The rules of the judgment (owner decision 2026-09-26):
 * - **Only one half-width `!` at the very start.** If there is whitespace before it, it is an ordinary message (a `!` in the middle of pasted text is not picked up).
 * - Only `!`, or whitespace only after `!`, is out of scope (nothing to run).
 * - Anything starting with `!!` is out of scope (it would be confused with shell history expansion. It is not aligned with the CLI's bash mode either).
 * - A full-width exclamation mark is out of scope (a Japanese exclamatory sentence).
 */

/** The command (the body with surrounding whitespace removed) if the input is a `!` input, otherwise null. */
export function shellCommandOf(text: string): string | null {
  if (!text.startsWith('!') || text.startsWith('!!')) return null
  const command = text.slice(1).trim()
  return command === '' ? null : command
}

/**
 * Whether to give the input box the "shell" appearance. It switches from the stage where just one `!` is typed (because it is a signal
 * that a command is about to be typed). Whether it can be sent is decided by `shellCommandOf`.
 */
export function isShellDraft(text: string): boolean {
  return text.startsWith('!') && !text.startsWith('!!')
}
