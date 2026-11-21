/**
 * Suggestions from the search history (TODO 900, wave 47 bundle C). Overlaid under the field's `.search-input-wrap` (position: relative).
 *
 * Focus stays on the field (pressing a suggestion does not steal focus from it: `preventDefault` in `onMouseDown`).
 * Up/Down / Enter / Esc are handled by the field's keydown (`SearchMode.tsx`); this component only shows and can be pressed.
 * Individual deletion is the remove mark at the right of a row, and "clear all search history" at the end clears everything. Search terms are only displayed and never go to the log.
 */
import type { SearchHistoryEntry, SearchHistoryMode } from '@shared/search-history.js'
import { useSearchHistory } from '../searchHistoryStore.js'
import { useT } from '../i18n/index.js'

/** The mode mark (the same emoji as the field's placeholder). The meaning is kept in `title` / `aria-label`. */
const MODE_ICON: Readonly<Record<SearchHistoryMode, string>> = { files: '📄', names: '🔍', conversation: '💬' }

export function SearchHistoryList({
  items,
  cursor,
  onPick
}: {
  readonly items: readonly SearchHistoryEntry[]
  /** Position of the highlighted suggestion (-1 = none chosen yet). */
  readonly cursor: number
  readonly onPick: (entry: SearchHistoryEntry) => void
}): React.JSX.Element {
  const t = useT()
  const remove = useSearchHistory((state) => state.remove)
  const clear = useSearchHistory((state) => state.clear)
  return (
    <div
      className="search-history"
      role="listbox"
      aria-label={t('search.history.label')}
      // Pressing a suggestion must not take focus off the field (if it did, blur would close the suggestions and the result of the press would not arrive).
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map(({ query, mode }, index) => (
        <div
          key={`${mode}:${query}`}
          role="option"
          aria-selected={index === cursor}
          className={`search-history-item${index === cursor ? ' active' : ''}`}
          onClick={() => onPick({ query, mode })}
        >
          <span className="search-history-mode" title={t(`search.history.mode.${mode}`)} aria-label={t(`search.history.mode.${mode}`)}>
            {MODE_ICON[mode]}
          </span>
          <span className="search-history-query">{query}</span>
          <button
            type="button"
            className="search-history-remove"
            aria-label={t('search.history.remove', { query })}
            onClick={(event) => {
              event.stopPropagation()
              void remove(query, mode)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="search-history-clear" onClick={() => void clear()}>
        {t('search.history.clear')}
      </button>
    </div>
  )
}
