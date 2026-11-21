/**
 * TODO 1281: the common error notice. Pure parts only (`buildNotice`, `internalErrorParams`, the dictionary entries).
 */
import { describe, expect, it } from 'vitest'
import { buildNotice, RECOVERY_CODES } from '../src/renderer/src/error-notice.js'
import { DICTIONARIES, translate } from '../src/renderer/src/i18n/index.js'
import { internalErrorParams, toIpcError } from '../src/main/ipc/handlers.js'
import { formatReason, parseReason } from '../src/shared/reason.js'

const en = (key: string, params?: Record<string, string | number>): string => translate('en', key, params)
const ja = (key: string, params?: Record<string, string | number>): string => translate('ja', key, params)

describe('internalErrorParams (TODO 1281)', () => {
  it('carries only the channel, the error kind, an errno-style code and the time - no message', () => {
    const err = Object.assign(new Error('ENOENT: /secret/token=abc'), { code: 'ENOENT' })
    const params = internalErrorParams('aios:thread/send', err)
    expect(params.channel).toBe('aios:thread/send')
    expect(params.kind).toBe('Error')
    expect(params.code).toBe('ENOENT')
    expect(Number.isNaN(Date.parse(params.at ?? ''))).toBe(false)
    expect(JSON.stringify(params)).not.toContain('secret')
  })

  it('strips odd characters and caps the length of what an error names itself', () => {
    const err = new Error('x')
    err.name = 'Bad Name "with" <junk>' + 'z'.repeat(100)
    const kind = internalErrorParams('aios:fs/read', err).kind ?? ''
    expect(kind).not.toMatch(/[ "<>]/)
    expect(kind.length).toBeLessThanOrEqual(48)
  })

  it('a non-Error value is kind "unknown" and has no code', () => {
    const params = internalErrorParams('aios:fs/read', 'boom')
    expect(params.kind).toBe('unknown')
    expect(params.code).toBeUndefined()
  })

  it('toIpcError puts the params into the reason, and the raw message stays out', () => {
    const reason = parseReason(toIpcError('aios:thread/send', new Error('leak /secret/path')).message)
    expect(reason?.code).toBe('internal-error')
    expect(reason?.params.channel).toBe('aios:thread/send')
    expect(JSON.stringify(reason)).not.toContain('/secret/path')
  })
})

describe('buildNotice (TODO 1281)', () => {
  const tr = (key: string, params?: Record<string, string | number>): string => en(key, params)

  it('names the failed area, adds a recovery step and keeps the technical rows separate', () => {
    const message = `Error invoking remote method 'x': Error: ${formatReason('internal-error', {
      channel: 'aios:thread/send',
      kind: 'TypeError',
      code: 'EACCES',
      at: '2026-11-21T01:02:03.456Z'
    })}`
    const view = buildNotice(tr, message)
    expect(view.code).toBe('internal-error')
    expect(view.summary).toBe('Could not complete: a conversation operation.')
    expect(view.recovery).toContain('Try the action again')
    expect(view.rows.map((row) => row.value).join('|')).toContain('aios:thread/send')
    expect(view.rows.map((row) => row.value).join('|')).toContain('TypeError')
    expect(view.rows.map((row) => row.value).join('|')).toContain('2026-11-21T01:02:03.456Z')
    expect(view.at).toBe('2026-11-21T01:02:03.456Z')
    // The summary never contains the technical values.
    expect(view.summary).not.toContain('TypeError')
  })

  it('an unknown area or a bare internal-error falls back to the generic sentence / dictionary text', () => {
    const unknown = buildNotice(tr, formatReason('internal-error', { channel: 'aios:nope/x' }))
    expect(unknown.summary).toBe('Something went wrong.')
    const bare = buildNotice(tr, 'internal-error')
    expect(bare.summary).toBe(en('reason.internal-error'))
    expect(bare.at).toBeNull()
  })

  it('a code with no recovery entry shows none; a raw sentence is shown as it is', () => {
    expect(buildNotice(tr, 'capture-cancelled').recovery).toBeNull()
    const raw = buildNotice(tr, 'some raw sentence')
    expect(raw.code).toBeNull()
    expect(raw.summary).toBe('some raw sentence')
    expect(raw.rows).toEqual([])
  })

  it('works in Japanese too', () => {
    const view = buildNotice(ja, formatReason('internal-error', { channel: 'aios:fs/read', at: '2026-11-21T01:02:03.456Z' }))
    expect(view.summary).toBe('完了できませんでした: ファイルの操作')
    expect(view.rows.some((row) => row.label === '発生時刻')).toBe(true)
  })
})

describe('dictionary (TODO 1281)', () => {
  it('every recovery code has a sentence in both languages', () => {
    for (const code of RECOVERY_CODES) {
      for (const locale of ['en', 'ja'] as const) {
        expect(DICTIONARIES[locale][`error.recovery.${code}` as keyof (typeof DICTIONARIES)['en']]).toBeTruthy()
      }
    }
  })
})
