/**
 * TODO 947: when a link in an answer points at a FIFO or the like, the result is `path-not-regular`, not "not found".
 * The existence check is replaced (no real FIFO is made).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLink } from '../src/main/fs/link.js'

const gate = { assertAllowed: (uri: string): string => uri.replace('file://', '') }
const context = { baseDir: '/work', memoryDirs: [], home: '/home/u' }

describe('TODO 947: links to non-regular files', () => {
  it('if it is neither a file nor a folder but exists, path-not-regular', () => {
    const result = resolveLink('/work/pipe', context, gate, () => false, () => false, (p) => p === '/work/pipe')
    expect(result).toMatchObject({ ok: false, reason: 'path-not-regular' })
  })

  it('if nothing is there, link-not-found as before', () => {
    const result = resolveLink('/work/none', context, gate, () => false, () => false, () => false)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('link-not-found')
  })

  it('the default decision (sorting with one stat) works the same on a real file, folder, FIFO and nonexistent path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-link-kind-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'x')
      mkdirSync(join(dir, 'sub'))
      execFileSync('mkfifo', [join(dir, 'pipe')])
      const ctx = { baseDir: dir, memoryDirs: [], home: '/home/u' }
      expect(resolveLink(join(dir, 'a.txt'), ctx, gate)).toMatchObject({ ok: true })
      expect(resolveLink(join(dir, 'sub'), ctx, gate)).toMatchObject({ ok: true, directory: true })
      expect(resolveLink(join(dir, 'pipe'), ctx, gate)).toMatchObject({ ok: false, reason: 'path-not-regular' })
      const missing = resolveLink(join(dir, 'none'), ctx, gate)
      expect(missing.ok === false && missing.reason).toContain('link-not-found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
