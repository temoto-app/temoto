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

describe('exclusion paths for watching', () => {
  it('passes them with the actual letter case before folding', () => {
    const { ignore } = main()
    expect(ignore).toContain(`${HOME}/Library`)
    expect(ignore).toContain(`${HOME}/Library/Caches`)
    expect(ignore).not.toContain(`${HOME}/Library`.toLowerCase())
  })

  it('events under ~/Library are dropped by the same prefix match as native', () => {
    const { ignore } = main()
    expect(isIgnored(ignore, `${HOME}/Library/Biome/compute/sessions/x`)).toBe(true)
    expect(isIgnored(ignore, `${HOME}/Library/Containers/com.apple.Notes/Data/tmp/x`)).toBe(true)
    expect(isIgnored(ignore, `${HOME}/Library/Group Containers/group.com.apple.notes/x`)).toBe(true)
    expect(isIgnored(ignore, `${HOME}/Documents/memo.md`)).toBe(false)
  })

  it('does not pass exclusions outside the root', () => {
    const { ignore } = main()
    expect(ignore).not.toContain('/System')
    expect(ignore).not.toContain('/private')
  })

  it('does not include the root itself in the exclusions', () => {
    expect(main().ignore).not.toContain(HOME)
  })

  it('passes generated directory names as globs', () => {
    expect(main().ignore).toContain('**/node_modules')
  })
})

describe('include under an exclusion', () => {
  it('subscribes to iCloud Drive as an independent root', () => {
    const roots = plan().map((entry) => entry.root)
    expect(roots[0]).toBe(HOME)
    expect(roots).toContain(ICLOUD)
  })

  it("does not include itself in that root's exclusions", () => {
    const entry = plan().find((value) => value.root === ICLOUD)
    expect(entry).toBeDefined()
    expect(isIgnored(entry?.ignore ?? [], `${ICLOUD}/memo.md`)).toBe(false)
  })

  it('an allowed volume becomes a root because it is under the /Volumes exclusion', () => {
    const rules = createMacosExclusions(HOME, { allowedVolumes: ['/Volumes/Data'] })
    const roots = watchPlan('/', rules).map((entry) => entry.root)
    expect(roots).toContain('/Volumes/Data')
  })
})

describe('T20: even when /Users is excluded and only your own home is included, the watch root stays the home', () => {
  it('the roots are one home plus iCloud Drive, and the home is not duplicated', () => {
    const roots = plan().map((entry) => entry.root)
    expect(roots[0]).toBe(HOME)
    expect(roots.filter((root) => root.toLowerCase() === HOME.toLowerCase())).toHaveLength(1)
    expect(roots).toEqual([HOME, ICLOUD])
  })

  it("/Users (outside the root) does not enter the home root's exclusions", () => {
    const { ignore } = main()
    expect(ignore).not.toContain('/Users')
    expect(isIgnored(ignore, `${HOME}/Documents/memo.md`)).toBe(false)
  })

  it('only when / is the root, the home becomes an independent root as an include under the /Users exclusion', () => {
    const entries = watchPlan('/', createMacosExclusions(HOME))
    const roots = entries.map((entry) => entry.root)
    expect(roots[0]).toBe('/')
    expect(roots).toContain(HOME)
    const top = entries[0] as (typeof entries)[number]
    expect(top.ignore).toContain('/Users')
    expect(isIgnored(top.ignore, '/Users/other/Documents/x')).toBe(true)
  })
})
