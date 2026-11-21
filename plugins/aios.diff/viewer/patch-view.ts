/**
 * Show a `.diff` / `.patch` file read-only (TODO 901).
 *
 * The contents (a unified diff string) are read by the host through the Broker and passed in. This viewer does not read the file.
 * Both a multi-file diff with `diff --git` entries and a plain diff with only `--- / +++` are split into
 * one section per file and shown in one column. To see or edit the original text, pick aios.text under "open with another viewer" in the viewer heading
 * (TODO 907. The chosen viewer becomes the default for that extension and can be reverted under "viewer per extension" in settings).
 *
 * Colors come only from `--diff-*` in viewer.css (7.4.1). DOM construction is kept here so it can be tested in jsdom without the bridge.
 */

export type PatchLineKind = 'add' | 'del' | 'ctx' | 'note'

export interface PatchLine {
  readonly kind: PatchLineKind
  /** The text without the leading marker (`+` / `-` / ` `). For `note` (`\ No newline at end of file`), the whole line. */
  readonly text: string
  readonly oldNo: number | null
  readonly newNo: number | null
}

export interface PatchHunk {
  /** The `@@ -1,3 +1,4 @@ …` line as is. */
  readonly header: string
  readonly lines: readonly PatchLine[]
}

export interface PatchFile {
  /** Display name (the `b/` side, else the `a/` side). For `/dev/null`, the opposite side. */
  readonly name: string
  /** Notes such as `new file mode` / `rename from …` / `Binary files … differ`. */
  readonly notes: readonly string[]
  readonly hunks: readonly PatchHunk[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Turn `a/foo` / `b/foo` / `"a/foo bar"` into a display name, dropping the timestamp after a tab. */
function cleanName(raw: string): string {
  let name = raw.split('\t')[0] ?? raw
  name = name.trim()
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1)
  return name.replace(/^[ab]\//, '')
}

/** Take the name from `diff --git a/x b/y`. Even for names containing spaces, split in the middle if a and b have the same length. */
function gitHeaderName(rest: string): string {
  const quoted = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(rest)
  if (quoted !== null) return quoted[2] ?? quoted[1] ?? rest
  return cleanName(rest)
}

interface MutHunk {
  header: string
  lines: PatchLine[]
}
interface MutFile {
  name: string
  notes: string[]
  hunks: MutHunk[]
}

/** Parse a unified diff string into files. An empty array if there is not a single diff-like line. */
export function parsePatch(text: string): PatchFile[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const files: MutFile[] = []
  const cur: { file: MutFile | null; hunk: MutHunk | null } = { file: null, hunk: null }
  let oldLeft = 0
  let newLeft = 0
  let oldNo = 0
  let newNo = 0

  const startFile = (name: string): MutFile => {
    const created: MutFile = { name, notes: [], hunks: [] }
    files.push(created)
    cur.file = created
    cur.hunk = null
    return created
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const hunk = cur.hunk
    // Even if lines remain, a hunk ends when the next line is a new file header. This keeps a patch with more headers than
    // actual entries from treating `--- a/next` as a deleted line. `diff --git` cannot be a body line (which starts with + - or a space).
    // Only the sequence `--- ` + `+++ ` + `@@` is a header (to tell it from a pair of change lines like `-- x` / `++ y`).
    const startsFile =
      line.startsWith('diff --git ') ||
      (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && HUNK.test(lines[i + 2] ?? ''))
    const inHunk = hunk !== null && (oldLeft > 0 || newLeft > 0) && !startsFile
    // Inside a hunk: while lines remain, decide by the first character (so a deleted line like `--- foo` is not mistaken for a header).
    if (hunk !== null && inHunk) {
      const head = line.charAt(0)
      const body = line.slice(1)
      // A marker on a side whose count is used up is outside the hunk (the count never goes negative).
      if (head === '+' && newLeft > 0) {
        hunk.lines.push({ kind: 'add', text: body, oldNo: null, newNo })
        newNo++
        newLeft--
        continue
      }
      if (head === '-' && oldLeft > 0) {
        hunk.lines.push({ kind: 'del', text: body, oldNo, newNo: null })
        oldNo++
        oldLeft--
        continue
      }
      if ((head === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: 'ctx', text: body, oldNo, newNo })
        oldNo++
        newNo++
        oldLeft--
        newLeft--
        continue
      }
    }
    if (line.startsWith('\\')) {
      hunk?.lines.push({ kind: 'note', text: line, oldNo: null, newNo: null })
      continue
    }
    if (line.startsWith('diff --git ')) {
      startFile(gitHeaderName(line.slice('diff --git '.length)))
      continue
    }
    const match = HUNK.exec(line)
    if (match !== null) {
      const file = cur.file ?? startFile('')
      oldNo = Number(match[1])
      oldLeft = match[2] === undefined ? 1 : Number(match[2])
      newNo = Number(match[3])
      newLeft = match[4] === undefined ? 1 : Number(match[4])
      const created: MutHunk = { header: line, lines: [] }
      file.hunks.push(created)
      cur.hunk = created
      continue
    }
    const next = lines[i + 1] ?? ''
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      const from = cleanName(line.slice(4))
      const to = cleanName(next.slice(4))
      const name = to === '/dev/null' ? from : to
      const file = cur.file
      // A `---` right after `diff --git` continues the same file. Otherwise (a plain `diff -u`) a new file starts here.
      if (file === null || file.hunks.length > 0) startFile(name)
      else if (file.name === '') file.name = name
      cur.hunk = null
      i++
      continue
    }
    if (cur.file !== null && cur.hunk === null && line !== '') cur.file.notes.push(line)
  }
  return files.filter((f) => f.hunks.length > 0 || f.notes.length > 0 || f.name !== '')
}

/** Do not redraw for the same key (a resent theme must not lose the scroll position). A language that changes the wording goes into the key. */
export function patchRenderKey(text: string, truncated: boolean, locale: string): string {
  return `${locale}:${truncated ? 1 : 0}:${text}`
}

export interface PatchViewHandle {
  readonly destroy: () => void
}

/** Draw into `root`, split into one section per file. */
export function mountPatchView(
  root: HTMLElement,
  options: { readonly text: string; readonly truncated: boolean; readonly emptyLabel: string; readonly truncatedLabel: string }
): PatchViewHandle {
  const files = parsePatch(options.text)
  const wrap = document.createElement('div')
  wrap.className = 'patch-view'
  if (options.truncated) {
    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.textContent = options.truncatedLabel
    wrap.append(banner)
  }
  if (files.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'message'
    empty.textContent = options.emptyLabel
    wrap.append(empty)
  }
  for (const file of files) {
    const section = document.createElement('section')
    section.className = 'patch-file'
    const title = document.createElement('div')
    title.className = 'patch-file-name'
    title.textContent = file.name
    section.append(title)
    for (const note of file.notes) {
      const el = document.createElement('div')
      el.className = 'patch-note'
      el.textContent = note
      section.append(el)
    }
    for (const hunk of file.hunks) {
      const head = document.createElement('div')
      head.className = 'patch-hunk'
      head.textContent = hunk.header
      section.append(head)
      for (const line of hunk.lines) {
        const row = document.createElement('div')
        row.className = `patch-line patch-${line.kind}`
        const oldNum = document.createElement('span')
        oldNum.className = 'patch-no'
        oldNum.textContent = line.oldNo === null ? '' : String(line.oldNo)
        const newNum = document.createElement('span')
        newNum.className = 'patch-no'
        newNum.textContent = line.newNo === null ? '' : String(line.newNo)
        const mark = document.createElement('span')
        mark.className = 'patch-mark'
        mark.textContent = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'ctx' ? ' ' : ''
        const body = document.createElement('span')
        body.className = 'patch-text'
        body.textContent = line.text
        row.append(oldNum, newNum, mark, body)
        section.append(row)
      }
    }
    wrap.append(section)
  }
  root.append(wrap)
  return { destroy: () => wrap.remove() }
}
