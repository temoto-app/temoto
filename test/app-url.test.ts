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

describe('parseAppUrl (TODO 976 段 3)', () => {
  it('cwd / text / file (複数) を取る。値は % を解く', () => {
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

  it('引数なしでも開ける (cwd は null = 既定)。`aios://new/` と `aios:new` も同じ', () => {
    for (const raw of ['aios://new', 'aios://new/', 'aios:new', 'AIOS://NEW?']) {
      expect(parsed(raw)).toEqual({ action: 'new', cwd: null, text: '', files: [], dropped: [] })
    }
  })

  it('file: の URI もパスとして受ける', () => {
    expect(parsed('aios://new?cwd=file:///tmp/x&file=file:///tmp/x/a.md').cwd).toBe('file:///tmp/x')
  })

  it('知らない host・知らない道・aios 以外・壊れた URL は丸ごと捨てる', () => {
    expect(parseAppUrl('aios://send?text=hi')).toEqual({ ok: false, reason: 'unknown-action' })
    expect(parseAppUrl('aios://new/extra?text=hi')).toEqual({ ok: false, reason: 'unknown-action' })
    expect(parseAppUrl('aios:///new')).toEqual({ ok: false, reason: 'unknown-action' })
    expect(parseAppUrl('https://new?text=hi')).toEqual({ ok: false, reason: 'not-app-url' })
    expect(parseAppUrl('aios://[bad')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('URL 全体が上限を超えたら解かない', () => {
    const raw = `aios://new?text=${'a'.repeat(MAX_APP_URL_LENGTH)}`
    expect(parseAppUrl(raw)).toEqual({ ok: false, reason: 'too-long' })
  })

  it('知らないクエリは黙って無視する (送信の指示も無い)', () => {
    const request = parsed('aios://new?text=hi&send=1&autoSubmit=true&model=x')
    expect(request).toEqual({ action: 'new', cwd: null, text: 'hi', files: [], dropped: [] })
  })

  it('相対パス・~ 始まり・NUL を含むパスはその引数だけ捨てる', () => {
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

  it('text は UTF-8 で上限まで。超えたら text だけ捨てる (切り詰めない)', () => {
    const fits = 'あ'.repeat(Math.floor(MAX_APP_URL_TEXT_BYTES / 3))
    expect(parsed(`aios://new?text=${encodeURIComponent(fits)}`).text).toBe(fits)
    const over = parsed(`aios://new?cwd=/tmp&text=${encodeURIComponent(`${fits}ああ`)}`)
    expect(over.text).toBe('')
    expect(over.cwd).toBe('/tmp')
    expect(over.dropped).toEqual([{ param: 'text', reason: 'too-long' }])
  })

  it('cwd と text は最初の 1 つだけ。同じ file の 2 回目は捨てる。空の値は無かったことにする', () => {
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

  it('無効な最初の cwd / text は捨てて次を見る (どちらも「有効な最初の 1 つ」。976 review 3)', () => {
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

  it('同じ file は綴りが違っても 1 つ (file: URI・末尾の /・% エンコード。976 review 4)', () => {
    const request = parsed('aios://new?file=/tmp/a.txt&file=file:///tmp/a.txt&file=/tmp/a.txt/&file=file:///tmp/a%2Etxt&file=/tmp/b c')
    expect(request.files).toEqual(['/tmp/a.txt', '/tmp/b c'])
    expect(request.dropped).toEqual([
      { param: 'file', reason: 'duplicate' },
      { param: 'file', reason: 'duplicate' },
      { param: 'file', reason: 'duplicate' }
    ])
  })

  it('text の NUL は捨てる (理由は invalid)。改行とタブは残す (976 review 5)', () => {
    const bad = parsed('aios://new?text=a%00b')
    expect(bad.text).toBe('')
    expect(bad.dropped).toEqual([{ param: 'text', reason: 'invalid' }])
    expect(parsed('aios://new?text=a%00b&text=next').text).toBe('next')
    expect(parsed('aios://new?text=a%0Ab%09c').text).toBe('a\nb\tc')
  })

  it('file は上限まで。超えた分は捨て、理由は 1 回だけ残す', () => {
    const query = Array.from({ length: MAX_APP_URL_FILES + 5 }, (_, i) => `file=/tmp/${i}`).join('&')
    const request = parsed(`aios://new?${query}`)
    expect(request.files).toHaveLength(MAX_APP_URL_FILES)
    expect(request.dropped).toEqual([{ param: 'file', reason: 'too-many' }])
  })
})

describe('findAppUrlInArgv (TODO 976 段 3)', () => {
  it('second-instance の argv から最初の aios: を拾う (Chromium の旗が前後にあっても)', () => {
    expect(
      findAppUrlInArgv(['/Applications/aios.app/Contents/MacOS/aios', '--allow-file-access', 'aios://new?cwd=/tmp', 'aios://new'])
    ).toBe('aios://new?cwd=/tmp')
    expect(findAppUrlInArgv(['aios.exe', 'AIOS://new'])).toBe('AIOS://new')
  })

  it('無ければ null。旗の値の中の URL や似た scheme は拾わない', () => {
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

describe('openFromAppUrl (TODO 976 段 3)', () => {
  it('cwd のフォルダで作り、本文と添付は預けるだけ (送信の口は無い)', async () => {
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

  it('cwd がファイルなら親のフォルダ (Dock への Drop と同じ)', async () => {
    const deps = fakeDeps()
    await openFromAppUrl(parsed('aios://new?cwd=/ok/dir/a.txt'), deps)
    expect(deps.created).toEqual([{ cwdUri: 'file:///ok/dir' }])
  })

  it('cwd が無い・除外・存在しないなら「新しい会話」の既定 (所属なし) で作る', async () => {
    const deps = fakeDeps()
    expect(await openFromAppUrl(parsed('aios://new'), deps)).toEqual({ threadId: 't-new', created: true })
    expect(deps.created).toEqual([{ scratch: true }])
  })

  it('cwd が落ちたときは所属なしで開き、理由を notice に載せる (帯に出る。976 review 2)', async () => {
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

  it('関門を通らない file はその 1 件だけ捨てる (除外の下は stat もしない)', async () => {
    const deps = fakeDeps()
    const kindOf = vi.spyOn(deps, 'kindOf')
    const request = await openFromAppUrl(parsed('aios://new?file=/x/Library/secret&file=/ok/dir/a.txt'), deps)
    expect(request).toEqual({ threadId: 't-new', created: true, attach: ['file:///ok/dir/a.txt'] })
    expect(kindOf).not.toHaveBeenCalled()
  })

  it('パスは % を含んでも URI に正しく直る', async () => {
    const deps = fakeDeps()
    const request = await openFromAppUrl(parsed('aios://new?file=%2Fok%2F50%25%20off.txt'), deps)
    expect(request).toEqual({ threadId: 't-new', created: true, attach: ['file:///ok/50%25%20off.txt'] })
  })

  it('TODO 1118: 初めてのフォルダ (知らせがある) なら作業フォルダの履歴を最初の送信まで遅らせて作る', async () => {
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

  it('TODO 1118: 知らせが無いフォルダは今までどおり作成時に履歴へ。所属なしは引かない', async () => {
    const known = fakeDeps()
    await openFromAppUrl(parsed('aios://new?cwd=/ok/dir'), known)
    expect(known.deferred).toEqual([false])
    const scratch = fakeDeps()
    await openFromAppUrl(parsed('aios://new'), scratch)
    expect(scratch.notices).toEqual([])
    expect(scratch.deferred).toEqual([false])
  })

  it('TODO 1118: 知らせを引けなければ (投げた) 遅らせる側に倒す', async () => {
    const deps = fakeDeps()
    deps.folderNotice = async () => {
      throw new Error('boom')
    }
    await openFromAppUrl(parsed('aios://new?cwd=/ok/dir'), deps)
    expect(deps.deferred).toEqual([true])
  })

  it('作れなければ理由を預ける', async () => {
    const deps = fakeDeps()
    deps.create = async () => {
      throw new Error('aios-reason:backend-not-registered')
    }
    expect(await openFromAppUrl(parsed('aios://new?text=x'), deps)).toEqual({ reason: 'aios-reason:backend-not-registered' })
  })
})

describe('AppUrlInbox (TODO 976 段 3)', () => {
  it('markReady まで溜め、その後は届いた順に 1 つずつ渡す', () => {
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

  it('handle の例外・rejection は外へ漏らさず、後続の URL も届ける (976 review 8)', async () => {
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

  it('起動前に溜めるのは上限まで', () => {
    const handled: string[] = []
    const inbox = new AppUrlInbox((url) => handled.push(url))
    for (let i = 0; i < MAX_PENDING_APP_URLS + 3; i++) inbox.push(`aios://new?text=${i}`)
    inbox.markReady()
    expect(handled).toHaveLength(MAX_PENDING_APP_URLS)
  })

  it('dispose の後は溜めた分も届いた分も捨てる (12.9)', () => {
    const handled: string[] = []
    const inbox = new AppUrlInbox((url) => handled.push(url))
    inbox.push('aios://new')
    inbox.dispose()
    inbox.markReady()
    inbox.push('aios://new')
    expect(handled).toEqual([])
  })
})
