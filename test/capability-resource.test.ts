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

describe('A-4: aios-res:// is served by token', () => {
  it('the URL is aios-res://local/<token>/<name> and contains no path', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    const url = broker.resourceUrlFor(IMAGE, uri('pics', 'a.png'))
    expect(url.startsWith('aios-res://local/')).toBe(true)
    expect(url.endsWith('/a.png')).toBe(true)
    expect(url).not.toContain(root.slice(1))
    expect(RESOURCE_TOKEN_PATTERN.test(tokenOf(url))).toBe(true)
    expect(drain(tokenOf(url)).equals(readFileSync(file('pics', 'a.png')))).toBe(true)
    viewer.close(IMAGE, uri('pics', 'a.png'))
  })

  it('does not issue a URL for a URI that is not open', () => {
    expect(() => broker.resourceUrlFor(IMAGE, uri('pics', 'b.png'))).toThrow('no-grant')
  })

  it('returns the same token while the grant lasts (redraws and range requests come back for it many times)', () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    const first = broker.resourceUrlFor(IMAGE, uri('pics', 'a.png'))
    expect(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png'))).toBe(first)
    viewer.close(IMAGE, uri('pics', 'a.png'))
  })

  it('**a different plugin gets a different token even for the same file**; closing one leaves the other alive', () => {
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

  it('does not serve an unknown token or a malformed URL', () => {
    expect(() => broker.openResource('0'.repeat(32))).toThrow('unknown-token')
    // The old format (a URL that carries the path as is) is not read as a token.
    expect(resourceTokenOf(`aios-res://local${file('pics', 'a.png')}`)).toBeNull()
    expect(resourceTokenOf('aios-res://local/ABC/a.png')).toBeNull()
    expect(resourceTokenOf('aios-res://other/' + 'a'.repeat(32) + '/x')).toBeNull()
    expect(resourceTokenOf(tokenResourceUrl('f'.repeat(32), 'a b.png'))).toBe('f'.repeat(32))
  })

  it('does not serve an issued token once the plugin is disabled (its policy is gone)', () => {
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

  it('does not serve after the file is swapped for a symlink following issue (realpath again at serve time)', () => {
    const swap = file('pics', 'swap.png')
    writeFileSync(swap, Buffer.from([0x89, 0x50]))
    broker.grantOpen(IMAGE, pathToUri(swap))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, pathToUri(swap)))
    rmSync(swap)
    symlinkSync(file('secret', 'key.txt'), swap)
    expect(() => broker.openResource(token)).toThrow('symlink-escape')
    viewer.close(IMAGE, pathToUri(swap))
  })

  it('serving leaves fs / resource entries in the audit (for both allows and denials)', () => {
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

describe("TODO 550: aios-res:// for the app's own images (images sent from the timeline)", () => {
  it('an image gets a URL even when not open in a viewer, the same URI gets the same token, and serving returns the bytes themselves', () => {
    const url = broker.hostImageUrlFor(uri('pics', 'b.png'))
    expect(url.endsWith('/b.png')).toBe(true)
    expect(url).not.toContain(root.slice(1))
    expect(broker.hostImageUrlFor(uri('pics', 'b.png'))).toBe(url)
    expect(drain(tokenOf(url)).equals(readFileSync(file('pics', 'b.png')))).toBe(true)
    // It is not mixed with the plugin's permissions (a URL for b.png does not appear in the image viewer).
    expect(() => broker.resourceUrlFor(IMAGE, uri('pics', 'b.png'))).toThrow('no-grant')
  })

  it('does not issue for non-images, excluded files or missing files; the ViewerBroker entry point returns null', () => {
    expect(() => broker.hostImageUrlFor(uri('secret', 'key.txt'))).toThrow('not-image')
    expect(() => broker.hostImageUrlFor(uri('pics', 'gone.png'))).toThrow()
    expect(() => broker.hostImageUrlFor(pathToUri(join(homedir(), '.ssh', 'id.png')))).toThrow()
    expect(viewer.hostImageUrl(uri('secret', 'key.txt'))).toBeNull()
    expect(viewer.hostImageUrl(uri('pics', 'a.png'))).toMatch(/^aios-res:\/\/local\//)
  })

  it('refuses at every serve a secret named like an image through a symlink (the target hits an exclusion)', () => {
    // After TODO 590, a symlink itself is followed too if its target is not excluded, so a target that is not caught by an exclusion
    // (for example secret/key.txt) gets delivered (a default I decided myself, the same thinking as 558). To try the refusal form, use a target
    // whose name is caught by an exclusion (id_rsa etc., 'credentials-or-noise' at any level).
    writeFileSync(file('secret', 'id_rsa'), 'TOP SECRET KEY')
    symlinkSync(file('secret', 'id_rsa'), file('pics', 'disguised.png'))
    const url = viewer.hostImageUrl(uri('pics', 'disguised.png'))
    if (url !== null) expect(() => drain(tokenOf(url))).toThrow()
  })

  it("TODO 590: serves a symlink's own image (when the target is not excluded)", () => {
    const link = file('pics', 'host-link.png')
    symlinkSync(file('pics', 'a.png'), link)
    const url = viewer.hostImageUrl(uri('pics', 'host-link.png'))
    expect(url).not.toBeNull()
    expect(drain(tokenOf(url ?? '')).equals(readFileSync(file('pics', 'a.png')))).toBe(true)
  })
})

describe('TODO 876: local images inside an answer (timelineImageUrl)', () => {
  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

  it('issues only for files that start as an image, and serving returns the bytes themselves', () => {
    writeFileSync(file('pics', 'real.png'), PNG_HEAD)
    const url = viewer.timelineImageUrl(uri('pics', 'real.png'))
    expect(url).toMatch(/^aios-res:\/\/local\//)
    expect(drain(tokenOf(url ?? '')).equals(PNG_HEAD)).toBe(true)
  })

  it('TODO 879: issues svg / bmp / avif too when the content is an image; does not issue other content that merely has the svg extension', () => {
    writeFileSync(file('pics', 'a.svg'), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(viewer.timelineImageUrl(uri('pics', 'a.svg'))).toMatch(/^aios-res:\/\/local\//)
    writeFileSync(file('pics', 'a.bmp'), Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)]))
    expect(viewer.timelineImageUrl(uri('pics', 'a.bmp'))).toMatch(/^aios-res:\/\/local\//)
    writeFileSync(file('pics', 'a.avif'), Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]))
    expect(viewer.timelineImageUrl(uri('pics', 'a.avif'))).toMatch(/^aios-res:\/\/local\//)
    writeFileSync(file('pics', 'fake.svg'), 'password=hunter2')
    expect(viewer.timelineImageUrl(uri('pics', 'fake.svg'))).toBeNull()
  })

  it('does not issue for text or credentials merely named .png (magic bytes)', () => {
    writeFileSync(file('pics', 'fake.png'), 'not an image at all')
    expect(viewer.timelineImageUrl(uri('pics', 'fake.png'))).toBeNull()
  })

  it('returns null for non-image extensions, excluded files and missing files', () => {
    expect(viewer.timelineImageUrl(uri('secret', 'key.txt'))).toBeNull()
    expect(viewer.timelineImageUrl(pathToUri(join(homedir(), '.ssh', 'id.png')))).toBeNull()
    expect(viewer.timelineImageUrl(uri('pics', 'gone.png'))).toBeNull()
  })

  it('returns null for a symlink to an excluded target, and issues for a symlink to an image that is not excluded', () => {
    writeFileSync(file('secret', 'id_rsa'), PNG_HEAD)
    symlinkSync(file('secret', 'id_rsa'), file('pics', 'sneaky.png'))
    expect(viewer.timelineImageUrl(uri('pics', 'sneaky.png'))).toBeNull()
    writeFileSync(file('pics', 'target.png'), PNG_HEAD)
    symlinkSync(file('pics', 'target.png'), file('pics', 'ok-link.png'))
    expect(viewer.timelineImageUrl(uri('pics', 'ok-link.png'))).not.toBeNull()
  })
})

describe('D-3: returns the grant when closed (counted per window)', () => {
  it('a closed URI cannot be read and its token disappears too', async () => {
    viewer.open(uri('pics', 'a.png'))
    const read = await viewer.read(IMAGE, uri('pics', 'a.png'))
    expect(read.kind).toBe('binary')
    const token = tokenOf(read.kind === 'binary' ? read.resourceUrl : '')
    viewer.close(IMAGE, uri('pics', 'a.png'))
    expect(() => broker.openResource(token)).toThrow('unknown-token')
    expect((await viewer.read(IMAGE, uri('pics', 'a.png'))).kind).toBe('error')
  })

  it('when open in two windows, closing one keeps it and closing the second removes it', async () => {
    viewer.open(uri('pics', 'note.txt'))
    viewer.open(uri('pics', 'note.txt'))
    viewer.close(TEXT, uri('pics', 'note.txt'))
    expect((await viewer.read(TEXT, uri('pics', 'note.txt'))).kind).toBe('text')
    viewer.close(TEXT, uri('pics', 'note.txt'))
    expect((await viewer.read(TEXT, uri('pics', 'note.txt'))).kind).toBe('error')
  })

  it('closing a URI that is not open or a broken URI does nothing', () => {
    expect(() => viewer.close(TEXT, uri('pics', 'nothing.txt'))).not.toThrow()
    expect(() => viewer.close(TEXT, 'not a uri')).not.toThrow()
    expect(() => viewer.close('no.such.plugin', uri('pics', 'note.txt'))).not.toThrow()
  })

  it('the cap on missed closes is 16, and the tokens of pushed-out grants disappear too', () => {
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

  it("revokeOpen without a uri drops all of that plugin's grants and tokens", () => {
    broker.grantOpen(IMAGE, uri('pics', 'a.png'))
    broker.grantOpen(IMAGE, uri('pics', 'b.png'))
    const a = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'a.png')))
    const b = tokenOf(broker.resourceUrlFor(IMAGE, uri('pics', 'b.png')))
    broker.revokeOpen(IMAGE)
    expect(() => broker.openResource(a)).toThrow('unknown-token')
    expect(() => broker.openResource(b)).toThrow('unknown-token')
  })
})

describe('C-2: the viewer manifest decides whether to hand over by URL', () => {
  it('returns resourceUrl even for a binary (PDF) to a viewer that takes URLs (it used to be a binary error)', async () => {
    viewer.open(uri('pics', 'doc.pdf'))
    const resource = await viewer.read(IMAGE, uri('pics', 'doc.pdf'))
    expect(resource.kind).toBe('binary')
    if (resource.kind === 'binary') {
      expect(resource.size).toBe(statSync(file('pics', 'doc.pdf')).size)
      expect(drain(tokenOf(resource.resourceUrl)).toString('latin1')).toContain('%PDF')
    }
    viewer.close(IMAGE, uri('pics', 'doc.pdf'))
  })

  it('returns the body to a text viewer', async () => {
    viewer.open(uri('pics', 'note.txt'))
    const resource = await viewer.read(TEXT, uri('pics', 'note.txt'))
    expect(resource).toMatchObject({ kind: 'text', text: 'hello\n', truncated: false })
    viewer.close(TEXT, uri('pics', 'note.txt'))
  })

  it('does not use a URL when a plugin other than the resolved viewer reads (decided on the text path)', async () => {
    broker.grantOpen(TEXT, uri('pics', 'a.png'))
    const resource = await viewer.read(TEXT, uri('pics', 'a.png'))
    // A PNG is not passed to the text viewer (it contains NUL, so it is a binary error).
    expect(resource).toEqual({ kind: 'error', message: 'binary' })
    viewer.close(TEXT, uri('pics', 'a.png'))
  })

  it('PluginHost resolution: only a viewer that claims the extension and does not edit gets a url', async () => {
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
      // TODO 1280 review: a URI that is not a file and whose scheme nobody declares has no viewer (not the text fallback, not an extension match on its path).
      expect(plugins.resolveViewer('thread://abc')).toBeNull()
      expect(plugins.resolveViewer('https://example.com/x.pdf')).toBeNull()
      expect(plugins.resolveViewerWith('https://example.com/x.pdf', 'aios.pdf')).toBeNull()
    } finally {
      memory.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('D-5 / HTTP shape of serving (resource.ts)', () => {
  it('Range: accepts only a single range', () => {
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

  it('response headers: length, range, nosniff, no caching, CORS', () => {
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

  it('SVG gets a CSP that runs no script even when opened as a document', () => {
    expect(resourceHeaders('/x/a.svg', 1, null)['content-security-policy']).toContain("default-src 'none'")
    expect(resourceHeaders('/x/a.svg', 1, null)['content-security-policy']).toContain("script-src 'none'")
    expect(resourceHeaders('/x/a.svg', 1, null)['content-type']).toBe('image/svg+xml')
    expect(resourceHeaders('/x/a.png', 1, null)['content-security-policy']).toBeUndefined()
  })

  it('Content-Type comes from the extension (octet-stream when unknown)', () => {
    expect(resourceContentType('/a/b.PNG')).toBe('image/png')
    expect(resourceContentType('/a/b.pdf')).toBe('application/pdf')
    expect(resourceContentType('/a/b.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(resourceContentType('/a/b.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(resourceContentType('/a/b.exe')).toBe('application/octet-stream')
  })

  it('Content-Type for video (TODO 405, aios.video); avi cannot play in Chromium but its serving type is still given', () => {
    expect(resourceContentType('/a/b.mp4')).toBe('video/mp4')
    expect(resourceContentType('/a/b.M4V')).toBe('video/x-m4v')
    expect(resourceContentType('/a/b.mov')).toBe('video/quicktime')
    expect(resourceContentType('/a/b.webm')).toBe('video/webm')
    expect(resourceContentType('/a/b.avi')).toBe('video/x-msvideo')
  })

  it('Content-Type for audio (TODO 1271, aios.video)', () => {
    expect(resourceContentType('/a/b.wav')).toBe('audio/wav')
    expect(resourceContentType('/a/b.MP3')).toBe('audio/mpeg')
    expect(resourceContentType('/a/b.m4a')).toBe('audio/mp4')
    expect(resourceContentType('/a/b.ogg')).toBe('audio/ogg')
    expect(resourceContentType('/a/b.flac')).toBe('audio/flac')
  })

  it('openResource returns only the fd and the size and does not read the body (the size comes from fstat)', () => {
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

describe('TODO 851: text that is not UTF-8 is read-only', () => {
  it('Shift_JIS bytes are readOnly (no write back)', async () => {
    const target = file('pics', 'sjis.txt')
    writeFileSync(target, Buffer.from([0x82, 0xa0, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('does not count as invalid a truncation that cuts in the middle of a character at the end', async () => {
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

  it('valid UTF-8 Japanese can be edited (no readOnly)', async () => {
    const target = file('pics', 'utf8-ja.txt')
    writeFileSync(target, 'こんにちは\n')
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read.kind).toBe('text')
    expect('readOnly' in read).toBe(false)
    viewer.close(TEXT, pathToUri(target))
  })
})

describe('TODO 1215: hands over non-UTF-8 Japanese text as readable characters (still read-only)', () => {
  // Shift_JIS of two kanji, a comma, one hiragana, then CRLF (the form of a CSV that Excel writes).
  const SJIS = [0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x82, 0xa0, 0x0d, 0x0a]
  // EUC-JP of two kanji, a comma, one hiragana, then LF.
  const EUC = [0xc5, 0xec, 0xb5, 0xfe, 0x2c, 0xa4, 0xa2, 0x0a]

  it('a Shift_JIS CSV is read as Shift_JIS and stays readOnly', async () => {
    const target = file('pics', 'sjis.csv')
    writeFileSync(target, Buffer.from(SJIS))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: '東京,あ\r\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('does not mistake Shift_JIS without kana (kanji only) for EUC-JP C1 control characters', async () => {
    // Two kanji then LF. ICU's EUC-JP turns 0x93 and similar into U+0093 without reporting an error, so it is refused here and passed on to Shift_JIS.
    const target = file('pics', 'sjis-kanji.txt')
    writeFileSync(target, Buffer.from([0x93, 0x8c, 0x8b, 0x9e, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: '東京\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('reads EUC-JP as EUC-JP (does not mistake it for Shift_JIS half-width kana)', async () => {
    const target = file('pics', 'euc.txt')
    writeFileSync(target, Buffer.from(EUC))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: '東京,あ\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('even when the truncation cuts in the middle of a Shift_JIS character at the end, drops the broken character and reads', async () => {
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

  it('does not mistake half-width-kana-only Shift_JIS ("ﾌﾘｺﾐ,100") for EUC-JP kanji (code-review Y4)', async () => {
    const target = file('pics', 'sjis-hwkana.csv')
    writeFileSync(target, Buffer.from([0xcc, 0xd8, 0xba, 0xd0, 0x2c, 0x31, 0x30, 0x30, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: 'ﾌﾘｺﾐ,100\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })

  it('leaves GBK text as U+FFFD instead of turning it into random kanji (code-review Y4)', async () => {
    const target = file('pics', 'gbk.csv')
    writeFileSync(target, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7]))
    viewer.open(pathToUri(target))
    const read = (await viewer.read(TEXT, pathToUri(target))) as { text?: string; readOnly?: boolean }
    expect(read.readOnly).toBe(true)
    expect(read.text).toContain('\ufffd')
    viewer.close(TEXT, pathToUri(target))
  })

  it('reads UTF-8 as UTF-8 as before and can write it back (no invalidUtf8)', async () => {
    const target = file('pics', 'utf8.csv')
    writeFileSync(target, '東京,あ\n', 'utf8')
    viewer.open(pathToUri(target))
    const read = (await viewer.read(TEXT, pathToUri(target))) as { text?: string; readOnly?: boolean }
    expect(read.text).toBe('東京,あ\n')
    expect(read.readOnly).not.toBe(true)
    viewer.close(TEXT, pathToUri(target))
  })

  it('replaces bytes readable as neither (Latin-1) with U+FFFD as before', async () => {
    const target = file('pics', 'latin1.txt')
    writeFileSync(target, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x21, 0x0a]))
    viewer.open(pathToUri(target))
    const read = await viewer.read(TEXT, pathToUri(target))
    expect(read).toMatchObject({ kind: 'text', text: 'caf\ufffd !\n', readOnly: true })
    viewer.close(TEXT, pathToUri(target))
  })
})

describe('ViewerBroker.write (review chapter 7: it had no direct test)', () => {
  it('can write to an open URI, and a long existing tail is truncated', async () => {
    const target = file('pics', 'edit.txt')
    writeFileSync(target, 'a long original body\n')
    viewer.open(pathToUri(target))
    const before = statSync(target).mtimeMs
    const result = await viewer.write(TEXT, pathToUri(target), 'short\n', before)
    expect(result).toMatchObject({ ok: true, reason: null, size: 6 })
    expect(readFileSync(target, 'utf8')).toBe('short\n')
    viewer.close(TEXT, pathToUri(target))
  })

  it('TODO 1073: does not close the fd twice even if audit throws after writing (returns io without throwing EBADF)', async () => {
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

  it('**TODO 853: keeps looping until everything is written even when a short write returns**', async () => {
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

  it('**TODO 853: does not return ok when not a single byte could be written (io)**', async () => {
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

  it('**TODO 853: the mtime of a read comes from the same fd as the body** (the broker read returns mtimeMs and the viewer uses it)', async () => {
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

  it('when mtime differs, returns conflict without writing (it was rewritten outside)', async () => {
    const target = file('pics', 'conflict.txt')
    writeFileSync(target, 'disk\n')
    viewer.open(pathToUri(target))
    const result = await viewer.write(TEXT, pathToUri(target), 'mine\n', statSync(target).mtimeMs - 5000)
    expect(result.reason).toBe('conflict')
    expect(readFileSync(target, 'utf8')).toBe('disk\n')
    viewer.close(TEXT, pathToUri(target))
  })

  it('cannot write to a URI that is not open (denied); the same after closing', async () => {
    const target = file('pics', 'closed.txt')
    writeFileSync(target, 'x')
    expect((await viewer.write(TEXT, pathToUri(target), 'y', null)).reason).toBe('denied')
    viewer.open(pathToUri(target))
    viewer.close(TEXT, pathToUri(target))
    expect((await viewer.write(TEXT, pathToUri(target), 'y', null)).reason).toBe('denied')
    expect(readFileSync(target, 'utf8')).toBe('x')
  })

  it('**does not write when swapped for a symlink pointing outside after opening** (realpath + O_NOFOLLOW)', async () => {
    const target = file('pics', 'link.txt')
    writeFileSync(target, 'x')
    viewer.open(pathToUri(target))
    rmSync(target)
    symlinkSync(file('secret', 'key.txt'), target)
    expect((await viewer.write(TEXT, pathToUri(target), 'pwned', null)).reason).toBe('denied')
    expect(readFileSync(file('secret', 'key.txt'), 'utf8')).toBe('TOP SECRET')
    viewer.close(TEXT, pathToUri(target))
  })

  it('a vanished file is not-found, and a body over the limit is too-large', async () => {
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

  it('**TODO 558: opening a symlinked file can read it, and saving writes to the target** (the link stays a link)', async () => {
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

  it('**TODO 558: when the link is repointed elsewhere after opening, does not read or write** (the target is the one at open time)', async () => {
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

  it('**TODO 558: can also read a file whose middle component is a symlink (inside a linked folder)**; no heading annotation is added', async () => {
    const dirLink = file('pics-link')
    symlinkSync(file('pics'), dirLink)
    const uri = pathToUri(join(dirLink, 'note.txt'))
    const opened = viewer.open(uri)
    expect(opened?.linkTargetUri).toBeUndefined()
    expect(await viewer.read(TEXT, uri)).toMatchObject({ kind: 'text', text: 'hello\n' })
    viewer.close(TEXT, uri)
  })

  it('**TODO 558: a symlinked image is served by URL** (serving also covers the target at open time)', () => {
    const link = file('pics', 'a-link.png')
    symlinkSync(file('pics', 'a.png'), link)
    broker.grantOpen(IMAGE, pathToUri(link))
    const token = tokenOf(broker.resourceUrlFor(IMAGE, pathToUri(link)))
    expect(drain(token).equals(readFileSync(file('pics', 'a.png')))).toBe(true)
    viewer.close(IMAGE, pathToUri(link))
  })

  it('writes leave audit entries for both allows and denials', async () => {
    audit.flush()
    const writes = audit.recent(200).filter((entry) => entry.op === 'write')
    expect(writes.some((e) => e.decision === 'allow')).toBe(true)
    expect(writes.some((e) => e.decision === 'deny' && e.reason === 'conflict')).toBe(true)
  })
})

describe('TODO 673: passing viewId calls watch.track / watch.settle (not called when omitted)', () => {
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

  it("passing viewId to read (text) tracks it by the target's canonical path", async () => {
    const { viewer: v, tracked } = withWatch()
    const target = uri('pics', 'note.txt')
    v.open(target)
    const result = await v.read(TEXT, target, 7)
    if (result.kind !== 'text') throw new Error('expected text')
    expect(tracked).toEqual([{ viewId: 7, uri: target, path: file('pics', 'note.txt'), mtimeMs: result.mtimeMs, size: result.size }])
    v.close(TEXT, target)
  })

  it('the same applies to read (binary = URL handoff)', async () => {
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
  it('withCacheBust: the same URL gets a different query when mtime differs (resourceTokenOf can pick out the token)', () => {
    const a = withCacheBust('aios-res://local/abc123/pic.png', 1000.4)
    const b = withCacheBust('aios-res://local/abc123/pic.png', 2000)
    expect(a).not.toBe(b)
    expect(a).toBe('aios-res://local/abc123/pic.png?m=1000')
  })

  it('the resourceUrl returned by read (binary) carries an mtime query', async () => {
    const { viewer: v } = withWatch()
    const target = uri('pics', 'a.png')
    v.open(target)
    const result = await v.read(IMAGE, target, 10)
    if (result.kind !== 'binary') throw new Error('expected binary')
    expect(result.resourceUrl).toMatch(/\?m=\d+$/)
    v.close(IMAGE, target)
  })

  it('omitting viewId does not track (existing callers are unaffected)', async () => {
    const { viewer: v, tracked } = withWatch()
    const target = uri('pics', 'note.txt')
    v.open(target)
    await v.read(TEXT, target)
    expect(tracked).toEqual([])
    v.close(TEXT, target)
  })

  it('a successful write settles by viewId (not called on conflict or failure)', async () => {
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
  it('closeView(viewId) calls watch.untrack (a separate entry point from the probe close in 471)', async () => {
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

  it('without a watch, closeView does nothing (does not break callers that omitted it)', () => {
    const v = new ViewerBroker({ broker, audit, scope: { rules }, resolveViewer })
    expect(() => v.closeView(1)).not.toThrow()
  })
})
