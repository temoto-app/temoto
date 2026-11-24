/**
 * Unit tests for the exclusion list (ARCHITECTURE.md 4.4.1 / 4.4.2).
 * Confirms that each row of the table in 4.4.2 is implemented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { resolvePath } from '../src/common/fs-policy.js'
import { pathToUri } from '../src/common/uri.js'
import { runMigrations } from '../src/common/migrations.js'
import { FsAccess } from '../src/main/fs/access.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import {
  classify,
  classifyAccess,
  classifyReference,
  createMacosExclusions,
  isExcluded,
  isVolumeMountPath,
  RULES_VERSION,
  WORKTREES_PATH_SUFFIX
} from '../src/common/exclusions.js'
import { walk, type ScanCounters } from '../src/index-kernel/scanner.js'
import { scratchCwd, scratchRoot } from '../src/main/session/scratch.js'
import { makeTestDir } from './helpers/tmp.js'

const HOME = '/Users/tester'
const rules = createMacosExclusions(HOME)

const dir = (path: string): boolean =>
  isExcluded(path, path.slice(path.lastIndexOf('/') + 1), true, rules)
const file = (path: string): boolean =>
  isExcluded(path, path.slice(path.lastIndexOf('/') + 1), false, rules)

describe('4.4.1 OS-wide exclusions', () => {
  it('excludes the credentials directory', () => {
    expect(dir(`${HOME}/.ssh`)).toBe(true)
    expect(dir(`${HOME}/.aws`)).toBe(true)
    expect(dir(`${HOME}/.gnupg`)).toBe(true)
    expect(dir(`${HOME}/.config/gh`)).toBe(true)
    expect(file(`${HOME}/.ssh/id_rsa`)).toBe(true)
  })

  it('excludes the backend credentials directory (compat/backend-paths.json)', () => {
    // Constraint 2: do not touch credentials. The proper names are on the compat/ side, so here we check that "one or more hidden directories directly under home are excluded".
    const backendDirs = rules.prefixes.filter(
      (rule) => rule.reason === 'credentials' && rule.prefix.startsWith(`${HOME.toLowerCase()}/.`)
    )
    expect(backendDirs.length).toBeGreaterThan(4)
  })

  it('excludes credential files at any level', () => {
    expect(file(`${HOME}/projects/x/.netrc`)).toBe(true)
    expect(file(`${HOME}/projects/x/.npmrc`)).toBe(true)
  })

  it('TODO 855: excludes commonly used credential locations and ssh key names', () => {
    for (const path of [
      `${HOME}/.config/gcloud/application_default_credentials.json`,
      `${HOME}/.config/gcloud/legacy_credentials/me@example.com/adc.json`,
      `${HOME}/.azure/msal_token_cache.json`,
      `${HOME}/.terraform.d/credentials.tfrc.json`,
      `${HOME}/.config/rclone/rclone.conf`,
      `${HOME}/.m2/settings.xml`,
      `${HOME}/.yarnrc.yml`,
      `${HOME}/.config/configstore/firebase-tools.json`,
      `${HOME}/.wrangler/config/default.toml`
    ]) {
      expect(classify(path, path.slice(path.lastIndexOf('/') + 1), false, rules), path).toEqual({
        excluded: true,
        reason: 'credentials'
      })
    }
    for (const name of ['id_ecdsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk']) {
      expect(file(`${HOME}/projects/keys/${name}`), name).toBe(true)
    }
    // Keep the neighboring settings (other gcloud configuration, Maven repositories other than the one, a project's .yarnrc.yml).
    expect(file(`${HOME}/.config/gcloud/configurations/config_default`)).toBe(false)
    expect(file(`${HOME}/.m2/toolchains.xml`)).toBe(false)
    expect(file(`${HOME}/projects/app/.yarnrc.yml`)).toBe(false)
    expect(file(`${HOME}/projects/keys/id_rsa.pub`)).toBe(false)
  })

  it('excludes generated-output directories at any level', () => {
    expect(dir(`${HOME}/projects/app/node_modules`)).toBe(true)
    expect(dir(`${HOME}/projects/app/deep/nest/node_modules`)).toBe(true)
    expect(dir(`${HOME}/projects/app/__pycache__`)).toBe(true)
    // `dist` is conditional (TODO 1324): the pure verdict depends on the argument, not on a name alone.
    expect(classify(`${HOME}/projects/app/dist`, 'dist', true, rules, true).excluded).toBe(true)
    expect(dir(`${HOME}/projects/app/dist`)).toBe(false)
  })

  it('excludes .git/objects and keeps the rest directly under .git', () => {
    expect(file(`${HOME}/projects/app/.git/objects/ab/cdef`)).toBe(true)
    expect(file(`${HOME}/projects/app/.git/config`)).toBe(false)
  })

  it('excludes caches and the trash', () => {
    expect(dir(`${HOME}/.cache`)).toBe(true)
    expect(dir(`${HOME}/.Trash`)).toBe(true)
    expect(dir(`${HOME}/.npm`)).toBe(true)
  })

  it("excludes aios's own logs (aios-YYYYMMDD-HHMMSS.log) at any level (TODO 376)", () => {
    // The `dev:instance` copies are written to `~/aios-dev-data/logs/`. That is not in the exclusions, so exclude them by name.
    expect(file(`${HOME}/aios-dev-data/logs/aios-20261004-013012.log`)).toBe(true)
    expect(file(`${HOME}/aios-dev-data/logs/aios-20261004-013012-2.log`)).toBe(true)
    expect(classify(`${HOME}/aios-dev-data/logs/aios-20261004-013012.log`, 'aios-20261004-013012.log', false, rules).reason).toBe('app-log')
    // Ordinary files with similar names, and directories with the same name, are not excluded.
    expect(file(`${HOME}/projects/app/aios-notes.log`)).toBe(false)
    expect(file(`${HOME}/projects/app/aios-20261004.log`)).toBe(false)
    expect(dir(`${HOME}/projects/aios-20261004-013012.log`)).toBe(false)
  })
})

describe('4.4.2 macOS', () => {
  it('excludes the OS area and includes what the user installs', () => {
    expect(dir('/System/Library')).toBe(true)
    expect(dir('/private/var')).toBe(true)
    expect(dir('/bin')).toBe(true)
    expect(dir('/usr/bin')).toBe(true)
    expect(dir('/Applications/Foo.app')).toBe(false)
    expect(dir('/opt/homebrew')).toBe(false)
  })

  it('excludes /usr while including /usr/local (the longest match wins)', () => {
    expect(dir('/usr/share')).toBe(true)
    expect(dir('/usr/local/bin')).toBe(false)
  })

  it('excludes all of ~/Library and includes only iCloud Drive', () => {
    expect(dir(`${HOME}/Library/Application Support/Foo`)).toBe(true)
    expect(dir(`${HOME}/Library/Caches`)).toBe(true)
    expect(dir(`${HOME}/Library/Containers/com.example/Data/Documents`)).toBe(true)
    expect(dir(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Notes`)).toBe(false)
  })

  it('excludes the temporary area', () => {
    expect(dir('/tmp/x')).toBe(true)
    expect(dir('/private/tmp/x')).toBe(true)
    expect(dir('/var/folders/ab/cd')).toBe(true)
  })

  it('includes the user area', () => {
    for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public']) {
      expect(dir(`${HOME}/${name}`)).toBe(false)
    }
    expect(dir(`${HOME}/git/aios`)).toBe(false)
  })
})

describe("4.4.2.2 other users' homes (T20)", () => {
  it('the exclusion rules version is 7 (T20 made /Users excluded, TODO 262 added ~/.aios-test, 633 worktrees, 855 credential locations, 1324 conditional build folders)', () => {
    expect(RULES_VERSION).toBe(7)
  })

  it("excludes /Users and other users' homes", () => {
    expect(dir('/Users')).toBe(true)
    expect(dir('/Users/other')).toBe(true)
    expect(dir('/Users/other/.ssh')).toBe(true)
    expect(dir('/Users/other/Documents')).toBe(true)
    expect(file('/Users/other/Documents/memo.md')).toBe(true)
    expect(classify('/Users/other', 'other', true, rules).reason).toBe('other-users')
    // The credential rules are anchored at ~, so another user's .ssh is caught by the /Users exclusion.
    expect(classify('/Users/other/.ssh', '.ssh', true, rules).reason).toBe('other-users')
  })

  it('excludes /Users/Shared too (a write target of other users)', () => {
    expect(dir('/Users/Shared')).toBe(true)
    expect(file('/Users/Shared/notes.txt')).toBe(true)
    expect(classify('/Users/Shared', 'Shared', true, rules).reason).toBe('other-users')
  })

  it("one's own home stays (the include wins by longest match)", () => {
    expect(dir(HOME)).toBe(false)
    expect(dir(`${HOME}/Documents`)).toBe(false)
    expect(file(`${HOME}/Documents/memo.md`)).toBe(false)
    expect(dir(`${HOME}/git/aios`)).toBe(false)
    expect(dir('/users/TESTER/Desktop')).toBe(false)
    expect(rules.prefixes.find((rule) => rule.reason === 'own-home')?.raw).toBe(HOME)
  })

  it('another home whose name is only a prefix match does not pass', () => {
    expect(dir(`${HOME}2`)).toBe(true)
    expect(dir(`${HOME}-old/Documents`)).toBe(true)
  })

  it("inside one's own home the existing exclusions apply as before", () => {
    expect(dir(`${HOME}/.ssh`)).toBe(true)
    expect(dir(`${HOME}/Library/Caches`)).toBe(true)
    expect(dir(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Notes`)).toBe(false)
    expect(dir(`${HOME}/projects/app/node_modules`)).toBe(true)
  })
})

describe('4.3.2 disposable dump ~/aios/scratch (T19)', () => {
  // TODO 24's "location selection": anything under ~/Library is excluded, so it cannot be used. Placing it in a visible spot under home means the scan, assertAllowed, and the Broker's three paths all apply as they are.
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

  it("none of the root, a thread's scratch area and a file inside it hits an exclusion", () => {
    expect(dir(scratchRoot(HOME))).toBe(false)
    expect(dir(`${HOME}/aios`)).toBe(false)
    expect(dir(scratchCwd(HOME, id))).toBe(false)
    expect(file(`${scratchCwd(HOME, id)}/output.txt`)).toBe(false)
    expect(classify(scratchCwd(HOME, id), id, true, rules)).toEqual({ excluded: false, reason: null })
  })

  it('the own-home include wins even under the T20 /Users exclusion', () => {
    // /Users is excluded, but one's own home comes back through include (4.4.2.2). The scratch area is under it.
    expect(dir('/Users')).toBe(true)
    expect(dir(scratchRoot(HOME))).toBe(false)
  })

  it('the same for rules built with the real home', () => {
    const real = createMacosExclusions()
    const cwd = scratchCwd(homedir(), id)
    expect(isExcluded(cwd, id, true, real)).toBe(false)
    expect(isExcluded(`${cwd}/notes.md`, 'notes.md', false, real)).toBe(false)
  })

  it('generated-output directories inside the scratch area are still excluded (the rules are unchanged)', () => {
    expect(dir(`${scratchCwd(HOME, id)}/node_modules`)).toBe(true)
  })
})

describe('4.4.2 external storage (T4)', () => {
  it('under /Volumes is excluded by default', () => {
    expect(dir('/Volumes')).toBe(true)
    expect(dir('/Volumes/External')).toBe(true)
    expect(dir('/Volumes/External/work')).toBe(true)
    expect(file('/Volumes/External/work/notes.md')).toBe(true)
    expect(classify('/Volumes/External', 'External', true, rules).reason).toBe('external-volume')
    expect(rules.allowedVolumes).toEqual([])
  })

  it('only an allowed volume passes (longest match)', () => {
    const allowed = createMacosExclusions(HOME, { allowedVolumes: ['/Volumes/External'] })
    const ok = (path: string): boolean =>
      isExcluded(path, path.slice(path.lastIndexOf('/') + 1), true, allowed)
    expect(ok('/Volumes/External')).toBe(false)
    expect(ok('/Volumes/External/work')).toBe(false)
    expect(ok('/Volumes/EXTERNAL/Work')).toBe(false)
    // A different volume whose name only matches as a prefix does not pass.
    expect(ok('/Volumes/External2')).toBe(true)
    expect(ok('/Volumes/Other/work')).toBe(true)
    expect(ok('/Volumes')).toBe(true)
    // Even inside an allowed volume, the generated-output rules still apply.
    expect(ok('/Volumes/External/app/node_modules')).toBe(true)
    expect(allowed.allowedVolumes).toEqual(['/Volumes/External'])
  })

  it('only the mount path form (/Volumes/<name>) can be allowed', () => {
    expect(isVolumeMountPath('/Volumes/External')).toBe(true)
    expect(isVolumeMountPath('/volumes/external')).toBe(true)
    expect(isVolumeMountPath('/Volumes')).toBe(false)
    expect(isVolumeMountPath('/Volumes/')).toBe(false)
    expect(isVolumeMountPath('/Volumes/External/work')).toBe(false)
    expect(isVolumeMountPath('/Volumes/..')).toBe(false)
    expect(isVolumeMountPath('/Users/x/Volumes/External')).toBe(false)
    expect(isVolumeMountPath('/tmp/vol/External', '/tmp/vol')).toBe(true)
  })

  describe('cannot be bypassed through a symlink (the scan re-decides after realpath)', () => {
    let base: string
    let volumesDir: string
    let home: string

    beforeAll(() => {
      // tmpdir() is under /var/folders and is excluded, so create the directory under home.
      base = makeTestDir('excl-test')
      volumesDir = join(base, 'Volumes')
      home = join(base, 'home')
      mkdirSync(join(volumesDir, 'Allowed'), { recursive: true })
      mkdirSync(join(volumesDir, 'Other'), { recursive: true })
      mkdirSync(home, { recursive: true })
      writeFileSync(join(volumesDir, 'Allowed', 'a.txt'), 'a')
      writeFileSync(join(volumesDir, 'Other', 'b.txt'), 'b')
      writeFileSync(join(home, 'own.txt'), 'own')
      // A symlink under home that points to external storage.
      symlinkSync(join(volumesDir, 'Other'), join(home, 'to-other'))
      symlinkSync(join(volumesDir, 'Allowed'), join(home, 'to-allowed'))
    })

    afterAll(() => {
      rmSync(base, { recursive: true, force: true })
    })

    async function walkAll(rulesForWalk: ReturnType<typeof createMacosExclusions>): Promise<string[]> {
      const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
      const paths: string[] = []
      for await (const batch of walk(home, rulesForWalk, counters)) {
        for (const entry of batch) paths.push(entry.path)
      }
      return paths
    }

    it('does not descend into a symlink to a volume that is not allowed', async () => {
      const r = createMacosExclusions(home, { volumesDir })
      const paths = await walkAll(r)
      expect(paths).toContain(join(home, 'own.txt'))
      expect(paths.some((p) => p.startsWith(join(home, 'to-other')))).toBe(false)
      expect(paths.some((p) => p.startsWith(join(home, 'to-allowed')))).toBe(false)
    })

    it('a symlink to an allowed volume becomes a row but is not descended into (TODO 924)', async () => {
      const r = createMacosExclusions(home, {
        volumesDir,
        allowedVolumes: [join(volumesDir, 'Allowed')]
      })
      const paths = await walkAll(r)
      // A directory symlink is listed only as a row. Its contents come in through the real path under the root of the allowed volume (which is itself a scan root).
      expect(paths).toContain(join(home, 'to-allowed'))
      expect(paths).not.toContain(join(home, 'to-allowed', 'a.txt'))
      expect(paths.some((p) => p.startsWith(join(home, 'to-other')))).toBe(false)
    })
  })
})

describe('APFS does not distinguish case (PHASE1_BRIEF 3.3)', () => {
  it('gives the same decision even when the case differs', () => {
    expect(dir(`${HOME}/LIBRARY/Caches`)).toBe(true)
    expect(dir(`${HOME}/projects/NODE_MODULES`)).toBe(true)
    expect(dir(`${HOME}/Library/MOBILE DOCUMENTS/com~apple~CloudDocs`)).toBe(false)
  })
})

describe('classify returns a reason', () => {
  it('the reason for the exclusion is known', () => {
    expect(classify(`${HOME}/.ssh`, '.ssh', true, rules).reason).toBe('credentials')
    expect(classify(`${HOME}/a/node_modules`, 'node_modules', true, rules).reason).toBe('generated')
    expect(classify(`${HOME}/Library`, 'Library', true, rules).reason).toBe('app-internal')
    expect(classify(`${HOME}/Documents`, 'Documents', true, rules).reason).toBeNull()
  })
})

/**
 * TODO 561: `/tmp` is "not put in the index" but "allowed to open" (both read and write). The exclusion is split into two kinds:
 * `classify` (scan, index, watch, reference scope) keeps excluding as before, and `classifyAccess` (the choke point of the open route) returns only the OS-area rules (`system`) under `openableDirs`. `/tmp` → `/private/tmp` also passes after realpath.
 */
describe('TODO 561: /tmp is not indexed but can be opened', () => {
  let tmp: string

  beforeAll(() => {
    // Create it in the real `/tmp` (we want to see it pass through the symlink to `/private/tmp`). Remove it afterwards.
    tmp = mkdtempSync('/tmp/aios-561-')
    writeFileSync(join(tmp, 'a.py'), 'print(1)\n')
    mkdirSync(join(tmp, 'node_modules'))
    writeFileSync(join(tmp, '.netrc'), 'machine x\n')
    // A symlink inside `/tmp` that points to an OS area (`/etc` = `/private/etc`).
    symlinkSync('/etc/hosts', join(tmp, 'hosts-link'))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('the index (classify) keeps both /tmp and /private/tmp excluded', () => {
    expect(dir('/tmp')).toBe(true)
    expect(file('/tmp/x/a.py')).toBe(true)
    expect(file('/private/tmp/x/a.py')).toBe(true)
  })

  it('the open path (classifyAccess) passes both read and write; names of generated output and credentials inside are not restored', () => {
    for (const access of ['read', 'write'] as const) {
      expect(classifyAccess('/tmp', 'tmp', true, rules, access).excluded).toBe(false)
      expect(classifyAccess('/tmp/x/a.py', 'a.py', false, rules, access).excluded).toBe(false)
      expect(classifyAccess('/private/tmp/x/a.py', 'a.py', false, rules, access).excluded).toBe(false)
      expect(classifyAccess('/tmp/x/node_modules', 'node_modules', true, rules, access).excluded).toBe(true)
      expect(classifyAccess('/tmp/.netrc', '.netrc', false, rules, access).excluded).toBe(true)
    }
  })

  it('the table for the "may not even be opened" side is as before (OS area, credentials, others\' homes, ~/Library)', () => {
    const denied = [
      '/System/Library/x.plist',
      '/private/var/db/x',
      '/private/var/folders/ab/T/x.png',
      '/var/log/system.log',
      '/private/etc/hosts',
      '/etc/hosts',
      '/dev/null',
      '/usr/bin/env',
      '/Library/Preferences/x.plist',
      `${HOME}/.ssh/id_rsa`,
      `${HOME}/Library/Caches/x`,
      '/Users/other/a.txt'
    ]
    for (const path of denied) {
      for (const access of ['read', 'write'] as const) {
        expect(
          classifyAccess(path, path.slice(path.lastIndexOf('/') + 1), false, rules, access).excluded,
          `${path} (${access})`
        ).toBe(true)
      }
    }
  })

  it('the choke point (resolvePath) passes a real file in /tmp, and the target is /private/tmp; a symlink pointing at the OS area is symlink-escape', () => {
    const resolved = resolvePath(join(tmp, 'a.py'), { rules }, false, 'write')
    expect(resolved.canonical.startsWith('/private/tmp/')).toBe(true)
    expect(resolvePath(join(tmp, 'a.py'), { rules }, false, 'read').exists).toBe(true)
    expect(() => resolvePath(join(tmp, 'hosts-link'), { rules }, false, 'read')).toThrow('symlink-escape')
    // Within the scope a plugin declares (the Broker sets `openableDirs` to empty), exclusions still apply as before.
    expect(() =>
      resolvePath(join(tmp, 'a.py'), { rules: { ...rules, openableDirs: [] }, roots: [tmp] }, false, 'read')
    ).toThrow('excluded')
  })

  it('FsAccess: the choke point passes /tmp for both read and write and it can be added to the reference scope (--add-dir) (TODO 584); /tmp appears in the shortcuts', () => {
    const fs = new FsAccess(HOME)
    expect(fs.assertAllowed(pathToUri(join(tmp, 'a.py')), false)).toBe(join(tmp, 'a.py'))
    expect(fs.assertAllowed(pathToUri(tmp), true, 'read')).toBe(tmp)
    expect(fs.isViewable(join(tmp, 'a.py'))).toBe(true)
    // TODO 584 (wave 28): the user may add it. It is not within the default reference scope (directly under home).
    expect(fs.isReferenceable(tmp)).toBe(true)
    expect(fs.isReferenceable('/private/tmp')).toBe(true)
    expect(fs.defaultReferenceDirs()).not.toContain('/tmp')
    const shortcut = fs.roots().find((root) => root.shortcut === 'tmp')
    expect(shortcut).toMatchObject({ uri: 'file:///tmp', name: 'tmp', isDirectory: true })
  })

  it('index process: /tmp can be read in place and listed, and even when told that something was created it does not enter the index', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const home = makeTestDir('exclusions-561')
    const indexer = new FsIndexer(
      db,
      { onScanStatus: () => {}, onFileChanges: () => {} },
      new IndexStore(db),
      home,
      [home]
    )
    try {
      const listing = await indexer.listDirectory(pathToUri(tmp))
      expect(listing.live).toBe(true)
      expect(listing.reason).toBeNull()
      // node_modules and .netrc do not appear, and symlinks pointing to OS areas do not appear either.
      expect(listing.entries.map((entry) => entry.name)).toEqual(['a.py'])
      writeFileSync(join(tmp, 'b.py'), 'print(2)\n')
      await indexer.noteCreated([pathToUri(join(tmp, 'b.py'))])
      const found = await indexer.searchFiles('b.py', 50, null, null)
      expect(found.entries).toEqual([])
    } finally {
      await indexer.stop()
      db.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/**
 * TODO 584 (wave 28 bundle B): a third axis of exclusion, "can be added to the reference scope (`--add-dir`)". `/tmp` can be added, but the index (`classify`) still excludes it, and other places in OS areas and the generated outputs inside them cannot be added.
 */
describe('TODO 584: /tmp can be added to the reference scope (classifyReference)', () => {
  it('/tmp, /private/tmp and below can be added; the index (classify) stays excluded', () => {
    for (const path of ['/tmp', '/private/tmp', '/tmp/x', '/private/tmp/x/y']) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      expect(classifyReference(path, name, true, rules).excluded, path).toBe(false)
      expect(classify(path, name, true, rules).excluded, path).toBe(true)
    }
  })

  it('OS areas other than /tmp, generated output inside, and home exclusions cannot be added', () => {
    const denied: [string, string][] = [
      ['/private/var/folders/ab/T', 'T'],
      ['/private', 'private'],
      ['/etc', 'etc'],
      ['/System/Library', 'Library'],
      ['/tmp/x/node_modules', 'node_modules'],
      [`${HOME}/Library/Caches`, 'Caches'],
      [`${HOME}/.ssh`, '.ssh'],
      ['/Users/other', 'other']
    ]
    for (const [path, name] of denied) {
      expect(classifyReference(path, name, true, rules).excluded, path).toBe(true)
    }
  })

  it('where there is no exclusion, the same as classify', () => {
    expect(classifyReference(`${HOME}/Documents`, 'Documents', true, rules).excluded).toBe(false)
  })
})

/**
 * TODO 633 stage 1 (wave 29 bundle F): `.claude/worktrees/` is excluded from the index (scan, watch, full-text search, filename search) at any depth and in any repository, but, as with `/tmp`, opening it is allowed.
 */
describe('TODO 633 stage 1: excludes .claude/worktrees/ from the index (opening is allowed)', () => {
  it('at any depth, classify excludes it if .claude/worktrees is part of the absolute path', () => {
    const paths = [
      `${HOME}/git/aios/.claude/worktrees`,
      `${HOME}/git/aios/.claude/worktrees/wave29-f`,
      `${HOME}/git/aios/.claude/worktrees/wave29-f/src/index.ts`,
      `${HOME}/other-project/.claude/worktrees/x`
    ]
    for (const path of paths) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      expect(classify(path, name, false, rules).excluded, path).toBe(true)
      expect(classify(path, name, false, rules).reason, path).toBe('worktree')
    }
  })

  it('under .claude, things other than worktrees (settings etc.) are not excluded', () => {
    const path = `${HOME}/git/aios/.claude/settings.json`
    expect(classify(path, 'settings.json', false, rules).excluded).toBe(false)
  })

  it('the very spelling of WORKTREES_PATH_SUFFIX', () => {
    expect(WORKTREES_PATH_SUFFIX).toBe('/.claude/worktrees')
  })

  it('classifyAccess passes both read and write (opening is allowed, same as /tmp)', () => {
    const path = `${HOME}/git/aios/.claude/worktrees/wave29-f/src/index.ts`
    for (const access of ['read', 'write'] as const) {
      expect(classifyAccess(path, 'index.ts', false, rules, access).excluded, access).toBe(false)
    }
  })

  it('FsAccess: files inside a worktree pass for both read and write', () => {
    const fs = new FsAccess(HOME)
    const path = `${HOME}/git/aios/.claude/worktrees/wave29-f/src/index.ts`
    expect(fs.assertAllowed(pathToUri(path), false)).toBe(path)
  })

  it('code-review (constraint 2): ~/.claude/worktrees/… stays credentials and is refused for both read and write', () => {
    const path = `${HOME}/.claude/worktrees/x/file.ts`
    expect(classify(path, 'file.ts', false, rules)).toEqual({ excluded: true, reason: 'credentials' })
    for (const access of ['read', 'write'] as const) {
      expect(classifyAccess(path, 'file.ts', false, rules, access).excluded, access).toBe(true)
    }
    const fs = new FsAccess(HOME)
    expect(() => fs.assertAllowed(pathToUri(path), false)).toThrow()
  })

  it('code-review: .claude/worktrees under a volume that is not allowed, another user and the OS area stays excluded', () => {
    const cases: [string, string][] = [
      ['/Volumes/USB/repo/.claude/worktrees/x/a.ts', 'external-volume'],
      ['/Users/other/repo/.claude/worktrees/x/a.ts', 'other-users'],
      ['/System/repo/.claude/worktrees/x/a.ts', 'system']
    ]
    for (const [path, reason] of cases) {
      expect(classify(path, 'a.ts', false, rules).reason, path).toBe(reason)
      for (const access of ['read', 'write'] as const) {
        expect(classifyAccess(path, 'a.ts', false, rules, access).excluded, `${path} ${access}`).toBe(true)
      }
    }
  })

  it('code-review: .claude/worktrees under an allowed volume is a worktree (can be opened)', () => {
    const allowed = createMacosExclusions(HOME, { allowedVolumes: ['/Volumes/USB'] })
    const path = '/Volumes/USB/repo/.claude/worktrees/x/a.ts'
    expect(classify(path, 'a.ts', false, allowed).reason).toBe('worktree')
    expect(classifyAccess(path, 'a.ts', false, allowed, 'write').excluded).toBe(false)
  })
})
