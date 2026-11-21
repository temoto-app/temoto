/**
 * In saving a conversation as single-file HTML (TODO 866, ARCHITECTURE.md 5.1.8), embeds the images in the body as `data:` URLs.
 * It looks at each `<img src="…">` of the HTML the renderer built (answers are `renderMarkdown` = output that went through DOMPurify), and
 * **main reads the files** (paths are not handed to the renderer. The renderer already sees the body's paths, but main does the reading).
 *
 * - Readable files are those with an image extension that passed `FsAccess.assertAllowed` (exclusion rules, realpath re-check).
 * - Up to 5 MB each and 25 MB in total (owner decision 2026-10-18). Anything over, unreadable, or an external URL (http etc.; the network is not read) is replaced with
 *   an "image omitted" note. **The export does not fail.**
 * - A relative path is resolved from the conversation's working folder (the worktree if it moved to one). If there is no working folder, it is omitted.
 * - One that is already `data:image/…;base64,` only has its size checked and is kept as is.
 *
 * The replacement scans the HTML from the start and picks up the start tags of `<img …>` (`scanImgTags`). The renderer's HTML is not trusted, so
 * quotes (`"` / `'` / none) are read correctly, and an `<img` inside another tag's attribute value (`data-code="<img …>"`), a comment, or
 * `<style>` / `<script>` is not picked up. Attribute values are decoded before use and escaped again when written.
 * Image reading uses realpath + O_NOFOLLOW + a dev/ino comparison between the check and the open (the same way as `ViewerBroker`), and the type is decided not by the extension
 * but by the leading magic bytes (`sniffEmbeddableImage`). If it is not an image, it is omitted.
 * The log goes up to the path (no body).
 */
import { constants } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORT_IMAGE_MAX_BYTES, EXPORT_IMAGES_TOTAL_MAX_BYTES } from '@shared/conversation-export.js'
import { pathToUri } from '../../common/uri.js'
import { log, errorFields } from '../../common/logger.js'
import { sniffEmbeddableImage } from '../paste/temp-image.js'
import { openNoFollow } from '../../common/os/open-flags.js'

/** Extensions and MIME types of images that may be embedded. An SVG inside `<img>` does not run scripts. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif);base64,[A-Za-z0-9+/=\s]*$/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

export interface EmbedImagesDeps {
  /** `FsAccess.assertAllowed(uri, false, 'read')`. Throws to refuse. */
  readonly assertAllowed: (uri: string) => void
  /** The base for relative paths (the conversation's working folder). null if none. */
  readonly baseDir: string | null
  /** "Image omitted" (in the display language). */
  readonly omittedLabel: string
  /**
   * For tests. The default: realpath -> `assertCanonical` (the gate on the real file too) -> open with O_NOFOLLOW and compare dev/ino -> read after checking fstat's
   * size.
   */
  readonly readImage?: (
    path: string,
    maxBytes: number,
    assertCanonical: (canonical: string) => void
  ) => Promise<Uint8Array | null>
}

export interface EmbedImagesResult {
  readonly html: string
  readonly embedded: number
  readonly omitted: number
}

export function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface ImgTag {
  readonly start: number
  readonly end: number
  readonly attrs: ReadonlyMap<string, string>
}

const WS = /[\t\n\f\r ]/
/** Elements whose contents are skipped (text up to the closing tag). */
const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title'])

/**
 * Reads the attributes of a start tag from `from` (just after the tag name) to `>`. A `>` inside quotes (`"` / `'`) does not end it, and unquoted values are read too.
 * The returned `end` is the position after `>`. If a quote is not closed, it cuts at the next `>` (or the end if none) and discards the attributes (`ok: false`).
 */
function readAttributes(html: string, from: number): { attrs: Map<string, string>; end: number; ok: boolean } {
  const attrs = new Map<string, string>()
  let i = from
  while (i < html.length) {
    const ch = html[i] as string
    if (ch === '>') return { attrs, end: i + 1, ok: true }
    if (WS.test(ch) || ch === '/') {
      i += 1
      continue
    }
    let nameEnd = i
    while (nameEnd < html.length && !WS.test(html[nameEnd] as string) && !'=/>'.includes(html[nameEnd] as string)) nameEnd += 1
    // Even when the name is empty (starts with `=`), advance by one character.
    if (nameEnd === i) nameEnd = i + 1
    const name = html.slice(i, nameEnd).toLowerCase()
    i = nameEnd
    while (i < html.length && WS.test(html[i] as string)) i += 1
    let value = ''
    if (html[i] === '=') {
      i += 1
      while (i < html.length && WS.test(html[i] as string)) i += 1
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1)
        if (close < 0) {
          const gt = html.indexOf('>', i)
          return { attrs: new Map(), end: gt < 0 ? html.length : gt + 1, ok: false }
        }
        value = html.slice(i + 1, close)
        i = close + 1
      } else {
        const valueStart = i
        while (i < html.length && !WS.test(html[i] as string) && html[i] !== '>') i += 1
        value = html.slice(valueStart, i)
      }
    }
    if (!attrs.has(name)) attrs.set(name, decodeAttr(value))
  }
  return { attrs, end: html.length, ok: false }
}

/**
 * Scans the HTML from the start and returns the positions and attributes of `<img>` start tags. Other tags also have their attributes skipped according to quotes, so
 * it does not pick up an attribute value like `data-code="<img …>"`, nor the inside of a comment or `<style>` / `<script>`.
 */
export function scanImgTags(html: string): ImgTag[] {
  const found: ImgTag[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close < 0 ? html.length : close + 3
      continue
    }
    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 64))
    if (nameMatch === null) {
      i = lt + 1
      continue
    }
    const tagName = (nameMatch[1] as string).toLowerCase()
    const read = readAttributes(html, lt + nameMatch[0].length)
    if (tagName === 'img') {
      found.push({ start: lt, end: read.end, attrs: read.attrs })
    } else if (RAW_TEXT.has(tagName) && read.ok) {
      const close = html.toLowerCase().indexOf(`</${tagName}`, read.end)
      i = close < 0 ? html.length : close
      continue
    }
    i = read.end
  }
  return found
}

/** Turns `src` into a file path. null for an external URL or a malformed one. */
export function imagePathOf(src: string, baseDir: string | null): string | null {
  const value = src.trim()
  if (value === '') return null
  if (/^file:/i.test(value)) {
    try {
      return fileURLToPath(value)
    } catch {
      return null
    }
  }
  if (SCHEME.test(value)) return null
  if (value.startsWith('//')) return null
  let path: string
  try {
    path = decodeURI(value.split(/[?#]/, 1)[0] ?? '')
  } catch {
    path = value
  }
  if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  if (isAbsolute(path)) return resolve(path)
  return baseDir === null ? null : resolve(baseDir, path)
}

async function readLimited(
  path: string,
  maxBytes: number,
  assertCanonical: (canonical: string) => void
): Promise<Uint8Array | null> {
  // Resolve the real file, apply the gate to the real file too, open with O_NOFOLLOW, and compare against the dev/ino at check time (TOCTOU).
  const canonical = await realpath(path)
  assertCanonical(canonical)
  const before = await lstat(canonical)
  const handle = await openNoFollow(canonical, constants.O_RDONLY, { nonBlock: false })
  try {
    const stats = await handle.stat()
    if (stats.dev !== before.dev || stats.ino !== before.ino) return null
    if (!stats.isFile() || stats.size > maxBytes) return null
    const data = await handle.readFile()
    return data.byteLength > maxBytes ? null : new Uint8Array(data)
  } finally {
    await handle.close()
  }
}

// TODO 879: the decision moved to paste/temp-image.ts to be shared with the images in the conversation screen (876).
export { sniffEmbeddableImage }

/** The approximate number of bytes of the contents of a base64 `data:` URL. */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',')
  const payload = url.slice(comma + 1).replace(/\s/g, '')
  return Math.floor((payload.length * 3) / 4)
}

export async function embedImages(html: string, deps: EmbedImagesDeps): Promise<EmbedImagesResult> {
  const read = deps.readImage ?? readLimited
  const tags = scanImgTags(html)
  if (tags.length === 0) return { html, embedded: 0, omitted: 0 }
  let total = 0
  let embedded = 0
  let omitted = 0
  /** The same file is read only once (it is written each time it appears - and counted toward the total each time). */
  const cache = new Map<string, Uint8Array | null>()
  const replacements: string[] = []

  const omit = (alt: string): string => {
    omitted += 1
    const label = alt.trim() === '' ? deps.omittedLabel : `${deps.omittedLabel}: ${alt.trim()}`
    return `<span class="export-image-omitted">[${escapeHtml(label)}]</span>`
  }

  for (const match of tags) {
    const attrs = match.attrs
    const src = attrs.get('src') ?? ''
    const alt = attrs.get('alt') ?? ''
    const title = attrs.get('title')
    const imgTag = (dataUrl: string): string =>
      `<img src="${escapeHtml(dataUrl)}" alt="${escapeHtml(alt)}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>`

    if (/^data:/i.test(src.trim())) {
      const value = src.trim()
      const bytes = dataUrlBytes(value)
      if (!DATA_IMAGE.test(value) || bytes > EXPORT_IMAGE_MAX_BYTES || total + bytes > EXPORT_IMAGES_TOTAL_MAX_BYTES) {
        replacements.push(omit(alt))
        continue
      }
      total += bytes
      embedded += 1
      replacements.push(imgTag(value))
      continue
    }

    const path = imagePathOf(src, deps.baseDir)
    const extensionOk = path !== null && IMAGE_MIME[extname(path).toLowerCase()] !== undefined
    if (path === null || !extensionOk) {
      replacements.push(omit(alt))
      continue
    }
    let data = cache.get(path)
    if (data === undefined) {
      data = null
      try {
        deps.assertAllowed(pathToUri(path))
        data = await read(path, EXPORT_IMAGE_MAX_BYTES, (canonical) => deps.assertAllowed(pathToUri(canonical)))
      } catch (err) {
        log.debug('export.html.imageSkipped', { path, ...errorFields(err) })
      }
      cache.set(path, data)
    }
    // The type is decided by the contents, not the extension. If it is not an image (a text file named .png, credentials, etc.), it is omitted.
    const mime = data === null ? null : sniffEmbeddableImage(data)
    if (data === null || mime === null || total + data.byteLength > EXPORT_IMAGES_TOTAL_MAX_BYTES) {
      replacements.push(omit(alt))
      continue
    }
    total += data.byteLength
    embedded += 1
    replacements.push(imgTag(`data:${mime};base64,${Buffer.from(data).toString('base64')}`))
  }

  let out = ''
  let cursor = 0
  tags.forEach((tag, index) => {
    out += html.slice(cursor, tag.start) + (replacements[index] ?? '')
    cursor = tag.end
  })
  out += html.slice(cursor)
  return { html: out, embedded, omitted }
}
