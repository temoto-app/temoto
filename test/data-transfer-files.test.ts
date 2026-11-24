/**
 * The real files of export and import (`nodeTransferFiles`, TODO 1318 review X). The model is not called.
 *
 * - `openRead` opens the path once (no-follow, non-blocking) and checks the type on the descriptor: a FIFO, a folder and a symlink are
 *   refused without waiting. **If the FIFO case regresses, the test hangs rather than failing** (an open cannot be interrupted).
 * - `replace` (the manual export): a symlink chosen in the save dialog keeps pointing at the replaced file; an existing file keeps its
 *   mode and a new one is 0600; in a folder where nothing can be created it writes the target in place.
 * FIFOs exist only on macOS / Linux (`mkfifo`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeTransferFiles } from '../src/main/data-transfer/files.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const supported = process.platform !== 'win32'

let root: string

beforeAll(() => {
  root = makeTestDir('transfer-files')
})

afterAll(() => {
  // A read-only folder made by a test would stop the removal.
  for (const name of readdirSync(root)) chmodSync(join(root, name), 0o755)
  removeTestDir(root)
})

async function writeThrough(path: string, bytes: number[]): Promise<void> {
  const writer = await nodeTransferFiles.replace(path)
  await writer.write(Buffer.from(bytes))
  await writer.commit()
}

describe.skipIf(!supported)('openRead (one open, the type checked on the descriptor)', () => {
  it('reads a regular file at fixed positions', async () => {
    const path = join(root, 'plain.aiosdata')
    writeFileSync(path, Buffer.from([1, 2, 3, 4, 5]))
    const reader = await nodeTransferFiles.openRead(path)
    try {
      expect(reader.size).toBe(5)
      expect([...(await reader.read(1, 3))]).toEqual([2, 3, 4])
      expect([...(await reader.read(3, 10))]).toEqual([4, 5])
    } finally {
      await reader.close()
    }
  })

  it('refuses a FIFO without waiting for a writer', async () => {
    const fifo = join(root, 'pipe.aiosdata')
    execFileSync('mkfifo', [fifo])
    await expect(nodeTransferFiles.openRead(fifo)).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('refuses a folder', async () => {
    const dir = join(root, 'folder.aiosdata')
    mkdirSync(dir)
    await expect(nodeTransferFiles.openRead(dir)).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('refuses a symlink (also one to a regular file, and one to a FIFO)', async () => {
    const real = join(root, 'real.aiosdata')
    writeFileSync(real, 'x')
    const link = join(root, 'link.aiosdata')
    symlinkSync(real, link)
    await expect(nodeTransferFiles.openRead(link)).rejects.toThrow()
    const fifo = join(root, 'pipe-2')
    execFileSync('mkfifo', [fifo])
    const fifoLink = join(root, 'fifo-link.aiosdata')
    symlinkSync(fifo, fifoLink)
    await expect(nodeTransferFiles.openRead(fifoLink)).rejects.toThrow()
  })
})

describe.skipIf(!supported)('replace (the manual export over the chosen file)', () => {
  it('a new file is 0600 and an existing file keeps its mode; no temporary file stays', async () => {
    const dir = join(root, 'modes')
    mkdirSync(dir)
    const fresh = join(dir, 'fresh.aiosdata')
    await writeThrough(fresh, [1])
    expect(statSync(fresh).mode & 0o777).toBe(0o600)
    const shared = join(dir, 'shared.aiosdata')
    writeFileSync(shared, 'older')
    chmodSync(shared, 0o644)
    await writeThrough(shared, [2, 3])
    expect([...readFileSync(shared)]).toEqual([2, 3])
    expect(statSync(shared).mode & 0o777).toBe(0o644)
    expect(readdirSync(dir).sort()).toEqual(['fresh.aiosdata', 'shared.aiosdata'])
  })

  it('a chosen symlink is resolved once: the file it points to is replaced and the link stays a link', async () => {
    const synced = join(root, 'synced')
    const desk = join(root, 'desk')
    mkdirSync(synced)
    mkdirSync(desk)
    const real = join(synced, 'data.aiosdata')
    writeFileSync(real, 'older')
    chmodSync(real, 0o640)
    const link = join(desk, 'data.aiosdata')
    symlinkSync(real, link)
    await writeThrough(link, [7, 8, 9])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(real)
    expect([...readFileSync(real)]).toEqual([7, 8, 9])
    expect(statSync(real).mode & 0o777).toBe(0o640)
    // The temporary file was made beside the real file and renamed there; nothing is left in either folder.
    expect(readdirSync(synced)).toEqual(['data.aiosdata'])
    expect(readdirSync(desk)).toEqual(['data.aiosdata'])
  })

  it('a dangling symlink creates the file it names (as writing through it did)', async () => {
    const dir = join(root, 'dangling')
    mkdirSync(dir)
    const link = join(dir, 'link.aiosdata')
    symlinkSync('named.aiosdata', link)
    await writeThrough(link, [4])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect([...readFileSync(join(dir, 'named.aiosdata'))]).toEqual([4])
  })

  it('a folder where nothing can be created: the existing file is written in place; a new name fails', async () => {
    const dir = join(root, 'read-only')
    mkdirSync(dir)
    const target = join(dir, 'chosen.aiosdata')
    writeFileSync(target, 'an older export that is longer')
    chmodSync(target, 0o644)
    chmodSync(dir, 0o555)
    try {
      await writeThrough(target, [5, 6])
      expect([...readFileSync(target)]).toEqual([5, 6])
      expect(statSync(target).mode & 0o777).toBe(0o644)
      expect(readdirSync(dir)).toEqual(['chosen.aiosdata'])
      await expect(nodeTransferFiles.replace(join(dir, 'new.aiosdata'))).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('a discarded write leaves the chosen file as it was and no temporary file', async () => {
    const dir = join(root, 'discard')
    mkdirSync(dir)
    const target = join(dir, 'chosen.aiosdata')
    writeFileSync(target, 'keep me')
    const writer = await nodeTransferFiles.replace(target)
    await writer.write(Buffer.from([1, 2, 3]))
    await writer.discard()
    expect(readFileSync(target, 'utf8')).toBe('keep me')
    expect(readdirSync(dir)).toEqual(['chosen.aiosdata'])
  })

  it('a chosen path that is not a regular file is refused', async () => {
    const dir = join(root, 'not-regular')
    mkdirSync(join(dir, 'sub.aiosdata'), { recursive: true })
    await expect(nodeTransferFiles.replace(join(dir, 'sub.aiosdata'))).rejects.toMatchObject({ code: 'EINVAL' })
  })
})
