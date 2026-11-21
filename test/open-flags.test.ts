// TODO 1238: "open without following a symlink" must not vanish on an OS that lacks O_NOFOLLOW / O_NONBLOCK.
import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardFlags, openFlagSupport, openNoFollow, openNoFollowSync, UnsafeOpenError } from '../src/common/os/open-flags.js'

// What a Windows-like Node reports: the constants are absent.
const NO_FLAGS = {}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'open-flags-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('openFlagSupport / guardFlags', () => {
  it('reports presence of the flags, not the OS name', () => {
    expect(openFlagSupport(NO_FLAGS)).toEqual({ noFollow: false, nonBlock: false })
    expect(openFlagSupport({ O_NOFOLLOW: 0, O_NONBLOCK: 0 })).toEqual({ noFollow: false, nonBlock: false })
    expect(openFlagSupport({ O_NOFOLLOW: 256, O_NONBLOCK: 4 })).toEqual({ noFollow: true, nonBlock: true })
  })
  it('adds only the bits that exist (never ORs in undefined)', () => {
    expect(guardFlags(NO_FLAGS)).toBe(0)
    expect(guardFlags({ O_NOFOLLOW: 256, O_NONBLOCK: 4 })).toBe(260)
    expect(guardFlags({ O_NOFOLLOW: 256, O_NONBLOCK: 4 }, false)).toBe(256)
  })
  it('uses both flags when the real table has them (macOS behaviour unchanged)', () => {
    if (constants.O_NOFOLLOW) expect(guardFlags()).toBe(constants.O_NOFOLLOW | constants.O_NONBLOCK)
  })
})

describe.each([
  ['real flags', undefined],
  ['no flags (manual check)', NO_FLAGS]
])('openNoFollow with %s', (_name, table) => {
  it('opens a regular file', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello')
    closeSync(openNoFollowSync(file, constants.O_RDONLY, { table }))
    const handle = await openNoFollow(file, constants.O_RDONLY, { table })
    await handle.close()
  })

  it('refuses a final-component symlink', async () => {
    const file = join(dir, 'a.txt')
    const link = join(dir, 'link')
    writeFileSync(file, 'hello')
    symlinkSync(file, link)
    expect(() => openNoFollowSync(link, constants.O_RDONLY, { table })).toThrow()
    await expect(openNoFollow(link, constants.O_RDONLY, { table })).rejects.toThrow()
  })

  it('refuses a missing file', () => {
    expect(() => openNoFollowSync(join(dir, 'nope'), constants.O_RDONLY, { table })).toThrow()
  })

  it('creates exclusively and refuses a symlink in the way', () => {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    const made = join(dir, 'new.txt')
    closeSync(openNoFollowSync(made, flags, { table, nonBlock: false }))
    expect(existsSync(made)).toBe(true)
    const link = join(dir, 'l2')
    symlinkSync(join(dir, 'elsewhere'), link)
    expect(() => openNoFollowSync(link, flags, { table, nonBlock: false })).toThrow()
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false)
  })
})

describe('manual check when the flags are missing', () => {
  it('reports a symlink as UnsafeOpenError ELOOP before opening it', () => {
    const file = join(dir, 'a.txt')
    const link = join(dir, 'link')
    writeFileSync(file, 'x')
    symlinkSync(file, link)
    try {
      openNoFollowSync(link, constants.O_RDONLY, { table: NO_FLAGS })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeOpenError)
      expect((err as UnsafeOpenError).code).toBe('ELOOP')
    }
  })

  it('refuses a FIFO without O_NONBLOCK instead of blocking in open()', () => {
    const fifo = join(dir, 'fifo')
    execFileSync('mkfifo', [fifo])
    expect(() => openNoFollowSync(fifo, constants.O_RDONLY, { table: NO_FLAGS })).toThrow(UnsafeOpenError)
  })
})

// Security review (wave 92): without the flag, open() itself follows a link, so O_CREAT / O_TRUNC must not act
// before the checks have run.
describe('manual path with O_CREAT / O_TRUNC (no flags)', () => {
  const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC

  it('does not empty the target of a symlink', () => {
    const target = join(dir, 'target.txt')
    const link = join(dir, 'link.txt')
    writeFileSync(target, 'keep me')
    symlinkSync(target, link)
    expect(() => openNoFollowSync(link, WRITE, { table: NO_FLAGS })).toThrow(UnsafeOpenError)
    expect(readFileSync(target, 'utf8')).toBe('keep me')
  })
  it('does not create the target of a dangling symlink', async () => {
    const target = join(dir, 'elsewhere.txt')
    const link = join(dir, 'dangling.txt')
    symlinkSync(target, link)
    expect(() => openNoFollowSync(link, WRITE, { table: NO_FLAGS })).toThrow()
    await expect(openNoFollow(link, WRITE, { table: NO_FLAGS })).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
  })
  it('still creates a missing file and truncates an existing regular file', async () => {
    const file = join(dir, 'new.txt')
    closeSync(openNoFollowSync(file, WRITE, { table: NO_FLAGS }))
    expect(readFileSync(file, 'utf8')).toBe('')
    writeFileSync(file, 'old')
    const handle = await openNoFollow(file, WRITE, { table: NO_FLAGS })
    await handle.close()
    expect(readFileSync(file, 'utf8')).toBe('')
  })
  it('keeps O_EXCL meaning: an existing file is EEXIST', () => {
    const file = join(dir, 'exists.txt')
    writeFileSync(file, 'x')
    expect(() => openNoFollowSync(file, WRITE | constants.O_EXCL, { table: NO_FLAGS })).toThrow(/exists/)
    expect(readFileSync(file, 'utf8')).toBe('x')
  })
})
