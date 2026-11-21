/**
 * The "surfaces" of a plugin (TODO 1039 sidebar list / TODO 1038 sync progress, ARCHITECTURE.md 7.5).
 *
 * What it pins down:
 *  1. manifest: `sidebarView` requires `ui.sidebar` (`viewer.schemes` is optional since TODO 1264). `ui.status` can be declared
 *  2. Validation of Broker requests (unknown keys, duplicate ids, depth, counts, state words)
 *  3. Broker: refused if there is no declaration; with a declaration, the validated values are passed to the receiving side
 *  4. Receiving side (`PluginSurfaces`): a row's URI is only the plugin viewer's scheme; the badge disappears on done; it is emitted once in a batch
 *  5. plugin-host's `aios.sidebar` / `aios.status` become Broker requests
 *  6. The renderer's pure functions (visible rows, arrow keys, badge wording)
 */
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { parseBrokerRequest } from '../src/main/capability/request-schema.js'
import { parseManifest, ManifestError } from '../src/main/plugin/manifest.js'
import { PluginSurfaces, restrictRowUris } from '../src/main/plugin/surfaces.js'
import { createPluginApi } from '../src/plugin-host/dispatch.js'
import { syncLabel, treeKey, visibleRows } from '../src/renderer/src/pluginView.js'
import { MAX_SIDEBAR_ROWS, type PluginSidebarRow, type PluginSurfacesSnapshot } from '../src/shared/plugin-surfaces.js'
import type { BrokerRequest, CapabilityName } from '../src/shared/plugin.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

const base = { id: 'aios.sample', name: 'Sample', version: '1.0.0' }

describe('manifest: sidebarView / ui.status', () => {
  it('sidebarView is readable when ui.sidebar and viewer.schemes are both present', () => {
    const manifest = parseManifest({
      ...base,
      sidebarView: { title: 'Mail' },
      capabilities: { ui: { sidebar: true, status: true } },
      viewer: { entry: 'viewer/index.html', schemes: ['mail'] }
    })
    expect(manifest.sidebarView?.title).toBe('Mail')
    expect(manifest.capabilities.ui).toEqual({ sidebar: true, status: true })
  })

  it('fails without ui.sidebar', () => {
    expect(() =>
      parseManifest({ ...base, sidebarView: { title: 'Mail' }, viewer: { entry: 'v.html', schemes: ['mail'] } })
    ).toThrow(ManifestError)
  })

  it('TODO 1264: readable even without viewer.schemes (rows cannot have a URI, and it becomes an expand-only list)', () => {
    const manifest = parseManifest({
      ...base,
      sidebarView: { title: 'Calendar' },
      capabilities: { ui: { sidebar: true } }
    })
    expect(manifest.sidebarView?.title).toBe('Calendar')
    expect(restrictRowUris([{ id: 'a', label: 'A', uri: 'https://example.com/' }], new Set())).toEqual([{ id: 'a', label: 'A' }])
  })

  it('does not accept unknown keys (sidebarView / ui)', () => {
    expect(() =>
      parseManifest({
        ...base,
        sidebarView: { title: 'Mail', icon: 'x' },
        capabilities: { ui: { sidebar: true } },
        viewer: { entry: 'v.html', schemes: ['mail'] }
      })
    ).toThrow(ManifestError)
    expect(() => parseManifest({ ...base, capabilities: { ui: { other: true } } })).toThrow(ManifestError)
  })
})

describe('validating Broker requests', () => {
  const rows = (list: unknown): unknown => ({ capability: 'ui', op: 'setSidebarRows', rows: list })

  it('passes the row tree and the report', () => {
    expect(parseBrokerRequest(rows([{ id: 'a', label: 'A', badge: 3, children: [{ id: 'b', label: 'B', uri: 'mail://b' }] }]))).not.toBeNull()
    expect(parseBrokerRequest({ capability: 'ui', op: 'reportStatus', done: 1, total: 10, state: 'running' })).not.toBeNull()
    expect(parseBrokerRequest({ capability: 'ui', op: 'reportStatus', done: 1, total: null, state: 'offline' })).not.toBeNull()
  })

  it('refuses duplicate ids, too deep a tree, too many rows, and unknown keys', () => {
    expect(parseBrokerRequest(rows([{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]))).toBeNull()
    const deep = { id: '1', label: '1', children: [{ id: '2', label: '2', children: [{ id: '3', label: '3', children: [{ id: '4', label: '4' }] }] }] }
    expect(parseBrokerRequest(rows([deep]))).toBeNull()
    const many = Array.from({ length: MAX_SIDEBAR_ROWS + 1 }, (_, i) => ({ id: `r${i}`, label: 'x' }))
    expect(parseBrokerRequest(rows(many))).toBeNull()
    expect(parseBrokerRequest(rows([{ id: 'a', label: 'A', html: '<b>' }]))).toBeNull()
  })

  it('refuses a report whose values are broken', () => {
    const report = (extra: Record<string, unknown>): unknown => ({ capability: 'ui', op: 'reportStatus', done: 1, total: 2, state: 'running', ...extra })
    expect(parseBrokerRequest(report({ state: 'weird' }))).toBeNull()
    expect(parseBrokerRequest(report({ done: -1 }))).toBeNull()
    expect(parseBrokerRequest(report({ done: 1.5 }))).toBeNull()
    expect(parseBrokerRequest(report({ extra: 1 }))).toBeNull()
  })
})

describe('Broker: ui.setSidebarRows / ui.reportStatus', () => {
  let dbDir: string
  let db: Db
  let audit: AuditLog
  const received: string[] = []
  let broker: CapabilityBroker

  const policy = (declared: Partial<PluginPolicy['declared']>): PluginPolicy => ({
    id: 'test.sync',
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: true, ...declared },
    consented: new Set<CapabilityName>(['ui'])
  })
  let current: PluginPolicy = policy({})

  beforeAll(() => {
    dbDir = makeTestDir('surfaces-db')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key = '${'e'.repeat(64)}'`)
    runMigrations(db)
    audit = new AuditLog(db)
    broker = new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: new CredentialStore(dbDir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
      policyOf: (id) => (id === 'test.sync' ? current : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      surfaces: {
        setSidebarRows: (id, list) => received.push(`rows:${id}:${list.length}`),
        reportStatus: (id, report) => received.push(`status:${id}:${report.done}/${report.total}:${report.state}`)
      }
    })
  })
  afterAll(() => {
    audit.dispose()
    db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    received.length = 0
  })

  const rowsRequest: BrokerRequest = { capability: 'ui', op: 'setSidebarRows', rows: [{ id: 'a', label: 'A' }] }
  const statusRequest: BrokerRequest = { capability: 'ui', op: 'reportStatus', done: 5, total: 10, state: 'running' }

  it('refuses without a declaration (ui.notify alone is not enough)', async () => {
    current = policy({})
    await expect(broker.handle('test.sync', rowsRequest)).rejects.toThrow('not-declared')
    await expect(broker.handle('test.sync', statusRequest)).rejects.toThrow('not-declared')
    expect(received).toEqual([])
  })

  it('passes the validated value to the receiver when declared', async () => {
    current = policy({ uiSidebar: true, uiStatus: true })
    await broker.handle('test.sync', rowsRequest)
    await broker.handle('test.sync', statusRequest)
    expect(received).toEqual(['rows:test.sync:1', 'status:test.sync:5/10:running'])
  })

  it('refuses without consent', async () => {
    current = { ...policy({ uiStatus: true }), consented: new Set<CapabilityName>() }
    await expect(broker.handle('test.sync', statusRequest)).rejects.toThrow('not-consented')
  })
})

describe('PluginSurfaces', () => {
  let snapshots: PluginSurfacesSnapshot[]
  let enabled: boolean
  let surfaces: PluginSurfaces

  beforeEach(() => {
    vi.useFakeTimers()
    snapshots = []
    enabled = true
    surfaces = new PluginSurfaces({
      sidebarTitleOf: (id) => (id === 'aios.mail' && enabled ? 'Mail' : null),
      viewerSchemesOf: () => ['mail'],
      isEnabled: () => enabled,
      onChange: (snapshot) => snapshots.push(snapshot)
    })
  })
  afterEach(() => {
    surfaces.dispose()
    vi.useRealTimers()
  })

  it("keeps only row URIs of the plugin's viewer scheme", () => {
    const rows: PluginSidebarRow[] = [
      { id: 'a', label: 'A', uri: 'mail://a' },
      { id: 'b', label: 'B', uri: 'file:///etc/passwd' },
      { id: 'c', label: 'C', uri: 'https://example.com/', children: [{ id: 'd', label: 'D', uri: 'MAIL://d' }] }
    ]
    const out = restrictRowUris(rows, new Set(['mail']))
    expect(out[0]?.uri).toBe('mail://a')
    expect(out[1]?.uri).toBeUndefined()
    expect(out[2]?.uri).toBeUndefined()
    expect(out[2]?.children?.[0]?.uri).toBe('MAIL://d')
  })

  it('consecutive reports are sent as one', () => {
    surfaces.reportStatus('aios.mail', { done: 1, total: 10, state: 'running' })
    surfaces.reportStatus('aios.mail', { done: 2, total: 10, state: 'running' })
    surfaces.reportStatus('aios.mail', { done: 3, total: 10, state: 'running' })
    expect(snapshots).toHaveLength(0)
    vi.advanceTimersByTime(300)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.status).toEqual([{ pluginId: 'aios.mail', done: 3, total: 10, state: 'running' }])
  })

  it('the badge disappears on done, and the numerator does not exceed the denominator', () => {
    surfaces.reportStatus('aios.mail', { done: 12, total: 10, state: 'running' })
    expect(surfaces.snapshot().status[0]?.done).toBe(10)
    surfaces.reportStatus('aios.mail', { done: 10, total: 10, state: 'done' })
    expect(surfaces.snapshot().status).toEqual([])
  })

  it('the list is only plugins with sidebarView, is not shown once disabled, and is discarded on clear', () => {
    surfaces.setSidebarRows('aios.other', [{ id: 'x', label: 'X' }])
    expect(surfaces.snapshot().sidebar).toEqual([])
    surfaces.setSidebarRows('aios.mail', [{ id: 'a', label: 'A', uri: 'mail://a' }])
    expect(surfaces.snapshot().sidebar[0]).toMatchObject({ pluginId: 'aios.mail', title: 'Mail' })
    enabled = false
    expect(surfaces.snapshot().sidebar).toEqual([])
    expect(surfaces.snapshot().status).toEqual([])
    enabled = true
    surfaces.clear('aios.mail')
    expect(surfaces.snapshot().sidebar).toEqual([])
  })

  it('does not emit after dispose', () => {
    surfaces.reportStatus('aios.mail', { done: 1, total: 2, state: 'running' })
    surfaces.dispose()
    vi.advanceTimersByTime(1000)
    expect(snapshots).toHaveLength(0)
  })
})

describe('plugin-host aios.sidebar / aios.status', () => {
  it('becomes a Broker request', async () => {
    const calls: BrokerRequest[] = []
    const api = createPluginApi(async (request) => {
      calls.push(request)
      return { ok: true }
    })
    await api.sidebar.setRows([{ id: 'a', label: 'A' }])
    await api.status.report({ done: 3, total: null, state: 'paused' })
    expect(calls).toEqual([
      { capability: 'ui', op: 'setSidebarRows', rows: [{ id: 'a', label: 'A' }] },
      { capability: 'ui', op: 'reportStatus', done: 3, total: null, state: 'paused' }
    ])
  })
})

describe('pure functions of the renderer', () => {
  const rows: PluginSidebarRow[] = [
    { id: 'inbox', label: 'Inbox', children: [{ id: 't1', label: 'T1', uri: 'mail://t1' }, { id: 't2', label: 'T2', uri: 'mail://t2' }] },
    { id: 'sent', label: 'Sent', uri: 'mail://sent' }
  ]

  it('children of a collapsed branch are not visible', () => {
    expect(visibleRows(rows, new Set()).map((item) => item.row.id)).toEqual(['inbox', 't1', 't2', 'sent'])
    expect(visibleRows(rows, new Set(['inbox'])).map((item) => item.row.id)).toEqual(['inbox', 'sent'])
  })

  it('arrow keys: move, open and close, back to the parent, select', () => {
    const open = visibleRows(rows, new Set())
    expect(treeKey(open, 0, 'ArrowDown')).toEqual({ kind: 'move', index: 1 })
    expect(treeKey(open, 0, 'ArrowUp')).toEqual({ kind: 'move', index: 0 })
    expect(treeKey(open, 3, 'ArrowDown')).toEqual({ kind: 'move', index: 3 })
    expect(treeKey(open, 0, 'ArrowLeft')).toEqual({ kind: 'toggle', id: 'inbox', expand: false })
    expect(treeKey(open, 2, 'ArrowLeft')).toEqual({ kind: 'move', index: 0 })
    expect(treeKey(open, 0, 'ArrowRight')).toEqual({ kind: 'move', index: 1 })
    expect(treeKey(open, 1, 'Enter')).toEqual({ kind: 'activate', id: 't1' })
    expect(treeKey(open, 0, 'Enter')).toEqual({ kind: 'toggle', id: 'inbox', expand: false })
    const closed = visibleRows(rows, new Set(['inbox']))
    expect(treeKey(closed, 0, 'ArrowRight')).toEqual({ kind: 'toggle', id: 'inbox', expand: true })
    expect(treeKey(open, 0, 'a')).toBeNull()
  })

  it('badge text: no text at the end, and a re-entry is a different sentence', () => {
    const status = { pluginId: 'p', done: 12340, total: 204816 }
    expect(syncLabel({ ...status, state: 'done' })).toBeNull()
    expect(syncLabel({ ...status, state: 'running' })?.key).toBe('pluginSync.running')
    expect(syncLabel({ ...status, total: null, state: 'running' })?.key).toBe('pluginSync.runningUnknown')
    expect(syncLabel({ ...status, state: 'needs-reauth' })?.key).toBe('pluginSync.needsReauth')
    expect(syncLabel({ ...status, state: 'rate-limited' })?.key).toBe('pluginSync.rateLimited')
  })
})
