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

describe('4.4.1 OS 共通の除外', () => {
  it('資格情報ディレクトリを除外する', () => {
    expect(dir(`${HOME}/.ssh`)).toBe(true)
    expect(dir(`${HOME}/.aws`)).toBe(true)
    expect(dir(`${HOME}/.gnupg`)).toBe(true)
    expect(dir(`${HOME}/.config/gh`)).toBe(true)
    expect(file(`${HOME}/.ssh/id_rsa`)).toBe(true)
  })

  it('バックエンドの資格情報ディレクトリ (compat/backend-paths.json) を除外する', () => {
    // Constraint 2: do not touch credentials. The proper names are on the compat/ side, so here we check that "one or more hidden directories directly under home are excluded".
    const backendDirs = rules.prefixes.filter(
      (rule) => rule.reason === 'credentials' && rule.prefix.startsWith(`${HOME.toLowerCase()}/.`)
    )
    expect(backendDirs.length).toBeGreaterThan(4)
  })

  it('資格情報ファイルはどの階層でも除外する', () => {
    expect(file(`${HOME}/projects/x/.netrc`)).toBe(true)
    expect(file(`${HOME}/projects/x/.npmrc`)).toBe(true)
  })

  it('TODO 855: よく使われる資格情報の置き場と ssh の鍵の名前を除外する', () => {
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

  it('生成物のディレクトリをどの階層でも除外する', () => {
    expect(dir(`${HOME}/projects/app/node_modules`)).toBe(true)
    expect(dir(`${HOME}/projects/app/deep/nest/node_modules`)).toBe(true)
    expect(dir(`${HOME}/projects/app/__pycache__`)).toBe(true)
    expect(dir(`${HOME}/projects/app/dist`)).toBe(true)
  })

  it('.git/objects を除外し、.git 直下の他は残す', () => {
    expect(file(`${HOME}/projects/app/.git/objects/ab/cdef`)).toBe(true)
    expect(file(`${HOME}/projects/app/.git/config`)).toBe(false)
  })

  it('キャッシュとゴミ箱を除外する', () => {
    expect(dir(`${HOME}/.cache`)).toBe(true)
    expect(dir(`${HOME}/.Trash`)).toBe(true)
    expect(dir(`${HOME}/.npm`)).toBe(true)
  })

  it('aios 自身のログ (aios-YYYYMMDD-HHMMSS.log) はどの階層でも除外する (TODO 376)', () => {
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
  it('OS 領域を除外し、ユーザが入れるものは含める', () => {
    expect(dir('/System/Library')).toBe(true)
    expect(dir('/private/var')).toBe(true)
    expect(dir('/bin')).toBe(true)
    expect(dir('/usr/bin')).toBe(true)
    expect(dir('/Applications/Foo.app')).toBe(false)
    expect(dir('/opt/homebrew')).toBe(false)
  })

  it('/usr は除外しつつ /usr/local は含める (最長一致が勝つ)', () => {
    expect(dir('/usr/share')).toBe(true)
    expect(dir('/usr/local/bin')).toBe(false)
  })

  it('~/Library 全般を除外し、iCloud Drive だけ含める', () => {
    expect(dir(`${HOME}/Library/Application Support/Foo`)).toBe(true)
    expect(dir(`${HOME}/Library/Caches`)).toBe(true)
    expect(dir(`${HOME}/Library/Containers/com.example/Data/Documents`)).toBe(true)
    expect(dir(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Notes`)).toBe(false)
  })

  it('一時領域を除外する', () => {
    expect(dir('/tmp/x')).toBe(true)
    expect(dir('/private/tmp/x')).toBe(true)
    expect(dir('/var/folders/ab/cd')).toBe(true)
  })

  it('ユーザ領域を含める', () => {
    for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public']) {
      expect(dir(`${HOME}/${name}`)).toBe(false)
    }
    expect(dir(`${HOME}/git/aios`)).toBe(false)
  })
})

describe('4.4.2.2 他ユーザーのホーム (T20)', () => {
  it('除外規則の版は 6 (T20 で /Users を除外に倒し、TODO 262 で ~/.aios-test、633 で worktree、855 で資格情報の置き場を足した)', () => {
    expect(RULES_VERSION).toBe(6)
  })

  it('/Users と他ユーザーのホームを除外する', () => {
    expect(dir('/Users')).toBe(true)
    expect(dir('/Users/other')).toBe(true)
    expect(dir('/Users/other/.ssh')).toBe(true)
    expect(dir('/Users/other/Documents')).toBe(true)
    expect(file('/Users/other/Documents/memo.md')).toBe(true)
    expect(classify('/Users/other', 'other', true, rules).reason).toBe('other-users')
    // The credential rules are anchored at ~, so another user's .ssh is caught by the /Users exclusion.
    expect(classify('/Users/other/.ssh', '.ssh', true, rules).reason).toBe('other-users')
  })

  it('/Users/Shared も除外する (他ユーザーの書き込み先)', () => {
    expect(dir('/Users/Shared')).toBe(true)
    expect(file('/Users/Shared/notes.txt')).toBe(true)
    expect(classify('/Users/Shared', 'Shared', true, rules).reason).toBe('other-users')
  })

  it('自分のホームは残る (最長一致で include が勝つ)', () => {
    expect(dir(HOME)).toBe(false)
    expect(dir(`${HOME}/Documents`)).toBe(false)
    expect(file(`${HOME}/Documents/memo.md`)).toBe(false)
    expect(dir(`${HOME}/git/aios`)).toBe(false)
    expect(dir('/users/TESTER/Desktop')).toBe(false)
    expect(rules.prefixes.find((rule) => rule.reason === 'own-home')?.raw).toBe(HOME)
  })

  it('名前が前方一致するだけの別ホームは通らない', () => {
    expect(dir(`${HOME}2`)).toBe(true)
    expect(dir(`${HOME}-old/Documents`)).toBe(true)
  })

  it('自分のホームの中では従来の除外がそのまま効く', () => {
    expect(dir(`${HOME}/.ssh`)).toBe(true)
    expect(dir(`${HOME}/Library/Caches`)).toBe(true)
    expect(dir(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Notes`)).toBe(false)
    expect(dir(`${HOME}/projects/app/node_modules`)).toBe(true)
  })
})

describe('4.3.2 使い捨ての捨て場 ~/aios/scratch (T19)', () => {
  // TODO 24's "location selection": anything under ~/Library is excluded, so it cannot be used. Placing it in a visible spot under home means the scan, assertAllowed, and the Broker's three paths all apply as they are.
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

  it('根・スレッドの捨て場・その中のファイルのどれも除外に当たらない', () => {
    expect(dir(scratchRoot(HOME))).toBe(false)
    expect(dir(`${HOME}/aios`)).toBe(false)
    expect(dir(scratchCwd(HOME, id))).toBe(false)
    expect(file(`${scratchCwd(HOME, id)}/output.txt`)).toBe(false)
    expect(classify(scratchCwd(HOME, id), id, true, rules)).toEqual({ excluded: false, reason: null })
  })

  it('T20 の /Users 除外の下でも own-home の include が勝つ', () => {
    // /Users is excluded, but one's own home comes back through include (4.4.2.2). The scratch area is under it.
    expect(dir('/Users')).toBe(true)
    expect(dir(scratchRoot(HOME))).toBe(false)
  })

  it('本物のホームで作った規則でも同じ', () => {
    const real = createMacosExclusions()
    const cwd = scratchCwd(homedir(), id)
    expect(isExcluded(cwd, id, true, real)).toBe(false)
    expect(isExcluded(`${cwd}/notes.md`, 'notes.md', false, real)).toBe(false)
  })

  it('捨て場の中の生成物ディレクトリは今までどおり除外される (規則は変えていない)', () => {
    expect(dir(`${scratchCwd(HOME, id)}/node_modules`)).toBe(true)
  })
})

describe('4.4.2 外部ストレージ (T4)', () => {
  it('/Volumes 配下は既定で除外する', () => {
    expect(dir('/Volumes')).toBe(true)
    expect(dir('/Volumes/External')).toBe(true)
    expect(dir('/Volumes/External/work')).toBe(true)
    expect(file('/Volumes/External/work/notes.md')).toBe(true)
    expect(classify('/Volumes/External', 'External', true, rules).reason).toBe('external-volume')
    expect(rules.allowedVolumes).toEqual([])
  })

  it('許可したボリュームだけ通る (最長一致)', () => {
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

  it('許可できるのはマウントパス (/Volumes/<name>) の形だけ', () => {
    expect(isVolumeMountPath('/Volumes/External')).toBe(true)
    expect(isVolumeMountPath('/volumes/external')).toBe(true)
    expect(isVolumeMountPath('/Volumes')).toBe(false)
    expect(isVolumeMountPath('/Volumes/')).toBe(false)
    expect(isVolumeMountPath('/Volumes/External/work')).toBe(false)
    expect(isVolumeMountPath('/Volumes/..')).toBe(false)
    expect(isVolumeMountPath('/Users/x/Volumes/External')).toBe(false)
    expect(isVolumeMountPath('/tmp/vol/External', '/tmp/vol')).toBe(true)
  })

  describe('symlink 経由で回り込めない (走査は realpath 後に再判定する)', () => {
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

    it('許可していないボリュームへの symlink は降りない', async () => {
      const r = createMacosExclusions(home, { volumesDir })
      const paths = await walkAll(r)
      expect(paths).toContain(join(home, 'own.txt'))
      expect(paths.some((p) => p.startsWith(join(home, 'to-other')))).toBe(false)
      expect(paths.some((p) => p.startsWith(join(home, 'to-allowed')))).toBe(false)
    })

    it('許可したボリュームへの symlink は行になるが、中へは降りない (TODO 924)', async () => {
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

describe('APFS は大文字小文字を区別しない (PHASE1_BRIEF 3.3)', () => {
  it('大文字小文字が違っても同じ判定になる', () => {
    expect(dir(`${HOME}/LIBRARY/Caches`)).toBe(true)
    expect(dir(`${HOME}/projects/NODE_MODULES`)).toBe(true)
    expect(dir(`${HOME}/Library/MOBILE DOCUMENTS/com~apple~CloudDocs`)).toBe(false)
  })
})

describe('classify は理由を返す', () => {
  it('除外の理由が分かる', () => {
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
describe('TODO 561: /tmp は索引に入れないが開ける', () => {
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

  it('索引 (classify) は /tmp も /private/tmp も除外のまま', () => {
    expect(dir('/tmp')).toBe(true)
    expect(file('/tmp/x/a.py')).toBe(true)
    expect(file('/private/tmp/x/a.py')).toBe(true)
  })

  it('開く経路 (classifyAccess) は read も write も通す。中の生成物・資格情報の名前は戻さない', () => {
    for (const access of ['read', 'write'] as const) {
      expect(classifyAccess('/tmp', 'tmp', true, rules, access).excluded).toBe(false)
      expect(classifyAccess('/tmp/x/a.py', 'a.py', false, rules, access).excluded).toBe(false)
      expect(classifyAccess('/private/tmp/x/a.py', 'a.py', false, rules, access).excluded).toBe(false)
      expect(classifyAccess('/tmp/x/node_modules', 'node_modules', true, rules, access).excluded).toBe(true)
      expect(classifyAccess('/tmp/.netrc', '.netrc', false, rules, access).excluded).toBe(true)
    }
  })

  it('「開くことも許さない」側の表は今までどおり (OS 領域・資格情報・他人のホーム・~/Library)', () => {
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

  it('関門 (resolvePath) は /tmp の実ファイルを通し、実体は /private/tmp。OS 領域を指す symlink は symlink-escape', () => {
    const resolved = resolvePath(join(tmp, 'a.py'), { rules }, false, 'write')
    expect(resolved.canonical.startsWith('/private/tmp/')).toBe(true)
    expect(resolvePath(join(tmp, 'a.py'), { rules }, false, 'read').exists).toBe(true)
    expect(() => resolvePath(join(tmp, 'hosts-link'), { rules }, false, 'read')).toThrow('symlink-escape')
    // Within the scope a plugin declares (the Broker sets `openableDirs` to empty), exclusions still apply as before.
    expect(() =>
      resolvePath(join(tmp, 'a.py'), { rules: { ...rules, openableDirs: [] }, roots: [tmp] }, false, 'read')
    ).toThrow('excluded')
  })

  it('FsAccess: 関門は /tmp を読み書きとも通し、参照範囲 (--add-dir) にも足せる (TODO 584)。近道に /tmp が出る', () => {
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

  it('索引プロセス: /tmp はその場で読んで一覧でき、作ったことを知らせても索引には入らない', async () => {
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
describe('TODO 584: /tmp は参照範囲に足せる (classifyReference)', () => {
  it('/tmp と /private/tmp とその下は足せる。索引 (classify) は除外のまま', () => {
    for (const path of ['/tmp', '/private/tmp', '/tmp/x', '/private/tmp/x/y']) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      expect(classifyReference(path, name, true, rules).excluded, path).toBe(false)
      expect(classify(path, name, true, rules).excluded, path).toBe(true)
    }
  })

  it('/tmp 以外の OS 領域・中の生成物・ホームの除外は足せない', () => {
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

  it('除外でないところは classify と同じ', () => {
    expect(classifyReference(`${HOME}/Documents`, 'Documents', true, rules).excluded).toBe(false)
  })
})

/**
 * TODO 633 stage 1 (wave 29 bundle F): `.claude/worktrees/` is excluded from the index (scan, watch, full-text search, filename search) at any depth and in any repository, but, as with `/tmp`, opening it is allowed.
 */
describe('TODO 633 段 1: .claude/worktrees/ を索引から除外する (開くのは許す)', () => {
  it('どの深さでも、絶対パスの一部に .claude/worktrees があれば classify が除外する', () => {
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

  it('.claude 配下でも worktrees 以外 (settings 等) は除外しない', () => {
    const path = `${HOME}/git/aios/.claude/settings.json`
    expect(classify(path, 'settings.json', false, rules).excluded).toBe(false)
  })

  it('WORKTREES_PATH_SUFFIX の綴りそのもの', () => {
    expect(WORKTREES_PATH_SUFFIX).toBe('/.claude/worktrees')
  })

  it('classifyAccess は read も write も通す (開くことは /tmp と同じく許す)', () => {
    const path = `${HOME}/git/aios/.claude/worktrees/wave29-f/src/index.ts`
    for (const access of ['read', 'write'] as const) {
      expect(classifyAccess(path, 'index.ts', false, rules, access).excluded, access).toBe(false)
    }
  })

  it('FsAccess: worktree の中のファイルは読み書きとも通る', () => {
    const fs = new FsAccess(HOME)
    const path = `${HOME}/git/aios/.claude/worktrees/wave29-f/src/index.ts`
    expect(fs.assertAllowed(pathToUri(path), false)).toBe(path)
  })

  it('code-review (制約 2): ~/.claude/worktrees/… は credentials のまま、読み書きとも拒否する', () => {
    const path = `${HOME}/.claude/worktrees/x/file.ts`
    expect(classify(path, 'file.ts', false, rules)).toEqual({ excluded: true, reason: 'credentials' })
    for (const access of ['read', 'write'] as const) {
      expect(classifyAccess(path, 'file.ts', false, rules, access).excluded, access).toBe(true)
    }
    const fs = new FsAccess(HOME)
    expect(() => fs.assertAllowed(pathToUri(path), false)).toThrow()
  })

  it('code-review: 許可していないボリューム・他ユーザー・OS 領域の下の .claude/worktrees は除外のまま', () => {
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

  it('code-review: 許可したボリュームの下の .claude/worktrees は worktree (開ける)', () => {
    const allowed = createMacosExclusions(HOME, { allowedVolumes: ['/Volumes/USB'] })
    const path = '/Volumes/USB/repo/.claude/worktrees/x/a.ts'
    expect(classify(path, 'a.ts', false, allowed).reason).toBe('worktree')
    expect(classifyAccess(path, 'a.ts', false, allowed, 'write').excluded).toBe(false)
  })
})
