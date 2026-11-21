/**
 * Regression for ViewerPane's web page (TODO 400, ARCHITECTURE 5.2.1). Neither the model nor electron is used: a fake WebContentsView / WebContents is passed to `WebViewHost` in main.
 *
 * - URL judgment (`isWebViewerUrl` / `webLinkTarget`): one and the same in renderer and main
 * - refusing moves inside the page (`will-navigate` / `will-redirect`), and sorting of new windows (`setWindowOpenHandler`)
 * - `did-navigate` 'replace or new step', sending keys back, the copy taken before hiding, and cleanup on close
 * - the 'hide / restore' judgment for stacking order (`web-cover.ts`), and the replacement of the viewer history (`viewer-history.ts`)
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { isEmbedRefusedLogin, isWebViewerUrl, webLinkTarget } from '../src/shared/open-external.js'
import {
  matchWebShortcut,
  plainUserAgent,
  sanitizeWebShortcuts,
  toViewBounds,
  webShortcutFocusesRendererInput,
  windowOpenDecision,
  type WebViewEvent
} from '../src/shared/web-view.js'
import { WebViewHost, navigationDecision, type WebViewLike } from '../src/main/web/host.js'
import { rectsOverlap, shouldHideWebView } from '../src/renderer/src/web-cover.js'
import { EMPTY_HISTORY, recordVisit, stepHistory } from '../src/renderer/src/viewer-history.js'
import { webViewShortcuts } from '../src/renderer/src/shortcuts.js'

describe('isWebViewerUrl / webLinkTarget', () => {
  it('shows only http: / https: as a page', () => {
    expect(isWebViewerUrl('https://example.com/a?b=1#c')).toBe(true)
    expect(isWebViewerUrl('http://localhost:8000/')).toBe(true)
    for (const url of [
      'mailto:a@example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'aios-res://local/x',
      'ftp://example.com/',
      'https://user:pass@example.com/',
      '/relative',
      'x'.repeat(9000),
      42,
      null
    ]) {
      expect(isWebViewerUrl(url), String(url).slice(0, 40)).toBe(false)
    }
  })

  it('a plain click is the viewer, shift / ⌘ / Ctrl is the OS browser, mailto goes outside, and others do nothing', () => {
    expect(webLinkTarget('https://example.com/')).toBe('viewer')
    expect(webLinkTarget('https://example.com/', { shiftKey: true })).toBe('external')
    expect(webLinkTarget('https://example.com/', { metaKey: true })).toBe('external')
    expect(webLinkTarget('https://example.com/', { ctrlKey: true })).toBe('external')
    expect(webLinkTarget('mailto:a@example.com')).toBe('external')
    expect(webLinkTarget('https://u:p@example.com/')).toBe('external')
    expect(webLinkTarget('javascript:alert(1)')).toBe('none')
    expect(webLinkTarget('file:///x')).toBe('none')
  })
})

describe('pure functions of shared/web-view', () => {
  const table = sanitizeWebShortcuts([
    { id: 'webFind', key: 'f', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
    { id: 'files', key: 'f', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
    { id: 'bad', key: 'x' },
    'nope'
  ])

  it('the table keeps only rows of the right shape', () => {
    expect(table.map((row) => row.id)).toEqual(['webFind', 'files'])
    expect(sanitizeWebShortcuts('x')).toEqual([])
  })

  it("matches only an exact match of the keyDown modifiers (also Shift's capital letters)", () => {
    const base = { type: 'keyDown', meta: true, control: false, alt: false }
    expect(matchWebShortcut({ ...base, key: 'f', shift: false }, table)).toBe('webFind')
    expect(matchWebShortcut({ ...base, key: 'F', shift: true }, table)).toBe('files')
    expect(matchWebShortcut({ ...base, type: 'keyUp', key: 'f', shift: false }, table)).toBeNull()
    expect(matchWebShortcut({ ...base, key: 'f', shift: false, alt: true }, table)).toBeNull()
  })

  it('the rectangle is multiplied by the scale, clipped to the content area, and broken values are discarded', () => {
    expect(toViewBounds({ x: 10, y: 20, width: 100, height: 50 }, 1, { width: 1000, height: 800 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50
    })
    expect(toViewBounds({ x: 10, y: 20, width: 100, height: 50 }, 1.5, { width: 1000, height: 800 })).toEqual({
      x: 15,
      y: 30,
      width: 150,
      height: 75
    })
    expect(toViewBounds({ x: 900, y: 0, width: 300, height: 10 }, 1, { width: 1000, height: 800 })?.width).toBe(100)
    expect(toViewBounds({ x: Number.NaN, y: 0, width: 1, height: 1 }, 1, { width: 10, height: 10 })).toBeNull()
    expect(toViewBounds({ x: 0, y: 0, width: -1, height: 1 }, 1, { width: 10, height: 10 })).toBeNull()
    expect(toViewBounds(null, 1, { width: 10, height: 10 })).toBeNull()
  })

  it('new window: a plain target=_blank is the same view, ⌘ / shift / window.open go outside, and non-http(s) is stopped', () => {
    expect(windowOpenDecision('allow', 'foreground-tab')).toBe('same-view')
    expect(windowOpenDecision('allow', 'default')).toBe('same-view')
    expect(windowOpenDecision('allow', 'background-tab')).toBe('external')
    expect(windowOpenDecision('allow', 'new-window')).toBe('external')
    expect(windowOpenDecision('external', 'foreground-tab')).toBe('external')
    expect(windowOpenDecision('deny', 'foreground-tab')).toBe('deny')
  })

  it('TODO 588: only a send-back that focuses a field is true (⌘L / ⌘T / ⌘F / ⌘⇧F family); ⌘R, ⌃Tab, and back / forward are false', () => {
    for (const id of ['webFocusAddress', 'webNewTab', 'webFind', 'files', 'names', 'conversation']) {
      expect(webShortcutFocusesRendererInput(id), id).toBe(true)
    }
    for (const id of ['webReload', 'webNextTab', 'webPrevTab', 'viewerBack', 'viewerForward', 'unknown']) {
      expect(webShortcutFocusesRendererInput(id), id).toBe(false)
    }
  })

  it('removes Electron and the product name from the User-Agent', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) aios/0.21.0 Chrome/140.0.0.0 Electron/44.4.3 Safari/537.36'
    expect(plainUserAgent(ua, 'aios')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    )
  })
})

/** A fake WebContents. A listener registered with `on` can be called with `emit`. */
class FakeContents extends EventEmitter {
  url = ''
  loaded: string[] = []
  destroyed = false
  closedCount = 0
  reloads = 0
  finds: { text: string; options: unknown }[] = []
  stopFinds = 0
  openHandler: ((details: { url: string; disposition: string }) => { action: 'deny' }) | null = null
  captureResult: { isEmpty(): boolean; toJPEG(q: number): Uint8Array } = {
    isEmpty: () => false,
    toJPEG: () => new Uint8Array([1, 2, 3])
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    this.url = url
    return Promise.resolve()
  }
  getURL(): string {
    return this.url
  }
  reload(): void {
    this.reloads++
  }
  stop(): void {}
  focus(): void {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.closedCount++
    this.destroyed = true
  }
  findInPage(text: string, options: unknown): number {
    this.finds.push({ text, options })
    return 1
  }
  stopFindInPage(): void {
    this.stopFinds++
  }
  capturePage(): Promise<{ isEmpty(): boolean; toJPEG(q: number): Uint8Array }> {
    return Promise.resolve(this.captureResult)
  }
  setWindowOpenHandler(handler: (details: { url: string; disposition: string }) => { action: 'deny' }): void {
    this.openHandler = handler
  }
}

class FakeView {
  readonly webContents = new FakeContents()
  bounds: unknown = null
  visible: boolean[] = []
  setBounds(bounds: unknown): void {
    this.bounds = bounds
  }
  setVisible(visible: boolean): void {
    this.visible.push(visible)
  }
}

function setup(): {
  host: WebViewHost
  views: FakeView[]
  removed: FakeView[]
  events: WebViewEvent[]
  external: string[]
  /** The number of calls of the `focusRenderer` dep (TODO 588). Check the array's length: destructuring the value directly would freeze it. */
  focusRendererCalls: number[]
} {
  const views: FakeView[] = []
  const removed: FakeView[] = []
  const events: WebViewEvent[] = []
  const external: string[] = []
  const focusRendererCalls: number[] = []
  const host = new WebViewHost({
    createView: () => {
      const view = new FakeView()
      views.push(view)
      return view as unknown as WebViewLike
    },
    removeView: (view) => removed.push(view as unknown as FakeView),
    openExternal: (url) => external.push(url),
    send: (event) => events.push(event),
    zoom: () => 1,
    contentSize: () => ({ width: 1200, height: 800 }),
    focusRenderer: () => {
      focusRendererCalls.push(1)
    }
  })
  return { host, views, removed, events, external, focusRendererCalls }
}

/** A fake of the first argument of electron's `will-navigate`. */
function navEvent(url: string): { url: string; prevented: boolean; preventDefault(): void } {
  return {
    url,
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
}

describe('WebViewHost (fake electron)', () => {
  it('load is only http(s); creates the view at the first load and applies a rectangle that arrived earlier', () => {
    const { host, views } = setup()
    host.setBounds({ x: 300, y: 40, width: 500, height: 600 })
    expect(host.load('file:///etc/passwd')).toBe(false)
    expect(host.load('javascript:alert(1)')).toBe(false)
    expect(views).toHaveLength(0)
    expect(host.load('https://example.com/')).toBe(true)
    expect(views).toHaveLength(1)
    expect(views[0]?.webContents.loaded).toEqual(['https://example.com/'])
    expect(views[0]?.bounds).toEqual({ x: 300, y: 40, width: 500, height: 600 })
    expect(navigationDecision('https://a.example/')).toBe('allow')
    expect(navigationDecision('mailto:x@example.com')).toBe('external')
    expect(navigationDecision('file:///x')).toBe('deny')
  })

  it('will-navigate / will-redirect: stops anything but http(s); mailto goes to the OS', () => {
    const { host, views, external } = setup()
    host.load('https://example.com/')
    const contents = views[0]!.webContents
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'aios-plugin://aios.text/index.html', 'data:text/html,x']) {
      const event = navEvent(url)
      contents.emit('will-navigate', event)
      expect(event.prevented, url).toBe(true)
    }
    const redirect = navEvent('file:///Users/x/secret')
    contents.emit('will-redirect', redirect)
    expect(redirect.prevented).toBe(true)
    const mail = navEvent('mailto:a@example.com')
    contents.emit('will-navigate', mail)
    expect(mail.prevented).toBe(true)
    expect(external).toEqual(['mailto:a@example.com'])
    const ok = navEvent('https://example.com/next')
    contents.emit('will-navigate', ok)
    expect(ok.prevented).toBe(false)
  })

  it('did-navigate: the result of our own load replaces, a link inside the page is a new step, and in-page navigation replaces', () => {
    const { host, views, events } = setup()
    host.load('http://example.com')
    const contents = views[0]!.webContents
    contents.emit('did-navigate', {}, 'https://example.com/', 200, 'OK')
    contents.emit('will-navigate', navEvent('https://example.com/b'))
    contents.emit('did-navigate', {}, 'https://example.com/b', 200, 'OK')
    contents.emit('did-navigate-in-page', {}, 'https://example.com/b#x', true)
    contents.emit('did-navigate-in-page', {}, 'https://ads.example/frame#y', false)
    expect(events.filter((event) => event.kind === 'navigated')).toEqual([
      { kind: 'navigated', url: 'https://example.com/', replace: true },
      { kind: 'navigated', url: 'https://example.com/b', replace: false },
      { kind: 'navigated', url: 'https://example.com/b#x', replace: true }
    ])
  })

  it('TODO 857: when a Google login screen appears, opens the URL where navigation started (including after #) in the default browser only once', () => {
    const { host, views, external } = setup()
    const draft = 'https://mail.google.com/mail/?authuser=a@example.com#all?compose=thread-a:r-1'
    host.load(draft)
    const contents = views[0]!.webContents
    // If already logged in, ServiceLogin is a pass-through relay: it does not stop it and does not send it outside (822).
    const passive = navEvent('https://accounts.google.com/ServiceLogin?passive=1209600&continue=x')
    contents.emit('will-redirect', passive)
    expect(passive.prevented).toBe(false)
    contents.emit('did-navigate', {}, 'https://mail.google.com/mail/u/0/', 200, 'OK')
    expect(external).toEqual([])
    // A login was asked for: the original URL goes outside. It is not opened twice on a move to the refusal screen.
    host.load(draft)
    contents.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/identifier?continue=x', 200, 'OK')
    contents.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/rejected?continue=x', 200, 'OK')
    expect(external).toEqual([draft])
    expect(isEmbedRefusedLogin('https://accounts.google.com/signin/v2/identifier')).toBe(true)
    expect(isEmbedRefusedLogin('https://accounts.google.com/ServiceLogin')).toBe(false)
    expect(isEmbedRefusedLogin('https://accounts.google.com.evil.example/v3/signin/')).toBe(false)
    expect(isEmbedRefusedLogin('https://mail.google.com/mail/')).toBe(false)
  })

  it('TODO 857: even if a 「ログイン」 link inside the page leads to the login screen, what opens is the first URL (not the login screen)', () => {
    const { host, views, external } = setup()
    const draft = 'https://mail.google.com/mail/?authuser=a@example.com#all?compose=thread-a:r-1'
    host.load(draft)
    const contents = views[0]!.webContents
    contents.emit('did-navigate', {}, 'https://workspace.google.com/gmail/', 200, 'OK')
    contents.emit('will-navigate', navEvent('https://accounts.google.com/v3/signin/identifier?continue=x'))
    contents.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/rejected?continue=x', 200, 'OK')
    expect(external).toEqual([draft])
  })

  it('new windows are always denied; a plain _blank loads in the same view (a new step), and ⌘ / shift go to the OS browser', () => {
    const { host, views, external, events } = setup()
    host.load('https://example.com/')
    const contents = views[0]!.webContents
    expect(contents.openHandler?.({ url: 'https://other.example/', disposition: 'foreground-tab' })).toEqual({
      action: 'deny'
    })
    expect(contents.loaded.at(-1)).toBe('https://other.example/')
    contents.emit('did-navigate', {}, 'https://other.example/', 200, 'OK')
    expect(events.at(-1)).toEqual({ kind: 'navigated', url: 'https://other.example/', replace: false })
    expect(contents.openHandler?.({ url: 'https://third.example/', disposition: 'background-tab' })).toEqual({
      action: 'deny'
    })
    expect(contents.openHandler?.({ url: 'file:///etc/passwd', disposition: 'foreground-tab' })).toEqual({
      action: 'deny'
    })
    expect(external).toEqual(['https://third.example/'])
    expect(contents.loaded).toEqual(['https://example.com/', 'https://other.example/'])
  })

  it('before-input-event: keys in the table are not passed to the page and the id is sent; other keys pass through', () => {
    const { host, views, events } = setup()
    host.setShortcuts(webViewShortcuts('mac'))
    host.load('https://example.com/')
    const contents = views[0]!.webContents
    let prevented = false
    const event = { preventDefault: () => (prevented = true) }
    contents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'f',
      meta: true,
      control: false,
      shift: false,
      alt: false
    })
    expect(prevented).toBe(true)
    expect(events.at(-1)).toEqual({ kind: 'shortcut', id: 'webFind' })
    prevented = false
    contents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'a',
      meta: true,
      control: false,
      shift: false,
      alt: false
    })
    expect(prevented).toBe(false)
  })

  it("TODO 588: a send-back that focuses a field (⌘F / ⌘L / ⌘T) returns focus to the window's renderer; ⌘R stays with the page", () => {
    const { host, views, focusRendererCalls } = setup()
    host.setShortcuts(webViewShortcuts('mac'))
    host.load('https://example.com/')
    const contents = views[0]!.webContents
    const event = { preventDefault: () => {} }
    const key = (k: string) => ({ type: 'keyDown', key: k, meta: true, control: false, shift: false, alt: false })
    contents.emit('before-input-event', event, key('f')) // ⌘F → webFind
    expect(focusRendererCalls).toHaveLength(1)
    contents.emit('before-input-event', event, key('l')) // ⌘L → webFocusAddress
    expect(focusRendererCalls).toHaveLength(2)
    contents.emit('before-input-event', event, key('t')) // ⌘T → webNewTab
    expect(focusRendererCalls).toHaveLength(3)
    contents.emit('before-input-event', event, key('r')) // ⌘R -> webReload (not moved to the field, so not called)
    expect(focusRendererCalls).toHaveLength(3)
  })

  it('did-fail-load notifies only for a main frame error other than ERR_ABORTED; found-in-page only the final value', () => {
    const { host, views, events } = setup()
    host.load('https://example.com/')
    const contents = views[0]!.webContents
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/', true)
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://sub.example/', false)
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/', true)
    contents.emit('found-in-page', {}, { matches: 3, activeMatchOrdinal: 1, finalUpdate: false })
    contents.emit('found-in-page', {}, { matches: 4, activeMatchOrdinal: 2, finalUpdate: true })
    expect(events).toEqual([
      { kind: 'failed', code: -105, url: 'https://example.com/' },
      { kind: 'found', matches: 4, active: 2 }
    ])
  })

  it('hide: hides after taking a snapshot; if a "show" arrives while taking it, does not hide', async () => {
    const { host, views } = setup()
    host.load('https://example.com/')
    const view = views[0]!
    await host.setVisible(true, false)
    const image = await host.setVisible(false, true)
    expect(image).toBe('data:image/jpeg;base64,AQID')
    expect(view.visible.at(-1)).toBe(false)
    const pending = host.setVisible(false, true)
    await host.setVisible(true, false)
    expect(await pending).toBeNull()
    expect(view.visible.at(-1)).toBe(true)
  })

  it('close: removes the view and closes the webContents; drops later notices and does not create after dispose', () => {
    const { host, views, removed, events } = setup()
    host.load('https://example.com/')
    const view = views[0]!
    host.close()
    expect(removed).toEqual([view])
    expect(view.webContents.closedCount).toBe(1)
    view.webContents.emit('did-stop-loading')
    expect(events).toEqual([])
    host.load('https://example.com/again')
    expect(views).toHaveLength(2)
    host.dispose()
    expect(host.load('https://example.com/x')).toBe(false)
    expect(views).toHaveLength(2)
  })
})

describe('stacking order (web-cover)', () => {
  const view = { left: 400, top: 40, right: 1200, bottom: 800 }

  it('hides when a cover overlaps the page and restores when it leaves', () => {
    expect(shouldHideWebView(view, [])).toBe(false)
    // The balloon runs from under the heading onto the page.
    expect(shouldHideWebView(view, [{ left: 900, top: 30, right: 1000, bottom: 60 }])).toBe(true)
    // The sidebar's right-click menu (outside the page)
    expect(shouldHideWebView(view, [{ left: 10, top: 100, right: 200, bottom: 300 }])).toBe(false)
    // Only touching edges do not overlap.
    expect(rectsOverlap(view, { left: 0, top: 0, right: 400, bottom: 40 })).toBe(false)
    // A cover with no size is not counted.
    expect(shouldHideWebView(view, [{ left: 500, top: 100, right: 500, bottom: 100 }])).toBe(false)
  })

  it('hides when the pane is hidden and the rectangle is empty', () => {
    expect(shouldHideWebView({ left: 0, top: 0, right: 0, bottom: 0 }, [])).toBe(true)
  })
})

describe('viewer history and web pages (TODO 400)', () => {
  const visit = (uri: string, replace = false) => ({ uri, highlight: null, now: 0, byKeys: false, replace })

  it('replacing rewrites the current step and keeps later steps', () => {
    let history = recordVisit(EMPTY_HISTORY, visit('file:///a.md'))
    history = recordVisit(history, visit('http://example.com'))
    history = recordVisit(history, visit('https://example.com/', true))
    expect(history.entries.map((entry) => entry.uri)).toEqual(['file:///a.md', 'https://example.com/'])
    history = recordVisit(history, visit('https://example.com/b'))
    // Even with a URL from re-reading after going back (a redirect), 'forward' does not disappear.
    const back = stepHistory(history, 'https://example.com/b', 'back')!
    history = recordVisit(back.history, visit('https://www.example.com/', true))
    expect(history.entries.map((entry) => entry.uri)).toEqual([
      'file:///a.md',
      'https://www.example.com/',
      'https://example.com/b'
    ])
    expect(history.index).toBe(1)
  })
})

describe('webViewShortcuts', () => {
  it('adds in-page search and reload to the three search ones and back / forward, and removes save and the mouse buttons', () => {
    const ids = webViewShortcuts('mac').map((row) => row.id)
    expect(ids).toContain('webFind')
    expect(ids).toContain('webReload')
    expect(ids).toContain('files')
    expect(ids).toContain('viewerBack')
    expect(ids).not.toContain('save')
    const find = webViewShortcuts('other').find((row) => row.id === 'webFind')
    expect(find).toMatchObject({ key: 'f', ctrlKey: true, metaKey: false })
  })
})
