/**
 * `aios.git` — the Source Control view (TODO 834 stage 1, ARCHITECTURE.md 7.4.14). **Read-only.**
 *
 * The host opens this viewer for an `aios-git:` URI (a folder the user opened with "Open in Source Control"); opening it is what grants the folder to
 * this extension. The viewer does no I/O: it asks this extension's host commands (`bridge.runCommand`), which state intents through the Broker's
 * read-only git capability (main builds every argv). Pressing a change reads both sides and asks the host to show them in the diff view
 * (`bridge.openDiff` -> `aios.diff`, side by side / unified). This view stays alive behind the diff, so closing the diff comes back here.
 */
import '@pluginshared/viewer.css'
import './git.css'
import { connect } from '@pluginshared/bridge.js'
import { vt } from '@pluginshared/i18n.js'
import { GIT_INDEX, GIT_WORKTREE, type GitChange, type GitCommit, type GitDiffResult, type GitLogResult, type GitShowResult, type GitSide, type GitStatusResult } from '@shared/plugin-git.js'
import type { DiffSide } from '@shared/plugin.js'
import { isGitRev } from '@shared/git-rev.js'
import { changeSides, type ChangeMode, type SideSpec } from '../common/sides.js'
import { describeGitError, renderGitView, type GitViewState } from './git-view.js'

const bridge = connect('aios.git')
const root = document.getElementById('root')
root?.classList.add('git-root')

let uri = ''
/** Discards results of an earlier folder / refresh. */
let generation = 0
/** Discards results of an earlier comparison (its own counter: a refresh must not orphan a running comparison and leave it "loading"). Bumped on a folder switch too. */
let compareSeq = 0
/** The versions the listed comparison result was made with (rows open with these, not with whatever is typed in the fields now). */
let compareBase: { readonly from: string; readonly to: string } | null = null
let state: GitViewState = {
  folder: '',
  status: null,
  loading: false,
  error: null,
  notice: null,
  compare: { from: '', to: '', result: null, loading: false, error: null },
  commits: []
}

function render(): void {
  if (root === null) return
  renderGitView(root, state, { refresh, open, setCompare, runCompare })
}

function update(next: Partial<GitViewState>): void {
  state = { ...state, ...next }
  render()
}

function errorText(err: unknown, rev?: string): string {
  return describeGitError(err instanceof Error ? err.message : String(err), rev)
}

async function refresh(): Promise<void> {
  if (uri === '') return
  const gen = ++generation
  update({ loading: true, error: null, notice: null })
  try {
    const [status, log] = await Promise.all([
      bridge.runCommand('status', { repo: uri }) as Promise<GitStatusResult>,
      (bridge.runCommand('log', { repo: uri }) as Promise<GitLogResult>).catch((): GitLogResult => ({ commits: [], more: false }))
    ])
    if (gen !== generation) return
    update({ status, commits: log.commits, loading: false })
  } catch (err) {
    if (gen !== generation) return
    update({ status: null, loading: false, error: errorText(err) })
  }
}

function sideLabel(spec: SideSpec | null, fallbackPath: string): string {
  const path = spec?.path ?? fallbackPath
  if (spec === null) return path
  const where = spec.rev === GIT_WORKTREE ? vt('gitWorkingTree') : spec.rev === GIT_INDEX ? vt('gitIndex') : shortRev(spec.rev)
  // The version goes in front: the diff view picks the language from the end of the name (the extension).
  return `${where}: ${path}`
}

function shortRev(rev: GitSide): string {
  return /^[0-9a-f]{40,64}$/.test(rev) ? rev.slice(0, 12) : rev
}

function sideText(result: GitShowResult): string | 'binary' | 'too-large' {
  if (result.kind === 'text') return result.text
  if (result.kind === 'missing') return ''
  return result.kind
}

async function open(mode: ChangeMode, change: GitChange): Promise<void> {
  const base = mode === 'compare' ? compareBase : null
  if (mode === 'compare' && base === null) return
  const from = base === null ? undefined : base.from
  const to = base === null || base.to === '' ? undefined : base.to
  const specs = changeSides(mode, change, from, to)
  update({ notice: null })
  try {
    const sides = (await bridge.runCommand('sides', { repo: uri, mode, change, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) })) as {
      before: GitShowResult
      after: GitShowResult
    }
    const before = sideText(sides.before)
    const after = sideText(sides.after)
    if (before === 'binary' || after === 'binary') return update({ notice: vt('gitBinary', { name: change.path }) })
    if (before === 'too-large' || after === 'too-large') return update({ notice: vt('gitTooLarge', { name: change.path }) })
    const left: DiffSide = { name: sideLabel(specs.before, change.oldPath ?? change.path), text: before, language: null }
    const right: DiffSide = { name: sideLabel(specs.after, change.path), text: after, language: null }
    bridge.openDiff(uri, left, right)
  } catch (err) {
    update({ notice: errorText(err, from) })
  }
}

function setCompare(field: 'from' | 'to', value: string): void {
  // No redraw while typing (the field keeps its focus and caret).
  state = { ...state, compare: { ...state.compare, [field]: value } }
}

async function runCompare(): Promise<void> {
  const from = state.compare.from.trim()
  const to = state.compare.to.trim()
  if (from === '') return
  const bad = [from, to].find((rev) => rev !== '' && !isGitRev(rev))
  if (bad !== undefined) return update({ compare: { ...state.compare, result: null, loading: false, error: vt('gitInvalidRev', { rev: bad }) } })
  const seq = ++compareSeq
  compareBase = null
  update({ compare: { ...state.compare, loading: true, error: null, result: null } })
  try {
    const result = (await bridge.runCommand('compare', { repo: uri, from, ...(to === '' ? {} : { to }) })) as GitDiffResult
    if (seq !== compareSeq) return
    compareBase = { from, to }
    update({ compare: { ...state.compare, loading: false, result } })
  } catch (err) {
    if (seq !== compareSeq) return
    update({ compare: { ...state.compare, loading: false, error: errorText(err, from) } })
  }
}

bridge.onResource((event) => {
  if (event.uri !== uri) {
    uri = event.uri
    generation++
    compareSeq++
    compareBase = null
    state = {
      folder: folderName(event.uri, event.label),
      status: null,
      loading: false,
      error: null,
      notice: null,
      compare: { from: '', to: '', result: null, loading: false, error: null },
      commits: [] as readonly GitCommit[]
    }
    if (event.resource.kind === 'error') {
      update({ error: describeGitError(event.resource.message) })
      return
    }
    void refresh()
    return
  }
  // A resend for a theme / language change: redraw the wording only.
  render()
})

/** The last segment of the folder (the host's label if it has one). */
function folderName(viewUri: string, hostLabel: string): string {
  if (hostLabel !== '') return hostLabel
  const trimmed = viewUri.replace(/\/+$/, '')
  try {
    return decodeURIComponent(trimmed.slice(trimmed.lastIndexOf('/') + 1))
  } catch {
    return trimmed
  }
}
