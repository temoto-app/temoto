/**
 * @vitest-environment jsdom
 *
 * TODO 834 stage 1, review fixes (wave 101 X): the `aios.git` viewer entry (`viewer/main.ts`) with the bridge replaced by a fake.
 * - a refresh while a comparison runs does not orphan the comparison (it must not stay "loading");
 * - a row of a comparison result opens with the versions the result was made with, not with what is typed in the fields now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (arg: never) => void
const handlers: Record<string, Handler | undefined> = {}
let pending: Array<{ name: string; arg: Record<string, unknown>; resolve: (value: unknown) => void }> = []
const calls: Array<{ name: string; arg: Record<string, unknown> }> = []
const diffs: unknown[] = []

vi.mock('../plugins/_shared/bridge.js', () => ({
  connect: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string) => {
          if (name === 'runCommand') {
            return (command: string, arg: Record<string, unknown>) => {
              calls.push({ name: command, arg })
              if (command === 'compare') return new Promise((resolve) => pending.push({ name: command, arg, resolve }))
              if (command === 'status') return Promise.resolve({ branch: 'main', head: null, staged: [], unstaged: [], truncated: false, hidden: 0 })
              if (command === 'log') return Promise.resolve({ commits: [], more: false })
              return Promise.resolve({ before: { kind: 'missing' }, after: { kind: 'text', text: 'x', size: 1 } })
            }
          }
          if (name === 'openDiff') return (...args: unknown[]) => void diffs.push(args)
          if (name.startsWith('on')) return (h: Handler) => void (handlers[name] = h)
          return () => undefined
        }
      }
    )
}))

const URI = 'aios-git:///r'
let root: HTMLElement
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function field(name: 'from' | 'to'): HTMLInputElement {
  return root.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!
}
function type(name: 'from' | 'to', value: string): void {
  const box = field(name)
  box.value = value
  box.dispatchEvent(new Event('input'))
}
function compareButton(): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>('.git-compare-form .git-button')!
}

beforeEach(async () => {
  pending = []
  calls.length = 0
  diffs.length = 0
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
  await import('../plugins/aios.git/viewer/main.js')
  handlers['onResource']?.({ uri: URI, label: 'r', resource: { kind: 'text', text: '' } } as never)
  await tick()
})
afterEach(() => vi.restoreAllMocks())

describe('aios.git viewer: comparison', () => {
  it('a refresh while comparing leaves the comparison able to finish (no stuck loading button)', async () => {
    type('from', 'v1')
    compareButton().click()
    expect(compareButton().disabled).toBe(true)
    root.querySelector<HTMLButtonElement>('.git-refresh')!.click()
    await tick()
    pending[0]!.resolve({ files: [{ path: 'a.ts', status: 'modified' }], truncated: false, hidden: 0 })
    await tick()
    expect(compareButton().disabled).toBe(false)
    expect(root.querySelectorAll('.git-compare .git-row').length).toBe(1)
  })

  it('opens a result row with the versions it was listed with, not the fields now', async () => {
    type('from', 'v1')
    type('to', 'v2')
    compareButton().click()
    pending[0]!.resolve({ files: [{ path: 'a.ts', status: 'modified' }], truncated: false, hidden: 0 })
    await tick()
    type('from', 'other')
    type('to', '')
    root.querySelector<HTMLButtonElement>('.git-compare .git-row')!.click()
    await tick()
    const sides = calls.find((call) => call.name === 'sides')!
    expect(sides.arg['from']).toBe('v1')
    expect(sides.arg['to']).toBe('v2')
  })
})
