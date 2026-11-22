/**
 * The "Report a problem" file (TODO 1308, ARCHITECTURE.md 12.9.2). One readable text file the user can open and check before
 * deciding to send it anywhere. Pure and independent of electron / the file system: main reads the log files and passes their text in.
 *
 * What goes in: the version / build / OS lines, the crash records (log lines about a process that went away) and the tail of the recent
 * log. What never goes in: conversation text, tool results, prompts, credentials. The log does not hold them by convention, and this
 * builder enforces it again: it keeps only JSON log rows, drops fields that could carry a body, then applies the secret
 * redaction, the e-mail mask and the home-directory mask to every line. A crash dump (minidump) is never part of it.
 */
import type { BuildInfo, RuntimeInfo } from '../shared/build-info.js'
import { redactText } from './redact.js'

/** Row fields that could carry a body or a secret. Dropped before the row is written out, whatever the value. */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'body',
  'content',
  'prompt',
  'input',
  'args',
  'output',
  'result',
  'tool_result',
  'toolResult',
  'stdout',
  'stderr',
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'credentials'
])

/** Events that mean a process went away or stopped answering. These rows are listed again in their own section. */
const CRASH_EVENT_RE = /(\.gone$|gaveUp$|unresponsive|crash)/i

/** Budget of the "recent log" section (bytes of the redacted text). */
export const REPORT_LOG_BUDGET_BYTES = 512 * 1024
/** Most crash records listed. */
export const REPORT_CRASH_RECORD_LIMIT = 100

export interface ReportLogFile {
  readonly name: string
  readonly text: string
}

export interface ProblemReportInput {
  readonly productName: string
  readonly build: BuildInfo
  readonly runtime: RuntimeInfo
  /** Log files, oldest first. */
  readonly logs: readonly ReportLogFile[]
  /** The home directory of the user (`os.homedir()`), masked to `~`. */
  readonly homeDir: string
  /** The login name; masked to `<user>` wherever it still appears. */
  readonly userName: string
  readonly now: Date
  readonly budgetBytes?: number
  /** Gives the event loop a turn; replaced in tests. */
  readonly yieldFn?: () => Promise<void>
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Builds the identity mask once (the regular expressions are compiled here, not per line). */
export function createIdentityMasker(homeDir: string, userName: string): (text: string) => string {
  const homes = [homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\\/g, '\\\\')].filter((h) => h.length > 1)
  const homeRes = [...new Set(homes)].map((home) => new RegExp(escapeRegExp(home), 'g'))
  const userRe = userName.length >= 3 ? new RegExp(`\\b${escapeRegExp(userName)}\\b`, 'g') : null
  return (text) => {
    let out = text
    for (const re of homeRes) out = out.replace(re, '~')
    // Any other home directory (an external volume's `/Volumes/x/Users/y`, another account): keep the shape, drop the name.
    out = out.replace(/(\/Users\/|\/home\/)[^/\s"'\\]+/g, '$1<user>')
    out = out.replace(/([A-Za-z]:\\{1,2}Users\\{1,2})[^\\\s"']+/g, '$1<user>')
    if (userRe !== null) out = out.replace(userRe, '<user>')
    return out
  }
}

/** Masks the home directory, other users' home directories and the login name. */
export function maskIdentity(text: string, homeDir: string, userName: string): string {
  return createIdentityMasker(homeDir, userName)(text)
}

/** One log line -> a safe line, or null if it is not a JSON log row. */
export function sanitizeLogLine(
  line: string,
  homeDir: string,
  userName: string,
  mask: (text: string) => string = createIdentityMasker(homeDir, userName)
): { readonly line: string; readonly event: string } | null {
  if (!line.startsWith('{')) return null
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (FORBIDDEN_FIELDS.has(key)) continue
    kept[key] = value
  }
  const event = typeof kept['event'] === 'string' ? kept['event'] : ''
  // The e-mail mask goes first: the user-name mask would otherwise turn `alice@x.com` into `<user>@x.com` and hide the match.
  let text = JSON.stringify(kept).replace(EMAIL_RE, '<email>')
  text = mask(text)
  text = redactText(text).text
  return { line: text, event }
}

/** Lines handled between two yields to the event loop. */
export const REPORT_YIELD_EVERY_LINES = 500

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function buildProblemReport(input: ProblemReportInput): Promise<string> {
  const yieldFn = input.yieldFn ?? yieldToEventLoop
  const mask = createIdentityMasker(input.homeDir, input.userName)
  let overBudget = false
  let sinceYield = 0
  const budget = input.budgetBytes ?? REPORT_LOG_BUDGET_BYTES
  const crashes: string[] = []
  // Newest first, so the budget keeps the newest lines.
  const recent: string[] = []
  let used = 0
  let omitted = 0
  let truncated = false
  for (let i = input.logs.length - 1; i >= 0; i--) {
    const lines = (input.logs[i]?.text ?? '').split('\n')
    for (let j = lines.length - 1; j >= 0; j--) {
      const raw = lines[j] ?? ''
      if (raw.trim() === '') continue
      if (++sinceYield >= REPORT_YIELD_EVERY_LINES) {
        sinceYield = 0
        await yieldFn()
      }
      // Past the budget only crash records can still matter: skip everything else before any parsing or masking.
      if (overBudget && (crashes.length >= REPORT_CRASH_RECORD_LIMIT || !CRASH_EVENT_RE.test(raw))) {
        truncated = true
        continue
      }
      const clean = sanitizeLogLine(raw, input.homeDir, input.userName, mask)
      if (clean === null) {
        omitted += 1
        continue
      }
      if (CRASH_EVENT_RE.test(clean.event) && crashes.length < REPORT_CRASH_RECORD_LIMIT) crashes.push(clean.line)
      if (!overBudget && used + clean.line.length + 1 <= budget) {
        recent.push(clean.line)
        used += clean.line.length + 1
      } else {
        overBudget = true
        truncated = true
      }
    }
    await yieldFn()
  }
  crashes.reverse()
  recent.reverse()

  const { build, runtime } = input
  const head = [
    `# ${input.productName} problem report`,
    '',
    `Generated: ${input.now.toISOString()}`,
    'Nothing in this file was sent anywhere. Open it, check it, and send it yourself only if you want to.',
    'It holds no conversation text, tool output, prompt or credential, and no crash dump. Secrets, e-mail addresses and your user name are masked.',
    '',
    '## App',
    `version: ${build.version}`,
    `commit: ${build.commit}${build.dirty ? ' (uncommitted changes)' : ''}`,
    `commit date: ${build.date === '' ? 'unknown' : build.date}`,
    '',
    '## Runtime',
    `electron: ${runtime.electron}`,
    `chromium: ${runtime.chromium}`,
    `node: ${runtime.node}`,
    `v8: ${runtime.v8}`,
    `os: ${runtime.os}`,
    '',
    '## Crash records',
    ...(crashes.length === 0 ? ['(none in the kept logs)'] : crashes),
    '',
    `## Recent log (${recent.length} lines${truncated ? ', older lines left out' : ''}${omitted > 0 ? `, ${omitted} non-log lines left out` : ''})`,
    ...recent,
    ''
  ]
  return head.join('\n')
}

/** `problem-report-YYYYMMDD-HHMMSS.txt` (local time, sorts in Finder). */
export function problemReportFileName(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `problem-report-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.txt`
}
