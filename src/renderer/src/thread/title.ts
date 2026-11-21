/**
 * Showing a thread's title (TODO 66, ARCHITECTURE.md 7.4.4).
 *
 * main sends a provisional title (a thread with no name yet) as an **empty string that does not depend on the language** (`UNTITLED_THREAD_TITLE`).
 * Replacing it with the dictionary's `thread.untitled` is done in this one place.
 *
 * "New thread" (the Japanese default title) left in DBs from before TODO 66 is normalized by `ThreadStore`, which looks at `title_auto`,
 * and sent as an empty string, so **strings are not compared here** - so that a title the user typed by hand with that same Japanese wording
 * (item 83) is not turned into "New thread" in the English display.
 */
import { UNTITLED_THREAD_TITLE } from '@shared/thread.js'
import type { Translate } from '../i18n/index.js'

export function threadTitleLabel(t: Translate, title: string): string {
  return title === UNTITLED_THREAD_TITLE ? t('thread.untitled') : title
}
