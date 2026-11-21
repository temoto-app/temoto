/**
 * TODO 1218: the bundled `aios.bitbucket` (on the plugin-host side), and the "account" with a fixed token (`PluginAccounts.saveToken`).
 *
 * **The fixture is synthetic**: this development machine does not connect to Bitbucket. The shape of the responses was written by hand from only the keys of the official OpenAPI definition
 * (https://api.bitbucket.org/swagger.json, fetched 2026-11-13). Differences from the real thing are fixed by the owner's check on a real device.
 * A fake `api` is passed in: the real API is not called.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginApi } from '../src/shared/plugin.js'
import type { PluginTriggerEvent, TriggerEmitResult } from '../src/shared/trigger.js'
import { CredentialStore, type SecretSealer } from '../src/main/capability/credentials.js'
import { BITBUCKET_CREDENTIAL as MAIN_CREDENTIAL, basicHeaderValue, checkBasicInput } from '../src/main/capability/basic-credentials.js'
import { PluginAccounts } from '../src/main/plugin/accounts.js'
import { parseManifest } from '../src/main/plugin/manifest.js'
import plugin from '../plugins/aios.bitbucket/host/index.js'
import { BITBUCKET_CREDENTIAL } from '../plugins/aios.bitbucket/host/bitbucket.js'
import { isReviewable, parseState, promptFor, runPoll, toTaskState } from '../plugins/aios.bitbucket/host/poll.js'
import { getPullRequest, getPullRequestDiff, listPullRequestComments, splitDiff } from '../plugins/aios.bitbucket/host/tools.js'

const ME = '{11111111-aaaa-bbbb-cccc-000000000001}'
const OTHER = '{22222222-aaaa-bbbb-cccc-000000000002}'

function pr(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Change ${id}`,
    state: 'OPEN',
    draft: false,
    author: { uuid: OTHER, display_name: 'Alice' },
    reviewers: [{ uuid: ME, display_name: 'Me' }],
    participants: [{ user: { uuid: ME }, role: 'REVIEWER', approved: false, state: null }],
    source: { branch: { name: 'feature' } },
    destination: { branch: { name: 'main' } },
    links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${id}` } },
    updated_on: '2026-11-10T00:00:00.000000+00:00',
    summary: { raw: 'Please look' },
    ...extra
  }
}

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/docs/b.md b/docs/b.md',
  '--- a/docs/b.md',
  '+++ b/docs/b.md',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  ''
].join('\n')

interface Fake {
  api: PluginApi
  urls: string[]
  events: PluginTriggerEvent[]
  emitResult: () => TriggerEmitResult
  routes: Map<string, () => { status: number; body: string; truncated?: boolean }>
  present: boolean
}

function fake(): Fake {
  const state: Fake = {
    urls: [],
    events: [],
    emitResult: () => ({ accepted: true }),
    routes: new Map(),
    present: true,
    api: undefined as unknown as PluginApi
  }
  const json = (value: unknown, status = 200) => () => ({ status, body: JSON.stringify(value) })
  state.routes.set('/user', json({ uuid: ME }))
  state.routes.set('/user/workspaces', json({ values: [{ workspace: { slug: 'acme' } }] }))
  state.routes.set(
    '/repositories/acme',
    json({
      values: [
        { slug: 'web', full_name: 'acme/web', updated_on: new Date().toISOString() },
        { slug: 'old', full_name: 'acme/old', updated_on: '2020-01-01T00:00:00Z' }
      ]
    })
  )
  state.api = {
    credentials: { status: async () => ({ present: state.present, host: 'api.bitbucket.org' }) },
    net: {
      fetch: async (url: string, init?: { method?: string; auth?: string }) => {
        state.urls.push(url)
        expect(init?.method ?? 'GET').toBe('GET')
        expect(init?.auth).toBe(BITBUCKET_CREDENTIAL)
        const parsed = new URL(url)
        const route = state.routes.get(parsed.pathname.replace('/2.0', ''))
        const out = route === undefined ? { status: 404, body: '{}' } : route()
        return { status: out.status, headers: {}, body: new TextEncoder().encode(out.body), truncated: out.truncated === true }
      }
    },
    triggers: {
      emit: async (event: PluginTriggerEvent) => {
        state.events.push(event)
        return state.emitResult()
      }
    }
  } as unknown as PluginApi
  return state
}

const json = (value: unknown, status = 200) => () => ({ status, body: JSON.stringify(value) })

describe('manifest', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'plugins', 'aios.bitbucket', 'manifest.json'), 'utf8')) as unknown
  const manifest = parseManifest(raw)

  it('declares read-only: tools have no sideEffect, the credential is a name in the table and there is one host', () => {
    expect(manifest.capabilities.network?.hosts).toEqual(['api.bitbucket.org'])
    expect(manifest.capabilities.credentials?.basic).toEqual([MAIN_CREDENTIAL])
    expect(manifest.capabilities.credentials?.oauth).toEqual([])
    const tools = manifest.mcp?.tools ?? []
    expect(tools.map((t) => t.name)).toEqual(['getPullRequest', 'getPullRequestDiff', 'listPullRequestComments'])
    for (const tool of tools) expect(tool.sideEffect).toBeUndefined()
    expect(manifest.triggers?.map((t) => t.id)).toEqual(['review-requested'])
    expect(Object.keys(plugin.mcp ?? {})).toEqual(tools.map((t) => t.name))
  })
})

describe('isReviewable', () => {
  it('true only for open, not draft, author is not self, self is a reviewer and not yet approved', () => {
    expect(isReviewable(pr(1), ME)).toBe(true)
    expect(isReviewable(pr(1, { draft: true }), ME)).toBe(false)
    expect(isReviewable(pr(1, { state: 'MERGED' }), ME)).toBe(false)
    expect(isReviewable(pr(1, { author: { uuid: ME } }), ME)).toBe(false)
    expect(isReviewable(pr(1, { reviewers: [{ uuid: OTHER }], participants: [] }), ME)).toBe(false)
    expect(isReviewable(pr(1, { participants: [{ user: { uuid: ME }, role: 'REVIEWER', approved: true }] }), ME)).toBe(false)
    // Braces and differences in case are the same uuid.
    expect(isReviewable(pr(1), ME.replace(/[{}]/g, '').toUpperCase())).toBe(true)
  })
})

describe('runPoll', () => {
  it('does nothing without credentials', async () => {
    const f = fake()
    f.present = false
    expect(await runPoll({ state: null, reason: 'scheduled' }, f.api)).toEqual({ more: false })
    expect(f.urls).toEqual([])
  })

  it('finds PRs where I am the reviewer per repository and notifies; does not look at old repositories; the key is workspace/repo#id and cwd is the repo name', async () => {
    const f = fake()
    f.routes.set('/repositories/acme/web/pullrequests', json({ values: [{ id: 7, updated_on: 'u1' }, { id: 8, updated_on: 'u2' }, { id: 9, updated_on: 'u3' }] }))
    f.routes.set('/repositories/acme/web/pullrequests/7', json(pr(7)))
    f.routes.set('/repositories/acme/web/pullrequests/8', json(pr(8, { draft: true })))
    f.routes.set('/repositories/acme/web/pullrequests/9', json(pr(9, { participants: [{ user: { uuid: ME }, role: 'REVIEWER', approved: true }] })))
    const result = await runPoll({ state: null, reason: 'scheduled' }, f.api)
    expect(f.events).toHaveLength(1)
    expect(f.events[0]).toMatchObject({
      trigger: 'review-requested',
      key: 'acme/web#7',
      cwd: 'web',
      url: 'https://bitbucket.org/acme/web/pull-requests/7'
    })
    expect(f.events[0]?.prompt).toContain('acme/web#7')
    expect(f.events[0]?.prompt).not.toContain('Please look') // The description is not put into the prompt (constraint 9)
    expect(f.urls.some((u) => u.includes('/repositories/acme/old'))).toBe(false)
    const listed = f.urls.find((u) => u.includes('/pullrequests?'))!
    expect(decodeURIComponent(listed)).toContain(`reviewers.uuid="${ME}"`)
    const state = parseState(result.state ?? null)
    expect(state.seen['acme/web#7']).toBe('done')
    // A PR that lacked credentials is not reviewed again until it is updated; the next run does not fetch the PR body.
    expect(state.seen['acme/web#8']).toBe('u2')
    const before = f.urls.length
    f.events.length = 0
    await runPoll({ state: result.state ?? null, reason: 'scheduled' }, f.api)
    expect(f.events).toEqual([])
    expect(f.urls.slice(before).some((u) => /pullrequests\/\d+$/.test(u))).toBe(false)
  })

  it('does not notify a second time even when a push adds commits (done stays done even if updated_on changes)', async () => {
    const f = fake()
    f.routes.set('/repositories/acme/web/pullrequests', json({ values: [{ id: 7, updated_on: 'u1' }] }))
    f.routes.set('/repositories/acme/web/pullrequests/7', json(pr(7)))
    const first = await runPoll({ state: null, reason: 'scheduled' }, f.api)
    f.routes.set('/repositories/acme/web/pullrequests', json({ values: [{ id: 7, updated_on: 'u9' }] }))
    f.events.length = 0
    await runPoll({ state: first.state ?? null, reason: 'scheduled' }, f.api)
    expect(f.events).toEqual([])
  })

  it('disabled / daily-cap / unavailable do not advance the state and stop with a gap; duplicate advances', async () => {
    const f = fake()
    f.routes.set('/repositories/acme/web/pullrequests', json({ values: [{ id: 7 }] }))
    f.routes.set('/repositories/acme/web/pullrequests/7', json(pr(7)))
    for (const reason of ['disabled', 'daily-cap', 'unavailable'] as const) {
      f.emitResult = () => ({ accepted: false, reason })
      const held = await runPoll({ state: null, reason: 'scheduled' }, f.api)
      expect(held.retryAfterMs).toBeGreaterThan(0)
      expect(parseState(held.state ?? null).seen['acme/web#7']).toBeUndefined()
    }
    f.emitResult = () => ({ accepted: false, reason: 'duplicate' })
    const dup = await runPoll({ state: null, reason: 'scheduled' }, f.api)
    expect(parseState(dup.state ?? null).seen['acme/web#7']).toBe('done')
  })

  it('when the filter is refused with 400, fetches again without filtering and checks with the PR itself', async () => {
    const f = fake()
    let calls = 0
    f.routes.set('/repositories/acme/web/pullrequests', () => {
      calls += 1
      return new URL(f.urls.at(-1)!).searchParams.has('q') ? { status: 400, body: '{}' } : { status: 200, body: JSON.stringify({ values: [{ id: 7 }] }) }
    })
    f.routes.set('/repositories/acme/web/pullrequests/7', json(pr(7)))
    const result = await runPoll({ state: null, reason: 'scheduled' }, f.api)
    expect(calls).toBe(2)
    expect(f.events).toHaveLength(1)
    expect(parseState(result.state ?? null).noFilter).toBe(true)
  })

  it('429 backs off (doubling), 401 does not advance, 5xx comes back after a short gap; the number of sends does not exceed the limit', async () => {
    const f = fake()
    f.routes.set('/user', json({}, 429))
    const limited = await runPoll({ state: null, reason: 'scheduled' }, f.api)
    expect(limited.retryAfterMs).toBe(60_000)
    f.routes.set('/user', json({}, 401))
    expect((await runPoll({ state: null, reason: 'scheduled' }, f.api)).retryAfterMs).toBeUndefined()
    f.routes.set('/user', json({}, 503))
    expect((await runPoll({ state: null, reason: 'scheduled' }, f.api)).retryAfterMs).toBe(120_000)
    const g = fake()
    g.routes.set('/repositories/acme/web/pullrequests', json({ values: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }))
    for (let id = 1; id <= 4; id += 1) g.routes.set(`/repositories/acme/web/pullrequests/${id}`, json(pr(id)))
    await runPoll({ state: null, reason: 'scheduled' }, g.api, 6)
    expect(g.urls.length).toBeLessThanOrEqual(6)
  })

  it('drops seen from the oldest so the state fits in 16 KB', () => {
    const state = parseState(null)
    for (let i = 0; i < 400; i += 1) state.seen[`acme/web#${i}`] = 'done'
    expect(JSON.stringify(toTaskState(state)).length).toBeLessThan(16 * 1024)
    expect(Object.keys((toTaskState(state) as { seen: object }).seen)).toHaveLength(200)
  })

  it('seen moves to recent when re-stamped: marks seen this time remain even over the limit and the oldest are dropped first', () => {
    const state = parseState(null)
    for (let i = 0; i < 150; i += 1) state.seen[`acme/web#${i}`] = 'done'
    // The 150 are re-marked as seen, followed by a new mark for 100 more.
    for (let i = 0; i < 100; i += 1) state.seen[`acme/api#${i}`] = 'done'
    const kept = Object.keys((toTaskState(state) as { seen: object }).seen)
    expect(kept).toHaveLength(200)
    expect(kept).toContain('acme/api#99')
    expect(kept).not.toContain('acme/web#0')
    expect(kept).toContain('acme/web#149')
  })

  it('promptFor is a reference only', () => {
    const text = promptFor('acme', 'web', pr(7) as never)
    expect(text).toContain('URL: https://bitbucket.org/acme/web/pull-requests/7')
    expect(text).not.toContain('Please look')
  })
})

describe('read tools', () => {
  it('getPullRequest: the badge and main fields; refuses a non-slug argument and an invalid id', async () => {
    const f = fake()
    f.routes.set('/repositories/acme/web/pullrequests/7', json(pr(7)))
    const text = await getPullRequest({ workspace: 'acme', repo: 'web', id: 7 }, f.api)
    expect(text).toContain('Untrusted')
    expect(text).toContain('acme/web#7: Change 7')
    expect(text).toContain('feature -> main')
    await expect(getPullRequest({ workspace: '../x', repo: 'web', id: 7 }, f.api)).rejects.toThrow()
    await expect(getPullRequest({ workspace: 'acme', repo: 'web', id: 0 }, f.api)).rejects.toThrow()
    await expect(getPullRequest({ workspace: 'acme', repo: 'web', id: 1.5 }, f.api)).rejects.toThrow()
  })

  it('getPullRequestDiff: everything if small, one with file, and a list and offset if large', async () => {
    const f = fake()
    f.routes.set('/repositories/acme/web/pullrequests/7/diff', () => ({ status: 200, body: DIFF }))
    expect(splitDiff(DIFF).map((x) => [x.path, x.added, x.removed])).toEqual([
      ['src/a.ts', 2, 1],
      ['docs/b.md', 1, 1]
    ])
    const all = await getPullRequestDiff({ workspace: 'acme', repo: 'web', id: 7 }, f.api)
    expect(all).toContain('- src/a.ts (+2 -1)')
    expect(all).toContain('+more')
    const one = await getPullRequestDiff({ workspace: 'acme', repo: 'web', id: 7, file: 'docs/b.md' }, f.api)
    expect(one).toContain('+y')
    expect(one).not.toContain('+more')
    expect(await getPullRequestDiff({ workspace: 'acme', repo: 'web', id: 7, file: 'nope' }, f.api)).toContain('No such file')
    const big = DIFF + 'diff --git a/big b/big\n' + '+x\n'.repeat(40_000)
    f.routes.set('/repositories/acme/web/pullrequests/7/diff', () => ({ status: 200, body: big }))
    const large = await getPullRequestDiff({ workspace: 'acme', repo: 'web', id: 7 }, f.api)
    expect(large).toContain('The diff is large')
    expect(large.length).toBeLessThan(5_000)
    expect(await getPullRequestDiff({ workspace: 'acme', repo: 'web', id: 7, file: 'big' }, f.api)).toContain('more: call again with offset')
  })

  it('listPullRequestComments: excludes deleted ones and adds lines and replies', async () => {
    const f = fake()
    f.routes.set(
      '/repositories/acme/web/pullrequests/7/comments',
      json({
        values: [
          { id: 1, user: { display_name: 'Bob' }, content: { raw: 'top' }, created_on: 't' },
          { id: 2, deleted: true, content: { raw: 'gone' } },
          { id: 3, user: { display_name: 'Cy' }, content: { raw: 'inline' }, parent: { id: 1 }, inline: { path: 'src/a.ts', to: 12 } }
        ]
      })
    )
    const text = await listPullRequestComments({ workspace: 'acme', repo: 'web', id: 7 }, f.api)
    expect(text).toContain('top')
    expect(text).not.toContain('gone')
    expect(text).toContain('on src/a.ts:12 (reply to #1)')
  })
})

describe('fixed-token account (PluginAccounts.saveToken)', () => {
  const sealer: SecretSealer = {
    available: () => true,
    seal: (v) => Buffer.from(`sealed:${v}`),
    open: (b) => b.toString().replace(/^sealed:/, '')
  }
  const manifest = parseManifest(JSON.parse(readFileSync(join(__dirname, '..', 'plugins', 'aios.bitbucket', 'manifest.json'), 'utf8')))
  let dir: string
  let store: CredentialStore
  let events: string[]
  const make = (): PluginAccounts =>
    new PluginAccounts({
      credentials: store,
      manifestOf: (id) => (id === 'aios.bitbucket' ? manifest : null),
      isBundled: (id) => id === 'aios.bitbucket',
      fetchFn: async () => ({ status: 200, text: async () => '{}' }),
      openUrl: () => undefined,
      chooseClientFile: async () => null,
      onSignedIn: (id) => events.push(`in:${id}`),
      onSignedOut: (id) => events.push(`out:${id}`)
    })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-bb-'))
    store = new CredentialStore(dir, sealer)
    events = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("the state appears as a token field; saving seals the Basic header with the table's host and the value is not returned in status either", () => {
    const accounts = make()
    expect(accounts.status('aios.bitbucket')).toEqual([
      { credential: MAIN_CREDENTIAL, provider: 'token', clientConfigured: true, signedIn: false, needsReauth: false, signingIn: false }
    ])
    const result = accounts.saveToken('aios.bitbucket', MAIN_CREDENTIAL, ' me@example.com ', ' tok-123 ')
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('tok-123')
    expect(store.headerFor(MAIN_CREDENTIAL)).toEqual({
      host: 'api.bitbucket.org',
      header: 'authorization',
      value: basicHeaderValue('me@example.com', 'tok-123')
    })
    expect(basicHeaderValue('me@example.com', 'tok-123')).toBe(`Basic ${Buffer.from('me@example.com:tok-123').toString('base64')}`)
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain('tok-123')
    expect(events).toEqual(['in:aios.bitbucket'])
  })

  it('refuses malformed input and a plugin / name without a declaration; deleting discards the credential and the continuation position', async () => {
    const accounts = make()
    for (const [email, token] of [['no-at', 't'], ['a@b.c', ''], ['a@b.c', 'has space'], ['a:b@c.d', 't'], ['a@b.c', 'x'.repeat(2_000)]]) {
      expect(accounts.saveToken('aios.bitbucket', MAIN_CREDENTIAL, email, token)).toMatchObject({ ok: false, error: 'bad-input' })
    }
    expect(accounts.saveToken('aios.bitbucket', MAIN_CREDENTIAL, 1, 2)).toMatchObject({ ok: false, error: 'bad-input' })
    expect(accounts.saveToken('aios.bitbucket', 'other:name', 'a@b.c', 't')).toMatchObject({ ok: false, error: 'unavailable' })
    expect(accounts.saveToken('aios.other', MAIN_CREDENTIAL, 'a@b.c', 't')).toMatchObject({ ok: false, error: 'unavailable' })
    expect(store.status(MAIN_CREDENTIAL).present).toBe(false)
    accounts.saveToken('aios.bitbucket', MAIN_CREDENTIAL, 'a@b.c', 't')
    await accounts.signOut('aios.bitbucket', MAIN_CREDENTIAL)
    expect(store.status(MAIN_CREDENTIAL).present).toBe(false)
    expect(events).toContain('out:aios.bitbucket')
    expect(checkBasicInput('a@b.c', 't')).toBe(true)
  })
})
