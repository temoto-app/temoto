/**
 * TODO 881: even with `'handoff'`, places protected by TCC (such as `~/Library/Mail`) are refused before the stat. Other places under `~/Library` still pass as before. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyAccess, createMacosExclusions, HANDOFF_DENIED_REASONS, TCC_REASON } from '../src/common/exclusions.js'
import { pathToUri } from '../src/common/uri.js'
import { FsAccess } from '../src/main/fs/access.js'
import { resolveLink } from '../src/main/fs/link.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let home: string
let cwd: string
let fsAccess: FsAccess

const TCC = [
  'Library/Mail/V10/x.emlx',
  'Library/Messages/chat.db',
  'Library/Safari/History.db',
  'Library/Calendars',
  'Library/Application Support/AddressBook/AddressBook-v22.abcddb',
  'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite',
  'Library/Photos/Libraries',
  'Pictures/Photos Library.photoslibrary/database/x'
]

beforeAll(() => {
  home = realpathSync(makeTestDir('tcc-handoff'))
  cwd = join(home, 'git', 'proj')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'Library', 'Mail'), { recursive: true })
  writeFileSync(join(home, 'Library', 'Mail', 'x.txt'), 'm')
  mkdirSync(join(home, 'Library', 'Application Support', 'Code'), { recursive: true })
  symlinkSync(join(home, 'Library', 'Mail', 'x.txt'), join(cwd, 'mail-link'))
  fsAccess = new FsAccess(home, [home])
})

afterAll(() => removeTestDir(home))

const handoff = (path: string, isDirectory = false): boolean =>
  classifyAccess(path, path.split('/').at(-1) ?? '', isDirectory, createMacosExclusions(home), 'handoff').excluded

describe("TODO 881: 'handoff' and TCC locations", () => {
  it('refuses TCC locations in handoff too (case, trailing slash, the folder itself)', () => {
    expect(HANDOFF_DENIED_REASONS.has(TCC_REASON)).toBe(true)
    for (const rel of TCC) {
      const path = join(home, rel)
      expect(handoff(path), rel).toBe(true)
      expect(handoff(join(home, rel.toUpperCase())), rel).toBe(true)
      expect(handoff(`${path}/`, true), rel).toBe(true)
    }
    expect(handoff(join(home, 'Library', 'Mail'), true)).toBe(true)
    expect(handoff(join(home, 'library', 'mail', 'x'))).toBe(true)
  })

  it("refuses other apps' Containers / Group Containers wholesale in handoff (wave 45 code-review, TCC on macOS 14 and later)", () => {
    const rules = createMacosExclusions(home)
    for (const rel of [
      'Library/Containers',
      'Library/Containers/com.example.app/Data/Documents/a.txt',
      'Library/Containers/com.apple.mail/Data/x',
      'Library/Containers/com.apple.Notes/Data/x',
      'Library/Group Containers',
      'Library/Group Containers/ABCDE12345.com.example.shared/a.db',
      'Library/Group Containers/group.com.apple.reminders/x'
    ]) {
      const path = join(home, rel)
      const result = classifyAccess(path, path.split('/').at(-1) ?? '', false, rules, 'handoff')
      expect(result.excluded, rel).toBe(true)
      expect(result.reason, rel).toBe(TCC_REASON)
      // The results of 'read' / 'write' do not change (they already fall outside as app-internal under ~/Library).
      for (const access of ['read', 'write', 'edit'] as const) {
        expect(classifyAccess(path, path.split('/').at(-1) ?? '', false, rules, access).excluded, `${rel} ${access}`).toBe(true)
      }
    }
    // A sibling that merely matches the name as a prefix is not included.
    expect(handoff(join(home, 'Library', 'ContainersX', 'a'))).toBe(false)
  })

  it('other places under ~/Library still pass handoff as before', () => {
    expect(handoff(join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'))).toBe(false)
    expect(handoff(join(home, 'Library', 'Preferences', 'a.plist'))).toBe(false)
    expect(handoff(join(home, 'Library', 'Mailbox-not', 'a'))).toBe(false)
  })

  it('resolveLink: does not stat TCC locations (does not call exists / isDirectory) and does not emit handoffUri', () => {
    const touched: string[] = []
    const stat = (p: string): boolean => {
      touched.push(p)
      return true
    }
    const context = { baseDir: cwd, memoryDirs: [] as readonly string[], home }
    for (const rel of TCC) {
      const result = resolveLink(join(home, rel), context, fsAccess, stat, stat)
      expect(result.ok, rel).toBe(false)
      if (!result.ok) expect(result.handoffUri, rel).toBeUndefined()
    }
    expect(touched).toEqual([])
  })

  it('FsAccess: refuses TCC locations in handoff, and a symlink pointing at TCC fails the recheck of the target', () => {
    expect(() => fsAccess.assertAllowed(pathToUri(join(home, 'Library', 'Mail', 'x.txt')), false, 'handoff')).toThrow()
    expect(() => fsAccess.assertAllowed(pathToUri(join(cwd, 'mail-link')), false, 'handoff')).toThrow()
    expect(() =>
      fsAccess.assertAllowed(pathToUri(join(home, 'Library', 'Application Support', 'Code', 'a.json')), false, 'handoff')
    ).not.toThrow()
  })
})
