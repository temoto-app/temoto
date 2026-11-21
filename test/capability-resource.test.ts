/**
 * `aios-res://` and reading and writing viewers (review of 2026-09-21 A-4 / D-5 / D-3 / C-2 / chapter 7, ARCHITECTURE.md 7.4 / 7.7).
 *
 * - A-4: the URL carries a token, and delivery checks even whether that URI is still open for that plugin
 * - D-5: delivery does not read the body; the Broker checks and only returns the opened fd
 * - D-3: when the ViewerPane is closed or switched, the permission and token are returned (counted per window)
 * - C-2: whether a URL is passed instead of the body is decided by the viewer's manifest (`extensions` + not editable)
 * - Chapter 7: direct tests of `ViewerBroker.write` (mtime conflicts, O_NOFOLLOW, writes without permission)
 *
 * The protocol handler itself imports electron, so the delivery judgment (Broker) and the HTTP shape
 * (pure functions in `resource.ts`) are checked separately. The tree is built under home (the Phase 1 pitfall).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { ViewerBroker, withCacheBust } from '../src/main/capability/viewer.js'
import { parseRange, resourceContentType, resourceHeaders } from '../src/main/capability/resource.js'
import { RESOURCE_TOKEN_PATTERN, resourceTokenOf, tokenResourceUrl } from '../src/shared/uri.js'
import type { CapabilityName, ResolvedViewer } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => null } }))

// TODO 853: reproduces a short write of writeSync (up to `shortWrite.max` bytes; if 0, not even 1 byte can be written). If null, it passes through.
const shortWrite = vi.hoisted(() => ({ max: null as number | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) =>
      actual.writeSync(
        fd,
        buffer,
        offset,
        shortWrite.max === null ? length : Math.min(length, shortWrite.max),
        position
      )) as typeof actual.writeSync
  }
})

let root: string
let dbDir: string
let db: Db
let audit: AuditLog
let broker: CapabilityBroker
let viewer: ViewerBroker
let policyEnabled = true

const IMAGE = 'test.image'
const TEXT = 'test.text'
const rules = testExclusions(homedir())

function policy(id: string): PluginPolicy {
  return {
    id,
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false },
    consented: new Set<CapabilityName>(['fs'])
  }
}

/** Stands in for manifest resolution. `.png` / `.pdf` are taken by the image plugins as URLs; the rest are text. */
function resolveViewer(uri: string): ResolvedViewer | null {
  if (/\.(png|pdf)$/.test(uri)) {
    return { pluginId: IMAGE, name: 'img', url: 'aios-plugin://test.image/v.html', editable: false, delivery: 'url' }
  }
  return { pluginId: TEXT, name: 'txt', url: 'aios-plugin://test.text/v.html', editable: true, delivery: 'text' }
}

const file = (...parts: string[]): string => join(root, ...parts)
const uri = (...parts: string[]): string => pathToUri(file(...parts))

function tokenOf(url: string): string {
  const token = resourceTokenOf(url)
  if (token === null) throw new Error(`not a token URL: ${url}`)
  return token
}

/** Reads everything from the fd the Broker opened (in place of delivery). */
function drain(token: string): Buffer {
  const opened = broker.openResource(token)
  try {
    const out = Buffer.alloc(opened.size)
    let at = 0
    while (at < opened.size) {
      const n = readSync(opened.fd, out, at, opened.size - at, at)
      if (n === 0) break
      at += n
    }
    return out
  } finally {
    closeSync(opened.fd)
  }
}

beforeAll(() => {
  root = makeTestDir('res-test')
  dbDir = makeTestDir('res-db')
  mkdirSync(file('pics'), { recursive: true })
  mkdirSync(file('secret'), { recursive: true })
  writeFileSync(file('pics', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  writeFileSync(file('pics', 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]))
  writeFileSync(file('pics', 'doc.pdf'), Buffer.from('%PDF-1.7\n\0binary'))
  writeFileSync(file('pics', 'note.txt'), 'hello\n')
  writeFileSync(file('secret', 'key.txt'), 'TOP SECRET')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'r'.repeat(64)}'`)
  runMigrations(db)
  audit = new AuditLog(db)
  broker = new CapabilityBroker({
    scope: { rules },
    audit,
    credentials: new CredentialStore(dbDir, {
      available: () => false,
      seal: () => Buffer.alloc(0),
      open: () => ''
    }),
    policyOf: (id) => (policyEnabled && (id === IMAGE || id === TEXT) ? policy(id) : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
  viewer = new ViewerBroker({ broker, audit, scope: { rules }, resolveViewer })
})

afterAll(() => {
  audit.dispose()
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('A-4: aios-res:// はトークンで配る', () => {
  it('URL は aios-res://local/<token>/<名前> で、パスを含まない', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    const url = broker.resourceUrlFor(IMAGE, uri('pics', 'a.png'))
    expect(url.startsWith('aios-res://local/')).toBe(true)
    expect(url.endsWith('/a.png')).toBe(true)
    expect(url).not.toContain(root.slice(1))
    expect(RESOURCE_TOKEN_PATTERN.test(tokenOf(url))).toBe(true)
    expect(drain(tokenOf(url)).equals(readFileSync(file('pics', 'a.png')))).toBe(true)
    viewer.close(IMAGE, uri('pics', 'a.png'))
  })

  it('開いていない URI には URL を発行しない', () => {
    expect(() => broker.resourceUrlFor(IMAGE, uri('pics', 'b.png'))).toThrow('no-grant')
  })

  it('同じ許可の間は同じトークン (描き直しや範囲取得で何度も取りに来る)', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    const first = broker.resourceUrlFor(IMAGE, uri('pics', 'a.png'))
    expect(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png'))).toBe(first)
    viewer.close(IMAGE, uri('pics', 'a.png'))
  })

  it('**別のプラグインには同じファイルでも別のトークン**。片方を閉じても他方は生きている', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    broker.grantOpen(TEXT, uri('pics', 'a.png'))
    const forImage = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png')))
    const forText = tokenOf(broker.resourceUrlFor(TEXT, uri('pics', 'a.png')))
    expect(forImage).not.toBe(forText)
    viewer.close(TEXT, uri('pics', 'a.png'))
    expect(() => broker.openResource(forText)).toThrow('unknown-token')
    expect(drain(forImage).byteLength).toBeGreaterThan(0)
    viewer.close(IMAGE, uri('pics', 'a.png'))
  })

  it('知らないトークン・形の違う URL は配らない', () => {
    expect(() => broker.openResource('0'.repeat(32))).toThrow('unknown-token')
    // The old format (a URL that carries the path as is) is not read as a token.
    expect(resourceTokenOf(`aios-res://local${file('pics', 'a.png')}`)).toBeNull()
    expect(resourceTokenOf('aios-res://local/ABC/a.png')).toBeNull()
    expect(resourceTokenOf('aios-res://other/' + 'a'.repeat(32) + '/x')).toBeNull()
    expect(resourceTokenOf(tokenResourceUrl('f'.repeat(32), 'a b.png'))).toBe('f'.repeat(32))
  })

  it('プラグインが無効になった (ポリシーが消えた) ら、発行済みのトークンでも配らない', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png')))
    policyEnabled = false
    try {
      expect(() => broker.openResource(token)).toThrow('unknown-plugin')
    } finally {
      policyEnabled = true
      viewer.close(IMAGE, uri('pics', 'a.png'))
    }
  })

  it('発行の後に symlink へ差し替えられたら配らない (配信のときにもう一度 realpath)', () => {
    const swap = file('pics', 'swap.png')
    writeFileSync(swap, Buffer.from([0x89, 0x50]))
    broker.grantOpen(IMAGE, pathToUri(swap))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, pathToUri(swap)))
    rmSync(swap)
    symlinkSync(file('secret', 'key.txt'), swap)
    expect(() => broker.openResource(token)).toThrow('symlink-escape')
    viewer.close(IMAGE, pathToUri(swap))
  })

  it('配信は監査に fs / resource として残る (許可も拒否も)', () => {
    broker.grantOpen(IMAGE, uri('pics', 'b.png'))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'b.png')))
    drain(token)
    viewer.close(IMAGE, uri('pics', 'b.png'))
    expect(() => broker.openResource(token)).toThrow()
    audit.flush()
    const entries = audit.recent(100).filter((entry) => entry.op === 'resource')
    expect(entries.some((e) => e.decision === 'allow' && e.target === uri('pics', 'b.png'))).toBe(true)
    expect(entries.some((e) => e.decision === 'deny' && e.reason === 'unknown-token')).toBe(true)
  })
})

describe('TODO 550: アプリ自身 (タイムラインの送った画像) の aios-res://', () => {
  it('画像は viewer で開いていなくても URL が出て、同じ URI は同じトークン、配信は中身そのもの', () => {
    const url = broker.hostImageUrlFor(uri('pics', 'b.png'))
    expect(url.endsWith('/b.png')).toBe(true)
    expect(url).not.toContain(root.slice(1))
    expect(broker.hostImageUrlFor(uri('pics', 'b.png'))).toBe(url)
    expect(drain(tokenOf(url)).equals(readFileSync(file('pics', 'b.png')))).toBe(true)
    // It is not mixed with the plugin's permissions (a URL for b.png does not appear in the image viewer).
    expect(() => broker.resourceUrlFor(IMAGE, uri('pics', 'b.png'))).toThrow('no-grant')
  })

  it('画像でない・除外・無いファイルには出さない。ViewerBroker の口は null で返す', () => {
    expect(() => broker.hostImageUrlFor(uri('secret', 'key.txt'))).toThrow('not-image')
    expect(() => broker.hostImageUrlFor(uri('pics', 'gone.png'))).toThrow()
    expect(() => broker.hostImageUrlFor(pathToUri(join(homedir(), '.ssh', 'id.png')))).toThrow()
    expect(viewer.hostImageUrl(uri('secret', 'key.txt'))).toBeNull()
    expect(viewer.hostImageUrl(uri('pics', 'a.png'))).toMatch(/^aios-res:\/\/local\//)
  })

  it('symlink で画像の名前を付けた秘密 (除外に当たる実体) は配信のたびの判定で断る', () => {
    // After TODO 590, a symlink itself is followed too if its target is not excluded, so a target that is not caught by an exclusion
    // (for example secret/key.txt) gets delivered (a default I decided myself, the same thinking as 558). To try the refusal form, use a target
    // whose name is caught by an exclusion (id_rsa etc., 'credentials-or-noise' at any level).
    writeFileSync(file('secret', 'id_rsa'), 'TOP SECRET KEY')
    symlinkSync(file('secret', 'id_rsa'), file('pics', 'disguised.png'))
    const url = viewer.hostImageUrl(uri('pics', 'disguised.png'))
    if (url !== null) expect(() => drain(tokenOf(url))).toThrow()
  })

  it('TODO 590: symlink 自身の画像 (実体が除外でなければ) は配る', () => {
    const link = file('pics', 'host-link.png')
    symlinkSync(file('pics', 'a.png'), link)
    const url = viewer.hostImageUrl(uri('pics', 'host-link.png'))
    expect(url).not.toBeNull()
    expect(drain(tokenOf(url ?? '')).equals(readFileSync(file('pics', 'a.png')))).toBe(true)
  })
})

describe('TODO 876: 回答の中のローカルの画像 (timelineImageUrl)', () => {
  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

  it('先頭が画像のものだけ出し、配信は中身そのもの', () => {
    writeFileSync(file('pics', 'real.png'), PNG_HEAD)
    const url = viewer.timelineImageUrl(uri('pics', 'real.png'))
    expect(url).toMatch(/^aios-res:\/\/local\//)
    expect(drain(tokenOf(url ?? '')).equals(PNG_HEAD)).toBe(true)
  })

  it('TODO 879: svg / bmp / avif も中身が画像なら出す。拡張子だけ svg の他の中身は出さない', () => {
    writeFileSync(file('pics', 'a.svg'), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(viewer.timelineImageUrl(uri('pics', 'a.svg'))).toMatch(/^aios-res:\/\/local\//)
    writeFileSync(file('pics', 'a.bmp'), Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)]))
    expect(viewer.timelineImageUrl(uri('pics', 'a.bmp'))).toMatch(/^aios-res:\/\/local\//)
    writeFileSync(file('pics', 'a.avif'), Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]))
    expect(viewer.timelineImageUrl(uri('pics', 'a.avif'))).toMatch(/^aios-res:\/\/local\//)
    writeFileSync(file('pics', 'fake.svg'), 'password=hunter2')
    expect(viewer.timelineImageUrl(uri('pics', 'fake.svg'))).toBeNull()
  })

  it('名前だけ .png のテキスト・資格情報は出さない (マジックバイト)', () => {
    writeFileSync(file('pics', 'fake.png'), 'not an image at all')
    expect(viewer.timelineImageUrl(uri('pics', 'fake.png'))).toBeNull()
  })

  it('画像でない拡張子・除外・無いファイルは null', () => {
    expect(viewer.timelineImageUrl(uri('secret', 'key.txt'))).toBeNull()
    expect(viewer.timelineImageUrl(pathToUri(join(homedir(), '.ssh', 'id.png')))).toBeNull()
    expect(viewer.timelineImageUrl(uri('pics', 'gone.png'))).toBeNull()
  })

  it('除外に当たる実体への symlink は null、そうでない実体の画像への symlink は出す', () => {
    writeFileSync(file('secret', 'id_rsa'), PNG_HEAD)
    symlinkSync(file('secret', 'id_rsa'), file('pics', 'sneaky.png'))
    expect(viewer.timelineImageUrl(uri('pics', 'sneaky.png'))).toBeNull()
    writeFileSync(file('pics', 'target.png'), PNG_HEAD)
    symlinkSync(file('pics', 'target.png'), file('pics', 'ok-link.png'))
    expect(viewer.timelineImageUrl(uri('pics', 'ok-link.png'))).not.toBeNull()
  })
})

describe('D-3: 閉じたら許可を返す (窓ごとに数える)', () => {
  it('閉じた URI は読めず、トークンも消える', async () => {
    viewer.open(uri('pics', 'a.png'))
    const read = await viewer.read(IMAGE, uri('pics', 'a.png'))
    expect(read.kind).toBe('binary')
    const token = tokenOf(read.kind === 'binary' ? read.resourceUrl : '')
    viewer.close(IMAGE, uri('pics', 'a.png'))
    expect(() => broker.openResource(token)).toThrow('unknown-token')
    expect((await viewer.read(IMAGE, uri('pics', 'a.png'))).kind).toBe('error')
  })

  it('2 つの窓で開いていれば、1 つ閉じても残り、2 つ目で消える', async () => {
    viewer.open(uri('pics', 'note.txt'))
    viewer.open(uri('pics', 'note.txt'))
    viewer.close(TEXT, uri('pics', 'note.txt'))
    expect((await viewer.read(TEXT, uri('pics', 'note.txt'))).kind).toBe('text')
    viewer.close(TEXT, uri('pics', 'note.txt'))
    expect((await viewer.read(TEXT, uri('pics', 'note.txt'))).kind).toBe('error')
  })

  it('開いていない URI・壊れた URI を閉じても何も起きない', () => {
    expect(() => viewer.close(TEXT, uri('pics', 'nothing.txt'))).not.toThrow()
    expect(() => viewer.close(TEXT, 'not a uri')).not.toThrow()
    expect(() => viewer.close('no.such.plugin', uri('pics', 'note.txt'))).not.toThrow()
  })

  it('閉じ損ねの上限は 16 本で、押し出された許可のトークンも消える', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png')))
    for (let i = 0; i < 16; i += 1) {
      const extra = file('pics', `extra-${i}.png`)
      writeFileSync(extra, Buffer.from([i]))
      broker.grantOpen(IMAGE, pathToUri(extra))
    }
    expect(() => broker.openResource(token)).toThrow('unknown-token')
    broker.revokeOpen(IMAGE)
  })

  it('uri を省いた revokeOpen はそのプラグインの許可とトークンを全部落とす', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    broker.grantOpen(IMAGE, uri('pics', 'b.png'))
    const a = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png')))
    const b = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'b.png')))
    broker.revokeOpen(IMAGE)
    expect(() => broker.openResource(a)).toThrow('unknown-token')
    expect(() => broker.openResource(b)).toThrow('unknown-token')
  })
})

describe('C-2: URL で渡すかは viewer のマニフェストが決める', () => {
  it('URL で受ける viewer にはバイナリ (PDF) でも resourceUrl を返す (以前は binary のエラー)', async () => {
    viewer.open(uri('pics', 'doc.pdf'))
    const resource = await viewer.read(IMAGE, uri('pics', 'doc.pdf'))
    expect(resource.kind).toBe('binary')
    if (resource.kind === 'binary') {
      expect(resource.size).toBe(statSync(file('pics', 'doc.pdf')).size)
      expect(drain(tokenOf(resource.resourceUrl)).toString('latin1')).toContain('%PDF')
    }
    viewer.close(IMAGE, uri('pics', 'doc.pdf'))
  })

  it('テキストの viewer には本文を返す', async () => {
    viewer.open(uri('pics', 'note.txt'))
    const resource = await viewer.read(TEXT, uri('pics', 'note.txt'))
    expect(resource).toMatchObject({ kind: 'text', text: 'hello\n', truncated: false })
    viewer.close(TEXT, uri('pics', 'note.txt'))
  })

  it('解決した viewer と違うプラグインが読むときは URL にしない (テキストの経路で判定)', async () => {
    broker.grantOpen(TEXT, uri('pics', 'a.png'))
    const resource = await viewer.read(TEXT, uri('pics', 'a.png'))
    // A PNG is not passed to the text viewer (it contains NUL, so it is a binary error).
    expect(resource).toEqual({ kind: 'error', message: 'binary' })
    viewer.close(TEXT, uri('pics', 'a.png'))
  })

  it('PluginHost の解決: 拡張子で名乗り出て編集しない viewer だけが url', async () => {
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const memory = new Database(':memory:')
    runMigrations(memory)
    const dir = mkdtempSync(join(tmpdir(), 'aios-res-host-'))
    try {
      const plugins = new PluginHost({
        db: memory,
        bundledDir: join(process.cwd(), 'plugins'),
        userDir: join(dir, 'user'),
        hostEntry: join(dir, 'host.js'),
        broker: () => broker,
        onChanged: () => {}
      })
      plugins.load()
      expect(plugins.resolveViewer('file:///tmp/x.png')).toMatchObject({ pluginId: 'aios.image', delivery: 'url' })
      expect(plugins.resolveViewer('file:///tmp/x.svg')).toMatchObject({ pluginId: 'aios.image', delivery: 'url' })
      expect(plugins.resolveViewer('file:///tmp/x.md')).toMatchObject({ pluginId: 'aios.markdown', delivery: 'text' })
      expect(plugins.resolveViewer('file:///tmp/x.ts')).toMatchObject({ pluginId: 'aios.text', delivery: 'text' })
      // aios.pdf (TODO 405) claims PDFs, and since it does not edit them, they are received as a URL.
      expect(plugins.resolveViewer('file:///tmp/x.pdf')).toMatchObject({ pluginId: 'aios.pdf', delivery: 'url' })
      // aios.office (TODO 405 (4)): docx / xlsx are passed as URLs. Old-format .doc / .xls and .pptx are not claimed.
      expect(plugins.resolveViewer('file:///tmp/x.docx')).toMatchObject({ pluginId: 'aios.office', delivery: 'url' })
      expect(plugins.resolveViewer('file:///tmp/x.xlsx')).toMatchObject({ pluginId: 'aios.office', delivery: 'url' })
      // TODO 1212 stage 1: only xlsx accepts cell-value drafts (docx does not get it).
      expect(plugins.resolveViewer('file:///tmp/x.xlsx')?.cellEdits).toBe(true)
      expect(plugins.resolveViewer('file:///tmp/x.docx')?.cellEdits).toBeUndefined()
      // TODO 1212 stage 2: a macro-enabled .xlsm is also a URL plus cell drafts.
      expect(plugins.resolveViewer('file:///tmp/x.xlsm')).toMatchObject({ pluginId: 'aios.office', delivery: 'url', cellEdits: true })
      expect(plugins.resolveViewer('file:///tmp/x.xls')).toMatchObject({ pluginId: 'aios.text' })
      expect(plugins.resolveViewer('file:///tmp/x.pptx')).toMatchObject({ pluginId: 'aios.text' })
      // aios.html (TODO 401): html / htm are editable, so they are passed as the body (CodeMirror in Source and srcdoc in Preview).
      expect(plugins.resolveViewer('file:///tmp/x.html')).toMatchObject({ pluginId: 'aios.html', delivery: 'text' })
      expect(plugins.resolveViewer('file:///tmp/X.HTM')).toMatchObject({ pluginId: 'aios.html', delivery: 'text' })
      expect(plugins.resolveViewer('file:///tmp/x.xhtml')).toMatchObject({ pluginId: 'aios.text' })
    } finally {
      memory.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('D-5 / 配信の HTTP の形 (resource.ts)', () => {
  it('Range: 1 範囲だけ受ける', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable')
    // A form that is not interpreted returns the whole thing.
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
  })

  it('応答ヘッダ: 長さ・範囲・nosniff・キャッシュしない・CORS', () => {
    const full = resourceHeaders('/x/a.pdf', 100, null)
    expect(full).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': '100',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    })
    expect(full['content-range']).toBeUndefined()
    const part = resourceHeaders('/x/a.pdf', 100, { start: 10, end: 19 })
    expect(part).toMatchObject({ 'content-length': '10', 'content-range': 'bytes 10-19/100' })
  })

  it('SVG は文書として開かれてもスクリプトを動かさない CSP を付ける', () => {
    expect(resourceHeaders('/x/a.svg', 1, null)['content-security-policy']).toContain("default-src 'none'")
    expect(resourceHeaders('/x/a.svg', 1, null)['content-security-policy']).toContain("script-src 'none'")
    expect(resourceHeaders('/x/a.svg', 1, null)['content-type']).toBe('image/svg+xml')
    expect(resourceHeaders('/x/a.png', 1, null)['content-security-policy']).toBeUndefined()
  })

  it('Content-Type は拡張子から (知らなければ octet-stream)', () => {
    expect(resourceContentType('/a/b.PNG')).toBe('image/png')
    expect(resourceContentType('/a/b.pdf')).toBe('application/pdf')
    expect(resourceContentType('/a/b.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(resourceContentType('/a/b.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(resourceContentType('/a/b.exe')).toBe('application/octet-stream')
  })

  it('動画 (TODO 405、aios.video) の Content-Type。avi は Chromium で再生できないが配信の型は出す', () => {
    expect(resourceContentType('/a/b.mp4')).toBe('video/mp4')
    expect(resourceContentType('/a/b.M4V')).toBe('video/x-m4v')
    expect(resourceContentType('/a/b.mov')).toBe('video/quicktime')
    expect(resourceContentType('/a/b.webm')).toBe('video/webm')
    expect(resourceContentType('/a/b.avi')).toBe('video/x-msvideo')
  })

  it('音声 (TODO 1271、aios.video) の Content-Type', () => {
    expect(resourceContentType('/a/b.wav')).toBe('audio/wav')
    expect(resourceContentType('/a/b.MP3')).toBe('audio/mpeg')
    expect(resourceContentType('/a/b.m4a')).toBe('audio/mp4')
    expect(resourceContentType('/a/b.ogg')).toBe('audio/ogg')
    expect(resourceContentType('/a/b.flac')).toBe('audio/flac')
  })

  it('openResource は fd と大きさだけを返し、本文を読まない (大きさは fstat)', () => {
    broker.grantOpen(IMAGE, uri('pics', 'b.png'))
    const opened = broker.openResource(tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'b.png'))))
    try {
      expect(opened.size).toBe(6)
      expect(opened.path).toBe(file('pics', 'b.png'))
      expect(Object.keys(opened).sort()).toEqual(['fd', 'path', 'size'])
    } finally {
      closeSync(opened.fd)
      viewer.close(IMAGE, uri('pics', 'b.png'))
    }
  })
})

describe('TODO 851: UTF-8 でないテキストは読み取り専用', () => {
  it('Shift_JIS のバイト列は readOnly (書き戻させない)', async () => {
    const target = file('pics', 'sjis.txt')
    writeFileSync(target, Buffer.from([0x82, 0xa0, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('切り詰めの末尾が文字の途中で切れても不正と数えない', async () => {
    const target = file('pics', 'cut.txt')
    writeFileSync(target, 'あいう\n')
    viewer.open(pathToUri(target))
    const cut = (await broker.handle(TEXT, { capability: 'fs', op: 'read', uri: pathToUri(target), length: 4 })) as {
      truncated: boolean
      invalidUtf8?: boolean
    }
    expect(cut.truncated).toBe(true)
    expect(cut.invalidUtf8).toBeUndefined()
    viewer.close(TEXT, pathToUri(target))
  })

  it('正しい UTF-8 の日本語は編集できる (readOnly が付かない)', async () => {
    const target = file('pics', 'utf8-ja.txt')
    writeFileSync(target, 'こんにちは\n')
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read.kind).toBe('text')
    expect('readOnly' in read).toBe(false)
    viewer.close(TEXT, pathToUri(target))
  })
})

describe('TODO 1215: UTF-8 でない日本語のテキストを読める文字で渡す (読み取り専用のまま)', () => {
  // Shift_JIS of two kanji, a comma, one hiragana, then CRLF (the form of a CSV that Excel writes).
  const SJIS = [0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x82, 0xa0, 0x0d, 0x0a]
  // EUC-JP of two kanji, a comma, one hiragana, then LF.
  const EUC = [0xc5, 0xec, 0xb5, 0xfe, 0x2c, 0xa4, 0xa2, 0x0a]

  it('Shift_JIS の CSV は Shift_JIS として読み、readOnly のまま', async () => {
    const target = file('pics', 'sjis.csv')
    writeFileSync(target, Buffer.from(SJIS))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: '東京,あ\r\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('仮名の無い Shift_JIS (漢字だけ) を EUC-JP の C1 制御文字に取り違えない', async () => {
    // Two kanji then LF. ICU's EUC-JP turns 0x93 and similar into U+0093 without reporting an error, so it is refused here and passed on to Shift_JIS.
    const target = file('pics', 'sjis-kanji.txt')
    writeFileSync(target, Buffer.from([0x93, 0x8c, 0x8b, 0x9e, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: '東京\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('EUC-JP は EUC-JP として読む (Shift_JIS の半角カナに取り違えない)', async () => {
    const target = file('pics', 'euc.txt')
    writeFileSync(target, Buffer.from(EUC))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: '東京,あ\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('切り詰めの末尾が Shift_JIS の文字の途中でも、欠けた文字を捨てて読む', async () => {
    const target = file('pics', 'sjis-cut.txt')
    writeFileSync(target, Buffer.from(SJIS))
    viewer.open(pathToUri(target))
    // The first kanji (2 bytes) plus the first byte of the second kanji.
    const cut = (await broker.handle(TEXT, { capability: 'fs', op: 'read', uri: pathToUri(target), length: 3 })) as {
      truncated: boolean
      invalidUtf8?: boolean
      text?: string
    }
    expect(cut).toMatchObject({ truncated: true, invalidUtf8: true, text: '東' })
    viewer.close(TEXT, pathToUri(target))
  })

  it('半角カナだけの Shift_JIS (ﾌﾘｺﾐ,100) を EUC-JP の漢字に取り違えない (code-review Y4)', async () => {
    const target = file('pics', 'sjis-hwkana.csv')
    writeFileSync(target, Buffer.from([0xcc, 0xd8, 0xba, 0xd0, 0x2c, 0x31, 0x30, 0x30, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: 'ﾌﾘｺﾐ,100\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('GBK の文はでたらめな漢字にせず U+FFFD のまま (code-review Y4)', async () => {
    const target = file('pics', 'gbk.csv')
    writeFileSync(target, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7]))
    viewer.open(pathToUri(target))
    const read = (await viewer.read(TEXT, pathToUri(target))) as { text?: string; readOnly?: boolean }
    expect(read.readOnly).toBe(true)
    expect(read.text).toContain('\ufffd')
    viewer.close(TEXT, pathToUri(target))
  })

  it('UTF-8 は今までどおり UTF-8 で読み、書き戻せる (invalidUtf8 を付けない)', async () => {
    const target = file('pics', 'utf8.csv')
    writeFileSync(target, '東京,あ\n', 'utf8')
    viewer.open(pathToUri(target))
    const read = (await viewer.read(TEXT, pathToUri(target))) as { text?: string; readOnly?: boolean }
    expect(read.text).toBe('東京,あ\n')
    expect(read.readOnly).not.toBe(true)
    viewer.close(TEXT, pathToUri(target))
  })

  it('どちらとしても読めないバイト列 (Latin-1) は今までどおり U+FFFD で置き換える', async () => {
    const target = file('pics', 'latin1.txt')
    writeFileSync(target, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x21, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: 'caf\ufffd !\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })
})

describe('ViewerBroker.write (レビュー 7 章: 直接のテストが無かった)', () => {
  it('開いた URI に書け、長い既存の末尾は切り詰められる', async () => {
    const target = file('pics', 'edit.txt')
    writeFileSync(target, 'a long original body\n')
    viewer.open(pathToUri(target))
    const before = statSync(target).mtimeMs
    const result = await viewer.write(TEXT, pathToUri(target), 'short\n', before)
    expect(result).toMatchObject({ ok: true, reason: null, size: 6 })
    expect(readFileSync(target, 'utf8')).toBe('short\n')
    viewer.close(TEXT, pathToUri(target))
  })

  it('TODO 1073: 書いた後に audit が投げても fd を二重に閉じない (EBADF を投げず io を返す)', async () => {
    const target = file('pics', 'audit-throws.txt')
    writeFileSync(target, 'old\n')
    viewer.open(pathToUri(target))
    const spy = vi.spyOn(audit, 'record').mockImplementationOnce(() => {
      throw new Error('audit down')
    })
    try {
      const result = await viewer.write(TEXT, pathToUri(target), 'new\n', null)
      expect(result).toMatchObject({ ok: false, reason: 'io' })
    } finally {
      spy.mockRestore()
    }
    expect(readFileSync(target, 'utf8')).toBe('new\n')
    viewer.close(TEXT, pathToUri(target))
  })

  it('**TODO 853: 短い書き込みが返っても書き切るまで回す**', async () => {
    const target = file('pics', 'short.txt')
    writeFileSync(target, 'old\n')
    viewer.open(pathToUri(target))
    shortWrite.max = 3
    try {
      const result = await viewer.write(TEXT, pathToUri(target), 'ひとつ ふたつ みっつ\n', null)
      expect(result).toMatchObject({ ok: true })
    } finally {
      shortWrite.max = null
    }
    expect(readFileSync(target, 'utf8')).toBe('ひとつ ふたつ みっつ\n')
    viewer.close(TEXT, pathToUri(target))
  })

  it('**TODO 853: 1 バイトも書けなければ ok を返さない (io)**', async () => {
    const target = file('pics', 'nospace.txt')
    writeFileSync(target, 'old\n')
    viewer.open(pathToUri(target))
    shortWrite.max = 0
    let result
    try {
      result = await viewer.write(TEXT, pathToUri(target), 'new content\n', null)
    } finally {
      shortWrite.max = null
    }
    expect(result).toMatchObject({ ok: false, reason: 'io' })
    viewer.close(TEXT, pathToUri(target))
  })

  it('**TODO 853: read の mtime は本文と同じ fd のもの** (broker の読みが mtimeMs を返し、viewer がそれを使う)', async () => {
    const target = file('pics', 'mtime.txt')
    writeFileSync(target, 'body\n')
    viewer.open(pathToUri(target))
    const raw = (await broker.handle(TEXT, { capability: 'fs', op: 'read', uri: pathToUri(target) })) as {
      mtimeMs: number
    }
    expect(raw.mtimeMs).toBe(statSync(target).mtimeMs)
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', mtimeMs: statSync(target).mtimeMs })
    viewer.close(TEXT, pathToUri(target))
  })

  it('mtime が食い違えば書かずに conflict (外で書き換えられた)', async () => {
    const target = file('pics', 'conflict.txt')
    writeFileSync(target, 'disk\n')
    viewer.open(pathToUri(target))
    const result = await viewer.write(TEXT, pathToUri(target), 'mine\n', statSync(target).mtimeMs - 5000)
    expect(result.reason).toBe('conflict')
    expect(readFileSync(target, 'utf8')).toBe('disk\n')
    viewer.close(TEXT, pathToUri(target))
  })

  it('開いていない URI には書けない (denied)。閉じた後も同じ', async () => {
    const target = file('pics', 'closed.txt')
    writeFileSync(target, 'x')
    expect((await viewer.write(TEXT, pathToUri(target), 'y', null)).reason).toBe('denied')
    viewer.open(pathToUri(target))
    viewer.close(TEXT, pathToUri(target))
    expect((await viewer.write(TEXT, pathToUri(target), 'y', null)).reason).toBe('denied')
    expect(readFileSync(target, 'utf8')).toBe('x')
  })

  it('**開いた後に外を指す symlink へ差し替えられたら書かない** (realpath + O_NOFOLLOW)', async () => {
    const target = file('pics', 'link.txt')
    writeFileSync(target, 'x')
    viewer.open(pathToUri(target))
    rmSync(target)
    symlinkSync(file('secret', 'key.txt'), target)
    expect((await viewer.write(TEXT, pathToUri(target), 'pwned', null)).reason).toBe('denied')
    expect(readFileSync(file('secret', 'key.txt'), 'utf8')).toBe('TOP SECRET')
    viewer.close(TEXT, pathToUri(target))
  })

  it('消えたファイルは not-found、上限を越える本文は too-large', async () => {
    const gone = file('pics', 'gone.txt')
    writeFileSync(gone, 'x')
    viewer.open(pathToUri(gone))
    rmSync(gone)
    expect((await viewer.write(TEXT, pathToUri(gone), 'y', null)).reason).toBe('not-found')
    expect((await viewer.write(TEXT, pathToUri(gone), 'y'.repeat(2 * 1024 * 1024 + 1), null)).reason).toBe(
      'too-large'
    )
    viewer.close(TEXT, pathToUri(gone))
  })

  it('**TODO 558: symlink のファイルを開くと読めて、保存は実体に書く** (リンクはリンクのまま)', async () => {
    const real = file('pics', 'real-todo.md')
    const link = file('pics', 'todo-link.md')
    writeFileSync(real, '# todo\n')
    symlinkSync(real, link)
    const opened = viewer.open(pathToUri(link))
    expect(opened?.linkTargetUri).toBe(pathToUri(real))
    const resource = await viewer.read(TEXT, pathToUri(link))
    expect(resource).toMatchObject({ kind: 'text', text: '# todo\n' })
    const result = await viewer.write(TEXT, pathToUri(link), '# done\n', statSync(real).mtimeMs)
    expect(result).toMatchObject({ ok: true, reason: null })
    expect(readFileSync(real, 'utf8')).toBe('# done\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    viewer.close(TEXT, pathToUri(link))
  })

  it('**TODO 558: 開いた後にリンクを別の場所へ向け直されたら読まず書かない** (実体は開いた時点のもの)', async () => {
    const real = file('pics', 'real-a.txt')
    const link = file('pics', 'retarget.txt')
    writeFileSync(real, 'a')
    symlinkSync(real, link)
    viewer.open(pathToUri(link))
    rmSync(link)
    symlinkSync(file('secret', 'key.txt'), link)
    expect((await viewer.read(TEXT, pathToUri(link))).kind).toBe('error')
    expect((await viewer.write(TEXT, pathToUri(link), 'pwned', null)).reason).toBe('denied')
    expect(readFileSync(file('secret', 'key.txt'), 'utf8')).toBe('TOP SECRET')
    viewer.close(TEXT, pathToUri(link))
  })

  it('**TODO 558: 途中の要素が symlink (リンクしたフォルダの中) のファイルも読める**。見出しの添えは付かない', async () => {
    const dirLink = file('pics-link')
    symlinkSync(file('pics'), dirLink)
    const uri = pathToUri(join(dirLink, 'note.txt'))
    const opened = viewer.open(uri)
    expect(opened?.linkTargetUri).toBeUndefined()
    expect(await viewer.read(TEXT, uri)).toMatchObject({ kind: 'text', text: 'hello\n' })
    viewer.close(TEXT, uri)
  })

  it('**TODO 558: symlink の画像は URL で配る** (配信も開いた時点の実体の範囲)', () => {
    const link = file('pics', 'a-link.png')
    symlinkSync(file('pics', 'a.png'), link)
    broker.grantOpen(IMAGE, pathToUri(link))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, pathToUri(link)))
    expect(drain(token).equals(readFileSync(file('pics', 'a.png')))).toBe(true)
    viewer.close(IMAGE, pathToUri(link))
  })

  it('書き込みは許可も拒否も監査に残る', async () => {
    audit.flush()
    const writes = audit.recent(200).filter((entry) => entry.op === 'write')
    expect(writes.some((e) => e.decision === 'allow')).toBe(true)
    expect(writes.some((e) => e.decision === 'deny' && e.reason === 'conflict')).toBe(true)
  })
})

describe('TODO 673: viewId を渡すと watch.track / watch.settle が呼ばれる (省略すると呼ばれない)', () => {
  function withWatch(): {
    viewer: ViewerBroker
    tracked: { viewId: number; uri: string; path: string; mtimeMs: number; size: number }[]
    settled: { viewId: number; uri: string; mtimeMs: number; size: number }[]
    untracked: number[]
  } {
    const tracked: { viewId: number; uri: string; path: string; mtimeMs: number; size: number }[] = []
    const settled: { viewId: number; uri: string; mtimeMs: number; size: number }[] = []
    const untracked: number[] = []
    const v = new ViewerBroker({
      broker,
      audit,
      scope: { rules },
      resolveViewer,
      watch: {
        track: (viewId, uri, path, mtimeMs, size) => tracked.push({ viewId, uri, path, mtimeMs, size }),
        settle: (viewId, uri, mtimeMs, size) => settled.push({ viewId, uri, mtimeMs, size }),
        untrack: (viewId) => untracked.push(viewId)
      }
    })
    return { viewer: v, tracked, settled, untracked }
  }

  it('read (text) に viewId を渡すと、実体の canonical path で track される', async () => {
    const { viewer: v, tracked } = withWatch()
    const target = uri('pics', 'note.txt')
    v.open(target)
    const result = await v.read(TEXT, target, 7)
    if (result.kind !== 'text') throw new Error('expected text')
    expect(tracked).toEqual([{ viewId: 7, uri: target, path: file('pics', 'note.txt'), mtimeMs: result.mtimeMs, size: result.size }])
    v.close(TEXT, target)
  })

  it('read (binary = URL 渡し) にも同じく効く', async () => {
    const { viewer: v, tracked } = withWatch()
    const target = uri('pics', 'a.png')
    v.open(target)
    const result = await v.read(IMAGE, target, 8)
    if (result.kind !== 'binary') throw new Error('expected binary')
    expect(tracked).toEqual([{ viewId: 8, uri: target, path: file('pics', 'a.png'), mtimeMs: result.mtimeMs, size: result.size }])
    v.close(IMAGE, target)
  })

  // code-review fix (critical 6): even on a re-read, `resourceUrlFor` reuses the same token,
  // so the mtime is added to the query to make `<img>` / `<video>` / aios.pdf fetch it again.
  it('withCacheBust: 同じ URL でも mtime が違えばクエリが変わる (resourceTokenOf はトークンを拾える)', () => {
    const a = withCacheBust('aios-res://local/abc123/pic.png', 1000.4)
    const b = withCacheBust('aios-res://local/abc123/pic.png', 2000)
    expect(a).not.toBe(b)
    expect(a).toBe('aios-res://local/abc123/pic.png?m=1000')
  })

  it('read (binary) が返す resourceUrl には mtime のクエリが付く', async () => {
    const { viewer: v } = withWatch()
    const target = uri('pics', 'a.png')
    v.open(target)
    const result = await v.read(IMAGE, target, 10)
    if (result.kind !== 'binary') throw new Error('expected binary')
    expect(result.resourceUrl).toMatch(/\?m=\d+$/)
    v.close(IMAGE, target)
  })

  it('viewId を省略すると track されない (既存の呼び出し元はそのまま)', async () => {
    const { viewer: v, tracked } = withWatch()
    const target = uri('pics', 'note.txt')
    v.open(target)
    await v.read(TEXT, target)
    expect(tracked).toEqual([])
    v.close(TEXT, target)
  })

  it('write が成功すると viewId で settle される (衝突・失敗では呼ばれない)', async () => {
    const { viewer: v, settled } = withWatch()
    const target = file('pics', 'watch-write.txt')
    writeFileSync(target, 'before\n')
    v.open(pathToUri(target))
    const before = statSync(target).mtimeMs
    const ok = await v.write(TEXT, pathToUri(target), 'after\n', before, 9)
    expect(ok.ok).toBe(true)
    expect(settled).toEqual([{ viewId: 9, uri: pathToUri(target), mtimeMs: ok.mtimeMs, size: ok.size }])

    const conflict = await v.write(TEXT, pathToUri(target), 'x', before - 5000, 9)
    expect(conflict.reason).toBe('conflict')
    expect(settled).toHaveLength(1)
    v.close(TEXT, pathToUri(target))
  })

  // code-review fix (first half of critical 7): when the ViewerPane is fully closed, the watch is removed by a new one-way notice
  // (`closeView`). A separate entry point, not the `close(pluginId, uri)` of the probe in item 471.
  it('closeView(viewId) は watch.untrack を呼ぶ (471 の probe の close とは別の口)', async () => {
    const { viewer: v, tracked, untracked } = withWatch()
    const target = uri('pics', 'note.txt')
    v.open(target)
    await v.read(TEXT, target, 11)
    expect(tracked).toHaveLength(1)
    expect(untracked).toEqual([])

    v.closeView(11)
    expect(untracked).toEqual([11])

    // The probe of item 471 (open -> close at once) does not call untrack (close() and closeView() are separate entry points).
    v.close(TEXT, target)
    expect(untracked).toEqual([11])
  })

  it('watch が無ければ closeView は何もしない (省略した呼び出し元を壊さない)', () => {
    const v = new ViewerBroker({ broker, audit, scope: { rules }, resolveViewer })
    expect(() => v.closeView(1)).not.toThrow()
  })
})
