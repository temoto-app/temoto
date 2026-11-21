/**
 * The list and details that main passes to the extension view (TODO 367) (`PluginHost.summaries` / `detail`).
 *
 * - A list row has `displayName` (or `name` if absent), a one-line description, and the consented capabilities (the upper key of TODO 368).
 * - The details mirror the manifest's contributions (the viewer's extensions, scheme, payload, receiver, command, mcp, indexer) and the consent and scope for each declared capability.
 *   **No process is started** (if it calls `fork`, the test fails).
 * - The directory location (path) is not passed.
 *
 * It reads the canonical bundled plugin manifests (`plugins/*\/manifest.json`) as they are. Neither the model nor Electron is used.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { PluginHost } from '../src/main/plugin/host.js'

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('fork must not be called')
    }
  }
}))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-detail-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function host(): PluginHost {
  const db = new Database(':memory:')
  runMigrations(db)
  const plugins = new PluginHost({
    db,
    bundledDir: join(process.cwd(), 'plugins'),
    userDir: join(dir, 'user'),
    hostEntry: join(dir, 'host.js'),
    broker: () => {
      throw new Error('not used')
    },
    onChanged: () => {}
  })
  plugins.load()
  return plugins
}

describe('一覧の行 (TODO 367 / 368)', () => {
  it('標準 plugin は組み込みで、displayName と一行説明を持ち、宣言した能力は同意済み', () => {
    const list = host().summaries()
    // TODO 405 (wave 21 bundles F / G / H) added aios.pdf / aios.video / aios.office, TODO 401 (wave 22 bundle A) added aios.html,
    // TODO 523 (wave 32 bundle C) added aios.gmail (only aios.gmail is disabled by default; see the separate test below).
    // TODO 848 (wave 46 bundle A) added aios.reddit (disabled by default; browser is bundled but not consented until the first consent — browser-capability.test.ts).
    // TODO 905 (wave 48 bundle C) added aios.zip.
    // TODO 1218 (wave 84 bundle J) added aios.bitbucket (disabled by default).
    // TODO 1264 (wave 94 bundle E) added aios.calendar (disabled by default, like aios.gmail).
    expect(list.map((p) => p.id)).toEqual([
      'aios.bitbucket',
      'aios.calendar',
      'aios.diff',
      'aios.gmail',
      'aios.html',
      'aios.image',
      'aios.markdown',
      'aios.office',
      'aios.pdf',
      'aios.reddit',
      'aios.text',
      'aios.video',
      'aios.zip'
    ])
    for (const plugin of list) {
      expect(plugin.bundled).toBe(true)
      if (plugin.id !== 'aios.gmail' && plugin.id !== 'aios.calendar' && plugin.id !== 'aios.reddit' && plugin.id !== 'aios.bitbucket') {
        expect(plugin.enabled).toBe(true)
      }
      expect(plugin.description).not.toBeNull()
      if (plugin.id === 'aios.reddit') expect(plugin.consented).toEqual([])
      else expect(plugin.consented).toEqual(plugin.capabilities)
    }
    const markdown = list.find((p) => p.id === 'aios.markdown')
    expect(markdown?.displayName).toBe('Markdown')
    expect(markdown?.host).toBe('stopped')
    expect(list.find((p) => p.id === 'aios.diff')?.displayName).toBe('Diff')
    expect(list.find((p) => p.id === 'aios.text')?.host).toBe('none')
    expect(list.find((p) => p.id === 'aios.video')?.displayName).toBe('Video')
    expect(list.find((p) => p.id === 'aios.html')?.host).toBe('none')
  })

  it('TODO 523: aios.gmail は Activity Bar の寄与を持ち、同梱だが既定で無効 (利用者が有効にするまで)', () => {
    const plugins = host()
    const gmail = plugins.summaries().find((p) => p.id === 'aios.gmail')
    expect(gmail?.bundled).toBe(true)
    expect(gmail?.required).toBe(false)
    expect(gmail?.enabled).toBe(false)
    // TODO 721: opens in the default browser (because Google's login refuses the embedded browser).
    expect(gmail?.activityBar).toEqual({
      title: 'Gmail',
      openUrl: 'https://mail.google.com/',
      openWith: 'external'
    })
    expect(gmail?.hasViewer).toBe(false)
    // TODO 952 stage 2: the background import (the periodic task `sync`) runs in plugin-host. Only the task's time wakes it.
    expect(gmail?.host).toBe('stopped')
    // TODO 952 stages 1 / 2: declares Google login (gmail.modify), the Gmail API, and its own index. TODO 1217: the `triggers` declaration becomes the `triggers` capability.
    expect(gmail?.capabilities).toEqual(['credentials', 'network', 'index', 'triggers'])
    // Other plugins have no activityBar (null).
    expect(plugins.summaries().find((p) => p.id === 'aios.markdown')?.activityBar).toBeNull()
  })

  it('TODO 523: 有効にすると行が残り、起動し直しても有効のまま (460 の無効化と対称)', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const hostOn = (): PluginHost => {
      const h = new PluginHost({
        db,
        bundledDir: join(process.cwd(), 'plugins'),
        userDir: join(dir, 'user'),
        hostEntry: join(dir, 'host.js'),
        broker: () => {
          throw new Error('not used')
        },
        onChanged: () => {}
      })
      h.load()
      return h
    }
    const first = hostOn()
    expect(first.summaries().find((p) => p.id === 'aios.gmail')?.enabled).toBe(false)
    first.setEnabled('aios.gmail', true)
    expect(first.summaries().find((p) => p.id === 'aios.gmail')?.enabled).toBe(true)
    const again = hostOn()
    expect(again.summaries().find((p) => p.id === 'aios.gmail')?.enabled).toBe(true)
  })

  it('TODO 523 の code-review: DEFAULT_DISABLED_PLUGIN_IDS は同梱の plugin だけに当てる (plugin.bundled も見る)', () => {
    // In a setup where the bundled aios.gmail is absent (a different bundledDir), even if an outside plugin claims the same id 'aios.gmail',
    // restoreState must not silently write a disabled row.
    const emptyBundled = join(dir, 'empty-bundled')
    mkdirSync(emptyBundled, { recursive: true })
    const pluginDir = join(dir, 'user', 'aios.gmail')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({ id: 'aios.gmail', name: 'Not The Real Gmail', version: '0.1.0' })
    )
    const db = new Database(':memory:')
    runMigrations(db)
    const plugins = new PluginHost({
      db,
      bundledDir: emptyBundled,
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host.js'),
      broker: () => {
        throw new Error('not used')
      },
      onChanged: () => {}
    })
    plugins.load()
    const outer = plugins.summaries().find((p) => p.id === 'aios.gmail')
    expect(outer?.bundled).toBe(false)
    expect(outer?.enabled).toBe(true)
  })

  it('TODO 523 の code-review: activityBar は同梱の plugin だけ。外の plugin が名乗っても summary に出ず、警告を 1 行', () => {
    const pluginDir = join(dir, 'user', 'test.outer-bar')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        id: 'test.outer-bar',
        name: 'Outer',
        version: '0.1.0',
        activityBar: { title: 'Outer', openUrl: 'https://example.com/' }
      })
    )
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const plugins = host()
      const summary = plugins.summaries().find((p) => p.id === 'test.outer-bar')
      expect(summary?.bundled).toBe(false)
      expect(summary?.activityBar).toBeNull()
      const lines = warn.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes('plugin.activityBar.ignored') && line.includes('test.outer-bar'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('displayName の無いマニフェストは name を出す。同意していない能力は consented に入らない', async () => {
    const pluginDir = join(dir, 'user', 'test.net')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        id: 'test.net',
        name: 'Net',
        version: '0.1.0',
        capabilities: { network: { hosts: ['api.example.com'] }, ui: { notify: true } }
      })
    )
    const plugins = host()
    const row = plugins.summaries().find((p) => p.id === 'test.net')
    expect(row).toMatchObject({ displayName: 'Net', description: null, publisher: null, bundled: false })
    expect(row?.capabilities).toEqual(['network', 'ui'])
    expect(row?.consented).toEqual([])
    // TODO 1233: consent for an outside extension is tied to its identity (a hash of its contents, asynchronous), so it is attached only after that is computed.
    await plugins.identitiesReady()
    plugins.setConsent('test.net', 'ui', true)
    expect(plugins.summaries().find((p) => p.id === 'test.net')?.consented).toEqual(['ui'])
    const detail = plugins.detail('test.net')
    expect(detail?.permissions).toEqual([
      { capability: 'network', consented: false, targets: [{ mode: null, value: 'api.example.com' }] },
      { capability: 'ui', consented: true, targets: [] }
    ])
  })
})

describe('アイコン (TODO 524)', () => {
  it('標準 plugin は aios-plugin:// のアイコンの URL を持つ。無い plugin は null', () => {
    const pluginDir = join(dir, 'user', 'iconless')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'test.iconless', name: 'N', version: '1' }))
    const brokenDir = join(dir, 'user', 'broken')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'manifest.json'), JSON.stringify({ id: 'test.broken', name: 'B', version: '1', icon: 'nope.svg' }))
    const list = host().summaries()
    for (const row of list.filter((p) => p.bundled)) {
      expect(row.iconUrl, row.id).toBe(`aios-plugin://${row.id}/icon.svg`)
    }
    // A plugin with no icon, or a nonexistent one, is still loaded, and the URL is null (the default icon).
    expect(list.find((p) => p.id === 'test.iconless')?.iconUrl).toBeNull()
    expect(list.find((p) => p.id === 'test.broken')?.iconUrl).toBeNull()
  })

  it('無効の plugin はアイコンだけ配信する (他のファイルは出さない)', () => {
    const plugins = host()
    plugins.setEnabled('aios.markdown', false)
    expect(plugins.directoryOf('aios.markdown')).toBeNull()
    expect(plugins.servingDirectoryOf('aios.markdown', 'icon.svg')).toBe(join(process.cwd(), 'plugins', 'aios.markdown'))
    expect(plugins.servingDirectoryOf('aios.markdown', 'manifest.json')).toBeNull()
    expect(plugins.servingDirectoryOf('aios.markdown', 'viewer/index.html')).toBeNull()
    expect(plugins.servingDirectoryOf('aios.nothing', 'icon.svg')).toBeNull()
    // When enabled, everything inside the directory is served as before (the path check is on the protocol side).
    expect(plugins.servingDirectoryOf('aios.text', 'viewer/index.html')).toBe(join(process.cwd(), 'plugins', 'aios.text'))
  })
})

describe('詳細 (TODO 367)', () => {
  it('aios.markdown: 拡張子・編集可・command、プロセスは起こさない', () => {
    const detail = host().detail('aios.markdown')
    expect(detail?.contributions.viewer).toEqual({
      extensions: ['md', 'markdown', 'mdown', 'mkd'],
      schemes: [],
      payloads: [],
      editable: true,
      priority: 20,
      fallback: false
    })
    expect(detail?.contributions.commands).toEqual([{ id: 'outline', title: 'Extract headings', sideEffect: false }])
    expect(detail?.contributions.mcp).toBe(false)
    expect(detail?.contributions.indexer).toBeNull()
    expect(detail?.restartLimit).toBeGreaterThan(0)
    expect(detail?.permissions.map((p) => p.capability)).toEqual(['fs', 'ui'])
    // The fs scope is an empty declaration (only the files the user opened).
    expect(detail?.permissions.find((p) => p.capability === 'fs')?.targets).toEqual([])
  })

  it('aios.text は受け皿、aios.diff は payload で名乗り出る (受け皿ではない)', () => {
    const plugins = host()
    expect(plugins.detail('aios.text')?.contributions.viewer?.fallback).toBe(true)
    const diff = plugins.detail('aios.diff')?.contributions.viewer
    expect(diff?.payloads).toEqual(['diff'])
    expect(diff?.fallback).toBe(false)
    // Having a viewer turns fs on (the implicit grant of 7.2). The scope declaration is empty.
    expect(plugins.detail('aios.diff')?.permissions).toEqual([{ capability: 'fs', consented: true, targets: [] }])
  })

  it('知らない id は null。返す値にディレクトリの位置 (パス) は入らない', () => {
    const plugins = host()
    expect(plugins.detail('no.such')).toBeNull()
    const text = JSON.stringify(plugins.detail('aios.image'))
    expect(text).not.toContain(process.cwd())
    expect(text).not.toContain('manifest.json')
  })
})

describe('組み込みの個別の無効化 (TODO 460、12.9)', () => {
  function hostOn(db: InstanceType<typeof Database>, onChanged: () => void = () => {}): PluginHost {
    const plugins = new PluginHost({
      db,
      bundledDir: join(process.cwd(), 'plugins'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host.js'),
      broker: () => {
        throw new Error('not used')
      },
      onChanged
    })
    plugins.load()
    return plugins
  }
  function freshDb(): InstanceType<typeof Database> {
    const db = new Database(':memory:')
    runMigrations(db)
    return db
  }

  it('無効にできないのは最後の受け皿 (aios.text) だけ', () => {
    const list = hostOn(freshDb()).summaries()
    expect(list.filter((p) => p.required).map((p) => p.id)).toEqual(['aios.text'])
  })

  it('組み込みの aios.markdown を無効にすると .md は受け皿 (aios.text) で開き、配り直しが走り、起動し直しても無効のまま', () => {
    const db = freshDb()
    const onChanged = vi.fn()
    const plugins = hostOn(db, onChanged)
    expect(plugins.resolveViewer('file:///tmp/a.md')?.pluginId).toBe('aios.markdown')
    plugins.setEnabled('aios.markdown', false)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(plugins.summaries().find((p) => p.id === 'aios.markdown')?.enabled).toBe(false)
    expect(plugins.resolveViewer('file:///tmp/a.md')?.pluginId).toBe('aios.text')
    // A disabled extension returns neither delivery nor policy (reads and writes through the Broker are refused too).
    expect(plugins.directoryOf('aios.markdown')).toBeNull()
    expect(plugins.policyOf('aios.markdown')).toBeNull()

    // Restart (re-reads the same DB): previously it reset the built-ins to always enabled.
    const again = hostOn(db)
    expect(again.summaries().find((p) => p.id === 'aios.markdown')?.enabled).toBe(false)
    expect(again.resolveViewer('file:///tmp/a.md')?.pluginId).toBe('aios.text')

    again.setEnabled('aios.markdown', true)
    expect(again.resolveViewer('file:///tmp/a.md')?.pluginId).toBe('aios.markdown')
    expect(hostOn(db).summaries().find((p) => p.id === 'aios.markdown')?.enabled).toBe(true)
  })

  it('aios.pdf を無効にすると .pdf は受け皿 (aios.text) に落ちる (受け皿はバイナリを「表示できません」と出す)', () => {
    const plugins = hostOn(freshDb())
    plugins.setEnabled('aios.pdf', false)
    expect(plugins.resolveViewer('file:///tmp/a.pdf')?.pluginId).toBe('aios.text')
  })

  it('aios.diff を無効にすると diff の種別に名乗り出る viewer が無くなる (「差分を見る」は「開けるビューアがありません」)', () => {
    const plugins = hostOn(freshDb())
    expect(plugins.resolvePayloadViewer('diff')?.pluginId).toBe('aios.diff')
    plugins.setEnabled('aios.diff', false)
    expect(plugins.resolvePayloadViewer('diff')).toBeNull()
  })

  it('受け皿 (aios.text) の無効化は受け付けない。DB に無効の行が残っていても起動時に有効へ戻す', () => {
    const db = freshDb()
    const onChanged = vi.fn()
    const plugins = hostOn(db, onChanged)
    plugins.setEnabled('aios.text', false)
    expect(onChanged).not.toHaveBeenCalled()
    expect(plugins.summaries().find((p) => p.id === 'aios.text')?.enabled).toBe(true)
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at) VALUES ('aios.text', 0, 0)`).run()
    const again = hostOn(db)
    expect(again.summaries().find((p) => p.id === 'aios.text')?.enabled).toBe(true)
    expect(again.resolveViewer('file:///tmp/x.unknown')?.pluginId).toBe('aios.text')
  })
})
