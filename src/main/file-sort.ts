/**
 * The setting for the file tree's sort order (TODO 872, wave 43 bundle C, ARCHITECTURE.md 5.6).
 *
 * Stored in a single `app_settings` key (`UI_FILE_SORT_ORDER`, owner is main - TODO 85). It is one setting for the whole app, so a change
 * is notified to **all windows** (the same light shape as `ThreadCollapsePreference`). The sorting itself is SQL in the index process
 * (`IndexStore.children`) - main holds the value and just attaches it as `sortOrder` on every `fs.listDirectory`.
 */
import type { AppSettingsStore } from '../common/settings.js'
import { UI_FILE_SORT_ORDER } from '../common/settings-keys.js'
import { isFileSortOrder, type FileSortOrder } from '@shared/file-sort.js'

export class FileSortPreference {
  private current: FileSortOrder

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly onChanged: (order: FileSortOrder) => void = () => undefined
  ) {
    this.current = settings.readTyped(UI_FILE_SORT_ORDER)
  }

  get(): FileSortOrder {
    return this.current
  }

  /** An unknown value is not saved and the current value is returned. If it is the same value, nothing happens. */
  set(value: unknown): FileSortOrder {
    if (!isFileSortOrder(value) || value === this.current) return this.current
    this.current = value
    this.settings.writeTyped(UI_FILE_SORT_ORDER, value)
    this.onChanged(value)
    return this.current
  }
}
