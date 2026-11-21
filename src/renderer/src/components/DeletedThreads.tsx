/**
 * The list of deleted threads and restore (item 191, ARCHITECTURE.md 4.3.3).
 *
 * "Deleted (N)" is placed collapsed at the **very bottom** of the SideBar's thread list. It is not placed in the settings screen
 * (owner decision 2026-09-28). The retention period is unlimited: for rows soft-deleted (item 64) there is no
 * cleanup mechanism that removes them, so this list keeps growing as is.
 *
 * Main has no dedicated push for the deleted list (`threadsChanged` carries only
 * all the living threads). So re-fetching is limited to "when the fold is opened" and "right after a delete / restore"
 * (handled by `threadStore.removeThread` / `restoreThread`). It is also fetched once on mount,
 * so "show nothing for 0 items" is satisfied from the start even if it was never opened.
 */
import { useEffect, useState } from 'react'
import { useThreads } from '../threadStore.js'
import { rainbowStyle } from '../rainbow.js'
import { useT, type Translate } from '../i18n/index.js'
import { threadTitleLabel } from '../thread/title.js'
import { formatWhen } from '../thread/timeline.js'

/** The sentence for the marker of worktrees left by cleanup (TODO 633 stage 1). */
export function keptWorktreesLabel(t: Translate, count: number): string {
  return t(count === 1 ? 'threads.deleted.keptWorktrees.one' : 'threads.deleted.keptWorktrees.other', { count })
}

export function DeletedThreads(): React.JSX.Element | null {
  const t = useT()
  const deletedThreads = useThreads((state) => state.deletedThreads)
  const loadDeletedThreads = useThreads((state) => state.loadDeletedThreads)
  const restoreThread = useThreads((state) => state.restoreThread)
  const [expanded, setExpanded] = useState(false)

  // Once on mount (the count is needed even while collapsed).
  useEffect(() => {
    void loadDeletedThreads()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (deletedThreads.length === 0) return null

  return (
    <div className="deleted-threads">
      <button
        type="button"
        className="deleted-threads-toggle"
        aria-expanded={expanded}
        onClick={() => {
          const next = !expanded
          setExpanded(next)
          // Re-fetch every time it is opened (so it is current even if something was restored / deleted in another window while it was collapsed).
          if (next) void loadDeletedThreads()
        }}
      >
        <span className="deleted-threads-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        {t('threads.deleted.heading', { count: deletedThreads.length })}
      </button>
      {expanded ? (
        <ul className="deleted-threads-rows">
          {deletedThreads.map((entry) => (
            <li
              key={entry.id}
              className="deleted-thread-row"
              style={rainbowStyle(entry.rainbow)}
              title={formatWhen(entry.deletedAt, t)}
            >
              {entry.cwdName !== '' ? (
                <span className="deleted-thread-cwd">{entry.cwdName}</span>
              ) : null}
              <span className="deleted-thread-title">{threadTitleLabel(t, entry.title)}</span>
              {/* TODO 633 stage 1: worktrees left by cleanup (with changes or unpushed commits). They are kept without asking, with only a marker. */}
              {entry.keptWorktrees !== undefined ? (
                <span
                  className="deleted-thread-worktrees"
                  role="img"
                  aria-label={keptWorktreesLabel(t, entry.keptWorktrees)}
                  title={keptWorktreesLabel(t, entry.keptWorktrees)}
                >
                  ⎇ {entry.keptWorktrees}
                </span>
              ) : null}
              <button
                type="button"
                className="deleted-thread-restore"
                onClick={() => void restoreThread(entry.id)}
              >
                {t('threads.deleted.restore')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
