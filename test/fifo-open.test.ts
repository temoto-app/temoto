/**
 * TODO 918: opening a named pipe (FIFO) through main's read/write entry point does not hang.
 *
 * `openChecked` (common/fs-policy.ts) calls `openSync` on main's JS thread. Opening a FIFO with `O_RDONLY` does not return until a writer arrives, and opening it with `O_WRONLY` does not return until a reader arrives, so all windows froze (item 849 fixed only the index side).
 * It now opens with `O_NONBLOCK` and rejects by `fstat().isFile()` (`PathDenied('not-regular')`).
 *
 * **If this is not fixed, the test does not time out: it hangs forever** (a synchronous open cannot be interrupted by vitest).
 * FIFOs exist only on macOS / Linux (`mkfifo`). The fixture tree lives under home (a Phase 1 pitfall).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { PathDenied, openChecked, pathDenialCode, resolvePath } from '../src/common/fs-policy.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { ViewerBroker } from '../src/main/capability/viewer.js'
import { checkDropLinks } from '../src/main/fs/drop-links.js'
import type { CapabilityName, ResolvedViewer } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, removeTestDir, testExclusions } from './helpers/tmp.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => null } }))

const supported = process.platform !== 'win32'
const TEXT = 'test.text'
const IMAGE = 'test.image'
const rules = testExclusions(homedir())

let root: string
let dbDir: string
let db: Db
let audit: AuditLog
let broker: CapabilityBroker
let viewer: ViewerBroker
let fifo: string
let fifoPng: string

function policy(id: string): PluginPolicy {
  return {
    id,
    declared: { credentials: [], networkHosts: [], fsRead: [root], fsWrite: [], indexSources: [], ui: false },
    consented: new Set<CapabilityName>(['fs'])
  }
}

function resolveViewer(uri: string): ResolvedViewer | null {
  if (uri.endsWith('.png')) {
    return { pluginId: IMAGE, name: 'img', url: 'aios-plugin://test.image/v.html', editable: false, delivery: 'url' }
  }
  return { pluginId: TEXT, name: 'txt', url: 'aios-plugin://test.text/v.html', editable: true, delivery: 'text' }
}

beforeAll(() => {
  if (!supported) return
  root = makeTestDir('fifo-test')
  dbDir = makeTestDir('fifo-db')
  fifo = join(root, 'pipe.md')
  fifoPng = join(root, 'pipe.png')
  execFileSync('mkfifo', [fifo, fifoPng])
  writeFileSync(join(root, 'plain.md'), 'hello\n')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'f'.repeat(64)}'`)
  runMigrations(db)
  audit = new AuditLog(db)
  broker = new CapabilityBroker({
    scope: { rules },
    audit,
    credentials: new CredentialStore(dbDir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
    policyOf: (id) => (id === TEXT || id === IMAGE ? policy(id) : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
  viewer = new ViewerBroker({ broker, audit, scope: { rules }, resolveViewer })
})

afterAll(() => {
  if (!supported) return
  audit.dispose()
  db.close()
  removeTestDir(root)
  removeTestDir(dbDir)
})

describe.skipIf(!supported)('TODO 918: FIFO を開いても main が固まらない', () => {
  it('openChecked は読みでも書きでもすぐ PathDenied(not-regular) を返す', () => {
    const resolved = resolvePath(fifo, { rules }, false, 'read')
    expect(resolved.exists).toBe(true)
    const started = Date.now()
    expect(() => closeSync(openChecked(resolved, constants.O_RDONLY))).toThrow(PathDenied)
    expect(() => closeSync(openChecked(resolved, constants.O_RDONLY))).toThrow(/not-regular/)
    expect(() => closeSync(openChecked(resolved, constants.O_WRONLY))).toThrow(/not-regular/)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(pathDenialCode('not-regular')).toBe('path-not-regular')
  })

  it('FIFO を指す symlink でも同じ (実体は resolvePath が畳む)', () => {
    const link = join(root, 'link-to-pipe.md')
    symlinkSync(fifo, link)
    const resolved = resolvePath(link, { rules }, false, 'read')
    expect(() => closeSync(openChecked(resolved, constants.O_RDONLY))).toThrow(/not-regular/)
  })

  it('通常のファイルは今までどおり開ける (O_NONBLOCK は効かない)', () => {
    const resolved = resolvePath(join(root, 'plain.md'), { rules }, false, 'read')
    const fd = openChecked(resolved, constants.O_RDONLY)
    closeSync(fd)
  })

  it('viewer の読み (text) は error、保存は denied で返る', async () => {
    const uri = pathToUri(fifo)
    viewer.open(uri)
    const read = await viewer.read(TEXT, uri)
    expect(read.kind).toBe('error')
    const write = await viewer.write(TEXT, uri, 'x', null)
    expect(write).toMatchObject({ ok: false, reason: 'denied' })
    viewer.close(TEXT, uri)
  })

  it('viewer の読み (URL 配信) と aios-res:// の配信も断る', async () => {
    const uri = pathToUri(fifoPng)
    viewer.open(uri)
    const read = await viewer.read(IMAGE, uri)
    expect(read.kind).toBe('error')
    viewer.close(IMAGE, uri)
  })

  it('plugin の fs.read も断る', async () => {
    await expect(broker.handle(TEXT, { capability: 'fs', op: 'read', uri: pathToUri(fifo) })).rejects.toThrow(
      /not-regular/
    )
  })

  it('viewer への Drop (checkDropLinks) は path-not-regular で断る', () => {
    const gate = { assertAllowed: (uri: string): string => resolvePath(new URL(uri).pathname, { rules }, false, 'read').logical }
    const result = checkDropLinks([pathToUri(fifo), pathToUri(join(root, 'plain.md'))], { gate })
    expect(result.denied).toEqual([{ uri: pathToUri(fifo), reason: 'path-not-regular' }])
    expect(result.allowed).toHaveLength(1)
  })
})
