/**
 * Where the CLI's shell `cd`-ed to during a conversation (TODO 816, ARCHITECTURE.md 5.1).
 *
 * A relative link in an answer (`uC3/Driver/.../x.S`) may be written relative to where the shell `cd`-ed to in that conversation, not the conversation's cwd
 * (a conversation that visits several repositories). Because link resolution (`src/main/fs/link.ts`) uses it as the next candidate after the cwd,
 * this picks `cd` / `pushd` destinations from the commands of saved shell tool calls (the `input` of `tool_use`, already redacted and clipped).
 *
 * - **The tool name and the argument key (`command`) are backend-specific** (constraint 6), so they live in the adapter.
 * - The CLI's shell tool carries the working folder across calls, so we walk in chronological order and update the current location
 *   (a relative `cd sub` starts from the previous location). The return from a subshell `( cd x && … )` is not tracked (the same as a candidate destination).
 * - Only the shape is picked. **Neither existence nor the choke point is checked**: whether it can be opened is decided by the caller with `assertAllowed(…, 'read')`.
 * - `cd -`, a bare `cd`, `$VAR` (other than `$HOME` / `${HOME}`) and arguments containing command substitution are dropped (the destination is not decided by shape).
 */
import { isAbsolute, join, resolve } from 'node:path'
import type { JsonValue } from '@shared/agent.js'

const SHELL_TOOL = 'Bash'

/** Upper bound on the destinations returned (newest first). */
export const MAX_SHELL_DIRS = 32

/** One saved tool call (`ThreadStore.recentToolUses`). */
export interface StoredToolUse {
  readonly name: string
  readonly input: JsonValue
}

/** A `cd` / `pushd` after a command separator (`&&` `||` `;` `|` newline, or the opening of a subshell), and its one argument. */
const CD_PATTERN = /(?:^|[;&|\n(]|&&|\|\|)\s*(?:builtin\s+)?(?:cd|pushd)(?:\s+--)?\s+("([^"]*)"|'([^']*)'|((?:\\.|[^\s;&|()<>'"])+))/g

/** Turns one argument into a destination path. Null if it is not decided by shape. */
function targetOf(raw: string, quoted: boolean, current: string, home: string): string | null {
  let value = raw
  if (!quoted) value = value.replace(/\\(.)/g, '$1')
  if (value === '' || value === '-' || value.startsWith('-')) return null
  value = value.replace(/^\$\{HOME\}(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home)
  if (value === '~' || value.startsWith('~/')) value = join(home, value.slice(1))
  // A leftover variable, command substitution, or `~user` is not decided by shape.
  if (value.includes('$') || value.includes('`') || value.startsWith('~')) return null
  return isAbsolute(value) ? resolve(value) : resolve(current, value)
}

/** Walks the `cd`s of one command in order and returns the places passed through (in order) and the last place. */
export function cdTargetsOf(command: string, current: string, home: string): { readonly visited: readonly string[]; readonly last: string } {
  const visited: string[] = []
  let at = current
  for (const match of command.matchAll(CD_PATTERN)) {
    const double = match[2]
    const single = match[3]
    const bare = match[4]
    const target =
      double !== undefined
        ? targetOf(double, true, at, home)
        : single !== undefined
          ? targetOf(single, true, at, home)
          : bare !== undefined
            ? targetOf(bare, false, at, home)
            : null
    if (target === null) continue
    visited.push(target)
    at = target
  }
  return { visited, last: at }
}

/**
 * From the saved tool calls (oldest first), returns where the shell `cd`-ed to, **newest first** and without duplicates (the cwd itself excluded).
 * Capped at `MAX_SHELL_DIRS`.
 */
export function shellDirsOf(toolUses: readonly StoredToolUse[], cwd: string, home: string): readonly string[] {
  const order: string[] = []
  let at = cwd
  for (const use of toolUses) {
    if (use.name !== SHELL_TOOL) continue
    const input = use.input
    if (typeof input !== 'object' || input === null || Array.isArray(input)) continue
    const command = (input as Record<string, JsonValue>)['command']
    if (typeof command !== 'string') continue
    const { visited, last } = cdTargetsOf(command, at, home)
    order.push(...visited)
    at = last
  }
  const out: string[] = []
  for (let i = order.length - 1; i >= 0 && out.length < MAX_SHELL_DIRS; i--) {
    const dir = order[i]!
    if (dir !== cwd && !out.includes(dir)) out.push(dir)
  }
  return out
}
