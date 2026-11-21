/**
 * Preparation for Phase 5 (review of 2026-09-21 C-1 / C-3 / A-3, ARCHITECTURE.md 7.7).
 *
 * - C-1: the Broker's `fs.read` can return binary contents (`encoding: 'bytes'`), and range reads (`offset` / `length`)
 * - C-3: the `net.fetch` response is a byte sequence (the limit is also counted in bytes)
 * - A-3: requests from plugin-host are validated with zod, and ones that fail remain in the audit as `invalid-request`
 *
 * The tree is built under home (`os.tmpdir()` falls under the exclusion, a Phase 1 pitfall).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { auditLabel, parseBrokerRequest } from '../src/main/capability/request-schema.js'
import { brokeredFetch, standaloneBytes, type NetTransport } from '../src/main/capability/network.js'
import { MAX_RESPONSE_BYTES } from '../src/main/capability/net-policy.js'
import {
  MAX_PLUGIN_READ_BYTES,
  MAX_PLUGIN_READ_CHUNK_BYTES,
  type BrokerFsReadResult,
  type CapabilityName
} from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

let root: string
let dbDir: string
let db: Db
let audit: AuditLog
let broker: CapabilityBroker
let sent: { body: string | Uint8Array | null }[] = []

const PLUGIN = 'test.bytes'
/** PDF-like contents: ASCII at the head, with NUL and 0xff in the middle. */
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from([0x00, 0xff, 0x10, 0x80]),
  Buffer.alloc(3 * 1024 * 1024, 0x41),
  Buffer.from('%%EOF\n')
])

const policy: PluginPolicy = {
  id: PLUGIN,
  declared: {
    credentials: [],
    networkHosts: ['files.example.com'],
    fsRead: [],
    fsWrite: [],
    indexSources: [],
    ui: false
  },
  consented: new Set<CapabilityName>(['fs', 'network'])
}

/** A fake transport that returns a byte sequence containing 0x00 and 0xff on the first call. */
const transport: NetTransport = {
  async resolve() {
    return [{ address: '93.184.216.34', family: 4 }]
  },
  async send(_url, options) {
    sent.push({ body: options.body })
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array([0x25, 0x50, 0x00, 0xff, 0xfe]),
      truncated: false
    }
  }
}

beforeAll(() => {
  root = makeTestDir('bytes-test')
  dbDir = makeTestDir('bytes-db')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'a.pdf'), PDF)
  writeFileSync(join(root, 'docs', 'note.txt'), 'こんにちは\n')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'b'.repeat(64)}'`)
  runMigrations(db)
  audit = new AuditLog(db)
  broker = new CapabilityBroker({
    scope: { rules: testExclusions(homedir()) },
    audit,
    credentials: new CredentialStore(dbDir, {
      available: () => false,
      seal: () => Buffer.alloc(0),
      open: () => ''
    }),
    policyOf: (id) => (id === PLUGIN ? policy : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined,
    transport
  })
})

afterAll(() => {
  audit.dispose()
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

const pdfUri = (): string => pathToUri(join(root, 'docs', 'a.pdf'))

describe('C-1: fs.read returns bytes and ranges', () => {
  it('the default (utf8) is as before: text for text, no content for binary', async () => {
    broker.grantOpen(PLUGIN, pathToUri(join(root, 'docs', 'note.txt')))
    broker.grantOpen(PLUGIN, pdfUri())
    const text = (await broker.handle(PLUGIN, {
      capability: 'fs',
      op: 'read',
      uri: pathToUri(join(root, 'docs', 'note.txt'))
    })) as BrokerFsReadResult
    expect(text).toMatchObject({ kind: 'text', text: 'こんにちは\n', offset: 0, truncated: false })
    expect(text.data).toBeUndefined()

    const binary = (await broker.handle(PLUGIN, { capability: 'fs', op: 'read', uri: pdfUri() })) as BrokerFsReadResult
    expect(binary.kind).toBe('binary')
    expect(binary.text).toBeUndefined()
    expect(binary.data).toBeUndefined()
    // The default length is 2 MB. A PDF is 3 MB, so there is a continuation.
    expect(binary.length).toBe(MAX_PLUGIN_READ_BYTES)
    expect(binary.truncated).toBe(true)
    expect(binary.bytes).toBe(PDF.byteLength)
  })

  it('`bytes` returns the binary content as is in a Uint8Array (NUL / 0xff are not lost)', async () => {
    const result = (await broker.handle(PLUGIN, {
      capability: 'fs',
      op: 'read',
      uri: pdfUri(),
      encoding: 'bytes',
      length: 16
    })) as BrokerFsReadResult
    expect(result.data).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(result.data ?? []).equals(PDF.subarray(0, 16))).toBe(true)
    expect(result.kind).toBe('binary')
    expect(result.length).toBe(16)
  })

  it('joining ranged reads restores the original file (offset / length / truncated)', async () => {
    const parts: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const chunk = (await broker.handle(PLUGIN, {
        capability: 'fs',
        op: 'read',
        uri: pdfUri(),
        encoding: 'bytes',
        offset,
        length: 1024 * 1024
      })) as BrokerFsReadResult
      expect(chunk.offset).toBe(offset)
      parts.push(chunk.data ?? new Uint8Array())
      offset += chunk.length
      if (!chunk.truncated) break
    }
    expect(parts).toHaveLength(4)
    expect(Buffer.concat(parts).equals(PDF)).toBe(true)
  })

  it('an offset past the end returns 0 bytes (does not throw)', async () => {
    const result = (await broker.handle(PLUGIN, {
      capability: 'fs',
      op: 'read',
      uri: pdfUri(),
      encoding: 'bytes',
      offset: PDF.byteLength + 100
    })) as BrokerFsReadResult
    expect(result).toMatchObject({ offset: PDF.byteLength, length: 0, truncated: false })
    expect(result.data?.byteLength).toBe(0)
  })

  it('**the returned bytes have their own dedicated ArrayBuffer** (structured clone does not leak other values)', async () => {
    const small = (await broker.handle(PLUGIN, {
      capability: 'fs',
      op: 'read',
      uri: pdfUri(),
      encoding: 'bytes',
      length: 5
    })) as BrokerFsReadResult
    // The whole underlying ArrayBuffer is sent, not the view. If the sizes match, nothing extra is included.
    expect(small.data?.buffer.byteLength).toBe(5)
  })

  it('a length over the per-call limit fails shape validation', async () => {
    await expect(
      broker.handleUntrusted(PLUGIN, {
        capability: 'fs',
        op: 'read',
        uri: pdfUri(),
        encoding: 'bytes',
        length: MAX_PLUGIN_READ_CHUNK_BYTES + 1
      })
    ).rejects.toThrow('invalid-request')
  })

  it('a file without permission cannot be read even with bytes (the judgment is the same as utf8)', async () => {
    const other = join(root, 'docs', 'other.bin')
    writeFileSync(other, Buffer.from([1, 2, 3]))
    await expect(
      broker.handle(PLUGIN, { capability: 'fs', op: 'read', uri: pathToUri(other), encoding: 'bytes' })
    ).rejects.toThrow('no-grant')
  })
})

describe('C-3: the net.fetch response is bytes', () => {
  it('the body of a response through the Broker is a Uint8Array and NUL / 0xff arrive as is', async () => {
    const result = (await broker.handle(PLUGIN, {
      capability: 'network',
      op: 'fetch',
      url: 'https://files.example.com/a.pdf'
    })) as { body: Uint8Array; status: number }
    expect(result.status).toBe(200)
    expect(result.body).toBeInstanceOf(Uint8Array)
    expect([...result.body]).toEqual([0x25, 0x50, 0x00, 0xff, 0xfe])
  })

  it('bytes can be passed as the request body (upload)', async () => {
    sent = []
    await broker.handle(PLUGIN, {
      capability: 'network',
      op: 'fetch',
      url: 'https://files.example.com/upload',
      method: 'POST',
      body: new Uint8Array([0, 1, 2])
    })
    expect(sent[0]?.body).toBeInstanceOf(Uint8Array)
  })

  it('even if the transport does not enforce the limit, it is cut by bytes at the limit and truncated is set', async () => {
    const big: NetTransport = {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      send: async () => ({
        status: 200,
        headers: {},
        body: new Uint8Array(MAX_RESPONSE_BYTES + 10),
        truncated: false
      })
    }
    const result = await brokeredFetch(
      {
        url: 'https://files.example.com/big',
        method: 'GET',
        headers: {},
        body: null,
        allowedHosts: ['files.example.com'],
        credential: null
      },
      big
    )
    expect(result.body.byteLength).toBe(MAX_RESPONSE_BYTES)
    expect(result.truncated).toBe(true)
  })

  it('standaloneBytes makes an ArrayBuffer of its own from a Buffer of the shared pool', () => {
    // A small Buffer is a slice of the 8 KB shared pool (Node's default).
    const pooled = Buffer.from('secret-free')
    const out = standaloneBytes(pooled)
    expect(Buffer.from(out).toString()).toBe('secret-free')
    expect(out.buffer.byteLength).toBe(out.byteLength)
  })
})

describe('A-3: shape validation of requests from the plugin-host', () => {
  const valid = [
    { capability: 'fs', op: 'read', uri: 'file:///Users/x/a.txt' },
    { capability: 'fs', op: 'read', uri: 'file:///Users/x/a.pdf', encoding: 'bytes', offset: 0, length: 1024 },
    {
      capability: 'network',
      op: 'fetch',
      url: 'https://x.example.com/',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      auth: 'google:gmail'
    },
    { capability: 'credentials', op: 'status', name: 'google:gmail' },
    {
      capability: 'index',
      op: 'put',
      document: { source: 'gmail', sourceId: 'm1', title: '件名', uri: 'gmail://m1', body: '本文', updatedAt: 1 }
    },
    { capability: 'index', op: 'remove', source: 'gmail', sourceId: 'm1' },
    { capability: 'ui', op: 'notify', title: '同期しました' }
  ]
  for (const request of valid) {
    it(`passes: ${request.capability}.${request.op}`, () => {
      expect(parseBrokerRequest(request)).not.toBeNull()
    })
  }

  const invalid: readonly [string, unknown][] = [
    ['uri が文字列でない', { capability: 'fs', op: 'read', uri: 42 }],
    ['知らない鍵', { capability: 'fs', op: 'read', uri: 'file:///a', extra: true }],
    ['知らない encoding', { capability: 'fs', op: 'read', uri: 'file:///a', encoding: 'latin1' }],
    ['負の offset', { capability: 'fs', op: 'read', uri: 'file:///a', offset: -1 }],
    ['headers が配列', { capability: 'network', op: 'fetch', url: 'https://x/', headers: ['a'] }],
    ['ヘッダ値に改行 (差し込み)', { capability: 'network', op: 'fetch', url: 'https://x/', headers: { a: 'b\r\nx: y' } }],
    ['ヘッダ名に空白', { capability: 'network', op: 'fetch', url: 'https://x/', headers: { 'a b': 'c' } }],
    ['知らないメソッド', { capability: 'network', op: 'fetch', url: 'https://x/', method: 'CONNECT' }],
    [
      'document に知らない鍵',
      {
        capability: 'index',
        op: 'put',
        document: { source: 's', sourceId: 'i', title: 't', uri: 'u', body: 'b', sql: 'x' }
      }
    ],
    ['知らない能力', { capability: 'shell', op: 'run', command: 'ls' }],
    ['題名が長すぎる', { capability: 'ui', op: 'notify', title: 'x'.repeat(300) }],
    ['null', null],
    ['文字列', 'fs.read']
  ]
  for (const [label, raw] of invalid) {
    it(`rejects: ${label}`, () => {
      expect(parseBrokerRequest(raw)).toBeNull()
    })
  }

  it('a rejected one is left in the audit as `invalid-request`, and only a short lowercase word is copied as the capability name', async () => {
    await expect(broker.handleUntrusted(PLUGIN, { capability: 'fs', op: 'read', uri: 7 })).rejects.toThrow(
      'invalid-request'
    )
    await expect(
      broker.handleUntrusted(PLUGIN, { capability: 'DROP TABLE audit_log', op: {} })
    ).rejects.toThrow('invalid-request')
    audit.flush()
    const denied = audit.recent(50, PLUGIN).filter((entry) => entry.reason === 'invalid-request')
    expect(denied.map((entry) => `${entry.capability}.${entry.op}`)).toEqual(
      expect.arrayContaining(['fs.read', 'invalid.invalid'])
    )
    expect(denied.every((entry) => entry.decision === 'deny' && entry.target === null)).toBe(true)
  })

  it("a request that passes goes on to the judgment as is (declaration, consent, and policy remain the Broker's job)", async () => {
    await expect(
      broker.handleUntrusted(PLUGIN, { capability: 'ui', op: 'notify', title: 'x' })
    ).rejects.toThrow('not-consented')
  })

  it('auditLabel falls to invalid for values of the wrong shape', () => {
    expect(auditLabel({ capability: 'fs' }, 'capability')).toBe('fs')
    expect(auditLabel({ capability: 'Fs' }, 'capability')).toBe('invalid')
    expect(auditLabel({ capability: 'x'.repeat(40) }, 'capability')).toBe('invalid')
    expect(auditLabel(undefined, 'op')).toBe('invalid')
  })
})
