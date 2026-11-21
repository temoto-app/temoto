/**
 * `aios.zip` — show the contents of a zip as a list, and open files inside it as temporary views (TODO 905, ARCHITECTURE.md 7.4.11).
 *
 * **It does not extract and write to disk** (owner decision 2026-10-20). No "extract and save" is added either (2026-10-21).
 *
 * As with `aios.office` / `aios.pdf`, the contents are received as a **URL served by main's `aios-res://`** (review C-2), and read with Range,
 * the end first and then the central directory (`zip.ts`). When an entry is pressed, only that entry is read and expanded inside the iframe, and the
 * bytes are handed to the host (`bridge.openEntry`). The host makes them a temporary view with no URI (7.4.6) and draws them with the viewer that
 * matches the name's extension. A zip inside a zip is opened by `aios.zip` again inside the temporary view (the bridge passes it as a `blob:` URL).
 */
import '@pluginshared/viewer.css'
import './zip.css'
import { connect } from '@pluginshared/bridge.js'
import { createDomFind } from '@pluginshared/dom-find.js'
import { vt } from '@pluginshared/i18n.js'
import {
  ZipError,
  encryptionSupport,
  extractZipEntry,
  isOpenableEntryName,
  readZipListing,
  urlRangeSource,
  type RangeSource,
  type ZipEntry,
  type ZipListing
} from './zip.js'
import { displayName, formatModified, formatSize, reasonText, sortedEntries, summaryText } from './zip-view.js'

const bridge = connect('aios.zip')
const root = document.getElementById('root')

/** The archive now shown (used to match the destination of `open-entry`). An empty string inside a temporary view. */
let uri = ''
/** The key that decides whether to reread (the same URL, size and version count as a resend). */
let loadedKey = ''
/** The load generation. Discards the results of old reads and extractions. */
let generation = 0
let source: RangeSource | null = null
let listing: ZipListing | null = null
/** The notice above the list (extracting, or a failure). Kept across redraws. */
let status: { text: string; error: boolean } | null = null
/** The list sorted by name (sorted only once per `listing`). */
let sorted: readonly ZipEntry[] = []
/** The status band (made by `render`; `setStatus` rewrites only this). */
let statusBar: HTMLElement | null = null
/** The extraction generation. When pressed again, the previous extraction's result (and the clearing of "extracting…") is discarded. */
let openSeq = 0
/**
 * The password for an encrypted entry (TODO 1151). **Only in this iframe's memory**: dropped when the archive is reread. It is not persisted,
 * not put into `onDraftChange` / the bridge, and not logged. It is not asked for again for the next encrypted entry of the same archive.
 */
let sessionPassword: string | null = null
/** The state of the password field (kept in memory so that typed characters are not lost on a redraw). */
let pending: { entry: ZipEntry; draft: string; error: string | null; busy: boolean; reveal: boolean } | null = null
/** The place for the password field (made by `render`). */
let promptHost: HTMLElement | null = null

root?.classList.add('zip-root')
const find = createDomFind({
  host: root ?? document.body,
  target: () => root?.querySelector<HTMLElement>('.zip-scroll') ?? null
})
document.addEventListener('keydown', (event) => {
  if (find.handleKey(event)) event.preventDefault()
})

function message(text: string): void {
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
  find.refresh()
}

function cell(tag: 'td' | 'th', text: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  element.textContent = text
  if (className !== undefined) element.className = className
  return element
}

function tag(text: string, title: string, className: string): HTMLElement {
  const span = document.createElement('span')
  span.className = `zip-tag ${className}`
  span.textContent = text
  span.title = title
  return span
}

function nameCell(entry: ZipEntry): HTMLElement {
  const td = document.createElement('td')
  td.className = 'zip-name'
  const shown = displayName(entry.name)
  if (entry.directory) {
    const span = document.createElement('span')
    span.className = 'zip-folder'
    span.textContent = shown
    td.append(span)
  } else if (!isOpenableEntryName(entry.name)) {
    // A name the host does not accept (no last element, or too long). Do not make it look pressable.
    const span = document.createElement('span')
    span.className = 'zip-unopenable'
    span.textContent = shown
    td.append(span, tag(vt('zipUnopenable'), vt('zipUnopenableTitle'), 'zip-tag-unopenable'))
  } else {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'zip-open'
    button.textContent = shown
    button.addEventListener('click', () => openEntry(entry))
    td.append(button)
  }
  if (entry.encoding === 'shift_jis' || entry.encoding === 'cp437') {
    td.title = vt('zipNameGuessed', { encoding: entry.encoding === 'shift_jis' ? 'Shift_JIS' : 'CP437' })
  }
  if (entry.encrypted) td.append(tag(vt('zipEncrypted'), vt('zipEncryptedTitle'), 'zip-tag-encrypted'))
  if (entry.unsafeName) td.append(tag(vt('zipUnsafe'), vt('zipUnsafeTitle'), 'zip-tag-unsafe'))
  return td
}

function render(): void {
  if (root === null || listing === null) return
  const scrollTop = root.querySelector('.zip-scroll')?.scrollTop ?? 0
  root.textContent = ''

  const header = document.createElement('div')
  header.className = 'toolbar zip-header'
  const summary = document.createElement('span')
  summary.className = 'zip-summary'
  summary.textContent = summaryText(listing)
  header.append(summary)
  if (listing.truncated) {
    const note = document.createElement('span')
    note.className = 'zip-note'
    note.textContent = vt('zipTruncated', {
      shown: listing.entries.length,
      total: Math.max(listing.totalEntries, listing.entries.length)
    })
    header.append(note)
  }
  root.append(header)

  statusBar = document.createElement('div')
  statusBar.setAttribute('role', 'status')
  paintStatus()
  root.append(statusBar)

  promptHost = document.createElement('div')
  root.append(promptHost)
  paintPrompt(false)

  if (listing.entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'message'
    empty.textContent = vt('zipEmpty')
    root.append(empty)
    find.refresh()
    return
  }

  const scroll = document.createElement('div')
  scroll.className = 'zip-scroll'
  const table = document.createElement('table')
  table.className = 'zip-table'
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  headRow.append(
    cell('th', vt('zipColumnName')),
    cell('th', vt('zipColumnSize'), 'num'),
    cell('th', vt('zipColumnCompressed'), 'num'),
    cell('th', vt('zipColumnModified'))
  )
  head.append(headRow)
  table.append(head)
  const body = document.createElement('tbody')
  for (const entry of sorted) {
    const tr = document.createElement('tr')
    if (entry.directory) tr.className = 'zip-row-folder'
    tr.append(
      nameCell(entry),
      cell('td', entry.directory ? '' : formatSize(entry.uncompressedSize), 'num'),
      cell('td', entry.directory ? '' : formatSize(entry.compressedSize), 'num'),
      cell('td', formatModified(entry.modifiedMs), 'zip-modified')
    )
    body.append(tr)
  }
  table.append(body)
  scroll.append(table)
  root.append(scroll)
  scroll.scrollTop = scrollTop
  find.refresh()
}

function paintStatus(): void {
  if (statusBar === null) return
  statusBar.hidden = status === null
  statusBar.className = status?.error === true ? 'zip-status zip-status-error' : 'zip-status'
  statusBar.textContent = status?.text ?? ''
}

/** Rewrite only the status band (the list is not redrawn — so up to 10,000 rows are not laid out again). */
function setStatus(next: { text: string; error: boolean } | null): void {
  status = next
  paintStatus()
}

function openEntry(entry: ZipEntry): void {
  if (source === null) return
  if (!encryptionSupport(entry).supported) {
    // An unsupported encryption is known from the list information. The password is not asked for.
    openSeq++
    pending = null
    paintPrompt(false)
    setStatus({ text: vt('zipOpenFailed', { name: displayName(entry.name), reason: reasonText(new ZipError('unsupported-encryption')) }), error: true })
    return
  }
  if (entry.encrypted && sessionPassword === null) {
    // Do not show the host's dialog; show a field inside this viewer.
    openSeq++
    setStatus(null)
    pending = { entry, draft: '', error: null, busy: false, reveal: false }
    paintPrompt(true)
    return
  }
  extractAndOpen(entry, sessionPassword ?? undefined)
}

/** Extract an entry and hand it to the host. For an encrypted entry, if `password` is wrong, reopen the field (`onWrong`). */
function extractAndOpen(entry: ZipEntry, password: string | undefined, onWrong?: () => void): void {
  const current = source
  if (current === null) return
  const gen = generation
  const seq = ++openSeq
  const stale = (): boolean => gen !== generation || seq !== openSeq
  const shown = displayName(entry.name)
  setStatus({ text: vt('zipOpening', { name: shown }), error: false })
  void (async () => {
    try {
      const data = await extractZipEntry(current, entry, {}, password)
      if (stale()) return
      if (password !== undefined && entry.encrypted) sessionPassword = password
      pending = null
      paintPrompt(false)
      setStatus(null)
      bridge.openEntry(uri, entry.name, data)
    } catch (err) {
      if (stale()) return
      if (err instanceof ZipError && err.reason === 'wrong-password') {
        sessionPassword = null
        setStatus(null)
        if (onWrong !== undefined) onWrong()
        else {
          pending = { entry, draft: '', error: vt('zipPasswordWrong'), busy: false, reveal: false }
          paintPrompt(true)
        }
        return
      }
      pending = null
      paintPrompt(false)
      setStatus({ text: vt('zipOpenFailed', { name: shown, reason: reasonText(err) }), error: true })
    }
  })()
}

/** Draw the password field. If `focus`, move focus to the input (do not move it when only redrawing). */
function paintPrompt(focus: boolean): void {
  const host = promptHost
  if (host === null) return
  host.textContent = ''
  const state = pending
  if (state === null) return
  const form = document.createElement('form')
  form.className = 'zip-password'
  const label = document.createElement('label')
  label.className = 'zip-password-label'
  label.textContent = vt('zipPasswordLabel', { name: displayName(state.entry.baseName) })
  const input = document.createElement('input')
  input.className = 'zip-password-input'
  input.type = state.reveal ? 'text' : 'password'
  input.value = state.draft
  input.autocomplete = 'off'
  input.spellcheck = false
  input.disabled = state.busy
  input.addEventListener('input', () => {
    state.draft = input.value
  })
  label.append(' ', input)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.textContent = vt(state.reveal ? 'zipPasswordHide' : 'zipPasswordShow')
  toggle.title = vt(state.reveal ? 'zipPasswordHideTitle' : 'zipPasswordShowTitle')
  toggle.addEventListener('click', () => {
    state.reveal = !state.reveal
    input.type = state.reveal ? 'text' : 'password'
    toggle.textContent = vt(state.reveal ? 'zipPasswordHide' : 'zipPasswordShow')
    toggle.title = vt(state.reveal ? 'zipPasswordHideTitle' : 'zipPasswordShowTitle')
    input.focus()
  })
  const ok = document.createElement('button')
  ok.type = 'submit'
  ok.textContent = vt(state.busy ? 'zipPasswordChecking' : 'zipPasswordOk')
  ok.disabled = state.busy
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = vt('zipPasswordCancel')
  const close = (): void => {
    openSeq++
    pending = null
    setStatus(null)
    paintPrompt(false)
  }
  cancel.addEventListener('click', close)
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (state.busy || state.draft === '') return
    const password = state.draft
    state.busy = true
    state.error = null
    paintPrompt(false)
    extractAndOpen(state.entry, password, () => {
      pending = { entry: state.entry, draft: '', error: vt('zipPasswordWrong'), busy: false, reveal: state.reveal }
      paintPrompt(true)
    })
  })
  form.append(label, toggle, ok, cancel)
  if (state.error !== null) {
    const error = document.createElement('div')
    error.className = 'zip-password-error'
    error.setAttribute('role', 'alert')
    error.textContent = state.error
    form.append(error)
  }
  host.append(form)
  if (focus) input.focus()
}

bridge.onResource((event) => {
  if (root === null) return
  const resource = event.resource
  const key =
    resource.kind === 'binary' ? `${event.uri}\n${resource.resourceUrl}\n${resource.size}\n${event.revision ?? ''}` : ''
  if (key !== '' && key === loadedKey) {
    // A resend of only the theme or language. Do not reread; redraw only the wording.
    if (listing !== null) render()
    return
  }

  generation++
  const gen = generation
  uri = event.uri
  loadedKey = ''
  sessionPassword = null
  pending = null
  source = null
  listing = null
  sorted = []
  statusBar = null
  status = null

  if (resource.kind === 'error') {
    message(vt('cannotOpen', { reason: resource.message }))
    return
  }
  if (resource.kind !== 'binary') {
    message(vt('notZip'))
    return
  }

  loadedKey = key
  message(vt('zipLoading'))
  const next = urlRangeSource(resource.resourceUrl, resource.size)
  void (async () => {
    try {
      const read = await readZipListing(next)
      if (gen !== generation) return
      source = next
      listing = read
      sorted = sortedEntries(read.entries)
      render()
    } catch (err) {
      if (gen !== generation) return
      // A version that failed is not remembered (the next resend rereads it).
      loadedKey = ''
      message(vt('zipFailed', { reason: reasonText(err) }))
    }
  })()
})
