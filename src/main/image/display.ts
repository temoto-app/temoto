/**
 * Entry point that converts images for display (TODO 1154, `aios.image` in ARCHITECTURE.md 7.4).
 *
 * Chromium does not decode HEIC / HEIF, so only when `aios-res://` serves one (`protocol.ts`) it is converted to JPEG with the macOS stock
 * `sips`. In line with the **principle of not keeping body text**, the result is not cached: every time it is written to a
 * temporary directory (`mkdtemp` = new, 0700) and deleted right after it is read.
 *
 * The only entry point that calls `sips` (same shape as `runGit`): the executable is fixed (`/usr/bin/sips`), the flags are fixed
 * (`-s format jpeg <input> --out <output>`), and the environment is only `PATH` and `LANG`. It is not made a general-purpose runner (the "unit of operation" of constraint 8).
 *
 * **The input is not a path but an fd that the Broker checked and opened** (`openResource` with O_NOFOLLOW + fstat already done). It is copied from that fd
 * into the temporary directory before being given to `sips` (wave 71 review X). Previously the fd was closed and the logical path was
 * given to `sips`, so if the path was swapped for a symlink between the check and the conversion, a different file could be converted and served (TOCTOU).
 * Passing `/dev/fd/<n>` does not work because `sips` re-resolves a path from the fd and opens that (failure confirmed locally).
 *
 * For orientation (EXIF / HEIF rotation), `sips` returns a JPEG with it applied to the pixels. On environments without `sips`, such as Windows, the result is
 * `unsupported-platform` (another way for Windows later, TODO 899).
 *
 * Attachments (TODO 1173) go through the same conversion (`convertFileForAttachment`): a HEIC attached to the Prompt is sent as JPEG.
 * Only for attachments, if the plain conversion exceeds the attachment limit (`shrinkAboveBytes`), `-Z ATTACHMENT_MAX_PIXELS` (a fixed constant) is added and
 * it is shrunk exactly once (wave 75 review: a 48 MP photo exceeded 8 MB and could not be attached). Conversion for display is never shrunk.
 */
import { execFile } from 'node:child_process'
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ViewerImageConversion as DisplayConversion } from '@shared/plugin.js'
import { HEIF_EXTENSIONS, isHeifName } from '@shared/transient-file.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import { OS_MINIMAL_PATH, OS_TOOLS } from '../../common/os/tools.js'
import { openNoFollowSync } from '../../common/os/open-flags.js'

export const SIPS_PATH = OS_TOOLS.sips
/** Upper bound on the time for a conversion. */
export const CONVERT_TIMEOUT_MS = 30_000
/** Upper bound on the size of the converted JPEG (it is held in memory). */
export const MAX_CONVERTED_BYTES = 64 * 1024 * 1024
/** Upper bound on the size of the source file to convert (it is copied to the temporary directory). */
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024

/** Whether the extension needs conversion for display (case-insensitive). */
export function needsDisplayConversion(path: string): boolean {
  return isHeifName(path)
}


/** A `sips` call. The arguments are a fixed sequence, and it uses `execFile` (no shell). true on success. Tests replace it. */
export type SipsRunner = (args: readonly string[]) => Promise<boolean>

export const runSips: SipsRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      SIPS_PATH,
      [...args],
      { env: { PATH: OS_MINIMAL_PATH, LANG: 'en_US.UTF-8' }, timeout: CONVERT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error) => resolve(error === null)
    )
  })

/**
 * Attachment shrinking (wave 75 review): the maximum edge in pixels passed to `sips -Z` when the plain conversion exceeds the attachment limit. **A fixed constant**
 * (the flag value is not taken from the caller). A JPEG of a 48 MP photo exceeds 8 MB, but the model shrinks the long edge anyway when reading,
 * so 3072 px (about 9.4 MP, 4:3) is enough.
 */
export const ATTACHMENT_MAX_PIXELS = 3072

export interface ConvertDeps {
  readonly platform?: NodeJS.Platform
  readonly run?: SipsRunner
  /** Location of the temporary directory (`app.getPath('temp')`). */
  readonly tempDir: string
  /**
   * Attachments only (TODO 1173 / wave 75 review): if the plain conversion exceeds this many bytes, convert again once, shrunk with `-Z ATTACHMENT_MAX_PIXELS`.
   * Display (`protocol.ts`) does not pass it (no shrinking).
   */
  readonly shrinkAboveBytes?: number
}

/** Input of the conversion: the fd the Broker checked and opened (same shape as `OpenedResource`). */
export interface DisplaySource {
  readonly fd: number
  readonly size: number
  /** Logical path. Only its extension is used for the temporary file's name; it is not opened. */
  readonly path: string
}

/** Convert the input file `input` inside the temporary directory `dir` to JPEG and read it (shared by `convertForDisplay` / `convertBytesForDisplay`). */
async function runConversion(dir: string, input: string, deps: ConvertDeps): Promise<DisplayConversion> {
  const run = deps.run ?? runSips
  let output = join(dir, 'out.jpg')
  const ok = await run(['-s', 'format', 'jpeg', input, '--out', output])
  if (!ok) return { ok: false, reason: 'failed' }
  // Check the size before reading (do not load anything over the limit into memory).
  let written = await stat(output)
  if (!written.isFile() || written.size === 0) return { ok: false, reason: 'failed' }
  if (deps.shrinkAboveBytes !== undefined && written.size > deps.shrinkAboveBytes) {
    // Over the attachment limit: shrink the longest edge and convert again exactly once (flag and value are fixed). If still over, the caller refuses.
    output = join(dir, 'out-small.jpg')
    const shrunk = await run(['-s', 'format', 'jpeg', '-Z', String(ATTACHMENT_MAX_PIXELS), input, '--out', output])
    if (!shrunk) return { ok: false, reason: 'failed' }
    written = await stat(output)
    if (!written.isFile() || written.size === 0) return { ok: false, reason: 'failed' }
  }
  if (written.size > MAX_CONVERTED_BYTES) return { ok: false, reason: 'too-large' }
  const bytes = await readFile(output)
  if (bytes.byteLength === 0) return { ok: false, reason: 'failed' }
  if (bytes.byteLength > MAX_CONVERTED_BYTES) return { ok: false, reason: 'too-large' }
  return { ok: true, bytes, contentType: 'image/jpeg' }
}

/**
 * Convert the contents of `source.fd` to JPEG and return it. **Takes ownership of the fd** (closed whether it succeeds or not). Failure is returned as a reason, not thrown.
 * The logical path is not opened: what was copied from the fd into the temporary directory (0700) is given to `sips`.
 */
export async function convertForDisplay(source: DisplaySource, deps: ConvertDeps): Promise<DisplayConversion> {
  let fdOwned = true
  const closeFd = (): void => {
    if (!fdOwned) return
    fdOwned = false
    try {
      closeSync(source.fd)
    } catch {
      // Already closed.
    }
  }
  if (!isMac(deps.platform ?? hostPlatform())) {
    closeFd()
    return { ok: false, reason: 'unsupported-platform' }
  }
  if (source.size > MAX_SOURCE_BYTES) {
    closeFd()
    return { ok: false, reason: 'too-large' }
  }
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(deps.tempDir, 'aios-display-'))
    const ext = extname(source.path).slice(1).toLowerCase()
    const input = join(dir, `in.${HEIF_EXTENSIONS.has(ext) ? ext : 'heic'}`)
    // The fd is closed by the stream when it finishes reading or fails (autoClose). Reads from position 0 (pread).
    fdOwned = false
    await pipeline(
      createReadStream('', { fd: source.fd, autoClose: true, start: 0 }),
      createWriteStream(input, { flags: 'wx', mode: 0o600 })
    )
    return await runConversion(dir, input, deps)
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    closeFd()
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Attachment entry point (TODO 1173): turn a HEIC / HEIF attached to the Prompt into a JPEG the model can read.
 * The caller (`session/attachments.ts`) passes a path that went through `FsAccess.assertAllowed`. Here it is folded to the real path, opened with `O_NOFOLLOW`,
 * confirmed by fstat to be a regular file, and that fd is given to `convertForDisplay` (the conversion flags, limits and orientation are the same as for display).
 * The caller only base64-encodes the result and puts it in the send; it is kept nowhere (constraints 9 / 10).
 */
export async function convertFileForAttachment(path: string, deps: ConvertDeps): Promise<DisplayConversion> {
  // On an environment without `sips`, the file is not even opened.
  if (!isMac(deps.platform ?? hostPlatform())) return { ok: false, reason: 'unsupported-platform' }
  let fd: number
  try {
    // The choke point returns the logical path (attachments can be symlinks). Fold it to the real path, then open without following the last component.
    fd = openNoFollowSync(realpathSync.native(path), constants.O_RDONLY, { nonBlock: false })
  } catch {
    return { ok: false, reason: 'failed' }
  }
  let size: number
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      closeSync(fd)
      return { ok: false, reason: 'failed' }
    }
    size = stats.size
  } catch {
    closeSync(fd)
    return { ok: false, reason: 'failed' }
  }
  return convertForDisplay({ fd, size, path }, deps)
}

/** Turn the conversion result into an `aios-res://` response. Failure is 415 (the viewer shows "this format cannot be displayed"), too large is 413. */
export function conversionResponse(conversion: DisplayConversion): Response {
  if (!conversion.ok) {
    return new Response(null, { status: conversion.reason === 'too-large' ? 413 : 415, headers: { 'access-control-allow-origin': '*' } })
  }
  return new Response(conversion.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      'content-type': conversion.contentType,
      'content-length': String(conversion.bytes.byteLength),
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    }
  })
}

/** `ftyp` major brands that are HEIC / HEIF (ISO BMFF). AVIF (`avif` / `avis`) is not included, because Chromium can read it directly. */
const HEIF_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'heif'])

/** Upper bound for reading as an `ftyp` box (the list of brands never gets longer than this). */
const FTYP_MAX_BYTES = 4096

/** Whether the leading bytes are HEIC / HEIF (judged by contents, not extension; never trust only the name when passing to `sips`). */
export function sniffHeif(data: Uint8Array): boolean {
  if (data.byteLength < 12) return false
  const latin = (from: number, to: number): string => Buffer.from(data.subarray(from, to)).toString('latin1')
  if (latin(4, 8) !== 'ftyp') return false
  if (HEIF_BRANDS.has(latin(8, 12))) return true
  // Even with a different major brand, some files have a heic-family compatible brand. Only the inside of the `ftyp` box is read
  // (a size in the first 4 bytes. 0 = to the end, 1 = a 64-bit size whose range cannot be determined, so up to the limit, which is FTYP_MAX_BYTES).
  const declared = Buffer.from(data.subarray(0, 4)).readUInt32BE(0)
  const boxEnd = declared >= 16 ? declared : declared === 0 || declared === 1 ? FTYP_MAX_BYTES : 0
  const end = Math.min(data.byteLength, boxEnd, FTYP_MAX_BYTES)
  // 16 = size + 'ftyp' + major brand + minor version. From there, every 4 bytes is a compatible brand.
  for (let at = 16; at + 4 <= end; at += 4) if (HEIF_BRANDS.has(latin(at, at + 4))) return true
  return false
}

/**
 * Convert a byte sequence (such as a HEIC inside a zip: a temporary view with no file, TODO 1162) to JPEG. The extension of the name
 * (`needsDisplayConversion`), the content type (`sniffHeif`) and the size (`MAX_SOURCE_BYTES`) are all checked here (the caller is not trusted).
 * The input is written to a new file (`wx`) in a temporary directory (0700), given to `sips`, and deleted right away.
 */
export async function convertBytesForDisplay(bytes: Uint8Array, name: string, deps: ConvertDeps): Promise<DisplayConversion> {
  if (!isMac(deps.platform ?? hostPlatform())) return { ok: false, reason: 'unsupported-platform' }
  if (!needsDisplayConversion(name) || !sniffHeif(bytes)) return { ok: false, reason: 'failed' }
  if (bytes.byteLength > MAX_SOURCE_BYTES) return { ok: false, reason: 'too-large' }
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(deps.tempDir, 'aios-display-'))
    const input = join(dir, 'in.heic')
    await writeFile(input, bytes, { flag: 'wx', mode: 0o600 })
    return await runConversion(dir, input, deps)
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
