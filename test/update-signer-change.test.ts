import { describe, expect, it } from 'vitest'
import { detectKeychainPrompt, keychainPromptExpected, readBundleSigner } from '../src/main/update/signer-change.js'
import type { CommandRunner } from '../src/main/update/release-source.js'
import type { BundleSigner } from '../src/main/update/stage.js'

const devId: BundleSigner = { kind: 'developer-id', teamId: 'LVG3JZJZ3U' }
const selfSigned: BundleSigner = { kind: 'self-signed', name: 'aios dev' }
const adhoc: BundleSigner = { kind: 'adhoc' }

describe('keychainPromptExpected (TODO 1090)', () => {
  it('同じ署名の主なら出さない', () => {
    expect(keychainPromptExpected(devId, { ...devId })).toBe(false)
    expect(keychainPromptExpected(selfSigned, { ...selfSigned })).toBe(false)
  })
  it('署名の主が変わるなら出す', () => {
    expect(keychainPromptExpected(selfSigned, devId)).toBe(true)
    expect(keychainPromptExpected(devId, { kind: 'developer-id', teamId: 'OTHER00000' })).toBe(true)
    expect(keychainPromptExpected(selfSigned, { kind: 'self-signed', name: 'other' })).toBe(true)
  })
  it('どちらかが読めなければ出す', () => {
    expect(keychainPromptExpected(null, devId)).toBe(true)
    expect(keychainPromptExpected(devId, null)).toBe(true)
    expect(keychainPromptExpected(null, null)).toBe(true)
  })
  it('ad-hoc は同じとみなさず出す', () => {
    expect(keychainPromptExpected(adhoc, adhoc)).toBe(true)
    expect(keychainPromptExpected(devId, adhoc)).toBe(true)
    expect(keychainPromptExpected({ kind: 'other', authority: 'x', teamId: null }, { kind: 'other', authority: 'x', teamId: null })).toBe(true)
  })
})

const DEV_ID_DETAIL = [
  'Identifier=io.github.temoto-app.temoto',
  'Authority=Developer ID Application: Someone (LVG3JZJZ3U)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=LVG3JZJZ3U'
].join('\n')
const SELF_DETAIL = ['Identifier=io.github.temoto-app.temoto', 'Authority=aios dev', 'TeamIdentifier=not set'].join('\n')

function runner(table: Record<string, { code: number; stderr: string } | 'throw'>): CommandRunner {
  return async (_command, args) => {
    const bundle = String(args[args.length - 1])
    const entry = table[bundle]
    if (entry === undefined || entry === 'throw') throw new Error('ENOENT')
    return { code: entry.code, stdout: '', stderr: entry.stderr }
  }
}

describe('readBundleSigner / detectKeychainPrompt', () => {
  it('codesign の出力から署名の主を読む', async () => {
    const run = runner({ '/a.app': { code: 0, stderr: DEV_ID_DETAIL } })
    expect(await readBundleSigner('/a.app', run)).toEqual(devId)
  })
  it('codesign が失敗・投げたら null', async () => {
    const run = runner({ '/a.app': { code: 1, stderr: '' }, '/b.app': 'throw' })
    expect(await readBundleSigner('/a.app', run)).toBeNull()
    expect(await readBundleSigner('/b.app', run)).toBeNull()
  })
  it('二つの .app を読み比べる', async () => {
    const run = runner({
      '/old.app': { code: 0, stderr: SELF_DETAIL },
      '/new.app': { code: 0, stderr: DEV_ID_DETAIL },
      '/new2.app': { code: 0, stderr: SELF_DETAIL }
    })
    expect(await detectKeychainPrompt('/old.app', '/new.app', run)).toBe(true)
    expect(await detectKeychainPrompt('/old.app', '/new2.app', run)).toBe(false)
    expect(await detectKeychainPrompt('/old.app', '/missing.app', run)).toBe(true)
  })
})
