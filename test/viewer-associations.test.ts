/**
 * The 'open with another viewer' choice and the default viewer for each extension (TODO 907, ARCHITECTURE 7.1).
 *
 * - Parsing the setting key (`VIEWER_ASSOCIATIONS`) drops broken values and items whose shape does not fit
 * - `PluginHost.resolveViewer` checks the per-extension default first, and if it is not among the candidates (disabled or gone), silently falls back to the normal choice
 * - `viewerChoices` returns the viewers that claim the file, in priority order (including the fallback aios.text)
 * - a choice from the renderer is re-checked in main (`applyViewerChoice`, only viewers among the candidates)
 * - confirming the origin (TODO 901 made `.patch` open in the read-only aios.diff): reopening `.patch` in aios.text makes it editable and saveable through the Broker
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { VIEWER_ASSOCIATIONS } from '../src/common/settings-keys.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { ViewerBroker } from '../src/main/capability/viewer.js'
import {
  ViewerAssociations,
  applyViewerChoice,
  resetViewerAssociation
} from '../src/main/plugin/associations.js'
import type { PluginHost as PluginHostType } from '../src/main/plugin/host.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import { isAssociationExt } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { reopenDecision, reopenMenuEntries, showReopenWith } from '../src/renderer/src/viewer-reopen.js'
import { makeTestDir, removeTestDir, testExclusions } from './helpers/tmp.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => null } }))

let dir: string
let db: Db
let settings: AppSettingsStore
let associations: ViewerAssociations
let plugins: PluginHostType

beforeAll(async () => {
  dir = makeTestDir('viewer-assoc')
  db = new Database(':memory:')
  runMigrations(db)
  settings = new AppSettingsStore(db)
  associations = new ViewerAssociations(settings)
  const { PluginHost } = await import('../src/main/plugin/host.js')
  plugins = new PluginHost({
    db,
    // Read the canonical bundled plugin manifests as they are
    bundledDir: join(process.cwd(), 'plugins'),
    userDir: join(dir, 'user'),
    hostEntry: join(dir, 'host.js'),
    broker: () => {
      throw new Error('not used')
    },
    onChanged: () => {},
    associations: () => associations.all()
  })
  plugins.load()
})

afterAll(() => {
  db.close()
  removeTestDir(dir)
})

describe('parse of VIEWER_ASSOCIATIONS', () => {
  it('missing, broken JSON, and an array give {}, and items of the wrong shape are dropped', () => {
    expect(VIEWER_ASSOCIATIONS.parse(null)).toEqual({})
    expect(VIEWER_ASSOCIATIONS.parse('{oops')).toEqual({})
    expect(VIEWER_ASSOCIATIONS.parse('["patch"]')).toEqual({})
    expect(
      VIEWER_ASSOCIATIONS.parse(JSON.stringify({ patch: 'aios.text', 'BAD.EXT': 'aios.text', md: 3, diff: '' }))
    ).toEqual({ patch: 'aios.text' })
  })

  it('the extension key is only lowercase alphanumerics and _ + -', () => {
    expect(isAssociationExt('patch')).toBe(true)
    expect(isAssociationExt('c++')).toBe(true)
    expect(isAssociationExt('')).toBe(false)
    expect(isAssociationExt('PATCH')).toBe(false)
    expect(isAssociationExt('a/b')).toBe(false)
    expect(isAssociationExt('__proto__')).toBe(false)
  })

  it('even with __proto__ as a key the table shape does not break', () => {
    const table = VIEWER_ASSOCIATIONS.parse('{"__proto__": "aios.text", "patch": "aios.text"}')
    expect(Object.getPrototypeOf(table)).toBe(Object.prototype)
    expect(table).toEqual({ patch: 'aios.text' })
  })
})

describe('PluginHost: looks at the per-extension default first', () => {
  it('without a default it is as before (.patch is aios.diff, read-only)', () => {
    associations.clear()
    expect(plugins.resolveViewer('file:///tmp/x.patch')).toMatchObject({ pluginId: 'aios.diff', editable: false })
  })

  it('the candidates for .patch are aios.diff (default) and the fallback aios.text', () => {
    associations.clear()
    const choices = plugins.viewerChoices('file:///tmp/x.patch')
    expect(choices.ext).toBe('patch')
    expect(choices.current).toBe('aios.diff')
    expect(choices.associated).toBe(false)
    expect(choices.choices.map((c) => [c.pluginId, c.builtinDefault, c.editable])).toEqual([
      ['aios.diff', true, false],
      ['aios.text', false, true]
    ])
  })

  it('with .patch → aios.text as the default, aios.text opens it as text (editable)', () => {
    associations.set('patch', 'aios.text')
    expect(plugins.resolveViewer('file:///tmp/x.patch')).toMatchObject({
      pluginId: 'aios.text',
      editable: true,
      delivery: 'text'
    })
    // Upper-case extensions match the same default (`extensionOf` lowercases them)
    expect(plugins.resolveViewer('file:///tmp/X.PATCH')?.pluginId).toBe('aios.text')
    // Other extensions are unaffected
    expect(plugins.resolveViewer('file:///tmp/x.diff')?.pluginId).toBe('aios.diff')
    expect(plugins.viewerChoices('file:///tmp/x.patch')).toMatchObject({ current: 'aios.text', associated: true })
    associations.clear()
  })

  it('a default of a viewer that does not claim it, a viewer that no longer exists, or a disabled plugin silently returns to the normal choice', () => {
    // aios.markdown does not claim .patch
    associations.set('patch', 'aios.markdown')
    expect(plugins.resolveViewer('file:///tmp/x.patch')?.pluginId).toBe('aios.diff')
    // An id that no longer exists
    associations.set('md', 'gone.viewer')
    expect(plugins.resolveViewer('file:///tmp/x.md')?.pluginId).toBe('aios.markdown')
    // A disabled plugin
    associations.set('png', 'aios.text')
    expect(plugins.resolveViewer('file:///tmp/x.png')?.pluginId).toBe('aios.text')
    associations.set('png', 'aios.image')
    associations.set('pdf', 'aios.text')
    plugins.setEnabled('aios.pdf', false)
    try {
      associations.set('pdf', 'aios.pdf')
      expect(plugins.resolveViewer('file:///tmp/x.pdf')?.pluginId).toBe('aios.text')
      const entries = plugins.viewerAssociationEntries()
      expect(entries.find((e) => e.ext === 'pdf')).toMatchObject({ pluginId: 'aios.pdf', name: 'PDF', valid: false })
      expect(entries.find((e) => e.ext === 'md')).toMatchObject({ pluginId: 'gone.viewer', name: 'gone.viewer', valid: false })
      expect(entries.find((e) => e.ext === 'png')).toMatchObject({ pluginId: 'aios.image', valid: true })
      // The list is in extension order
      expect(entries.map((e) => e.ext)).toEqual(['md', 'patch', 'pdf', 'png'])
    } finally {
      plugins.setEnabled('aios.pdf', true)
      associations.clear()
    }
  })

  it("resolveViewerWith returns only the candidate viewer (the way of passing is that viewer's)", () => {
    expect(plugins.resolveViewerWith('file:///tmp/x.png', 'aios.image')).toMatchObject({ delivery: 'url' })
    expect(plugins.resolveViewerWith('file:///tmp/x.png', 'aios.text')).toMatchObject({ delivery: 'text' })
    expect(plugins.resolveViewerWith('file:///tmp/x.png', 'aios.markdown')).toBeNull()
  })
})

describe("applyViewerChoice / resetViewerAssociation (main re-validates the renderer's value)", () => {
  it('accepts only a viewer among the candidates, and removes it from the table when the normal first choice is selected', () => {
    associations.clear()
    expect(applyViewerChoice(plugins, associations, 'file:///tmp/x.patch', 'aios.text')).toBe(true)
    expect(associations.all()).toEqual({ patch: 'aios.text' })
    expect(settings.readTyped(VIEWER_ASSOCIATIONS)).toEqual({ patch: 'aios.text' })
    // Viewers not among the candidates, values of the wrong type, and files without an extension are not accepted
    expect(applyViewerChoice(plugins, associations, 'file:///tmp/x.patch', 'aios.image')).toBe(false)
    expect(applyViewerChoice(plugins, associations, 'file:///tmp/x.patch', 42)).toBe(false)
    expect(applyViewerChoice(plugins, associations, null, 'aios.text')).toBe(false)
    expect(applyViewerChoice(plugins, associations, 'file:///tmp/Makefile', 'aios.text')).toBe(false)
    expect(associations.all()).toEqual({ patch: 'aios.text' })
    // Choosing the default (aios.diff) again removes the row
    expect(applyViewerChoice(plugins, associations, 'file:///tmp/x.patch', 'aios.diff')).toBe(true)
    expect(associations.all()).toEqual({})
    expect(settings.read(VIEWER_ASSOCIATIONS.key)).toBeNull()
  })

  it('reset to the default: per extension / all / a broken value does nothing', () => {
    associations.set('patch', 'aios.text')
    associations.set('png', 'aios.text')
    resetViewerAssociation(associations, 'PNG!')
    expect(Object.keys(associations.all()).sort()).toEqual(['patch', 'png'])
    resetViewerAssociation(associations, 'png')
    expect(associations.all()).toEqual({ patch: 'aios.text' })
    resetViewerAssociation(associations, null)
    expect(associations.all()).toEqual({})
  })

  it('the table remains across a restart (a rebuild)', () => {
    associations.set('patch', 'aios.text')
    expect(new ViewerAssociations(settings).all()).toEqual({ patch: 'aios.text' })
    associations.clear()
  })
})

describe('confirming the origin: reopening a .patch with aios.text allows editing and saving', () => {
  it('a .patch whose default is aios.text is not read-only and can be written via the Broker', async () => {
    const root = makeTestDir('viewer-assoc-patch')
    const dbDir = makeTestDir('viewer-assoc-db')
    const brokerDb = new Database(join(dbDir, 'aios.db'))
    brokerDb.pragma(`key = '${'r'.repeat(64)}'`)
    runMigrations(brokerDb)
    const audit = new AuditLog(brokerDb)
    try {
      const rules = testExclusions(homedir())
      const policy = (id: string): PluginPolicy => ({
        id,
        declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false },
        consented: new Set<CapabilityName>(['fs'])
      })
      const broker = new CapabilityBroker({
        scope: { rules },
        audit,
        credentials: new CredentialStore(dbDir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
        policyOf: (id) => (id === 'aios.text' || id === 'aios.diff' ? policy(id) : null),
        index: { put: async () => undefined, remove: async () => undefined },
        notify: () => undefined
      })
      const viewer = new ViewerBroker({
        broker,
        audit,
        scope: { rules },
        resolveViewer: (uri) => plugins.resolveViewer(uri),
        resolveViewerWith: (uri, pluginId) => plugins.resolveViewerWith(uri, pluginId)
      })
      const path = join(root, 'fix.patch')
      const original = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
      writeFileSync(path, original)
      const target = pathToUri(path)

      // Left at the default: aios.diff (not editable)
      associations.clear()
      const before = viewer.open(target)
      expect(before).toMatchObject({ pluginId: 'aios.diff', editable: false })
      viewer.close('aios.diff', target)

      // Open with another viewer -> choose aios.text (make it the default and reopen)
      expect(applyViewerChoice(plugins, associations, target, 'aios.text')).toBe(true)
      const opened = viewer.open(target)
      expect(opened).toMatchObject({ pluginId: 'aios.text', editable: true, delivery: 'text' })
      const resource = await viewer.read('aios.text', target)
      if (resource.kind !== 'text') throw new Error(`expected text, got ${resource.kind}`)
      expect(resource.text).toBe(original)
      expect(resource.readOnly).toBeUndefined()

      const edited = `${original}# reviewed\n`
      const result = await viewer.write('aios.text', target, edited, resource.mtimeMs)
      expect(result).toMatchObject({ ok: true, reason: null })
      expect(readFileSync(path, 'utf8')).toBe(edited)
      viewer.close('aios.text', target)
    } finally {
      associations.clear()
      audit.dispose()
      brokerDb.close()
      removeTestDir(root)
      removeTestDir(dbDir)
    }
  })
})

describe('viewer-reopen (renderer pure function)', () => {
  const choices = {
    ext: 'patch',
    choices: [
      { pluginId: 'aios.diff', name: 'Diff', editable: false, builtinDefault: true },
      { pluginId: 'aios.text', name: 'Text', editable: true, builtinDefault: false }
    ],
    current: 'aios.diff',
    associated: false
  }

  it('the entry exists only when there is an extension and 2 or more candidates', () => {
    expect(showReopenWith(choices)).toBe(true)
    expect(showReopenWith(null)).toBe(false)
    expect(showReopenWith({ ...choices, ext: '' })).toBe(false)
    expect(showReopenWith({ ...choices, choices: choices.choices.slice(0, 1) })).toBe(false)
  })

  it('a ✓ on the current viewer', () => {
    expect(reopenMenuEntries(choices, 'aios.diff').map((e) => [e.pluginId, e.checked, e.builtinDefault])).toEqual([
      ['aios.diff', true, true],
      ['aios.text', false, false]
    ])
  })

  it('does nothing for the same viewer / does not switch to a non-editable viewer while a draft exists', () => {
    const base = { currentPluginId: 'aios.text', dirty: false }
    expect(reopenDecision({ ...base, targetPluginId: 'aios.text', targetEditable: true })).toBe('none')
    expect(reopenDecision({ ...base, targetPluginId: 'aios.diff', targetEditable: false })).toBe('reopen')
    expect(reopenDecision({ ...base, dirty: true, targetPluginId: 'aios.diff', targetEditable: false })).toBe('blocked')
    expect(reopenDecision({ currentPluginId: 'aios.text', dirty: true, targetPluginId: 'aios.markdown', targetEditable: true })).toBe('reopen')
  })
})
