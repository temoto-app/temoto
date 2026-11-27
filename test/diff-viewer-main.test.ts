/**
 * @vitest-environment jsdom
 *
 * The `aios.diff` viewer entry (`viewer/main.ts`) with the bridge replaced by a fake (wave 109 fix X3).
 * While a big diff waits for the worker, the previous view stays on screen and can still be selected in. A selection made there belongs
 * to the diff that is drawn, not to the one that just arrived (`last`): it must not be reported under the new diff's `uri`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (arg: never) => void
const handlers: Record<string, Handler | undefined> = {}
const selections: Array<{ uri: string; selection: unknown }> = []

vi.mock('../plugins/_shared/bridge.js', () => ({
  connect: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string) => {
          if (name === 'reportSelection') return (uri: string, selection: unknown) => void selections.push({ uri, selection })
          if (name.startsWith('on')) return (h: Handler) => void (handlers[name] = h)
          return () => undefined
        }
      }
    )
}))
vi.mock('../plugins/aios.diff/viewer/diff-worker.ts?worker&url', () => ({ default: 'aios-plugin://aios.diff/assets/diff-worker.js' }))

/** A worker that never answers: the big diff keeps waiting for the whole test (the ready timeout is 5 s). */
class SilentWorker {
  postMessage(): void {}
  addEventListener(): void {}
  terminate(): void {}
}

let root: HTMLElement

function send(uri: string, before: string, after: string): void {
  handlers['onResource']?.({
    uri,
    label: 'diff',
    resource: { kind: 'diff', before: { name: 'a.txt', text: before, language: null }, after: { name: 'a.txt', text: after, language: null } },
    editable: false,
    theme: 'light',
    locale: 'en',
    highlightQuery: null,
    revision: null
  } as never)
}

/** Selects the text of the first changed line in the view on screen and lets the viewer hear about it. */
function selectInView(): string {
  const line = root.querySelector('.cm-line')!
  const range = document.createRange()
  range.selectNodeContents(line)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return selection.toString()
}

// One instance of the entry for the file: it listens on `document`, which every test shares.
beforeAll(async () => {
  vi.stubGlobal('Worker', SilentWorker)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
  await import('../plugins/aios.diff/viewer/main.js')
})
beforeEach(() => {
  selections.length = 0
})
afterAll(() => vi.unstubAllGlobals())

describe('aios.diff viewer: the selection belongs to the diff on screen', () => {
  it('while a big diff waits for the worker, a selection in the previous view is not reported under the new uri', () => {
    send('diff://x', 'one\ntwo\n', 'one\nTWO\n')
    expect(root.querySelector('.cm-line')).not.toBeNull()
    const text = selectInView()
    expect(text.length).toBeGreaterThan(0)
    expect(selections.at(-1)).toEqual({ uri: 'diff://x', selection: expect.anything() })

    // A big diff arrives: it waits for the worker, and the view of diff://x stays.
    const big = Array.from({ length: 3000 }, (_, i) => `const value_${i} = compute(${i}) // padding`).join('\n') + '\n'
    send('diff://y', big, big.replace('value_100 =', 'renamed_100 ='))
    expect(root.querySelector('.cm-line')).not.toBeNull()
    selections.length = 0
    selectInView()
    expect(selections.filter((entry) => entry.uri === 'diff://y' && entry.selection !== null)).toEqual([])
    // It is still the selection of the diff on screen.
    expect(selections.at(-1)).toEqual({ uri: 'diff://x', selection: expect.objectContaining({ text }) })
  })

  it('a message replacing the view (an error) reports "no selection" for the diff that was shown, and selections stop', () => {
    send('diff://x', 'one\ntwo\n', 'one\nTWO\n')
    selectInView()
    selections.length = 0
    handlers['onResource']?.({
      uri: 'diff://z',
      label: 'diff',
      resource: { kind: 'error', message: 'gone' },
      editable: false,
      theme: 'light',
      locale: 'en',
      highlightQuery: null,
      revision: null
    } as never)
    expect(selections).toContainEqual({ uri: 'diff://x', selection: null })
    selections.length = 0
    document.dispatchEvent(new Event('selectionchange'))
    expect(selections).toEqual([])
  })
})
