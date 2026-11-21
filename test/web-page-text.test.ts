/**
 * Regression for an AI reading the text of an open Web tab (TODO 1052, ARCHITECTURE 5.2.1 / 7.6.2). Neither the model nor electron is used:
 * a fake WebContentsView / WebContents is passed to `WebViewHost`, and a thin fake host to `GatewayRequests`.
 *
 * - pure functions of `page-text.ts` (cut at UTF-8 byte positions, tidying, checking the returned values, choosing the tab), and the same cap as the gateway
 * - `WebViewHost.readTabText`: reads from a live view; a tab evicted by LRU is loaded again without being shown (the shown view is neither replaced nor evicted);
 *   if the pane is not showing, it closes after reading; a failed page, or a fake that cannot run JS, refuses
 * - `getOpenUrlText` of `GatewayRequests`: asks for consent only the first time; if refused, it does not read; it does not read a URL that is not open (it does not draw in the background);
 *   right after `openUrl` it waits for the tab; cutting out the text; `webTabs` of `listOpenFiles`
 */
import { isLoginPageUrl } from '../src/shared/open-external.js'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_TEXT_SLICE_BYTES,
  MAX_PAGE_TEXT_CHARS,
  MAX_PAGE_TEXT_SLICE_BYTES,
  PAGE_TEXT_PROBE,
  PAGE_TEXT_SCRIPT,
  PAGE_TEXT_WORLD_ID,
  parsePageText,
  pickWebTab,
  slicePageText,
  tidyPageText,
  type ReadableWebTab,
  type TabTextOutcome,
  looksLikeLoginPage
} from '../src/main/web/page-text.js'
import { WebViewHost, WEB_LIVE_VIEWS, type WebViewLike } from '../src/main/web/host.js'
import { DEFAULT_TEXT_BYTES, MAX_TEXT_BYTES } from '../src/gateway/respond.js'
import { getOpenUrlTextInput } from '../src/gateway/viewer-schemas.js'
import {
  describeInView,
  GatewayRequests,
  WEB_TAB_READ_CONSENT_SUMMARY,
  type GatewayRequestHost
} from '../src/main/session/gateway-requests.js'
import type { ApprovalRequestInput, ApprovalResult } from '../src/main/approval/broker.js'
import type { AiosEvent } from '../src/shared/agent.js'
import type { Thread } from '../src/shared/thread.js'
import type { ViewerShownReport } from '../src/shared/viewer-shown.js'
import { WEB_TAB_READ_CONSENT } from '../src/common/settings-keys.js'

describe('pure functions of page-text', () => {
  it('the body is cut at UTF-8 byte positions without cutting in the middle of a character', () => {
    const text = 'abあいう' // a b (1+1) + 3 characters × 3 bytes = 11 bytes
    expect(slicePageText(text, 0, 100)).toEqual({
      text,
      offset: 0,
      bytes: 11,
      total: 11,
      next_offset: null,
      truncated: false
    })
    // From byte 3 (the start of the second character) for 4 bytes: the second character plus 1 byte ends mid-character, so only the second character is returned.
    expect(slicePageText(text, 2, 4)).toMatchObject({ text: 'あ', offset: 2, bytes: 3, next_offset: 5, truncated: true })
    // If it starts in the middle of a character, it moves to the head of the next character.
    expect(slicePageText(text, 3, 3)).toMatchObject({ text: 'い', offset: 5, next_offset: 8 })
    // Past the end it is empty, and there is nothing after.
    expect(slicePageText(text, 50, 10)).toMatchObject({ text: '', offset: 11, next_offset: null, truncated: false })
    // Following the continuation reads everything once each.
    let offset: number | null = 0
    let joined = ''
    while (offset !== null) {
      const slice = slicePageText(text, offset, 4)
      joined += slice.text
      offset = slice.next_offset
    }
    expect(joined).toBe(text)
  })

  it('tidying: drops trailing whitespace on lines, 3 or more blank lines, and leading and trailing whitespace', () => {
    expect(tidyPageText('  a  \r\n\r\n\r\n\nb\t\n \n')).toBe('a\n\nb')
  })

  it('validating the returned value: null if the shape differs, and the title and body are cut at the limit', () => {
    expect(parsePageText(null)).toBeNull()
    expect(parsePageText({ title: 'x' })).toBeNull()
    expect(parsePageText('text')).toBeNull()
    expect(parsePageText({ title: 42, text: 'b' })).toEqual({ title: '', text: 'b', clipped: false })
    const long = parsePageText({ title: 't'.repeat(900), text: 'x'.repeat(MAX_PAGE_TEXT_CHARS + 5) })
    expect(long?.title.length).toBe(500)
    expect(long?.text.length).toBe(MAX_PAGE_TEXT_CHARS)
    expect(long?.clipped).toBe(true)
  })

  it('the injected JS is a fixed statement in the app and returns only the page body (innerText) and the title', () => {
    expect(PAGE_TEXT_SCRIPT).toContain('innerText')
    expect(PAGE_TEXT_SCRIPT).toContain('document.title')
    expect(PAGE_TEXT_PROBE).toContain('innerText.length')
    expect(PAGE_TEXT_WORLD_ID).not.toBe(0)
    expect(PAGE_TEXT_WORLD_ID).not.toBe(999)
  })

  it('choosing a tab: tabId / URL (exact match → ignoring # and a trailing /) / the previous tab if neither; a URL that is not open is not chosen', () => {
    const tabs: ReadableWebTab[] = [
      { tabId: 't1', url: 'https://a.example/x', title: 'A', active: false },
      { tabId: 't2', url: 'https://b.example/pr/1/#c', title: 'B', active: true }
    ]
    expect(pickWebTab([], {})).toEqual({ ok: false, reason: 'no-tabs' })
    expect(pickWebTab(tabs, {})).toMatchObject({ ok: true, tab: { tabId: 't2' } })
    expect(pickWebTab(tabs, { tabId: 't1' })).toMatchObject({ ok: true, tab: { tabId: 't1' } })
    expect(pickWebTab(tabs, { tabId: 't9' })).toEqual({ ok: false, reason: 'no-such-tab' })
    expect(pickWebTab(tabs, { url: 'https://a.example/x' })).toMatchObject({ ok: true, tab: { tabId: 't1' } })
    expect(pickWebTab(tabs, { url: 'https://b.example/pr/1' })).toMatchObject({ ok: true, tab: { tabId: 't2' } })
    expect(pickWebTab(tabs, { url: 'https://evil.example/' })).toEqual({ ok: false, reason: 'no-matching-url' })
  })

  it("the length returned at once is the same value as the gateway's getDocumentText; the gateway's input shape has the same limit", () => {
    expect(DEFAULT_PAGE_TEXT_SLICE_BYTES).toBe(DEFAULT_TEXT_BYTES)
    expect(MAX_PAGE_TEXT_SLICE_BYTES).toBe(MAX_TEXT_BYTES)
    expect(getOpenUrlTextInput.safeParse({}).success).toBe(true)
    expect(getOpenUrlTextInput.safeParse({ url: 'https://a.example/', offset: 10, length: 1024 }).success).toBe(true)
    expect(getOpenUrlTextInput.safeParse({ length: MAX_TEXT_BYTES + 1 }).success).toBe(false)
    expect(getOpenUrlTextInput.safeParse({ offset: -1 }).success).toBe(false)
    expect(getOpenUrlTextInput.safeParse({ tabId: '' }).success).toBe(false)
  })

  it('there is one consent key in the app settings, the default is not consented, and the owner is main', () => {
    expect(WEB_TAB_READ_CONSENT.parse(null)).toBe(false)
    expect(WEB_TAB_READ_CONSENT.parse('true')).toBe(true)
    expect(WEB_TAB_READ_CONSENT.owner).toBe('main')
  })
})

// ---------------------------------------------------------------------------
// WebViewHost.readTabText
// ---------------------------------------------------------------------------

class FakeContents extends EventEmitter {
  url = ''
  loaded: string[] = []
  destroyed = false
  loading = false
  scripts: { world: number; code: string }[] = []
  /** The body of the page (the value that the injected JS returns). */
  page: { title: string; text: string; loginForm?: boolean; loginFormChars?: number } = { title: 'PR 1', text: 'hello' }
  /** Whether to give the fake a way to run JS (the fake of TODO 400 does not have one). */
  scriptable = true
  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    this.url = url
    return Promise.resolve()
  }
  getURL(): string {
    return this.url
  }
  reload(): void {}
  stop(): void {}
  focus(): void {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  isLoading(): boolean {
    return this.loading
  }
  close(): void {
    this.destroyed = true
  }
  findInPage(): number {
    return 1
  }
  stopFindInPage(): void {}
  capturePage(): Promise<{ isEmpty(): boolean; toJPEG(q: number): Uint8Array }> {
    return Promise.resolve({ isEmpty: () => true, toJPEG: () => new Uint8Array() })
  }
  setWindowOpenHandler(): void {}
  get executeJavaScriptInIsolatedWorld():
    | ((world: number, scripts: { code: string }[]) => Promise<unknown>)
    | undefined {
    if (!this.scriptable) return undefined
    return (world, scripts) => {
      const code = scripts[0]?.code ?? ''
      this.scripts.push({ world, code })
      if (code === PAGE_TEXT_PROBE) return Promise.resolve(this.page.text.length)
      return Promise.resolve({ ...this.page, clipped: false })
    }
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

function setupHost(sleep: () => Promise<void> = () => Promise.resolve()): { host: WebViewHost; views: FakeView[]; removed: FakeView[] } {
  const views: FakeView[] = []
  const removed: FakeView[] = []
  const host = new WebViewHost({
    createView: () => {
      const view = new FakeView()
      views.push(view)
      return view as unknown as WebViewLike
    },
    removeView: (view) => removed.push(view as unknown as FakeView),
    openExternal: () => undefined,
    send: () => undefined,
    zoom: () => 1,
    contentSize: () => ({ width: 1200, height: 800 }),
    sleep
  })
  return { host, views, removed }
}

describe('WebViewHost.readTabText (TODO 1052)', () => {
  it('reads by running fixed JS in an isolated world from the view of a live tab', async () => {
    const { host, views } = setupHost()
    host.load('https://a.example/pr', 't1')
    const result = await host.readTabText('t1', 'https://a.example/pr')
    expect(result).toEqual({ ok: true, url: 'https://a.example/pr', title: 'PR 1', text: 'hello', clipped: false, loading: false, settled: true })
    expect(views).toHaveLength(1)
    const scripts = views[0]?.webContents.scripts ?? []
    expect(scripts.every((script) => script.world === PAGE_TEXT_WORLD_ID)).toBe(true)
    expect(scripts.at(-1)?.code).toBe(PAGE_TEXT_SCRIPT)
    // Read after the body settles (the length was seen as the same twice in a row).
    expect(scripts.filter((script) => script.code === PAGE_TEXT_PROBE).length).toBeGreaterThanOrEqual(2)
  })

  it('for a tab dropped by LRU, creates a view without showing it and reloads; does not replace the shown view and does not evict it', async () => {
    const { host, views } = setupHost()
    for (let index = 1; index <= WEB_LIVE_VIEWS + 1; index += 1) host.load(`https://a.example/${index}`, `t${index}`)
    // t1 was evicted. The one being shown is the last tab.
    expect(host.liveTabs).not.toContain('t1')
    const shown = views.at(-1)
    const result = await host.readTabText('t1', 'https://a.example/1')
    expect(result).toMatchObject({ ok: true, url: 'https://a.example/1' })
    const created = views.at(-1)
    expect(created).not.toBe(shown)
    expect(created?.webContents.loaded).toEqual(['https://a.example/1'])
    // The created view is not shown. Its size fits the window.
    expect(created?.visible).toEqual([false])
    expect(created?.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
    // The view that was being shown stays alive (since the pane is showing, the created view is kept in LRU too).
    expect(shown?.webContents.destroyed).toBe(false)
    expect(host.liveTabs).toContain(`t${WEB_LIVE_VIEWS + 1}`)
    expect(host.liveTabs).toContain('t1')
    expect(host.liveTabs.length).toBeLessThanOrEqual(WEB_LIVE_VIEWS)
  })

  it('a view created when the pane is not shown (closed with ✕) is closed after reading', async () => {
    const { host, views, removed } = setupHost()
    host.load('https://a.example/1', 't1')
    host.close()
    const result = await host.readTabText('t1', 'https://a.example/1')
    expect(result).toMatchObject({ ok: true })
    const created = views.at(-1)
    expect(created?.webContents.destroyed).toBe(true)
    expect(removed).toContain(created)
    expect(host.liveTabs).toEqual([])
  })

  it('if the user shows the pane of the same tab while reading, that view is not closed (review 57-2)', async () => {
    let onSleep: () => void = () => undefined
    const { host, views, removed } = setupHost(() => {
      onSleep()
      return Promise.resolve()
    })
    host.load('https://a.example/1', 't1')
    host.close()
    onSleep = () => {
      onSleep = () => undefined
      host.load('https://a.example/1', 't1')
    }
    const result = await host.readTabText('t1', 'https://a.example/1')
    expect(result).toMatchObject({ ok: true })
    const shown = views.at(-1)
    expect(shown?.webContents.destroyed).toBe(false)
    expect(removed).not.toContain(shown)
    expect(host.liveTabs).toEqual(['t1'])
  })

  it('refuses a failed page, a non-http(s) tab, a view that cannot run JS, and a closed window', async () => {
    const { host, views } = setupHost()
    host.load('https://a.example/1', 't1')
    const contents = views[0]?.webContents
    contents?.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://a.example/1', true)
    expect(await host.readTabText('t1', 'https://a.example/1')).toEqual({ ok: false, reason: 'failed' })
    expect(await host.readTabText('t2', 'about:blank')).toEqual({ ok: false, reason: 'not-web' })

    const other = setupHost()
    other.host.load('https://a.example/2', 't2')
    if (other.views[0] !== undefined) other.views[0].webContents.scriptable = false
    expect(await other.host.readTabText('t2', 'https://a.example/2')).toEqual({ ok: false, reason: 'unreadable' })

    other.host.dispose()
    expect(await other.host.readTabText('t2', 'https://a.example/2')).toEqual({ ok: false, reason: 'closed' })
  })

  it('TODO 1055 (3): a background view that hit a login screen returns login-required and does not open the default browser', async () => {
    const opened: string[] = []
    const views: FakeView[] = []
    const host = new WebViewHost({
      createView: () => {
        const view = new FakeView()
        views.push(view)
        return view as unknown as WebViewLike
      },
      removeView: () => undefined,
      openExternal: (url) => opened.push(url),
      send: () => undefined,
      zoom: () => 1,
      contentSize: () => ({ width: 1200, height: 800 }),
      sleep: () => Promise.resolve()
    })
    const login = 'https://accounts.google.com/v3/signin/identifier'
    const result = await host.readTabText('t1', login)
    expect(result).toEqual({ ok: false, reason: 'login-required' })
    expect(opened).toEqual([])
  })

  it('TODO 1087: login screens other than Google (the URL table) are also login-required', async () => {
    const { host } = setupHost()
    for (const login of [
      'https://login.microsoftonline.com/common/oauth2/authorize?x=1',
      'https://github.com/login?return_to=%2Fo%2Fr',
      'https://acme.slack.com/signin',
      'https://dev-123.okta.com/app/x/sso/saml'
    ]) {
      expect(await host.readTabText('t-' + login, login)).toEqual({ ok: false, reason: 'login-required' })
    }
  })

  it('TODO 1087: even if not in the URL table, a visible password field makes it login-required', async () => {
    const { host, views } = setupHost()
    host.load('https://sso.corp.example/', 't1')
    views[0]!.webContents.page = { title: 'Sign in', text: 'user / pass', loginForm: true }
    expect(await host.readTabText('t1', 'https://sso.corp.example/')).toEqual({ ok: false, reason: 'login-required' })
  })

  it('TODO 1087 (review): a password field on a public page or in a long body does not make it a login screen', async () => {
    for (const url of [
      'https://developer.okta.com/docs/guides/',
      'https://auth0.com/docs',
      'https://community.auth0.com/t/x',
      'https://www.onelogin.com/',
      'https://acme.okta.com/'
    ]) expect(isLoginPageUrl(url)).toBe(false)
    for (const url of ['https://acme.okta.com/login/login.htm', 'https://acme.auth0.com/u/login?state=x', 'https://acme.okta.com/oauth2/v1/authorize'])
      expect(isLoginPageUrl(url)).toBe(true)
    const long = 'x'.repeat(2000)
    expect(looksLikeLoginPage({ text: 'user / pass', loginForm: true })).toBe(true)
    expect(looksLikeLoginPage({ text: long, loginForm: true, loginFormChars: 50 })).toBe(false)
    expect(looksLikeLoginPage({ text: long, loginForm: true, loginFormChars: 1500 })).toBe(true)
    expect(looksLikeLoginPage({ text: 'short' })).toBe(false)
    const { host, views } = setupHost()
    host.load('https://forum.example/', 't1')
    views[0]!.webContents.page = { title: 'Forum', text: long, loginForm: true, loginFormChars: 40 }
    expect(await host.readTabText('t1', 'https://forum.example/')).toMatchObject({ ok: true })
  })

  it('TODO 1087: isLoginPageUrl looks at an exact-match host and path', () => {
    expect(isLoginPageUrl('https://login.live.com/')).toBe(true)
    expect(isLoginPageUrl('https://appleid.apple.com/sign-in')).toBe(true)
    expect(isLoginPageUrl('https://github.com/login')).toBe(true)
    expect(isLoginPageUrl('https://github.com/anthropics/repo')).toBe(false)
    expect(isLoginPageUrl('https://slack.com/intl/en/features')).toBe(false)
    expect(isLoginPageUrl('https://login.live.com.evil.example/')).toBe(false)
    expect(isLoginPageUrl('https://evilokta.com/')).toBe(false)
    expect(isLoginPageUrl('https://accounts.google.com/ServiceLogin')).toBe(false)
    expect(isLoginPageUrl('https://accounts.google.com/v3/signin/identifier')).toBe(true)
    expect(isLoginPageUrl('ftp://login.live.com/')).toBe(false)
    expect(parsePageText({ text: 'a', loginForm: true })).toEqual({ title: '', text: 'a', clipped: false, loginForm: true })
  })

  it('TODO 1055 (4): when the length does not settle and reaches the limit, settled: false', async () => {
    const { host, views } = setupHost()
    host.load('https://a.example/1', 't1')
    let n = 0
    const contents = views[0]?.webContents
    if (contents !== undefined) Object.defineProperty(contents.page, 'text', { get: () => 'x'.repeat((n += 1)) })
    expect(await host.readTabText('t1', 'https://a.example/1')).toMatchObject({ ok: true, settled: false })
  })

  it('TODO 1055 (4, review): when the body stays empty with the same length twice in a row, settled: true (does not repeat re-reading)', async () => {
    const { host, views } = setupHost()
    host.load('https://a.example/1', 't1')
    if (views[0] !== undefined) views[0].webContents.page.text = ''
    expect(await host.readTabText('t1', 'https://a.example/1')).toMatchObject({ ok: true, text: '', settled: true })
  })

  it('TODO 1055 (4, review): when the length is not returned as a number, does not make it settled: false', async () => {
    const { host, views } = setupHost()
    host.load('https://a.example/1', 't1')
    const contents = views[0]?.webContents
    if (contents !== undefined) {
      Object.defineProperty(contents, 'executeJavaScriptInIsolatedWorld', {
        value: (_world: number, scripts: { code: string }[]) =>
          Promise.resolve(scripts[0]?.code === PAGE_TEXT_PROBE ? 'not a number' : { title: 'T', text: 'hello', clipped: false })
      })
    }
    expect(await host.readTabText('t1', 'https://a.example/1')).toMatchObject({ ok: true, settled: true })
  })

  it('when still loading past the limit, returns the body at that point with loading: true', async () => {
    const { host, views } = setupHost()
    host.load('https://a.example/1', 't1')
    if (views[0] !== undefined) views[0].webContents.loading = true
    expect(await host.readTabText('t1', 'https://a.example/1')).toMatchObject({ ok: true, loading: true })
  })
})

// ---------------------------------------------------------------------------
// GatewayRequests: getOpenUrlText / listOpenFiles
// ---------------------------------------------------------------------------

interface GatewayFixture {
  requests: GatewayRequests
  approvals: ApprovalRequestInput[]
  reads: { viewId: number; tabId: string }[]
  recorded: AiosEvent[]
  consent: { value: boolean }
  tabs: Map<number, ReadableWebTab[]>
}

function setupGateway(options: {
  views?: number[]
  allow?: boolean
  outcome?: TabTextOutcome
  consented?: boolean
  /** Adds a tab at the nth wait (reproduces the moment right after openUrl). */
  onSleep?: (fixture: GatewayFixture) => void
  /** TODO 1061 (3): per-window notice of ViewerPane. */
  shown?: Map<number, ViewerShownReport>
}): GatewayFixture {
  const approvals: ApprovalRequestInput[] = []
  const reads: { viewId: number; tabId: string }[] = []
  const recorded: AiosEvent[] = []
  const consent = { value: options.consented ?? false }
  const tabs = new Map<number, ReadableWebTab[]>()
  const fixture = {} as GatewayFixture
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: (sessionId) => (sessionId === 's1' ? 'th1' : undefined),
    getThread: (id) =>
      id === 'th1'
        ? ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread)
        : null,
    getAdapter: () => undefined,
    getLive: () => undefined,
    emitThread: () => undefined,
    record: (_threadId, event) => {
      recorded.push(event)
    },
    viewsOf: () => options.views ?? [7],
    allViewEntries: () => [],
    viewerShown: (viewId, threadId) => {
      const report = options.shown?.get(viewId) ?? null
      return report !== null && report.threadId === threadId ? report : null
    },
    requestApproval: (input): Promise<ApprovalResult> => {
      approvals.push(input)
      return Promise.resolve(
        (options.allow ?? true)
          ? ({ allowed: true, by: 'user' } as ApprovalResult)
          : ({ allowed: false, by: 'user', message: '' } as ApprovalResult)
      )
    },
    webTabs: {
      list: (viewId) => tabs.get(viewId) ?? [],
      read: (viewId, tabId) => {
        reads.push({ viewId, tabId })
        return Promise.resolve(
          options.outcome ?? { ok: true, url: 'https://b.example/pr/1', title: 'PR', text: 'line 1\n\n\n\nline 2  ', clipped: false, loading: false, settled: true }
        )
      }
    },
    webTabReadConsent: {
      granted: () => consent.value,
      grant: () => {
        consent.value = true
      }
    },
    sleep: () => {
      options.onSleep?.(fixture)
      return Promise.resolve()
    }
  }
  Object.assign(fixture, { requests: new GatewayRequests(host as GatewayRequestHost), approvals, reads, recorded, consent, tabs })
  return fixture
}

const readText = (fixture: GatewayFixture, payload: Record<string, unknown> = {}): Promise<unknown> =>
  fixture.requests.handle({ sessionId: 's1', kind: 'getOpenUrlText', payload } as never)

describe('getOpenUrlText (TODO 1052)', () => {
  const prTab: ReadableWebTab = { tabId: 't2', url: 'https://b.example/pr/1', title: 'PR', active: true }

  it('asks for consent in the approval box only the first time (does not pass it through even by default), and does not ask after recording', async () => {
    const fixture = setupGateway({})
    fixture.tabs.set(7, [prTab])
    const first = await readText(fixture)
    expect(first).toMatchObject({ url: 'https://b.example/pr/1', title: 'PR', tabId: 't2', text: 'line 1\n\nline 2', truncated: false })
    expect(fixture.approvals).toHaveLength(1)
    expect(fixture.approvals[0]).toMatchObject({
      toolName: 'mcp__aios__getOpenUrlText',
      summary: WEB_TAB_READ_CONSENT_SUMMARY,
      alwaysAsk: true
    })
    // The timeline has two rows: pending, then the outcome.
    expect(fixture.recorded.map((event) => (event.payload as { outcome: { kind: string } }).outcome.kind)).toEqual([
      'pending',
      'allowed'
    ])
    expect(fixture.consent.value).toBe(true)
    await readText(fixture)
    expect(fixture.approvals).toHaveLength(1)
    expect(fixture.reads).toEqual([
      { viewId: 7, tabId: 't2' },
      { viewId: 7, tabId: 't2' }
    ])
  })

  it('TODO 1055 (1): the approve stage does not pass early and leaves it to the decision, yielding only the asking to the tool stage (toolStageAsks)', async () => {
    const fixture = setupGateway({})
    const reply = await fixture.requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: 'mcp__aios__getOpenUrlText', input: {}, toolUseId: 'tu1' }
    } as never)
    expect(reply).toMatchObject({ allowed: true })
    expect(fixture.approvals).toHaveLength(1)
    expect(fixture.approvals[0]).toMatchObject({ toolName: 'mcp__aios__getOpenUrlText', toolStageAsks: true })
  })

  it('TODO 1055 (review): getViewerScreenshot yields the asking only when capturing a Web tab (a file viewer gets the normal decision)', async () => {
    const approveScreenshot = async (kind: 'web' | 'file'): Promise<ApprovalRequestInput> => {
      const shown = new Map<number, ViewerShownReport>([
        [7, { threadId: 'th1', kind, uri: kind === 'web' ? 'https://c.example/' : 'file:///tmp/a.md' }]
      ])
      const fixture = setupGateway({ shown })
      await fixture.requests.handle({
        sessionId: 's1',
        kind: 'approve',
        payload: { toolName: 'mcp__aios__getViewerScreenshot', input: {}, toolUseId: 'tu1' }
      } as never)
      expect(fixture.approvals).toHaveLength(1)
      return fixture.approvals[0]!
    }
    expect(await approveScreenshot('web')).toMatchObject({ toolStageAsks: true })
    expect(await approveScreenshot('file')).not.toHaveProperty('toolStageAsks')
  })

  it('TODO 1055 (3): for a page that needs login, returns a login-required sentence to the model', async () => {
    const fixture = setupGateway({ consented: true, outcome: { ok: false, reason: 'login-required' } })
    fixture.tabs.set(7, [prTab])
    const result = (await readText(fixture)) as { error?: string }
    expect(result.error).toMatch(/sign-in/)
  })

  it('TODO 1055 (4): attaches a re-read note to a body read without settling', async () => {
    const fixture = setupGateway({
      consented: true,
      outcome: { ok: true, url: 'https://b.example/pr/1', title: 'PR', text: 'x', clipped: false, loading: false, settled: false }
    })
    fixture.tabs.set(7, [prTab])
    const result = (await readText(fixture)) as { notice?: string }
    expect(JSON.stringify(result)).toMatch(/still changing/)
  })

  it('does not read and does not record when consent is refused', async () => {
    const fixture = setupGateway({ allow: false })
    fixture.tabs.set(7, [prTab])
    const result = (await readText(fixture)) as { error?: string }
    expect(result.error).toMatch(/NOT read/)
    expect(fixture.reads).toEqual([])
    expect(fixture.consent.value).toBe(false)
  })

  it('does not read a URL that is not open (does not render in the background); attaches the list of tabs and urges openUrl', async () => {
    const fixture = setupGateway({ consented: true })
    fixture.tabs.set(7, [prTab])
    const result = (await readText(fixture, { url: 'https://evil.example/' })) as { error?: string; tabs?: unknown }
    expect(result.error).toMatch(/openUrl/)
    expect(result.tabs).toEqual([{ tabId: 't2', url: 'https://b.example/pr/1', title: 'PR' }])
    expect(fixture.reads).toEqual([])
  })

  it('right after openUrl, waits for the URL to show up in the tab before reading', async () => {
    let sleeps = 0
    const fixture = setupGateway({
      consented: true,
      onSleep: (self) => {
        sleeps += 1
        if (sleeps === 2) self.tabs.set(7, [prTab])
      }
    })
    fixture.tabs.set(7, [{ tabId: 't2', url: 'https://old.example/', title: 'old', active: true }])
    expect(await readText(fixture, { url: 'https://b.example/pr/1' })).toMatchObject({ tabId: 't2', url: 'https://b.example/pr/1' })
    expect(sleeps).toBe(2)
  })

  it('refuses with no window, no tab, an unknown tabId, or broken arguments, and does not ask for consent', async () => {
    const noWindow = setupGateway({ views: [] })
    expect(await readText(noWindow)).toMatchObject({ error: expect.stringMatching(/No window/) })
    const noTabs = setupGateway({})
    expect(await readText(noTabs)).toMatchObject({ error: expect.stringMatching(/openUrl/) })
    expect(noTabs.approvals).toEqual([])
    const fixture = setupGateway({ consented: true })
    fixture.tabs.set(7, [prTab])
    expect(await readText(fixture, { tabId: 't9' })).toMatchObject({ error: expect.stringMatching(/listOpenFiles/) })
    expect(await readText(fixture, { tabId: 42 })).toEqual({ error: 'invalid tabId' })
    expect(await readText(fixture, { offset: -1 })).toMatchObject({ error: expect.stringMatching(/offset/) })
    expect(await readText(fixture, { length: 10 })).toMatchObject({ error: expect.stringMatching(/length/) })
    expect(fixture.reads).toEqual([])
  })

  it('cuts a long body in the same way as getDocumentText, and the rest can be read with next_offset', async () => {
    const text = 'あ'.repeat(200) // 600 bytes
    const fixture = setupGateway({
      consented: true,
      outcome: { ok: true, url: 'https://b.example/pr/1', title: 'PR', text, clipped: false, loading: false, settled: true }
    })
    fixture.tabs.set(7, [prTab])
    const first = (await readText(fixture, { length: 256 })) as { text: string; next_offset: number; truncated: boolean }
    expect(first).toMatchObject({ offset: 0, bytes: 255, total_bytes: 600, next_offset: 255, truncated: true })
    const second = (await readText(fixture, { offset: first.next_offset, length: 256 })) as { text: string; next_offset: number }
    const third = (await readText(fixture, { offset: second.next_offset, length: 256 })) as { text: string; next_offset: null }
    expect(third.next_offset).toBeNull()
    expect(first.text + second.text + third.text).toBe(text)
  })

  it('returns the reason it could not be read in a fixed English sentence', async () => {
    const fixture = setupGateway({ consented: true, outcome: { ok: false, reason: 'failed' } })
    fixture.tabs.set(7, [prTab])
    expect(await readText(fixture)).toMatchObject({ error: expect.stringMatching(/failed to load/), tabId: 't2' })
  })

  it("listOpenFiles: puts this conversation's window's Web tabs in webTabs", async () => {
    const fixture = setupGateway({ views: [7, 8] })
    fixture.tabs.set(7, [prTab])
    fixture.tabs.set(8, [{ tabId: 't5', url: 'https://c.example/', title: 'C', active: false }])
    const listed = await fixture.requests.handle({ sessionId: 's1', kind: 'listOpenFiles', payload: {} } as never)
    expect(listed).toEqual({
      files: [],
      webTabs: [
        { ...prTab, shown: false },
        { tabId: 't5', url: 'https://c.example/', title: 'C', active: false, shown: false }
      ],
      inView: [{ kind: 'unknown' }, { kind: 'unknown' }]
    })
  })

  it('TODO 1061 (3): shown on the previous tab of a window where ViewerPane shows Web, and that tab in inView', async () => {
    const shown = new Map<number, ViewerShownReport>([
      [7, { threadId: 'th1', kind: 'file', uri: 'file:///tmp/a.md' }],
      [8, { threadId: 'th1', kind: 'web', uri: 'https://c.example/' }]
    ])
    const fixture = setupGateway({ views: [7, 8], shown })
    fixture.tabs.set(7, [prTab])
    const cTab = { tabId: 't5', url: 'https://c.example/', title: 'C', active: true }
    fixture.tabs.set(8, [{ tabId: 't6', url: 'https://d.example/', title: 'D', active: false }, cTab])
    const listed = await fixture.requests.handle({ sessionId: 's1', kind: 'listOpenFiles', payload: {} } as never)
    expect(listed).toMatchObject({
      webTabs: [{ tabId: prTab.tabId, shown: false }, { tabId: 't6', shown: false }, { tabId: 't5', shown: true }],
      inView: [
        { kind: 'file', path: '/tmp/a.md' },
        { kind: 'web', tabId: 't5', url: 'https://c.example/', title: 'C' }
      ]
    })
    // Without arguments, getOpenUrlText reads the tab the user is seeing (t5 of window 8), not the earlier tab of window 7 (behind Web).
    fixture.consent.value = true
    await readText(fixture)
    expect(fixture.reads).toEqual([{ viewId: 8, tabId: 't5' }])
  })

  it('TODO 1061 (3): describeInView: a blank tab, a temporary display, closed, and non-file', () => {
    expect(describeInView({ threadId: 't', kind: 'web', uri: 'about:blank' }, [])).toEqual({
      kind: 'web',
      tabId: null,
      url: 'about:blank',
      title: ''
    })
    expect(describeInView({ threadId: 't', kind: 'diff', uri: null }, [])).toEqual({ kind: 'diff' })
    expect(describeInView({ threadId: 't', kind: 'file', uri: 'file:///tmp/a.zip', entry: 'd/b.txt' }, [])).toEqual({
      kind: 'file',
      path: '/tmp/a.zip',
      entry: 'd/b.txt'
    })
    expect(describeInView({ threadId: 't', kind: 'none', uri: null }, [])).toEqual({ kind: 'none' })
    expect(describeInView({ threadId: 't', kind: 'file', uri: 'thread://x' }, [])).toEqual({ kind: 'other' })
    expect(describeInView(null, [])).toEqual({ kind: 'unknown' })
  })

  it("TODO 1061 part 2: describeInView: the file's current page and selection (secrets are masked)", () => {
    expect(describeInView({ threadId: 't', kind: 'file', uri: 'file:///tmp/a.pdf', page: 5 }, [])).toEqual({
      kind: 'file',
      path: '/tmp/a.pdf',
      page: 5
    })
    const entry = describeInView(
      {
        threadId: 't',
        kind: 'file',
        uri: 'file:///tmp/a.ts',
        selection: { text: 'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', fromLine: 1, toLine: 2, truncated: false }
      },
      []
    )
    expect(entry).toMatchObject({ kind: 'file', path: '/tmp/a.ts', selection: { fromLine: 1, toLine: 2 } })
    expect(JSON.stringify(entry)).not.toContain('sk-ant-api03-abcdefghij')
  })

  it('TODO 1091 part 2: describeInView: the diff selection (secrets are masked)', () => {
    const entry = describeInView(
      {
        threadId: 't',
        kind: 'diff',
        uri: null,
        selection: { text: 'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', fromLine: null, toLine: null, truncated: false }
      },
      []
    )
    expect(entry).toMatchObject({ kind: 'diff', selection: { fromLine: null, toLine: null } })
    expect(JSON.stringify(entry)).not.toContain('sk-ant-api03-abcdefghij')
  })
})
