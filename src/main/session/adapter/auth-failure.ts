/**
 * Recognition of auth expiry (TODO 893, wave 47 bundle D). **Message comparison is only in this file** (constraint 6) - the values and regexes are in
 * `authFailure` in `compat/`.
 *
 * When token refresh fails, the CLI emits a synthetic assistant line (`error` field = `authentication_failed`) and a failed
 * `result` (the same message in `result`). The assistant line is looked at first and remembered (held by `LiveSession`), and `authFailed` is
 * attached to the `result`. On versions where no assistant line arrives, it is also caught from the `result` message.
 *
 * All aios does is recognize, guide and resend - it does not refresh tokens or touch the credentials file (constraint 2).
 */
import type { CompatTable } from './compat.js'

/** Upper bound on the length of the CLI's synthetic failure message. A longer message is regarded as a model response. */
const MAX_CLI_MESSAGE_LENGTH = 300

interface CompiledPattern {
  /** The source string of the table entry (kept in the TODO 1147 diagnostics bundle). */
  readonly source: string
  readonly re: RegExp
}

const compiled = new WeakMap<CompatTable, readonly CompiledPattern[]>()
const compiledCredential = new WeakMap<CompatTable, readonly CompiledPattern[]>()

function patternsOf(table: CompatTable): readonly CompiledPattern[] {
  const cached = compiled.get(table)
  if (cached !== undefined) return cached
  const out = compile(table.authFailure?.textPatterns ?? [])
  compiled.set(table, out)
  return out
}

function credentialPatternsOf(table: CompatTable): readonly CompiledPattern[] {
  const cached = compiledCredential.get(table)
  if (cached !== undefined) return cached
  const out = compile(table.authFailure?.credentialPatterns ?? [])
  compiledCredential.set(table, out)
  return out
}

function compile(sources: readonly string[]): readonly CompiledPattern[] {
  const out: CompiledPattern[] = []
  for (const source of sources) {
    try {
      // Anchored at the start of the message (code-review): when the failed `result` message was a model response, a mention in the middle does not match.
      out.push({ source, re: new RegExp(`^(?:${source})`, 'i') })
    } catch {
      // Skip a broken regex (a table mistake must not stop stream reading).
    }
  }
  return out
}

/** Whether the stream-json assistant line (the parent) reports an auth expiry. Judged by the value of the `error` field. */
export function isAuthFailureLine(table: CompatTable, raw: Record<string, unknown>): boolean {
  if (raw['type'] !== 'assistant') return false
  if (raw['parent_tool_use_id'] !== undefined && raw['parent_tool_use_id'] !== null) return false
  const error = raw['error']
  return typeof error === 'string' && (table.authFailure?.errorValues ?? []).includes(error)
}

/**
 * Whether a failed `result` message is an auth expiry (a fallback for versions where the assistant line's `error` field did not arrive). Called only for a failed `result`
 * (`is_error`). The CLI's synthetic message is one short line, so **only the start of a one-line message of up to 300 characters** is matched against the table's regexes
 * - multi-line or long messages are regarded as a model response and not looked at (mentioning "Invalid API key" inside a response does not make it an auth expiry).
 */
export function isAuthFailureText(table: CompatTable, text: string | null): boolean {
  return matchedAuthPattern(table, text) !== null
}

/**
 * TODO 1147: the table regex the message matched (its source string). null if none. Used to leave "what kind of message it was" in the diagnostics bundle
 * in place of the body (the body is not written to the log). The condition is the same as `isAuthFailureText` (the start of a one-line message of up to 300 characters).
 */
export function matchedAuthPattern(table: CompatTable, text: string | null): string | null {
  if (text === null) return null
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_CLI_MESSAGE_LENGTH || /[\r\n]/.test(trimmed)) return null
  return patternsOf(table).find((pattern) => pattern.re.test(trimmed))?.source ?? null
}

/**
 * TODO 1282: which kind of auth failure a failed turn was. `credential` = the credential handed to the CLI itself was rejected (an
 * invalid API key and the like): signing in again does not fix it, so neither the "Log in" button nor the automatic login is offered
 * (constraint 3: an API-key user is never pushed into a subscription login). Anything else is `login` (an expired / unrenewable login,
 * which a fresh login fixes). The text is the failed `result` message, under the same one-line, 300-character condition as above.
 */
export function authFailureKindOf(table: CompatTable, text: string | null): 'login' | 'credential' {
  if (text === null) return 'login'
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_CLI_MESSAGE_LENGTH || /[\r\n]/.test(trimmed)) return 'login'
  return credentialPatternsOf(table).some((pattern) => pattern.re.test(trimmed)) ? 'credential' : 'login'
}
