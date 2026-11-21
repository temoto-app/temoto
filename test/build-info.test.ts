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

describe('format', () => {
  it('shortCommit is 7 digits and unknown is kept as is', () => {
    expect(shortCommit(SHA)).toBe('179996e')
    expect(shortCommit('unknown')).toBe('unknown')
  })

  it("BottomBar's short form is 「版 · commit · Mon D, h:mm AM/PM」 (TODO 457, fixed to the English-language format), and * on the commit when dirty", () => {
    expect(formatShortDate(BUILD.date)).toBe('Oct 2, 3:34 PM')
    expect(formatBuildBadge(BUILD)).toBe('0.17.0 · 179996e · Oct 2, 3:34 PM')
    expect(formatBuildBadge({ ...BUILD, dirty: true })).toBe('0.17.0 · 179996e* · Oct 2, 3:34 PM')
  })

  it('does not show the year; midnight is 12 AM, noon is 12 PM, and the day is not zero-padded', () => {
    const midnight = new Date(2026, 0, 9, 0, 5, 0)
    const noon = new Date(2026, 0, 9, 12, 0, 0)
    expect(formatShortDate(midnight.toISOString())).toBe('Jan 9, 12:05 AM')
    expect(formatShortDate(noon.toISOString())).toBe('Jan 9, 12:00 PM')
  })

  it('drops the date and time when there is none (a load that does not go through define)', () => {
    expect(formatBuildBadge({ version: '0.1.0', commit: 'unknown', dirty: false, date: '' })).toBe('0.1.0')
  })

  it('relative time: under 1 minute is now, minutes / hours / days, the future (clock skew) is also now, an unreadable date is null', () => {
    const base = LOCAL.getTime()
    expect(relativeAge(BUILD.date, base + 30_000)).toEqual({ unit: 'now' })
    expect(relativeAge(BUILD.date, base - 5_000)).toEqual({ unit: 'now' })
    expect(relativeAge(BUILD.date, base + 5 * 60_000)).toEqual({ unit: 'minute', count: 5 })
    expect(relativeAge(BUILD.date, base + 3 * 3_600_000 + 10)).toEqual({ unit: 'hour', count: 3 })
    expect(relativeAge(BUILD.date, base + 2 * 86_400_000 + 10)).toEqual({ unit: 'day', count: 2 })
    expect(relativeAge('', base)).toBeNull()
  })

  it('the copy string is "label: value" lines like VS Code\'s About (fixed English, no relative time)', () => {
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

  it('the copy string of the distributed version (commit is unknown) writes the date as Build date', () => {
    const lines = formatBuildCopyText({ ...BUILD, commit: 'unknown' }, RUNTIME).split('\n')
    expect(lines[2]).toBe(`Build date: ${BUILD.date}`)
    expect(lines.some((line) => line.startsWith('Commit date'))).toBe(false)
  })

  it('About panel values: applicationVersion is the version, version is the commit and local date and time, credits is the copy string', () => {
    const values = aboutPanelValues({ ...BUILD, dirty: true }, RUNTIME)
    expect(values.applicationVersion).toBe('0.17.0')
    expect(values.version).toBe('179996e* · 2026-10-02 15:34')
    expect(values.credits).toBe(formatBuildCopyText({ ...BUILD, dirty: true }, RUNTIME))
  })

  it('the names of constraint 5 do not appear in words shown in the UI', () => {
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

describe('readBuildStamp (once at build time)', () => {
  /** The HEAD committer date (`%cI`, with timezone offset). Not the time it was built (TODO 1010). */
  const COMMIT_DATE = '2026-10-02T15:34:00+09:00'
  const fake =
    (answers: Record<string, string | Error>): GitRunner =>
    (args) => {
      const answer = answers[args[0] ?? '']
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no')
      return answer
    }

  it('if git exists, takes the 40 digits of HEAD, dirty (tracked changes), and the commit date (committer date)', () => {
    const stamp = readBuildStamp('/nowhere', {
      version: '0.17.0',
      git: fake({ 'rev-parse': `${SHA.toUpperCase()}\n`, show: `${COMMIT_DATE}\n`, status: ' M src/main/index.ts\n' })
    })
    expect(stamp).toEqual({ version: '0.17.0', commit: SHA, dirty: true, date: COMMIT_DATE })
  })

  it("the date uses git show's %cI (not the build time): the same commit gives the same value however many times it is called", () => {
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

  it('dirty: false when the working tree is clean', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: COMMIT_DATE, status: '' }) })
    expect(stamp.dirty).toBe(false)
    expect(stamp.date).toBe(COMMIT_DATE)
  })

  it('without git or outside a repository, does not fail and gives unknown, and the date is empty', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': new Error('ENOENT') }) })
    expect(stamp).toEqual({ version: '1', commit: 'unknown', dirty: false, date: '' })
  })

  it('even if only show fails, the commit stays and the date is empty', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: new Error('x'), status: '' }) })
    expect(stamp.commit).toBe(SHA)
    expect(stamp.date).toBe('')
  })

  it('an unreadable date (git returns strange output) is made empty', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: 'not a date', status: '' }) })
    expect(stamp.date).toBe('')
  })

  it('even if only status fails, the commit stays', () => {
    const stamp = readBuildStamp('/nowhere', { version: '1', git: fake({ 'rev-parse': SHA, show: COMMIT_DATE, status: new Error('x') }) })
    expect(stamp.commit).toBe(SHA)
    expect(stamp.dirty).toBe(false)
  })

  it("if version is omitted, package.json's value; 0.0.0 if unreadable", () => {
    const root = new URL('..', import.meta.url).pathname
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string }
    expect(readBuildStamp(root, { git: fake({}) }).version).toBe(pkg.version)
    expect(readBuildStamp('/nonexistent-dir-316', { git: fake({}) }).version).toBe('0.0.0')
  })

  it("TODO 1190: the distributed version does not embed the build source's commit and the date is the build time", () => {
    const now = new Date('2026-11-08T01:02:03.000Z')
    const runner: GitRunner = () => {
      throw new Error('release では git を呼ばない')
    }
    const stamp = readBuildStamp('/nowhere', { version: '1', release: true, now, git: runner })
    expect(stamp).toEqual({ version: '1', commit: 'unknown', dirty: false, date: now.toISOString() })
    expect(isReleaseBuild({ AIOS_RELEASE: '1' })).toBe(true)
    expect(isReleaseBuild({})).toBe(false)
  })

  it('TODO 1190: the badge and About without a commit do not show a commit and do not break', () => {
    const rel = { version: '0.79.0', commit: 'unknown', dirty: false, date: '2026-11-08T01:02:03.000Z' }
    expect(formatBuildBadge(rel)).not.toContain('unknown')
    expect(formatBuildBadge(rel)).toMatch(/^0\.79\.0 · Nov \d+, /)
    const about = aboutPanelValues(rel, RUNTIME)
    expect(about.version).not.toContain('unknown')
    expect(about.version).not.toMatch(/^ ·|· $/)
    expect(aboutPanelValues({ ...rel, date: '' }, RUNTIME).version).toBe('')
  })

  it('does not throw when called with the real git (this repository)', () => {
    const stamp = readBuildStamp(new URL('..', import.meta.url).pathname)
    expect(stamp.commit).toMatch(/^([0-9a-f]{40,64}|unknown)$/)
  })
})

describe("main's runtime values and the shape of AppInfo", () => {
  it('a load that does not go through define falls to app.getVersion() and unknown', () => {
    expect(currentBuildInfo('0.1.0')).toEqual({ version: '0.1.0', commit: 'unknown', dirty: false, date: '' })
  })

  it('runtime comes from process.versions and os', () => {
    const runtime = currentRuntimeInfo({ ...process.versions, electron: '38.1.0', chrome: '140.1' })
    expect(runtime.electron).toBe('38.1.0')
    expect(runtime.chromium).toBe('140.1')
    expect(runtime.node).toBe(process.versions.node)
    expect(runtime.v8).toBe(process.versions.v8)
    expect(runtime.os).toMatch(/^\S+ \S+ \S+$/)
  })

  it('AppInfo has build and runtime (the renderer receives it with this type)', () => {
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
