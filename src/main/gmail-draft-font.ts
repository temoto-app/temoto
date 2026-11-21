/**
 * Storage of the body font of Gmail drafts (TODO 1229). The only writer of one `app_settings` key (`GMAIL_DRAFT_FONT`) (owner is main, TODO 85).
 * Does not depend on electron. It looks up the storage on every read, so it never disagrees with the value read by the conversation launch side (`ThreadStore.gmailDraftFont`).
 */
import type { GmailDraftFont } from '@shared/gmail-draft-font.js'
import type { AppSettingsStore } from '../common/settings.js'
import { GMAIL_DRAFT_FONT } from '../common/settings-keys.js'

export class GmailDraftFontPreference {
  constructor(private readonly settings: AppSettingsStore) {}

  get(): GmailDraftFont {
    return this.settings.readTyped(GMAIL_DRAFT_FONT)
  }

  set(font: GmailDraftFont): GmailDraftFont {
    this.settings.writeTyped(GMAIL_DRAFT_FONT, font)
    return this.get()
  }
}
