/**
 * The setting "Suggest new screenshots" (TODO 999, `composer.screenshotOffer`, on by default). The only writer.
 */
import type { AppSettingsStore } from '../../common/settings.js'
import { COMPOSER_SCREENSHOT_OFFER } from '../../common/settings-keys.js'

export class ScreenshotOfferPreference {
  private current: boolean

  constructor(private readonly settings: AppSettingsStore) {
    this.current = settings.readTyped(COMPOSER_SCREENSHOT_OFFER)
  }

  get(): boolean {
    return this.current
  }

  set(enabled: boolean): boolean {
    this.current = enabled
    this.settings.writeTyped(COMPOSER_SCREENSHOT_OFFER, enabled)
    return this.current
  }
}
