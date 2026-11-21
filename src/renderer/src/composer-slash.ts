/**
 * Slash commands in the prompt box (item 68, ARCHITECTURE.md 4.5.3). Pure functions that do not touch the DOM, and
 * `test/composer-slash.test.ts` tests them as they are.
 *
 * **Not a single command name is written here** (constraint 6). The list is what the backend reported in `session_started`
 * (the adapter takes it in and it arrives via `BackendChoice.commands` / the thread's `session_started`
 * payload); this file only decides "is the input one of that list".
 *
 * Rules for the decision:
 * - Only when the start of the input (leading whitespace ignored) is `/name`, and the name starts with `[A-Za-z0-9]` and does not contain `/`,
 *   is it treated as a command. A pasted path such as a message starting with `/Users/me/x` followed by Japanese text is not blocked.
 * - If the list is null (= no report seen yet), no decision is made. **What is not known is not blocked.**
 * - A name not in the list is `unknown`. The Composer does not send and shows a band (with "send anyway" too:
 *   the list can vary with the thread's cwd, so this is the way out when a fallback list wrongly blocks).
 */

import { slashName } from '@shared/slash-command.js'

/** The command name at the start of the input (without `/`). Null if it is not in the shape of a command. The decision is shared with main (TODO 961). */
export { slashName }

export type SlashCheck =
  /** Not in the shape of a command (an ordinary message). */
  | { readonly kind: 'none' }
  /** The list is not known yet. Do not block. */
  | { readonly kind: 'unverified'; readonly name: string }
  /** It is in the list. Send as before. */
  | { readonly kind: 'known'; readonly name: string }
  /** It is not in the list. Do not send (the turn is not consumed). */
  | { readonly kind: 'unknown'; readonly name: string }

export function checkSlash(text: string, commands: readonly string[] | null): SlashCheck {
  const name = slashName(text)
  if (name === null) return { kind: 'none' }
  if (commands === null) return { kind: 'unverified', name }
  return commands.includes(name) ? { kind: 'known', name } : { kind: 'unknown', name }
}

/**
 * Completion candidates. When the input is only `/` or `/partial` (no whitespace yet), return the list narrowed down.
 * Prefix matches first, then substring matches (both case-insensitive). The order within the list is kept.
 * If the input exactly matches a single name and there are no other candidates, nothing is shown (the choice is already finished).
 */
export function suggestSlash(
  text: string,
  commands: readonly string[] | null,
  limit = 8
): readonly string[] {
  if (commands === null || commands.length === 0) return NO_SUGGESTIONS
  const match = /^\s*\/([\w:.-]*)$/.exec(text)
  if (match === null) return NO_SUGGESTIONS
  const typed = match[1]!.toLowerCase()
  const prefix: string[] = []
  const inner: string[] = []
  for (const name of commands) {
    const folded = name.toLowerCase()
    if (folded.startsWith(typed)) prefix.push(name)
    else if (typed !== '' && folded.includes(typed)) inner.push(name)
  }
  const all = [...prefix, ...inner]
  if (all.length === 1 && all[0] === match[1]) return NO_SUGGESTIONS
  return all.length === 0 ? NO_SUGGESTIONS : all.slice(0, limit)
}

/** The input after a candidate is chosen. Leading whitespace is dropped and one space is placed after the name (so arguments can be typed right away). */
export function completeSlash(name: string): string {
  return `/${name} `
}

/**
 * Choose the list used for the decision. **The thread's own list takes priority** (the one reported for that thread's cwd);
 * otherwise the backend's fallback (the list of the last session started); if neither exists, null.
 */
export function commandsFor(
  threadCommands: readonly string[] | undefined,
  backendCommands: readonly string[] | null | undefined
): readonly string[] | null {
  return threadCommands ?? backendCommands ?? null
}

/**
 * Names of skills (TODO 564), used to put a "skill" badge in completion. The thread's own report takes priority; otherwise the list last
 * reported by any thread; if neither exists, null (no badge). Names are not written here (constraint 6).
 */
export function skillsFor(
  threadSkills: readonly string[] | undefined,
  recentSkills: readonly string[] | null | undefined
): readonly string[] | null {
  return threadSkills ?? recentSkills ?? null
}

/** Up/down over the completion rows (cycles through `length` rows including the trailing "create a new skill"). */
export function slashMenuStep(at: number, step: 1 | -1, length: number): number {
  if (length <= 0) return 0
  return (((at + step) % length) + length) % length
}

/** No candidates. A constant so that the selector / useMemo does not create a new array. */
export const NO_SUGGESTIONS: readonly string[] = []
