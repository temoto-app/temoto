/**
 * Matching and proposals for the per-role grant table (TODO 983 stage 1, ARCHITECTURE 4.2.5). **Pure functions only.**
 *
 * A role that runs unattended (stages 1 to 3: one scheduled job = one role, key `job:<jobId>`) starts strict, and grants accumulate in this table through the approval frame's "allow this role from now on".
 * The Broker consults it at stage 2.7, after stage 2.5 (quiet standard commands) and before strict. The Broker stops the stage 0 lines (questions, plans, side effects, outbound operations,
 * persistence, secrets), stop patterns and unreadable commands first, so only the requests after those reach here.
 *
 * - The subject (`GrantSubject`) is a neutral form the Adapter builds from a tool call (`grantSubjectFor` is the entry point the Adapter calls with its table, constraint 6).
 * - **This is matching on the side that lets things pass, so when in doubt, leave it out** (same direction as quiet.ts). Bash forms that cannot be read (command substitution, parentheses, heredocs, `&`,
 *   writing to a file, `\`) are not used for first-word prefix matching; only an exact match of the whole command (hash) is used.
 * - First words that can run anything (shells, interpreters, wrappers, tools that are paths out) never get a prefix-match row, and such rows have no effect.
 * - Paths are a directory prefix match on the realpath (the boundary is the `/` separator). The working folder is not looked at (same as T40 in 4.2.1.1).
 */
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  canAlwaysAllow,
  isRoleGrantScope,
  type GrantSubject,
  type RoleGrantScope,
  type RoleGrantSubjectKind
} from '@shared/thread.js'
import { EXTERNAL_DIRECTORY_TOOL } from '@shared/approval-tools.js'
import { redactText } from '../../common/redact.js'
import { loadOutboundVocabulary } from './outbound-vocabulary.js'
import { basename } from './outbound.js'
import { normalizeCommand, splitCommand } from './policy.js'

const VOCABULARY = loadOutboundVocabulary()

/**
 * First words for which a prefix-match row is neither made nor honored (the "shell interpreters" of 3. in 4.2.5). Allowing just the first word would let anything run:
 * shells, heredoc runners, wrappers (`env` / `xargs` / `sudo` ...), tools that are paths out (`curl` / `ssh` / `python3` ...), and interpreters.
 */
const EXACT_ONLY_HEADS: ReadonlySet<string> = new Set([
  ...VOCABULARY.shell.shells,
  ...VOCABULARY.shell.heredocRunners,
  ...VOCABULARY.shell.wrappers,
  ...Object.keys(VOCABULARY.quiet.wrappers),
  ...VOCABULARY.quiet.shells,
  ...VOCABULARY.secrets.egressCommands,
  ...VOCABULARY.persistence.interpreters
])

/**
 * First words that take another command as an argument and run it (wave 89 code-review). Including ones not in the vocabulary table's `wrappers`, they never get a prefix match
 * (so `timeout 5 rm -rf x` is not passed by a grant for `timeout 5`).
 */
const WRAPPER_HEADS: ReadonlySet<string> = new Set([
  'timeout', 'nice', 'ionice', 'nohup', 'time', 'command', 'builtin', 'exec', 'env', 'xargs', 'sudo', 'doas', 'su', 'stdbuf',
  'setsid', 'chroot', 'watch', 'unbuffer', 'script', 'parallel', 'find', 'npx', 'bunx', 'uvx', 'pipx', 'tsx', 'ts-node'
])
/** (first word, second word) pairs where whatever follows the subcommand becomes arbitrary execution (`uv run x` / `npm exec x` / `cargo run`). */
const EXEC_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'uv run', 'uv tool', 'poetry run', 'pipenv run', 'pdm run', 'hatch run', 'rye run', 'conda run', 'npm exec', 'npm x', 'pnpm exec', 'pnpm dlx',
  'pnpm x', 'yarn exec', 'yarn dlx', 'bun x', 'bun exec', 'bundle exec', 'cargo run', 'go run', 'deno run', 'dotnet run', 'mvn exec:java',
  'gradle run', 'docker run', 'docker exec', 'kubectl exec', 'kubectl run', 'git filter-branch', 'docker-compose run',
  'docker-compose exec', 'podman run', 'podman exec', 'nerdctl run', 'nerdctl exec', 'yarn workspace', 'pnpm --filter', 'nx run'
])

/** Words allowed as the second word (the subcommand) of a prefix match. Flags, paths, quotes, variables and globs are excluded. */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/
/** Subcommands that take up to a third word (`npm run build` / `pnpm run test`). After `run` comes the script name. */
const SCRIPT_SUBCOMMANDS: ReadonlySet<string> = new Set(['run', 'run-script'])
/** Verbs after which anything can become an arbitrary command, whatever the first word (wave 89 automatic security review). */
const EXEC_VERBS: ReadonlySet<string> = new Set(['exec', 'x', 'foreach', 'dlx', 'shell', 'eval'])
const THIRD_EXEC_VERBS: ReadonlySet<string> = new Set(['exec', 'foreach', 'run', 'shell', 'eval'])

/** A table the Adapter builds from the compat table (constraint 6: tool names and argument keys are backend-specific). */
export interface GrantTable {
  readonly shellTools: readonly string[]
  readonly commandField: string
  /** Tools that read (`secrets.readTools`) and the key of their path argument. */
  readonly readTools: readonly string[]
  readonly pathKeys: readonly string[]
  /** Tools that fetch from the Web (`secrets.egressTools`). If there is a `urlField` argument they are matched by host, otherwise by tool name. */
  readonly fetchTools: readonly string[]
  readonly urlField: string
  /**
   * Tools that write (wave 89 automatic security review). A write whose target path is not a single one (a call without a path, a patch touching several files)
   * is not reduced to a tool-name row and no subject is built (= ask every time). Reducing it would let that tool write anywhere.
   */
  readonly writeTools: readonly string[]
  /**
   * Tools known to be read-only (TODO 983 stage 2, owner decision 2026-11-15). A tool with neither a write mark nor a read mark in the table (such as a user's
   * MCP tool, where we cannot tell write from read) does not become a name row - ask every time. The same set as the Adapter's `isReadOnlyTool`
   * (only the table's unattended read-only tools `unattended.readOnlyTools`. **Web fetch and search tools are not included** - they send queries outside).
   */
  readonly readOnlyTools: readonly string[]
}

/** The result of resolving a path (the caller resolves it against the conversation's working folder and turns it into a realpath). Null if it cannot be resolved. */
export interface ResolvedGrantPath {
  readonly path: string
  readonly directory: boolean
}

/**
 * Build the grant subject from a tool call (the body of the Adapter's `grantSubjectOf`). Null if it cannot be built (= the table is not consulted and nothing is proposed).
 * `writeTarget` is the Adapter's `writeToolTargetPath` (the target of a write tool), and `resolve` is the entry point that resolves a path to a realpath.
 */
export function grantSubjectFor(
  table: GrantTable,
  toolName: string,
  input: unknown,
  writeTarget: string | null,
  resolve?: (raw: string) => ResolvedGrantPath | null
): GrantSubject | null {
  if (!canAlwaysAllow(toolName)) return null
  // The check for a path outside the working folder (TODO 1020) would let any outside directory through if made a tool-name row. Not built in stage 1 (ask every time).
  if (toolName === EXTERNAL_DIRECTORY_TOOL) return null
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  if (table.shellTools.includes(toolName)) {
    const command = record?.[table.commandField]
    return typeof command === 'string' && command.trim() !== '' ? { kind: 'command', command } : null
  }
  if (writeTarget !== null) {
    const resolved = resolve?.(writeTarget) ?? null
    return resolved === null ? null : { kind: 'path', access: 'write', path: resolved.path, directory: false }
  }
  if (table.writeTools.includes(toolName)) return null
  if (table.readTools.includes(toolName)) {
    if (record === null || resolve === undefined) return null
    let raw: string | null = null
    for (const key of table.pathKeys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') {
        raw = value
        break
      }
    }
    // A search with no origin (the working folder) does not put the working folder into the judgment, so it is not built. Cases where another argument has an absolute path or a path that goes up
    // (`pattern: '/etc/**'`) can also look outside the origin, so they are not built either (they ask).
    if (raw === null) return null
    for (const [key, value] of Object.entries(record)) {
      if (table.pathKeys.includes(key) || typeof value !== 'string') continue
      if (value.startsWith('/') || value.startsWith('~') || value.includes('..')) return null
    }
    const resolved = resolve(raw)
    return resolved === null ? null : { kind: 'path', access: 'read', path: resolved.path, directory: resolved.directory }
  }
  if (table.fetchTools.includes(toolName)) {
    const url = record?.[table.urlField]
    // A fetch or search without a URL (`WebSearch` etc.) sends a query outside. If it is not in the read-only set, it is not built (ask every time).
    if (url === undefined) return table.readOnlyTools.includes(toolName) ? { kind: 'tool' } : null
    const host = hostOf(url)
    return host === null ? null : { kind: 'host', host }
  }
  // Stage 2: only tools known to be read-only can be allowed by name. Everything else (where we cannot tell write from read) is not built (ask every time).
  return table.readOnlyTools.includes(toolName) ? { kind: 'tool' } : null
}

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const host = parsed.hostname.toLowerCase()
    return host === '' ? null : host
  } catch {
    return null
  }
}

/** One row of the table (a form only inside main). The same as the columns of `role_grants`. */
export interface RoleGrantRow {
  readonly id: string
  readonly roleKey: string
  readonly toolName: string
  readonly subjectKind: RoleGrantSubjectKind
  /** The value for matching and display. For `command-exact`, only the display after redaction. */
  readonly subject: string | null
  /** The matching value for `command-exact` (the SHA-256 of the normalized command). */
  readonly subjectHash: string | null
  readonly access: 'read' | 'write' | null
  readonly scope: RoleGrantScope
  readonly threadId: string | null
  readonly expiresAt: number | null
  readonly source: 'approval' | 'drill'
  readonly createdAt: number
  readonly lastUsedAt: number | null
  readonly useCount: number
}

/** A candidate row to add (a proposal). The role, expiry and id are decided when pressed. */
export interface GrantCandidate {
  readonly subjectKind: RoleGrantSubjectKind
  readonly subject: string
  readonly subjectHash: string | null
  readonly access: 'read' | 'write' | null
}

const SUBJECT_KINDS: ReadonlySet<string> = new Set(['command-prefix', 'command-exact', 'path-prefix', 'host', 'tool'])

/** Same as TODO 859: the SHA-256 (hex) of the normalized command. */
export function grantCommandHash(command: string): string {
  // Newlines (and CR) are separators, so they are not squashed into spaces: so that an exact-match row for `git status sh` (an argument) does not match `git status⏎sh` (a different command),
  // normalize line by line and join with newlines (a command without newlines gets the same hash as before. Wave 91 code-review).
  const text = command
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(normalizeCommand)
    .join('\n')
    .trim()
  return createHash('sha256').update(text).digest('hex')
}

/** Validate a row read from the storage (the same idea as `sanitizeRule`: DB contents are values from outside too). Rows that do not agree, or that cannot be made now, become null (no effect). */
export function sanitizeGrantRow(row: RoleGrantRow): RoleGrantRow | null {
  if (typeof row.id !== 'string' || row.id === '' || typeof row.roleKey !== 'string' || row.roleKey === '') return null
  if (typeof row.toolName !== 'string' || row.toolName === '' || !canAlwaysAllow(row.toolName)) return null
  if (!SUBJECT_KINDS.has(row.subjectKind)) return null
  if (!isRoleGrantScope(row.scope)) return null
  if (row.scope === 'thread' && (typeof row.threadId !== 'string' || row.threadId === '' || row.expiresAt !== null)) return null
  if (row.scope === 'today' && (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.threadId !== null)) return null
  if (row.scope === 'forever' && (row.threadId !== null || row.expiresAt !== null)) return null
  switch (row.subjectKind) {
    case 'command-prefix': {
      const value = row.subject
      if (value === null || value === '' || normalizeCommand(value) !== value) return null
      // A prefix match on a first word that can run anything is not honored (old versions, rows touched by hand).
      if (execRefusal(value.split(' ')) !== null) return null
      break
    }
    case 'command-exact':
      if (row.subjectHash === null || !/^[0-9a-f]{64}$/.test(row.subjectHash)) return null
      break
    case 'path-prefix':
      if (row.subject === null || !row.subject.startsWith('/') || row.subject === '/') return null
      if (row.access !== 'read' && row.access !== 'write') return null
      break
    case 'host':
      if (row.subject === null || row.subject === '' || row.subject !== row.subject.toLowerCase()) return null
      break
    case 'tool':
      break
  }
  return row
}

/** Whether a row takes effect in this conversation now (expiry, "this conversation only"). */
export function grantActive(row: RoleGrantRow, now: number, threadId: string): boolean {
  if (row.scope === 'today') return row.expiresAt !== null && now < row.expiresAt
  if (row.scope === 'thread') return row.threadId === threadId
  return true
}

/** Matching context. `quietSegment` is the Broker's judgment of "quiet standard commands" (1031, for one segment). */
export interface GrantMatchContext {
  readonly roleKey: string
  /**
   * TODO 983 stage 4: further keys whose rows also apply (a Teammate's job run consults the job's rows and the Teammate's rows).
   * A compound command may pass with segments matched by rows of different keys - all of them are rows of this conversation.
   */
  readonly alsoRoleKeys?: readonly string[]
  readonly toolName: string
  readonly threadId: string
  readonly now: number
  readonly quietSegment: (segment: string) => boolean
  /** The user's home (realpath). Main passes `os.homedir()` so that a path-prefix that is too broad is not proposed. */
  readonly home: string
}

/** Rows that are in effect now for the same role and tool (matching and proposals use the same narrowing). */
function liveRows(rows: readonly RoleGrantRow[], context: GrantMatchContext): readonly RoleGrantRow[] {
  return rows.filter(
    (row) =>
      (row.roleKey === context.roleKey || context.alsoRoleKeys?.includes(row.roleKey) === true) &&
      row.toolName === context.toolName &&
      grantActive(row, context.now, context.threadId)
  )
}

/**
 * Whether it hits a grant row. If so, the rows used (Bash can have several, one per segment); otherwise null.
 * **Bash passes only when every segment hits "a grant or a quiet standard command".** The caller (Broker) looks at stop patterns first.
 */
export function matchGrant(
  subject: GrantSubject,
  rows: readonly RoleGrantRow[],
  context: GrantMatchContext
): readonly RoleGrantRow[] | null {
  const live = liveRows(rows, context)
  if (live.length === 0) return null
  switch (subject.kind) {
    case 'tool': {
      const row = live.find((candidate) => candidate.subjectKind === 'tool')
      return row === undefined ? null : [row]
    }
    case 'host': {
      const row = live.find((candidate) => candidate.subjectKind === 'host' && candidate.subject === subject.host)
      return row === undefined ? null : [row]
    }
    case 'path': {
      const row = live.find(
        (candidate) =>
          candidate.subjectKind === 'path-prefix' &&
          candidate.subject !== null &&
          (candidate.access === 'write' || candidate.access === subject.access) &&
          pathUnder(subject.path, candidate.subject)
      )
      return row === undefined ? null : [row]
    }
    case 'command':
      return matchCommand(subject.command, live, context.quietSegment)
  }
}

function matchCommand(
  command: string,
  rows: readonly RoleGrantRow[],
  quietSegment: (segment: string) => boolean
): readonly RoleGrantRow[] | null {
  const hash = grantCommandHash(command)
  const exact = rows.find((row) => row.subjectKind === 'command-exact' && row.subjectHash === hash)
  if (exact !== undefined) return [exact]
  // Compound commands (TODO 983 stage 3, 3 of 1005): a command made only of safe characters is split at separators (`&&` `||` `;` `|`) and passes **only when every part**
  // hits a quiet standard command or a grant row (a first-word prefix match, or an exact match of just that part) - the same direction as how the CLI splits `Bash(grep:*)`.
  // Commands containing unsafe characters (quotes, `$`, globs, expansion symbols, etc.) are not split, and only the whole-command exact match above applies.
  if (!prefixReadable(command)) return null
  const used: RoleGrantRow[] = []
  for (const segment of splitCommand(command)) {
    if (quietSegment(segment.text)) continue
    // A part whose first word refuses prefix matching (interpreters, wrappers, arbitrary-execution verbs) does not match even a part-only exact row (if a row that allowed `sh` hit the `sh` of
    // `curl … | sh`, it could execute the previous part's output, whatever it is. Wave 91 automatic security review).
    // The receiving side of a pipe (after `|`) also does not get a part-only exact match, because its input changes with the previous part (only the whole-command exact match).
    if (segmentExactOnly(segment.text)) return null
    const segmentHash = grantCommandHash(segment.text)
    const row =
      (segmentExactAllowed(segment)
        ? rows.find((candidate) => candidate.subjectKind === 'command-exact' && candidate.subjectHash === segmentHash)
        : undefined) ??
      rows.find(
        (candidate) =>
          candidate.subjectKind === 'command-prefix' && candidate.subject !== null && startsWithPrefix(segment.text, candidate.subject)
      )
    if (row === undefined) return null
    if (!used.includes(row)) used.push(row)
  }
  return used.length === 0 ? null : used
}

/**
 * The rows to propose (the rightmost column of 3. in 4.2.5). For Bash, as many candidates as there are **segments that do not yet pass** (if a first-word prefix match cannot be used,
 * one exact match of the whole command). A value containing a secret does not become a row - `refused: 'secret'` (falls back to a one-time allow). If none can be made, `refused: 'none'`.
 */
export function proposeGrants(
  subject: GrantSubject,
  rows: readonly RoleGrantRow[],
  context: GrantMatchContext
): { readonly candidates: readonly GrantCandidate[] } | { readonly refused: 'secret' | 'none' } {
  switch (subject.kind) {
    case 'tool':
      return { candidates: [{ subjectKind: 'tool', subject: context.toolName, subjectHash: null, access: null }] }
    case 'host':
      return secretFree(subject.host) ? { candidates: [{ subjectKind: 'host', subject: subject.host, subjectHash: null, access: null }] } : { refused: 'secret' }
    case 'path': {
      const isDir = subject.access === 'read' && subject.directory
      const parent = isDir ? subject.path : dirname(subject.path)
      if (parent === '/' || !parent.startsWith('/')) return { refused: 'none' }
      // When the parent is too broad (the home, an ancestor of the home, directly under the root, a dot directory of the home), only the file itself (it passes only when `pathUnder` is equal).
      // A permission to read the directory itself is not offered if it is too broad.
      const dir = pathTooBroad(parent, context.home) ? (isDir ? null : subject.path) : parent
      if (dir === null || dir === '/') return { refused: 'none' }
      if (!secretFree(dir)) return { refused: 'secret' }
      return { candidates: [{ subjectKind: 'path-prefix', subject: dir, subjectHash: null, access: subject.access }] }
    }
    case 'command':
      return proposeCommand(subject.command, rows, context)
  }
}

function proposeCommand(
  command: string,
  rows: readonly RoleGrantRow[],
  context: GrantMatchContext
): { readonly candidates: readonly GrantCandidate[] } | { readonly refused: 'secret' | 'none' } {
  const normalized = normalizeCommand(command)
  if (normalized === '') return { refused: 'none' }
  const exactOf = (text: string, hashSource: string = text): { readonly candidates: readonly GrantCandidate[] } | { readonly refused: 'secret' } => {
    // A command containing a secret does not become an exact-match row either (so the masked display and the secret's hash are not left in the table).
    const redacted = redactText(text).text
    if (redacted !== text) return { refused: 'secret' }
    return { candidates: [{ subjectKind: 'command-exact', subject: redacted, subjectHash: grantCommandHash(hashSource), access: null }] }
  }
  // A command containing unsafe characters is not split: one exact match of the whole.
  if (!prefixReadable(command)) return exactOf(normalized, command)
  const live = liveRows(rows, context)
  const out: GrantCandidate[] = []
  const push = (candidate: GrantCandidate): void => {
    if (!out.some((existing) => existing.subjectKind === candidate.subjectKind && existing.subject === candidate.subject)) out.push(candidate)
  }
  for (const segment of splitCommand(command)) {
    if (context.quietSegment(segment.text)) continue
    // If there is a part whose first word refuses prefix matching, do not split: one exact match of the whole command (the same line as `matchCommand` of matching).
    if (segmentExactOnly(segment.text)) return exactOf(normalized, command)
    const segmentHash = grantCommandHash(segment.text)
    if (segmentExactAllowed(segment) && live.some((row) => row.subjectKind === 'command-exact' && row.subjectHash === segmentHash)) continue
    if (live.some((row) => row.subjectKind === 'command-prefix' && row.subject !== null && startsWithPrefix(segment.text, row.subject))) {
      continue
    }
    const prefix = prefixOf(segment.text)
    if (prefix === null) {
      // The receiving side of a pipe does not get a part-only exact match (its input changes with the previous part). Go to the whole-command exact match.
      if (!segmentExactAllowed(segment)) return exactOf(normalized, command)
      // A part that cannot be a first-word prefix match gets an exact match of just that part (the other parts stay as first words).
      const exact = exactOf(segment.text)
      if ('refused' in exact) return exact
      for (const candidate of exact.candidates) push(candidate)
      continue
    }
    if (!secretFree(prefix)) return { refused: 'secret' }
    push({ subjectKind: 'command-prefix', subject: prefix, subjectHash: null, access: null })
  }
  return out.length === 0 ? exactOf(normalized, command) : { candidates: out }
}

/**
 * The first word to propose from a segment (3. in 4.2.5): the first word + a subcommand (when the second word is a plain word; after `run`, up to the script name).
 * A one-word segment is just the first word. **Null if the second word is a flag, path or quote** (a first-word-only permission is too broad, so use an exact match of the whole -
 * narrower than the design's "first word only", the stage 1 note of 4.2.5). Null also for first words that can run anything and for assignment prefixes.
 */
export function prefixOf(segment: string): string | null {
  const words = normalizeCommand(segment).split(' ').filter((word) => word !== '')
  const head = words[0]
  if (head === undefined) return null
  if (execRefusal(words) !== null) return null
  // A one-word segment does not become a first-word prefix match (allowing `rm` would pass even `rm -rf …`. Wave 89 automatic security review). Go to the whole-command exact match.
  if (words.length === 1) return null
  const second = words[1] ?? ''
  if (!PLAIN_WORD.test(second)) return null
  if (SCRIPT_SUBCOMMANDS.has(second)) {
    // A `run` without a script name (`npm run`) is null (a flag or something else may follow).
    const third = words[2]
    if (third === undefined) return null
    return PLAIN_WORD.test(third) ? `${head} ${second} ${third}` : null
  }
  return `${head} ${second}`
}

/**
 * The reason a first-word prefix match must not be made (null if none). Proposals (`prefixOf`), matching (`matchCommand`) and row validation (`sanitizeGrantRow`)
 * use the same judgment. It looks at the first word (interpreters, wrappers, assignments, symbols), up to the second word (`uv run` etc.), and a `run` without a script name.
 */
function execRefusal(words: readonly string[]): string | null {
  const first = words[0] ?? ''
  const refusal = prefixRefusal(first)
  if (refusal !== null) return refusal
  const head = basename(first)
  // GNU's g-prefixed ones (`gtimeout` etc.) are wrappers too.
  if (WRAPPER_HEADS.has(head) || (head.startsWith('g') && WRAPPER_HEADS.has(head.slice(1)))) return 'wrapper'
  const second = words[1]
  if (second !== undefined && EXEC_SUBCOMMANDS.has(`${head} ${second}`)) return 'exec-subcommand'
  // Even a first word not in the table does not get a prefix match if the second word is an arbitrary-execution verb (`exec` / `x` / `foreach` / `dlx`) or a number (an argument of `timeout`-like commands)
  // (we lean toward closing by verb rather than refusing by the table's forms. Wave 89 automatic security review). `run` needs a script name (bare-run below and `prefixOf`).
  if (second !== undefined && (EXEC_VERBS.has(second) || /^[0-9.]+[smhd]?$/.test(second))) return 'exec-verb'
  // Third word onward: things like `git submodule foreach` / `git bisect run` / `docker compose run` where a later verb makes it arbitrary execution. Look at all positions
  // without fixing one (inserting a flag, as in `docker compose -f x.yml run app sh`, slipped through. Wave 89 automatic security review). They are often arguments, so
  // short words like `x` are not looked at; only `foreach` / `exec` / `run` / `shell` / `eval`. What follows `npm run <script>` is not looked at.
  if (second !== 'run' && second !== 'run-script' && words.slice(2).some((word) => THIRD_EXEC_VERBS.has(word))) return 'exec-verb'
  if (second !== undefined && SCRIPT_SUBCOMMANDS.has(second) && words[2] === undefined) return 'bare-run'
  return null
}

/** The reason a first word must not be a prefix match (null if none). */
function prefixRefusal(prefix: string): string | null {
  const head = prefix.split(' ')[0] ?? ''
  if (head === '' || head.includes('=')) return 'assignment'
  if (!/^[A-Za-z0-9_./+-]+$/.test(head)) return 'symbol'
  if (EXACT_ONLY_HEADS.has(basename(head))) return 'runner'
  return null
}

function segmentExactOnly(segment: string): boolean {
  return execRefusal(segment.split(' ').filter((word) => word !== '')) !== null
}

/**
 * Whether one part of a compound command may be matched or proposed with a part-only exact row (TODO 983 stage 3). Not for the receiving side of a pipe (after `|`), because its input
 * changes with the previous part. A part whose first word refuses prefix matching has already been refused by the caller (`segmentExactOnly`).
 */
function segmentExactAllowed(segment: { readonly operator: string }): boolean {
  return segment.operator !== '|'
}

/**
 * Whether it is a form that may be read by first-word prefix matching. **Only safe characters are allowed** (owner decision 2026-11-15, dialog): a design that lists dangerous symbols and refuses them
 * kept leaking through forms with quotes, globs, expansions, and flags in between (11 findings of the wave 89 automatic security review). Only when what is left after removing the separators (`&&` / `||` / `;` / `|`) and
 * the redirect to `/dev/null` consists of alphanumerics, `- _ . / : = , @ +` and spaces is it used for prefix matching; everything else becomes an exact match of the whole command.
 * No symbol with which the shell rewrites words (quotes, `$`, globs, `~`, `!`, `\`, parentheses, redirects, a lone `&`) remains.
 */
export function prefixReadable(command: string): boolean {
  const stripped = command
    .replace(/&&|\|\||;|\|/g, ' ')
    .replace(/\d*>&\d+/g, ' ')
    .replace(/&>>?[ \t]*\/dev\/null(?=[ \t]|$)/g, ' ')
    .replace(/\d*>>?[ \t]*\/dev\/null(?=[ \t]|$)/g, ' ')
  // Whitespace is only the ASCII space and the tab. A command containing a newline or CR is not used for prefix matching or splitting; only the whole-command exact match
  // (a newline after `|` slipped past the receiver's check. Wave 91 code-review).
  return /^[A-Za-z0-9_\-./:=,@+ \t]*$/.test(stripped)
}

/** Whether the segment starts with the grant's first word (at a word boundary: the whole is the same, or what follows immediately is whitespace). */
function startsWithPrefix(segment: string, prefix: string): boolean {
  return segment === prefix || segment.startsWith(`${prefix} `)
}

/** Whether a directory is too broad to be a prefix-match grant (the home itself, an ancestor of the home, directly under the root (depth 1 to 2), and under a dot directory of the home). */
export function pathTooBroad(dir: string, home: string): boolean {
  const depth = dir.split('/').filter((part) => part !== '').length
  if (depth <= 2) return true
  const base = home.endsWith('/') ? home.slice(0, -1) : home
  if (base === '') return false
  if (dir === base || base.startsWith(`${dir}/`)) return true
  if (dir.startsWith(`${base}/`)) return dir.slice(base.length + 1).startsWith('.')
  return false
}

/** Whether `path` is inside `dir` (the same, or below it at a `/` boundary). */
export function pathUnder(path: string, dir: string): boolean {
  if (dir === '/' || dir === '') return false
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return path === base || path.startsWith(`${base}/`)
}

function secretFree(value: string): boolean {
  return redactText(value).text === value
}

/** The expiry of "today only": 0:00 of the next day in local time of `now` (epoch ms). */
export function nextLocalMidnight(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime()
}

/** Build a row when pressed. */
export function grantRowOf(
  candidate: GrantCandidate,
  roleKey: string,
  toolName: string,
  scope: RoleGrantScope,
  threadId: string,
  now: number
): RoleGrantRow {
  return {
    id: randomUUID(),
    roleKey,
    toolName,
    subjectKind: candidate.subjectKind,
    subject: candidate.subject,
    subjectHash: candidate.subjectHash,
    access: candidate.access,
    scope,
    threadId: scope === 'thread' ? threadId : null,
    expiresAt: scope === 'today' ? nextLocalMidnight(now) : null,
    source: 'approval',
    createdAt: now,
    lastUsedAt: null,
    useCount: 0
  }
}

/** Whether these are rows of the same permission (so they are not stacked). The id and usage records are not looked at. */
export function sameGrant(a: RoleGrantRow, b: RoleGrantRow): boolean {
  return (
    a.roleKey === b.roleKey &&
    a.toolName === b.toolName &&
    a.subjectKind === b.subjectKind &&
    a.subject === b.subject &&
    a.subjectHash === b.subjectHash &&
    a.access === b.access &&
    a.scope === b.scope &&
    a.threadId === b.threadId
  )
}
