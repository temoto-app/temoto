/**
 * Judging writes that persist or switch off a safeguard (TODO 1042, owner decision 2026-10-29, ARCHITECTURE 4.2.1 "writes that persist are asked about even by default").
 *
 * The worst outcome of a hijacked AI is not one send but **leaving a foothold that also works in later conversations**. Such a write
 * almost never happens in ordinary work, so like operations that send something out (959), it is asked about every time, even with the default allow-everything, even with a rule, and even for quiet standard commands (1031):
 *
 * - Switching off a safeguard: the backend CLI's settings (hooks, `permissions.allow`) and `.mcp.json`. The locations are backend-specific, so they are in the Adapter's
 *   compat table `persistence.paths` (constraint 6).
 * - Persisting: shell startup files, LaunchAgents / LaunchDaemons, `crontab`, `launchctl load|bootstrap`, `.git/hooks`, and
 *   `git config core.*|alias.*…`, `~/.ssh/*`, `~/.gitconfig`. The common table is `persistence` in `compat/outbound.json`.
 *
 * This file is **pure functions only**. It looks only at the **argument strings** of the AI's tools and never reads files (constraint 2: do not touch where the CLI's settings are kept).
 * A realpath is resolved only through the entry point the caller passes (`resolve`).
 *
 * **Coarse is fine, but lean toward asking** (the same as 959). For Bash, it matches on any of: (a) the target of a redirect (`>` / `>>`) matches the table, (b) the head of a segment is a writing
 * command (`cp` / `tee` / `ln` / `chmod` / `sed -i` ...) or an interpreter whose contents cannot be read (`python` / `node` / `sh` ...), and **within that segment** there is
 * a word matching the table (TODO 1206: words in other segments or other statements are not matched), (c) `crontab` (except `-l`, which only reads), `launchctl load|bootstrap|enable|submit`, or a dangerous key of `git config`.
 * The route of writing from inside a script file slips through (an unstoppable route of 4.2.1; closing it is 1044).
 */
import { loadOutboundVocabulary } from './outbound-vocabulary.js'
import { basename, commandWords, dropDataHeredocBodies, shellSegments } from './outbound.js'
import { commandPathTokens, matchPathGroup, mergePathGroups } from './path-pattern.js'

const VOCABULARY = loadOutboundVocabulary().persistence
const WRITERS: ReadonlySet<string> = new Set(VOCABULARY.writers)
const IN_PLACE: ReadonlySet<string> = new Set(VOCABULARY.inPlace)
const INTERPRETERS: ReadonlySet<string> = new Set(VOCABULARY.interpreters)
const CRONTAB_READ: ReadonlySet<string> = new Set(VOCABULARY.crontabReadFlags)
const LAUNCHCTL_WRITES: ReadonlySet<string> = new Set(VOCABULARY.launchctlWrites)
const GIT_CONFIG_READ: ReadonlySet<string> = new Set(VOCABULARY.gitConfigReadFlags)
/** Flags of `git config` that take the next word as their value (so it is not mistaken for a key). */
const GIT_CONFIG_VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment'])
/** Prefix flags before `git` that take the next word as their value. */
const GIT_PREFIX_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** What matched the persistence judgment. `match` is the table name (`shell-startup` / `cli-settings` / `crontab` ...), `target` is the path or key. */
export interface PersistenceHit {
  readonly match: string
  readonly target: string | null
}

/** The table the Adapter builds from the compat table. */
export interface PersistenceTable {
  readonly shellTools: readonly string[]
  readonly commandField: string
  /** Backend-specific write targets (where the CLI's settings are). Layered on the common table. */
  readonly paths?: Readonly<Record<string, readonly string[]>>
}

function groupsOf(table: PersistenceTable): Readonly<Record<string, readonly string[]>> {
  return mergePathGroups(VOCABULARY.paths, table.paths)
}

/**
 * Whether an approval request is a write that persists. Null if not.
 *
 * - Shell tools: `classifyPersistenceCommand`.
 * - Write tools: a match if any of `writePath` (the Adapter's `writeToolTargetPath`) and the absolute path / realpath resolved by the caller (`resolve`) matches the table.
 */
export function classifyPersistence(
  table: PersistenceTable,
  toolName: string,
  input: unknown,
  writePath: string | null,
  resolve?: (path: string) => readonly string[]
): PersistenceHit | null {
  const groups = groupsOf(table)
  if (table.shellTools.includes(toolName)) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
    const command = (input as Record<string, unknown>)[table.commandField]
    return typeof command === 'string' ? classifyPersistenceCommand(command, groups) : null
  }
  if (writePath === null || writePath.trim() === '') return null
  for (const candidate of [writePath, ...(resolve?.(writePath) ?? [])]) {
    const match = matchPathGroup(candidate, groups)
    if (match !== null) return { match, target: writePath }
  }
  return null
}

/** The target word of a redirect (`>` / `>>` / `>|` / `&>` / `2>`). `>&2` (fd duplication) is excluded. A partly quoted form (`"$HOME"/.zshrc`) is also taken as one word (TODO 1206). */
const REDIRECT = /(?:^|[^-=<>])(?:&|\d)?>{1,2}\|?[ \t]*(?!&)((?:"[^"\n]*"|'[^'\n]*'|[^\s;&|<>()"'])+)/g

export function classifyPersistenceCommand(
  command: string,
  groups: Readonly<Record<string, readonly string[]>> = VOCABULARY.paths
): PersistenceHit | null {
  if (command.trim() === '') return null
  // The body of a heredoc (the contents being written) is not looked at as words (the same skipping as TODO 1053). The destination remains on the `<<` line.
  // TODO 1206: a body redirected to a file (`cat > /tmp/x.py <<'EOF'`) is dropped even if `python3 /tmp/x.py` follows it. We used to ask just because the word `.mcp.json`
  // was in the body. **This is the only narrowing** - the "match only words inside the writing statement" approach missed `python3 -c "…; open('~/.zshrc')"`, heredocs to
  // interpreters, and writers not in the table (`rm x 2>/dev/null`), so it was not adopted (wave 82 review).
  const text = dropDataHeredocBodies(command, { dropFileBound: true })
  // If there is even one redirect, treat it as "writing" and also match the words of the whole command against the table below (review 57-1). A target that is only partly quoted
  // (`>> "$HOME"/.zshrc`) is taken as one word by REDIRECT, and quotes are removed before matching.
  let writes = false
  for (const match of text.matchAll(REDIRECT)) {
    writes = true
    const target = (match[1] ?? '').replace(/["']/g, '')
    const group = matchPathGroup(target, groups)
    if (group !== null) return { match: group, target }
  }
  for (const segment of shellSegments(text)) {
    const words = commandWordsPastKeywords(segment)
    const head = words[0] === undefined ? '' : basename(words[0])
    const args = words.slice(1)
    const special = specialCommand(head, args, groups)
    if (special !== null) return special
    if (WRITERS.has(head) || INTERPRETERS.has(head) || writesByForm(head, args)) writes = true
  }
  if (!writes) return null
  for (const token of commandPathTokens(text)) {
    const group = matchPathGroup(token, groups)
    if (group !== null) return { match: group, target: token }
  }
  return null
}

/** Shell reserved words that stand at the start of a statement. The word after is the real command (`then cp …`, `do tee …`, `! cp …`). */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(', 'builtin'])
/**
 * Alternately strip reserved words and wrappers (`sudo` / `env` ..., stripped by `commandWords`) until neither can be stripped (`then sudo cp …`. Wave 82 review).
 * Stripping is only to find the head of the writer, and once found the words of the whole command are matched, so stripping too much only leans toward asking.
 */
function commandWordsPastKeywords(segment: string): readonly string[] {
  let words = commandWords(segment)
  for (let guard = 0; guard < 8 && words[0] !== undefined && SHELL_KEYWORDS.has(words[0]); guard += 1) {
    let start = 0
    while (start < words.length && SHELL_KEYWORDS.has(words[start] ?? '')) start += 1
    words = commandWords(words.slice(start).join(' '))
  }
  return words
}

/** The forms of `crontab` / `launchctl` / `git config`. Null if none matches. */
function specialCommand(head: string, args: readonly string[], groups: Readonly<Record<string, readonly string[]>>): PersistenceHit | null {
  if (head === 'crontab') {
    // No arguments (replaces from standard input), `-e`, `-r`, and a file name are all writes. Only `-l` reads.
    return args.length > 0 && args.every((arg) => CRONTAB_READ.has(arg)) ? null : { match: 'crontab', target: null }
  }
  if (head === 'launchctl') {
    const positional = args.filter((arg) => !arg.startsWith('-'))
    const sub = positional[0]
    return sub !== undefined && LAUNCHCTL_WRITES.has(sub) ? { match: 'launchctl', target: positional[1] ?? null } : null
  }
  if (head === 'git') return gitConfigHit(args) ?? gitOutputHit(args, groups)
  if (head === 'tar' || head === 'gtar' || head === 'bsdtar') return tarHit(args, groups)
  if (head === 'unzip') return unzipHit(args, groups)
  return null
}

/**
 * Commands treated as writing only in a writing form (we do not ask about the read-only `sed -n` / `sort` / `tar tf`. Review of TODO 1071).
 * `jq` is excluded because it writes only to stdout (redirects are looked at separately).
 */
function writesByForm(head: string, args: readonly string[]): boolean {
  if (head === 'sed' || head === 'gsed') {
    if (IN_PLACE.has(head) && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg === '--in-place' || arg.startsWith('--in-place='))) return true
    // The `w <file>` / `W <file>` commands of the script and the `s///w <file>` flag. Matched broadly (if no word matches the table, we do not ask in the end).
    // Words are cut at spaces with their quotes included, so the script is looked at by joining the arguments.
    const script = args.join(' ')
    return /(^|[;{}\n'"])\s*[wW]\s*\S/.test(script) || /\s[wW]\s+\S/.test(script) || /\/[gpiImMe0-9]*[wW]\s*\S/.test(script)
  }
  if (head === 'awk' || head === 'gawk') return args.some((arg) => arg.includes('>'))
  if (head === 'sort') return args.some((arg) => arg === '-o' || /^-o./.test(arg) || /^--out(p(u(t)?)?)?(=|$)/.test(arg))
  if (head === 'uniq') return args.filter((arg) => !arg.startsWith('-')).length >= 2
  if (head === 'unzip') return !unzipReadOnly(args)
  if (head === 'tar' || head === 'gtar' || head === 'bsdtar') return tarMode(args) === 'extract'
  return false
}

const unquote = (word: string): string => word.replace(/^["']|["']$/g, '')

function unzipReadOnly(args: readonly string[]): boolean {
  return args.some((arg) => !arg.startsWith('--') && /^-[A-Za-z]*[ltpZ]/.test(arg))
}

function tarMode(args: readonly string[]): 'extract' | 'write' | 'read' {
  let mode: 'extract' | 'write' | 'read' = 'read'
  args.forEach((arg, i) => {
    let letters = ''
    if (arg === '--extract' || arg === '--get') letters = 'x'
    else if (arg === '--create' || arg === '--append' || arg === '--update') letters = 'c'
    else if (/^-[A-Za-z]+$/.test(arg) || (i === 0 && /^[A-Za-z]+$/.test(arg))) letters = arg.replace(/^-/, '')
    if (letters.includes('x')) mode = 'extract'
    else if (mode === 'read' && /[cruA]/.test(letters)) mode = 'write'
  })
  return mode
}

/** Whether the extraction target is the home itself or a parent in the path table (`~/.ssh` / `.git`). The write target does not appear on the command line, so it is matched here. */
function dirHit(dir: string, groups: Readonly<Record<string, readonly string[]>>): PersistenceHit | null {
  const clean = unquote(dir).replace(/\/+$/, '')
  if (clean === '') return null
  if (/^(~|\$HOME|\$\{HOME\}|\/Users\/[^/]+|\/home\/[^/]+)$/.test(clean)) return { match: 'shell-startup', target: dir }
  for (const probe of ['/x', '/config', '/hooks/x']) {
    const group = matchPathGroup(clean + probe, groups)
    if (group !== null) return { match: group, target: dir }
  }
  return null
}

/** The extraction target of `tar` (`-C` / `--directory`) and the write target of create / append (`-f <path>`). */
function tarHit(args: readonly string[], groups: Readonly<Record<string, readonly string[]>>): PersistenceHit | null {
  const mode = tarMode(args)
  if (mode === 'read') return null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    let dir: string | null = null
    let file: string | null = null
    if (arg === '--directory' || /^-[A-Za-z]*C$/.test(arg)) dir = args[i + 1] ?? null
    else if (arg.startsWith('--directory=')) dir = arg.slice('--directory='.length)
    else if (/^-C./.test(arg)) dir = arg.slice(2)
    else if (arg === '--file' || /^-[A-Za-z]*f$/.test(arg)) file = args[i + 1] ?? null
    else if (arg.startsWith('--file=')) file = arg.slice('--file='.length)
    if (dir !== null && mode === 'extract') {
      const hit = dirHit(dir, groups)
      if (hit !== null) return hit
    }
    if (file !== null && mode === 'write') {
      const group = matchPathGroup(unquote(file), groups)
      if (group !== null) return { match: group, target: unquote(file) }
    }
  }
  return null
}

/** `unzip -d <dir>` (also `-d<dir>`). Listing, testing and stdout output (`-l` / `-t` / `-p` / `-Z`) do not write. */
function unzipHit(args: readonly string[], groups: Readonly<Record<string, readonly string[]>>): PersistenceHit | null {
  if (unzipReadOnly(args)) return null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    const dir = arg === '-d' ? (args[i + 1] ?? null) : /^-d./.test(arg) ? arg.slice(2) : null
    if (dir === null) continue
    const hit = dirHit(dir, groups)
    if (hit !== null) return hit
  }
  return null
}

/** `git <subcommand> --output=<path>` / `--output <path>` (abbreviations such as `--outp` too). diff / log / show can write to any file. */
function gitOutputHit(args: readonly string[], groups: Readonly<Record<string, readonly string[]>>): PersistenceHit | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    const m = /^--outp(?:u(?:t)?)?(?:=(.*))?$/.exec(arg)
    if (m === null) continue
    const value = unquote(m[1] ?? args[i + 1] ?? '')
    const group = value === '' ? null : matchPathGroup(value, groups)
    if (group !== null) return { match: group, target: value }
  }
  return null
}

function gitConfigHit(args: readonly string[]): PersistenceHit | null {
  let at = 0
  while (at < args.length) {
    const arg = args[at] ?? ''
    if (GIT_PREFIX_VALUE_FLAGS.has(arg)) {
      at += 2
      continue
    }
    if (arg.startsWith('-')) {
      at += 1
      continue
    }
    break
  }
  if (args[at] !== 'config') return null
  const rest = args.slice(at + 1)
  if (rest.some((arg) => GIT_CONFIG_READ.has(arg))) return null
  // `git config --edit` / `-e` opens the whole settings file.
  if (rest.some((arg) => arg === '-e' || arg === '--edit')) return { match: 'git-config', target: null }
  // Skip the subcommand of the new form (`git config set|unset <key>`, 2.46 and later). `get` / `list` read.
  let key: string | null = null
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? ''
    if (GIT_CONFIG_VALUE_FLAGS.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    if (key === null && (arg === 'get' || arg === 'list')) return null
    if (key === null && (arg === 'set' || arg === 'unset' || arg === 'rename-section' || arg === 'remove-section')) continue
    key = arg.toLowerCase()
    break
  }
  if (key === null) return null
  const risky = VOCABULARY.gitConfigKeyPrefixes.some((prefix) => key.startsWith(prefix)) || key.endsWith('.textconv')
  return risky ? { match: 'git-config', target: key } : null
}
