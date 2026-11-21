/**
 * Matching against path shapes (like `**\/.zshrc` / `**\/Library/LaunchAgents/**` / `**\/.mcp.json`)
 * (the persistence write targets of TODO 1042 and the secret locations of TODO 1043, ARCHITECTURE 4.2.1). **Pure functions only.**
 *
 * - A shape is split into segments by `/`. `**` is zero or more segments, and `*` inside a segment is any characters (except `/`). Other characters are literal.
 * - A path is split into segments, empty segments and `.` are dropped, and `..` removes the previous segment (`a/.git/x/../hooks/p` -> `a/.git/hooks/p`).
 * - **Case is not distinguished** (macOS's default file system does not distinguish it, so writing to `~/.ZSHRC` also writes to `.zshrc`).
 * - `~` / `$HOME` / absolute paths / relative paths are not distinguished - a shape starts with `**\/`, so it matches whatever is put in front.
 */

export function pathSegments(path: string): readonly string[] {
  const out: string[] = []
  for (const part of path.toLowerCase().split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

const compiled = new Map<string, readonly (RegExp | '**')[]>()

function compile(pattern: string): readonly (RegExp | '**')[] {
  const cached = compiled.get(pattern)
  if (cached !== undefined) return cached
  const parts = pattern
    .toLowerCase()
    .split('/')
    .filter((part) => part !== '')
    .map((part): RegExp | '**' =>
      part === '**' ? '**' : new RegExp(`^${part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
    )
  compiled.set(pattern, parts)
  return parts
}

function matchFrom(parts: readonly (RegExp | '**')[], at: number, segments: readonly string[], from: number): boolean {
  if (at === parts.length) return from === segments.length
  const part = parts[at]
  if (part === '**') {
    for (let next = from; next <= segments.length; next += 1) {
      if (matchFrom(parts, at + 1, segments, next)) return true
    }
    return false
  }
  if (from >= segments.length || part === undefined) return false
  return part.test(segments[from] ?? '') && matchFrom(parts, at + 1, segments, from + 1)
}

export function matchPathPattern(path: string, pattern: string): boolean {
  return matchFrom(compile(pattern), 0, pathSegments(path), 0)
}

/** In a table of name -> shape, the first name whose shape the path matches. Null if none. */
export function matchPathGroup(path: string, groups: Readonly<Record<string, readonly string[]>>): string | null {
  for (const [name, patterns] of Object.entries(groups)) {
    if (patterns.some((pattern) => matchPathPattern(path, pattern))) return name
  }
  return null
}

/** Add two tables by name (layering the backend's table on the common table). */
export function mergePathGroups(
  ...tables: readonly (Readonly<Record<string, readonly string[]>> | undefined)[]
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {}
  for (const table of tables) {
    if (table === undefined) continue
    for (const [name, patterns] of Object.entries(table)) out[name] = [...(out[name] ?? []), ...patterns]
  }
  return out
}

/**
 * Path-like words in a shell command (split at whitespace, operators, quotes, `=` / `,`). The values of `of=~/.zshrc` / `--output=x` also become one word.
 * Coarse - the matching side narrows by shape.
 */
export function commandPathTokens(command: string): readonly string[] {
  return command.split(/[\s;&|<>()'"`=,]+/).filter((token) => token !== '' && token !== '-')
}
