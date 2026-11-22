/**
 * The layer that moves the ViewerPane's reads and writes onto the Broker (ARCHITECTURE.md 5.2 / 7.4 / 7.7).
 *
 * In Phases 1 to 3 the ViewerPane called `FsService.readResource` / `writeTextFile` directly (both were removed later).
 * Phase 4 makes explicit **which viewer plugin a read or write is for**
 * and sends it through the CapabilityBroker's path checks and audit log.
 *
 * ```
 * ViewerPane (renderer)         main
 *   viewer.open(uri)     ──►  PluginHost.resolveViewer + Broker.grantOpen
 *   viewer.read(id, uri) ──►  Broker.fs           ──► realpath / exclusion / TOCTOU
 *                        └►  (delivery = url) Broker.resourceUrlFor ──► aios-res://local/<token>/…
 *   viewer.write(...)    ──►  Broker.fs (write)   ──► same + O_NOFOLLOW
 *   viewer.close(id, uri)──►  Broker.revokeOpen   ──► drop the grant and the token (review D-3)
 * ```
 *
 * **The viewer itself does no I/O** (5.2), so viewer-side code is
 * unaffected by this move. That is where 5.2's aim pays off.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  readSync,
  realpathSync,
  writeSync
} from 'node:fs'
import type { ResolvedViewer, ViewerImageConversion } from '@shared/plugin.js'
import type { TextWriteResult, ViewerResource } from '@shared/types.js'
import { log, errorFields } from '../../common/logger.js'
import { pathToUri } from '../../common/uri.js'
import { resourceTokenOf } from '@shared/uri.js'
import { isGitRepositoryUri } from '@shared/plugin-git.js'
import { convertBytesForDisplay, type ConvertDeps } from '../image/display.js'
import { EMBEDDABLE_SNIFF_BYTES, sniffEmbeddableImage } from '../paste/temp-image.js'
import { parseCellEdits } from '@shared/xlsx-cells.js'
import type { AuditLog } from './audit.js'
import { applyCellEdits, XlsxCellsError } from './xlsx-cells-write.js'
import type { CapabilityBroker } from './broker.js'
import type { ViewerFileWatcher } from './viewer-watch.js'
import {
  PathDenied,
  openChecked,
  pathDenialCode,
  pathFromUri,
  resolvePath,
  type PathAccess,
  type PathScope
} from '../../common/fs-policy.js'

/** Upper bound of text loaded into the editor (unchanged since Phase 1). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** The longest prefix of at most `max` bytes that ends on a character boundary, decoded (a cut inside a multi-byte character would end in U+FFFD). */
export function utf8Prefix(bytes: Buffer, max: number): string {
  let end = Math.min(max, bytes.byteLength)
  // The prefix ends on a boundary unless the next byte is a continuation (10xxxxxx): then step back to that character's lead byte and drop the character whole.
  for (let steps = 0; steps < 3 && end > 0 && end < bytes.byteLength && ((bytes[end] as number) & 0xc0) === 0x80; steps += 1) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Upper bound on the size of an `.xlsx` whose cell values are written (TODO 1212 stage 1). The same as the limit the viewer displays (`MAX_OFFICE_BYTES` of `aios.office`).
 * A write reads the whole file and rebuilds it, so what cannot be displayed is not written.
 */
export const MAX_CELL_EDIT_FILE_BYTES = 32 * 1024 * 1024

/**
 * Adds `mtimeMs` to the query so that a viewer that receives a URL by delivery (image, PDF, video) fetches again even when it re-reads
 * (code-review fix, serious item 6). `resourceUrlFor` reuses the same token while the (pluginId, path) is the same
 * (since PDF range requests and the like fetch many times), so the token alone leaves `<img src>` /
 * `<video src>` unchanged, and browser caching keeps the stale contents.
 * `resourceTokenOf` (`shared/uri.ts`) cuts at the first `/` `?` `#` right after the token,
 * so adding a query after the name does not break the serving side's token extraction.
 */
export function withCacheBust(resourceUrl: string, mtimeMs: number): string {
  return `${resourceUrl}?m=${Math.round(mtimeMs)}`
}

/**
 * In `read()`, only the latest of each generation calls `watch.track` (code-review fix, serious item 5). A text
 * read goes through `await this.deps.broker.handle(...)` (binary / url-delivery reads do not), so
 * when switching quickly to another file in the same window (`viewId`), a fast read that started later (binary and the like)
 * can call `track` first, and the `track` of the earlier read that finishes late can overwrite it **in completion order**
 * (reverting to watching the old file regardless of call order). So at the start of `read()` (before any await) a
 * generation is taken with `begin`, and right before calling `track`, `isLatest` checks whether it is still the latest generation.
 *
 * A pure state machine split out of `ViewerBroker` (`test/viewer-read-generation.test.ts` tests it directly,
 * without having to create real `await` ordering jitter).
 */
export class ReadGenerationTracker {
  private readonly generation = new Map<number, number>()

  /** Call when starting a read. If `viewId` is absent (omitted), returns 0, which is always treated as "not the latest". */
  begin(viewId: number | undefined): number {
    if (viewId === undefined) return 0
    const next = (this.generation.get(viewId) ?? 0) + 1
    this.generation.set(viewId, next)
    return next
  }

  /** Check right before calling `track`. Always false if `viewId` is absent. */
  isLatest(viewId: number | undefined, generation: number): boolean {
    if (viewId === undefined) return false
    return this.generation.get(viewId) === generation
  }
}

export interface ViewerBrokerDeps {
  readonly broker: CapabilityBroker
  readonly audit: AuditLog
  readonly scope: Omit<PathScope, 'roots'>
  readonly resolveViewer: (uri: string) => ResolvedViewer | null
  /**
   * The resolution result when opened with a specified viewer (TODO 907, `PluginHost.resolveViewerWith`). Used so that `read` decides the delivery (text / url)
   * by **the viewer that came to read** rather than "the current default viewer" (so a re-read after the default was changed in another window
   * keeps the delivery of the viewer that was opened). If omitted, the result of `resolveViewer` is used only when it is that plugin (as before).
   */
  readonly resolveViewerWith?: (uri: string, pluginId: string) => ResolvedViewer | null
  /**
   * The watch that detects rewrites by external tools (TODO 673). **If omitted, nothing is watched**: existing tests
   * call `read` / `write` directly without passing `viewId`, so nothing breaks.
   */
  readonly watch?: Pick<ViewerFileWatcher, 'track' | 'settle' | 'untrack'>
  /** Temporary directory and the like for image conversion for display (TODO 1162). If omitted, `convertImageForDisplay` is always `failed`. */
  readonly imageConvert?: ConvertDeps
}

export class ViewerBroker {
  private readonly readGeneration = new ReadGenerationTracker()

  constructor(private readonly deps: ViewerBrokerDeps) {}

  /**
   * The operation `image.convertForDisplay` (TODO 1162): turns the bytes of a temporary-view image (a `.heic` inside a zip) into a JPEG for display.
   * It has no file, so it does not go through `aios-res://`, and 1154's conversion did not apply. Here it **checks the type (extension + the ftyp of the contents), the size, and
   * the supported OS** (`convertBytesForDisplay`), and records the decision in the audit under the name `aios.image`. The input opens no path
   * (it only writes a new file in a temporary directory). The conversion result is only returned and kept nowhere (constraints 9 / 10).
   * Values from the renderer are not trusted: a wrong type gives `failed`. The target (`target`) is only the last element of the name.
   */
  async convertImageForDisplay(name: unknown, bytes: unknown): Promise<ViewerImageConversion> {
    const started = Date.now()
    const base = typeof name === 'string' ? (name.split(/[/\\]/).filter((part) => part !== '').pop() ?? '').slice(0, 256) : ''
    const record = (decision: 'allow' | 'deny', reason: string | null): void => {
      this.deps.audit.record({
        at: started,
        pluginId: 'aios.image',
        capability: 'image',
        op: 'convertForDisplay',
        target: base,
        decision,
        reason,
        ms: Date.now() - started
      })
    }
    let result: ViewerImageConversion = { ok: false, reason: 'failed' }
    if (this.deps.imageConvert !== undefined && typeof name === 'string' && bytes instanceof Uint8Array) {
      result = await convertBytesForDisplay(bytes, name, this.deps.imageConvert)
    }
    if (result.ok) record('allow', null)
    else record('deny', result.reason)
    return result
  }

  /**
   * The ViewerPane closed completely (TODO 673, code-review fix, the first half of serious item 7). The renderer calls this when `uri` became null or
   * the viewer itself was folded (`viewerOpen` is false). It is a new one-way notice (`viewerUntrackWatch`) separate from 471's probe
   * (`viewer.open` -> immediately `viewer.close`), so it cannot be confused with the probe. When only switching to another file, the `track()` of that `read()`
   * releases the previous watch by itself, so there is no need to call this (calling it does no harm; it is idempotent).
   */
  closeView(viewId: number): void {
    this.deps.watch?.untrack(viewId)
  }

  /**
   * Resolves the viewer for a URI and **at the same time grants that plugin read access** (7.2).
   * Even if the renderer passes a false URI, the grant itself goes through the policy, so the scope does not widen.
   */
  open(uri: string): ResolvedViewer | null {
    const viewer = this.deps.resolveViewer(uri)
    if (viewer === null) return null
    // TODO 834: a folder opened in the Source Control view grants that folder to the git viewer's extension (the Broker checks the declaration,
    // the file policy and that it is a directory). There is no body: the viewer reads through its own git capability.
    if (isGitRepositoryUri(uri)) {
      if (viewer.delivery !== 'text') return null
      try {
        this.deps.broker.grantRepository(viewer.pluginId, uri)
      } catch (err) {
        log.warn('viewer.open.denied', { pluginId: viewer.pluginId, ...errorFields(err) })
        return null
      }
      return viewer
    }
    // TODO 1280: a document uri of an extension's own scheme (a row of its sidebar list) has no file to grant. The contents come from `readOwnDocument` in `read`.
    if (!uri.startsWith('file://')) return viewer.delivery === 'text' ? viewer : null
    try {
      this.deps.broker.grantOpen(viewer.pluginId, uri)
    } catch (err) {
      log.warn('viewer.open.denied', { pluginId: viewer.pluginId, ...errorFields(err) })
      return null
    }
    const linkTargetUri = linkTargetOf(uri)
    return linkTargetUri === null ? viewer : { ...viewer, linkTargetUri }
  }

  /**
   * The `aios-res://` URL for an image sent from the timeline (TODO 550). null if refused (the reason goes only to the log).
   * An entry point for the app's own `<img>`, which does not go through a viewer plugin.
   */
  hostImageUrl(uri: string): string | null {
    try {
      return this.deps.broker.hostImageUrlFor(uri)
    } catch (err) {
      log.debug('timeline.image.denied', errorFields(err))
      return null
    }
  }

  /**
   * The `aios-res://` URL for a local image inside an answer's Markdown (TODO 876). In addition to `hostImageUrl`,
   * **it confirms by the leading magic bytes that it is an image** (so a text file that is `.png` only by name, or credentials, are not shown).
   * The confirmation reads from the fd the Broker checked and opened (already O_NOFOLLOW + fstat, `openResource`),
   * so it looks only at the head of a file that passed the same decision as serving. null if refused (the reason goes only to the log).
   */
  timelineImageUrl(uri: string): string | null {
    const url = this.hostImageUrl(uri)
    if (url === null) return null
    const token = resourceTokenOf(url)
    if (token === null) return null
    try {
      const opened = this.deps.broker.openResource(token)
      try {
        const head = Buffer.alloc(EMBEDDABLE_SNIFF_BYTES)
        const read = readSync(opened.fd, head, 0, head.length, 0)
        if (sniffEmbeddableImage(head.subarray(0, read)) === null) {
          log.debug('timeline.image.not-image', {})
          return null
        }
        return url
      } finally {
        closeSync(opened.fd)
      }
    } catch (err) {
      log.debug('timeline.image.denied', errorFields(err))
      return null
    }
  }

  /**
   * The ViewerPane closed a URI / switched to another URI (review D-3). Returns one of the "URI the user has open right now"
   * (7.2) grants and also invalidates that URI's `aios-res://` token.
   * If the same file is also open in another window, that many grants remain (the Broker counts them).
   */
  close(pluginId: string, uri: string): void {
    if (isGitRepositoryUri(uri)) this.deps.broker.revokeRepository(pluginId, uri)
    else this.deps.broker.revokeOpen(pluginId, uri)
  }

  /**
   * The contents handed to the viewer. **Whether to pass a URL instead of the body is decided by the viewer's manifest** (review C-2):
   * "an extension the viewer claimed in `extensions`, and it does not edit" means an `aios-res://` URL.
   * It used to keep a separate table of image extensions (`IMAGE_EXTS`) here, so adding a PDF viewer
   * only produced a `binary` error.
   */
  async read(pluginId: string, uri: string, viewId?: number): Promise<ViewerResource> {
    // Code-review fix (serious item 5): take the generation before the await. The `track` after the await is called
    // only while this read is still the latest (even if completion order overtakes call order through a quick switch in the same `viewId`,
    // an old read does not trample the watch of a new read).
    const generation = this.readGeneration.begin(viewId)
    try {
      const resolvedViewer =
        this.deps.resolveViewerWith !== undefined
          ? this.deps.resolveViewerWith(uri, pluginId)
          : this.deps.resolveViewer(uri)
      // TODO 834: the Source Control view has no body (the folder is in the URI; the extension reads through `git.*`). Only for the extension that owns the scheme.
      if (isGitRepositoryUri(uri)) {
        if (resolvedViewer?.pluginId !== pluginId || resolvedViewer.delivery !== 'text') return { kind: 'error', message: 'not allowed' }
        return { kind: 'text', text: '', truncated: false, size: 0, mtimeMs: 0, readOnly: true }
      }
      // TODO 1280: not a file. Only the extension that owns the viewer for this scheme gets the document, and only its own documents (`readOwnDocument` decides by the caller's id).
      if (!uri.startsWith('file://')) {
        if (resolvedViewer?.pluginId !== pluginId || resolvedViewer.delivery !== 'text') return { kind: 'error', message: 'not allowed' }
        const doc = await this.deps.broker.readOwnDocument(pluginId, uri)
        const bytes = Buffer.from(doc.text, 'utf8')
        const truncated = bytes.byteLength > MAX_TEXT_BYTES
        return {
          kind: 'text',
          text: truncated ? utf8Prefix(bytes, MAX_TEXT_BYTES) : doc.text,
          truncated,
          size: bytes.byteLength,
          mtimeMs: doc.updatedAt,
          // The canonical copy is the extension's index; a viewer edit would never be written back.
          readOnly: true
        }
      }
      if (resolvedViewer?.pluginId === pluginId && resolvedViewer.delivery === 'url') {
        // The Broker confirms the grant and returns only a URL with a token (A-4).
        // The Broker (`openResource`) checks again at serving time.
        const resourceUrl = this.deps.broker.resourceUrlFor(pluginId, uri)
        const resolved = this.resolve(pluginId, uri, 'read')
        const fd = openChecked(resolved, constants.O_RDONLY)
        try {
          const stat = fstatSync(fd)
          const size = Number(stat.size)
          // TODO 673: remember one "file being viewed now" per window and watch the parent directory.
          if (viewId !== undefined && this.readGeneration.isLatest(viewId, generation)) {
            this.deps.watch?.track(viewId, uri, resolved.canonical, stat.mtimeMs, size)
          }
          return {
            kind: 'binary',
            // Serious item 6: even on re-read the token is the same, so add mtime to the query to force a fetch
            // (so the caches of `<img>` / `<video>` / aios.pdf do not keep stale contents).
            resourceUrl: withCacheBust(resourceUrl, stat.mtimeMs),
            size,
            mtimeMs: stat.mtimeMs,
            // TODO 1212 stage 1: only for a viewer that receives cell-value drafts and only when it passes the write check.
            ...(resolvedViewer.cellEdits === true && size <= MAX_CELL_EDIT_FILE_BYTES && this.writable(pluginId, uri)
              ? { cellEdits: true }
              : {})
          }
        } finally {
          closeSync(fd)
        }
      }

      const result = (await this.deps.broker.handle(pluginId, {
        capability: 'fs',
        op: 'read',
        uri
      })) as { kind: string; text?: string; bytes: number; truncated: boolean; mtimeMs: number; invalidUtf8?: boolean }

      if (result.kind === 'binary') return { kind: 'error', message: 'binary' }
      const resolved = this.resolve(pluginId, uri, 'read')
      // TODO 853: the mtime is from the same fd that read the body (re-opening separately would let an outside rewrite in between attach a new mtime to the old body).
      const mtimeMs = result.mtimeMs
      // TODO 673: same as above. Even for a truncated body, what is viewed is the current file, so the watch is set.
      if (viewId !== undefined && this.readGeneration.isLatest(viewId, generation)) {
        this.deps.watch?.track(viewId, uri, resolved.canonical, mtimeMs, result.bytes)
      }
      return {
        kind: 'text',
        text: result.text ?? '',
        truncated: result.truncated,
        size: result.bytes,
        mtimeMs,
        // What passed through the read exception (auto memory `.md`, item 254) cannot be saved
        // (`write` checks without the exception). Tell the viewer first so it does not let the user edit.
        // TODO 851: text that is invalid as UTF-8 (Shift_JIS and so on) is also read-only. Writing back the full text containing U+FFFD would lose the original bytes.
        ...(this.writable(pluginId, uri) && result.invalidUtf8 !== true ? {} : { readOnly: true })
      }
    } catch (err) {
      // TODO 947: `PathDenied` is passed as a reason code (such as `path-not-regular`) (the host translates it).
      const message =
        err instanceof PathDenied ? pathDenialCode(err.reason) : err instanceof Error ? err.message : 'not allowed'
      return { kind: 'error', message }
    }
  }

  /**
   * Saving text. **Only the ViewerPane (host) calls this**, and it is not part of the viewer contract
   * (5.2). Writes go through the same choke point as reads (realpath + O_NOFOLLOW + fstat).
   */
  async write(
    pluginId: string,
    uri: string,
    content: string,
    expectedMtimeMs: number | null,
    viewId?: number
  ): Promise<TextWriteResult> {
    const started = Date.now()
    const fail = (reason: TextWriteResult['reason'], mtimeMs = 0, size = 0): TextWriteResult => {
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: 'fs',
        op: 'write',
        target: uri,
        decision: 'deny',
        reason,
        ms: Date.now() - started
      })
      return { ok: false, mtimeMs, size, reason }
    }

    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_TEXT_BYTES) return fail('too-large')
    // TODO 1212 stage 1: for a viewer that returns cell-value drafts, `content` is a list of edits. Write it into the original file as a diff.
    if (this.viewerFor(pluginId, uri)?.cellEdits === true) {
      return this.writeCells(pluginId, uri, content, expectedMtimeMs, viewId, started, fail)
    }

    let resolved
    try {
      resolved = this.resolve(pluginId, uri, 'edit')
    } catch {
      return fail('denied')
    }
    if (!resolved.exists) return fail('not-found')

    let fd: number
    try {
      // Apply the same check as reads (O_NOFOLLOW + fstat) to writes too.
      fd = openChecked(resolved, constants.O_WRONLY)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (err instanceof PathDenied) return fail('denied')
      if (code === 'ENOENT') return fail('not-found')
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return fail('denied')
      return fail('io')
    }

    // TODO 1073: close the fd in one place, `finally` (so it is not closed twice if audit / settle throws after success).
    let after: ReturnType<typeof fstatSync>
    try {
      const before = fstatSync(fd)
      if (expectedMtimeMs !== null && Math.round(before.mtimeMs) !== Math.round(expectedMtimeMs)) {
        return fail('conflict', before.mtimeMs, Number(before.size))
      }
      const buffer = Buffer.from(content, 'utf8')
      // TODO 853: look at the return value (the number of bytes actually written) and loop until all is written. If no progress is made, `io` (do not return ok with only the length matching while the old contents remain).
      let written = 0
      while (written < buffer.byteLength) {
        const n = writeSync(fd, buffer, written, buffer.byteLength - written, written)
        if (n <= 0) throw new Error('short write')
        written += n
      }
      // Truncate so that no tail remains when the existing file is longer.
      ftruncateSync(fd, buffer.byteLength)
      // Same as VS Code's default save: write in place + fsync (no temp file + rename. If the inode changed,
      // the premises of the dev + ino check in `openChecked` and of the watch (TODO 673) would break).
      fsyncSync(fd)
      after = fstatSync(fd)
    } catch (err) {
      log.warn('viewer.write.failed', { pluginId, ...errorFields(err) })
      return fail('io')
    } finally {
      closeSync(fd)
    }
    try {
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: 'fs',
        op: 'write',
        target: uri,
        decision: 'allow',
        reason: null,
        ms: Date.now() - started
      })
      // **The path may be logged**, but the body is not (the logging rules of chapter 7).
      log.info('viewer.write.ok', { pluginId, bytes })
      // TODO 673: take the mtime / size advanced by our own write into the watch's baseline without a
      // notification (so a re-read does not run on every save, autosave, or flush before closing).
      if (viewId !== undefined) this.deps.watch?.settle(viewId, uri, after.mtimeMs, Number(after.size))
      return { ok: true, mtimeMs: after.mtimeMs, size: Number(after.size), reason: null }
    } catch (err) {
      log.warn('viewer.write.failed', { pluginId, ...errorFields(err) })
      return fail('io')
    }
  }

  /** Resolution of the viewer used when opening with this plugin now (the same criterion as `read`). */
  private viewerFor(pluginId: string, uri: string): ResolvedViewer | null {
    if (this.deps.resolveViewerWith !== undefined) return this.deps.resolveViewerWith(uri, pluginId)
    const viewer = this.deps.resolveViewer(uri)
    return viewer?.pluginId === pluginId ? viewer : null
  }

  /**
   * Writes the cell values of an `.xlsx` (TODO 1212 stage 1, ARCHITECTURE 7.4.9.1). `content` is a list of edits (`@shared/xlsx-cells.ts`).
   * It goes through the same choke point as text saving (realpath + O_NOFOLLOW + fstat), mtime conflict, and audit, and writes **the bytes made by reading the original file and
   * applying a diff** (`applyCellEdits`) in place (the inode does not change, for the same reason as `write`). The list of edits is re-checked by the viewer's
   * rules, and if it hits a refusal reason (a formula cell, the inside of a merge, a signed workbook ...) nothing is written and the result is `locked`.
   * If something else rewrites the file while the diff is being built (unzip and zip run on libuv threads), a fstat right before writing makes it `conflict`.
   */
  private async writeCells(
    pluginId: string,
    uri: string,
    content: string,
    expectedMtimeMs: number | null,
    viewId: number | undefined,
    started: number,
    fail: (reason: TextWriteResult['reason'], mtimeMs?: number, size?: number) => TextWriteResult
  ): Promise<TextWriteResult> {
    const edits = parseCellEdits(content)
    if (edits === null) return fail('unsupported')

    let resolved
    try {
      resolved = this.resolve(pluginId, uri, 'edit')
    } catch {
      return fail('denied')
    }
    if (!resolved.exists) return fail('not-found')

    let fd: number
    try {
      fd = openChecked(resolved, constants.O_RDWR)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (err instanceof PathDenied) return fail('denied')
      if (code === 'ENOENT') return fail('not-found')
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return fail('denied')
      return fail('io')
    }

    let after: ReturnType<typeof fstatSync>
    let written = 0
    // TODO 1212 (code-review): if it fails after writing started (ENOSPC, an external volume disconnecting, and so on), write the original bytes back.
    let original: Buffer | null = null
    let writing = false
    try {
      const before = fstatSync(fd)
      const size = Number(before.size)
      if (expectedMtimeMs !== null && Math.round(before.mtimeMs) !== Math.round(expectedMtimeMs)) {
        return fail('conflict', before.mtimeMs, size)
      }
      if (size > MAX_CELL_EDIT_FILE_BYTES) return fail('too-large', before.mtimeMs, size)
      const orig = Buffer.alloc(size)
      let read = 0
      while (read < size) {
        const n = readSync(fd, orig, read, size - read, read)
        if (n <= 0) throw new Error('short read')
        read += n
      }
      original = orig
      let next: Buffer
      try {
        next = await applyCellEdits(orig, edits)
      } catch (err) {
        if (err instanceof XlsxCellsError) {
          // Log only the reason code (no body or cell values).
          log.info('viewer.write.cells.refused', { pluginId, code: err.code, detail: err.detail })
          return fail(err.code === 'locked' ? 'locked' : 'unsupported', before.mtimeMs, size)
        }
        throw err
      }
      // Whether something else rewrote it while the diff was being built (fstat on the same fd).
      const recheck = fstatSync(fd)
      if (recheck.mtimeMs !== before.mtimeMs || Number(recheck.size) !== size) {
        return fail('conflict', recheck.mtimeMs, Number(recheck.size))
      }
      writing = true
      while (written < next.byteLength) {
        const n = writeSync(fd, next, written, next.byteLength - written, written)
        if (n <= 0) throw new Error('short write')
        written += n
      }
      ftruncateSync(fd, next.byteLength)
      fsyncSync(fd)
      after = fstatSync(fd)
    } catch (err) {
      log.warn('viewer.write.failed', { pluginId, ...errorFields(err) })
      // An in-place write that stops halfway leaves a zip with only a new head. To keep the inode it does not use a temp file + rename
      // (the same reason as `write`), and writes the original bytes read beforehand back. If writing back also fails (the disk stays full and so on), give up with io.
      if (writing && original !== null) {
        try {
          let restored = 0
          while (restored < original.byteLength) {
            const n = writeSync(fd, original, restored, original.byteLength - restored, restored)
            if (n <= 0) throw new Error('short write')
            restored += n
          }
          ftruncateSync(fd, original.byteLength)
          fsyncSync(fd)
          log.info('viewer.write.cells.restored', { pluginId })
        } catch (restoreErr) {
          log.error('viewer.write.cells.restore-failed', { pluginId, ...errorFields(restoreErr) })
        }
      }
      return fail('io')
    } finally {
      closeSync(fd)
    }
    try {
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: 'fs',
        op: 'write',
        target: uri,
        decision: 'allow',
        reason: null,
        ms: Date.now() - started
      })
      log.info('viewer.write.ok', { pluginId, bytes: written, cells: edits.length })
      if (viewId !== undefined) this.deps.watch?.settle(viewId, uri, after.mtimeMs, Number(after.size))
      return { ok: true, mtimeMs: after.mtimeMs, size: Number(after.size), reason: null }
    } catch (err) {
      log.warn('viewer.write.failed', { pluginId, ...errorFields(err) })
      return fail('io')
    }
  }

  /**
   * Resolves the path for images and mtime. The grant decision uses the same criterion as the Broker.
   * `access` is `'read'` for reads (the auto memory `.md` exception applies, item 254),
   * and `'edit'` for writes (only the user's skill SKILL.md is an exception). **Readable but not writable** is decided here.
   */
  private resolve(
    pluginId: string,
    uri: string,
    access: PathAccess = 'write'
  ): ReturnType<typeof resolvePath> {
    const path = pathFromUri(uri)
    this.deps.broker.assertGranted(pluginId, path)
    // The scope is the opened URI and the real path at the time of opening (a symlinked file, TODO 558). A write also opens the real path
    // with O_NOFOLLOW + fstat (`openChecked`), so the TOCTOU protection is unchanged.
    return resolvePath(
      path,
      { rules: this.deps.scope.rules, roots: this.deps.broker.openGrantRoots(pluginId, path) },
      false,
      access
    )
  }

  /** Whether it passes the write check (no exceptions). Distinguishes what is readable but not writable (item 254). */
  private writable(pluginId: string, uri: string): boolean {
    try {
      this.resolve(pluginId, uri, 'edit')
      return true
    } catch {
      return false
    }
  }
}

/**
 * If the **last element** of the opened URI is a symlink, the real path's URI (TODO 558; shown faintly next to the heading). One where only an intermediate element is
 * a symlink (`/tmp/x` → `/private/tmp/x`) is not added: it is not a link the user placed, and showing it would be noise.
 * Call after `grantOpen` has finished the grant (this is for display only and is not used in decisions).
 */
function linkTargetOf(uri: string): string | null {
  try {
    const path = pathFromUri(uri)
    if (!lstatSync(path).isSymbolicLink()) return null
    return pathToUri(realpathSync.native(path))
  } catch {
    return null
  }
}
