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

describe('TODO 1214: host から既定のアプリに回す表と振り分け (純関数)', () => {
  it('文書・画像・動画・音声は既定のアプリ、大文字・複数ドットも最後の拡張子で見る', () => {
    for (const name of ['a.xlsx', 'a.docx', 'a.pptx', 'a.pdf', 'a.PNG', 'a.JPEG', 'a.mov', 'a.mp3', 'my.report.v2.XLSX']) {
      expect(opensInDefaultApp(`file:///Users/a/${name}`)).toBe(true)
      expect(openRouteOf(`file:///Users/a/${name}`)).toBe('default-app')
    }
  })

  it('テキスト類・拡張子なし・隠しファイル・最後の拡張子が危険なものはエディタ', () => {
    for (const name of ['a.ts', 'a.md', 'a.json', 'a.csv', 'Makefile', '.pdf', 'a.pdf.command', 'a.xlsx.app', 'a.']) {
      expect(opensInDefaultApp(`file:///Users/a/${name}`)).toBe(false)
      expect(openRouteOf(`file:///Users/a/${name}`)).toBe('editor')
    }
  })

  it('実行されうる型・マクロつき・書庫・文字の正本は host の表に無い (大文字でも)', () => {
    for (const ext of NEVER_DEFAULT) {
      expect(HOST_OPEN_DEFAULT_EXTENSIONS.has(ext)).toBe(false)
      expect(opensInDefaultApp(`file:///a/x.${ext}`)).toBe(false)
      expect(opensInDefaultApp(`file:///a/x.${ext.toUpperCase()}`)).toBe(false)
    }
  })

  it('code-review: `server.key` (PEM の秘密鍵) は Keynote ではなくエディタ', () => {
    expect(HOST_OPEN_DEFAULT_EXTENSIONS.has('key')).toBe(false)
    expect(openRouteOf('file:///Users/a/certs/server.key')).toBe('editor')
    expect(opensInDefaultAppPath('/Users/a/certs/server.key')).toBe(false)
  })

  it('フォルダ・行番号つきはエディタ。file: 以外・文字列でないものは既定のアプリに回さない', () => {
    expect(openRouteOf('file:///a/b.pdf', { asDirectory: true })).toBe('editor')
    expect(openRouteOf('file:///a/b.pdf', { line: 12 })).toBe('editor')
    expect(openRouteOf('file:///a/b.pdf', { line: null })).toBe('default-app')
    expect(opensInDefaultApp('https://example.com/b.pdf')).toBe(false)
    expect(opensInDefaultApp('thread://x/b.pdf')).toBe(false)
    expect(opensInDefaultApp(undefined)).toBe(false)
    expect(opensInDefaultApp(42)).toBe(false)
  })

  it('host の表は plugin の表を広げない (plugin が頼める範囲は今までどおり)', () => {
    expect([...OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN.keys()].sort()).toEqual(['aios.html', 'aios.video'])
    expect(isOpenDefaultAllowed('aios.video', 'file:///a/b.pdf')).toBe(false)
    expect(isOpenDefaultAllowed('aios.office', 'file:///a/b.xlsx')).toBe(false)
    expect(isOpenDefaultAllowed('aios.image', 'file:///a/b.png')).toBe(false)
  })

  it('aios.video の表は manifest の extensions と揃っている (音声を含む、TODO 1271)', () => {
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

  it('extensionOfPath: 実パスの `#` / `?` はファイル名の一部 (断片とみなさない)', () => {
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

describe('TODO 1214: main の再検証 (openWithDefaultAppForHost)', () => {
  function hostDeps(patch: Partial<HostOpenDefaultAppDeps> = {}): HostOpenDefaultAppDeps {
    return { assertAllowed: allow, open: vi.fn(async () => ''), resolveRegularFile: (p) => p, ...patch }
  }

  it('表の拡張子は関門を通して実体のパスを shell.openPath に渡す', async () => {
    const d = hostDeps()
    expect(await openWithDefaultAppForHost(d, 'file:///Users/a/book.xlsx')).toBe('opened')
    expect(d.open).toHaveBeenCalledWith('/Users/a/book.xlsx')
  })

  it('renderer が「既定のアプリで」と言ってきても、表に無い拡張子は open を呼ばずに断る', async () => {
    const d = hostDeps()
    for (const name of [
      'run.command', 'Tool.app', 'a.sh', 'a.scpt', 'a.workflow', 'a.terminal', 'a.jar', 'a.pkg', 'a.dmg',
      'a.webloc', 'a.inetloc', 'a.url', 'noext', 'a.ts', 'm.xlsm'
    ]) {
      expect(await openWithDefaultAppForHost(d, `file:///tmp/${name}`)).toBe('refused')
    }
    expect(d.open).not.toHaveBeenCalled()
  })

  it('関門が投げた・関門が返したパスが表に無い・文字列でない値は断る', async () => {
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

  it('OS が開けなかった (関連付けが無い等)・open が投げたら failed (投げない)', async () => {
    const noApp = hostDeps({ open: vi.fn(async () => 'no application') })
    expect(await openWithDefaultAppForHost(noApp, 'file:///a.pdf')).toBe('failed')
    const throwing = hostDeps({
      open: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    expect(await openWithDefaultAppForHost(throwing, 'file:///a.pdf')).toBe('failed')
  })

  describe('実物の symlink (既定の resolveRegularFile)', () => {
    const real = (): HostOpenDefaultAppDeps => ({ assertAllowed: allow, open: vi.fn(async () => '') })

    it('a.pdf が .command への symlink なら開かない', async () => {
      await withDir(async (dir) => {
        writeFileSync(join(dir, 'evil.command'), '#!/bin/sh\n')
        symlinkSync(join(dir, 'evil.command'), join(dir, 'a.pdf'))
        const d = real()
        expect(await openWithDefaultAppForHost(d, `file://${join(dir, 'a.pdf')}`)).toBe('refused')
        expect(d.open).not.toHaveBeenCalled()
      })
    })

    it('拡張子なしの実行ファイル・`v.pdf#.command` への symlink でも開かない', async () => {
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

    it('表の拡張子の実体への symlink は実体のパスを開く。フォルダ・無いものは開かない', async () => {
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

describe('TODO 1214: 既定のアプリで開けなければ選んだエディタへ (openInDefaultAppOrEditor)', () => {
  it('開けたらエディタは呼ばない', async () => {
    const openEditor = vi.fn(async () => true)
    expect(await openInDefaultAppOrEditor({ openDefault: async () => 'opened', openEditor }, 'file:///a.pdf')).toBe(true)
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('断った・OS が開けなかったときはエディタで開き、その結果を返す', async () => {
    for (const result of ['refused', 'failed'] as const) {
      const openEditor = vi.fn(async () => true)
      expect(await openInDefaultAppOrEditor({ openDefault: async () => result, openEditor }, 'file:///a.pdf')).toBe(true)
      expect(openEditor).toHaveBeenCalledWith('file:///a.pdf')
    }
    const failing = vi.fn(async () => false)
    expect(await openInDefaultAppOrEditor({ openDefault: async () => 'failed', openEditor: failing }, 'file:///a.pdf')).toBe(false)
  })

  it('文字列でない値・空文字は何も呼ばない', async () => {
    const openDefault = vi.fn(async () => 'opened' as const)
    const openEditor = vi.fn(async () => true)
    for (const bad of [undefined, null, 1, '']) {
      expect(await openInDefaultAppOrEditor({ openDefault, openEditor }, bad)).toBe(false)
    }
    expect(openDefault).not.toHaveBeenCalled()
    expect(openEditor).not.toHaveBeenCalled()
  })
})

describe('TODO 1214 の code-review: 既定のアプリは `\'write\'` の関門だけ (openInDefaultAppForHost)', () => {
  /** A gate that refuses on `'write'` and passes on `'handoff'` (which only hands a place in an excluded area outside), such as under `~/Library` or `node_modules`. */
  const handoffOnly = vi.fn((uri: string, _asDirectory: boolean, access: PathAccess): string => {
    if (access !== 'handoff') throw new Error('excluded')
    return allow(uri)
  })

  it("'write' で断られ 'handoff' で通るパスは既定のアプリに回らず、選んだエディタ ('write' の口) に落ちる", async () => {
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

  it("'write' で通る表の拡張子は既定のアプリで開く (関門は 'write')", async () => {
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

  it('開けなかったリンクの帯の口 (editorOpenHandoff) は handoff のエディタで開くだけで、既定のアプリに回さない', () => {
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

describe('TODO 1214: plugin の経路も実パスの `#` で読み違えない', () => {
  it('a.avi が `v.avi#.command` への symlink なら開かない (監査に deny)', async () => {
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
