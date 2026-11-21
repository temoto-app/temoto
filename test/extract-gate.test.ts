/**
 * extractGate / readRange (wave 41 code-review: the fix for TODO 845).
 * getDocument's fs does not read the full text and goes only through the same gate as extractFile. readRange snaps to character boundaries.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { closeSync, ftruncateSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_FILE_BYTES, extractGate, readRange } from '../src/index-kernel/extract.js'
import { makeTestDir } from './helpers/tmp.js'

const dir = makeTestDir('extract-gate')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function sparse(path: string, size: number): void {
  const fd = openSync(path, 'w')
  ftruncateSync(fd, size)
  closeSync(fd)
}

describe('extractGate', () => {
  it('normal text passes', async () => {
    const p = join(dir, 'a.md')
    writeFileSync(p, '本文\n')
    expect(await extractGate(p)).toBeNull()
  })

  it('stops one that is too large, by extension, binary, empty, or bundle', async () => {
    const big = join(dir, 'big.txt')
    sparse(big, MAX_FILE_BYTES + 1)
    expect(await extractGate(big)).toBe('too-large')
    const png = join(dir, 'a.png')
    writeFileSync(png, 'x')
    expect(await extractGate(png)).toBe('extension')
    const bin = join(dir, 'bin.txt')
    writeFileSync(bin, Buffer.from([65, 0, 66]))
    expect(await extractGate(bin)).toBe('binary')
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '')
    expect(await extractGate(empty)).toBe('empty')
    expect(await extractGate(join(dir, 'X.app/Contents/a.txt'))).toBe('bundle')
    expect(await extractGate(join(dir, 'missing.txt'))).toBe('unreadable')
  })

  it('does not open an iCloud placeholder name or a not-yet-downloaded file with blocks === 0', async () => {
    expect(await extractGate(join(dir, '.note.txt.icloud'))).toBe('not-materialized')
    const p = join(dir, 'dataless.txt')
    sparse(p, 4096)
    // In an environment where the filesystem does not hold sparse files with blocks 0, this check means nothing.
    if (statSync(p).blocks === 0) expect(await extractGate(p)).toBe('not-materialized')
  })
})

describe('readRange', () => {
  it('does not produce U+FFFD even when a chunk boundary falls in the middle of a character (TODO 839)', async () => {
    const p = join(dir, 'ja.md')
    writeFileSync(p, 'あいうえお') // 3 bytes each
    // Bytes 1 to 8: from the middle of the first character to the middle of the third.
    const text = await readRange(p, 1, 8)
    expect(text).not.toContain('�')
    expect(text).toBe('い')
  })
})
