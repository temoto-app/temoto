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

describe('TODO 405: main の入口 (openWithDefaultApp)', () => {
  it('許可された URI は shell.openPath の代わりに実パスを渡し、成功 (空文字) なら true、監査に allow', async () => {
    const d = deps()
    expect(await openWithDefaultApp(d, 'file:///movies/a.avi', VIDEO)).toBe(true)
    expect(d.open).toHaveBeenCalledWith('/movies/a.avi')
    expect(d.audits).toHaveLength(1)
    expect(d.audits[0]).toMatchObject({ pluginId: VIDEO, op: 'open-default', decision: 'allow' })
  })

  it('shell.openPath が失敗の理由を返したら false (投げない)', async () => {
    const d = deps({ open: vi.fn(async () => 'cannot find application') })
    expect(await openWithDefaultApp(d, 'file:///movies/a.avi', VIDEO)).toBe(false)
    expect(d.audits[0]).toMatchObject({ decision: 'deny', reason: 'open-failed' })
  })

  it('門が投げた (除外の場所・非 file: など) ら open を呼ばず false', async () => {
    const deny = (): string => {
      throw new Error('denied')
    }
    const d = deps({ assertAllowed: deny })
    expect(await openWithDefaultApp(d, 'file:///Users/x/.claude/a.mp4', VIDEO)).toBe(false)
    expect(await openWithDefaultApp(d, 'https://example.com/a.mp4', VIDEO)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
  })

  it('文字列でない値・空文字は門にも渡さない (項目 86 の作法)', async () => {
    const assertAllowed = vi.fn(allow)
    const d = deps({ assertAllowed })
    for (const bad of [undefined, null, 42, {}, ['file:///a.avi'], '']) {
      expect(await openWithDefaultApp(d, bad, VIDEO)).toBe(false)
    }
    expect(assertAllowed).not.toHaveBeenCalled()
    expect(d.open).not.toHaveBeenCalled()
  })

  it('open が投げても投げ返さず false', async () => {
    const d = deps({
      open: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    expect(await openWithDefaultApp(d, 'file:///a.avi', VIDEO)).toBe(false)
  })
})

describe('TODO 850: 同梱の plugin・拡張子の表・監査', () => {
  it('実行されうる拡張子は、aios.video が頼んでも断る (open を呼ばず監査に deny)', async () => {
    const d = deps()
    for (const name of ['a.command', 'a.tool', 'a.terminal', 'a.app', 'a.jar', 'a.fileloc', 'a.webloc', 'a.sh', 'a.scpt', 'noext']) {
      expect(await openWithDefaultApp(d, `file:///tmp/${name}`, VIDEO)).toBe(false)
    }
    expect(d.open).not.toHaveBeenCalled()
    expect(d.audits.every((a) => a.decision === 'deny' && a.reason === 'not-allowed')).toBe(true)
  })

  it('同梱でない plugin・表に無い plugin id は断る (外の plugin が aios.video を名乗っても isBundled で落ちる)', async () => {
    const d = deps({ isBundledPlugin: () => false })
    expect(await openWithDefaultApp(d, 'file:///a.avi', VIDEO)).toBe(false)
    const e = deps()
    expect(await openWithDefaultApp(e, 'file:///a.avi', 'evil.plugin')).toBe(false)
    expect(await openWithDefaultApp(e, 'file:///a.avi', undefined)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
    expect(e.open).not.toHaveBeenCalled()
  })

  it('関門が返した実パスの拡張子も検める', async () => {
    const d = deps({ assertAllowed: () => '/tmp/run.command' })
    expect(await openWithDefaultApp(d, 'file:///tmp/a.avi', VIDEO)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
  })

  it('isOpenDefaultAllowed: 大文字・クエリ・断片・隠しファイル', () => {
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/B.MP4')).toBe(true)
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/b.mp4#t=3')).toBe(true)
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/b.mp4.command')).toBe(false)
    expect(isOpenDefaultAllowed(VIDEO, 'file:///a/.mp4')).toBe(false)
    expect(isOpenDefaultAllowed('aios.text', 'file:///a/b.mp4')).toBe(false)
  })
})

describe('第 42 波 code-review: symlink の先を検める', () => {
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

  it('a.avi が .command への symlink なら開かない', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'evil.command'), '#!/bin/sh\n')
      symlinkSync(join(dir, 'evil.command'), join(dir, 'a.avi'))
      const d = real()
      expect(await openWithDefaultApp(d, `file://${join(dir, 'a.avi')}`, VIDEO)).toBe(false)
      expect(d.open).not.toHaveBeenCalled()
      expect(d.audits[0]).toMatchObject({ decision: 'deny', reason: 'not-allowed' })
    })
  })

  it('表の拡張子の実体への symlink は、実体のパスを開く', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'movie.avi'), 'x')
      symlinkSync(join(dir, 'movie.avi'), join(dir, 'link.avi'))
      const d = real()
      expect(await openWithDefaultApp(d, `file://${join(dir, 'link.avi')}`, VIDEO)).toBe(true)
      expect(d.open).toHaveBeenCalledWith(join(dir, 'movie.avi'))
    })
  })

  it('通常のファイルでない (ディレクトリ) / 無いものは開かない', async () => {
    await withDir(async (dir) => {
      mkdirSync(join(dir, 'd.avi'))
      const d = real()
      expect(await openWithDefaultApp(d, `file://${join(dir, 'd.avi')}`, VIDEO)).toBe(false)
      expect(await openWithDefaultApp(d, `file://${join(dir, 'none.avi')}`, VIDEO)).toBe(false)
      expect(d.open).not.toHaveBeenCalled()
    })
  })
})
