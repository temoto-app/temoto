/**
 * Turns the result of the prompt box's `!` into text to mix into the next user row (item 116, ARCHITECTURE.md 4.5.7).
 *
 * The wrapping is a copy of the form the backend's bash mode adds to the conversation, and **the strings exist only in the compat table**
 * (constraint 6). This is a pure function that only fills values into the table's templates, and `test/shell-input.test.ts` checks it.
 */
import type { ShellRunPayload } from '@shared/agent.js'
import type { ShellLimits } from '../types.js'

/** The compat table's `shellInput`. */
export interface ShellInputTable {
  readonly caveat: string
  readonly input: string
  readonly output: string
  readonly failed: string
  readonly timedOut: string
  readonly noCwd: string
  readonly maxOutputChars: number
  readonly timeoutMs: number
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  // Replacement is done in a single scan. Even if a value happens to contain a string like `{stdout}`,
  // it is not replaced a second time (we cannot know what a command's output will contain).
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}

function formatRun(table: ShellInputTable, run: ShellRunPayload): string {
  const input = fill(table.input, { command: run.command })
  if (run.status === 'no-cwd') return `${input}\n${fill(table.failed, { message: table.noCwd })}`
  if (run.status === 'failed') {
    return `${input}\n${fill(table.failed, { message: run.errorCode ?? 'unknown error' })}`
  }
  const stderr =
    run.status === 'timeout'
      ? [run.stderr, fill(table.timedOut, { seconds: String(Math.round(table.timeoutMs / 1000)) })]
          .filter((part) => part !== '')
          .join('\n')
      : run.stderr
  return `${input}\n${fill(table.output, {
    stdout: run.stdout,
    stderr,
    exitCode: run.exitCode === null ? '' : String(run.exitCode)
  })}`
}

/** Turns the accumulated results (oldest first) into one piece of text. An empty string if there are none. */
export function formatShellContext(table: ShellInputTable, runs: readonly ShellRunPayload[]): string {
  if (runs.length === 0) return ''
  return [table.caveat, ...runs.map((run) => formatRun(table, run))].join('\n')
}

export function shellLimitsOf(table: ShellInputTable): ShellLimits {
  return { maxOutputChars: table.maxOutputChars, timeoutMs: table.timeoutMs }
}
