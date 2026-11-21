/**
 * TODO 976 stage 3: `aios://new?cwd=…&text=…&file=…` (ARCHITECTURE 3.3).
 *
 * - `parseAppUrl` (src/common/app-url.ts): shape, limits, unknown hosts, arguments to discard
 * - `findAppUrlInArgv`: picks up the URL from the argv of `second-instance` / launch
 * - `openFromAppUrl` (src/main/app-url.ts): discards only the arguments that do not pass the choke point, and creates a window without a project if there is no cwd. Does not send
 * - `AppUrlInbox`: queues before startup and flushes on `markReady`. Discards after `dispose`
 *
 * electron is not used. fs and creation are fake, injected.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_APP_URL_FILES,
  MAX_APP_URL_LENGTH,
  MAX_APP_URL_TEXT_BYTES,
  findAppUrlInArgv,
  parseAppUrl,
  type AppUrlNew
} from '../src/common/app-url.js'
import { AppUrlInbox, MAX_PENDING_APP_URLS, openFromAppUrl, type AppUrlOpenDeps } from '../src/main/app-url.js'
import type { CreateThreadInput, FolderNotice, Thread } from '../src/shared/thread.js'

function parsed(raw: string): AppUrlNew {
  const result = parseAppUrl(raw)
  if (!result.ok) throw new Error(`rejected: ${result.reason}`)
  return result.request
}

describe('parseAppUrl (TODO 976 stage 3)', () => {
  it('takes cwd / text / file (multiple); values are percent-decoded', () => {
    const request = parsed(
      'aios://new?cwd=/Users/me/proj&text=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF%0Anext&file=/tmp/a.txt&file=/tmp/b%20c.png'
    )
    expect(request).toEqual({
      action: 'new',
      cwd: '/Users/me/proj',
      text: 'こんにちは\nnext',
      files: ['/tmp/a.txt', '/tmp/b c.png'],
      dropped: []
    })
  })

  it('opens even without arguments (cwd is null = default); `aios://new/` and `aios:new` are the same', () => {
    for (const raw of ['aios://new', 'aios://new/', 'aios:new', 'AIOS://NEW?']) {
      expect(parsed(raw)).toEqual({ action: 'new', cwd: null, text: '', files: [], dropped: [] })
    }
  })

  it('accepts a file: URI as a path too', () => {
    expect(parsed('aios://new?cwd=file:///tmp/x&file=file:///tmp/x/a.md').cwd).toBe('file:///tmp/x')
  })

  it('drops the whole URL for an unknown host, an unknown route, a non-aios scheme, or a broken URL', () => {
    expect(parseAppUrl('aios://send?text=hi')).toEqual({ ok: false, reason: 'unknown-action' })
    expect(parseAppUrl('aios://new/extra?text=hi')).toEqual({ ok: false, reason: 'unknown-action' })
    expect(parseAppUrl('aios:///new')).toEqual({ ok: false, reason: 'unknown-action' })
    expect(parseAppUrl('https://new?text=hi')).toEqual({ ok: false, reason: 'not-app-url' })
    expect(parseAppUrl('aios://[bad')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('does not decode when the whole URL exceeds the limit', () => {
    const raw = `aios://new?text=${'a'.repeat(MAX_APP_URL_LENGTH)}`
    expect(parseAppUrl(raw)).toEqual({ ok: false, reason: 'too-long' })
  })

  it('silently ignores unknown queries (there is no send instruction either)', () => {
    const request = parsed('aios://new?text=hi&send=1&autoSubmit=true&model=x')
    expect(request).toEqual({ action: 'new', cwd: null, text: 'hi', files: [], dropped: [] })
  })

  it('drops only the argument for a relative path, a ~ prefix, or a path containing NUL', () => {
    const request = parsed('aios://new?cwd=proj&text=hi&file=~/a.txt&file=/tmp/ok&file=/tmp/a%00b')
    expect(request.cwd).toBeNull()
    expect(request.text).toBe('hi')
    expect(request.files).toEqual(['/tmp/ok'])
    expect(request.dropped).toEqual([
      { param: 'cwd', reason: 'not-absolute' },
      { param: 'file', reason: 'not-absolute' },
      { param: 'file', reason: 'not-absolute' }
    ])
  })

  it('text is UTF-8 up to the limit; beyond it only text is dropped (not truncated)', () => {
    const fits = 'あ'.repeat(Math.floor(MAX_APP_URL_TEXT_BYTES / 3))
    expect(parsed(`aios://new?text=${encodeURIComponent(fits)}`).text).toBe(fits)
    const over = parsed(`aios://new?cwd=/tmp&text=${encodeURIComponent(`${fits}ああ`)}`)
    expect(over.text).toBe('')
    expect(over.cwd).toBe('/tmp')
    expect(over.dropped).toEqual([{ param: 'text', reason: 'too-long' }])
  })

  it('only the first cwd and text count; a second identical file is dropped; an empty value is treated as absent', () => {
    const request = parsed('aios://new?cwd=&cwd=/a&cwd=/b&text=one&text=two&file=/f&file=/f&file=')
    expect(request.cwd).toBe('/a')
    expect(request.text).toBe('one')
    expect(request.files).toEqual(['/f'])
    expect(request.dropped).toEqual([
      { param: 'cwd', reason: 'duplicate' },
      { param: 'text', reason: 'duplicate' },
      { param: 'file', reason: 'duplicate' }
    ])
  })

  it('an invalid first cwd / text is dropped and the next is looked at (both are "the first valid one"; 976 review 3)', () => {
    const fits = 'あ'.repeat(Math.floor(MAX_APP_URL_TEXT_BYTES / 3))
    const tooLong = encodeURIComponent(`${fits}ああ`)
    const request = parsed(`aios://new?cwd=rel&cwd=/a&cwd=/b&text=${tooLong}&text=ok&text=later`)
    expect(request.cwd).toBe('/a')
    expect(request.text).toBe('ok')
    expect(request.dropped).toEqual([
      { param: 'cwd', reason: 'not-absolute' },
      { param: 'cwd', reason: 'duplicate' },
      { param: 'text', reason: 'too-long' },
      { param: 'text', reason: 'duplicate' }
    ])
  })

  it('the same file with a different spelling counts once (file: URI, trailing /, percent encoding; 976 review 4)', () => {
    const request = parsed('aios://new?file=/tmp/a.txt&file=file:///tmp/a.txt&file=/tmp/a.txt/&file=file:///tmp/a%2Etxt&file=/tmp/b c')
    expect(request.files).toEqual(['/tmp/a.txt', '/tmp/b c'])
    expect(request.dropped).toEqual([
      { param: 'file', reason: 'duplicate' },
      { param: 'file', reason: 'duplicate' },
      { param: 'file', reason: 'duplicate' }
    ])
  })

  it('NUL in text is dropped (reason is invalid); newlines and tabs are kept (976 review 5)', () => {
    const bad = parsed('aios://new?text=a%00b')
    expect(bad.text).toBe('')
    expect(bad.dropped).toEqual([{ param: 'text', reason: 'invalid' }])
    expect(parsed('aios://new?text=a%00b&text=next').text).toBe('next')
    expect(parsed('aios://new?text=a%0Ab%09c').text).toBe('a\nb\tc')
  })

  it('files go up to the limit; the excess is dropped and the reason is recorded only once', () => {
    const query = Array.from({ length: MAX_APP_URL_FILES + 5 }, (_, i) => `file=/tmp/${i}`).join('&')
    const request = parsed(`aios://new?${query}`)
    expect(request.files).toHaveLength(MAX_APP_URL_FILES)
    expect(request.dropped).toEqual([{ param: 'file', reason: 'too-many' }])
  })
})

describe('findAppUrlInArgv (TODO 976 stage 3)', () => {
  it('picks the first aios: from the second-instance argv (even with Chromium flags before and after)', () => {
    expect(
      findAppUrlInArgv(['/Applications/aios.app/Contents/MacOS/aios', '--allow-file-access', 'aios://new?cwd=/tmp', 'aios://new'])
    ).toBe('aios://new?cwd=/tmp')
    expect(findAppUrlInArgv(['aios.exe', 'AIOS://new'])).toBe('AIOS://new')
  })

  it('null if absent; URLs inside flag values and similar schemes are not picked', () => {
    expect(findAppUrlInArgv(['aios', '--user-data-dir=/tmp/x', '.'])).toBeNull()
    expect(findAppUrlInArgv(['aios', '--url=aios://new', 'aios-res://x', 'aiosx://new'])).toBeNull()
    expect(findAppUrlInArgv([])).toBeNull()
  })
})

/** `/ok/...` passes, and `/x/Library/...` is excluded. The directory is `/ok/dir`, the file is `/ok/dir/a.txt`. */
function fakeDeps(): AppUrlOpenDeps & {
  created: CreateThreadInput[]
  checked: string[]
  deferred: boolean[]
  notices: string[]
  firstFolders: Set<string>
} {
  const created: CreateThreadInput[] = []
  const checked: string[] = []
  const deferred: boolean[] = []
  const notices: string[] = []
  const firstFolders = new Set<string>()
  return {
    created,
    checked,
    deferred,
    notices,
    firstFolders,
    assertAllowed(uri: string): string {
      if (!uri.startsWith('file://')) throw new Error('unsupported scheme')
      const path = decodeURIComponent(uri.slice('file://'.length))
      checked.push(path)
      if (path.startsWith('/x/Library')) throw new Error('excluded')
      return path
    },
    async kindOf(path: string) {
      if (path === '/ok/dir') return 'directory'
      if (path === '/ok/dir/a.txt') return 'other'
      return null
    },
    async create(input: CreateThreadInput, options: { readonly deferCwdHistory: boolean }): Promise<Thread> {
      created.push(input)
      deferred.push(options.deferCwdHistory)
      return { id: 't-new' } as Thread
    },
    async folderNotice(cwdUri: string): Promise<FolderNotice | null> {
      notices.push(cwdUri)
      return firstFolders.has(cwdUri) ? { hooks: [{ uri: `${cwdUri}/.agent/settings.json`, names: ['SessionStart'] }], mcp: [] } : null
    }
  }
}

describe('openFromAppUrl (TODO 976 stage 3)', () => {
  it('creates in the cwd folder and only hands over the text and attachments (there is no path to send)', async () => {
    const deps = fakeDeps()
    const request = await openFromAppUrl(
      parsed('aios://new?cwd=/ok/dir&text=hello&file=/ok/dir/a.txt&file=file:///ok/dir/b.md'),
      deps
    )
    expect(deps.created).toEqual([{ cwdUri: 'file:///ok/dir' }])
    expect(request).toEqual({
      threadId: 't-new',
      created: true,
      draft: 'hello',
      attach: ['file:///ok/dir/a.txt', 'file:///ok/dir/b.md']
    })
  })

  it('if cwd is a file, uses the parent folder (same as a drop onto the Dock)', async () => {
    const deps = fakeDeps()
    await openFromAppUrl(parsed('aios://new?cwd=/ok/dir/a.txt'), deps)
    expect(deps.created).toEqual([{ cwdUri: 'file:///ok/dir' }])
  })

  it('if cwd is missing, excluded, or nonexistent, creates with the "new conversation" default (no membership)', async () => {
    const deps = fakeDeps()
    expect(await openFromAppUrl(parsed('aios://new'), deps)).toEqual({ threadId: 't-new', created: true })
    expect(deps.created).toEqual([{ scratch: true }])
  })

  it('when cwd fails, opens with no membership and puts the reason in the notice (shown in the band; 976 review 2)', async () => {
    for (const [raw, notice] of [
      ['aios://new?cwd=/x/Library/Caches', 'excluded'],
      ['aios://new?cwd=/nowhere', 'aios-reason:drop-not-found'],
      ['aios://new?cwd=proj', 'aios-reason:invalid-value']
    ] as const) {
      const deps = fakeDeps()
      const request = await openFromAppUrl(parsed(raw), deps)
      expect(deps.created).toEqual([{ scratch: true }])
      expect(request).toMatchObject({ threadId: 't-new', created: true })
      expect((request as { notice?: string }).notice).toContain(notice)
    }
  })

  it('a file that does not pass the gate is dropped individually (no stat under an exclusion)', async () => {
    const deps = fakeDeps()
    const kindOf = vi.spyOn(deps, 'kindOf')
    const request = await openFromAppUrl(parsed('aios://new?file=/x/Library/secret&file=/ok/dir/a.txt'), deps)
    expect(request).toEqual({ threadId: 't-new', created: true, attach: ['file:///ok/dir/a.txt'] })
    expect(kindOf).not.toHaveBeenCalled()
  })

  it('a path is correctly restored to a URI even if it contains %', async () => {
    const deps = fakeDeps()
    const request = await openFromAppUrl(parsed('aios://new?file=%2Fok%2F50%25%20off.txt'), deps)
    expect(request).toEqual({ threadId: 't-new', created: true, attach: ['file:///ok/50%25%20off.txt'] })
  })

  it('TODO 1118: for a first-time folder (with a notice), defers creating the working folder history until the first send', async () => {
    const deps = fakeDeps()
    deps.firstFolders.add('file:///ok/dir')
    const request = await openFromAppUrl(parsed('aios://new?cwd=/ok/dir&text=summarize'), deps)
    // Look up before creating (after creating, it is on the history and is no longer "first").
    expect(deps.notices).toEqual(['file:///ok/dir'])
    expect(deps.created).toEqual([{ cwdUri: 'file:///ok/dir' }])
    expect(deps.deferred).toEqual([true])
    // Does not send (the body is only handed over).
    expect(request).toEqual({ threadId: 't-new', created: true, draft: 'summarize' })
  })

  it('TODO 1118: a folder with no notice goes into the history at creation as before; no-membership is not looked up', async () => {
    const known = fakeDeps()
    await openFromAppUrl(parsed('aios://new?cwd=/ok/dir'), known)
    expect(known.deferred).toEqual([false])
    const scratch = fakeDeps()
    await openFromAppUrl(parsed('aios://new'), scratch)
    expect(scratch.notices).toEqual([])
    expect(scratch.deferred).toEqual([false])
  })

  it('TODO 1118: when the notice cannot be looked up (it threw), falls to the deferring side', async () => {
    const deps = fakeDeps()
    deps.folderNotice = async () => {
      throw new Error('boom')
    }
    await openFromAppUrl(parsed('aios://new?cwd=/ok/dir'), deps)
    expect(deps.deferred).toEqual([true])
  })

  it('hands over the reason when it cannot be created', async () => {
    const deps = fakeDeps()
    deps.create = async () => {
      throw new Error('aios-reason:backend-not-registered')
    }
    expect(await openFromAppUrl(parsed('aios://new?text=x'), deps)).toEqual({ reason: 'aios-reason:backend-not-registered' })
  })
})

describe('AppUrlInbox (TODO 976 stage 3)', () => {
  it('accumulates until markReady, then hands over one at a time in arrival order', () => {
    const handled: string[] = []
    const inbox = new AppUrlInbox((url) => handled.push(url))
    inbox.push('aios://new?text=1')
    inbox.push('aios://new?text=2')
    expect(handled).toEqual([])
    inbox.markReady()
    expect(handled).toEqual(['aios://new?text=1', 'aios://new?text=2'])
    inbox.push('aios://new?text=3')
    expect(handled).toHaveLength(3)
  })

  it('exceptions and rejections in handle do not leak out and later URLs are still delivered (976 review 8)', async () => {
    const handled: string[] = []
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const inbox = new AppUrlInbox((url) => {
      handled.push(url)
      if (url.endsWith('sync')) throw new Error('boom')
      if (url.endsWith('async')) return Promise.reject(new Error('boom'))
    })
    inbox.markReady()
    inbox.push('aios://new?text=sync')
    inbox.push('aios://new?text=async')
    inbox.push('aios://new?text=ok')
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)
    expect(handled).toHaveLength(3)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('accumulates only up to the limit before launch', () => {
    const handled: string[] = []
    const inbox = new AppUrlInbox((url) => handled.push(url))
    for (let i = 0; i < MAX_PENDING_APP_URLS + 3; i++) inbox.push(`aios://new?text=${i}`)
    inbox.markReady()
    expect(handled).toHaveLength(MAX_PENDING_APP_URLS)
  })

  it('after dispose, discards both accumulated and arriving ones (12.9)', () => {
    const handled: string[] = []
    const inbox = new AppUrlInbox((url) => handled.push(url))
    inbox.push('aios://new')
    inbox.dispose()
    inbox.markReady()
    inbox.push('aios://new')
    expect(handled).toEqual([])
  })
})
