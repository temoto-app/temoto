/**
 * TODO 405 (bundle G, aios.video) / TODO 850: the main entry point that opens with the OS default app (`openWithDefaultApp`).
 *
 * The route by which the viewer → bridge → host asks main to open a video that aios (Chromium) cannot play, such as `.avi`. TODO 850 added "bundled plugins only, limited to the extension table, recorded in the audit log".
 * What is checked: allow / deny, the type check, swallowed failures, and rejection of types that could be executed. `open` is stubbed the way the `shell.openPath` of Electron is specified (success gives `''`, failure gives the reason as a string).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuditEntry } from '../src/shared/plugin.js'
import { openWithDefaultApp, type OpenDefaultAppDeps } from '../src/main/editor/open-default.js'
import { isOpenDefaultAllowed } from '../src/shared/open-default.js'

const allow = (uri: string): string => uri.replace('file://', '')
const VIDEO = 'aios.video'

function deps(patch: Partial<OpenDefaultAppDeps> = {}): OpenDefaultAppDeps & { audits: AuditEntry[] } {
  const audits: AuditEntry[] = []
  return {
    assertAllowed: allow,
    open: vi.fn(async () => ''),
    isBundledPlugin: (id) => id === VIDEO,
    resolveRegularFile: (p) => p,
    audit: (e) => audits.push(e),
    audits,
    ...patch
  }
}

describe("TODO 405: main's entry point (openWithDefaultApp)", () => {
  it('for an allowed URI, passes the real path instead of shell.openPath, returns true on success (empty string), and audits allow', async () => {
    const d = deps()
    expect(await openWithDefaultApp(d, 'file:///movies/a.avi', VIDEO)).toBe(true)
    expect(d.open).toHaveBeenCalledWith('/movies/a.avi')
    expect(d.audits).toHaveLength(1)
    expect(d.audits[0]).toMatchObject({ pluginId: VIDEO, op: 'open-default', decision: 'allow' })
  })

  it('returns false (does not throw) when shell.openPath returns a failure reason', async () => {
    const d = deps({ open: vi.fn(async () => 'cannot find application') })
    expect(await openWithDefaultApp(d, 'file:///movies/a.avi', VIDEO)).toBe(false)
    expect(d.audits[0]).toMatchObject({ decision: 'deny', reason: 'open-failed' })
  })

  it('when the gate throws (excluded place, non-file:, etc.), does not call open and returns false', async () => {
    const deny = (): string => {
      throw new Error('denied')
    }
    const d = deps({ assertAllowed: deny })
    expect(await openWithDefaultApp(d, 'file:///Users/x/.claude/a.mp4', VIDEO)).toBe(false)
    expect(await openWithDefaultApp(d, 'https://example.com/a.mp4', VIDEO)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
  })

  it('does not pass a non-string value or an empty string even to the gate (the practice of item 86)', async () => {
    const assertAllowed = vi.fn(allow)
    const d = deps({ assertAllowed })
    for (const bad of [undefined, null, 42, {}, ['file:///a.avi'], '']) {
      expect(await openWithDefaultApp(d, bad, VIDEO)).toBe(false)
    }
    expect(assertAllowed).not.toHaveBeenCalled()
    expect(d.open).not.toHaveBeenCalled()
  })

  it('returns false without rethrowing even if open throws', async () => {
    const d = deps({
      open: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    expect(await openWithDefaultApp(d, 'file:///a.avi', VIDEO)).toBe(false)
  })
})

describe('TODO 850: bundled plugin, extension table and audit', () => {
  it('refuses an executable extension even if aios.video asks (does not call open, audits deny)', async () => {
    const d = deps()
    for (const name of ['a.command', 'a.tool', 'a.terminal', 'a.app', 'a.jar', 'a.fileloc', 'a.webloc', 'a.sh', 'a.scpt', 'noext']) {
      expect(await openWithDefaultApp(d, `file:///tmp/${name}`, VIDEO)).toBe(false)
    }
    expect(d.open).not.toHaveBeenCalled()
    expect(d.audits.every((a) => a.decision === 'deny' && a.reason === 'not-allowed')).toBe(true)
  })

  it('refuses a non-bundled plugin and a plugin id not in the table (an outside plugin claiming to be aios.video falls on isBundled)', async () => {
    const d = deps({ isBundledPlugin: () => false })
    expect(await openWithDefaultApp(d, 'file:///a.avi', VIDEO)).toBe(false)
    const e = deps()
    expect(await openWithDefaultApp(e, 'file:///a.avi', 'evil.plugin')).toBe(false)
    expect(await openWithDefaultApp(e, 'file:///a.avi', undefined)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
    expect(e.open).not.toHaveBeenCalled()
  })

  it('also checks the extension of the real path returned by the choke point', async () => {
    const d = deps({ assertAllowed: () => '/tmp/run.command' })
    expect(await openWithDefaultApp(d, 'file:///tmp/a.avi', VIDEO)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
  })

  it('isOpenDefaultAllowed: uppercase, query, fragment, hidden files', () => {
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/B.MP4')).toBe(true)
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/b.mp4#t=3')).toBe(true)
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/b.mp4.command')).toBe(false)
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/.mp4')).toBe(false)
    expect(isOpenDefaultAllowed('aios.text', 'file:///a/b.mp4')).toBe(false)
  })
})

describe('wave 42 code-review: checks the target of a symlink', () => {
  const real = (patch: Partial<OpenDefaultAppDeps> = {}) => {
    const d = deps(patch)
    delete (d as { resolveRegularFile?: unknown }).resolveRegularFile
    return d
  }
  const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-opendef-')))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('does not open when a.avi is a symlink to a .command', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'evil.command'), '#!/bin/sh\n')
      symlinkSync(join(dir, 'evil.command'), join(dir, 'a.avi'))
      const d = real()
      expect(await openWithDefaultApp(d, `file://${join(dir, 'a.avi')}`, VIDEO)).toBe(false)
      expect(d.open).not.toHaveBeenCalled()
      expect(d.audits[0]).toMatchObject({ decision: 'deny', reason: 'not-allowed' })
    })
  })

  it("a symlink to a target with a table extension opens the target's path", async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'movie.avi'), 'x')
      symlinkSync(join(dir, 'movie.avi'), join(dir, 'link.avi'))
      const d = real()
      expect(await openWithDefaultApp(d, `file://${join(dir, 'link.avi')}`, VIDEO)).toBe(true)
      expect(d.open).toHaveBeenCalledWith(join(dir, 'movie.avi'))
    })
  })

  it('does not open a non-regular file (directory) or a missing one', async () => {
    await withDir(async (dir) => {
      mkdirSync(join(dir, 'd.avi'))
      const d = real()
      expect(await openWithDefaultApp(d, `file://${join(dir, 'd.avi')}`, VIDEO)).toBe(false)
      expect(await openWithDefaultApp(d, `file://${join(dir, 'none.avi')}`, VIDEO)).toBe(false)
      expect(d.open).not.toHaveBeenCalled()
    })
  })
})
