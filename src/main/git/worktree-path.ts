/**
 * Check of the worktree location path (TODO 633 stage 1, pure function). The stream reader (`session/adapter/worktree.ts`, whether the
 * launch cwd is already a worktree) and the cleanup (`git/worktree-cleanup.ts`, whether it is a place that may be removed) apply the same rule
 * (code-review fix: there used to be two copies with slightly different rules, one of which `resolve`d the child and let
 * `..` through, the other refused non-normalized paths. Unified on the safe side = refuse).
 *
 * The path suffix of the location (`suffix`) is **taken as an argument**: the real value comes from compat (`WORKTREES_PATH_SUFFIX`
 * in `common/exclusions.ts`), and the backend's name string is not written here (constraint 6).
 */
import { isAbsolute, resolve } from 'node:path'

/**
 * Whether `path` is exactly one level below the worktree location of `root` (`<root><suffix>/<name>`). `path` must be absolute and
 * already normalized (anything containing `..`, `.` or repeated `/` is refused; a trailing `/` is allowed). Two levels down and the location itself are excluded.
 */
export function isDirectWorktreeOf(path: string, root: string, suffix: string): boolean {
  if (!isAbsolute(path) || resolve(path) !== path.replace(/\/+$/, '')) return false
  const base = `${resolve(root)}${suffix}/`
  if (!path.startsWith(base)) return false
  const name = path.slice(base.length).replace(/\/+$/, '')
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/')
}
