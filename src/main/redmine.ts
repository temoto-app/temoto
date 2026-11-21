/**
 * The Redmine base URL setting (TODO 811, wave 44 bundle A, ARCHITECTURE.md 5.1).
 *
 * It is saved as one key of `app_settings` (`WEB_REDMINE_BASE_URL`, owner is main - TODO 85). One for the whole app (multiple Redmines are not
 * supported - owner decision 2026-10-18). Empty = not set (no links are made). When it changes, **all windows** are told.
 * Only an https URL checked by `normalizeRedmineBase` is accepted (an unusable value is not saved and the current value is returned).
 */
import type { AppSettingsStore } from '../common/settings.js'
import { WEB_REDMINE_BASE_URL } from '../common/settings-keys.js'
import { normalizeRedmineBase } from '@shared/redmine-link.js'

export class RedmineBasePreference {
  private current: string

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly onChanged: (baseUrl: string) => void = () => undefined
  ) {
    this.current = settings.readTyped(WEB_REDMINE_BASE_URL)
  }

  /** The saved value (an empty string if not set). */
  get(): string {
    return this.current
  }

  /** Empty goes back to not set. An unusable value is not saved and the current value is returned. The same value does nothing. */
  set(value: unknown): string {
    if (typeof value !== 'string') return this.current
    const next = value.trim() === '' ? '' : normalizeRedmineBase(value)
    if (next === null || next === this.current) return this.current
    this.current = next
    this.settings.writeTyped(WEB_REDMINE_BASE_URL, next)
    this.onChanged(next)
    return this.current
  }
}
