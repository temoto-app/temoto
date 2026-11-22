/**
 * Drawing of the Source Control view (`aios.git`, TODO 834 stage 1). DOM only, no I/O: `main.ts` holds the state and the bridge, and this module
 * builds the list from that state (jsdom can draw it whole, `test/git-viewer.test.ts`). The shape follows VS Code's Source Control view:
 * "Staged Changes" and "Changes" groups, one row per file with the status letter, the file name and its folder; pressing a row opens the diff.
 * Below them, "Compare two versions" lists the files that differ between two revisions (`to` empty = the working tree).
 */
import { vt, type ViewerMessageKey } from '@pluginshared/i18n.js'
import type { GitChange, GitCommit, GitDiffResult, GitStatusResult } from '@shared/plugin-git.js'
import { statusLetter, type ChangeMode } from '../common/sides.js'

export interface CompareState {
  readonly from: string
  readonly to: string
  readonly result: GitDiffResult | null
  readonly loading: boolean
  readonly error: string | null
}

export interface GitViewState {
  /** The opened folder's name (the last segment). */
  readonly folder: string
  readonly status: GitStatusResult | null
  readonly loading: boolean
  /** A failure of the whole view (not a repository, git missing...). */
  readonly error: string | null
  /** A one-line notice above the list (a binary / too large change). */
  readonly notice: string | null
  readonly compare: CompareState
  readonly commits: readonly GitCommit[]
}

export interface GitViewHandlers {
  refresh(): void
  open(mode: ChangeMode, change: GitChange): void
  setCompare(field: 'from' | 'to', value: string): void
  runCompare(): void
}

const STATUS_KEYS: Readonly<Record<GitChange['status'], ViewerMessageKey>> = {
  added: 'gitStatusAdded',
  modified: 'gitStatusModified',
  deleted: 'gitStatusDeleted',
  renamed: 'gitStatusRenamed',
  copied: 'gitStatusCopied',
  typechange: 'gitStatusTypechange',
  untracked: 'gitStatusUntracked',
  conflicted: 'gitStatusConflicted'
}

/** The id of the commit suggestions (`<datalist>`). */
export const COMMITS_LIST_ID = 'git-commits'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** `src/a.ts` -> name `a.ts`, folder `src`. */
export function splitPath(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, folder: '' } : { name: path.slice(at + 1), folder: path.slice(0, at) }
}

function changeRow(mode: ChangeMode, change: GitChange, handlers: GitViewHandlers): HTMLElement {
  const row = element('button', `git-row git-status-${change.status}`)
  row.type = 'button'
  const { name, folder } = splitPath(change.path)
  const label = vt(STATUS_KEYS[change.status])
  row.title = change.oldPath === undefined ? `${change.path} — ${label}` : `${change.oldPath} → ${change.path} — ${label}`
  row.append(element('span', 'git-name', name))
  if (folder !== '') row.append(element('span', 'git-folder', folder))
  const letter = element('span', 'git-letter', statusLetter(change.status))
  letter.setAttribute('aria-label', label)
  row.append(letter)
  row.addEventListener('click', () => handlers.open(mode, change))
  return row
}

function group(title: string, mode: ChangeMode, changes: readonly GitChange[], handlers: GitViewHandlers): HTMLElement {
  const section = element('section', 'git-group')
  const heading = element('h2', 'git-group-title')
  heading.append(element('span', undefined, title), element('span', 'git-count', String(changes.length)))
  section.append(heading)
  for (const change of changes) section.append(changeRow(mode, change, handlers))
  return section
}

function input(field: 'from' | 'to', value: string, handlers: GitViewHandlers): HTMLLabelElement {
  const label = element('label', 'git-field')
  label.append(element('span', 'git-field-label', vt(field === 'from' ? 'gitFrom' : 'gitTo')))
  const box = element('input', 'git-input')
  box.type = 'text'
  box.value = value
  box.spellcheck = false
  box.autocomplete = 'off'
  box.setAttribute('list', COMMITS_LIST_ID)
  box.dataset['field'] = field
  if (field === 'to') box.placeholder = vt('gitToPlaceholder')
  box.addEventListener('input', () => handlers.setCompare(field, box.value))
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handlers.runCompare()
  })
  label.append(box)
  return label
}

function compareSection(state: GitViewState, handlers: GitViewHandlers): HTMLElement {
  const section = element('section', 'git-group git-compare')
  section.append(element('h2', 'git-group-title', vt('gitCompare')))
  const form = element('div', 'git-compare-form')
  const run = element('button', 'git-button', vt('gitCompareRun'))
  run.type = 'button'
  // Not disabled by an empty field: typing does not redraw (the focus stays), and `runCompare` ignores an empty `from`.
  run.disabled = state.compare.loading
  run.addEventListener('click', () => handlers.runCompare())
  form.append(input('from', state.compare.from, handlers), input('to', state.compare.to, handlers), run)
  section.append(form)
  const commits = element('datalist')
  commits.id = COMMITS_LIST_ID
  for (const commit of state.commits) {
    const option = element('option')
    option.value = commit.hash.slice(0, 12)
    option.label = `${commit.subject} — ${commit.author}`
    commits.append(option)
  }
  section.append(commits)
  if (state.compare.loading) section.append(element('div', 'git-note', vt('gitLoading')))
  else if (state.compare.error !== null) section.append(element('div', 'git-note git-error', state.compare.error))
  else if (state.compare.result !== null) {
    const result = state.compare.result
    if (result.files.length === 0) section.append(element('div', 'git-note', vt('gitCompareEmpty')))
    for (const change of result.files) section.append(changeRow('compare', change, handlers))
    if (result.truncated) section.append(element('div', 'git-note', vt('gitTruncated', { count: result.files.length })))
    if (result.hidden > 0) section.append(element('div', 'git-note', vt('gitHidden', { count: result.hidden })))
  }
  return section
}

/** Draws the whole view into `root` (replacing what was there). */
export function renderGitView(root: HTMLElement, state: GitViewState, handlers: GitViewHandlers): void {
  root.textContent = ''
  const header = element('div', 'git-header')
  const branch = state.status === null ? '' : (state.status.branch ?? vt('gitDetached'))
  header.append(element('span', 'git-title', state.folder))
  if (branch !== '') header.append(element('span', 'git-branch', branch))
  const refresh = element('button', 'git-button git-refresh', vt('gitRefresh'))
  refresh.type = 'button'
  refresh.disabled = state.loading
  refresh.addEventListener('click', () => handlers.refresh())
  header.append(refresh)
  root.append(header)

  const scroll = element('div', 'git-scroll')
  root.append(scroll)
  if (state.notice !== null) scroll.append(element('div', 'git-note git-notice', state.notice))
  if (state.error !== null) {
    scroll.append(element('div', 'git-note git-error', state.error))
    return
  }
  if (state.status === null) {
    scroll.append(element('div', 'git-note', vt('gitLoading')))
    return
  }
  const status = state.status
  if (status.staged.length > 0) scroll.append(group(vt('gitStaged'), 'staged', status.staged, handlers))
  scroll.append(group(vt('gitChanges'), 'unstaged', status.unstaged, handlers))
  if (status.staged.length === 0 && status.unstaged.length === 0) scroll.append(element('div', 'git-note', vt('gitNoChanges')))
  if (status.truncated) scroll.append(element('div', 'git-note', vt('gitTruncated', { count: status.staged.length + status.unstaged.length })))
  if (status.hidden > 0) scroll.append(element('div', 'git-note', vt('gitHidden', { count: status.hidden })))
  scroll.append(compareSection(state, handlers))
}

/** A Broker / command failure as a sentence (the reason codes of the git capability; anything else is shown as a reason). */
export function describeGitError(message: string, rev?: string): string {
  if (/not-a-repo/.test(message)) return vt('gitNotRepo')
  if (/unsupported-repo/.test(message)) return vt('gitUnsupported')
  if (/git-missing/.test(message)) return vt('gitMissing')
  if (/invalid-rev/.test(message)) return vt('gitInvalidRev', { rev: rev ?? '' })
  const reason = /\b([a-z]+(?:-[a-z]+)*)\b/.exec(message)?.[1] ?? 'error'
  return vt('gitFailed', { reason })
}
