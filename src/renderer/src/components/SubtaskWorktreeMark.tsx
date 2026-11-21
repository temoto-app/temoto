/**
 * The badge for a child's worktree (TODO 633 stage 2, owner decision 2026-10-13: show it by inference; do not show a PR).
 *
 * Only when main has **checked with git that it really exists** is it put in `runtime.subagentWorktrees` (`session/subtask-worktrees.ts`).
 * This only looks it up and shows "branch" with a mark and whether there is a commit (a dot). Pressing it opens that worktree in Files
 * (`revealFolderInFiles`). There is no git operation screen (631). A string is fetched, so a change of other children does not cause a re-render.
 *
 * A row of the list (`SubtaskList`) is itself a "jump to the block" button, so there it is made a badge that cannot be pressed (`plain`).
 * The list for `/batch` units reuses the children's list as is (no separate list is made).
 */
import type { SubtaskWorktree } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'
import { revealFolderInFiles } from '../shortcut-actions.js'

export function useSubtaskWorktree(threadId: string | null, toolUseId: string | null): SubtaskWorktree | null {
  return useThreads((state) =>
    threadId === null || toolUseId === null
      ? null
      : (state.threadsById[threadId]?.runtime.subagentWorktrees?.[toolUseId] ?? null)
  )
}

export function SubtaskWorktreeMark({
  threadId,
  toolUseId,
  plain = false,
  spaced = false
}: {
  threadId: string | null
  toolUseId: string | null
  /** A badge that cannot be pressed (when placed inside a button). */
  plain?: boolean
  /** Put one space in front (only when there is a mark; so no space is left at the end of a line). */
  spaced?: boolean
}): React.JSX.Element | null {
  const t = useT()
  const worktree = useSubtaskWorktree(threadId, toolUseId)
  if (worktree === null) return null
  const label = `⎇ ${worktree.branch}${worktree.committed ? ' ●' : ''}`
  const title = [
    t('subtasks.worktree', { branch: worktree.branch }),
    worktree.committed ? t('subtasks.worktreeCommitted') : null,
    plain ? null : t('subtasks.worktreeOpen')
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  if (plain) {
    return (
      <>
        {spaced ? ' ' : null}
        <span className="subtask-worktree" title={title}>
          {label}
        </span>
      </>
    )
  }
  return (
    <>
      {spaced ? ' ' : null}
      <button
        type="button"
        className="subtask-worktree subtask-worktree-button"
        title={title}
        onClick={() => revealFolderInFiles(worktree.uri)}
      >
        {label}
      </button>
    </>
  )
}
