/**
 * The history of the sidebar search box (TODO 900, wave 47 bundle C).
 *
 * Saved as one key of `app_settings` (`SEARCH_HISTORY`, owner is main - TODO 85). One for the whole app, shared by the three windows,
 * newest first, at most 20 entries. **Search terms are not logged** (they may contain secrets. The logger is not called here).
 * Values from the renderer are checked by `shared/search-history.ts`; a term that cannot be added is ignored and the current history is returned.
 */
import type { AppSettingsStore } from '../common/settings.js'
import { SEARCH_HISTORY } from '../common/settings-keys.js'
import { pushHistory, removeFromHistory, type SearchHistoryEntry } from '@shared/search-history.js'

export class SearchHistory {
  private current: readonly SearchHistoryEntry[]

  constructor(private readonly settings: AppSettingsStore) {
    this.current = settings.readTyped(SEARCH_HISTORY)
  }

  get(): readonly SearchHistoryEntry[] {
    return this.current
  }

  add(query: unknown, mode: unknown): readonly SearchHistoryEntry[] {
    return this.save(pushHistory(this.current, query, mode))
  }

  remove(query: unknown, mode: unknown): readonly SearchHistoryEntry[] {
    return this.save(removeFromHistory(this.current, query, mode))
  }

  clear(): readonly SearchHistoryEntry[] {
    return this.save([])
  }

  /** Write only when it changed. */
  private save(next: readonly SearchHistoryEntry[]): readonly SearchHistoryEntry[] {
    if (next.length === this.current.length && next.every((item, i) => item.query === this.current[i]?.query && item.mode === this.current[i]?.mode)) {
      return this.current
    }
    this.current = next
    this.settings.writeTyped(SEARCH_HISTORY, next)
    return this.current
  }
}
