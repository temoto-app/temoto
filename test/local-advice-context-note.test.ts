/**
 * TODO 1309 / 1315 / TODO 1299: the local-model note says the app sets only the context length (per request), and the no-viewer message no longer carries
 * the internal plugin id of the Diff extension.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { translate } from '../src/renderer/src/i18n/index.js'
import { contextNoteOf, folderNoteOf, legacyNoteOf } from '../src/renderer/src/i18n/local-advice.js'

describe('local model note and visible names', () => {
  it('states in EN and JA that only the context length (num_ctx) is set, per request, and no model is created (TODO 1315)', () => {
    const en = translate('en', 'localAdvice.contextOnly')
    const ja = translate('ja', 'localAdvice.contextOnly')
    expect(en).toContain('Temoto only sets the context length (num_ctx) on each request')
    expect(en).toContain('weights, template or prompts')
    expect(en).toContain('does not create models in Ollama')
    expect(ja).toContain('Temoto はリクエストごとに文脈長 (num_ctx) を指定するだけ')
    expect(ja).toContain('重み・テンプレート・プロンプト')
    expect(ja).toContain('Ollama にモデルを作りもしません')
  })

  it('tells how to remove models made by the retired button, in EN and JA (TODO 1315)', () => {
    for (const lang of ['en', 'ja'] as const) {
      const text = translate(lang, 'localAdvice.legacy', { models: 'aios-gpt-oss:20b' })
      expect(text).toContain('aios-gpt-oss:20b')
      expect(text).toContain('`ollama rm <')
    }
  })

  it('never advises removing derived models while the context length is not sent per request (review fix, wave 100)', () => {
    const models = ['aios-gpt-oss:20b']
    const sent = legacyNoteOf({ contextPerRequest: true, legacyModels: models })
    expect(sent?.key).toBe('localAdvice.legacy')
    for (const lang of ['en', 'ja'] as const) {
      expect(translate(lang, 'localAdvice.legacy', sent!.params)).toContain('`ollama rm <')
    }
    const kept = legacyNoteOf({ contextPerRequest: false, legacyModels: models })
    expect(kept?.key).toBe('localAdvice.legacyKept')
    for (const lang of ['en', 'ja'] as const) {
      const text = translate(lang, 'localAdvice.legacyKept', kept!.params)
      expect(text).toContain('aios-gpt-oss:20b')
      expect(text).not.toContain('ollama rm')
    }
    expect(legacyNoteOf({ contextPerRequest: false, legacyModels: [] })).toBeNull()
  })

  it('explains why the context length is not sent: missing part, old agent CLI (with the version), own provider (review fix, wave 100)', () => {
    expect(contextNoteOf({ contextBlocker: null, defaultContext: 4096 }, '4096')).toBeNull()
    const missing = contextNoteOf({ contextBlocker: { kind: 'bundle-missing' }, defaultContext: 4096 }, '4096')
    expect(missing?.key).toBe('localAdvice.contextUnavailable')
    const old = contextNoteOf({ contextBlocker: { kind: 'backend-old', minVersion: '2.1.4' }, defaultContext: 4096 }, '4096')
    expect(old?.key).toBe('localAdvice.contextBackendOld')
    for (const lang of ['en', 'ja'] as const) {
      expect(translate(lang, old!.key, old!.params)).toContain('2.1.4')
      expect(translate(lang, old!.key, old!.params)).toContain('4096')
    }
    const own = contextNoteOf({ contextBlocker: { kind: 'own-provider' }, defaultContext: 4096 }, '4096')
    expect(own?.key).toBe('localAdvice.contextOwnProvider')
    expect(translate('en', own!.key, own!.params)).toContain('your own Ollama provider')
    expect(translate('ja', own!.key, own!.params)).toContain('自分の Ollama の provider')
  })

  it('renders the general folder-provider note in the one shared component (settings field and creation dialog), only without another reason (TODO 1321)', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/components/LocalModelAdvice.tsx'), 'utf8')
    expect(src).toContain('folderNoteOf(advice)')
    // No folder goes to the backend before the conversation exists.
    expect(src).not.toContain('folderUri')
    for (const lang of ['en', 'ja'] as const) {
      expect(translate(lang, 'localAdvice.contextFolderNote')).not.toContain('{app}')
    }
    for (const file of ['Settings.tsx', 'NewThreadDialog.tsx']) {
      expect(readFileSync(join(__dirname, '../src/renderer/src/components', file), 'utf8')).toContain('<LocalModelAdvice ')
    }
  })

  it('shows the folder-provider note only where a context length the app sends is listed (review fix Y, TODO 1321)', () => {
    const pick = { model: 'm' } as never
    expect(folderNoteOf({ contextBlocker: null, picks: [pick] })?.key).toBe('localAdvice.contextFolderNote')
    // No recommendation listed (no runtime / no candidate): no context length is shown, so the note would be noise.
    expect(folderNoteOf({ contextBlocker: null, picks: [] })).toBeNull()
    // The context length is not sent: the blocker has its own note.
    expect(folderNoteOf({ contextBlocker: { kind: 'own-provider' }, picks: [pick] })).toBeNull()
  })

  it('does not show the internal id of the Diff extension in the no-viewer message', () => {
    expect(translate('en', 'viewer.noDiffViewer')).not.toContain('aios.diff')
    expect(translate('ja', 'viewer.noDiffViewer')).not.toContain('aios.diff')
  })
})
