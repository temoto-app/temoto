/**
 * Judging operations that send something out (TODO 959, ARCHITECTURE.md 4.2.1 "operations that send something out are asked about even by default").
 *
 * TODO 1191 (owner decision 2026-11-08): what we ask about is narrowed to **only sending messages that reach a person's eyes (an individual or a small group)**.
 * Asked: connector tool names (`matchOutboundToolName`), mail commands, sending with `osascript`, chat webhooks / APIs
 * (a write by curl / wget / httpie to a host in `chatEndpoints`). Not asked: publishing ones such as `gh`, `git push`, `npm publish`,
 * transfer ones such as `scp` / `sftp`, and generic curl / wget / httpie. Instead of making the lexical analysis smarter, we narrowed what is judged
 * (a string in `python3 - <<'PY'` that merely contained `gh release create` used to trigger a question). We assume aios users run with Bypass-equivalent behavior.
 *
 * This file is **pure functions only** and holds no backend words. Which tool is a shell, the shape of MCP tool names, and
 * the tools to stop by name are passed in by the Adapter as an `OutboundTable` made from the `outbound` table in `compat/` (constraint 6).
 * The shapes of shell commands (`curl -X POST` etc.) do not depend on the backend, so they live here. The vocabulary (the lists of verbs, nouns, command names and
 * flags) was moved to `compat/outbound.json` in TODO 1020, and both Adapters use this judgment and that one vocabulary
 * (owner decision 2026-10-26).
 *
 * **Coarse is fine, but lean toward the sending side.** A shell can write anything, so we cannot be exhaustive (a URL put in a variable,
 * a script file, `python -c` ...). If exhaustiveness is needed, use strict mode - scheduled jobs are strict by default (6.2.4).
 * Even if sending is stopped by approval, other routes remain to leak what was read (embedding it in the URL of a Web fetch, etc.).
 * This is a line for "do not send on your own", not a complete defense against prompt injection.
 */
import type { OutboundDetail } from '@shared/thread.js'
import { GATEWAY_TOOL_PREFIX } from '@shared/thread.js'
import { splitCommand } from './policy.js'
import { loadOutboundVocabulary } from './outbound-vocabulary.js'

/** The backend-independent vocabulary (`compat/outbound.json`, TODO 1020). Both Adapters judge with this one. */
const VOCABULARY = loadOutboundVocabulary()

/** The table the Adapter builds from `outbound` in `compat/`. */
export interface OutboundTable {
  readonly shellTools: readonly string[]
  readonly commandField: string
  /** The start of MCP tool names (`mcp__`). A name that begins with it is read as `<prefix><server><separator><tool>`. */
  readonly mcpPrefix: string
  readonly mcpSeparator: string
  /** Full names of tools to stop even when no verb matches (known sending tools of connectors). */
  readonly tools: readonly string[]
  /** Full names of tools not to stop even when a verb matches (known to only read). */
  readonly readOnlyTools: readonly string[]
}

/** Upper limit (characters) of the body shown. It is for reading in the approval frame; the full text is in "contents". */
export const MAX_OUTBOUND_TEXT = 20_000

// ---- MCP tool names ----

/** If the first word is one of these, it only reads (`get_comments` / `list_posts` / `search_messages`). The vocabulary is in `compat/outbound.json` (TODO 1020). */
const READ_VERBS: ReadonlySet<string> = new Set(VOCABULARY.mcp.readVerbs)

/** Words treated as sending or posting wherever they are in the name. */
const SEND_VERBS: ReadonlySet<string> = new Set(VOCABULARY.mcp.sendVerbs)

/** Verbs for create / modify / delete. They match only when paired with the "things visible to people" below (`create_issue` matches, `create_draft` does not). */
const WRITE_VERBS: ReadonlySet<string> = new Set(VOCABULARY.mcp.writeVerbs)

/** Things that reach other people when created or changed (issues, PRs, calendar invitations, messages, pages, files and branches of a remote repository ...). */
const SHARED_OBJECTS: ReadonlySet<string> = new Set(VOCABULARY.mcp.sharedObjects)

/** Split `send_message` / `createIssue` / `post-message` into words (lowercase). */
export function toolWords(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
}

/**
 * Whether an MCP tool's name (without the server) has the shape of sending or posting. Returns the word that matched (`send` / `create+issue`).
 * If a reading verb comes before the sending or creating verb, null (`get_comments` / `slack_read_channel` / `github_list_posts`.
 * Some tools prefix the service name to the tool name, so we do not decide by the first word alone).
 */
export function matchOutboundToolName(name: string): string | null {
  const words = toolWords(name)
  let verb: string | null = null
  for (const word of words) {
    if (SEND_VERBS.has(word)) return word
    if (verb !== null) continue
    if (WRITE_VERBS.has(word)) verb = word
    else if (READ_VERBS.has(word)) return null
  }
  if (verb === null) return null
  const object = words.find((word) => SHARED_OBJECTS.has(word))
  return object === undefined ? null : `${verb}+${object}`
}

// ---- Shell ----

/** Prefixes after which the inner command is the real one (`sudo curl …`, `env A=1 curl …`). */
const WRAPPERS: ReadonlySet<string> = new Set(VOCABULARY.shell.wrappers)
/** Flags of wrappers that take the next word as their value (`sudo -u me`, `xargs -n 1`). */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(VOCABULARY.shell.wrapperValueFlags).map(([name, flags]) => [name, new Set(flags)])
)
const SHELLS: ReadonlySet<string> = new Set(VOCABULARY.shell.shells)
const MAIL_COMMANDS: ReadonlySet<string> = new Set(VOCABULARY.shell.mailCommands)
/** Turn a list of words into `(a|b|…)` (regex symbols are escaped). */
function alternation(words: readonly string[]): string {
  return words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
}
/** The recipient of an AppleScript send (`tell application "Mail"`). */
const OSASCRIPT_SEND = new RegExp(`\\b(${alternation(VOCABULARY.shell.osascriptWords)})\\b`)
/** Destinations of chat webhooks / APIs (`host` or host/path-prefix; `*.host` also covers child hosts). curl / wget / httpie to these are asked about whatever the method (TODO 1191, review X-1). */
const CHAT_ENDPOINTS: readonly { readonly host: string; readonly subdomains: boolean; readonly path: string }[] =
  VOCABULARY.shell.chatEndpoints.map((entry) => {
    const slash = entry.indexOf('/')
    const host = (slash < 0 ? entry : entry.slice(0, slash)).toLowerCase()
    return {
      host: host.replace(/^\*\./, ''),
      subdomains: host.startsWith('*.'),
      path: slash < 0 ? '' : entry.slice(slash).toLowerCase()
    }
  })

/** Decode `%XX` until it stops changing (against double encoding). Null if it cannot be decoded. */
function decodeRepeatedly(raw: string): string | null {
  let current = raw
  for (let round = 0; round < 8; round += 1) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      return null
    }
    if (next === current) return current
    current = next
  }
  return current
}

/**
 * If one word of the arguments starts with a URL or host, return its host and (lowercase) path. URLs inside a JSON value are not picked up.
 * Review X-4: if the host contains `%`, decode it; if it cannot be decoded, `opaque` (leaning toward asking).
 */
function endpointOf(arg: string): { host: string; path: string; opaque: boolean } | null {
  // Review X-2: the value of a variable assignment (`WEBHOOK=https://…` / `export URL=…`) and the quotes around that value are also seen as a destination.
  const bare = arg.replace(/^--url=/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '').replace(/^["'`]+/, '')
  // Review (1191): not slipped past by an uppercase scheme, a host with a trailing dot, or a path containing `//` or `./` `../`.
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([A-Za-z0-9%][A-Za-z0-9.%-]*)(?::\d+)?(\/[^\s?#]*)?/i.exec(bare)
  if (m === null) return null
  let host = m[1] ?? ''
  if (host.includes('%')) {
    const decoded = decodeRepeatedly(host)
    if (decoded === null || !/^[A-Za-z0-9.-]+$/.test(decoded)) return { host: '', path: '', opaque: true }
    host = decoded
  }
  // Strip the version of Discord's `/api/v10/webhooks/…` to match `/api/webhooks` in the table.
  const path = normalizePath(m[2] ?? '').replace(/^\/api\/v\d+\//, '/api/')
  return { host: host.toLowerCase().replace(/\.+$/, ''), path, opaque: false }
}

/**
 * Decode `%XX` (ASCII range) in the path one at a time until it stops changing. Invalid sequences (`%ZZ`) and non-ASCII bytes are left as they are
 * and do not stop decoding the other valid `%XX` (even `/api/%77ebhooks%ZZ` is flattened to `webhooks`).
 */
function decodeAsciiEscapes(raw: string): string {
  let current = raw
  for (let round = 0; round < 8; round += 1) {
    const next = current.replace(/%([0-7][0-9a-f])/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    if (next === current) break
    current = next
  }
  return current
}

/** Normalize a URL path the way curl does: lowercase, decode `%XX` (until it stops changing), collapse `//` to one, and fold `.` and `..` segments. */
function normalizePath(raw: string): string {
  if (raw === '') return ''
  const decoded = decodeAsciiEscapes(raw).toLowerCase()
  const out: string[] = []
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}${decoded.endsWith('/') && out.length > 0 ? '/' : ''}`
}

function targetsChat(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg.startsWith('-') && !arg.startsWith('--url=')) return false
    const endpoint = endpointOf(arg)
    if (endpoint === null) return false
    if (endpoint.opaque) return true
    return CHAT_ENDPOINTS.some(
      (entry) =>
        (endpoint.host === entry.host || (entry.subdomains && endpoint.host.endsWith(`.${entry.host}`))) &&
        endpoint.path.startsWith(entry.path)
    )
  })
}

/** Prefix flags after `git` (`-C` / `-c` / `--git-dir` / `--work-tree`, which take a value, and other flags). */
const GIT_PREFIX =
  /\bgit((?:\s+(?:-[Cc]|--git-dir|--work-tree)(?:\s+|=)(?:"[^"]*"|'[^']*'|\\.|[^\s"';&|])+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*)/g
const PROTECTED_SPACE = '\u0001'

/**
 * TODO 1021: replace the spaces in a flag value such as `git -C "/a b" push` with a marker (U+0001) before stripping quotes. Stripping directly would shift the words
 * and miss `push`. The value stays one word and is skipped as a prefix flag. The shell's `-c`, as in `bash -c "git push"`, is not after `git`, so it is left alone.
 */
function protectGitPrefixSpaces(command: string): string {
  return command.replace(GIT_PREFIX, (whole: string) =>
    whole.replace(/"([^"]*)"|'([^']*)'|\\ /g, (_m: string, dq: string | undefined, sq: string | undefined) =>
      dq !== undefined || sq !== undefined ? (dq ?? sq ?? '').replace(/ /g, PROTECTED_SPACE) : PROTECTED_SPACE
    )
  )
}

/** TODO 1053: receivers that only read a heredoc body as data (`cat` / `tee` ...). */
export const HEREDOC_SINKS: ReadonlySet<string> = new Set(VOCABULARY.shell.heredocSinks)
/** TODO 1053: if one is in the same command, the body is not skipped (the written body could be run on the spot). */
const HEREDOC_RUNNERS: ReadonlySet<string> = new Set(VOCABULARY.shell.heredocRunners)
/** The head of a heredoc on the matching side (`<<EOF` / `<<-'EOF'` / `<< "EOF"`). `<<<` (here-string) is excluded by the caller. */
const HEREDOC_START = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z0-9_.-]+))/g

/** Whether the first word of a segment (with wrappers and `VAR=` stripped) could run a body. Also calls like `./x` / `*.sh`. */
function runsSomething(segment: string): boolean {
  const words = segment.split(' ').filter((word) => word !== '')
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    const name = basename(word)
    if (HEREDOC_RUNNERS.has(name) || word.startsWith('./') || name.endsWith('.sh')) return true
    // Strip wrappers (`sudo` / `env` / `time` ...) and look at the next word. Flags are skipped too (the value of a flag that takes a value is seen as a word, which only leans toward asking).
    if (WRAPPERS.has(name) || word.startsWith('-')) continue
    return false
  }
  return false
}

/**
 * TODO 1206: the standard output of `cat` is redirected to **one ordinary file** (`cat > /tmp/x.py <<'EOF'` / `cat <<'EOF' > f`). The body only becomes the contents of that file
 * and is not run on this line (even if wrapped in `$( … )` or `eval`, the output goes to the file).
 *
 * When in doubt, false (keep the body = the asking side). Only the heredoc's own simple command is looked at: before it, cut at `;` `|` `&&` `||` `(` `` ` `` `$(`, and also a lone `&` and
 * braces; after it, up to the next separator. If there is even one fd duplication (`>&` / `<&`) or process substitution (`>(` / `<(`) in it, false. True only when
 * there is exactly one redirect of standard output (`>` / `>>` / `1>` / `&>`) and its target is neither under `/dev/` nor empty (a form that goes back to `/dev/stdout` with a second `>`, and `> "a > b"`, are false too).
 * The receiver is only `cat` (the other `heredocSinks` do not always output the body itself, and `tee` also writes its arguments).
 */
/**
 * Forms for which `dropFileBound` is not used (6th security review). "The output goes to a file, so the body is not run on this line" breaks when the target is a symlink to `/dev/stdout` or a fifo
 * and something receives that output. If the command without the body has even one thing that could receive output (`$(`, backticks, `eval`,
 * process substitution, pipes, parentheses and braces) or something that could change what the target means (`cd` / `pushd` / `popd` / `ln` / `mkfifo` / `mknod` / `exec` / `source`),
 * return to the behavior before the wave (keep the body). Words are looked at after quotes are removed, and it also returns when there is a backslash (`\\cd`) or a lone `&` that runs in the background (`&&` is different). 8th round: if there is even one `$`, return (forms like `$'…'` and empty expansions that corrupt a word), and words match even with a path (`/bin/ln`)
 * (7th round: a slip through the word table). What remains is the flat form "write to a file and run it in another statement".
 */
const FILE_BOUND_UNSAFE = /\$|`|\\|[<>]\(|\||[(){}]|(?<![>&])&(?![>&])|(?:^|[\s;&])(?:[^\s;&]*\/)?(?:eval|cd|pushd|popd|ln|mkfifo|mknod|exec|source|\.)(?=$|[\s;&])/

function heredocFileBound(head: string, before: string, after: string): boolean {
  if (head !== 'cat') return false
  const own = before.split(/(?<![>&])&(?!>)|[{}]/).pop() ?? ''
  const rest = after.split(/[;|)`}]|(?<![>&])&(?![>&])/)[0] ?? ''
  const statement = `${own} ${rest}`
  // List only the forms we allow (5th security review). With quotes, `#`, backslashes, variables or substitutions we cannot say which `>` is a real operator, so false.
  // The fd is only none / 1 / & (standard output) and 2 (standard error); any other number (`01>` etc.) is false.
  if (/["'#\\$`]/.test(statement) || /[<>]\(|[<>]&|<>/.test(statement)) return false
  let stdout = 0
  for (const match of statement.matchAll(/(\d*|&)>{1,2}\|?[ \t]*(\S*)/g)) {
    const fd = match[1] ?? ''
    const target = match[2] ?? ''
    if (fd === '2') continue
    if (fd !== '' && fd !== '1' && fd !== '&') return false
    // The target is a path of only safe characters. Anything containing `..` or `//`, and `/dev/` or `/proc/`, is false (`/tmp/../dev/stdout`, `//dev/stdout`).
    if (!/^(?:~\/)?[A-Za-z0-9_.+/-]+$/.test(target)) return false
    if (target.includes('..') || target.includes('//') || /^\/(?:dev|proc)(?:\/|$)/.test(target)) return false
    stdout += 1
  }
  return stdout === 1
}

/**
 * TODO 1053 (owner decision 2026-10-29): before the matching side (`shellSegments`), drop the bodies of heredocs whose **receiver only reads them as data** (`HEREDOC_SINKS`)
 * (a string `git push` in the body of `cat > f <<'EOF'` alone does not match). If the receiver is `bash` / `python` /
 * `xargs` / `ssh` etc., the body may be executed, so it is kept (the body lines are matched as before). It is also kept (leaning toward asking) when:
 * there is a pipe after the receiver (`cat <<EOF | sh`), there is no terminator line, or some segment of the same command could run the body (`runsSomething`).
 *
 * `dropFileBound` (TODO 1206, used only by the persistence judgment): a body whose receiver `cat` has its standard output redirected to one ordinary file (`heredocFileBound`) is dropped even when the same command could run something
 * (`python3 /tmp/x.py` after `cat > /tmp/x.py <<'EOF' … EOF`). The route of running a written file later has the same limit as writing with Write and running (1044 / 1056).
 */
export function dropDataHeredocBodies(command: string, options: { readonly dropFileBound?: boolean } = {}): string {
  if (!command.includes('<<')) return command
  const lines = command.split('\n')
  /** The result with every droppable body dropped. */
  const out: string[] = []
  /** The result with only the `dropFileBound` bodies dropped (returned when the same command could run something). */
  const kept: string[] = []
  let dropped = false
  let droppedFileBound = false
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    out.push(line)
    kept.push(line)
    index += 1
    const heredocs: { delimiter: string; stripTabs: boolean; sink: boolean; fileBound: boolean }[] = []
    for (const match of line.matchAll(HEREDOC_START)) {
      const at = match.index ?? 0
      if (line[at - 1] === '<' || line[at + 2] === '<') continue
      const before = line.slice(0, at).split(/\|\||&&|[;|(`]|\$\(/).pop() ?? ''
      const head = commandWords(before.replace(/["']/g, ' '))[0]
      const after = line.slice(at + match[0].length)
      const piped = /(^|[^|])\|(?!\|)/.test(after)
      const sink = head !== undefined && HEREDOC_SINKS.has(basename(head)) && !piped
      heredocs.push({
        delimiter: match[2] ?? match[3] ?? match[4] ?? '',
        stripTabs: match[1] === '-',
        sink,
        fileBound: sink && options.dropFileBound === true && head !== undefined && heredocFileBound(basename(head), before, after)
      })
    }
    for (const heredoc of heredocs) {
      const body: string[] = []
      let closed = false
      while (index < lines.length) {
        const bodyLine = lines[index] ?? ''
        index += 1
        if ((heredoc.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine) === heredoc.delimiter) {
          closed = true
          break
        }
        body.push(bodyLine)
      }
      // A body without a terminator is not dropped (we cannot tell where the data ends).
      if (!closed || !heredoc.sink) {
        out.push(...body)
        kept.push(...body)
        if (closed) {
          out.push(heredoc.delimiter)
          kept.push(heredoc.delimiter)
        }
        continue
      }
      dropped = true
      if (heredoc.fileBound) droppedFileBound = true
      else kept.push(...body, heredoc.delimiter)
    }
  }
  if (!dropped) return command
  const rest = out.join('\n')
  const segments = splitCommand(rest.replace(/["']/g, ' ').replace(/\$\(|[`(){}]/g, ' ; ').replace(/(?<![&>|])&(?![&>])/g, ' ; '))
  if (!segments.some((segment) => runsSomething(segment.text))) return rest
  return droppedFileBound && !FILE_BOUND_UNSAFE.test(rest.replace(/["']/g, '')) ? kept.join('\n') : command
}

/**
 * TODO 1077 (a fix from the review): apply `edit` only to the body lines of heredocs whose **receiver could run the body** (`runsSomething`: `python3` / `node` / `sh` ..., wrappers, `./x`),
 * and return the rest as is. It is not applied outside the body (the head line and the following commands). `<<<` (here-string) is not a heredoc, so it is not looked at.
 * A head like `1 << 2` is also not applied if no terminator line is found (we cannot tell where the body ends).
 */
export function editRunnerHeredocBodies(command: string, edit: (line: string) => string): string {
  if (!command.includes('<<')) return command
  const lines = command.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    out.push(line)
    index += 1
    const heredocs: { delimiter: string; stripTabs: boolean; runner: boolean }[] = []
    for (const match of line.matchAll(HEREDOC_START)) {
      const at = match.index ?? 0
      if (line[at - 1] === '<' || line[at + 2] === '<') continue
      const before = line.slice(0, at).split(/\|\||&&|[;|(`]|\$\(/).pop() ?? ''
      heredocs.push({
        delimiter: match[2] ?? match[3] ?? match[4] ?? '',
        stripTabs: match[1] === '-',
        runner: runsSomething(before.replace(/["']/g, ' '))
      })
    }
    for (const heredoc of heredocs) {
      const body: string[] = []
      let closed = false
      while (index < lines.length) {
        const bodyLine = lines[index] ?? ''
        index += 1
        if ((heredoc.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine) === heredoc.delimiter) {
          closed = true
          break
        }
        body.push(bodyLine)
      }
      out.push(...(closed && heredoc.runner ? body.map(edit) : body))
      if (closed) out.push(lines[index - 1] ?? heredoc.delimiter)
    }
  }
  return out.join('\n')
}

/**
 * Convert quotes, subshells and `&` into separators, then split with `splitCommand`. The inside of quotes is looked at too
 * (so `bash -c "curl -d …"` is not missed) - as a result `echo "a; curl -d x"` also matches, but we lean toward the sending side.
 */
export function shellSegments(command: string): readonly string[] {
  return shellSegmentsOf(dropDataHeredocBodies(command))
}

/** The stage of `shellSegments` after the heredoc bodies have been dropped. */
function shellSegmentsOf(text: string): readonly string[] {
  const flattened = protectGitPrefixSpaces(text.replace(/\\\n/g, ' '))
    .replace(/["']/g, ' ')
    .replace(/\$\(|[`(){}]/g, ' ; ')
    .replace(/(?<![&>|])&(?![&>])/g, ' ; ')
  return splitCommand(flattened).map((segment) => segment.text)
}

export function basename(word: string): string {
  const slash = word.lastIndexOf('/')
  return slash >= 0 ? word.slice(slash + 1) : word
}

/** The sequence of words from the head of a segment with wrappers (`sudo` / `env A=1` / `bash -c`) and variable assignments stripped. */
export function commandWords(segment: string): readonly string[] {
  const words = segment.split(' ').filter((word) => word !== '')
  let at = 0
  while (at < words.length) {
    const word = words[at] ?? ''
    const name = basename(word)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at += 1
      continue
    }
    if (WRAPPERS.has(name)) {
      at += 1
      // Flags of wrappers (`sudo -u x`, `xargs -n 1`) are skipped together with their values.
      const valueFlags = WRAPPER_VALUE_FLAGS[name]
      while (at < words.length && (words[at] ?? '').startsWith('-')) {
        at += valueFlags?.has(words[at] ?? '') === true ? 2 : 1
      }
      continue
    }
    if (SHELLS.has(name) && words[at + 1] !== undefined && /^-[a-z]*c[a-z]*$/.test(words[at + 1] ?? '')) {
      at += 2
      continue
    }
    break
  }
  return words.slice(at)
}

/** Whether one segment sends something out. Returns the name of the pattern that matched. */
function matchSegment(segment: string, chatTarget: boolean): string | null {
  const words = commandWords(segment)
  const head = words[0]
  if (head === undefined) return null
  const name = basename(head)
  const args = words.slice(1)
  // TODO 1191: generic curl / wget / httpie are not asked about. If the destination is a chat webhook / API (`chatEndpoints`), ask whatever the method
  // (review X-1: Slack's Web API can post even with a GET query).
  if (name === 'curl') return chatTarget ? 'chat-webhook' : null
  if (name === 'wget') return chatTarget ? 'chat-webhook' : null
  if (name === 'http' || name === 'https' || name === 'xh' || name === 'xhs') return chatTarget ? 'chat-webhook' : null
  if (name === 'osascript') {
    return OSASCRIPT_SEND.test(args.join(' ')) ? 'osascript-send' : null
  }
  if (MAIL_COMMANDS.has(name)) return 'mail'
  return null
}

/**
 * Whether a shell command sends something out. Returns the name of the pattern that matched (`chat-webhook` / `osascript-send` / `mail`).
 * It returns a name rather than a boolean to leave "what stopped it" in the audit log (no values are put in).
 */
export function matchOutboundCommand(command: string): string | null {
  // TODO 1169 (owner decision 2026-11-07): the body of a data heredoc (`heredocSinks`) is not matched even if `make` / `npm run` / `$(cat f)` follows it.
  const text = dropDataHeredocBodies(command)
  // The destination URL can come after the JSON body (`-d '{…}'`), and `{` splits the segment, so look at the words of the whole command rather than the segment.
  const chatTarget = targetsChat(text.split(/\s+/).map((word) => word.replace(/^[\s"'`(]+|[\s"'`);]+$/g, '')))
  for (const segment of shellSegmentsOf(text)) {
    const hit = matchSegment(segment, chatTarget)
    if (hit !== null) return hit
  }
  return null
}

// ---- Narrow lexical analysis (the side that lets things pass. Made in TODO 1013 and used by the quiet standard commands of 1031 (`quiet.ts`)) ----

export type ShellOp = '' | ';' | '&&' | '||' | '|'

export interface ShellSegment {
  /** The preceding operator ('' for the first). */
  readonly op: ShellOp
  readonly words: readonly string[]
  /** Whether there was a redirect to a file (`>` / `>>` / `&>` ...). fd duplication (`2>&1`) is not counted. */
  readonly redirected: boolean
  /**
   * TODO 1053: whether there was heredoc input (`<<'EOF'` ...). The body has been skipped. Whether the receiver could run the body
   * (`bash <<EOF`) is not decided at the lexical stage; the user looks at the first word (`isHeredocSink`).
   */
  readonly heredoc: boolean
}

/**
 * TODO 1053: whether the receiver of a segment with a heredoc only reads it as data (`HEREDOC_SINKS`; a `VAR=` prefix is skipped).
 * A segment without a heredoc is true. Wrappers such as `sudo tee` are false (the asking side).
 */
export function isHeredocSink(segment: ShellSegment): boolean {
  if (!segment.heredoc) return true
  const head = segment.words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  return head !== undefined && HEREDOC_SINKS.has(head)
}

interface PendingHeredoc {
  readonly delimiter: string
  /** If quoted (`<<'EOF'` / `<<"EOF"`), the body is not expanded. */
  readonly quoted: boolean
  /** `<<-`: strip the leading tabs of the body and the terminator line. */
  readonly stripTabs: boolean
}

/**
 * Read the delimiter word after `<<` (`from` is right after `<<`): `-` (`<<-`), whitespace, `'EOF'` / `"EOF"` / `EOF` (combinations are fine).
 * Null if it cannot be read (a delimiter word containing `$` / `\` / a backtick, or an empty delimiter word).
 */
function readHeredocDelimiter(command: string, from: number): { heredoc: PendingHeredoc; end: number } | null {
  let at = from
  const stripTabs = command[at] === '-'
  if (stripTabs) at += 1
  while (command[at] === ' ' || command[at] === '\t') at += 1
  let delimiter = ''
  let quoted = false
  while (at < command.length) {
    const ch = command[at] ?? ''
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, at + 1)
      if (close < 0) return null
      const body = command.slice(at + 1, close)
      if (body.includes('\n') || (ch === '"' && /[$`\\]/.test(body))) return null
      delimiter += body
      quoted = true
      at = close + 1
      continue
    }
    if (/[A-Za-z0-9_.-]/.test(ch)) {
      delimiter += ch
      at += 1
      continue
    }
    if (/[\s;&|<>()]/.test(ch)) break
    return null
  }
  if (delimiter === '') return null
  return { heredoc: { delimiter, quoted, stripTabs }, end: at }
}

/**
 * Skip heredoc bodies in order from `from` (the start of the first line of the body) and return the position after the last terminator line.
 * -1 if there is no terminator line or an unquoted body has an expansion (`$` / backtick / `\`).
 */
function skipHeredocBodies(command: string, from: number, heredocs: readonly PendingHeredoc[]): number {
  let at = from
  for (const heredoc of heredocs) {
    for (;;) {
      if (at > command.length) return -1
      const newline = command.indexOf('\n', at)
      const end = newline < 0 ? command.length : newline
      const line = command.slice(at, end)
      at = end + 1
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break
      if (!heredoc.quoted && /[$`\\]/.test(line)) return -1
      if (newline < 0) return -1
    }
  }
  return Math.min(at, command.length)
}

/**
 * A **narrow** lexical split to decide whether an allow list may be applied. Unlike `shellSegments` (the matching side, coarse is fine),
 * misreading means passing through, so it accepts only forms that can be read for certain, and everything else is null (= ask):
 * only quotes (`'…'`, and `"…"` that does not contain `$` / backtick / `\`), `;` / `&&` / `||` / `|` / newline, and output
 * redirects (`>` / `>>` / `2>&1` / `&>` ..., the redirect target is discarded). `$` (variables, substitution), backticks, parentheses,
 * braces, `\`, `&` (background), `<` (input), `<<<`, globs (`*?[]`), `!`, and a leading `#` / `=` / `~user` are null.
 *
 * TODO 1053 (owner decision 2026-10-29): heredocs (`<<'EOF'` / `<<"EOF"` / `<<EOF`, also `<<-`) are accepted. The body is skipped up to the terminator line,
 * and `heredoc` is set on that segment. An unquoted `<<EOF` is accepted only when the body has no expansion (`$` / backtick / `\`)
 * (otherwise null). Whether the receiver could run the body (`bash <<EOF`) is looked at by the user with `isHeredocSink`.
 */
export interface StrictLexOptions {
  /**
   * TODO 1031: accept a glob (`*?[]`) inside a word as an ordinary character (only for reads in the quiet standard commands). Even when expanded it only becomes the
   * file names of arguments, so unless it is in the command name (the first word) the judgment does not change - the caller looks at the first word.
   */
  readonly glob?: boolean
  /** TODO 1031: accept the input redirect `< file` (not the heredoc `<<` or process substitution `<(`). */
  readonly input?: boolean
}

export function strictShellSegments(command: string, options: StrictLexOptions = {}): readonly ShellSegment[] | null {
  const segments: ShellSegment[] = []
  let words: string[] = []
  let word: string | null = null
  let op: ShellOp = ''
  let redirected = false
  let heredoc = false
  /** Heredocs that started on this line. The body follows the next newline (outside quotes). */
  let heredocs: PendingHeredoc[] = []
  const endWord = (): void => {
    if (word !== null) words.push(word)
    word = null
  }
  const endSegment = (next: ShellOp): boolean => {
    endWord()
    if (words.length === 0) {
      // An empty segment is allowed only as a run of `;` / newlines (blank lines, a trailing `;`). `&& &&`, `| ;`, a leading `|` and the like are not read.
      if ((next !== '' && next !== ';') || (op !== '' && op !== ';')) return false
    } else {
      segments.push({ op, words, redirected, heredoc })
    }
    words = []
    redirected = false
    heredoc = false
    op = next
    return true
  }
  /** Skip the word of a redirect target. -1 if it cannot be read. */
  const skipTarget = (from: number): number => {
    let at = from
    while (command[at] === ' ' || command[at] === '\t') at += 1
    const start = at
    while (at < command.length && !/[\s;&|<>()'"`$\\{}*?[\]!#]/.test(command[at] ?? '')) at += 1
    return at === start ? -1 : at
  }
  let i = 0
  while (i < command.length) {
    const ch = command[i] ?? ''
    if (ch === ' ' || ch === '\t') {
      endWord()
      i += 1
      continue
    }
    if (ch === '\n') {
      if (!endSegment(';')) return null
      i += 1
      if (heredocs.length > 0) {
        const next = skipHeredocBodies(command, i, heredocs)
        if (next < 0) return null
        heredocs = []
        i = next
      }
      continue
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1)
      if (close < 0) return null
      word = (word ?? '') + command.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (ch === '"') {
      const close = command.indexOf('"', i + 1)
      if (close < 0) return null
      const body = command.slice(i + 1, close)
      if (/[$`\\!]/.test(body)) return null
      word = (word ?? '') + body
      i = close + 1
      continue
    }
    if (ch === ';') {
      if (command[i + 1] === ';' || !endSegment(';')) return null
      i += 1
      continue
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        if (!endSegment('&&')) return null
        i += 2
        continue
      }
      if (command[i + 1] === '>') {
        // `&>` / `&>>`: redirect both.
        endWord()
        let at = i + 2
        if (command[at] === '>') at += 1
        const end = skipTarget(at)
        if (end < 0) return null
        redirected = true
        i = end
        continue
      }
      return null
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        if (!endSegment('||')) return null
        i += 2
        continue
      }
      if (command[i + 1] === '&') return null
      if (!endSegment('|')) return null
      i += 1
      continue
    }
    if (ch === '>') {
      // The fd digit of `2>` is part of the redirect (not a word).
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      let at = i + 1
      if (command[at] === '>' || command[at] === '|') at += 1
      if (command[at] === '(') return null
      if (command[at] === '&') {
        at += 1
        const start = at
        while (/[0-9]/.test(command[at] ?? '')) at += 1
        if (command[at] === '-') at += 1
        if (at === start) return null
        i = at
        continue
      }
      const end = skipTarget(at)
      if (end < 0) return null
      redirected = true
      i = end
      continue
    }
    if (ch === '<' && command[i + 1] === '<') {
      // TODO 1053: heredoc. `<<<` (here-string) is not read.
      if (command[i + 2] === '<') return null
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      const parsed = readHeredocDelimiter(command, i + 2)
      if (parsed === null) return null
      heredocs.push(parsed.heredoc)
      heredoc = true
      i = parsed.end
      continue
    }
    if (ch === '<' && options.input === true) {
      if (command[i + 1] === '(') return null
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      const end = skipTarget(i + 1)
      if (end < 0) return null
      i = end
      continue
    }
    if (options.glob === true && /[*?[\]]/.test(ch)) {
      word = (word ?? '') + ch
      i += 1
      continue
    }
    if (/[<()`$\\{}*?[\]!]/.test(ch)) return null
    if (word === null && (ch === '#' || ch === '=')) return null
    if (word === null && ch === '~') {
      const next = command[i + 1] ?? ''
      if (next !== '' && next !== '/' && !/[\s;&|>]/.test(next)) return null
    }
    word = (word ?? '') + ch
    i += 1
  }
  // A heredoc without a body (no newline at the end) is not read.
  if (heredocs.length > 0 || !endSegment('')) return null
  return segments
}

/**
 * The forms accepted as the value of `git -C <dir>`. git does not look at CDPATH, so a name relative to a previous absolute path is fine. Anything starting with `~` is
 * not accepted (inside quotes `~` is not expanded, outside it is; the lexical stage cannot tell them apart, so we lean toward asking).
 */
function isGitDirArg(arg: string): boolean {
  return arg !== '' && !arg.startsWith('-') && !arg.startsWith('~')
}

/** The form accepted as a remote name. Anything with `/` or `:` (a URL or a path written directly) is not accepted. */
const PUSH_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Flags of `git push` accepted as an ordinary push. **Every flag not here is asked about** (force, delete, mirror, all ...). */
const PLAIN_PUSH_LONG_FLAGS: ReadonlySet<string> = new Set([
  '--quiet',
  '--verbose',
  '--set-upstream',
  '--dry-run',
  '--porcelain',
  '--progress',
  '--no-progress',
  '--follow-tags',
  '--no-verify',
  '--verify',
  '--atomic'
])
/** Characters allowed in a bundle of short flags (`-qu`). `-f` / `-d` are not allowed. */
const PLAIN_PUSH_SHORT_FLAGS = /^-[qvun]+$/
/** The form accepted as a refspec. Anything starting with `+` (force) or `:` (delete), and `*` (glob), is not accepted. */
const PLAIN_REFSPEC = /^[A-Za-z0-9_./~^@-][A-Za-z0-9_./~^@-]*(?::[A-Za-z0-9_./~^@-]+)?$/

/** If the words after `git` are an ordinary push, return its form. 'other' if it is not a push, null if it is a push but not an ordinary one. */
export function parsePushWords(args: readonly string[]): { dirs: string[]; remote: string | null } | 'other' | null {
  const dirs: string[] = []
  let at = 0
  while (at < args.length) {
    const arg = args[at] ?? ''
    if (arg === '-C') {
      const dir = args[at + 1]
      if (dir === undefined || !isGitDirArg(dir)) return null
      dirs.push(dir)
      at += 2
      continue
    }
    if (arg === '--no-pager') {
      at += 1
      continue
    }
    if (arg.startsWith('-')) return 'other'
    break
  }
  if (args[at] !== 'push') return 'other'
  const positional: string[] = []
  let endOfFlags = false
  for (const arg of args.slice(at + 1)) {
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg.startsWith('-')) {
      if (PLAIN_PUSH_LONG_FLAGS.has(arg) || PLAIN_PUSH_SHORT_FLAGS.test(arg)) continue
      return null
    }
    positional.push(arg)
  }
  const remote = positional[0] ?? null
  if (remote !== null && !PUSH_REMOTE_NAME.test(remote)) return null
  for (const refspec of positional.slice(1)) {
    if (!PLAIN_REFSPEC.test(refspec) || refspec.endsWith(':')) return null
  }
  return { dirs, remote }
}

// ---- Contents to display ----

const TO_KEYS: readonly string[] = VOCABULARY.display.to
const SUBJECT_KEYS: readonly string[] = VOCABULARY.display.subject
const BODY_KEYS: readonly string[] = VOCABULARY.display.body

function clip(text: string): string {
  return text.length > MAX_OUTBOUND_TEXT ? `${text.slice(0, MAX_OUTBOUND_TEXT)}…` : text
}

/** A destination value as one line. A string, a number, an array of strings, or an array of `{email}` / `{name}`. */
function addressText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((entry) => {
      if (typeof entry === 'string') return entry
      if (typeof entry === 'object' && entry !== null) {
        const record = entry as Record<string, unknown>
        for (const key of ['email', 'address', 'name', 'id']) {
          if (typeof record[key] === 'string') return record[key]
        }
      }
      return null
    })
    const kept = parts.filter((part): part is string => part !== null && part !== '')
    return kept.length === 0 ? null : kept.join(', ')
  }
  return null
}

function fieldsOf(input: unknown): { to: string | null; subject: string | null; body: string | null } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { to: null, subject: null, body: null }
  const record = input as Record<string, unknown>
  const to: string[] = []
  for (const key of TO_KEYS) {
    const text = addressText(record[key])
    if (text !== null) to.push(key === 'to' || key === 'recipient' || key === 'recipients' ? text : `${key}: ${text}`)
  }
  let subject: string | null = null
  for (const key of SUBJECT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      subject = clip(value)
      break
    }
  }
  let body: string | null = null
  for (const key of BODY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      body = clip(value)
      break
    }
  }
  return { to: to.length === 0 ? null : clip(to.join(', ')), subject, body }
}

/**
 * If an approval request is an operation that sends something out, return its contents; otherwise null.
 *
 * - Shell tools: look at the command with `matchOutboundCommand`.
 * - MCP tools (`<prefix><server><separator><tool>`): a match if in `table.tools`, no match if in `table.readOnlyTools`,
 *   otherwise judged by the words of the tool name (`matchOutboundToolName`). **aios's own gateway tools are not looked at** -
 *   the relay stage asks every time for a plugin's tools with side effects (7.6.7, `alwaysAsk`). We do not ask twice.
 * - Anything else (built-in reads and writes, Web fetch) is no match.
 */
export function classifyOutbound(table: OutboundTable, toolName: string, input: unknown): OutboundDetail | null {
  if (table.shellTools.includes(toolName)) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
    const command = (input as Record<string, unknown>)[table.commandField]
    if (typeof command !== 'string' || command.trim() === '') return null
    const match = matchOutboundCommand(command)
    return match === null ? null : { channel: 'shell', match, to: null, subject: null, body: null, command: clip(command) }
  }
  if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) return null
  if (table.readOnlyTools.includes(toolName)) return null
  let match: string | null = null
  if (table.tools.includes(toolName)) match = 'listed'
  else if (table.mcpPrefix !== '' && toolName.startsWith(table.mcpPrefix)) {
    const rest = toolName.slice(table.mcpPrefix.length)
    const cut = rest.indexOf(table.mcpSeparator)
    if (cut < 0) return null
    match = matchOutboundToolName(rest.slice(cut + table.mcpSeparator.length))
  }
  if (match === null) return null
  return { channel: 'tool', match, ...fieldsOf(input), command: null }
}
