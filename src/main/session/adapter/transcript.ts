/**
 * Read-only access to the backend's transcripts (`.jsonl` under `~/.claude/projects`).
 *
 * **This file is the only place that knows the location and format of transcripts**, and by constraint 6 it cannot go outside here
 * (`src/main/session/adapter/`) and `compat/`. The location itself is in
 * `compat/backend-paths.json`; only the knowledge of the format is here.
 *
 * Its standing under the rules (12.2 / 12.7):
 * - A transcript is **not a credential**, so it may be read. Only `.jsonl` files under `projects` are read, and
 *   credential files are never touched (constraint 2).
 * - Nothing is ever written. aios does not modify the CLI's files (constraint 1).
 * - **`tool_result` is not put in the index** (constraint 10). For restoring, it is read
 *   only when the user opens it in the timeline, read from the canonical copy on the spot and returned.
 *
 * Format (measured with CLI 2.1.207):
 * `{type:'user'|'assistant', uuid, timestamp, sessionId, cwd, message:{content:[...]}}`.
 * `content` is an array of `{type:'text'|'thinking'|'tool_use'|'tool_result', ...}`;
 * user messages are `text`, and tool results are `tool_result` (with `tool_use_id`).
 *
 * **Re-reading one message is a partial read of one line** (item 78). At ingestion it returns each message's
 * line byte offset and length, and the index keeps them in `documents.metadata`. Previously,
 * for every single snippet the whole file (up to 16 MB) was read and every line was `JSON.parse`d
 * (on main's JS thread, in proportion to the hit count). Only when the location is unusable does it
 * fall back to a full parse, and that result is kept in a small LRU and reused by the remaining hits of the same search.
 */
import { createReadStream } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { log, errorFields } from '../../../common/logger.js'
import type { AiosEvent } from '@shared/agent.js'
import { TRANSCRIPT_EVENT_ID_PREFIX } from '@shared/thread.js'
import type {
  TranscriptFileContent,
  TranscriptFileInfo,
  TranscriptHistoryContext,
  TranscriptLocator,
  TranscriptMessage,
  TranscriptSessionInfo,
  TranscriptStore,
  TranscriptTextResult,
  TranscriptToolResult
} from '../types.js'
import { loadBackendPaths, loadCompatTable } from './compat.js'
import { measureToolResult, toolUsePayload } from './parse.js'

/** Upper bound for one file. For a transcript over it, only the head is read. */
const MAX_FILE_BYTES = 16 * 1024 * 1024
/** Upper bound when returning a tool result. It is only shown in the timeline, so it is not made large. */
const MAX_TOOL_RESULT_BYTES = 64 * 1024
/** How much to read at once when looking for a tool result (TODO 1126, `scanLines`). There is no limit on the whole file. */
const SCAN_CHUNK_BYTES = 1024 * 1024
/**
 * How many files' results to keep after falling back to a full parse (item 78). For an old line with no location or
 * a rewritten file, the hits of one search cluster on the same file, so a few files' worth
 * turns "50 hits = 50 parses" into 1.
 */
const FALLBACK_CACHE_FILES = 4
/**
 * The head and tail lengths read for the list summary (item 111). The head has the session id, cwd and first message, and the tail has
 * the last response's model. The backend's title (the `ai-title` line) is written after the first response,
 * so it usually falls in the head (if not, it is picked up from the tail, and if that fails the first message is shown).
 */
const SUMMARY_HEAD_BYTES = 64 * 1024
const SUMMARY_TAIL_BYTES = 64 * 1024
/** Length of the "first message" in the list. */
const FIRST_PROMPT_CHARS = 160
/** How many parse results of the past part (`readHistory`) to keep. So that every line is not re-read on each page turn. */
const HISTORY_CACHE_FILES = 4

interface RawLine {
  readonly type?: string
  readonly uuid?: string
  readonly timestamp?: string
  readonly sessionId?: string
  readonly cwd?: string
  /** A subagent's line (item 111: shown neither in the list nor in the past part). */
  readonly isSidechain?: boolean
  /** An internal line (command output etc.). Not shown in the past part. */
  readonly isMeta?: boolean
  /** The `ai-title` line: the title the backend assigned. */
  readonly aiTitle?: string
  readonly message?: { readonly role?: string; readonly content?: unknown; readonly model?: unknown }
}

/**
 * Whether it can be used as the list's "first message". Subagent lines, internal lines, and command wrappers
 * (body strings starting with `<command-name>` etc.) are not used.
 */
function promptTextOf(line: RawLine): string | null {
  if (line.type !== 'user' || line.isSidechain === true || line.isMeta === true) return null
  const content = line.message?.content
  if (typeof content === 'string') {
    return content.trimStart().startsWith('<') || content.trim() === '' ? null : content
  }
  const text = textOf(content)
  return text === '' ? null : text
}

/** The head for display, clipped to one line. */
function headline(text: string, max: number): string {
  const first = text.replace(/\s+/g, ' ').trim()
  return first.length > max ? `${first.slice(0, max)}…` : first
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    // **`thinking` and `tool_result` are not taken** (4.3.1 / constraint 10).
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text'])
    }
  }
  return parts.join('\n').trim()
}

/** The number of `image` blocks in a user row (TODO 878). The contents (base64) are not touched. */
export function imageBlockCount(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter((b) => isBlock(b, 'image')).length
}

function toolResultOf(content: unknown, toolUseId: string): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'tool_result' || record['tool_use_id'] !== toolUseId) continue
    const inner = record['content']
    if (typeof inner === 'string') return inner
    if (Array.isArray(inner)) {
      const parts: string[] = []
      for (const item of inner) {
        if (typeof item === 'object' && item !== null) {
          const value = (item as Record<string, unknown>)['text']
          if (typeof value === 'string') parts.push(value)
        }
      }
      return parts.join('\n')
    }
    return JSON.stringify(inner ?? null)
  }
  return null
}

/** A version for change detection (mtime+size). `listFiles` and the location record use the same expression. */
function versionOf(stats: { readonly mtimeMs: number; readonly size: number }): string {
  return `${Math.round(stats.mtimeMs)}:${stats.size}`
}

/** The inverse of `versionOf`, taking out only the size. Used to judge whether the file merely grew by appending. */
function sizeOfVersion(version: string): number | null {
  const at = version.lastIndexOf(':')
  if (at < 0) return null
  const size = Number(version.slice(at + 1))
  return Number.isSafeInteger(size) && size >= 0 ? size : null
}

/** The transcript's URI. Given the same shape in `listFiles` and `readMessages`. */
function uriOf(fileId: string): string {
  return `transcript://${encodeURI(fileId)}`
}

interface ParsedLine {
  readonly line: RawLine
  /** The byte position of the line start, and the byte length of the line without the newline. **Not a character count.** */
  readonly offset: number
  readonly length: number
}

function parseLine(text: string): RawLine | null {
  if (text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as RawLine) : null
  } catch {
    // A line that is mid-write. Skip it.
    return null
  }
}

/**
 * Splits the buffer into lines at newlines (0x0a) and parses them. **Positions are counted in bytes**: if it were
 * turned into a string before splitting, positions would shift after a line with Japanese or emoji (one UTF-8 character is
 * 1 to 4 bytes).
 */
function parseBuffer(buffer: Buffer): ParsedLine[] {
  const out: ParsedLine[] = []
  let start = 0
  while (start < buffer.length) {
    let end = buffer.indexOf(0x0a, start)
    if (end < 0) end = buffer.length
    if (end > start) {
      const line = parseLine(buffer.toString('utf8', start, end))
      if (line !== null) out.push({ line, offset: start, length: end - start })
    }
    start = end + 1
  }
  return out
}

function toMessage(line: RawLine, offset: number, length: number): TranscriptMessage | null {
  if (line.type !== 'user' && line.type !== 'assistant') return null
  const uuid = line.uuid
  if (typeof uuid !== 'string') return null
  const text = textOf(line.message?.content)
  if (text === '') return null
  return {
    id: uuid,
    role: line.type,
    text,
    ts: line.timestamp === undefined ? 0 : Date.parse(line.timestamp) || 0,
    sessionId: typeof line.sessionId === 'string' ? line.sessionId : '',
    offset,
    length
  }
}

/** Reads from the start up to the limit. For a transcript over it, only the head is handled (as before). */
async function readHead(handle: FileHandle, size: number): Promise<Buffer> {
  const want = Math.min(size, MAX_FILE_BYTES)
  const buffer = Buffer.alloc(want)
  let filled = 0
  while (filled < want) {
    const { bytesRead } = await handle.read(buffer, filled, want - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

/**
 * Streams the file from the start and passes only the lines (newline excluded) containing `needle` to `visit` (TODO 1126). When `visit` returns
 * non-null, reading stops there and that value is returned. The whole file is never made one Buffer, so there is no size limit (only the longest single line is needed).
 * Null if not found. Rejects when it cannot be opened or read.
 */
async function scanLines<T>(path: string, needle: Buffer, visit: (line: Buffer) => T | null): Promise<T | null> {
  const stream = createReadStream(path, { highWaterMark: SCAN_CHUNK_BYTES })
  // A fragment of a line continuing from the previous chunk (the part before a newline has arrived).
  let carry: Buffer[] = []
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0
      let newline = chunk.indexOf(0x0a, start)
      while (newline >= 0) {
        const piece = chunk.subarray(start, newline)
        const line = carry.length === 0 ? piece : Buffer.concat([...carry, piece])
        carry = []
        if (line.includes(needle)) {
          const value = visit(line)
          if (value !== null) return value
        }
        start = newline + 1
        newline = chunk.indexOf(0x0a, start)
      }
      if (start < chunk.length) carry.push(chunk.subarray(start))
    }
    // The last line, which does not end with a newline (still being written).
    if (carry.length > 0) {
      const line = Buffer.concat(carry)
      if (line.includes(needle)) return visit(line)
    }
    return null
  } finally {
    stream.destroy()
  }
}

/**
 * Reads `bytes` bytes of the tail and returns it from after the first newline (dropping the line read from the middle).
 * Used only to pick up the last response's model for the list summary (item 111).
 */
async function readTail(handle: FileHandle, size: number, bytes: number): Promise<Buffer> {
  const start = Math.max(0, size - bytes)
  const buffer = Buffer.alloc(size - start)
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  const whole = buffer.subarray(0, filled)
  if (start === 0) return whole
  const newline = whole.indexOf(0x0a)
  return newline < 0 ? whole.subarray(0, 0) : whole.subarray(newline + 1)
}

/** The inverse of `uriOf`: takes the fileId out of `transcript://<encodeURI(fileId)>[/<messageId>]`. */
function fileIdOfUri(uri: string): string | null {
  const prefix = 'transcript://'
  if (!uri.startsWith(prefix)) return null
  let rest: string
  try {
    rest = decodeURI(uri.slice(prefix.length))
  } catch {
    return null
  }
  // A file id has two segments, `<project>/<name>.jsonl`. The third and later segments are the message id.
  const segments = rest.split('/')
  if (segments.length < 2) return null
  return `${segments[0]}/${segments[1]}`
}

/**
 * Turns transcript lines into timeline events (item 111, 4.5.9). They have the same `message.content` shape as stream-json's `assistant` /
 * `user` rows, so a tool call's summary is built with the same `toolUsePayload` as `parse.ts`. **`tool_result` is length only** (the body is
 * read from the canonical copy when restoring an "omitted" one: constraint 10). Subagent lines and internal lines are not shown. Lines after
 * the read cutoff (`limit`) are not shown either.
 */
function historyEvents(
  lines: readonly ParsedLine[],
  ctx: TranscriptHistoryContext,
  limit: number
): readonly AiosEvent[] {
  const out: AiosEvent[] = []
  for (const { line, offset, length } of lines) {
    if (offset + length > limit) break
    if (line.isSidechain === true || line.isMeta === true) continue
    if (line.type !== 'user' && line.type !== 'assistant') continue
    const uuid = typeof line.uuid === 'string' ? line.uuid : String(offset)
    const ts = line.timestamp === undefined ? 0 : Date.parse(line.timestamp) || 0
    let n = 0
    const base = () => ({
      id: `${TRANSCRIPT_EVENT_ID_PREFIX}${uuid}:${n++}`,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ts,
      actor: 'main' as const
    })
    const content = line.message?.content
    if (line.type === 'user') {
      if (Array.isArray(content) && content.some((b) => isBlock(b, 'tool_result'))) {
        for (const block of content) {
          if (!isBlock(block, 'tool_result')) continue
          const measured = measureToolResult(block['content'])
          out.push({
            ...base(),
            kind: 'tool_result',
            payload: {
              toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '',
              ok: block['is_error'] !== true,
              bytes: measured.bytes
            }
          })
        }
        continue
      }
      const prompt = promptTextOf(line)
      // TODO 878: unnamed badges, only as many as the image blocks. The base64 is read and discarded (constraints 9 / 10).
      const images = imageBlockCount(content)
      if (prompt !== null || images > 0) {
        const attachments = images === 0 ? {} : { attachments: Array.from({ length: images }, () => ({ name: '' })) }
        out.push({
          ...base(),
          kind: 'user_text',
          payload: { text: prompt ?? '', ...attachments, messageId: uuid }
        })
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isBlock(block, 'text')) {
        const text = typeof block['text'] === 'string' ? block['text'] : ''
        if (text.trim() === '') continue
        out.push({ ...base(), kind: 'assistant_text', payload: { text, messageId: uuid } })
      } else if (isBlock(block, 'tool_use')) {
        out.push({
          ...base(),
          kind: 'tool_use',
          payload: toolUsePayload(
            typeof block['name'] === 'string' ? block['name'] : '?',
            typeof block['id'] === 'string' ? block['id'] : '',
            block['input'],
            'main',
            uuid
          )
        })
      }
    }
  }
  return out
}

function isBlock(value: unknown, type: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['type'] === type
}

function isLocator(value: TranscriptLocator | null | undefined): value is TranscriptLocator {
  return (
    value !== null &&
    value !== undefined &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    Number.isSafeInteger(value.length) &&
    value.length > 0 &&
    value.length <= MAX_FILE_BYTES &&
    typeof value.version === 'string'
  )
}

/** Why reading by location failed (the structured log's `reason`). */
type MissReason =
  | 'no-locator'
  | 'rewritten'
  | 'out-of-range'
  | 'short-read'
  | 'mismatch'
  | 'unreadable'

export class TranscriptReader implements TranscriptStore {
  private readonly root: string
  /**
   * `fileId`s confirmed to be ENOENT (item 241). From the second `load()` of the same file on,
   * `transcript.read.failed` is not warned (when one conversation search has dozens of hits to a vanished file,
   * the same warning was emitted that many times: the observation in 233 was 24). Unlike the unbounded `fallbackCache`,
   * this is a `Set` of strings only, small enough to keep for the whole life of a process (the number of transcript files is at most a few hundred to a few thousand).
   */
  private readonly missingFiles = new Set<string>()

  constructor(home: string = homedir()) {
    const configured = loadBackendPaths().transcriptDir
    this.root = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  }

  /** Turns `<project directory>/<session>.jsonl` into an absolute path. */
  private pathOf(fileId: string): string | null {
    const full = resolve(this.root, fileId)
    // Never go outside the transcript directory.
    if (full !== this.root && !full.startsWith(this.root + sep)) return null
    if (!full.endsWith('.jsonl')) return null
    return full
  }

  async listFiles(): Promise<readonly TranscriptFileInfo[]> {
    const files: TranscriptFileInfo[] = []
    let projects: string[]
    try {
      projects = await readdir(this.root)
    } catch {
      // An environment with no transcripts (the CLI has never been used) gives empty.
      return files
    }
    for (const project of projects) {
      let names: string[]
      try {
        names = await readdir(join(this.root, project))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const id = `${project}/${name}`
        const full = join(this.root, project, name)
        try {
          const stats = await stat(full)
          files.push({ id, uri: uriOf(id), version: versionOf(stats), mtimeMs: stats.mtimeMs })
        } catch {
          // Skip vanished files.
        }
      }
    }
    return files
  }

  async readMessages(fileId: string): Promise<TranscriptFileContent | null> {
    return this.load(fileId, null)
  }

  /**
   * The body of one message (for snippets and `getDocumentText`, item 78).
   *
   * If there is a `locator`, **partially read just that one line and `JSON.parse` once**.
   * It is accepted only if the read line's `uuid` equals `messageId`. Even if the file's version
   * differs from the record, if **only the size grew (= an append)** the bytes of existing lines do not move, so
   * it is used with the same check (the transcript of a session in progress has exactly this shape, and the version changes every turn).
   * When it shrank, the version's shape cannot be read, the check fails, or there is no location (a line from before item 78),
   * it falls back to a full parse and returns `stale: true`, a signal for the caller to re-ingest that file.
   */
  async readMessageText(
    fileId: string,
    messageId: string,
    locator?: TranscriptLocator | null
  ): Promise<TranscriptTextResult> {
    let reason: MissReason = 'no-locator'
    if (isLocator(locator)) {
      const direct = await this.readAt(fileId, messageId, locator)
      if (typeof direct === 'string') return { text: direct, stale: false, missing: false }
      reason = direct.reason
    }
    const content = await this.load(fileId, reason)
    if (content === null) return { text: null, stale: false, missing: this.missingFiles.has(fileId) }
    const found = content.messages.find((message) => message.id === messageId)
    return { text: found?.text ?? null, stale: true, missing: false }
  }

  /** The number of full parses (for tests and bench). Reads by location are not counted. */
  get fullParseCount(): number {
    return this.parses
  }

  private parses = 0
  /** `(fileId, version) → parse result`. The Map's insertion order is used as the LRU order. */
  private readonly fallbackCache = new Map<string, Promise<TranscriptFileContent>>()

  /** Reads one line according to its location. If it cannot be read, returns the reason. */
  private async readAt(
    fileId: string,
    messageId: string,
    locator: TranscriptLocator
  ): Promise<string | { reason: MissReason }> {
    const path = this.pathOf(fileId)
    if (path === null) return { reason: 'unreadable' }
    let handle: FileHandle
    try {
      handle = await open(path, 'r')
    } catch {
      return { reason: 'unreadable' }
    }
    try {
      const stats = await handle.stat()
      if (versionOf(stats) !== locator.version) {
        const recorded = sizeOfVersion(locator.version)
        if (recorded === null || stats.size < recorded) return { reason: 'rewritten' }
      }
      if (locator.offset + locator.length > stats.size) return { reason: 'out-of-range' }
      const buffer = Buffer.alloc(locator.length)
      const { bytesRead } = await handle.read(buffer, 0, locator.length, locator.offset)
      if (bytesRead !== locator.length) return { reason: 'short-read' }
      const line = parseLine(buffer.toString('utf8'))
      const message = line === null ? null : toMessage(line, locator.offset, locator.length)
      if (message === null || message.id !== messageId) return { reason: 'mismatch' }
      return message.text
    } catch {
      return { reason: 'unreadable' }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Opens one file and fully parses it. If `reason` is null this is ingestion: it consults the LRU but does not
   * add to it (running the LRU during the ingestion of all files at startup is pointless).
   * If not null it is a fallback where the location was unusable: the result is added to the LRU, and
   * the reason is written to the structured log only when it actually parsed (so 50 hits of one search do not emit 50 lines).
   */
  private async load(
    fileId: string,
    reason: MissReason | null
  ): Promise<TranscriptFileContent | null> {
    const path = this.pathOf(fileId)
    if (path === null) return null
    let handle: FileHandle
    try {
      handle = await open(path, 'r')
    } catch (err) {
      this.warnReadFailed(fileId, err)
      return null
    }
    try {
      const stats = await handle.stat()
      const version = versionOf(stats)
      const key = `${fileId}\n${version}`
      const cached = this.fallbackCache.get(key)
      if (cached !== undefined) {
        this.fallbackCache.delete(key)
        this.fallbackCache.set(key, cached)
        return await cached
      }
      const parsing = this.parse(handle, fileId, version, stats.size)
      if (reason !== null) {
        log.info('transcript.offset.fallback', { file: fileId, reason, bytes: stats.size })
        this.fallbackCache.set(key, parsing)
        while (this.fallbackCache.size > FALLBACK_CACHE_FILES) {
          const oldest = this.fallbackCache.keys().next().value
          if (oldest === undefined) break
          this.fallbackCache.delete(oldest)
        }
        parsing.catch(() => this.fallbackCache.delete(key))
      }
      return await parsing
    } catch (err) {
      this.warnReadFailed(fileId, err)
      return null
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Emits `transcript.read.failed` (item 241). ENOENT (the file is missing) is emitted per `fileId`
   * **only the first time**: when search hits remain for a transcript deleted in a terminal or swept by the CLI,
   * the same warning was emitted that many times (the observation in 233: 24 in one search).
   * Only that one time needs to go into `missingFiles` (`readMessageText` only checks whether it is in the Set).
   * Anything other than ENOENT (EACCES, broken JSON, etc.) is emitted every time as it is: it may be temporary,
   * and we do not decide to drop it from the index either.
   */
  private warnReadFailed(fileId: string, err: unknown): void {
    const isEnoent = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (isEnoent) {
      if (this.missingFiles.has(fileId)) return
      this.missingFiles.add(fileId)
    }
    log.warn('transcript.read.failed', { file: fileId, ...errorFields(err) })
  }

  private async parse(
    handle: FileHandle,
    fileId: string,
    version: string,
    size: number
  ): Promise<TranscriptFileContent> {
    const buffer = await readHead(handle, size)
    this.parses += 1
    const messages: TranscriptMessage[] = []
    let sessionId: string | null = null
    for (const { line, offset, length } of parseBuffer(buffer)) {
      if (sessionId === null && typeof line.sessionId === 'string') sessionId = line.sessionId
      const message = toMessage(line, offset, length)
      if (message !== null) messages.push(message)
    }
    return { id: fileId, uri: uriOf(fileId), version, sessionId, messages }
  }

  // ---- Continuing a terminal / VS Code conversation (item 111, 4.5.9) ----

  /** `(fileId) → (version, summary)`. Not re-read if the version is the same. */
  private readonly summaryCache = new Map<string, { version: string; info: TranscriptSessionInfo }>()

  async listSessions(): Promise<readonly TranscriptSessionInfo[]> {
    const out: TranscriptSessionInfo[] = []
    for (const file of await this.listFiles()) {
      const info = await this.describe(file.id)
      if (info !== null) out.push(info)
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  }

  async findSession(sessionId: string): Promise<TranscriptSessionInfo | null> {
    for (const info of await this.listSessions()) {
      if (info.sessionId === sessionId) return info
    }
    return null
  }

  async describeUri(uri: string): Promise<TranscriptSessionInfo | null> {
    const fileId = fileIdOfUri(uri)
    return fileId === null ? null : this.describe(fileId)
  }

  /**
   * The summary of one transcript. Reads only the head and tail (the list has hundreds, and reading every line would be hundreds of MB).
   * A subagent's transcript (all the conversation lines at the head are sidechain) and a transcript whose session id cannot be read give null.
   */
  private async describe(fileId: string): Promise<TranscriptSessionInfo | null> {
    const path = this.pathOf(fileId)
    if (path === null) return null
    let handle: FileHandle
    try {
      handle = await open(path, 'r')
    } catch {
      return null
    }
    try {
      const stats = await handle.stat()
      const version = versionOf(stats)
      const cached = this.summaryCache.get(fileId)
      if (cached !== undefined && cached.version === version) return cached.info
      const head = parseBuffer(await readHead(handle, Math.min(stats.size, SUMMARY_HEAD_BYTES)))
      const tail =
        stats.size > SUMMARY_HEAD_BYTES
          ? parseBuffer(await readTail(handle, stats.size, SUMMARY_TAIL_BYTES))
          : head
      let sessionId: string | null = null
      let cwd: string | null = null
      let firstPrompt = ''
      let title: string | null = null
      let model: string | null = null
      let conversation = 0
      let sidechain = 0
      for (const { line } of head) {
        if (sessionId === null && typeof line.sessionId === 'string') sessionId = line.sessionId
        if (cwd === null && typeof line.cwd === 'string' && line.cwd !== '') cwd = line.cwd
        if (line.type === 'user' || line.type === 'assistant') {
          conversation += 1
          if (line.isSidechain === true) sidechain += 1
        }
        if (firstPrompt === '') {
          const prompt = promptTextOf(line)
          if (prompt !== null) firstPrompt = headline(prompt, FIRST_PROMPT_CHARS)
        }
        if (typeof line.aiTitle === 'string' && line.aiTitle.trim() !== '') title = line.aiTitle.trim()
      }
      const synthetic = loadCompatTable().streamEvents?.syntheticModel
      for (const { line } of tail) {
        if (typeof line.aiTitle === 'string' && line.aiTitle.trim() !== '') title = line.aiTitle.trim()
        if (line.type !== 'assistant' || line.isSidechain === true) continue
        const reported = line.message?.model
        if (typeof reported === 'string' && reported !== '' && reported !== synthetic) model = reported
      }
      // If there is not a single conversation line (writing has just begun), or all are subagent lines, do not show it.
      if (sessionId === null || conversation === 0 || sidechain === conversation) return null
      const info: TranscriptSessionInfo = {
        id: fileId,
        uri: uriOf(fileId),
        sessionId,
        cwd,
        title,
        firstPrompt,
        model,
        mtimeMs: stats.mtimeMs,
        size: stats.size
      }
      this.summaryCache.set(fileId, { version, info })
      return info
    } catch (err) {
      log.warn('transcript.describe.failed', errorFields(err))
      return null
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /** `(fileId, version, limit, threadId) → past part`. So that every line is not re-read on each page turn. */
  private readonly historyCache = new Map<string, Promise<readonly AiosEvent[]>>()

  async readHistory(
    fileId: string,
    ctx: TranscriptHistoryContext,
    limit: number
  ): Promise<readonly AiosEvent[] | null> {
    const path = this.pathOf(fileId)
    if (path === null) return null
    let handle: FileHandle
    try {
      handle = await open(path, 'r')
    } catch {
      return null
    }
    try {
      const stats = await handle.stat()
      // After the read cutoff (`limit`) are aios's own lines. If the file shrank (was rewritten), only up to there.
      const want = Math.max(0, Math.min(limit, stats.size, MAX_FILE_BYTES))
      const key = `${fileId}\n${versionOf(stats)}\n${want}\n${ctx.threadId}`
      const cached = this.historyCache.get(key)
      if (cached !== undefined) {
        this.historyCache.delete(key)
        this.historyCache.set(key, cached)
        return await cached
      }
      const parsing = readHead(handle, want).then((buffer) =>
        historyEvents(parseBuffer(buffer), ctx, want)
      )
      this.historyCache.set(key, parsing)
      while (this.historyCache.size > HISTORY_CACHE_FILES) {
        const oldest = this.historyCache.keys().next().value
        if (oldest === undefined) break
        this.historyCache.delete(oldest)
      }
      parsing.catch(() => this.historyCache.delete(key))
      return await parsing
    } catch (err) {
      log.warn('transcript.history.failed', errorFields(err))
      return null
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Reads, from the canonical copy, a tool result that the timeline shows as "omitted (N KB)" (4.3.1).
   * **Not put in the index or the DB**: it is only read on the spot for display (constraint 10).
   */
  async findToolResult(
    backendSessionId: string,
    toolUseId: string
  ): Promise<TranscriptToolResult | null> {
    let projects: string[]
    try {
      projects = await readdir(this.root)
    } catch {
      return null
    }
    // TODO 1126: do not cut at the first 16 MB (`readHead`); stream the whole file one line at a time. Only lines containing the id are parsed
    // (so 16 MB is not fed to a synchronous `JSON.parse` on every click). The longer the conversation, the further back the recent results are.
    const needle = Buffer.from(toolUseId, 'utf8')
    if (needle.length === 0) return null
    for (const project of projects) {
      const path = join(this.root, project, `${backendSessionId}.jsonl`)
      let text: string | null
      try {
        text = await scanLines(path, needle, (raw) => {
          const line = parseLine(raw.toString('utf8'))
          return line === null || line.type !== 'user' ? null : toolResultOf(line.message?.content, toolUseId)
        })
      } catch {
        continue
      }
      if (text === null) continue
      const bytes = Buffer.byteLength(text, 'utf8')
      return {
        text: Buffer.from(text, 'utf8').subarray(0, MAX_TOOL_RESULT_BYTES).toString('utf8'),
        bytes,
        truncated: bytes > MAX_TOOL_RESULT_BYTES
      }
    }
    return null
  }
}
