// @vitest-environment jsdom
/**
 * Shows Help (TODO 1174, ARCHITECTURE.md 7.4.13) as the temporary display of ViewerPane (7.4.6), and returns to the previous display when closed.
 *
 *  - `openHelp(lang)` only sets `help://index?lang=…` in `transient`, and does not touch the file behind it (`selectedUri`)
 *  - Closing by ✕ (`closeTransient`), by the viewer's "back" (`navigateViewer('back')`), or by selecting a file all return to the display behind
 *  - The value that the per-thread memory (63) looks at does not change on open or close, so nothing is pushed to the memory or to the viewer's history
 *  - The entry `openHelp()` opens in the app's display language, and pressing `toggleHelp()` again from the Activity Bar closes it
 *
 *  - The heading (label, ✕, tooltip) is drawn in one place, `TransientFrame`. The same frame is drawn while the document cannot be read or is loading (there is no separate `TransientMessage`)
 *
 * The DOM is not needed, but the viewer history wiring (`viewerHistory.ts`) looks up `window.aios`, so a fake is placed in jsdom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

beforeEach(() => {
  vi.resetModules()
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { viewerHistory: vi.fn(async () => null), setViewerHistory: vi.fn(async () => undefined) },
    fs: { stat: vi.fn(async () => null) }
  }
})

async function load(): Promise<{
  store: typeof import('../src/renderer/src/store.js')
  help: typeof import('../src/renderer/src/help.js')
  locale: typeof import('../src/renderer/src/localeStore.js')
  history: typeof import('../src/renderer/src/viewerHistory.js')
}> {
  const store = await import('../src/renderer/src/store.js')
  const help = await import('../src/renderer/src/help.js')
  const locale = await import('../src/renderer/src/localeStore.js')
  const history = await import('../src/renderer/src/viewerHistory.js')
  store.useStore.setState({ selectedUri: null, highlightQuery: null, transient: null, viewerSelection: null })
  return { store, help, locale, history }
}

describe('Help の一時表示 (TODO 1174)', () => {
  it('openHelp は裏のファイルに触らず、✕ でそのファイルに戻る', async () => {
    const { store } = await load()
    store.useStore.getState().select('file:///x/a.ts', { highlight: 'foo' })
    store.useStore.getState().openHelp('ja')
    let state = store.useStore.getState()
    expect(state.transient).toMatchObject({ kind: 'help', uri: 'help://index?lang=ja' })
    expect(state.selectedUri).toBe('file:///x/a.ts')
    expect(state.highlightQuery).toBe('foo')

    store.useStore.getState().closeTransient()
    state = store.useStore.getState()
    expect(state.transient).toBeNull()
    expect(state.selectedUri).toBe('file:///x/a.ts')
    expect(state.highlightQuery).toBe('foo')
  })

  it('開き直すたびに nonce が進む (iframe を作り直す)', async () => {
    const { store } = await load()
    store.useStore.getState().openHelp('en')
    const first = store.useStore.getState().transient
    store.useStore.getState().openHelp('en')
    const second = store.useStore.getState().transient
    expect(first?.kind === 'help' && second?.kind === 'help' && second.nonce > first.nonce).toBe(true)
  })

  it('viewer の「戻る」で閉じて裏のファイルへ (履歴は動かない)', async () => {
    const { store, history } = await load()
    store.useStore.getState().select('file:///x/a.ts')
    store.useStore.getState().openHelp('en')
    expect(history.navigateViewer('back')).toBe(true)
    expect(store.useStore.getState().transient).toBeNull()
    expect(store.useStore.getState().selectedUri).toBe('file:///x/a.ts')
  })

  it('ファイルを選ぶと Help は閉じる', async () => {
    const { store } = await load()
    store.useStore.getState().openHelp('en')
    store.useStore.getState().select('file:///x/b.ts')
    expect(store.useStore.getState().transient).toBeNull()
    expect(store.useStore.getState().selectedUri).toBe('file:///x/b.ts')
  })

  it('開け閉めでスレッドの記憶の対象 (selectedUri / highlightQuery) は動かない', async () => {
    const { store } = await load()
    store.useStore.getState().select('file:///x/a.ts')
    const seen: string[] = []
    const unsubscribe = store.useStore.subscribe((state, previous) => {
      if (state.selectedUri !== previous.selectedUri || state.highlightQuery !== previous.highlightQuery) {
        seen.push(String(state.selectedUri))
      }
    })
    store.useStore.getState().openHelp('ja')
    store.useStore.getState().closeTransient()
    unsubscribe()
    expect(seen).toEqual([])
  })

  it('入口はアプリの表示言語で開き、Activity Bar の ? は押し直しで閉じる', async () => {
    const { store, help, locale } = await load()
    locale.useLocale.setState({ resolved: 'ja' } as never)
    help.toggleHelp()
    expect(store.useStore.getState().transient).toMatchObject({ kind: 'help', uri: 'help://index?lang=ja' })
    help.toggleHelp()
    expect(store.useStore.getState().transient).toBeNull()

    locale.useLocale.setState({ resolved: 'en' } as never)
    help.openHelp()
    expect(store.useStore.getState().transient).toMatchObject({ kind: 'help', uri: 'help://index?lang=en' })
    // When another temporary display (diff) is in front, ? switches to Help (it does not close).
    store.useStore.getState().openDiff({ before: { name: 'a', text: '1' }, after: { name: 'a', text: '2' } })
    help.toggleHelp()
    expect(store.useStore.getState().transient?.kind).toBe('help')
  })

  it('Help の読み込みは TransientFrame の resolve に畳まれ、失敗は noViewer に help.loadFailed を渡す', () => {
    const file = join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'TransientViewerPane.tsx')
    const src = readFileSync(file, 'utf8')
    expect(src).not.toContain('TransientMessage')
    expect(src).toContain("noViewer={doc === null ? t('help.loadFailed') : t('help.noViewer')}")
    // The ✕ in the heading exists in only one place in the frame.
    expect(src.match(/className="icon-button viewer-close"/g)).toHaveLength(1)
  })
})
