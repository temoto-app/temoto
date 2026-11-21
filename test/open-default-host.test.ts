/**
 * TODO 1214: one "Open in editor" button is routed by extension, so documents, images, videos and the like open in the OS's default app
 * (owner decision 2026-11-12).
 *
 * - The host table (`HOST_OPEN_DEFAULT_EXTENSIONS`) and the routing (`openRouteOf`) in `src/shared/open-default.ts`.
 *   Types that can be executed must not be in the table, and the plugin table must not be widened.
 * - The main re-check (`openWithDefaultAppForHost`): even if the renderer asks for the default app, an extension not in the table is refused;
 *   if the target of a symlink (the real file) is not in the table, it is refused; a `#` in a real path is not misread as a fragment.
 * - If it cannot be opened, it falls back to the chosen editor (`openInDefaultAppOrEditor`). `open` is a fake for `shell.openPath`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuditEntry } from '../src/shared/plugin.js'
import type { PathAccess } from '../src/common/fs-policy.js'
import {
  openInDefaultAppForHost,
  openInDefaultAppOrEditor,
  openWithDefaultApp,
  openWithDefaultAppForHost,
  type HostOpenDefaultAppDeps
} from '../src/main/editor/open-default.js'
import {
  extensionOfPath,
  HOST_OPEN_DEFAULT_EXTENSIONS,
  isOpenDefaultAllowed,
  isOpenDefaultAllowedPath,
  OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN,
  openRouteOf,
  opensInDefaultApp,
  opensInDefaultAppPath
} from '../src/shared/open-default.js'

const allow = (uri: string): string => uri.replace('file://', '')

/** Types that can become execution, macro-enabled files, archives, and the canonical copy of text. They must not be in the host table. */
const NEVER_DEFAULT = [
  'app', 'command', 'tool', 'sh', 'bash', 'zsh', 'csh', 'py', 'rb', 'pl', 'js', 'scpt', 'scptd', 'applescript',
  'workflow', 'terminal', 'jar', 'pkg', 'mpkg', 'dmg', 'iso', 'webloc', 'inetloc', 'url', 'fileloc', 'exe', 'bat',
  'cmd', 'msi', 'ps1', 'vbs', 'lnk', 'desktop', 'prefpane', 'kext', 'action', 'definition', 'osax', 'xpc',
  'doc', 'xls', 'ppt', 'xlsm', 'docm', 'pptm', 'xltm', 'xlam', 'ppsm', 'ppsx', 'zip', 'html', 'htm', 'svg', 'xhtml', 'shtml', 'rtf', 'csv',
  // Extensions that are also common for text files (code-review): PEM private keys and certificates (`.key` collides with Keynote), and TypeScript (MPEG-TS).
  'key', 'pem', 'crt', 'cer', 'csr', 'p12', 'pfx', 'ts', 'mts'
]

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-opendef-host-')))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('TODO 1214: table and routing from the host to the default app (pure functions)', () => {
  it('documents, images, video and audio go to the default app; uppercase and multiple dots are judged by the last extension', () => {
    for (const name of ['a.xlsx', 'a.docx', 'a.pptx', 'a.pdf', 'a.PNG', 'a.JPEG', 'a.mov', 'a.mp3', 'my.report.v2.XLSX']) {
      expect(opensInDefaultApp(`file:///Users/a/${name}`)).toBe(true)
      expect(openRouteOf(`file:///Users/a/${name}`)).toBe('default-app')
    }
  })

  it('text types, no extension, hidden files and those whose last extension is dangerous go to the editor', () => {
    for (const name of ['a.ts', 'a.md', 'a.json', 'a.csv', 'Makefile', '.pdf', 'a.pdf.command', 'a.xlsx.app', 'a.']) {
      expect(opensInDefaultApp(`file:///Users/a/${name}`)).toBe(false)
      expect(openRouteOf(`file:///Users/a/${name}`)).toBe('editor')
    }
  })

  it('executable types, macro-enabled files, archives and the canonical text are not in the host table (even in uppercase)', () => {
    for (const ext of NEVER_DEFAULT) {
      expect(HOST_OPEN_DEFAULT_EXTENSIONS.has(ext)).toBe(false)
      expect(opensInDefaultApp(`file:///a/x.${ext}`)).toBe(false)
      expect(opensInDefaultApp(`file:///a/x.${ext.toUpperCase()}`)).toBe(false)
    }
  })

  it('code-review: `server.key` (a PEM private key) goes to the editor, not Keynote', () => {
    expect(HOST_OPEN_DEFAULT_EXTENSIONS.has('key')).toBe(false)
    expect(openRouteOf('file:///Users/a/certs/server.key')).toBe('editor')
    expect(opensInDefaultAppPath('/Users/a/certs/server.key')).toBe(false)
  })

  it('folders and paths with a line number go to the editor; non-file: and non-string values are not sent to the default app', () => {
    expect(openRouteOf('file:///a/b.pdf', { asDirectory: true })).toBe('editor')
    expect(openRouteOf('file:///a/b.pdf', { line: 12 })).toBe('editor')
    expect(openRouteOf('file:///a/b.pdf', { line: null })).toBe('default-app')
    expect(opensInDefaultApp('https://example.com/b.pdf')).toBe(false)
    expect(opensInDefaultApp('thread://x/b.pdf')).toBe(false)
    expect(opensInDefaultApp(undefined)).toBe(false)
    expect(opensInDefaultApp(42)).toBe(false)
  })

  it('the host table does not widen the plugin table (what plugins can ask for is as before)', () => {
    expect([...OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN.keys()].sort()).toEqual(['aios.html', 'aios.video'])
    expect(isOpenDefaultAllowed('aios.video', 'file:///a/b.pdf')).toBe(false)
    expect(isOpenDefaultAllowed('aios.office', 'file:///a/b.xlsx')).toBe(false)
    expect(isOpenDefaultAllowed('aios.image', 'file:///a/b.png')).toBe(false)
  })

  it('the aios.video table matches the manifest extensions (including audio, TODO 1271)', () => {
    const manifest = JSON.parse(readFileSync('plugins/aios.video/manifest.json', 'utf8')) as {
      contributes?: unknown
      viewer?: { extensions?: string[] }
    }
    const text = JSON.stringify(manifest)
    const match = /"extensions":\s*(\[[^\]]*\])/.exec(text)
    const exts = JSON.parse(match?.[1] ?? '[]') as string[]
    expect(exts.length).toBeGreaterThan(0)
    for (const ext of exts) expect(isOpenDefaultAllowed('aios.video', `file:///a/b.${ext}`)).toBe(true)
    expect(isOpenDefaultAllowed('aios.video', 'file:///a/b.ogg')).toBe(true)
  })

  it('extensionOfPath: `#` / `?` in a real path are part of the file name (not treated as a fragment)', () => {
    expect(extensionOfPath('/x/v.pdf#.command')).toBe('command')
    expect(extensionOfPath('/x/v.pdf?.app')).toBe('app')
    expect(extensionOfPath('/x/a.b/noext')).toBe('')
    expect(extensionOfPath('/x/.pdf')).toBe('')
    expect(opensInDefaultAppPath('/x/v.pdf#.command')).toBe(false)
    expect(opensInDefaultAppPath('/x/v.PDF')).toBe(true)
    expect(isOpenDefaultAllowedPath('aios.video', '/x/v.avi#.command')).toBe(false)
    expect(isOpenDefaultAllowedPath('aios.video', '/x/v.avi')).toBe(true)
  })
})

describe('TODO 1214: main re-validation (openWithDefaultAppForHost)', () => {
  function hostDeps(patch: Partial<HostOpenDefaultAppDeps> = {}): HostOpenDefaultAppDeps {
    return { assertAllowed: allow, open: vi.fn(async () => ''), resolveRegularFile: (p) => p, ...patch }
  }

  it('passes the real path of a table extension through the gate to shell.openPath', async () => {
    const d = hostDeps()
    expect(await openWithDefaultAppForHost(d, 'file:///Users/a/book.xlsx')).toBe('opened')
    expect(d.open).toHaveBeenCalledWith('/Users/a/book.xlsx')
  })

  it('refuses an extension not in the table without calling open even if the renderer says "with the default app"', async () => {
    const d = hostDeps()
    for (const name of [
      'run.command', 'Tool.app', 'a.sh', 'a.scpt', 'a.workflow', 'a.terminal', 'a.jar', 'a.pkg', 'a.dmg',
      'a.webloc', 'a.inetloc', 'a.url', 'noext', 'a.ts', 'm.xlsm'
    ]) {
      expect(await openWithDefaultAppForHost(d, `file:///tmp/${name}`)).toBe('refused')
    }
    expect(d.open).not.toHaveBeenCalled()
  })

  it('refuses when the gate threw, when the path the gate returned is not in the table, and for non-string values', async () => {
    const deny = (): string => {
      throw new Error('denied')
    }
    const a = hostDeps({ assertAllowed: deny })
    expect(await openWithDefaultAppForHost(a, 'file:///Users/x/.ssh/a.pdf')).toBe('refused')
    const b = hostDeps({ assertAllowed: () => '/tmp/run.command' })
    expect(await openWithDefaultAppForHost(b, 'file:///tmp/a.pdf')).toBe('refused')
    const c = hostDeps()
    for (const bad of [undefined, null, 42, {}, '']) expect(await openWithDefaultAppForHost(c, bad)).toBe('refused')
    expect(a.open).not.toHaveBeenCalled()
    expect(b.open).not.toHaveBeenCalled()
    expect(c.open).not.toHaveBeenCalled()
  })

  it('returns failed (does not throw) when the OS could not open it (no association etc.) or open threw', async () => {
    const noApp = hostDeps({ open: vi.fn(async () => 'no application') })
    expect(await openWithDefaultAppForHost(noApp, 'file:///a.pdf')).toBe('failed')
    const throwing = hostDeps({
      open: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    expect(await openWithDefaultAppForHost(throwing, 'file:///a.pdf')).toBe('failed')
  })

  describe('a real symlink (the default resolveRegularFile)', () => {
    const real = (): HostOpenDefaultAppDeps => ({ assertAllowed: allow, open: vi.fn(async () => '') })

    it('does not open when a.pdf is a symlink to .command', async () => {
      await withDir(async (dir) => {
        writeFileSync(join(dir, 'evil.command'), '#!/bin/sh\n')
        symlinkSync(join(dir, 'evil.command'), join(dir, 'a.pdf'))
        const d = real()
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'a.pdf')}`)).toBe('refused')
        expect(d.open).not.toHaveBeenCalled()
      })
    })

    it('does not open an extensionless executable or a symlink to `v.pdf#.command`', async () => {
      await withDir(async (dir) => {
        writeFileSync(join(dir, 'runme'), '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(join(dir, 'runme'), join(dir, 'a.pdf'))
        writeFileSync(join(dir, 'v.pdf#.command'), '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(join(dir, 'v.pdf#.command'), join(dir, 'b.pdf'))
        const d = real()
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'a.pdf')}`)).toBe('refused')
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'b.pdf')}`)).toBe('refused')
        expect(d.open).not.toHaveBeenCalled()
      })
    })

    it('opens the real path for a symlink to the real file of a table extension; does not open folders or missing files', async () => {
      await withDir(async (dir) => {
        writeFileSync(join(dir, 'book.xlsx'), 'x')
        symlinkSync(join(dir, 'book.xlsx'), join(dir, 'link.xlsx'))
        mkdirSync(join(dir, 'folder.pdf'))
        const d = real()
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'link.xlsx')}`)).toBe('opened')
        expect(d.open).toHaveBeenCalledWith(join(dir, 'book.xlsx'))
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'folder.pdf')}`)).toBe('refused')
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'none.pdf')}`)).toBe('refused')
        expect(d.open).toHaveBeenCalledTimes(1)
      })
    })
  })
})

describe('TODO 1214: falls back to the chosen editor when the default app cannot open it (openInDefaultAppOrEditor)', () => {
  it('does not call the editor when it opened', async () => {
    const openEditor = vi.fn(async () => true)
    expect(await openInDefaultAppOrEditor({ openDefault: async () => 'opened', openEditor }, 'file:///a.pdf')).toBe(true)
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('opens in the editor when refused or the OS could not open it, and returns that result', async () => {
    for (const result of ['refused', 'failed'] as const) {
      const openEditor = vi.fn(async () => true)
      expect(await openInDefaultAppOrEditor({ openDefault: async () => result, openEditor }, 'file:///a.pdf')).toBe(true)
      expect(openEditor).toHaveBeenCalledWith('file:///a.pdf')
    }
    const failing = vi.fn(async () => false)
    expect(await openInDefaultAppOrEditor({ openDefault: async () => 'failed', openEditor: failing }, 'file:///a.pdf')).toBe(false)
  })

  it('calls nothing for a non-string or an empty string', async () => {
    const openDefault = vi.fn(async () => 'opened' as const)
    const openEditor = vi.fn(async () => true)
    for (const bad of [undefined, null, 1, '']) {
      expect(await openInDefaultAppOrEditor({ openDefault, openEditor }, bad)).toBe(false)
    }
    expect(openDefault).not.toHaveBeenCalled()
    expect(openEditor).not.toHaveBeenCalled()
  })
})

describe("TODO 1214 code-review: the default app only passes the `'write'` gate (openInDefaultAppForHost)", () => {
  /** A gate that refuses on `'write'` and passes on `'handoff'` (which only hands a place in an excluded area outside), such as under `~/Library` or `node_modules`. */
  const handoffOnly = vi.fn((uri: string, _asDirectory: boolean, access: PathAccess): string => {
    if (access !== 'handoff') throw new Error('excluded')
    return allow(uri)
  })

  it("a path refused by 'write' and passed by 'handoff' does not go to the default app and falls to the chosen editor (the 'write' entry)", async () => {
    handoffOnly.mockClear()
    const open = vi.fn(async () => '')
    const openEditor = vi.fn(async () => false)
    const uri = 'file:///Users/a/Library/Caches/report.pdf'
    expect(await openInDefaultAppForHost({ assertAllowed: handoffOnly, open, openEditor, resolveRegularFile: (p) => p }, uri)).toBe(
      false
    )
    expect(open).not.toHaveBeenCalled()
    expect(openEditor).toHaveBeenCalledWith(uri)
    // The gate is applied only for `'write'` (it does not fall back to `'handoff'`).
    expect(handoffOnly.mock.calls.map((call) => call[2])).toEqual(['write'])
  })

  it("a table extension passed by 'write' opens in the default app (the gate is 'write')", async () => {
    const gate = vi.fn<(uri: string, asDirectory: boolean, access: PathAccess) => string>((uri) => allow(uri))
    const open = vi.fn(async () => '')
    const openEditor = vi.fn(async () => true)
    expect(
      await openInDefaultAppForHost({ assertAllowed: gate, open, openEditor, resolveRegularFile: (p) => p }, 'file:///Users/a/book.xlsx')
    ).toBe(true)
    expect(open).toHaveBeenCalledWith('/Users/a/book.xlsx')
    expect(openEditor).not.toHaveBeenCalled()
    expect(gate.mock.calls.every((call) => call[2] === 'write')).toBe(true)
  })

  it('the link-band entry for what could not be opened (editorOpenHandoff) only opens in the handoff editor and does not go to the default app', () => {
    const source = readFileSync(join(__dirname, '../src/main/ipc/handlers.ts'), 'utf8')
    const handoff = source.split('\n').filter((line) => line.includes('IpcChannel.editorOpenHandoff'))
    expect(handoff).toEqual([
      '  ipcMain.handle(IpcChannel.editorOpenHandoff, (_event, uri: unknown) => editorHandoff.open(uri))'
    ])
    // The default-app entry point does not pass the `'handoff'` gate.
    const openDefault = source.slice(source.indexOf('IpcChannel.editorOpenInDefaultApp,'))
    expect(openDefault.slice(0, openDefault.indexOf('\n  )\n'))).not.toMatch(/withHandoffFallback|'handoff'|editorHandoff/)
  })
})

describe('TODO 1214: the plugin path also does not misread `#` in a real path', () => {
  it('does not open when a.avi is a symlink to `v.avi#.command` (deny in the audit)', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'v.avi#.command'), '#!/bin/sh\n', { mode: 0o755 })
      symlinkSync(join(dir, 'v.avi#.command'), join(dir, 'a.avi'))
      const audits: AuditEntry[] = []
      const open = vi.fn(async () => '')
      const ok = await openWithDefaultApp(
        { assertAllowed: allow, open, isBundledPlugin: (id) => id === 'aios.video', audit: (e) => audits.push(e) },
        `file://${join(dir, 'a.avi')}`,
        'aios.video'
      )
      expect(ok).toBe(false)
      expect(open).not.toHaveBeenCalled()
      expect(audits[0]).toMatchObject({ decision: 'deny', reason: 'not-allowed' })
    })
  })
})
