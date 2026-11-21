/**
 * Regression of watch ignore (`ignore` of `@parcel/watcher`).
 *
 * The native side's `Watcher::isIgnored` is a byte-wise prefix match, so a path passed in folded form never matches. In fact, passing `/users/alice/library` made all FSEvents under `~/Library` go up,
 * and the macOS 26 confirmation dialog for `kTCCServiceSystemPolicyAppData` ('Access Data from Other Apps') appeared.
 */
import { describe, expect, it } from 'vitest'
import { createMacosExclusions } from '../src/common/exclusions.js'
import { watchPlan } from '../src/index-kernel/watcher.js'

const HOME = '/Users/Alice'
const ICLOUD = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`

const plan = (): ReturnType<typeof watchPlan> => watchPlan(HOME, createMacosExclusions(HOME))
const main = (): ReturnType<typeof watchPlan>[number] => plan()[0] as ReturnType<typeof watchPlan>[number]

/** The same check as `isIgnored` in Watcher.cc (byte-wise prefix match). */
function isIgnored(ignore: readonly string[], path: string): boolean {
  return ignore.some((dir) => path === dir || path.startsWith(`${dir}/`))
}

describe('監視の除外パス', () => {
  it('畳み込む前の実際の大小文字で渡す', () => {
    const { ignore } = main()
    expect(ignore).toContain(`${HOME}/Library`)
    expect(ignore).toContain(`${HOME}/Library/Caches`)
    expect(ignore).not.toContain(`${HOME}/Library`.toLowerCase())
  })

  it('native と同じ前方一致で ~/Library 以下のイベントが落ちる', () => {
    const { ignore } = main()
    expect(isIgnored(ignore, `${HOME}/Library/Biome/compute/sessions/x`)).toBe(true)
    expect(isIgnored(ignore, `${HOME}/Library/Containers/com.apple.Notes/Data/tmp/x`)).toBe(true)
    expect(isIgnored(ignore, `${HOME}/Library/Group Containers/group.com.apple.notes/x`)).toBe(true)
    expect(isIgnored(ignore, `${HOME}/Documents/memo.md`)).toBe(false)
  })

  it('ルートの外の除外は渡さない', () => {
    const { ignore } = main()
    expect(ignore).not.toContain('/System')
    expect(ignore).not.toContain('/private')
  })

  it('根そのものは除外に含めない', () => {
    expect(main().ignore).not.toContain(HOME)
  })

  it('生成物のディレクトリ名はグロブで渡す', () => {
    expect(main().ignore).toContain('**/node_modules')
  })
})

describe('除外の下にある include', () => {
  it('iCloud Drive を独立した根として購読する', () => {
    const roots = plan().map((entry) => entry.root)
    expect(roots[0]).toBe(HOME)
    expect(roots).toContain(ICLOUD)
  })

  it('その根の除外には自分自身を含めない', () => {
    const entry = plan().find((value) => value.root === ICLOUD)
    expect(entry).toBeDefined()
    expect(isIgnored(entry?.ignore ?? [], `${ICLOUD}/memo.md`)).toBe(false)
  })

  it('許可ボリュームは /Volumes の除外の下にあるので根になる', () => {
    const rules = createMacosExclusions(HOME, { allowedVolumes: ['/Volumes/Data'] })
    const roots = watchPlan('/', rules).map((entry) => entry.root)
    expect(roots).toContain('/Volumes/Data')
  })
})

describe('T20: /Users を除外して自分のホームだけ含めても、監視の根はホームのまま', () => {
  it('根はホーム 1 つ + iCloud Drive で、ホームが重複しない', () => {
    const roots = plan().map((entry) => entry.root)
    expect(roots[0]).toBe(HOME)
    expect(roots.filter((root) => root.toLowerCase() === HOME.toLowerCase())).toHaveLength(1)
    expect(roots).toEqual([HOME, ICLOUD])
  })

  it('ホームの根の除外に /Users (根の外) は入らない', () => {
    const { ignore } = main()
    expect(ignore).not.toContain('/Users')
    expect(isIgnored(ignore, `${HOME}/Documents/memo.md`)).toBe(false)
  })

  it('/ を根にしたときだけ、ホームは /Users の除外の下の include として独立した根になる', () => {
    const entries = watchPlan('/', createMacosExclusions(HOME))
    const roots = entries.map((entry) => entry.root)
    expect(roots[0]).toBe('/')
    expect(roots).toContain(HOME)
    const top = entries[0] as (typeof entries)[number]
    expect(top.ignore).toContain('/Users')
    expect(isIgnored(top.ignore, '/Users/other/Documents/x')).toBe(true)
  })
})
