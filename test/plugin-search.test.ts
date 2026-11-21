/**
 * TODO 896 (ARCHITECTURE 7.5.1): the entry point of the search section that a plugin adds to the search sidebar.
 *
 *  - Validation of the manifest's `searchProvider` (the entry, `openWith`, and the scheme if `viewer`)
 *  - Lookup of the plugin-host export (`search.query`)
 *  - Rechecking of results (`sanitizeSearchReturn`: shape, count, length, where it opens)
 *  - Relay (`PluginSearchRelay`): re-querying the section, arguments, cancellation of the previous search, and how failures are told apart
 *  - The real `PluginHost` (fork is a fake): bundled only; not called when disabled; `invoke` with kind `search`
 *  - The renderer's pure functions and store (500 ms debounce and Enter)
 *
 * No trial section is added to bundled plugins: it is shown with the fixture manifest and a fake plugin-host. The model is not called.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'
import { isDeclaredExport, missingExports, needsHost, parseManifest } from '../src/main/plugin/manifest.js'
import { PluginSearchRelay, acceptsOpen, sanitizeSearchReturn, type PluginSearchSource } from '../src/main/plugin/search.js'
import type { EnabledSearchProvider } from '../src/main/plugin/host.js'
import { describeExports, findHandler, readInvoke } from '../src/plugin-host/dispatch.js'
import {
  MAX_PLUGIN_SEARCH_RESULTS,
  MAX_PLUGIN_SEARCH_TITLE,
  PLUGIN_SEARCH_DEBOUNCE_MS,
  type PluginSearchResponse
} from '../src/shared/plugin-search.js'
import type { PluginSummary } from '../src/shared/plugin.js'
import {
  IDLE_PROVIDER,
  openPluginResult,
  pluginSearchProviders,
  pluginSearchRows,
  type PluginSearchLabels
} from '../src/renderer/src/pluginSearch.js'

const BASE = { id: 'test.search', name: 'Search', version: '1.0.0', host: { entry: 'host/index.js' } }

describe('searchProvider in the manifest', () => {
  it('reads it when title and openWith are present, and it becomes a declaration that starts plugin-host', () => {
    const manifest = parseManifest({ ...BASE, searchProvider: { title: 'Drive', openWith: 'web' } })
    expect(manifest.searchProvider).toEqual({ title: 'Drive', openWith: 'web' })
    expect(needsHost(manifest)).toBe(true)
    expect(isDeclaredExport(manifest, 'search', 'query')).toBe(true)
    expect(isDeclaredExport(manifest, 'search', 'other')).toBe(false)
    expect(missingExports(manifest, { commands: [], mcp: [], indexer: [] })).toEqual(['search:query'])
    expect(missingExports(manifest, { commands: [], mcp: [], indexer: [], search: ['query'] })).toEqual([])
  })

  it('does not read an omitted openWith, an unknown value, an unknown key, or a missing entry', () => {
    expect(() => parseManifest({ ...BASE, searchProvider: { title: 'Drive' } })).toThrow(/openWith/)
    expect(() => parseManifest({ ...BASE, searchProvider: { title: 'Drive', openWith: 'file' } })).toThrow()
    expect(() => parseManifest({ ...BASE, searchProvider: { title: 'Drive', openWith: 'web', live: true } })).toThrow()
    const noHost = { id: BASE.id, name: BASE.name, version: BASE.version }
    expect(() => parseManifest({ ...noHost, searchProvider: { title: 'Drive', openWith: 'web' } })).toThrow(/host\.entry/)
  })

  it('openWith "viewer" needs the scheme of the plugin\'s own viewer', () => {
    expect(() => parseManifest({ ...BASE, searchProvider: { title: 'Mail', openWith: 'viewer' } })).toThrow(/viewer\.schemes/)
    const manifest = parseManifest({
      ...BASE,
      searchProvider: { title: 'Mail', placeholder: 'Search mail', openWith: 'viewer' },
      viewer: { entry: 'viewer/index.html', schemes: ['testmail'] }
    })
    expect(manifest.searchProvider?.placeholder).toBe('Search mail')
  })

  it('a plugin without the declaration cannot call search', () => {
    expect(isDeclaredExport(parseManifest(BASE), 'search', 'query')).toBe(false)
  })
})

describe('plugin-host export (search.query)', () => {
  it('finds the search kind and puts it in the list after loading', () => {
    const query = (): unknown => ({ results: [] })
    const plugin = { search: { query } }
    expect(findHandler(plugin, 'search', 'query')).toBe(query)
    expect(findHandler(plugin, 'search', 'constructor')).toBeNull()
    expect(describeExports(plugin).search).toEqual(['query'])
    expect(readInvoke({ kind: 'search', command: 'query', arg: { query: 'x' } })).toEqual({
      kind: 'search',
      name: 'query',
      arg: { query: 'x' }
    })
  })
})

describe('re-validating results (sanitizeSearchReturn)', () => {
  it('web accepts only http(s) URLs, viewer only the scheme of that plugin', () => {
    expect(acceptsOpen('web', [], 'https://drive.google.com/file/d/1')).toBe(true)
    expect(acceptsOpen('external', [], 'https://user:pw@example.com/')).toBe(false)
    expect(acceptsOpen('web', [], 'file:///etc/passwd')).toBe(false)
    expect(acceptsOpen('web', [], 'javascript:alert(1)')).toBe(false)
    expect(acceptsOpen('viewer', ['testmail'], 'testmail://t/1')).toBe(true)
    expect(acceptsOpen('viewer', ['testmail'], 'TESTMAIL://t/1')).toBe(true)
    expect(acceptsOpen('viewer', ['testmail'], 'gmail://t/1')).toBe(false)
    expect(acceptsOpen('viewer', ['testmail'], 'https://example.com/')).toBe(false)
  })

  it('null for a wrong shape; bad rows are dropped and counted', () => {
    expect(sanitizeSearchReturn(null, 'web', [])).toBeNull()
    expect(sanitizeSearchReturn([{ id: 'a' }], 'web', [])).toBeNull()
    expect(sanitizeSearchReturn({ results: 'x' }, 'web', [])).toBeNull()
    const out = sanitizeSearchReturn(
      {
        results: [
          { id: 'a', title: ' Report\nQ3 ', snippet: 'line1\tline2', description: 'me', open: 'https://example.com/a', extra: 1 },
          { id: 'a', title: 'dup', open: 'https://example.com/dup' },
          { id: 'b', title: '', open: 'https://example.com/b' },
          { id: 'c', title: 'local', open: 'file:///Users/me/secret' },
          { title: 'no id', open: 'https://example.com/n' },
          'text',
          { id: 'd', title: 'x'.repeat(500), open: 'https://example.com/d', snippet: 42 }
        ]
      },
      'web',
      []
    )
    expect(out?.results).toEqual([
      { id: 'a', title: 'Report Q3', snippet: 'line1 line2', description: 'me', open: 'https://example.com/a' },
      { id: 'd', title: `${'x'.repeat(MAX_PLUGIN_SEARCH_TITLE - 1)}…`, open: 'https://example.com/d' }
    ])
    expect(out?.dropped).toBe(5)
  })

  it('anything over the limit is dropped and counted', () => {
    const results = Array.from({ length: MAX_PLUGIN_SEARCH_RESULTS + 7 }, (_, i) => ({
      id: `r${i}`,
      title: `r${i}`,
      open: `https://example.com/${i}`
    }))
    const out = sanitizeSearchReturn({ results }, 'external', [])
    expect(out?.results).toHaveLength(MAX_PLUGIN_SEARCH_RESULTS)
    expect(out?.dropped).toBe(7)
  })
})

function provider(pluginId: string, openWith: 'web' | 'external' | 'viewer' = 'web'): EnabledSearchProvider {
  return { pluginId, declaration: { title: pluginId, openWith }, viewerSchemes: ['testmail'] }
}

describe('relay (PluginSearchRelay)', () => {
  it('a plugin without a section is unavailable without calling plugin-host', async () => {
    const invoke = vi.fn()
    const relay = new PluginSearchRelay({ source: { searchProviders: () => [], invoke } })
    expect(await relay.search(1, 'test.search', 'q')).toMatchObject({ error: 'unavailable', results: [] })
    expect(await relay.search(1, 42, 'q')).toMatchObject({ error: 'unavailable' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('calls the search kind query with the normalized term and the limit, and returns the re-validated result', async () => {
    const invoke = vi.fn(async () => ({
      results: [
        { id: '1', title: 'Hit', open: 'testmail://t/1' },
        { id: '2', title: 'Web', open: 'https://example.com/' }
      ]
    }))
    const relay = new PluginSearchRelay({ source: { searchProviders: () => [provider('test.search', 'viewer')], invoke } })
    const response = await relay.search(1, 'test.search', '  budget  ')
    expect(invoke).toHaveBeenCalledWith(
      'test.search',
      'query',
      { query: 'budget', limit: MAX_PLUGIN_SEARCH_RESULTS },
      'search',
      expect.any(Number),
      expect.any(AbortSignal)
    )
    expect(response).toEqual({
      pluginId: 'test.search',
      query: 'budget',
      results: [{ id: '1', title: 'Hit', open: 'testmail://t/1' }],
      error: null,
      dropped: 1
    })
  })

  it('a next search on the same section in the same window cancels the previous one (other windows and other sections are not cancelled)', async () => {
    const signals: AbortSignal[] = []
    const resolvers: ((value: unknown) => void)[] = []
    const source: PluginSearchSource = {
      searchProviders: () => [provider('test.a'), provider('test.b')],
      invoke: (_id, _command, _arg, _kind, _timeout, signal) =>
        new Promise((resolve, reject) => {
          signals.push(signal!)
          resolvers.push(resolve)
          signal?.addEventListener('abort', () => reject(new Error('plugin invoke aborted')))
        })
    }
    const relay = new PluginSearchRelay({ source })
    const first = relay.search(1, 'test.a', 'one')
    const otherWindow = relay.search(2, 'test.a', 'one')
    const otherProvider = relay.search(1, 'test.b', 'one')
    const second = relay.search(1, 'test.a', 'two')
    expect(await first).toMatchObject({ error: 'cancelled', query: 'one' })
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false, false])
    for (const resolve of resolvers.slice(1)) resolve({ results: [] })
    expect(await second).toMatchObject({ error: null, query: 'two' })
    expect(await otherWindow).toMatchObject({ error: null })
    expect(await otherProvider).toMatchObject({ error: null })
    // When the window closes, its running searches are cancelled.
    const pending = relay.search(3, 'test.a', 'x')
    relay.cancelCaller(3)
    expect(await pending).toMatchObject({ error: 'cancelled' })
  })

  it('a failure is returned as a reason code and the text the plugin threw is not passed on', async () => {
    const cases: [string, string][] = [
      ['plugin invoke timeout', 'timeout'],
      ['plugin host exited (1)', 'crashed'],
      ['plugin not available', 'unavailable'],
      ['403 Forbidden: secret token abc', 'failed']
    ]
    for (const [message, error] of cases) {
      const relay = new PluginSearchRelay({
        source: { searchProviders: () => [provider('test.a')], invoke: async () => Promise.reject(new Error(message)) }
      })
      const response = await relay.search(1, 'test.a', 'q')
      expect(response).toEqual({ pluginId: 'test.a', query: 'q', results: [], error, dropped: 0 })
    }
    const invalid = new PluginSearchRelay({ source: { searchProviders: () => [provider('test.a')], invoke: async () => 'text' } })
    expect(await invalid.search(1, 'test.a', 'q')).toMatchObject({ error: 'invalid' })
  })
})

// ---- the real PluginHost (the utility process is a fake, the same shape as `plugin-host-tools.test.ts`) ----

interface Posted {
  id: number
  kind: string
  payload?: { kind?: string; command?: string; arg?: unknown }
}

class FakeChild extends EventEmitter {
  readonly stderr = null
  readonly posted: Posted[] = []
  postMessage(message: Posted): void {
    this.posted.push(message)
  }
  kill(): void {
    setTimeout(() => this.emit('exit', 0), 0)
  }
}

const children: FakeChild[] = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      setTimeout(
        () => child.emit('message', { id: 0, kind: 'ready', payload: { commands: [], mcp: [], indexer: [], search: ['query'] } }),
        0
      )
      return child
    }
  }
}))

describe('PluginHost search section (bundled only)', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    children.length = 0
    dir = mkdtempSync(join(tmpdir(), 'aios-plugin-search-'))
    const manifestOf = (id: string): string =>
      JSON.stringify({ id, name: id, version: '1.0.0', host: { entry: 'host/index.js' }, searchProvider: { title: 'Docs', openWith: 'web' } })
    for (const [root, id] of [
      ['bundled', 'test.bundled'],
      ['user', 'test.user']
    ] as const) {
      const pluginDir = join(dir, root, id)
      mkdirSync(join(pluginDir, 'host'), { recursive: true })
      writeFileSync(join(pluginDir, 'manifest.json'), manifestOf(id))
      writeFileSync(join(pluginDir, 'host', 'index.js'), 'export const search = {}\n')
    }
    mkdirSync(join(dir, 'host-entry'), { recursive: true })
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function setup(): Promise<InstanceType<typeof import('../src/main/plugin/host.js').PluginHost>> {
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const host = new PluginHost({
      db,
      bundledDir: join(dir, 'bundled'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
      broker: () => ({}) as unknown as CapabilityBroker,
      onChanged: () => undefined
    })
    host.load()
    return host
  }

  it('only bundled plugins produce a section and appear in summary; an external plugin does not start plugin-host even when called', async () => {
    const host = await setup()
    expect(host.searchProviders().map((entry) => entry.pluginId)).toEqual(['test.bundled'])
    const summaries = host.summaries()
    expect(summaries.find((entry) => entry.id === 'test.bundled')?.searchProvider).toEqual({ title: 'Docs', openWith: 'web' })
    expect(summaries.find((entry) => entry.id === 'test.user')?.searchProvider).toBeUndefined()
    await expect(host.invoke('test.user', 'query', { query: 'x', limit: 1 }, 'search')).rejects.toThrow('plugin not available')
    expect(children).toHaveLength(0)
    await host.stop()
  })

  it('querying through the relay becomes an invoke of the search kind and the result comes back; unavailable once disabled', async () => {
    const host = await setup()
    const relay = new PluginSearchRelay({ source: host })
    const pending = relay.search(7, 'test.bundled', 'quarterly')
    await vi.waitFor(() => expect(children[0]?.posted.find((message) => message.kind === 'invoke')).toBeDefined())
    const invoke = children[0]!.posted.find((message) => message.kind === 'invoke')!
    expect(invoke.payload).toEqual({ kind: 'search', command: 'query', arg: { query: 'quarterly', limit: MAX_PLUGIN_SEARCH_RESULTS } })
    children[0]!.emit('message', {
      id: invoke.id,
      kind: 'result',
      payload: { results: [{ id: 'd1', title: 'Quarterly', snippet: 'numbers', open: 'https://docs.example.com/d1' }] }
    })
    expect(await pending).toEqual({
      pluginId: 'test.bundled',
      query: 'quarterly',
      results: [{ id: 'd1', title: 'Quarterly', snippet: 'numbers', open: 'https://docs.example.com/d1' }],
      error: null,
      dropped: 0
    })
    host.setEnabled('test.bundled', false)
    expect(await relay.search(7, 'test.bundled', 'quarterly')).toMatchObject({ error: 'unavailable' })
    await host.stop()
  })
})

// ---- the renderer's pure functions and store ----

function summary(id: string, extra: Partial<PluginSummary>): PluginSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: null,
    publisher: null,
    iconUrl: null,
    version: '1',
    activityBar: null,
    bundled: true,
    required: false,
    enabled: true,
    capabilities: [],
    consented: [],
    hasViewer: false,
    host: 'stopped',
    crashes: 0,
    ...extra
  } as PluginSummary
}

const LABELS: PluginSearchLabels = {
  section: (title, count) => `${title} (${count})`,
  searching: 'searching',
  empty: 'empty',
  dropped: (n) => `dropped ${n}`,
  error: (code) => `error ${code}`
}

describe('renderer section (pluginSearch.ts)', () => {
  it('only plugins that are enabled and have searchProvider, in heading order', () => {
    const providers = pluginSearchProviders([
      summary('test.z', { searchProvider: { title: 'Mail', openWith: 'viewer', placeholder: 'Find mail' } }),
      summary('test.a', { searchProvider: { title: 'Drive', openWith: 'external' } }),
      summary('test.off', { enabled: false, searchProvider: { title: 'Off', openWith: 'web' } }),
      summary('test.none', {})
    ])
    expect(providers).toEqual([
      { pluginId: 'test.a', title: 'Drive', placeholder: null, openWith: 'external' },
      { pluginId: 'test.z', title: 'Mail', placeholder: 'Find mail', openWith: 'viewer' }
    ])
    expect(pluginSearchProviders(null)).toEqual([])
  })

  it('does not show a section with no search term, and reports searching, 0 results, failure, and the dropped count in one line', () => {
    const providers = [
      { pluginId: 'p.a', title: 'A', placeholder: null, openWith: 'web' as const },
      { pluginId: 'p.b', title: 'B', placeholder: null, openWith: 'viewer' as const },
      { pluginId: 'p.c', title: 'C', placeholder: null, openWith: 'web' as const },
      { pluginId: 'p.d', title: 'D', placeholder: null, openWith: 'web' as const }
    ]
    const rows = pluginSearchRows(
      providers,
      {
        'p.a': { ...IDLE_PROVIDER, draft: 'x', query: 'x', searching: true },
        'p.b': { ...IDLE_PROVIDER, query: 'x', results: [{ id: '1', title: 'one', open: 'm://1' }], dropped: 2 },
        'p.c': { ...IDLE_PROVIDER, query: 'x', error: 'timeout' },
        'p.d': { ...IDLE_PROVIDER, draft: 'typing' }
      },
      LABELS
    )
    expect(rows.map((row) => (row.kind === 'plugin' ? `${row.kind}:${row.section}:${row.openWith}` : `${row.kind}:${'label' in row ? row.label : row.text}`))).toEqual([
      'header:A (0)',
      'note:searching',
      'header:B (1)',
      'plugin:plugin:p.b:viewer',
      'note:dropped 2',
      'header:C (0)',
      'note:error timeout'
    ])
  })

  it("where it opens follows the section's openWith", () => {
    const calls: string[] = []
    const openers = {
      web: (url: string) => void calls.push(`web ${url}`),
      external: (url: string) => void calls.push(`external ${url}`),
      viewer: (uri: string) => void calls.push(`viewer ${uri}`)
    }
    openPluginResult('web', 'https://a/', openers)
    openPluginResult('external', 'https://b/', openers)
    openPluginResult('viewer', 'm://c', openers)
    expect(calls).toEqual(['web https://a/', 'external https://b/', 'viewer m://c'])
  })

  describe('store (on Enter or after 500 ms of no typing)', () => {
    let search: ReturnType<typeof vi.fn>
    let answers: ((response: PluginSearchResponse) => void)[]

    beforeEach(() => {
      vi.useFakeTimers()
      answers = []
      search = vi.fn(
        () =>
          new Promise<PluginSearchResponse>((resolve) => {
            answers.push(resolve)
          })
      )
      ;(globalThis as unknown as { window: unknown }).window = { aios: { plugins: { search } } }
    })

    afterEach(() => {
      vi.useRealTimers()
      delete (globalThis as { window?: unknown }).window
    })

    const response = (query: string, ids: string[]): PluginSearchResponse => ({
      pluginId: 'p.a',
      query,
      results: ids.map((id) => ({ id, title: id, open: `https://x/${id}` })),
      error: null,
      dropped: 0
    })

    it('does not query per keystroke, queries once after 500 ms of stopping; Enter does not wait; stale answers are dropped', async () => {
      const { usePluginSearch } = await import('../src/renderer/src/pluginSearch.js')
      usePluginSearch.setState({ byPlugin: {} })
      const store = usePluginSearch.getState()
      store.setDraft('p.a', 'b')
      vi.advanceTimersByTime(200)
      store.setDraft('p.a', 'bu')
      vi.advanceTimersByTime(PLUGIN_SEARCH_DEBOUNCE_MS - 1)
      expect(search).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenLastCalledWith('p.a', 'bu')
      expect(usePluginSearch.getState().byPlugin['p.a']).toMatchObject({ query: 'bu', searching: true })

      // Enter: sends without waiting. An answer to the earlier 'bu' is discarded even if it arrives later.
      store.setDraft('p.a', 'budget')
      store.submit('p.a')
      expect(search).toHaveBeenCalledTimes(2)
      expect(search).toHaveBeenLastCalledWith('p.a', 'budget')
      answers[1]!(response('budget', ['new']))
      answers[0]!(response('bu', ['old']))
      await vi.runAllTimersAsync()
      expect(usePluginSearch.getState().byPlugin['p.a']).toMatchObject({ query: 'budget', searching: false })
      expect(usePluginSearch.getState().byPlugin['p.a']?.results.map((result) => result.id)).toEqual(['new'])
      // The debounce after Enter does not query the same word again.
      expect(search).toHaveBeenCalledTimes(2)

      // If it is emptied, the results are cleared (nothing is queried).
      store.setDraft('p.a', '')
      vi.advanceTimersByTime(PLUGIN_SEARCH_DEBOUNCE_MS)
      expect(search).toHaveBeenCalledTimes(2)
      expect(usePluginSearch.getState().byPlugin['p.a']).toMatchObject({ query: '', results: [] })
    })
  })
})
