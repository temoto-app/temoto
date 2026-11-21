/**
 * The git summary shown in the BottomBar (ARCHITECTURE.md 5.6, TODO 51).
 *
 * main's `GitStatusReader` builds it from one `git status --porcelain=v2 --branch`.
 * **No paths are included** (the renderer only sees URIs, the convention of chapter 7).
 * The cases that "should be hidden" (not under git, no `git`, timeout, no cwd) arrive as
 * `null` rather than this type. The renderer does not distinguish the reasons.
 */
export interface GitStatus {
  /** The branch name. If detached, a short commit id (7 digits). */
  readonly branch: string
  /** `HEAD` does not point to a branch (detached HEAD). */
  readonly detached: boolean
  /** Whether there is an upstream (`branch.upstream`). If not, ahead / behind stay 0. */
  readonly hasUpstream: boolean
  readonly ahead: number
  readonly behind: number
  /** Tracked entries with changes (the sum of ordinary / renamed / unmerged). */
  readonly changed: number
  /** Untracked entries. */
  readonly untracked: number
}
