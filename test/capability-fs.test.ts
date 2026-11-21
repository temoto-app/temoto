/**
 * The fs capability and path checks of CapabilityBroker (ARCHITECTURE.md 7.7, the homework of 12.4 / 12.8).
 *
 * One of the two tests that IMPLEMENTATION_BRIEF chapter 7 makes **mandatory**.
 * **It must always include a case where a symlink points outside the allowed range.**
 *
 * On macOS `os.tmpdir()` is `/var/folders/...`, which falls under the exclusions of 4.4.2,
 * so the tree is built under home (the Phase 1 pitfall in CLAUDE.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { createMacosExclusions } from '../src/common/exclusions.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { PathDenied, openChecked, resolvePath, withinDirectory } from '../src/common/fs-policy.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

const KEY = 'c'.repeat(64)
let root: string
let dbDir: string
let db: Db
let broker: CapabilityBroker
let audit: AuditLog

const rules = testExclusions(homedir())

/** A plugin that holds only the declared range. Consent is attached to all capabilities. */
function policy(overrides: Partial<PluginPolicy['declared']> = {}): PluginPolicy {
  return {
    id: 'test.plugin',
    declared: {
      credentials: [],
      networkHosts: [],
      fsRead: [],
      fsWrite: [],
      indexSources: [],
      ui: false,
      ...overrides
    },
    consented: new Set<CapabilityName>(['fs', 'network', 'credentials', 'index', 'ui'])
  }
}

let currentPolicy: PluginPolicy = policy()

beforeAll(() => {
  root = makeTestDir('cap-test')
  dbDir = makeTestDir('cap-db')
  mkdirSync(join(root, 'allowed'), { recursive: true })
  mkdirSync(join(root, 'secret'), { recursive: true })
  writeFileSync(join(root, 'allowed', 'note.txt'), 'こんにちは\n')
  writeFileSync(join(root, 'allowed', 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]))
  writeFileSync(join(root, 'secret', 'key.txt'), 'TOP SECRET')
  // A symlink inside the allowed range that points outside (the case 7.7 requires refusal for).
  symlinkSync(join(root, 'secret', 'key.txt'), join(root, 'allowed', 'escape.txt'))
  // A symlink that stays entirely within the allowed range. This one may be read.
  symlinkSync(join(root, 'allowed', 'note.txt'), join(root, 'allowed', 'inside.txt'))

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${KEY}'`)
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
    policyOf: (id) => (id === 'test.plugin' ? currentPolicy : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
})

afterAll(() => {
  audit.dispose()
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

const read = (uri: string): Promise<unknown> =>
  broker.handle('test.plugin', { capability: 'fs', op: 'read', uri })

describe('パス検査 (7.7)', () => {
  it('宣言も許可も無ければ読めない', async () => {
    currentPolicy = policy()
    await expect(read(pathToUri(join(root, 'allowed', 'note.txt')))).rejects.toThrow('no-grant')
  })

  it('ユーザが開いた URI は読める (7.2 の暗黙の許可)', async () => {
    currentPolicy = policy()
    const uri = pathToUri(join(root, 'allowed', 'note.txt'))
    broker.grantOpen('test.plugin', uri)
    const result = (await read(uri)) as { kind: string; text: string }
    expect(result.kind).toBe('text')
    expect(result.text).toContain('こんにちは')
  })

  it('開いた URI 以外は、同じディレクトリでも読めない', async () => {
    currentPolicy = policy()
    broker.grantOpen('test.plugin', pathToUri(join(root, 'allowed', 'note.txt')))
    await expect(read(pathToUri(join(root, 'secret', 'key.txt')))).rejects.toThrow()
  })

  it('マニフェストで宣言した範囲は読める', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    const result = (await read(pathToUri(join(root, 'allowed', 'note.txt')))) as { kind: string }
    expect(result.kind).toBe('text')
  })

  it('宣言した範囲の外は読めない', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    await expect(read(pathToUri(join(root, 'secret', 'key.txt')))).rejects.toThrow('outside-grant')
  })

  it('**許可範囲の中の symlink が外を指していれば拒否する**', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    // The logical path is inside the allowed range, but the actual file is secret/key.txt outside the range.
    await expect(read(pathToUri(join(root, 'allowed', 'escape.txt')))).rejects.toThrow(
      'symlink-escape'
    )
  })

  it('許可範囲の中で完結する symlink は読める', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    const result = (await read(pathToUri(join(root, 'allowed', 'inside.txt')))) as {
      kind: string
      text: string
    }
    expect(result.text).toContain('こんにちは')
  })

  it('**TODO 558: ユーザが開いた symlink は、実体が除外でなければ範囲の外を指していても読める**', async () => {
    // A route separate from the declared range (the two above): permission for an "opened URI" covers the actual target as of the time it was opened.
    currentPolicy = policy()
    const uri = pathToUri(join(root, 'allowed', 'escape.txt'))
    broker.grantOpen('test.plugin', uri)
    try {
      const result = (await read(uri)) as { kind: string; text: string }
      expect(result.text).toBe('TOP SECRET')
      // Only the link was opened. The URI of the target itself was not opened, so it cannot be read.
      await expect(read(pathToUri(join(root, 'secret', 'key.txt')))).rejects.toThrow('no-grant')
    } finally {
      broker.revokeOpen('test.plugin', uri)
    }
  })

  it('**TODO 558: 除外を指す symlink は、開こうとしても許可にならない** (実体の再検査)', () => {
    currentPolicy = policy()
    // `.netrc` is excluded at any level (a credential file name). Even if the link's name is harmless, it is dropped by its target.
    writeFileSync(join(root, 'secret', '.netrc'), 'machine x login y password z')
    symlinkSync(join(root, 'secret', '.netrc'), join(root, 'allowed', 'harmless.txt'))
    expect(() =>
      broker.grantOpen('test.plugin', pathToUri(join(root, 'allowed', 'harmless.txt')))
    ).toThrow('symlink-escape')
  })

  it('**TODO 561: /tmp は利用者が開けば読めるが、plugin の宣言の範囲には効かない** (plugin の許可は変えない)', async () => {
    const tmp = mkdtempSync('/tmp/aios-561-broker-')
    try {
      writeFileSync(join(tmp, 'a.py'), 'print(1)\n')
      const uri = pathToUri(join(tmp, 'a.py'))
      currentPolicy = policy({ fsRead: [tmp] })
      await expect(read(uri)).rejects.toThrow('excluded')
      currentPolicy = policy()
      broker.grantOpen('test.plugin', uri)
      const result = (await read(uri)) as { text: string }
      expect(result.text).toBe('print(1)\n')
      broker.revokeOpen('test.plugin', uri)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('`..` で範囲の外に出られない', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    const escape = pathToUri(`${join(root, 'allowed')}/../secret/key.txt`)
    await expect(read(escape)).rejects.toThrow()
  })

  it('除外リストに当たるパスは、宣言しても許可しても読めない', async () => {
    currentPolicy = policy({ fsRead: [join(homedir(), '.ssh')] })
    await expect(read(pathToUri(join(homedir(), '.ssh', 'id_rsa')))).rejects.toThrow('excluded')
    // The same for the route "opened by the user".
    expect(() => broker.grantOpen('test.plugin', pathToUri(join(homedir(), '.ssh', 'config')))).toThrow()
  })

  it('file: 以外のスキームと相対パスを弾く', async () => {
    currentPolicy = policy()
    await expect(read('http://example.com/x')).rejects.toThrow('not-a-file-uri')
    await expect(read('thread://a/b')).rejects.toThrow('not-a-file-uri')
  })

  it('バイナリは text として返さない', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    const result = (await read(pathToUri(join(root, 'allowed', 'binary.bin')))) as { kind: string }
    expect(result.kind).toBe('binary')
  })

  it('ディレクトリは読めない', async () => {
    currentPolicy = policy({ fsRead: [root] })
    await expect(read(pathToUri(join(root, 'allowed')))).rejects.toThrow('directory')
  })

  it('同意が無ければ宣言があっても読めない (7.7 の 3 段判定)', async () => {
    currentPolicy = {
      ...policy({ fsRead: [join(root, 'allowed')] }),
      consented: new Set<CapabilityName>()
    }
    await expect(read(pathToUri(join(root, 'allowed', 'note.txt')))).rejects.toThrow('not-consented')
  })

  it('知らないプラグインは拒否する', async () => {
    await expect(
      broker.handle('unknown.plugin', {
        capability: 'fs',
        op: 'read',
        uri: pathToUri(join(root, 'allowed', 'note.txt'))
      })
    ).rejects.toThrow('unknown-plugin')
  })
})

describe('resolvePath そのもの', () => {
  it('canonical path を返し、論理パスも残す', () => {
    const resolved = resolvePath(join(root, 'allowed', 'inside.txt'), { rules }, false)
    expect(resolved.logical).toBe(join(root, 'allowed', 'inside.txt'))
    expect(resolved.canonical).toBe(join(root, 'allowed', 'note.txt'))
    expect(resolved.exists).toBe(true)
  })

  it('存在しないファイルでも親が解決できれば通る (書き込みの新規作成)', () => {
    const resolved = resolvePath(join(root, 'allowed', 'new.txt'), { rules }, false)
    expect(resolved.exists).toBe(false)
  })

  it('**TODO 861: 検査の後に途中のフォルダを symlink に差し替えられたら openChecked は changed**', () => {
    const base = join(root, 'swap')
    mkdirSync(join(base, 'granted', 'a'), { recursive: true })
    mkdirSync(join(base, 'secret'), { recursive: true })
    writeFileSync(join(base, 'granted', 'a', 'f.txt'), 'OK')
    writeFileSync(join(base, 'secret', 'f.txt'), 'SECRET')
    const resolved = resolvePath(join(base, 'granted', 'a', 'f.txt'), { roots: [join(base, 'granted')], rules }, false)
    renameSync(join(base, 'granted', 'a'), join(base, 'granted', 'a.old'))
    symlinkSync(join(base, 'secret'), join(base, 'granted', 'a'))
    expect(() => closeSync(openChecked(resolved, 0))).toThrow(/changed/)
  })

  it('除外パスは PathDenied を投げる', () => {
    expect(() => resolvePath(join(homedir(), '.aws', 'credentials'), { rules }, false)).toThrow(
      PathDenied
    )
  })
})

/**
 * Judgment of the approval rule's `scope: 'cwd'` (T26 / 4.2.1.2). **So that path normalization is not implemented separately on the approval side**,
 * the judgment lives in this module of 7.7. What is checked here is that
 * "outside is never called inside, with symlinks, `..`, case, or a nonexistent tail".
 */
describe('withinDirectory — 「作業フォルダの中か」 (T26 / 4.2.1.2)', () => {
  // `root` is decided in beforeAll, so it cannot be read in the describe body.
  let dir = ''
  beforeAll(() => {
    dir = join(root, 'allowed')
  })

  it('配下とディレクトリ自身は中', () => {
    expect(withinDirectory(join(dir, 'note.txt'), dir)).toBe(true)
    expect(withinDirectory(dir, dir)).toBe(true)
  })

  it('兄弟ディレクトリと、名前が前方一致するだけのものは外', () => {
    expect(withinDirectory(join(root, 'secret', 'key.txt'), dir)).toBe(false)
    // `allowed` and `allowed-2` share a prefix but are different directories (the separator is checked).
    expect(withinDirectory(`${dir}-2/x.txt`, dir)).toBe(false)
  })

  it('`..` は畳んでから見る', () => {
    expect(withinDirectory(join(dir, '..', 'secret', 'key.txt'), dir)).toBe(false)
    expect(withinDirectory(join(dir, 'sub', '..', 'note.txt'), dir)).toBe(true)
  })

  it('**中から外を指す symlink は外**。中で完結する symlink は中', () => {
    expect(withinDirectory(join(dir, 'escape.txt'), dir)).toBe(false)
    expect(withinDirectory(join(dir, 'inside.txt'), dir)).toBe(true)
  })

  it('**ぶら下がり symlink は外**に倒す (realpath が失敗する側の穴)', () => {
    const dangling = join(dir, 'dangling.txt')
    symlinkSync(join(root, 'secret', 'not-yet.txt'), dangling)
    try {
      // There is no real file, so realpath fails; but treated as a logical path it would look "inside".
      expect(withinDirectory(dangling, dir)).toBe(false)
    } finally {
      rmSync(dangling)
    }
  })

  it('これから作られるファイル (末尾が存在しない) は中と答える', () => {
    expect(withinDirectory(join(dir, 'new.txt'), dir)).toBe(true)
    expect(withinDirectory(join(dir, 'a', 'b', 'c.txt'), dir)).toBe(true)
  })

  it('**両辺を realpath する** (片側だけだと symlink 越しの同じ場所を外と言う)', () => {
    // Even when the allowed range itself is pointed to by a symlink, it is inside.
    const link = join(root, 'allowed-link')
    symlinkSync(dir, link)
    try {
      expect(withinDirectory(join(link, 'note.txt'), dir)).toBe(true)
      expect(withinDirectory(join(dir, 'note.txt'), link)).toBe(true)
    } finally {
      rmSync(link)
    }
  })

  it('大小の扱いはファイルシステムに任せる (`foldPath` で畳まない)', () => {
    // On a volume that does not distinguish case it is the same file, so inside; on one that distinguishes case it is
    // a different nonexistent path, so outside. **Either way it matches "whether it is actually that file".**
    const upper = join(root, 'ALLOWED', 'note.txt')
    expect(withinDirectory(upper, dir)).toBe(existsSync(upper))
  })

  it('相対パスは判定しない (外に倒す)', () => {
    expect(withinDirectory('note.txt', dir)).toBe(false)
    expect(withinDirectory(join(dir, 'note.txt'), 'allowed')).toBe(false)
  })
})

describe('外部ストレージ (4.4.2、T4) — Broker 経路も同じ classify を通る', () => {
  let volumesDir: string
  let volumeRules: ReturnType<typeof createMacosExclusions>
  let volumeBroker: CapabilityBroker

  beforeAll(() => {
    // The real /Volumes cannot be touched, so a version with the rule's `volumesDir` replaced is built.
    volumesDir = join(root, 'Volumes')
    mkdirSync(join(volumesDir, 'Allowed'), { recursive: true })
    mkdirSync(join(volumesDir, 'Other'), { recursive: true })
    writeFileSync(join(volumesDir, 'Allowed', 'a.txt'), 'allowed volume')
    writeFileSync(join(volumesDir, 'Other', 'b.txt'), 'other volume')
    // A symlink from inside the allowed range (allowed/) to a volume that is not allowed.
    symlinkSync(join(volumesDir, 'Other'), join(root, 'allowed', 'to-other'))
    symlinkSync(join(volumesDir, 'Allowed'), join(root, 'allowed', 'to-allowed'))
    volumeRules = testExclusions(homedir(), {
      volumesDir,
      allowedVolumes: [join(volumesDir, 'Allowed')]
    })
    volumeBroker = new CapabilityBroker({
      scope: { rules: volumeRules },
      audit,
      credentials: new CredentialStore(dbDir, {
        available: () => false,
        seal: () => Buffer.alloc(0),
        open: () => ''
      }),
      policyOf: (id) => (id === 'test.plugin' ? currentPolicy : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined
    })
  })

  const readVia = (uri: string): Promise<unknown> =>
    volumeBroker.handle('test.plugin', { capability: 'fs', op: 'read', uri })

  it('許可していないボリュームは、宣言しても読めない', async () => {
    currentPolicy = policy({ fsRead: [volumesDir] })
    await expect(readVia(pathToUri(join(volumesDir, 'Other', 'b.txt')))).rejects.toThrow('excluded')
    expect(() => resolvePath(join(volumesDir, 'Other', 'b.txt'), { rules: volumeRules }, false)).toThrow(
      PathDenied
    )
    // With the default rule (no allowance), the real /Volumes is the same.
    expect(() => resolvePath('/Volumes/Any/file.txt', { rules }, false)).toThrow('excluded')
  })

  it('許可したボリュームだけ読める', async () => {
    currentPolicy = policy({ fsRead: [volumesDir] })
    const result = (await readVia(pathToUri(join(volumesDir, 'Allowed', 'a.txt')))) as {
      kind: string
      text: string
    }
    expect(result.kind).toBe('text')
    expect(result.text).toContain('allowed volume')
  })

  it('symlink 経由で許可していないボリュームへ回り込めない (realpath 後に再判定)', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    await expect(readVia(pathToUri(join(root, 'allowed', 'to-other', 'b.txt')))).rejects.toThrow(
      'symlink-escape'
    )
    // A symlink to an allowed volume passes (it is not refused if the target is in the allowed range).
    currentPolicy = policy({ fsRead: [join(root, 'allowed'), join(volumesDir, 'Allowed')] })
    const result = (await readVia(pathToUri(join(root, 'allowed', 'to-allowed', 'a.txt')))) as {
      text: string
    }
    expect(result.text).toContain('allowed volume')
  })
})

describe('監査ログ (8 章)', () => {
  it('許可も拒否もプラグイン ID 付きで残る', async () => {
    currentPolicy = policy({ fsRead: [join(root, 'allowed')] })
    await read(pathToUri(join(root, 'allowed', 'note.txt')))
    await expect(read(pathToUri(join(root, 'secret', 'key.txt')))).rejects.toThrow()
    audit.flush()

    const entries = audit.recent(50, 'test.plugin')
    const allow = entries.find((e) => e.decision === 'allow' && e.capability === 'fs')
    const deny = entries.find((e) => e.decision === 'deny' && e.reason === 'outside-grant')
    expect(allow).toBeDefined()
    expect(deny).toBeDefined()
    expect(allow?.pluginId).toBe('test.plugin')
  })
})
