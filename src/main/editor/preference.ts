/**
 * The setting for which external editor to open in (item 115). Stored in a single `app_settings` key
 * (`EDITOR_ID`, TODO 85). The same shape as `ThemeController` / `LocaleController` but
 * much lighter (no OS-following resolution - the chosen value is the effective value as is).
 */
import type { EditorId } from '@shared/editor.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { EDITOR_ID } from '../../common/settings-keys.js'

export class EditorPreference {
  private current: EditorId

  constructor(private readonly settings: AppSettingsStore) {
    this.current = settings.readTyped(EDITOR_ID)
  }

  get(): EditorId {
    return this.current
  }

  set(id: EditorId): EditorId {
    this.current = id
    this.settings.writeTyped(EDITOR_ID, id)
    return this.current
  }
}
