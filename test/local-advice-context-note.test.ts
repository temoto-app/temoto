/**
 * TODO 1309 / TODO 1299: the local-model note says the app sets only the context length, and the no-viewer message no longer carries
 * the internal plugin id of the Diff extension.
 */
import { describe, expect, it } from 'vitest'
import { translate } from '../src/renderer/src/i18n/index.js'

describe('local model note and visible names', () => {
  it('states in EN and JA that only the context length (num_ctx) is set', () => {
    const en = translate('en', 'localAdvice.contextOnly')
    const ja = translate('ja', 'localAdvice.contextOnly')
    expect(en).toContain('Temoto sets only the context length (num_ctx)')
    expect(en).toContain('weights, template or prompts')
    expect(ja).toContain('Temoto が設定するのは文脈長 (num_ctx) だけ')
    expect(ja).toContain('重み・テンプレート・プロンプト')
  })

  it('does not show the internal id of the Diff extension in the no-viewer message', () => {
    expect(translate('en', 'viewer.noDiffViewer')).not.toContain('aios.diff')
    expect(translate('ja', 'viewer.noDiffViewer')).not.toContain('aios.diff')
  })
})
