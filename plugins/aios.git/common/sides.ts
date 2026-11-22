/**
 * Which two versions of a file one picked change compares (TODO 834 stage 1). Pure; shared by the host side (which reads the contents) and the viewer
 * (which labels the two sides). The modes follow VS Code's Source Control view:
 *
 * - `staged` ("Staged Changes"): HEAD -> the index.
 * - `unstaged` ("Changes"): the index -> the working tree (an untracked file: nothing -> the working tree; a conflict: HEAD -> the working tree).
 * - `compare` (two versions): `from` -> `to`, or `from` -> the working tree when `to` is omitted.
 *
 * The left side reads the old path of a rename / copy. A side where the file does not exist (added / deleted) is `null` = an empty text.
 */
import { GIT_INDEX, GIT_WORKTREE, type GitChange, type GitSide } from '@shared/plugin-git.js'

export type ChangeMode = 'staged' | 'unstaged' | 'compare'

export interface SideSpec {
  readonly rev: GitSide
  readonly path: string
}

export interface ChangeSides {
  readonly before: SideSpec | null
  readonly after: SideSpec | null
}

export function changeSides(mode: ChangeMode, change: GitChange, from?: string, to?: string): ChangeSides {
  const oldPath = change.oldPath ?? change.path
  const left = (rev: GitSide): SideSpec | null => (change.status === 'added' || change.status === 'untracked' ? null : { rev, path: oldPath })
  const right = (rev: GitSide): SideSpec | null => (change.status === 'deleted' ? null : { rev, path: change.path })
  switch (mode) {
    case 'staged':
      return { before: left('HEAD'), after: right(GIT_INDEX) }
    case 'unstaged':
      return { before: left(change.status === 'conflicted' ? 'HEAD' : GIT_INDEX), after: right(GIT_WORKTREE) }
    case 'compare':
      return { before: left(from ?? 'HEAD'), after: right(to ?? GIT_WORKTREE) }
  }
}

/** The one-letter mark of a status (VS Code's letters; `!` for a conflict). */
export function statusLetter(status: GitChange['status']): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'modified':
      return 'M'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'typechange':
      return 'T'
    case 'untracked':
      return 'U'
    case 'conflicted':
      return '!'
  }
}
