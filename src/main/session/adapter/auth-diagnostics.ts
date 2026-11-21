/**
 * The auth-expiry diagnostics bundle (TODO 1147, wave 72 bundle D, ARCHITECTURE 4.6.7).
 *
 * On 2026-11-04 the CLI turned to logged-out in the middle of a conversation, and re-login overwrote the clues (such as the keychain item's modification time).
 * So that the clues are left in the log **before the re-login** the next time it happens, one structured JSON line (`agent.auth.diagnostics`) is written when an auth expiry
 * is recognized, when the login state turns false, after the re-check 30 seconds later, and when it comes back.
 *
 * - **No secrets are written.** The bundle is built only from permitted fields (for the body, only its length and "which regex of the table it matched"), and finally passed through `redactJson`.
 *   The fields of `auth status --json` are only those in compat's allow table (`authFailure.diagnostics.authStatusFields`) (email, org and
 *   directory are dropped).
 * - **Only attributes of the keychain** (owner decision 2026-11-05): calls `security find-generic-password -s <item name>` without `-g` / `-w`,
 *   and picks up only `mdat` / `cdat` (a way of reading that shows no confirmation dialog). The credentials themselves are not touched (constraint 2 is "do not touch credentials",
 *   and reading attributes is interpreted as not touching them). The item name is from compat's table (constraint 6). Not read on anything other than macOS.
 * - Only the Adapter calls the CLI (`readAuthStatus` in `index.ts`); this file only bundles the snapshots.
 */
import { redactJson } from '../../../common/redact.js'
import type { LogFields } from '../../../common/logger.js'
import type { AuthDiagnosticsTrigger } from '../types.js'
import type { CompatTable } from './compat.js'
import { matchedAuthPattern } from './auth-failure.js'
import { runCapture } from './run-capture.js'
import { hostPlatform, isMac } from '../../../common/os/platform.js'
import { OS_TOOLS } from '../../../common/os/tools.js'

/** The macOS keychain tool. Does not rely on the PATH of an aios started from the GUI. */
const SECURITY_COMMAND = OS_TOOLS.security
const SECURITY_TIMEOUT_MS = 5_000
/** The exit code of `security` for "the item does not exist" (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44
/** Upper bound on the length of a string kept as a field value (longer values are dropped - the field is for keeping the kind of value, not its contents). */
const MAX_FIELD_LENGTH = 64

/** A snapshot of a stream line. Does not hold the body (only its length). */
export interface AuthErrorSnapshot {
  readonly at: number
  readonly threadId: string | null
  /** Which line it was recognized on. */
  readonly source: 'assistant' | 'result'
  /** The value of the line's `error` field (only a short identifier such as `authentication_failed`). */
  readonly errorValue: string | null
  /** The length of the body (in characters). The body itself is not kept. */
  readonly textLength: number
  /** The compat regex the body matched (its source string). */
  readonly pattern: string | null
  /** The API request id extracted from the line. */
  readonly requestId: string | null
}

/** A snapshot of `system/api_retry` (the last one). */
export interface ApiRetrySnapshot {
  readonly at: number
  readonly threadId: string | null
  readonly status: number | null
  /** The kind in the `error` field (only a short identifier such as `overloaded_error`). */
  readonly errorValue: string | null
  readonly attempt: number | null
  readonly requestId: string | null
}

/** A snapshot of `auth status --json` (only permitted fields). */
export interface AuthProbeSnapshot {
  readonly at: number
  readonly exitCode: number | null
  readonly parse: 'ok' | 'empty' | 'not-json'
  readonly fields: Readonly<Record<string, string | number | boolean>>
}

export type KeychainState = 'found' | 'not-found' | 'error' | 'unsupported' | 'unconfigured'

export interface KeychainMeta {
  readonly state: KeychainState
  readonly service: string | null
  readonly modifiedAt: string | null
  readonly createdAt: string | null
  readonly exitCode: number | null
}

export type CommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<{ readonly stdout: string; readonly code: number | null }>

/** Keeps only a short identifier (`authentication_failed` / `overloaded_error`, etc.). Sentences are dropped. */
function identifierOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null
}

const requestIdPatterns = new WeakMap<CompatTable, RegExp | null>()

function requestIdRe(table: CompatTable): RegExp | null {
  if (requestIdPatterns.has(table)) return requestIdPatterns.get(table) ?? null
  const source = table.authFailure?.diagnostics?.requestIdPattern
  let re: RegExp | null = null
  if (source !== undefined) {
    try {
      re = new RegExp(source)
    } catch {
      re = null
    }
  }
  requestIdPatterns.set(table, re)
  return re
}

/** Extracts only the API request id from a string (the one that appears last). */
export function requestIdIn(table: CompatTable, text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text === '') return null
  const re = requestIdRe(table)
  if (re === null) return null
  const all = text.match(new RegExp(re.source, 'g'))
  const last = all?.at(-1)
  return last !== undefined && last.length <= MAX_FIELD_LENGTH ? last : null
}

function textOfAssistant(raw: Record<string, unknown>): string {
  const message = raw['message']
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as Record<string, unknown>)['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * A snapshot of an auth-expired assistant line (the parent). `line` is the line itself, `stderrTail` is the tail of that session's stderr
 * (both are only used to look for the request id, and are not put into the snapshot).
 */
export function snapshotOfAuthLine(
  table: CompatTable,
  raw: Record<string, unknown>,
  line: string,
  stderrTail: string,
  threadId: string | null,
  now: number
): AuthErrorSnapshot {
  const text = textOfAssistant(raw)
  return {
    at: now,
    threadId,
    source: 'assistant',
    errorValue: identifierOf(raw['error']),
    textLength: text.length,
    pattern: matchedAuthPattern(table, text),
    requestId: requestIdIn(table, line) ?? requestIdIn(table, stderrTail)
  }
}

/** A snapshot of the `result` of an auth-expired failure (called under the same condition as the fallback for versions with no assistant line). */
export function snapshotOfAuthResult(
  table: CompatTable,
  text: string | null,
  stderrTail: string,
  threadId: string | null,
  now: number
): AuthErrorSnapshot {
  return {
    at: now,
    threadId,
    source: 'result',
    errorValue: null,
    textLength: text?.length ?? 0,
    pattern: matchedAuthPattern(table, text),
    requestId: requestIdIn(table, text) ?? requestIdIn(table, stderrTail)
  }
}

/** A snapshot of a `system/api_retry` line. */
export function snapshotOfApiRetry(
  table: CompatTable,
  raw: Record<string, unknown>,
  line: string,
  threadId: string | null,
  now: number
): ApiRetrySnapshot {
  const status = raw['error_status']
  const attempt = raw['attempt']
  return {
    at: now,
    threadId,
    status: typeof status === 'number' && Number.isFinite(status) ? Math.floor(status) : null,
    errorValue: identifierOf(raw['error']),
    attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? Math.floor(attempt) : null,
    requestId: requestIdIn(table, line)
  }
}

/** Keeps only the permitted fields from the stdout of `auth status --json`. Fields with secrets or personal information are not in the table, so they fall away. */
export function snapshotOfAuthStatus(
  table: CompatTable,
  stdout: string,
  exitCode: number | null,
  now: number
): AuthProbeSnapshot {
  const trimmed = stdout.trim()
  if (trimmed === '') return { at: now, exitCode, parse: 'empty', fields: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { at: now, exitCode, parse: 'not-json', fields: {} }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { at: now, exitCode, parse: 'not-json', fields: {} }
  }
  const record = parsed as Record<string, unknown>
  const fields: Record<string, string | number | boolean> = {}
  for (const key of table.authFailure?.diagnostics?.authStatusFields ?? []) {
    const value = record[key]
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) fields[key] = value
    else if (typeof value === 'string' && value.length <= MAX_FIELD_LENGTH) fields[key] = value
  }
  return { at: now, exitCode, parse: 'ok', fields }
}

/** Converts the time of a `security` attribute (`"mdat"<timedate>=0x… "20261104094100Z\000"`) to ISO. */
function keychainTime(stdout: string, attribute: 'mdat' | 'cdat'): string | null {
  const match = new RegExp(`"${attribute}"<timedate>=[^"\\n]*"(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})Z`).exec(stdout)
  if (match === null) return null
  const [, y, mo, d, h, mi, s] = match
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
}

const defaultRunner: CommandRunner = (command, args) =>
  runCapture(command, args, { timeoutMs: SECURITY_TIMEOUT_MS, maxBuffer: 64 * 1024 })

/**
 * Reads the attributes of a keychain item (existence, modification time, creation time). **`-g` / `-w` are not passed** (so that no secret is printed and
 * no confirmation dialog appears). Only the two times are picked up, and other attributes (such as the account name) are dropped.
 */
export async function readKeychainMeta(
  table: CompatTable,
  options: { readonly platform?: NodeJS.Platform; readonly run?: CommandRunner } = {}
): Promise<KeychainMeta> {
  const service = table.authFailure?.diagnostics?.keychainService ?? null
  if (service === null || service === '') {
    return { state: 'unconfigured', service: null, modifiedAt: null, createdAt: null, exitCode: null }
  }
  if (!isMac(options.platform ?? hostPlatform())) {
    return { state: 'unsupported', service, modifiedAt: null, createdAt: null, exitCode: null }
  }
  const run = options.run ?? defaultRunner
  try {
    const result = await run(SECURITY_COMMAND, ['find-generic-password', '-s', service])
    if (result.code === 0) {
      return {
        state: 'found',
        service,
        modifiedAt: keychainTime(result.stdout, 'mdat'),
        createdAt: keychainTime(result.stdout, 'cdat'),
        exitCode: 0
      }
    }
    return {
      state: result.code === SECURITY_NOT_FOUND ? 'not-found' : 'error',
      service,
      modifiedAt: null,
      createdAt: null,
      exitCode: result.code
    }
  } catch {
    return { state: 'error', service, modifiedAt: null, createdAt: null, exitCode: null }
  }
}

export interface AuthDiagnosticsInput {
  readonly trigger: AuthDiagnosticsTrigger
  readonly threadId: string | null
  readonly now: number
  readonly version: string | null
  readonly loggedIn: boolean | null
  readonly authProbe: AuthProbeSnapshot | null
  readonly lastError: AuthErrorSnapshot | null
  readonly lastRetry: ApiRetrySnapshot | null
  readonly keychain: KeychainMeta
}

/**
 * Builds the bundle (flat `LogFields`). Every value is from fields chosen here, and finally passed through `redactJson` (a double net).
 * The number of redaction hits is kept in `redacted` (the values are not).
 */
export function buildAuthDiagnostics(input: AuthDiagnosticsInput): LogFields {
  const fields: Record<string, string | number | boolean | null> = {
    trigger: input.trigger,
    threadId: input.threadId,
    version: input.version,
    loggedIn: input.loggedIn
  }
  if (input.authProbe !== null) {
    fields['authExitCode'] = input.authProbe.exitCode
    fields['authParse'] = input.authProbe.parse
    fields['authAgeMs'] = Math.max(0, input.now - input.authProbe.at)
    for (const [key, value] of Object.entries(input.authProbe.fields)) fields[`auth_${key}`] = value
  }
  if (input.lastError !== null) {
    fields['errorSource'] = input.lastError.source
    fields['errorValue'] = input.lastError.errorValue
    fields['errorTextLength'] = input.lastError.textLength
    fields['errorPattern'] = input.lastError.pattern
    fields['errorRequestId'] = input.lastError.requestId
    fields['errorThreadId'] = input.lastError.threadId
    fields['errorAgeMs'] = Math.max(0, input.now - input.lastError.at)
  }
  if (input.lastRetry !== null) {
    fields['retryStatus'] = input.lastRetry.status
    fields['retryError'] = input.lastRetry.errorValue
    fields['retryAttempt'] = input.lastRetry.attempt
    fields['retryRequestId'] = input.lastRetry.requestId
    fields['retryAgeMs'] = Math.max(0, input.now - input.lastRetry.at)
  }
  fields['keychain'] = input.keychain.state
  fields['keychainService'] = input.keychain.service
  fields['keychainModifiedAt'] = input.keychain.modifiedAt
  fields['keychainCreatedAt'] = input.keychain.createdAt
  if (input.keychain.exitCode !== null && input.keychain.exitCode !== 0) fields['keychainExitCode'] = input.keychain.exitCode
  const { value, hits } = redactJson(fields)
  return hits.length > 0 ? { ...value, redacted: hits.length } : value
}
