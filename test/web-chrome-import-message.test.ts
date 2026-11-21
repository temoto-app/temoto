/**
 * TODO 676 code-review fix: `chromeImportResultMessage` (`webStore.ts`) shows `skippedOverLimit`. Before the fix it was counted (`ChromeImportResult.skippedOverLimit`),
 * but it appeared in no message, and the part that could not be imported disappeared silently. Neither the model nor Electron is used.
 */
import { describe, expect, it } from 'vitest'
import { chromeImportResultMessage } from '../src/renderer/src/webStore.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import { MAX_WEB_FAVORITES } from '../src/shared/web-tabs.js'

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string =>
  translate('ja', key, params)

describe('chromeImportResultMessage', () => {
  it('取り込んだだけなら件数だけ', () => {
    expect(chromeImportResultMessage(t, { imported: 3, alreadyPresent: 0, skippedOverLimit: 0 })).toBe(
      t('web.favorites.chromeImport.done.other', { imported: 3 })
    )
  })

  it('既にあった分は括弧で続ける', () => {
    const message = chromeImportResultMessage(t, { imported: 2, alreadyPresent: 1, skippedOverLimit: 0 })
    expect(message).toContain(t('web.favorites.chromeImport.done.other', { imported: 2 }))
    expect(message).toContain(t('web.favorites.chromeImport.existing.one', { existing: 1 }))
  })

  // The main point: the count skipped by the cap appears in the message.
  it('上限で飛ばした分は「上限 N 件のため M 件は取り込めませんでした」が付く', () => {
    const message = chromeImportResultMessage(t, { imported: 5, alreadyPresent: 0, skippedOverLimit: 2 })
    expect(message).toContain(
      t('web.favorites.chromeImport.skipped.other', { skipped: 2, limit: MAX_WEB_FAVORITES })
    )
    expect(message).toContain(String(MAX_WEB_FAVORITES))
  })

  it('3 つとも非ゼロなら 3 つとも出る', () => {
    const message = chromeImportResultMessage(t, { imported: 1, alreadyPresent: 1, skippedOverLimit: 1 })
    expect(message).toContain(t('web.favorites.chromeImport.done.one', { imported: 1 }))
    expect(message).toContain(t('web.favorites.chromeImport.existing.one', { existing: 1 }))
    expect(message).toContain(t('web.favorites.chromeImport.skipped.one', { skipped: 1, limit: MAX_WEB_FAVORITES }))
  })

  it('EN でも同じ形', () => {
    const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string =>
      translate('en', key, params)
    const message = chromeImportResultMessage(en, { imported: 1, alreadyPresent: 0, skippedOverLimit: 1 })
    expect(message).toBe(
      `${en('web.favorites.chromeImport.done.one', { imported: 1 })} ${en('web.favorites.chromeImport.skipped.one', { skipped: 1, limit: MAX_WEB_FAVORITES })}`
    )
  })
})
