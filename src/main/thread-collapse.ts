/**
 * The setting for after how many days of inactivity rows in the thread list are folded (TODO 659, wave 30 bundle C, ARCHITECTURE.md 4.3).
 *
 * Saved as one key of `app_settings` (`THREADS_COLLAPSE_OLD_AFTER_DAYS`, owner is main - TODO 85). It is one for the whole app,
 * so when it changes **all windows** are told (the same light shape as `AutoSavePreference`). The judgment of age and the folding itself are in the
 * renderer's `thread-sort.ts` (pure functions) - this only holds the setting's value.
 */
import type { AppSettingsStore } from '../common/settings.js'
import { THREADS_COLLAPSE_OLD_AFTER_DAYS } from '../common/settings-keys.js'
import { isCollapseOldAfterDays } from '@shared/thread-collapse.js'

export class ThreadCollapsePreference {
  private current: number

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly onChanged: (days: number) => void = () => undefined
  ) {
    this.current = settings.readTyped(THREADS_COLLAPSE_OLD_AFTER_DAYS)
  }

  get(): number {
    return this.current
  }

  /**
   * An out-of-range, non-integer or non-number value is **not saved** and the current value is returned (a code-review fix, TODO 659).
   * Even if a value like "-5" is typed in the field, it is not silently rounded to 0 - aligned with the "refuse" practice of the other entry points
   * that check values (`FsService.assertAllowed` and the like).
   */
  set(value: unknown): number {
    if (!isCollapseOldAfterDays(value) || value === this.current) return this.current
    this.current = value
    this.settings.writeTyped(THREADS_COLLAPSE_OLD_AFTER_DAYS, value)
    this.onChanged(value)
    return this.current
  }
}
