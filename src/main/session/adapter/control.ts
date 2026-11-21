/**
 * stream-json control requests (items 91 / 94, ARCHITECTURE.md 4.6.2).
 *
 * Writes one line to the stdin of the unmodified CLI and matches the response line returned on stdout by request_id.
 * It is an internal protocol not listed in `--help`, so the vocabulary (the names of the kinds) is placed in `control` of `compat/`,
 * and building and reading the lines is confined to this file (constraints 1 / 6 - the same treatment as `--permission-prompt-tool`).
 *
 * spike 16 / 15b (CLI 2.1.207): `initialize` may be sent before the user's input and takes about 0.6 s,
 * and `interrupt` returns `success` in 1 ms. Neither calls the API.
 *
 * `interrupt` (item 94, 4.5.4) stops only the running turn and **does not kill the process** -
 * unlike the stop button (SIGINT), it does not incur the startup cost of `--resume` (about 21k tokens).
 * It is sent by `LiveSession.interrupt()`, through the same entry point as `initialize`, `writeControlRequest`.
 * A pure function with no side effects (regression in "item 91" and "item 94" of `test/adapter-process.test.ts`).
 */
import type { ControlVocabulary } from './compat.js'

/** One response. If `ok` is false, `error` holds the CLI's message (for diagnostics. Not shown on screen). */
export interface ControlResponse {
  readonly requestId: string
  readonly ok: boolean
  /** The contents on success (the shape differs per kind. The reader validates it). */
  readonly response: unknown
  readonly error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One request line (no newline). `extra` is the fields added to `request` (`subtype` cannot be overwritten). */
export function controlRequestLine(
  vocab: ControlVocabulary,
  requestId: string,
  subtype: string,
  extra: Readonly<Record<string, unknown>> = {}
): string {
  return JSON.stringify({
    type: vocab.requestType,
    request_id: requestId,
    request: { ...extra, subtype }
  })
}

/**
 * If a line of stdout is a response to a control request, returns it; otherwise null (it goes to `parseEvent` as a normal
 * event). **A response line is not passed to `parseEvent`** - it would become an `unknown` event as an unknown kind,
 * and the raw line (for initialize, including account information) would be saved.
 *
 * So as not to parse every line's JSON twice, only lines that contain the kind's name together with its quotes are read. Even if the
 * model's output has the same word, inside a JSON string it becomes `\"`, so it does not match this pre-check.
 */
export function readControlResponse(vocab: ControlVocabulary, line: string): ControlResponse | null {
  if (!line.includes(`"${vocab.responseType}"`)) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw['type'] !== vocab.responseType) return null
  const body = raw['response']
  if (!isRecord(body)) return null
  const requestId = body['request_id']
  if (typeof requestId !== 'string') return null
  const ok = body['subtype'] === vocab.success
  const error = body['error']
  return {
    requestId,
    ok,
    response: ok ? body['response'] : null,
    error: ok ? null : typeof error === 'string' ? error : JSON.stringify(error ?? null)
  }
}
