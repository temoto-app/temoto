/**
 * TODO 1319: after an automatic renderer reload the window's thread is opened again, and after the limit the window shows the failure page whose
 * "Load Again" button loads the app again (without a loop). The window is a fake (an event emitter), so no electron is needed.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { attachRendererRecovery, RECOVERY_MAX_RELOADS } from '../src/main/renderer-recovery.js'
import { RECOVERY_RELOAD_URL, isRecoveryReload, recoveryPageHtml, recoveryPageUrl, safeReason } from '../src/main/recovery-page.js'

const APP_URL = 'file:///app/out/renderer/index.html?aios-theme=light'

class FakeContents extends EventEmitter {
  url = APP_URL
  reloads = 0
  loads: string[] = []
  reloadThrows = false
  /** `loadURL` rejects (dev server down, build in progress). */
  loadRejects = false
  /** The new address is only the current one after a commit (`commit()`), as in Electron. */
  autoCommit = true
  getURL(): string {
    return this.url
  }
  reload(): void {
    if (this.reloadThrows) throw new Error('boom')
    this.reloads += 1
  }
  loadURL(url: string): Promise<void> {
    this.loads.push(url)
    if (this.loadRejects) return Promise.reject(new Error('ERR_CONNECTION_REFUSED'))
    if (this.autoCommit) this.url = url
    return Promise.resolve()
  }
}

function setup(options: { thread?: string | null; reopenThrows?: boolean; failureThrows?: boolean } = {}) {
  const contents = new FakeContents()
  const window = { webContents: contents, isDestroyed: () => false } as never
  let now = 1_000_000
  const shown: { thread: string | null } = { thread: options.thread === undefined ? 'thread-1' : options.thread }
  const reopened: string[] = []
  const dropped: number[] = []
  const failures: string[] = []
  const handle = attachRendererRecovery(window, {
    isShuttingDown: () => false,
    now: () => now,
    threadOf: () => shown.thread,
    dropReopen: () => {
      dropped.push(1)
    },
    reopenThread: (id) => {
      reopened.push(id)
      if (options.reopenThrows === true) throw new Error('reopen failed')
    },
    showFailure: (reason) => {
      failures.push(reason)
      if (options.failureThrows === true) throw new Error('page failed')
    }
  })
  const die = (reason = 'crashed'): void => {
    contents.emit('render-process-gone', {}, { reason, exitCode: 1 })
  }
  const loaded = (): void => {
    contents.emit('did-finish-load')
  }
  return { contents, handle, shown, reopened, dropped, failures, die, loaded, tick: (ms: number) => (now += ms) }
}

describe('reopening the thread after an automatic reload (TODO 1319)', () => {
  it('reopens the thread the window showed, once, when the page has loaded', () => {
    const t = setup()
    t.die()
    expect(t.contents.reloads).toBe(1)
    expect(t.reopened).toEqual(['thread-1'])
    t.loaded()
    expect(t.reopened).toEqual(['thread-1'])
  })

  it('opens nothing for a window that showed no thread', () => {
    const t = setup({ thread: null })
    t.die()
    t.loaded()
    expect(t.reopened).toEqual([])
  })

  it('each window keeps its own thread', () => {
    const a = setup({ thread: 'a' })
    const b = setup({ thread: 'b' })
    a.die()
    b.die()
    a.loaded()
    b.loaded()
    expect(a.reopened).toEqual(['a'])
    expect(b.reopened).toEqual(['b'])
  })

  it('does not reopen after a clean exit (no reload happened)', () => {
    const t = setup()
    t.die('clean-exit')
    t.loaded()
    expect(t.contents.reloads).toBe(0)
    expect(t.reopened).toEqual([])
  })

  it('a failing reopen is logged and ends there: no further reload, no failure page', () => {
    const t = setup({ reopenThrows: true })
    t.die()
    expect(() => t.loaded()).not.toThrow()
    expect(t.contents.reloads).toBe(1)
    expect(t.failures).toEqual([])
    expect(t.reopened).toEqual(['thread-1'])
  })

  it('a reload that throws leaves nothing to reopen', () => {
    const t = setup()
    t.contents.reloadThrows = true
    t.die()
    t.contents.reloadThrows = false
    t.loaded()
    expect(t.reopened).toEqual([])
  })
})

describe('the failure page after the limit (TODO 1319)', () => {
  function exhaust(t: ReturnType<typeof setup>): void {
    for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) {
      t.die()
      t.loaded()
    }
    t.die('oom')
  }

  it('shows the failure page with the reason once the limit is passed, and drops the queued reopen', () => {
    const t = setup()
    exhaust(t)
    expect(t.contents.reloads).toBe(RECOVERY_MAX_RELOADS)
    expect(t.failures).toEqual(['oom'])
    expect(t.dropped).toHaveLength(1)
    expect(t.reopened).toHaveLength(RECOVERY_MAX_RELOADS)
  })

  it('a renderer dying on the failure page itself is not recovered again (no loop)', () => {
    const t = setup()
    exhaust(t)
    t.die()
    t.die()
    expect(t.failures).toEqual(['oom'])
    expect(t.contents.reloads).toBe(RECOVERY_MAX_RELOADS)
  })

  it('"Load Again" loads the app address (not reload) and reopens no thread', () => {
    const t = setup()
    exhaust(t)
    t.contents.url = 'data:text/html;charset=utf-8,failure'
    t.handle.loadAgain()
    expect(t.contents.loads).toEqual([APP_URL])
    const before = t.reopened.length
    t.loaded()
    expect(t.reopened).toHaveLength(before)
  })

  it('"Load Again" is ignored when the failure page is not showing', () => {
    const t = setup()
    t.handle.loadAgain()
    expect(t.contents.loads).toEqual([])
  })

  it('dying again right after "Load Again" lands on the failure page again, not in a reload loop', () => {
    const t = setup()
    exhaust(t)
    t.handle.loadAgain()
    t.tick(1000)
    t.die()
    expect(t.contents.reloads).toBe(RECOVERY_MAX_RELOADS)
    expect(t.failures).toEqual(['oom', 'crashed'])
  })

  it('after the window has passed, "Load Again" earns a fresh round of automatic reloads, and each round needs another press', () => {
    const t = setup()
    exhaust(t)
    t.handle.loadAgain()
    t.tick(61_000)
    for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) t.die()
    expect(t.contents.reloads).toBe(RECOVERY_MAX_RELOADS * 2)
    t.die()
    expect(t.failures).toHaveLength(2)
  })

  it('a failure page that cannot be shown does not leave the window stuck in the failure state', () => {
    const t = setup({ failureThrows: true })
    exhaust(t)
    t.tick(61_000)
    t.die()
    expect(t.contents.reloads).toBe(RECOVERY_MAX_RELOADS + 1)
  })
})

describe('the failure page document (TODO 1319)', () => {
  const template = '<html lang="{{lang}}" data-theme="{{theme}}"><title>{{title}}</title><a href="{{reloadUrl}}">{{reload}}</a><p>{{reasonLabel}}: {{reason}}</p>{{unknown}}</html>'

  it('fills language, theme, wording and the reload address, in both languages', () => {
    const en = recoveryPageHtml(template, { locale: 'en', theme: 'dark', reason: 'oom' })
    expect(en).toContain('lang="en"')
    expect(en).toContain('data-theme="dark"')
    expect(en).toContain('Load Again')
    expect(en).toContain(RECOVERY_RELOAD_URL)
    expect(en).toContain('Reason code: oom')
    expect(en).toContain('{{unknown}}')
    const ja = recoveryPageHtml(template, { locale: 'ja', theme: 'light', reason: 'crashed' })
    expect(ja).toContain('lang="ja"')
    expect(ja).toContain('もう一度読み込む')
  })

  it('an odd reason never becomes markup', () => {
    expect(safeReason('crashed')).toBe('crashed')
    expect(safeReason('<script>alert(1)</script>')).toBe('unknown')
    expect(safeReason('')).toBe('unknown')
    expect(recoveryPageHtml(template, { locale: 'en', theme: 'light', reason: '"><img src=x>' })).not.toContain('<img')
  })

  it('only the exact reload address is the button', () => {
    expect(isRecoveryReload(RECOVERY_RELOAD_URL)).toBe(true)
    expect(isRecoveryReload(`${RECOVERY_RELOAD_URL}?x=1`)).toBe(false)
    expect(isRecoveryReload('https://example.com/')).toBe(false)
    expect(recoveryPageUrl('<p>é</p>').startsWith('data:text/html;charset=utf-8,')).toBe(true)
  })
})

describe('review fixes (wave 100 X)', () => {
  it('"Load Again" still works when the renderer died before the app page committed after an earlier "Load Again"', () => {
    const t = setup()
    for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) {
      t.die()
      t.loaded()
    }
    t.die('oom')
    // The failure page is what the window shows now, and the next load does not commit before the renderer dies again.
    t.contents.url = 'data:text/html;charset=utf-8,failure'
    t.contents.autoCommit = false
    t.handle.loadAgain()
    t.tick(61_000)
    t.die()
    t.die()
    t.die()
    t.die('oom')
    expect(t.failures).toHaveLength(2)
    t.contents.autoCommit = true
    t.handle.loadAgain()
    expect(t.contents.loads).toEqual([APP_URL, APP_URL])
  })

  it('never takes a data: address as the app address', () => {
    const t = setup({ thread: null })
    t.contents.url = 'data:text/html;charset=utf-8,failure'
    for (let i = 0; i <= RECOVERY_MAX_RELOADS; i++) t.die()
    t.handle.loadAgain()
    expect(t.contents.loads).toEqual([])
  })

  it('keeps the queued thread when the renderer dies again during the reload (the view is already closed)', () => {
    const t = setup()
    t.die()
    t.shown.thread = null
    t.die()
    t.loaded()
    expect(t.reopened).toEqual(['thread-1'])
    expect(t.dropped).toEqual([])
    expect(t.contents.reloads).toBe(2)
  })

  it('drops the queued thread at the limit', () => {
    const t = setup()
    t.die()
    t.shown.thread = null
    t.die()
    t.die()
    t.die()
    expect(t.failures).toEqual(['crashed'])
    expect(t.dropped).toHaveLength(1)
  })

  it('puts the failure page back when "Load Again" cannot load the app page', async () => {
    const t = setup()
    for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) {
      t.die()
      t.loaded()
    }
    t.die('oom')
    t.contents.loadRejects = true
    t.handle.loadAgain()
    await Promise.resolve()
    await Promise.resolve()
    expect(t.failures).toEqual(['oom', 'oom'])
    // The button works again once the page can be loaded.
    t.contents.loadRejects = false
    t.handle.loadAgain()
    expect(t.contents.loads).toEqual([APP_URL, APP_URL])
  })

  it('does not put the failure page back when the window was destroyed in the meantime', async () => {
    const contents = new FakeContents()
    let destroyed = false
    const failures: string[] = []
    const handle = attachRendererRecovery({ webContents: contents, isDestroyed: () => destroyed } as never, {
      isShuttingDown: () => false,
      showFailure: (r) => failures.push(r)
    })
    for (let i = 0; i <= RECOVERY_MAX_RELOADS; i++) contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    contents.loadRejects = true
    handle.loadAgain()
    destroyed = true
    await Promise.resolve()
    await Promise.resolve()
    expect(failures).toHaveLength(1)
  })
})
