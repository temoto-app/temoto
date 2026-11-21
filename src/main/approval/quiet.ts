/**
 * Quiet standard commands (TODO 1031, owner decision 2026-10-28, ARCHITECTURE 4.2.1 "quiet standard commands").
 *
 * Only when **every segment** of a Bash command is in the table (`quiet` in `compat/outbound.json`) does the Broker pass it without asking, even in strict mode and
 * in the outbound judgment (959) (anything matching a stop pattern does not pass). If even one stage is outside, the behavior is as before.
 *
 * This file is **pure functions only**. For reading it uses the narrow lexical analysis of `outbound.ts` (`strictShellSegments`, the same as the `git push` allow list), widened only for
 * globs and input redirects. Forms that cannot be read for certain (`$`, command substitution, parentheses, braces, `\`, `&`, here-strings ...) are
 * all "not in the table" (= the asking side). A heredoc is accepted only when the receiver merely reads it as data (`cat` / `tee` ..., `HEREDOC_SINKS`) (TODO 1053). **Coarse is fine for the matching side (959), but this is the passing side** - misreading passes straight through, so
 * when in doubt, leave it out.
 *
 * - A command name must be a plain name only (names with a path such as `./x` / `/usr/bin/x`, or containing a glob, are out).
 * - A `VAR=value` prefix is out if the variable could change the command that runs or where git points (`GIT_*` / `PATH` / `*PAGER` ..., `envDeny*` in the table).
 *   A segment of only assignments (`PATH=x; ls`) is out too.
 * - For `xargs` / `env` / `time` / `nice` the inner command, and for `sh -c` / `bash -c` / `zsh -c` the inner string, is looked at with the same table
 *   (it is out if there is `rm -rf` or a force push inside). The inside of `python -c` / `node -e` is not looked at and passes (owner decision).
 * - `git push` uses the reading of an "ordinary push" in `outbound.ts` (`parsePushWords`) as it is.
 * - `chmod` (`localPaths`) is out when the same command or an outer one has `cd` / `pushd` / `popd` / `ln`, and when it is the inner command of `xargs` (review 56-5).
 * - **TODO 1029**: `ssh` / `scp` / `sftp` / `rsync` collect and return the destination hosts (`host` / `user@host`), and the caller matches them against the setting
 *   "hosts not to ask about" (`src/shared/ssh-hosts.ts`). Flags are only those in the table (`quiet.transfers`) - flags that can insert another command or another destination, such as `-o` / `-F` / `-J` /
 *   rsync's `-e`, are out. The remote command of `ssh host <command>` is not looked at (inside a box we trust).
 */
import { normalizeSshHost, sshHostAllowed } from '@shared/ssh-hosts.js'
import { loadOutboundVocabulary, type QuietRule, type TransferRule } from './outbound-vocabulary.js'
import { MAX_OUTBOUND_TEXT, isHeredocSink, parsePushWords, strictShellSegments } from './outbound.js'

const VOCABULARY = loadOutboundVocabulary()
const QUIET = VOCABULARY.quiet
/** Flags that take a value, such as `npm --prefix x run` (the same table as the publish judgment). */
const SUBCOMMAND_VALUE_FLAGS: ReadonlySet<string> = new Set(VOCABULARY.shell.publisherValueFlags)
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set()
/** Upper limit of nesting depth such as `bash -c "xargs sh -c '…'"`. */
const MAX_DEPTH = 4
/** A plain command name. Anything with a path, glob or symbol is out. */
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/

/** Look up from the table (without picking up inherited names such as `constructor`). */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

/** The hosts a command in the table connects to (`host` / `user@host`, normalized, no duplicates). Empty if it connects to nothing. */
export interface QuietPlan {
  readonly hosts: readonly string[]
}

/** The result for a segment. null = not in the table (the asking side), an array = in the table (the hosts needed). */
type Hosts = readonly string[] | null
const NONE: readonly string[] = []

/**
 * The context for reading a segment (review 56-5). The `localPaths` rule (`chmod`) looks at a "relative path that appears to be inside the working folder" by its literal form,
 * so it is out when the literal form and the real location can differ (`cd ~/.ssh && chmod 777 id_rsa`, `ln -s ~/.ssh/id_rsa x && chmod 777 x`,
 * `find … | xargs chmod 777 x`).
 */
interface Context {
  readonly depth: number
  /** The same command (or an outer one) has the word `cd` / `pushd` / `ln`. */
  readonly pathsShifted: boolean
  /** The inner command of `xargs` (paths are added from standard input). */
  readonly viaXargs: boolean
}

/** Words that can change what the working folder or a relative path points to. The position of the word does not matter (`echo cd` also matches, but that only leans toward asking). */
const PATH_SHIFTERS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'ln'])

/** If the whole command is made only of quiet standard commands, where it connects to. Null if not in the table. */
export function quietPlan(command: string): QuietPlan | null {
  const hosts = quietAt(command, { depth: 0, pathsShifted: false, viaXargs: false })
  return hosts === null ? null : { hosts }
}

/** Whether the whole command is made only of quiet standard commands and all its destinations are in `allowedHosts` (hosts not asked about). */
export function isQuietCommand(command: string, allowedHosts: readonly string[] = []): boolean {
  const plan = quietPlan(command)
  return plan !== null && plan.hosts.every((host) => sshHostAllowed(host, allowedHosts))
}

function merge(into: string[], hosts: readonly string[]): void {
  for (const host of hosts) if (!into.includes(host)) into.push(host)
}

function quietAt(command: string, outer: Context): Hosts {
  if (outer.depth > MAX_DEPTH || command.length > MAX_OUTBOUND_TEXT || command.trim() === '') return null
  const segments = strictShellSegments(command, { glob: true, input: true })
  if (segments === null || segments.length === 0) return null
  const ctx: Context = {
    ...outer,
    pathsShifted: outer.pathsShifted || segments.some((segment) => segment.words.some((word) => PATH_SHIFTERS.has(word)))
  }
  const hosts: string[] = []
  for (const segment of segments) {
    // TODO 1053: a heredoc only when the receiver merely reads it as data (`cat > f <<'EOF'`). `bash <<EOF` / `python <<EOF` are on the asking side.
    if (!isHeredocSink(segment)) return null
    const got = wordsHosts(segment.words, ctx)
    if (got === null) return null
    merge(hosts, got)
  }
  return hosts
}

function envAllowed(name: string): boolean {
  if (QUIET.envDenyNames.includes(name)) return false
  if (QUIET.envDenyPrefixes.some((prefix) => name.startsWith(prefix))) return false
  return !QUIET.envDenySuffixes.some((suffix) => name.endsWith(suffix))
}

/** Whether the word sequence of one segment (including prefix assignments) is in the table. If so, where it connects to. */
function wordsHosts(words: readonly string[], ctx: Context): Hosts {
  let at = 0
  while (at < words.length) {
    const assignment = ASSIGNMENT.exec(words[at] ?? '')
    if (assignment === null) break
    if (!envAllowed(assignment[1] ?? '')) return null
    at += 1
  }
  // A segment of only assignments can change the environment of the following segments (`PATH=…; ls`).
  const head = words[at]
  if (head === undefined || !COMMAND_NAME.test(head)) return null
  const args = words.slice(at + 1)
  if (QUIET.shells.includes(head)) return shellHosts(args, ctx)
  const wrapperFlags = own(QUIET.wrappers, head)
  if (wrapperFlags !== undefined) return wrapperHosts(head, args, new Set(wrapperFlags), ctx)
  const transfer = own(QUIET.transfers, head)
  if (transfer !== undefined) return transferHosts(head, transfer, args)
  if (head === 'git') return gitQuiet(args) ? NONE : null
  const rule = own(QUIET.commands, head)
  if (rule === undefined) return null
  // Review 56-5: a rule that looks at the literal form of a path is out in a context where the literal form and the real location can differ.
  if (rule !== 'any' && rule.localPaths === true && (ctx.pathsShifted || ctx.viaXargs)) return null
  // GNU long flags also accept a unique prefix abbreviation (`sort --compress-p`, `tar --use-comp`), so forbidden flags are matched against abbreviations too (review 56-3).
  return ruleAllows(rule, args, SUBCOMMAND_VALUE_FLAGS, true) ? NONE : null
}

/** `sh -c "<contents>"`. Only a bundle of flags that includes `-c` (`-lc`) is accepted, and the contents are looked at with the same table. */
function shellHosts(args: readonly string[], ctx: Context): Hosts {
  const flag = args[0] ?? ''
  const script = args[1]
  if (!/^-[a-z]*c[a-z]*$/.test(flag) || script === undefined) return null
  return quietAt(script, { ...ctx, depth: ctx.depth + 1 })
}

/** `xargs [flags] cmd …` / `env [-i] [A=1] cmd …` / `time cmd` / `nice -n 5 cmd`. With no inner command (xargs runs echo, env lists) it passes. */
function wrapperHosts(name: string, args: readonly string[], valueFlags: ReadonlySet<string>, ctx: Context): Hosts {
  let at = 0
  while (at < args.length) {
    const arg = args[at] ?? ''
    if (!arg.startsWith('-') || arg === '-') break
    if (arg === '--') {
      at += 1
      break
    }
    // `env -S` (splits a string and runs it) and `env -P` (where to search) are not read. For env only `-i` / `-u NAME`.
    if (name === 'env' && arg !== '-i' && arg !== '-u' && arg !== '--ignore-environment') return null
    at += valueFlags.has(arg) ? 2 : 1
  }
  const rest = args.slice(at)
  if (rest.length === 0) return NONE
  if (ctx.depth + 1 > MAX_DEPTH) return null
  return wordsHosts(rest, { ...ctx, depth: ctx.depth + 1, viaXargs: ctx.viaXargs || name === 'xargs' })
}

// ---- Commands that connect to another host (TODO 1029) ----

/** The remote form `[user@]host:path` of `scp` / `rsync` (also rsync's `host::module`). If `/` comes before `:`, it is a local path. */
const REMOTE_PATH = /^(?:([^@/:\s]+)@)?([^@/:\s[\]]+|\[[0-9A-Fa-f:.]+\]):/
/** `[user@]host[:port]` of `ssh://` / `scp://` / `sftp://` / `rsync://`. */
const REMOTE_URL = /^(?:ssh|scp|sftp|rsync):\/\/(?:([^@/:\s]+)@)?([^@/:\s[\]]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?(?:\/|$)/

/** Build the matching form (`user@host` / `host`) from a user and host. Null if it cannot be read. */
function target(user: string | undefined | null, host: string): string | null {
  return normalizeSshHost(user === undefined || user === null || user === '' ? host : `${user}@${host}`)
}

function userHost(text: string): string | null {
  const at = text.lastIndexOf('@')
  return at >= 0 ? target(text.slice(0, at), text.slice(at + 1)) : target(null, text)
}

/** One positional argument of `scp` / `rsync`. If remote, its destination; if local, ''; if unreadable, null. */
function remoteOf(arg: string): string | null {
  const url = REMOTE_URL.exec(arg)
  if (url !== null) return target(url[1], url[2] ?? '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return null
  const spec = REMOTE_PATH.exec(arg)
  if (spec === null) return ''
  return target(spec[1], spec[2] ?? '')
}

/**
 * Where `ssh` / `scp` / `sftp` / `rsync` connect to. Only flags in the table (`flags` / `valueFlags` / `forbid`) are accepted.
 * For ssh the first positional argument is the destination and what follows is the remote command (not looked at). But a word right after the destination that starts with `-` is out, because OpenSSH
 * reads it again as a flag.
 */
function transferHosts(name: string, rule: TransferRule, args: readonly string[]): Hosts {
  const valueFlags = new Set(rule.valueFlags)
  const positional: string[] = []
  /** ssh's `-l <user>`. If it disagrees with the destination's `user@`, it is treated as a connection without a user. */
  let loginUser: string | null = null
  let endOfFlags = false
  let i = 0
  for (; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (name === 'ssh' && positional.length === 1) break
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg.startsWith('-') && arg !== '-') {
      if (rule.forbid?.some((flag) => flagHit(arg, flag, false)) === true) return null
      if (valueFlags.has(arg)) {
        const value = args[i + 1]
        if (value === undefined) return null
        if (name === 'ssh' && arg === '-l') loginUser = value
        i += 1
        continue
      }
      if (arg.startsWith('--')) {
        // Long flags exist only for rsync (those with no `flags` in the table). `--x=value` is one word.
        if (rule.flags !== undefined) return null
        continue
      }
      // The form with the value written right after, such as `-p2222` / `-ikey`.
      const attached = `-${arg[1] ?? ''}`
      if (arg.length > 2 && valueFlags.has(attached)) {
        if (name === 'ssh' && attached === '-l') loginUser = arg.slice(2)
        continue
      }
      if (rule.flags !== undefined && ![...arg.slice(1)].every((letter) => rule.flags?.includes(letter) === true)) return null
      continue
    }
    positional.push(arg)
  }
  if (name === 'ssh') {
    const destination = positional[0]
    if (destination === undefined) return null
    // OpenSSH reads flags after the destination again (`ssh host -o ProxyCommand=…`).
    if ((args[i] ?? '').startsWith('-')) return null
    const url = REMOTE_URL.exec(destination)
    const at = destination.lastIndexOf('@')
    let user: string | undefined = url !== null ? url[1] : at >= 0 ? destination.slice(0, at) : undefined
    const host = url !== null ? (url[2] ?? '') : at >= 0 ? destination.slice(at + 1) : destination
    if (loginUser !== null) user = user === undefined || user === loginUser ? loginUser : undefined
    const one = target(user, host)
    return one === null ? null : [one]
  }
  if (name === 'sftp') {
    // sftp has one destination. `host` alone is fine (remote even without `:`).
    if (positional.length !== 1) return null
    const arg = positional[0] ?? ''
    const remote = arg.includes(':') ? remoteOf(arg) : userHost(arg)
    return remote === null || remote === '' ? null : [remote]
  }
  const hosts: string[] = []
  for (const arg of positional) {
    const remote = remoteOf(arg)
    if (remote === null) return null
    if (remote !== '') merge(hosts, [remote])
  }
  return hosts
}

/** Positional arguments with flags (words starting with `-`) and their values skipped. Everything after `--` is positional. */
function positionals(args: readonly string[], valueFlags: ReadonlySet<string>): readonly string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (valueFlags.has(arg)) i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * The flag words. With `untilDashDash`, only those before `--` (for `require` - so the `-n` of `git clean -f -- -n` is not counted as a dry run).
 * `forbid` also looks after `--`: macOS's `find . -- -name x -delete` makes the `-delete` after `--` take effect
 * (wave 56 review 56-1). If a positional argument after `--` happens to start with `-` (`git diff -- -f`), it leans toward asking, which is fine on the passing side.
 */
function flagWords(args: readonly string[], untilDashDash: boolean): readonly string[] {
  const end = untilDashDash ? args.indexOf('--') : -1
  return (end < 0 ? args : args.slice(0, end)).filter((arg) => arg.startsWith('-') && arg !== '-' && arg !== '--')
}

/**
 * Whether the flag word `arg` matches the table flag `flag`. For `-x` (2 characters), the characters inside a bundle of short flags (`-xvf`) are also looked at. For `--long`, compare with `=value` removed,
 * and with `abbrev` also match a unique prefix abbreviation (`--forc`, which git accepts). A one-dash long flag such as `-delete` must match exactly.
 */
function flagHit(arg: string, flag: string, abbrev: boolean): boolean {
  if (flag.startsWith('--')) {
    if (!arg.startsWith('--')) return false
    const name = arg.split('=')[0] ?? ''
    return name === flag || (abbrev && name.length > 3 && flag.startsWith(name))
  }
  if (flag.length === 2) {
    if (arg.startsWith('--')) return false
    return arg.slice(1).includes(flag.slice(1))
  }
  return arg === flag
}

/** Whether it looks like a relative path inside the working folder (does not start with `/`, `~` or `..`, and has no `..` segment). */
function looksLocal(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('~')) return false
  return !path.split('/').includes('..')
}

function ruleAllows(rule: QuietRule, rawArgs: readonly string[], valueFlags: ReadonlySet<string>, abbrev: boolean): boolean {
  if (rule === 'any') return true
  // `awk '{ system("…") }'` is not caught by flags, so it is excluded by the text of the body (review 56-3, a simple substring match that leans toward asking).
  if (rule.forbidText !== undefined && rawArgs.some((arg) => rule.forbidText?.some((text) => arg.includes(text)) === true)) return false
  // The first word of `tar xIf …` (the old style) is a bundle of flags.
  const first = rawArgs[0]
  const args =
    rule.bundledFirst === true && first !== undefined && first !== '' && !first.startsWith('-') ? [`-${first}`, ...rawArgs.slice(1)] : rawArgs
  const allFlags = flagWords(args, false)
  if (rule.forbid !== undefined && allFlags.some((arg) => rule.forbid?.some((flag) => flagHit(arg, flag, abbrev)) === true)) return false
  const flags = flagWords(args, true)
  if (rule.require !== undefined && !flags.some((arg) => rule.require?.some((flag) => flagHit(arg, flag, false)) === true)) return false
  const positional = positionals(args, valueFlags)
  const sub = positional[0]
  if (rule.subcommands !== undefined) {
    if (sub === undefined) {
      if (rule.bareOk !== true) return false
    } else if (!rule.subcommands.includes(sub)) {
      return false
    }
  }
  if (rule.forbidSubcommands !== undefined && sub !== undefined && rule.forbidSubcommands.includes(sub)) return false
  // `chmod 644 a b`: the paths after the first positional argument (the mode) must appear to be inside the working folder.
  if (rule.localPaths === true && (positional.length < 2 || !positional.slice(1).every(looksLocal))) return false
  return true
}

/** git: the only prefixes are `-C <dir>` / `--no-pager`. push is only an ordinary push, and everything else goes by the table of subcommands. */
function gitQuiet(args: readonly string[]): boolean {
  let at = 0
  while (at < args.length) {
    const arg = args[at] ?? ''
    if (arg === '-C') {
      if (args[at + 1] === undefined) return false
      at += 2
      continue
    }
    if (arg === '--no-pager') {
      at += 1
      continue
    }
    if (arg.startsWith('-')) return false
    break
  }
  const sub = args[at]
  if (sub === undefined) return false
  if (sub === 'push') {
    const parsed = parsePushWords(args)
    return parsed !== null && parsed !== 'other'
  }
  const rule = own(QUIET.git, sub)
  return rule !== undefined && ruleAllows(rule, args.slice(at + 1), NO_VALUE_FLAGS, true)
}
