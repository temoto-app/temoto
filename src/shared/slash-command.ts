/**
 * Whether a message is in slash-command form (the judgment of item 68, shared by main and the renderer).
 *
 * **No command name is written here** (constraint 6). Only the shape is checked: the start of the input (leading whitespace ignored) is
 * `/` followed by a name, the name starts with `[A-Za-z0-9]` and contains no `/`, and what follows is whitespace or the end. Pasting a path such as `/Users/me/x`
 * followed by a request is not treated as a command.
 *
 * main uses it so as not to mix a hand-over sentence (TODO 961) or a `!` result (item 116) into the head of a command message
 * (if anything is attached at the head, the backend does not accept it as a command).
 */

/** The command name at the start of the input (without the `/`). null if it is not in command form. */
export function slashName(text: string): string | null {
  const match = /^\s*\/([A-Za-z0-9][\w:.-]*)(?=\s|$)/.exec(text)
  return match === null ? null : match[1]!
}
