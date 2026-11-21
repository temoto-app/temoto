// TODO 1259: `openChecked` compares dev / ino as bigint, so two ino values that collapse to the same Number (above 2^53) still differ.
import { closeSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ fstat: null as null | ((real: unknown) => unknown) }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    fstatSync: (...args: Parameters<typeof real.fstatSync>) => {
      const stat = (real.fstatSync as (...a: unknown[]) => unknown)(...args)
      return hooks.fstat ? hooks.fstat(stat) : stat
    }
  }
})

import { openChecked, PathDenied, type ResolvedPath } from '../src/common/fs-policy.js'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fs-policy-identity-'))
  file = join(dir, 'a.txt')
  writeFileSync(file, 'x')
})
afterEach(() => {
  hooks.fstat = null
  rmSync(dir, { recursive: true, force: true })
})

const BIG = 2n ** 53n
const resolved = (ino: bigint, dev = 1n): ResolvedPath => ({
  logical: file,
  canonical: file,
  exists: true,
  isDirectory: false,
  identity: { dev, ino }
})
// Keeps the real stat's methods (isFile) and overrides only dev / ino.
const fake = (ino: bigint, dev = 1n) => (real: unknown) => Object.assign(Object.create(Object.getPrototypeOf(real as object)), real as object, { dev, ino })

describe('openChecked identity (bigint)', () => {
  it('rejects an ino that differs only above 2^53 (equal as Number)', () => {
    expect(Number(BIG)).toBe(Number(BIG + 1n))
    hooks.fstat = fake(BIG + 1n)
    expect(() => openChecked(resolved(BIG), constants.O_RDONLY)).toThrow(PathDenied)
  })
  it('accepts the same 64-bit ino', () => {
    hooks.fstat = fake(BIG + 1n)
    closeSync(openChecked(resolved(BIG + 1n), constants.O_RDONLY))
  })
  it('rejects a different dev', () => {
    hooks.fstat = fake(5n, 2n)
    expect(() => openChecked(resolved(5n, 1n), constants.O_RDONLY)).toThrow(PathDenied)
  })
})
