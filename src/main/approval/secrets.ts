/**
 * A conversation that read a secret gets asked about every path out (TODO 1043, owner decision 2026-10-29, ARCHITECTURE 4.2.1 "paths out of a conversation that read a secret").
 *
 * 959 stops "sending", but a way to leak what was read by embedding it in a web fetch URL (GET, WebFetch, `openUrl`) remains. As an approximation
 * cheaper than 979's strict tracking (provenance marks), **only the conversation that read a secret** is marked (in the Broker's memory), and every later path out of that conversation is asked about.
 * Conversations that read secrets are rare, so dialogs barely increase (compatible with 167).
 *
 * This file holds **pure functions only**. Tool names and argument keys are backend-specific, so the Adapter builds a `SecretTable` from the compat table and passes it in (constraint 6).
 * The vocabulary of locations and commands is `secrets` in `compat/outbound.json` (`.env` is not included, owner decision). Only the argument strings are inspected;
 * aios itself never reads the locations (constraint 2).
 *
 * - Reads that set the mark (`classifySecretRead`): the path argument of a reading tool (`Read` / `Grep` ...), path-like words inside a Bash command
 *   (for any command: `cat` / `grep` / `cp` / `base64` ... except `ls` / `stat` / `file`, which look only at names, and the ssh-family `-i <key>`; review 57-5), and commands that print secrets (`security find-generic-password -w` /
 *   `gh auth token` / `op read` ...).
 * - Paths out that are asked about after the mark (`classifyEgress`): web fetch and search tools, all MCP tools (the gateway's own tools are checked at the gateway's entry point),
 *   Bash `curl` / `wget` / `ssh` / `scp` / `gh` / `open` ... (regardless of method), git push / fetch / pull / clone ..., and outbound operations (959).
 *
 * **Limit**: reading and then sending inside a script gets through (1044 closes that). Reads by tools the CLI runs without asking for approval (`permissions.allow`)
 * also get marked when visible in tool_use, but if the sending side passes that way it cannot be stopped.
 */
import { GATEWAY_TOOL_PREFIX } from '@shared/thread.js'
import { loadOutboundVocabulary } from './outbound-vocabulary.js'
import { basename, commandWords, editRunnerHeredocBodies, matchOutboundCommand, shellSegments } from './outbound.js'
import { commandPathTokens, matchPathGroup, matchPathPattern, mergePathGroups } from './path-pattern.js'

const VOCABULARY = loadOutboundVocabulary().secrets
const EGRESS_COMMANDS: ReadonlySet<string> = new Set(VOCABULARY.egressCommands)
const EGRESS_GIT: ReadonlySet<string> = new Set(VOCABULARY.egressGit)
const EGRESS_PUBLISHERS: ReadonlySet<string> = new Set(VOCABULARY.egressPublishers)
const EGRESS_PUBLISH_VERBS: ReadonlySet<string> = new Set(VOCABULARY.egressPublishVerbs)
/** Among `git`'s leading flags, those that take the next word as their value. */
const GIT_PREFIX_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The table the Adapter builds from the compat table. */
export interface SecretTable {
  readonly shellTools: readonly string[]
  readonly commandField: string
  /** Reading tools (`Read` / `Grep` / `Glob` ...) and the keys of their path arguments. */
  readonly readTools: readonly string[]
  readonly pathKeys: readonly string[]
  /** Full names of the tools asked about after the mark, such as web fetch and search. */
  readonly egressTools: readonly string[]
  /** Prefix of MCP tool names (if empty, MCP is not checked). */
  readonly mcpPrefix: string
  /** Backend-specific locations of secrets (the CLI's credentials). */
  readonly paths?: Readonly<Record<string, readonly string[]>>
}

/** A hit on a secret read. `match` is the table's name (`ssh-key` / `cloud-credentials` / `keychain` ...). */
export interface SecretReadHit {
  readonly match: string
}

function secretGroup(path: string, groups: Readonly<Record<string, readonly string[]>>): string | null {
  if (VOCABULARY.excludePaths.some((pattern) => matchPathPattern(path, pattern))) return null
  return matchPathGroup(path, groups)
}

/**
 * Whether an argument word contains the flag `flag`. Besides the whole word and `flag=value`, a one-character flag (`-w`) is also looked for among the letters of a single-dash cluster (`-wa` / `-gw`)
 * (review 57-7, same approach as `-i` in `persistence.ts`). It also matches letters in a value inside a cluster (`-sgithub`), but that only errs toward asking.
 */
function hasFlag(arg: string, flag: string): boolean {
  if (arg === flag || arg.startsWith(`${flag}=`)) return true
  return /^-[A-Za-z]$/.test(flag) && /^-[A-Za-z0-9]+$/.test(arg) && arg.slice(1).includes(flag.slice(1))
}

/** Whether a tool call reads a secret. If so, the kind of mark. */
export function classifySecretRead(table: SecretTable, toolName: string, input: unknown): SecretReadHit | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const groups = mergePathGroups(VOCABULARY.paths, table.paths)
  if (table.shellTools.includes(toolName)) {
    const command = record[table.commandField]
    return typeof command === 'string' ? classifySecretCommand(command, groups) : null
  }
  if (!table.readTools.includes(toolName)) return null
  for (const key of table.pathKeys) {
    const value = record[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const match = secretGroup(value.trim(), groups)
    if (match !== null) return { match }
  }
  return null
}

/** Whether a shell command reads a secret. */
export function classifySecretCommand(
  command: string,
  groups: Readonly<Record<string, readonly string[]>> = VOCABULARY.paths
): SecretReadHit | null {
  if (command.trim() === '') return null
  // TODO 1166: `shellSegments` drops the body of a heredoc whose receiver only reads it as data (`heredocSinks`: `cat` ..., `git commit -F -`)
  // (so words in a commit message do not set the mark). The bodies of `python3 - <<'EOF'` / `sh <<'EOF'` / `cat <<'EOF' | sh`, and of a body whose
  // later delimiter could run the written text (`cat > run.sh <<'EOF' … bash run.sh`), are not dropped and are inspected as before.
  const segments = shellSegments(command)
  for (const segment of segments) {
    const words = commandWords(segment)
    const head = words[0] === undefined ? '' : basename(words[0])
    const args = words.slice(1)
    const positional = args.filter((arg) => !arg.startsWith('-'))
    for (const rule of VOCABULARY.commands) {
      if (rule.words[0] !== head) continue
      if (!rule.words.slice(1).every((word) => positional.includes(word))) continue
      if (rule.anyFlag !== undefined && !args.some((arg) => rule.anyFlag?.some((flag) => hasFlag(arg, flag)) === true)) continue
      return { match: 'secret-command' }
    }
  }
  for (const segment of segments) {
    const head = commandWords(segment)[0]
    // review 57-5: commands that look only at names and attributes (`ls ~/.ssh` / `stat` / `file`) do not read the contents.
    if (head !== undefined && NAME_ONLY.has(basename(head))) continue
    for (const token of commandPathTokens(withoutIdentityArgs(segment))) {
      const match = secretGroup(token, groups)
      if (match !== null) return { match }
    }
  }
  return null
}

/** review 57-5: commands that take a secret-location path as an argument but print only names and attributes, not contents. */
const NAME_ONLY: ReadonlySet<string> = new Set(VOCABULARY.nameOnlyCommands)
/** review 57-5: ssh-family commands that receive the key with `-i` (for rsync, only after the `ssh` inside `-e "ssh -i …"`; rsync's own `-i` takes no value). */
const IDENTITY_COMMANDS: ReadonlySet<string> = new Set(VOCABULARY.identityCommands)

/**
 * review 57-5: from the delimited words, drops arguments that only hand a key to an ssh-family command (`-i <key>` / `-i<key>` / `-o IdentityFile=<key>`). ssh
 * uses the key only for authentication, and its contents appear neither in the conversation nor outside. Positional arguments that send the key itself, as in `scp ~/.ssh/id_rsa host:`, are kept.
 */
function withoutIdentityArgs(segment: string): string {
  const words = segment.split(' ').filter((word) => word !== '')
  const out: string[] = []
  let ssh = false
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? ''
    if (IDENTITY_COMMANDS.has(basename(word))) ssh = true
    if (ssh && word === '-i') {
      at += 1
      continue
    }
    if (ssh && word.startsWith('-i') && word.length > 2) continue
    if (ssh && /^(-o)?IdentityFile=/i.test(word)) continue
    if (ssh && word === '-o' && /^IdentityFile=/i.test(words[at + 1] ?? '')) {
      at += 1
      continue
    }
    out.push(word)
  }
  return out.join(' ')
}

/**
 * Whether a tool call is a path out (asked about after the mark). Returns the name that matched (`webfetch` / `mcp` / `curl` / `git-fetch` / the name of an outbound operation).
 * The aios gateway's own tools are not checked (for `openUrl` and plugin tools, the gateway's entry point looks at the mark and asks).
 */
export function classifyEgress(table: SecretTable, toolName: string, input: unknown): string | null {
  if (table.shellTools.includes(toolName)) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
    const command = (input as Record<string, unknown>)[table.commandField]
    return typeof command === 'string' ? egressCommand(command) : null
  }
  if (table.egressTools.includes(toolName)) return toolName.toLowerCase()
  if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) return null
  if (table.mcpPrefix !== '' && toolName.startsWith(table.mcpPrefix)) return 'mcp'
  return null
}

/**
 * TODO 1077: when there is a heredoc, a function call `open(…)` in the body the receiver (`python3` ...) executes is split at `(`
 * and looks like it starts with the word `open` (macOS's command for opening URLs). Only path-out words that end right before `(` are removed (`$(open x)` / `(open x)` stay,
 * because they come after the `(`). `curl …` / `subprocess.run(['curl', …])` / `os.system("ssh …")` in the body remain as words after `(` and err toward asking.
 * Review fix: the removal applies **only inside heredoc bodies the receiver could run** (`editRunnerHeredocBodies`). It is not applied to command text outside the body
 * (the first line, what follows, a `<<<` here-string, a `1 << 2` expression).
 */
function withoutCallNames(command: string): string {
  return editRunnerHeredocBodies(command, (line) =>
    line.replace(/(?<![\w$./-])([A-Za-z][\w-]*)\(/g, (all, name: string) => (EGRESS_COMMANDS.has(name) ? ' (' : all))
  )
}

/** Whether the word is a publish verb. Flags (`--push` / `--push=true`) and table words containing `=` (`type=registry`) match partially (`--output=type=registry`). */
function isPublishWord(word: string): boolean {
  for (const verb of EGRESS_PUBLISH_VERBS) {
    if (word === verb) return true
    if (verb.startsWith('-') && word.startsWith(`${verb}=`)) return true
    if (verb.includes('=') && word.includes(verb)) return true
  }
  return false
}

/** Whether a shell command is a path out. Returns the name that matched (a tool name / `git-<subcommand>` / `publish` / the name of an outbound operation). */
export function egressCommand(command: string): string | null {
  if (command.trim() === '') return null
  for (const segment of shellSegments(withoutCallNames(command))) {
    const words = commandWords(segment)
    const head = words[0] === undefined ? '' : basename(words[0])
    if (EGRESS_COMMANDS.has(head)) return head
    if (head === 'git') {
      const args = words.slice(1)
      let at = 0
      while (at < args.length && (args[at] ?? '').startsWith('-')) at += GIT_PREFIX_VALUE_FLAGS.has(args[at] ?? '') ? 2 : 1
      const sub = args[at]
      if (sub !== undefined && EGRESS_GIT.has(sub)) return `git-${sub}`
    }
    // TODO 1191 review (X-5): the publishing family was removed from the outbound operation check (959), so `npm publish` / `docker push` are checked here.
    // The head of the segment is a publishing tool and a later word is a verb (a flag counts too: `--push` / `--output=type=registry`). The wrapper `bash -c "npm publish"`
    // is unwrapped by `shellSegments` / `commandWords`. Heredoc bodies that are data are dropped by `shellSegments`, so words in the body do not match.
    // Precision comes from the segment head; as insurance, any word in the segment being a publishing tool is also checked (`python -m twine upload` / `timeout 60 npm publish` /
    // `poetry run twine upload` / `find . -exec npm publish \;` / `npx vsce publish`). This applies only to conversations that read a secret, so it errs toward asking.
    const all = segment.split(' ').filter((word) => word !== '')
    const tool = all.findIndex((word) => EGRESS_PUBLISHERS.has(basename(word)))
    if (tool >= 0 && all.slice(tool + 1).some(isPublishWord)) return 'publish'
  }
  // Since 1191, the outbound operation check (959) picks up only chat, mail, and osascript. This picks up those inside wrappers not examined above.
  return matchOutboundCommand(command)
}
