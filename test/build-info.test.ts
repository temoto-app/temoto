/**
 * TODO 316 (wave 17 bundle A): the app's version format (`src/shared/build-info.ts`), how build-time values are made
 * (`src/common/build-stamp.ts`), main's runtime values (`src/main/build-info.ts`), and the shape of `AppInfo`.
 * The embedding itself is in `test/build-stamp-bundle.test.ts` (after the build only).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  aboutPanelValues,
  formatBuildBadge,
  formatBuildCopyText,
  formatShortDate,
  relativeAge,
  shortCommit,
  type BuildInfo,
  type RuntimeInfo
} from '../src/shared/build-info.js'
import { isReleaseBuild, readBuildStamp, type GitRunner } from '../src/common/build-stamp.js'
import { currentBuildInfo, currentRuntimeInfo } from '../src/main/build-info.js'
import type { AppInfo } from '../src/shared/types.js'
import { DICTIONARIES } from '../src/renderer/src/i18n/index.js'

const SHA = '179996e0123456789abcdef0123456789abcdef0'
/** 2026-10-02 15:34 in local time (the format prints in local time, so the test is also built in local time). */
const LOCAL = new Date(2026, 9, 2, 15, 34, 12)
const BUILD: BuildInfo = { version: '0.17.0', commit: SHA, dirty: false, date: LOCAL.toISOString() }
const RUNTIME: RuntimeInfo = {
  electron: '38.0.0',
  chromium: '140.0.0.0',
  node: '22.19.0',
  v8: '14.0.0-electron.0',
  os: 'Darwin arm64 25.6.0'
}

describe('書式', () => {
  it('shortCommit は 7 桁、unknown はそのまま', () => {
    expect(shortCommit(SHA)).toBe('179996e')
    expect(shortCommit('unknown')).toBe('unknown')
  })

  it('BottomBar の短縮形は「版 · commit · Mon D, h:mm AM/PM」(TODO 457、英語圏の書式で固定)、dirty なら commit に *', () => {
    expect(formatShortDate(BUILD.date)).toBe('Oct 2, 3:34 PM')
    expect(formatBuildBadge(BUILD)).toBe('0.17.0 · 179996e · Oct 2, 3:34 PM')
    expect(formatBuildBadge({ ...BUILD, dirty: true })).toBe('0.17.0 · 179996e* · Oct 2, 3:34 PM')
  })

  it('年は出さない。真夜中は 12 AM、正午は 12 PM、日は 0 埋めしない', () => {
    const midnight = new Date(2026, 0, 9, 0, 5, 0)
    const noon = new Date(2026, 0, 9, 12, 0, 0)
    expect(formatShortDate(midnight.toISOString())).toBe('Jan 9, 12:05 AM')
    expect(formatShortDate(noon.toISOString())).toBe('Jan 9, 12:00 PM')
  })

  it('日時が無い (define を通らない読み込み) ときは日時を落とす', () => {
    expect(formatBuildBadge({ version: '0.1.0', commit: 'unknown', dirty: false, date: '' })).toBe('0.1.0')
  })

  it('相対時刻: 1 分未満は now、分 / 時間 / 日、未来 (時計のずれ) も now、読めない日時は null', () => {
    const base = LOCAL.getTime()
    expect(relativeAge(BUILD.date, base + 30_000)).toEqual({ unit: 'now' })
    expect(relativeAge(BUILD.date, base - 5_000)).toEqual({ unit: 'now' })
    expect(relativeAge(BUILD.date, base + 5 * 60_000)).toEqual({ unit: 'minute', count: 5 })
    expect(relativeAge(BUILD.date, base + 3 * 3_600_000 + 10)).toEqual({ unit: 'hour', count: 3 })
    expect(relativeAge(BUILD.date, base + 2 * 86_400_000 + 10)).toEqual({ unit: 'day', count: 2 })
    expect(relativeAge('', base)).toBeNull()
  })

  it('コピー用の文字列は VS Code の About と同じ「見出し: 値」の行 (英語固定・相対時刻なし)', () => {
    expect(formatBuildCopyText({ ...BUILD, dirty: true }, RUNTIME)).toBe(
      [
        '0.17.0',
        `${SHA} (dirty)`,
        BUILD.date,
        '38.0.0',
        '140.0.0.0',
        '22.19.0',
        '14.0.0-electron.0',
        'Darwin arm64 25.6.0'
      ]
        .map((value, index) => `${['Version', 'Commit', 'Commit date', 'Electron', 'Chromium', 'Node.js', 'V8', 'OS'][index]}: ${value}`)
        .join('\n')
    )
  })

  it('配る版 (commit が unknown) のコピー用の文字列は日付を Build date と書く', () => {
    const lines = formatBuildCopyText({ ...BUILD, commit: 'unknown' }, RUNTIME).split('\n')
    expect(lines[2]).toBe(`Build date: ${BUILD.date}`)
    expect(lines.some((line) => line.startsWith('Commit date'))).toBe(false)
  })

  it('About パネルの値: applicationVersion は版、version は commit と手元の日時、credits はコピー用の文字列', () => {
    const values = aboutPanelValues({ ...BUILD, dirty: true }, RUNTIME)
    expect(values.applicationVersion).toBe('0.17.0')
    expect(values.version).toBe('179996e* · 2026-10-02 15:34')
    expect(values.credits).toBe(formatBuildCopyText({ ...BUILD, dirty: true }, RUNTIME))
  })

  it('UI に出す語に制約 5 の名前が入らない', () => {
    const text = JSON.stringify(aboutPanelValues(BUILD, RUNTIME)) + formatBuildBadge(BUILD)
    const words = Object.entries(DICTIONARIES.en)
      .concat(Object.entries(DICTIONARIES.ja))
      .filter(([key]) => key.startsWith('build.'))
      .map(([, value]) => value)
      .join('\n')
    for (const name of ['Claude', 'Anthropic']) {
      expect(text).not.toContain(name)
      expect(words).not.toContain(name)
    }
  })
})

describe('readBuildStamp (ビルド時に 1 回)', () => {
  /** The HEAD committer date (`%cI`, with timezone offset). Not the time it was built (TODO 1010). */
  const COMMIT_DATE = '2026-10-02T15:34:00+09:00'
  const fake =
    (answers: Record<string, string | Error>): GitRunner =>
    (args) => {
      const answer = answers[args[0] ?? '']
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no')
      return answer
    }

  it('git があれば HEAD の 40 桁と dirty (追跡中の変更) と commit の日付 (committer date) を取る', () => {
    const stamp = readBuildStamp('/nowhere', {
      version: '0.17.0',
      git: fake({ 'rev-parse': `${SHA.toUpperCase()}\n`, show: `${COMMIT_DATE}\n`, status: ' M src/main/index.ts\n' })
    })
    expect(stamp).toEqual({ version: '0.17.0', commit: SHA, dirty: true, date: COMMIT_DATE })
  })

  it('日付は git show の %cI を使う (ビルドした時刻ではない): 同じ commit なら何度呼んでも同じ値', () => {
    const calls: string[][] = []
    const recording: GitRunner = (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse') return SHA
      if (args[0] === 'show') return COMMIT_DATE
      return ''
    }
    const first = readBuildStamp('/nowhere', { version: '1', git: recording })
    const second = readBuildStamp('/nowhere', { version: '1', git: recording })
    expect(first.date).toBe(COMMIT_DATE)
    expect(second.date).toBe(first.date)
    expect(calls).toContainEqual(['show', '-s', '--format=%cI', 'HEAD'])
  })

  it('作業木がきれいなら dirty: false', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: COMMIT_DATE, status: '' }) })
    expect(stamp.dirty).toBe(false)
    expect(stamp.date).toBe(COMMIT_DATE)
  })

  it('git が無い・リポジトリ外では落ちずに unknown、日付は空', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': new Error('ENOENT') }) })
    expect(stamp).toEqual({ version: '1', commit: 'unknown', dirty: false, date: '' })
  })

  it('show だけ失敗しても commit は残し、日付は空', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: new Error('x'), status: '' }) })
    expect(stamp.commit).toBe(SHA)
    expect(stamp.date).toBe('')
  })

  it('読めない日付 (git が変な出力を返す) は空にする', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: 'not a date', status: '' }) })
    expect(stamp.date).toBe('')
  })

  it('status だけ失敗しても commit は残す', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: COMMIT_DATE, status: new Error('x') }) })
    expect(stamp.commit).toBe(SHA)
    expect(stamp.dirty).toBe(false)
  })

  it('version を省けば package.json の値、読めなければ 0.0.0', () => {
    const root = new URL('..', import.meta.url).pathname
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string }
    expect(readBuildStamp(root, { git: fake({}) }).version).toBe(pkg.version)
    expect(readBuildStamp('/nonexistent-dir-316', { git: fake({}) }).version).toBe('0.0.0')
  })

  it('TODO 1190: 配る版はビルド元 の commit を埋めず、日付はビルド時刻', () => {
    const now = new Date('2026-11-08T01:02:03.000Z')
    const runner: GitRunner = () => {
      throw new Error('release では git を呼ばない')
    }
    const stamp = readBuildStamp('/nowhere', { version: '1', release: true, now, git: runner })
    expect(stamp).toEqual({ version: '1', commit: 'unknown', dirty: false, date: now.toISOString() })
    expect(isReleaseBuild({ AIOS_RELEASE: '1' })).toBe(true)
    expect(isReleaseBuild({})).toBe(false)
  })

  it('TODO 1190: commit が無い札・About は commit を出さず崩れない', () => {
    const rel = { version: '0.79.0', commit: 'unknown', dirty: false, date: '2026-11-08T01:02:03.000Z' }
    expect(formatBuildBadge(rel)).not.toContain('unknown')
    expect(formatBuildBadge(rel)).toMatch(/^0\.79\.0 · Nov \d+, /)
    const about = aboutPanelValues(rel, RUNTIME)
    expect(about.version).not.toContain('unknown')
    expect(about.version).not.toMatch(/^ ·|· $/)
    expect(aboutPanelValues({ ...rel, date: '' }, RUNTIME).version).toBe('')
  })

  it('実物の git で呼んでも投げない (このリポジトリ)', () => {
    const stamp = readBuildStamp(new URL('..', import.meta.url).pathname)
    expect(stamp.commit).toMatch(/^([0-9a-f]{40,64}|unknown)$/)
  })
})

describe('main の実行時の値と AppInfo の形', () => {
  it('define を通らない読み込みでは app.getVersion() と unknown に落ちる', () => {
    expect(currentBuildInfo('0.1.0')).toEqual({ version: '0.1.0', commit: 'unknown', dirty: false, date: '' })
  })

  it('runtime は process.versions と os から', () => {
    const runtime = currentRuntimeInfo({ ...process.versions, electron: '38.1.0', chrome: '140.1' })
    expect(runtime.electron).toBe('38.1.0')
    expect(runtime.chromium).toBe('140.1')
    expect(runtime.node).toBe(process.versions.node)
    expect(runtime.v8).toBe(process.versions.v8)
    expect(runtime.os).toMatch(/^\S+ \S+ \S+$/)
  })

  it('AppInfo は build と runtime を持つ (renderer はこの型で受ける)', () => {
    const info: AppInfo = {
      productName: 'aios',
      dataName: 'aios',
      version: '0.17.0',
      homeUri: 'file:///Users/x',
      storage: 'encrypted',
      storageReason: null,
      platform: 'darwin',
      userDataLabel: null,
      agentDisabled: false,
      build: BUILD,
      runtime: RUNTIME
    }
    expect(Object.keys(info.build).sort()).toEqual(['commit', 'date', 'dirty', 'version'])
    expect(Object.keys(info.runtime).sort()).toEqual(['chromium', 'electron', 'node', 'os', 'v8'])
  })
})
