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

describe('normalizing destinations', () => {
  it('only host names and *.host name; lowercases and drops a trailing .', () => {
    expect(normalizeSandboxDomain(' Registry.NPMJS.org. ')).toBe('registry.npmjs.org')
    expect(normalizeSandboxDomain('*.GitHub.com')).toBe('*.github.com')
  })

  it('does not accept schemes, paths, ports, IPs, a single word, whitespace and a doubled *', () => {
    for (const bad of ['https://a.com', 'a.com/x', 'a.com:443', '10.0.0.1', 'localhost', 'a b.com', '*.*.a.com', '*', '', '-a.com']) {
      expect(normalizeSandboxDomain(bad)).toBeNull()
    }
  })
})

describe('normalizing writable places', () => {
  it('only paths starting with / or ~/; a trailing / is dropped', () => {
    expect(normalizeSandboxWritePath('~/.npm/')).toBe('~/.npm')
    expect(normalizeSandboxWritePath('/opt/build')).toBe('/opt/build')
    expect(normalizeSandboxWritePath('/Users/alice/work')).toBe('/Users/alice/work')
  })

  it('does not accept the whole machine, the whole home, relative paths, .. and control characters', () => {
    for (const bad of ['/', '~', '~/', 'relative', './x', '/a/../b', '/a/./b', '/a//b', '/a\nb', '~user/x', '/Users', '/Users/alice', '/Users/alice/', '/home/alice', '/root', '']) {
      expect(normalizeSandboxWritePath(bad)).toBeNull()
    }
  })
})

describe('drops home and its parent (main, item 8 of TODO 1109)', () => {
  it('refuses a home in another place (/Volumes, /srv) and its parent; values that pass the shape check in shared', () => {
    const homes = ['/Volumes/data/me']
    for (const path of ['/Volumes/data/me', '/Volumes/data', '/Volumes', '/Volumes/data/me/', '/VOLUMES/Data/Me']) {
      // The shape check (shared) passes (the trailing / is dropped).
      expect(normalizeSandboxWritePath(path)).not.toBeNull()
      expect(isHomeOrAncestor(normalizeSandboxWritePath(path)!, homes)).toBe(true)
    }
    expect(isHomeOrAncestor('/srv/home/me', ['/srv/home/me'])).toBe(true)
    expect(isHomeOrAncestor('/srv', ['/srv/home/me'])).toBe(true)
  })

  it('accepts inside home, siblings and names that only share a prefix; ~/... is expanded to home before comparing', () => {
    const homes = ['/Volumes/data/me']
    expect(isHomeOrAncestor('~/.npm', homes)).toBe(false)
    expect(isHomeOrAncestor('/Volumes/data/me/.cache', homes)).toBe(false)
    expect(isHomeOrAncestor('/Volumes/data/meme', homes)).toBe(false)
    expect(isHomeOrAncestor('/Volumes/data/other', homes)).toBe(false)
    expect(isHomeOrAncestor('/tmp/build', homes)).toBe(false)
  })

  it("refuses both shapes when home's realpath is also passed; keeps the order", () => {
    const homes = ['/home/me', '/data/users/me']
    expect(dropHomeWritePaths(['~/.npm', '/data/users', '/home', '/opt/cache', '/data/users/me'], homes)).toEqual([
      '~/.npm',
      '/opt/cache'
    ])
    // An empty home drops nothing.
    expect(dropHomeWritePaths(['/x'], [''])).toEqual(['/x'])
  })
})

describe('list diff and the destinations passed to launch', () => {
  it('starting from the whole value, removes then adds; duplicates become one and unreadable values are dropped', () => {
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

  it('cuts at the limit', () => {
    const many = Array.from({ length: MAX_SANDBOX_ENTRIES + 5 }, (_, i) => `h${i}.example`)
    expect(sanitizeSandboxDomains(many)).toHaveLength(MAX_SANDBOX_ENTRIES)
  })

  it('the destinations passed to launch are the settings list + hosts of destinations that are not asked about (drops user@; drops what cannot be read as a name)', () => {
    expect(sandboxDomainsForLaunch(['github.com'], ['me@build.example.org', 'winbox', 'u@NAS', '[::1]', 'github.com'])).toEqual([
      'github.com',
      'build.example.org',
      'winbox',
      'nas'
    ])
  })
})

describe('keys of app_settings', () => {
  it('the owner is main; defaults when missing or broken, and an empty array stays empty', () => {
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

  it("not visible from the conversation AI's settings tool (not a foothold for loosening the gate)", () => {
    expect(agentSettingAccess(SANDBOX_ALLOWED_DOMAINS)).toBeNull()
    expect(agentSettingAccess(SANDBOX_ALLOW_WRITE)).toBeNull()
  })

  it('round-trips through ThreadStore; writing with omissions does not touch the stored value', () => {
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

describe('settings screen entry (asPolicyPatch)', () => {
  it('accepts only string arrays and does not include missing fields', () => {
    expect(
      asPolicyPatch({ sandboxAllowedDomainsAdd: ['a.example', 1], sandboxAllowWriteRemove: 'x', sandboxAllowWrite: ['~/.npm'] })
    ).toEqual({ sandboxAllowedDomainsAdd: ['a.example'], sandboxAllowWrite: ['~/.npm'] })
  })
})

describe('Broker: a request to run outside the sandbox (TODO 1106)', () => {
  it('refuses with system without asking, even with the default allow-all or with rules (does not queue)', async () => {
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
  it('existing rows are OFF; does not fail when the number is rolled back and reapplied (does not run if the column exists)', () => {
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
