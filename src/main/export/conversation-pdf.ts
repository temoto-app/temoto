/**
 * The main side of saving a conversation as a PDF / single-file HTML (TODO 818 / 866, ARCHITECTURE.md 5.1.8).
 *
 * Flow: the renderer receives the body via `threads.exportTurns` (main reads all of it, already redacted), builds print HTML with the shared
 * `renderMarkdown`, and passes it to `threads.savePdf`. This file:
 *
 *   1. Asks for the destination with `showSaveDialog` **every time** (owner decision 2026-10-17). The initial folder is the folder
 *      last saved to (`EXPORT_LAST_DIR`), and for the first time ~/Downloads. The default file name is the title + date (+ which question), and
 *      **the title is built from a value main holds** (the renderer's string is not used as a file name).
 *   2. Renders the HTML in a hidden window and calls `printToPDF`. The window is sandboxed, JS-disabled, with no preload and a throwaway session, and
 *      every request other than the loaded temporary file and embedded `data:image/` is blocked (external URLs). The renderer's HTML went through DOMPurify,
 *      but it is confined here on the assumption that it is not trusted.
 *   3. Writes to the chosen path. The path was chosen by the user in a native dialog (treated like "Choose another folder...").
 *
 * Markdown (TODO 1014) writes the string the renderer built as is, after applying redaction again (`.md`).
 * HTML (TODO 866) replaces step 2: main reads the images in the body and embeds them as `data:` (`embed-images.ts`), and writes it as is.
 * PDF (TODO 1273) embeds the same way before printing, so the user's attached / pasted images and images in answers are in the PDF.
 * In either format, `redactText` is applied again to the HTML from the renderer before writing (the body is already redacted, but
 * a renderer value is not trusted. It is not applied to image bytes). The last folder is shared between PDF and HTML.
 *
 * The part independent of electron (this class) and `electronPdfRenderer`, which creates a real window, are separated (tests pass a fake).
 * The log goes up to the path (no body).
 */
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EXPORT_HTML_MAX_BYTES,
  exportFileName,
  type ExportFormat,
  type ExportScope,
  type SavePdfResult
} from '@shared/conversation-export.js'
import { reasonError } from '@shared/reason.js'
import { redactText } from '@shared/redact.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { EXPORT_LAST_DIR } from '../../common/settings-keys.js'
import { pathToUri } from '../../common/uri.js'
import { log, errorFields } from '../../common/logger.js'

/** Chunks to which redaction is not applied: the contents of `<style>` (the inline styles.css), and `data:image/…;base64,…` in `src` (image bytes). */
const REDACT_SKIP = /<style\b[\s\S]*?<\/style\s*>|(?<=\bsrc=["'])data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*/gi

/**
 * Re-applies redaction to HTML from the renderer (TODO 866). Base64 images and CSS can accidentally match a secret pattern and
 * break, so it is applied only to the rest (the body, `data-code` attributes, etc.). A `data:` outside `src` is body text, so it is covered.
 */
export function redactExportHtml(html: string): string {
  let out = ''
  let cursor = 0
  for (const match of html.matchAll(REDACT_SKIP)) {
    const at = match.index ?? 0
    out += redactText(html.slice(cursor, at)).text + match[0]
    cursor = at + match[0].length
  }
  return out + redactText(html.slice(cursor)).text
}

export interface SaveDialogRequest<Owner> {
  readonly defaultPath: string
  /** The dialog's parent (the calling window. Shown as a sheet). */
  readonly owner: Owner
  /** Chooses the dialog's title and extension filter (TODO 866). */
  readonly format: ExportFormat
}

export interface ConversationExportDeps<Owner> {
  readonly settings: AppSettingsStore
  /** The save dialog. The chosen path, or null if closed. */
  readonly askSavePath: (request: SaveDialogRequest<Owner>) => Promise<string | null>
  /** Turns HTML into PDF bytes. */
  readonly renderPdf: (html: string) => Promise<Uint8Array>
  /**
   * HTML export (TODO 866): HTML with the images in the body embedded as `data:`. Images that cannot be read or are too large are replaced with a note and
   * do not fail the export (`embed-images.ts`). If omitted, it is left as is without embedding (for tests).
   */
  readonly embedImages?: (html: string, threadId: string) => Promise<string>
  /** The thread's title (null if none). */
  readonly threadTitle: (threadId: string) => string | null
  /** The destination for the first save (~/Downloads). */
  readonly defaultDir: () => string
  /** The file name when the title is empty (the display language's word for "conversation"). */
  readonly fallbackName: () => string
  readonly writeFile?: (path: string, data: Uint8Array) => Promise<void>
  readonly now?: () => Date
}

export class ConversationExporter<Owner = unknown> {
  private readonly write: (path: string, data: Uint8Array) => Promise<void>
  private readonly now: () => Date

  constructor(private readonly deps: ConversationExportDeps<Owner>) {
    this.write = deps.writeFile ?? ((path, data) => writeFile(path, data))
    this.now = deps.now ?? (() => new Date())
  }

  async save(
    threadId: string,
    scope: ExportScope,
    html: string,
    owner: Owner,
    format: ExportFormat = 'pdf'
  ): Promise<SavePdfResult> {
    const title = this.deps.threadTitle(threadId)
    if (title === null) throw reasonError('invalid-value', { field: 'threadId' })
    if (Buffer.byteLength(html, 'utf8') > EXPORT_HTML_MAX_BYTES) {
      throw reasonError('invalid-value', { field: 'html' })
    }
    const lastDir = this.deps.settings.readTyped(EXPORT_LAST_DIR)
    const name = exportFileName(
      title,
      this.now(),
      this.deps.fallbackName(),
      scope.kind === 'turn' ? scope.number : undefined,
      format
    )
    const path = await this.deps.askSavePath({
      defaultPath: join(lastDir ?? this.deps.defaultDir(), name),
      owner,
      format
    })
    if (path === null) return { saved: false }
    // Markdown (TODO 1014) is not HTML: there is no `<style>` or `data:` image, so `redactText` is applied to the whole.
    const redacted = format === 'md' ? redactText(html).text : redactExportHtml(html)
    let data: Uint8Array
    try {
      if (format === 'md') {
        data = new Uint8Array(Buffer.from(redacted, 'utf8'))
      } else if (format === 'pdf') {
        // TODO 1273: images (the user's attachments, images in answers) are embedded as `data:` before printing, the same as HTML.
        const embedded = this.deps.embedImages === undefined ? redacted : await this.deps.embedImages(redacted, threadId)
        data = await this.deps.renderPdf(embedded)
      } else {
        const embedded = this.deps.embedImages === undefined ? redacted : await this.deps.embedImages(redacted, threadId)
        data = new Uint8Array(Buffer.from(embedded, 'utf8'))
      }
      await this.write(path, data)
    } catch (err) {
      log.warn(`export.${format}.failed`, { path, ...errorFields(err) })
      throw reasonError(format === 'pdf' ? 'export-pdf-failed' : format === 'md' ? 'export-md-failed' : 'export-html-failed')
    }
    this.deps.settings.writeTyped(EXPORT_LAST_DIR, dirname(path))
    log.info(`export.${format}.saved`, { path, scope: scope.kind, bytes: data.byteLength })
    return { saved: true, uri: pathToUri(path) }
  }
}

/** Name of the throwaway session for printing (no `persist:` prefix = nothing is kept). */
const EXPORT_PARTITION = 'aios-export-pdf'

/** URLs of the temporary files being rendered now. Even if two exports run at once, one filter lets both through. */
const allowedUrls = new Set<string>()
let filterInstalled = false

/**
 * Turns HTML into a PDF in a real window. electron is read when called (so this file can be imported in tests).
 * The temporary file is placed in the OS temp folder and deleted when done.
 */
export function electronPdfRenderer(tempDir: () => string): (html: string) => Promise<Uint8Array> {
  return async (html) => {
    const { BrowserWindow, session } = await import('electron')
    const file = join(tempDir(), `aios-export-${randomUUID()}.html`)
    await writeFile(file, html, 'utf8')
    const fileUrl = pathToFileURL(file).href
    const ses = session.fromPartition(EXPORT_PARTITION)
    // Only the loaded temporary file and embedded `data:image/` pass. Link targets and external URLs are not read.
    if (!filterInstalled) {
      ses.webRequest.onBeforeRequest((details, callback) => {
        // `data:image/` is allowed: main has already embedded the images it checked and read (TODO 1273).
        // `data:font/woff2` is allowed too: the export document embeds KaTeX's fonts that way (TODO 1342). Nothing else loads fonts.
        callback({
          cancel: !allowedUrls.has(details.url) && !details.url.startsWith('data:image/') && !details.url.startsWith('data:font/woff2')
        })
      })
      filterInstalled = true
    }
    allowedUrls.add(fileUrl)
    let win: InstanceType<typeof BrowserWindow> | null = null
    try {
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
          webgl: false,
          spellcheck: false
        }
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event) => event.preventDefault())
      await win.loadURL(fileUrl)
      const data = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
      })
      return new Uint8Array(data)
    } finally {
      allowedUrls.delete(fileUrl)
      win?.destroy()
      await unlink(file).catch((err: unknown) => log.warn('export.pdf.tempCleanupFailed', errorFields(err)))
    }
  }
}
