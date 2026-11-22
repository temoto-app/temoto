/**
 * The plugin-host side of `aios.git` (TODO 834 stage 1, ARCHITECTURE 7.4.14). **Read-only.**
 *
 * **This code does not run in main** (constraint 8) and never builds a command line: it only states intents through `api.git` (the Broker's read-only
 * git capability), which works only on the folder the user opened in the Source Control view. The viewer calls these commands with that view's
 * `aios-git:` URI; the values are re-checked here (shape) and again in main (grant, file policy, revs, paths).
 */
import { isGitRev } from '@shared/git-rev.js'
import {
  fileUriOfGitRepository,
  isGitRelativePath,
  type GitChange,
  type GitChangeStatus,
  type GitShowResult
} from '@shared/plugin-git.js'
import type { PluginApi, PluginModule } from '@shared/plugin.js'
import { changeSides, type ChangeMode, type SideSpec } from '../common/sides.js'

const STATUSES: readonly GitChangeStatus[] = ['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted']
/** How many commits the viewer lists to pick a version from. */
const LOG_PAGE = 100

function record(arg: unknown): Record<string, unknown> {
  return typeof arg === 'object' && arg !== null && !Array.isArray(arg) ? (arg as Record<string, unknown>) : {}
}

/** The `file:` URI of the opened folder (from the view's `aios-git:` URI). */
export function repoOf(arg: Record<string, unknown>): string {
  const repo = arg['repo']
  const fileUri = typeof repo === 'string' ? fileUriOfGitRepository(repo) : null
  if (fileUri === null) throw new Error('invalid-repo')
  return fileUri
}

function optionalRev(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!isGitRev(value)) throw new Error('invalid-rev')
  return value
}

export function changeOf(value: unknown): GitChange {
  const raw = record(value)
  const path = raw['path']
  const status = raw['status']
  const oldPath = raw['oldPath']
  if (!isGitRelativePath(path) || typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) throw new Error('invalid-change')
  if (oldPath !== undefined && !isGitRelativePath(oldPath)) throw new Error('invalid-change')
  return { path, status: status as GitChangeStatus, ...(oldPath === undefined ? {} : { oldPath }) }
}

function modeOf(value: unknown): ChangeMode {
  if (value === 'staged' || value === 'unstaged' || value === 'compare') return value
  throw new Error('invalid-mode')
}

async function readSide(api: PluginApi, repo: string, side: SideSpec | null): Promise<GitShowResult> {
  return side === null ? { kind: 'missing' } : api.git.show(repo, side.rev, side.path)
}

const plugin: PluginModule = {
  commands: {
    /** The working tree's changes ("Staged Changes" and "Changes"). */
    status: (arg, api) => api.git.status(repoOf(record(arg))),
    /** The files that differ between two versions (`to` omitted = the working tree). */
    compare: (arg, api) => {
      const input = record(arg)
      const from = optionalRev(input['from'])
      const to = optionalRev(input['to'])
      if (from === undefined) throw new Error('invalid-rev')
      return api.git.diff(repoOf(input), to === undefined ? { from } : { from, to })
    },
    /** Recent commits, to pick a version from. */
    log: (arg, api) => {
      const input = record(arg)
      const skip = input['skip']
      return api.git.log(repoOf(input), {
        limit: LOG_PAGE,
        ...(typeof skip === 'number' && Number.isInteger(skip) && skip > 0 ? { skip } : {})
      })
    },
    /** Both sides of one change (the viewer opens them in the diff view). */
    sides: async (arg, api) => {
      const input = record(arg)
      const repo = repoOf(input)
      const mode = modeOf(input['mode'])
      const from = optionalRev(input['from'])
      const to = optionalRev(input['to'])
      // A range (`a..b` / `a...b`) lists files but is not one version of a file: refuse it here (main refuses it too).
      if (mode === 'compare' && [from, to].some((rev) => rev !== undefined && rev.includes('..'))) throw new Error('invalid-rev')
      const sides = changeSides(mode, changeOf(input['change']), from, to)
      const [before, after] = await Promise.all([readSide(api, repo, sides.before), readSide(api, repo, sides.after)])
      return { before, after }
    }
  }
}

export default plugin
