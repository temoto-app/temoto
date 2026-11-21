/**
 * The allow table of the OS sandbox (TODO 1106, ARCHITECTURE 4.2.4): normalization, differences, the connection targets passed to launch, the `app_settings` keys,
 * the input of the settings screen, Broker's refusal of a request to "run outside the sandbox", and migration 34. Neither the model nor the CLI is used.
 * TODO 1109 item 8: on the main side, drops the home itself and its parents (`sandbox-home.ts`, including homes at other places).
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  DEFAULT_SANDBOX_ALLOWED_DOMAINS,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  MAX_SANDBOX_ENTRIES,
  applySandboxDomainsPatch,
  applySandboxWritePatch,
  normalizeSandboxDomain,
  normalizeSandboxWritePath,
  sandboxDomainsForLaunch,
  sanitizeSandboxDomains
} from '../src/shared/os-sandbox.js'
import { SANDBOX_ALLOWED_DOMAINS, SANDBOX_ALLOW_WRITE, agentSettingAccess } from '../src/common/settings-keys.js'
import { asPolicyPatch } from '../src/main/ipc/handlers.js'
import { ApprovalBroker, type ApprovalResult } from '../src/main/approval/broker.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { dropHomeWritePaths, isHomeOrAncestor } from '../src/main/session/sandbox-home.js'

describe('接続先の正規化', () => {
  it('ホスト名と *.ホスト名だけ。小文字に揃え、末尾の . を落とす', () => {
    expect(normalizeSandboxDomain(' Registry.NPMJS.org. ')).toBe('registry.npmjs.org')
    expect(normalizeSandboxDomain('*.GitHub.com')).toBe('*.github.com')
  })

  it('スキーム・パス・ポート・IP・1 語・空白・二重の * は受けない', () => {
    for (const bad of ['https://a.com', 'a.com/x', 'a.com:443', '10.0.0.1', 'localhost', 'a b.com', '*.*.a.com', '*', '', '-a.com']) {
      expect(normalizeSandboxDomain(bad)).toBeNull()
    }
  })
})

describe('書ける場所の正規化', () => {
  it('/ か ~/ で始まるパスだけ。末尾の / は落とす', () => {
    expect(normalizeSandboxWritePath('~/.npm/')).toBe('~/.npm')
    expect(normalizeSandboxWritePath('/opt/build')).toBe('/opt/build')
    expect(normalizeSandboxWritePath('/Users/alice/work')).toBe('/Users/alice/work')
  })

  it('機械全体・ホーム全体・相対・.. ・制御文字は受けない', () => {
    for (const bad of ['/', '~', '~/', 'relative', './x', '/a/../b', '/a/./b', '/a//b', '/a\nb', '~user/x', '/Users', '/Users/alice', '/Users/alice/', '/home/alice', '/root', '']) {
      expect(normalizeSandboxWritePath(bad)).toBeNull()
    }
  })
})

describe('ホームとその親を落とす (main、TODO 1109 の 8)', () => {
  it('別の場所のホーム (/Volumes・/srv) とその親は拒む。shared の形の検査は通ってしまう値', () => {
    const homes = ['/Volumes/data/me']
    for (const path of ['/Volumes/data/me', '/Volumes/data', '/Volumes', '/Volumes/data/me/', '/VOLUMES/Data/Me']) {
      // The shape check (shared) passes (the trailing / is dropped).
      expect(normalizeSandboxWritePath(path)).not.toBeNull()
      expect(isHomeOrAncestor(normalizeSandboxWritePath(path)!, homes)).toBe(true)
    }
    expect(isHomeOrAncestor('/srv/home/me', ['/srv/home/me'])).toBe(true)
    expect(isHomeOrAncestor('/srv', ['/srv/home/me'])).toBe(true)
  })

  it('ホームの中・兄弟・名前の前方一致は受ける。~/… はホームに展開して比べる', () => {
    const homes = ['/Volumes/data/me']
    expect(isHomeOrAncestor('~/.npm', homes)).toBe(false)
    expect(isHomeOrAncestor('/Volumes/data/me/.cache', homes)).toBe(false)
    expect(isHomeOrAncestor('/Volumes/data/meme', homes)).toBe(false)
    expect(isHomeOrAncestor('/Volumes/data/other', homes)).toBe(false)
    expect(isHomeOrAncestor('/tmp/build', homes)).toBe(false)
  })

  it('ホームの realpath も渡せば、どちらの形も拒む。順は保つ', () => {
    const homes = ['/home/me', '/data/users/me']
    expect(dropHomeWritePaths(['~/.npm', '/data/users', '/home', '/opt/cache', '/data/users/me'], homes)).toEqual([
      '~/.npm',
      '/opt/cache'
    ])
    // An empty home drops nothing.
    expect(dropHomeWritePaths(['/x'], [''])).toEqual(['/x'])
  })
})

describe('一覧の差分と起動に渡す接続先', () => {
  it('丸ごとの値を土台に、外す → 足す。重複は 1 つ、読めない値は落とす', () => {
    expect(
      applySandboxDomainsPatch(DEFAULT_SANDBOX_ALLOWED_DOMAINS, {
        sandboxAllowedDomainsRemove: ['GITHUB.com'],
        sandboxAllowedDomainsAdd: ['pypi.org', 'pypi.org', 'bad/']
      })
    ).toEqual(['registry.npmjs.org', '*.github.com', 'pypi.org'])
    expect(applySandboxDomainsPatch(['a.example'], { sandboxAllowedDomains: [] })).toEqual([])
    expect(applySandboxWritePatch(DEFAULT_SANDBOX_ALLOW_WRITE, { sandboxAllowWriteAdd: ['~/.cache/pip', '/'] })).toEqual([
      '~/.npm',
      '~/.cache/pip'
    ])
  })

  it('上限で切る', () => {
    const many = Array.from({ length: MAX_SANDBOX_ENTRIES + 5 }, (_, i) => `h${i}.example`)
    expect(sanitizeSandboxDomains(many)).toHaveLength(MAX_SANDBOX_ENTRIES)
  })

  it('起動に渡す接続先は、設定の一覧 + 聞かない接続先のホスト (user@ を落とす。名前として読めないものは落とす)', () => {
    expect(sandboxDomainsForLaunch(['github.com'], ['me@build.example.org', 'winbox', 'u@NAS', '[::1]', 'github.com'])).toEqual([
      'github.com',
      'build.example.org',
      'winbox',
      'nas'
    ])
  })
})

describe('app_settings の鍵', () => {
  it('owner は main。値が無い・壊れていれば既定、空の配列は空のまま', () => {
    expect(SANDBOX_ALLOWED_DOMAINS.key).toBe('sandbox.allowedDomains')
    expect(SANDBOX_ALLOWED_DOMAINS.owner).toBe('main')
    expect(SANDBOX_ALLOW_WRITE.key).toBe('sandbox.allowWrite')
    expect(SANDBOX_ALLOW_WRITE.owner).toBe('main')
    expect(SANDBOX_ALLOWED_DOMAINS.parse(null)).toEqual(['registry.npmjs.org', 'github.com', '*.github.com'])
    expect(SANDBOX_ALLOWED_DOMAINS.parse('not json')).toEqual(DEFAULT_SANDBOX_ALLOWED_DOMAINS)
    expect(SANDBOX_ALLOWED_DOMAINS.parse('[]')).toEqual([])
    expect(SANDBOX_ALLOWED_DOMAINS.parse('["X.example","https://y"]')).toEqual(['x.example'])
    expect(SANDBOX_ALLOW_WRITE.parse(null)).toEqual(['~/.npm'])
    expect(SANDBOX_ALLOW_WRITE.parse('{"a":1}')).toEqual(['~/.npm'])
    expect(SANDBOX_ALLOW_WRITE.parse(SANDBOX_ALLOW_WRITE.serialize(['/opt/x']))).toEqual(['/opt/x'])
  })

  it('会話の AI の設定の道具からは見えない (関門を緩める足場にしない)', () => {
    expect(agentSettingAccess(SANDBOX_ALLOWED_DOMAINS)).toBeNull()
    expect(agentSettingAccess(SANDBOX_ALLOW_WRITE)).toBeNull()
  })

  it('ThreadStore で往復する。省略して書いても保存値に触らない', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      const base = { autoAllowAll: true, autoAllowTools: [], bashDenyPatterns: [] }
      store.writeApprovalPolicy({ ...base, sandboxAllowedDomains: ['a.example'], sandboxAllowWrite: [] })
      expect(store.readApprovalPolicy()).toMatchObject({ sandboxAllowedDomains: ['a.example'], sandboxAllowWrite: [] })
      store.writeApprovalPolicy(base)
      expect(store.readApprovalPolicy()).toMatchObject({ sandboxAllowedDomains: ['a.example'], sandboxAllowWrite: [] })
    } finally {
      db.close()
    }
  })
})

describe('設定画面の受け口 (asPolicyPatch)', () => {
  it('文字列の配列だけを受け、無い欄は載せない', () => {
    expect(
      asPolicyPatch({ sandboxAllowedDomainsAdd: ['a.example', 1], sandboxAllowWriteRemove: 'x', sandboxAllowWrite: ['~/.npm'] })
    ).toEqual({ sandboxAllowedDomainsAdd: ['a.example'], sandboxAllowWrite: ['~/.npm'] })
  })
})

describe('Broker — sandbox の外で走らせる要求 (TODO 1106)', () => {
  it('既定の全部許可・規則があっても、聞かずに system で拒む (積まない)', async () => {
    const decided: ApprovalResult[] = []
    const broker = new ApprovalBroker(
      { onChanged: () => undefined, onDecided: (_item, result) => decided.push(result) },
      { autoAllowAll: true, autoAllowTools: [], bashDenyPatterns: [] }
    )
    const result = await broker.request({
      threadId: 't',
      threadTitle: 't',
      toolName: 'Bash',
      summary: '',
      input: { command: 'touch ~/x', dangerouslyDisableSandbox: true },
      unsandboxed: true
    })
    expect(result).toEqual({
      allowed: false,
      by: 'system',
      message: 'approval-cancelled-os-sandbox',
      reply: { kind: 'cancelled', reason: 'os-sandbox' }
    })
    expect(broker.list()).toEqual([])
    expect(decided).toHaveLength(1)
    // A request without the mark is handled as usual (the default lets it through).
    await expect(
      broker.request({ threadId: 't', threadTitle: 't', toolName: 'Bash', summary: '', input: { command: 'ls' } })
    ).resolves.toMatchObject({ allowed: true })
  })
})

describe('migration 34 (threads.os_sandbox)', () => {
  it('既存の行は OFF。番号を巻き戻して当て直しても落ちない (列があれば流さない)', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const columns = db.prepare(`SELECT name, dflt_value FROM pragma_table_info('threads')`).all() as {
        name: string
        dflt_value: string | null
      }[]
      expect(columns.find((column) => column.name === 'os_sandbox')?.dflt_value).toBe('0')
      db.pragma('user_version = 33')
      expect(runMigrations(db)).toBeGreaterThanOrEqual(34)
    } finally {
      db.close()
    }
  })
})
