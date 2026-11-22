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

describe('list rows (TODO 367 / 368)', () => {
  it('standard plugins are built in, have displayName and a one-line description, and their declared capabilities are consented', () => {
    const list = host().summaries()
    // TODO 405 (wave 21 bundles F / G / H) added aios.pdf / aios.video / aios.office, TODO 401 (wave 22 bundle A) added aios.html,
    // TODO 523 (wave 32 bundle C) added aios.gmail (only aios.gmail is disabled by default; see the separate test below).
    // TODO 848 (wave 46 bundle A) added aios.reddit (disabled by default; browser is bundled but not consented until the first consent — browser-capability.test.ts).
    // TODO 905 (wave 48 bundle C) added aios.zip.
    // TODO 1218 (wave 84 bundle J) added aios.bitbucket (disabled by default).
    // TODO 1264 (wave 94 bundle E) added aios.calendar (disabled by default, like aios.gmail).
    // TODO 834 (wave 101 bundle A) added aios.git (the Source Control view, read-only git).
    expect(list.map((p) => p.id)).toEqual([
      'aios.bitbucket',
      'aios.calendar',
      'aios.diff',
      'aios.git',
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

  it('TODO 523: aios.gmail has an Activity Bar contribution and is bundled but disabled by default (until the user enables it)', () => {
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

  it('TODO 523: when enabled the row remains and stays enabled after restart (symmetric with the disabling of 460)', () => {
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

  it('TODO 523 code-review: DEFAULT_DISABLED_PLUGIN_IDS applies only to bundled plugins (also looks at plugin.bundled)', () => {
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

  it('TODO 523 code-review: activityBar is for bundled plugins only; even if an outside plugin claims it, it does not appear in the summary and 1 warning line is logged', () => {
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

  it('a manifest without displayName shows name; capabilities not consented do not enter consented', async () => {
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

describe('icons (TODO 524)', () => {
  it('standard plugins have an aios-plugin:// icon URL; plugins without one get null', () => {
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

  it('a disabled plugin serves only the icon (no other files)', () => {
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

describe('details (TODO 367)', () => {
  it('aios.markdown: extensions, editable, command; no process is spawned', () => {
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

  it('aios.text is the fallback and aios.diff claims by payload (not a fallback)', () => {
    const plugins = host()
    expect(plugins.detail('aios.text')?.contributions.viewer?.fallback).toBe(true)
    const diff = plugins.detail('aios.diff')?.contributions.viewer
    expect(diff?.payloads).toEqual(['diff'])
    expect(diff?.fallback).toBe(false)
    // Having a viewer turns fs on (the implicit grant of 7.2). The scope declaration is empty.
    expect(plugins.detail('aios.diff')?.permissions).toEqual([{ capability: 'fs', consented: true, targets: [] }])
  })

  it('null for an unknown id; the returned value contains no directory location (path)', () => {
    const plugins = host()
    expect(plugins.detail('no.such')).toBeNull()
    const text = JSON.stringify(plugins.detail('aios.image'))
    expect(text).not.toContain(process.cwd())
    expect(text).not.toContain('manifest.json')
  })
})

describe('disabling individual built-ins (TODO 460, 12.9)', () => {
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

  it('only the last fallback (aios.text) cannot be disabled', () => {
    const list = hostOn(freshDb()).summaries()
    expect(list.filter((p) => p.required).map((p) => p.id)).toEqual(['aios.text'])
  })

  it('disabling the built-in aios.markdown opens .md in the fallback (aios.text), runs a redistribution and stays disabled after restart', () => {
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

  it('disabling aios.pdf drops .pdf to the fallback (aios.text) (the fallback shows binaries as 「表示できません」)', () => {
    const plugins = hostOn(freshDb())
    plugins.setEnabled('aios.pdf', false)
    expect(plugins.resolveViewer('file:///tmp/a.pdf')?.pluginId).toBe('aios.text')
  })

  it('disabling aios.diff leaves no viewer that claims the diff kind (「差分を見る」 gives 「開けるビューアがありません」)', () => {
    const plugins = hostOn(freshDb())
    expect(plugins.resolvePayloadViewer('diff')?.pluginId).toBe('aios.diff')
    plugins.setEnabled('aios.diff', false)
    expect(plugins.resolvePayloadViewer('diff')).toBeNull()
  })

  it('does not accept disabling the fallback (aios.text); even if a disabled row remains in the DB, it returns to enabled at launch', () => {
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
