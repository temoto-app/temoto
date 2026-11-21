/**
 * Loading the vocabulary for judging outbound operations (`compat/outbound.json`) (TODO 1020 made the TODO 959 table common,
 * owner decision 2026-10-26, ARCHITECTURE 4.2.1).
 *
 * The vocabulary does not depend on the backend (verbs and nouns of MCP tool names, shell command names and flags). Which tool is a shell and the shape of MCP
 * tool names are backend-specific, so they stay in each Adapter's compat table `outbound` (`OutboundTable`). Both Adapters'
 * `outboundAction` use this one vocabulary through `classifyOutbound`.
 *
 * If it cannot be read, throw (silently making it empty would let every outbound operation through). The table is included in distributed builds too (`compat/*.json`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface OutboundVocabulary {
  readonly mcp: {
    readonly readVerbs: readonly string[]
    readonly sendVerbs: readonly string[]
    readonly writeVerbs: readonly string[]
    readonly sharedObjects: readonly string[]
  }
  readonly shell: {
    readonly wrappers: readonly string[]
    readonly wrapperValueFlags: Readonly<Record<string, readonly string[]>>
    readonly shells: readonly string[]
    readonly mailCommands: readonly string[]
    readonly osascriptWords: readonly string[]
    /** TODO 1191: destinations of chat webhooks / APIs (`host`, host/path-prefix, `*.host`). */
    readonly chatEndpoints: readonly string[]
    readonly publisherValueFlags: readonly string[]
    /** TODO 1053: receivers that only read a heredoc body as data (`cat` / `tee` ...). */
    readonly heredocSinks: readonly string[]
    /** TODO 1053: if one is in the same command, the body is not skipped (the written body could be run). */
    readonly heredocRunners: readonly string[]
  }
  /** Quiet standard commands (TODO 1031). The judgment is in `quiet.ts`. */
  readonly quiet: {
    readonly commands: Readonly<Record<string, QuietRule>>
    readonly git: Readonly<Record<string, QuietRule>>
    /** TODO 1029: the flag table for ssh / scp / sftp / rsync (destinations are matched against the "hosts not to ask about"). */
    readonly transfers: Readonly<Record<string, TransferRule>>
    /** Wrappers whose inner command is looked at with the same table, and the flags of those wrappers that take a value. */
    readonly wrappers: Readonly<Record<string, readonly string[]>>
    readonly shells: readonly string[]
    readonly envDenyPrefixes: readonly string[]
    readonly envDenySuffixes: readonly string[]
    readonly envDenyNames: readonly string[]
  }
  /** Writes that persist or switch off a safeguard (TODO 1042). The judgment is in `persistence.ts`. */
  readonly persistence: {
    readonly paths: Readonly<Record<string, readonly string[]>>
    readonly writers: readonly string[]
    readonly inPlace: readonly string[]
    readonly interpreters: readonly string[]
    readonly crontabReadFlags: readonly string[]
    readonly launchctlWrites: readonly string[]
    readonly gitConfigKeyPrefixes: readonly string[]
    readonly gitConfigReadFlags: readonly string[]
  }
  /** The marker of a conversation that read a secret, and the paths out to ask about after the marker (TODO 1043). The judgment is in `secrets.ts`. */
  readonly secrets: {
    readonly paths: Readonly<Record<string, readonly string[]>>
    readonly excludePaths: readonly string[]
    readonly commands: readonly SecretCommandRule[]
    readonly egressCommands: readonly string[]
    readonly egressGit: readonly string[]
    /** Review of TODO 1191: publishing tools and verbs to ask about after the marker (`npm publish` / `docker push` ...). */
    readonly egressPublishers: readonly string[]
    readonly egressPublishVerbs: readonly string[]
    /** Review 57-5: commands that take a storage path but do not read the contents (`ls` / `stat` / `file`). */
    readonly nameOnlyCommands: readonly string[]
    /** Review 57-5: commands that only receive a key with `-i` / `-o IdentityFile=` (`ssh` / `scp` / `sftp`). */
    readonly identityCommands: readonly string[]
  }
  readonly display: {
    readonly to: readonly string[]
    readonly subject: readonly string[]
    readonly body: readonly string[]
  }
}

/** A command that prints a secret to standard output (TODO 1043). `words[0]` is the command name, the rest are somewhere among the positional arguments. `anyFlag` requires one of the flags. */
export interface SecretCommandRule {
  readonly words: readonly string[]
  readonly anyFlag?: readonly string[]
}

function isSecretCommandRule(value: unknown): value is SecretCommandRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rule = value as Record<string, unknown>
  if (!isStringList(rule['words']) || rule['words'].length === 0) return false
  return rule['anyFlag'] === undefined || isStringList(rule['anyFlag'])
}

/** One rule of the quiet standard commands (TODO 1031). `'any'` means any arguments. */
export type QuietRule =
  | 'any'
  | {
      readonly forbid?: readonly string[]
      readonly require?: readonly string[]
      readonly subcommands?: readonly string[]
      readonly bareOk?: boolean
      readonly forbidSubcommands?: readonly string[]
      readonly localPaths?: boolean
      /** Review 56-3: it is rejected if any argument contains this text (`system(` / `|` of `awk`). */
      readonly forbidText?: readonly string[]
      /** Review 56-3: if the first argument does not start with `-`, read it as a bundle of flags (the old style of `tar xIf`). */
      readonly bundledFirst?: boolean
    }

/**
 * The flag table of commands that connect to another host (TODO 1029). `flags` are the one-letter flags accepted (if absent, every flag other than `forbid` is accepted),
 * `valueFlags` are flags that take a value, and `forbid` are flags that are not accepted.
 */
export interface TransferRule {
  readonly flags?: string
  readonly valueFlags: readonly string[]
  readonly forbid?: readonly string[]
}

function isTransferRule(value: unknown): value is TransferRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rule = value as Record<string, unknown>
  if (!Object.keys(rule).every((key) => key === 'flags' || key === 'valueFlags' || key === 'forbid')) return false
  if (rule['flags'] !== undefined && typeof rule['flags'] !== 'string') return false
  if (rule['forbid'] !== undefined && !isStringList(rule['forbid'])) return false
  return isStringList(rule['valueFlags'])
}

const QUIET_RULE_LISTS = ['forbid', 'require', 'subcommands', 'forbidSubcommands', 'forbidText'] as const
const QUIET_RULE_FLAGS = ['bareOk', 'localPaths', 'bundledFirst'] as const

function isQuietRule(value: unknown): value is QuietRule {
  if (value === 'any') return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rule = value as Record<string, unknown>
  for (const key of Object.keys(rule)) {
    if (!(QUIET_RULE_LISTS as readonly string[]).includes(key) && !(QUIET_RULE_FLAGS as readonly string[]).includes(key)) return false
  }
  if (QUIET_RULE_LISTS.some((key) => rule[key] !== undefined && !isStringList(rule[key]))) return false
  return QUIET_RULE_FLAGS.every((key) => rule[key] === undefined || typeof rule[key] === 'boolean')
}

function isRuleTable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isQuietRule)
}

function candidateDirs(): readonly string[] {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    join(here, '../../../compat'), // src/main/approval → repo/compat (dev, vitest)
    join(here, '../../compat'), // out/main → repo/compat (build)
    join(process.cwd(), 'compat')
  ]
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** Shape validation (so a missing key does not silently become an empty set). */
function validate(raw: unknown): OutboundVocabulary {
  const root = raw as Record<string, Record<string, unknown> | undefined>
  const missing: string[] = []
  for (const [section, keys] of [
    ['mcp', ['readVerbs', 'sendVerbs', 'writeVerbs', 'sharedObjects']],
    [
      'shell',
      [
        'wrappers',
        'shells',
        'mailCommands',
        'osascriptWords',
        'chatEndpoints',
        'publisherValueFlags',
        'heredocSinks',
        'heredocRunners'
      ]
    ],
    ['quiet', ['shells', 'envDenyPrefixes', 'envDenySuffixes', 'envDenyNames']],
    [
      'persistence',
      [
        'writers',
        'inPlace',
        'interpreters',
        'crontabReadFlags',
        'launchctlWrites',
        'gitConfigKeyPrefixes',
        'gitConfigReadFlags'
      ]
    ],
    ['secrets', ['excludePaths', 'egressCommands', 'egressGit', 'egressPublishers', 'egressPublishVerbs', 'nameOnlyCommands', 'identityCommands']],
    ['display', ['to', 'subject', 'body']]
  ] as const) {
    for (const key of keys) {
      if (!isStringList(root[section]?.[key])) missing.push(`${section}.${key}`)
    }
  }
  const flags = root['shell']?.['wrapperValueFlags']
  if (typeof flags !== 'object' || flags === null || !Object.values(flags).every(isStringList)) {
    missing.push('shell.wrapperValueFlags')
  }
  // TODO 1031: the table of quiet standard commands. If a broken rule were silently turned into "any", things that should be asked about would pass.
  const quiet = root['quiet']
  if (!isRuleTable(quiet?.['commands'])) missing.push('quiet.commands')
  if (!isRuleTable(quiet?.['git'])) missing.push('quiet.git')
  const transfers = quiet?.['transfers']
  if (typeof transfers !== 'object' || transfers === null || !Object.values(transfers).every(isTransferRule)) {
    missing.push('quiet.transfers')
  }
  const wrappers = quiet?.['wrappers']
  if (typeof wrappers !== 'object' || wrappers === null || !Object.values(wrappers).every(isStringList)) {
    missing.push('quiet.wrappers')
  }
  // TODO 1042: the table of write targets that persist. If it were emptied, everything would pass.
  const paths = root['persistence']?.['paths']
  if (typeof paths !== 'object' || paths === null || Object.keys(paths).length === 0 || !Object.values(paths).every(isStringList)) {
    missing.push('persistence.paths')
  }
  // TODO 1043: the table of where secrets live and of commands that print secrets.
  const secretPaths = root['secrets']?.['paths']
  if (
    typeof secretPaths !== 'object' ||
    secretPaths === null ||
    Object.keys(secretPaths).length === 0 ||
    !Object.values(secretPaths).every(isStringList)
  ) {
    missing.push('secrets.paths')
  }
  const secretCommands = root['secrets']?.['commands']
  if (!Array.isArray(secretCommands) || !secretCommands.every(isSecretCommandRule)) missing.push('secrets.commands')
  if (missing.length > 0) throw new Error(`outbound vocabulary is malformed: ${missing.join(', ')}`)
  return raw as OutboundVocabulary
}

let cached: OutboundVocabulary | null = null

export function loadOutboundVocabulary(): OutboundVocabulary {
  if (cached !== null) return cached
  const errors: string[] = []
  for (const dir of candidateDirs()) {
    const file = join(dir, 'outbound.json')
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`)
      continue
    }
    try {
      cached = validate(JSON.parse(text))
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`, { cause: err })
    }
    return cached
  }
  throw new Error(`outbound vocabulary not found\n${errors.join('\n')}`)
}
