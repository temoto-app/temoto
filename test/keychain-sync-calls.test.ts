/**
 * TODO 1344 item 2: Electron 46 removes `safeStorage`'s synchronous entry points. Every synchronous call lives in
 * `src/main/keychain/sync.ts`, so the move to 46 is "delete that file and fix what no longer compiles". This test keeps it that way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const ALLOWED = ['src/main/keychain/sync.ts']
const SYNC_CALL = /\b(?:encryptString|decryptString|isEncryptionAvailable)\s*\(/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path)
  }
  return out
}

describe('the synchronous safeStorage entry points are called from one file only', () => {
  it('no file under src/ other than the allowed one calls them', () => {
    const offenders: string[] = []
    for (const path of sources(join(ROOT, 'src'))) {
      const rel = relative(ROOT, path).split(sep).join('/')
      if (ALLOWED.includes(rel)) continue
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const code = line.replace(/\/\/.*$/, '')
          if (SYNC_CALL.test(code) && !/^\s*\*/.test(code)) offenders.push(`${rel}:${index + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('the check itself catches a call (so an empty result means something)', () => {
    expect(SYNC_CALL.test('safeStorage.decryptString(buffer)')).toBe(true)
    expect(SYNC_CALL.test('storage.isEncryptionAvailable()')).toBe(true)
    expect(SYNC_CALL.test('safeStorage.decryptStringAsync(buffer)')).toBe(false)
    expect(SYNC_CALL.test('safeStorage.encryptStringAsync(text)')).toBe(false)
  })
})
