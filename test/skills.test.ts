/**
 * TODO 773: Settings' 'Skills' (ARCHITECTURE.md 4.5.3). Enumerating skills, frontmatter, escaping symlinks, plugins being read-only, and checks on deletion.
 *
 * The location is built under a fake home (a temp folder). The real settings directory is not read, written, or deleted (constraint 2). Moving to the trash is a fake (`trash`) and does not actually move anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyAccess, createMacosExclusions } from '../src/common/exclusions.js'
import { pathToUri } from '../src/common/uri.js'
import { loadBackendPaths } from '../src/main/session/adapter/compat.js'
import {
  checkSkillDelete,
  cwdPathOf,
  deleteSkill,
  listSkills,
  parseSkillFrontmatter
} from '../src/main/session/adapter/skills.js'

let base: string
let home: string
let cwd: string
let outside: string

const paths = loadBackendPaths()
const canRead = (): boolean => true

function skill(root: string, name: string, text: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text)
  return dir
}

const userRoot = (): string => join(home, '.claude', 'skills')
const projectRoot = (): string => join(cwd, '.claude', 'skills')

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aios-skills-')))
  home = join(base, 'home')
  cwd = join(base, 'proj')
  outside = join(base, 'dotfiles')
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('parseSkillFrontmatter', () => {
  it('1 行の description と name', () => {
    const meta = parseSkillFrontmatter('---\nname: deploy\ndescription: Ship it\n---\n# body\n')
    expect(meta).toEqual({ name: 'deploy', description: 'Ship it' })
  })
  it('引用符・折りたたみブロック・続きの行', () => {
    expect(parseSkillFrontmatter('---\ndescription: "A: b"\n---\n').description).toBe('A: b')
    expect(parseSkillFrontmatter('---\ndescription: >\n  one\n  two\n\n  three\nname: x\n---\n')).toEqual({
      name: 'x',
      description: 'one two three'
    })
    expect(parseSkillFrontmatter('---\ndescription: first\n  second\n---\n').description).toBe('first second')
  })
  it('frontmatter が無ければ空 / 長い説明は切る', () => {
    expect(parseSkillFrontmatter('# just text\ndescription: no\n')).toEqual({ name: null, description: '' })
    const long = parseSkillFrontmatter(`---\ndescription: ${'a'.repeat(500)}\n---\n`).description
    expect(long.length).toBe(301)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('listSkills', () => {
  it('ユーザーとプロジェクトを範囲ごとに出す。cwd が無ければユーザーだけ', async () => {
    skill(userRoot(), 'b-user', '---\ndescription: user one\n---\n')
    skill(userRoot(), 'a-user', 'no frontmatter')
    skill(projectRoot(), 'proj-skill', '---\nname: Proj\ndescription: project one\n---\n')
    mkdirSync(join(userRoot(), 'not-a-skill')) // A directory without a body is not listed.
    mkdirSync(join(userRoot(), '.hidden'))
    const withCwd = await listSkills(cwd, { home, paths, canRead })
    expect(withCwd.projectChecked).toBe(true)
    expect(withCwd.skills.map((s) => [s.scope, s.dirName, s.name, s.description, s.readOnly])).toEqual([
      ['user', 'a-user', 'a-user', '', false],
      ['user', 'b-user', 'b-user', 'user one', false],
      ['project', 'proj-skill', 'Proj', 'project one', false]
    ])
    expect(withCwd.skills[2]?.uri).toBe(pathToUri(join(projectRoot(), 'proj-skill', 'SKILL.md')))
    const without = await listSkills(null, { home, paths, canRead })
    expect(without.projectChecked).toBe(false)
    expect(without.skills.map((s) => s.scope)).toEqual(['user', 'user'])
  })

  it('cwd がホームなら同じ置き場を 2 度出さない', async () => {
    skill(userRoot(), 'only', '---\ndescription: x\n---\n')
    const listing = await listSkills(home, { home, paths, canRead })
    expect(listing.skills).toHaveLength(1)
    expect(listing.skills[0]?.scope).toBe('user')
  })

  it('読み取りの関門を通らない本体は載せない', async () => {
    skill(userRoot(), 'ok', 'x')
    skill(userRoot(), 'denied', 'x')
    const listing = await listSkills(null, { home, paths, canRead: (p) => !p.includes('denied') })
    expect(listing.skills.map((s) => s.dirName)).toEqual(['ok'])
  })

  it('設定ディレクトリの外へのリンク (dotfiles) は載せて linked、中の別の場所へのリンクは載せない', async () => {
    skill(outside, 'shared', '---\ndescription: from dotfiles\n---\n')
    symlinkSync(join(outside, 'shared'), join(userRoot(), 'shared'))
    // A SKILL.md link that points to a credentials file.
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"secret":true}')
    mkdirSync(join(userRoot(), 'evil'))
    symlinkSync(join(home, '.claude', '.credentials.json'), join(userRoot(), 'evil', 'SKILL.md'))
    // A link to a folder elsewhere in the settings directory, such as auto memory.
    skill(join(home, '.claude', 'projects', 'x', 'memory'), 'm', 'memory text')
    symlinkSync(join(home, '.claude', 'projects', 'x', 'memory', 'm'), join(userRoot(), 'mem'))
    const listing = await listSkills(null, { home, paths, canRead })
    expect(listing.skills.map((s) => [s.dirName, s.linked])).toEqual([['shared', true]])
    expect(listing.skills[0]?.description).toBe('from dotfiles')
  })

  it('plugin の skill は読み取り専用で、plugin の名前が付く', async () => {
    const install = join(home, '.claude', 'plugins', 'cache', 'mkt', 'tool', '1.0.0')
    skill(join(install, 'skills'), 'helper', '---\ndescription: from plugin\n---\n')
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'tool@mkt': [{ scope: 'user', installPath: install }] } })
    )
    const listing = await listSkills(null, { home, paths, canRead })
    expect(listing.skills).toHaveLength(1)
    expect(listing.skills[0]).toMatchObject({ scope: 'plugin', pluginName: 'tool', readOnly: true, dirName: 'helper' })
  })

  it('他のプロジェクトにだけ入れた plugin は、そのプロジェクトのときだけ', async () => {
    const install = join(home, '.claude', 'plugins', 'cache', 'mkt', 'scoped', '1.0.0')
    skill(join(install, 'skills'), 's', 'x')
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'scoped@mkt': [{ scope: 'project', projectPath: cwd, installPath: install }] } })
    )
    expect((await listSkills(null, { home, paths, canRead })).skills).toHaveLength(0)
    expect((await listSkills(join(base, 'other'), { home, paths, canRead })).skills).toHaveLength(0)
    expect((await listSkills(cwd, { home, paths, canRead })).skills).toHaveLength(1)
  })

  it('壊れた plugin の一覧は黙って空', async () => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{not json')
    expect((await listSkills(null, { home, paths, canRead })).skills).toEqual([])
  })
})

describe('削除の検査', () => {
  const request = (dirName: string, scope: 'user' | 'project' = 'user') => ({
    scope,
    dirName,
    cwdUri: pathToUri(cwd)
  })

  it('ユーザー / プロジェクトの skill を置き場の直下 1 つとして通す', () => {
    const user = skill(userRoot(), 'u', 'x')
    const project = skill(projectRoot(), 'p', 'x')
    expect(checkSkillDelete(request('u'), { home, paths, canRead })).toEqual({ ok: true, path: user })
    expect(checkSkillDelete(request('p', 'project'), { home, paths, canRead })).toEqual({ ok: true, path: project })
  })

  it('区切り・.. ・隠し・空・plugin・未知の範囲は invalid', () => {
    skill(userRoot(), 'u', 'x')
    for (const name of ['', '.', '..', '../u', 'a/b', '.hidden', 'a\\b', 'a\0b']) {
      expect(checkSkillDelete(request(name), { home, paths, canRead })).toEqual({ ok: false, reason: 'invalid' })
    }
    const plugin = { scope: 'plugin' as unknown as 'user', dirName: 'u', cwdUri: null }
    expect(checkSkillDelete(plugin, { home, paths, canRead })).toEqual({ ok: false, reason: 'invalid' })
    // Without a cwd, a project skill cannot be pointed at.
    expect(
      checkSkillDelete({ scope: 'project', dirName: 'p', cwdUri: null }, { home, paths, canRead })
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(cwdPathOf('relative')).toBeNull()
  })

  it('無いもの・本体の無いディレクトリは not-found', () => {
    mkdirSync(join(userRoot(), 'empty'), { recursive: true })
    expect(checkSkillDelete(request('missing'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-found' })
    expect(checkSkillDelete(request('empty'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('削除は読みの関門 (canRead) に依らない (削除専用の検査)', () => {
    const user = skill(userRoot(), 'u', 'x')
    expect(checkSkillDelete(request('u'), { home, paths, canRead: () => false })).toEqual({ ok: true, path: user })
  })

  it('置き場自身・置き場を含む位置へのリンクは not-allowed', () => {
    skill(userRoot(), 'u', 'x')
    writeFileSync(join(userRoot(), 'SKILL.md'), 'x')
    symlinkSync(userRoot(), join(userRoot(), 'self'))
    expect(checkSkillDelete(request('self'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
    writeFileSync(join(home, '.claude', 'SKILL.md'), 'x')
    symlinkSync(join(home, '.claude'), join(userRoot(), 'up'))
    expect(checkSkillDelete(request('up'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('置き場が別の場所へのリンクでも、直下 1 段の実体なら通り、2 段下を指すリンクは名前の側だけを捨てる', () => {
    skill(outside, 'real', 'x')
    rmSync(userRoot(), { recursive: true })
    symlinkSync(outside, userRoot())
    expect(checkSkillDelete(request('real'), { home, paths, canRead })).toEqual({ ok: true, path: join(userRoot(), 'real') })
    skill(join(outside, 'sub'), 'deep', 'x')
    symlinkSync(join(outside, 'sub', 'deep'), join(outside, 'lnk'))
    // Drop the link (the link itself directly under it, not the entity two levels down at its target).
    expect(checkSkillDelete(request('lnk'), { home, paths, canRead })).toEqual({ ok: true, path: join(userRoot(), 'lnk') })
  })

  it('plugin の置き場の skill は指せない (範囲が plugin なら invalid)', () => {
    const install = join(home, '.claude', 'plugins', 'cache', 'mkt', 'tool', '1.0.0')
    skill(join(install, 'skills'), 'helper', 'x')
    const plugin = { scope: 'plugin' as unknown as 'user', dirName: 'helper', cwdUri: pathToUri(cwd) }
    expect(checkSkillDelete(plugin, { home, paths, canRead })).toEqual({ ok: false, reason: 'invalid' })
    // It also cannot escape by name into the plugin location.
    expect(checkSkillDelete(request('../plugins/cache/mkt/tool/1.0.0/skills/helper'), { home, paths, canRead })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('資格情報へ向くリンクは捨てさせない。dotfiles へのリンクはリンクだけを指す', () => {
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}')
    mkdirSync(join(userRoot(), 'evil'))
    symlinkSync(join(home, '.claude', '.credentials.json'), join(userRoot(), 'evil', 'SKILL.md'))
    expect(checkSkillDelete(request('evil'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
    skill(outside, 'shared', 'x')
    symlinkSync(join(outside, 'shared'), join(userRoot(), 'shared'))
    expect(checkSkillDelete(request('shared'), { home, paths, canRead })).toEqual({
      ok: true,
      path: join(userRoot(), 'shared')
    })
  })

  it('設定ディレクトリの中の別の場所へのリンクは not-allowed', () => {
    skill(join(home, '.claude', 'projects', 'x', 'memory'), 'm', 'x')
    symlinkSync(join(home, '.claude', 'projects', 'x', 'memory', 'm'), join(userRoot(), 'mem'))
    expect(checkSkillDelete(request('mem'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
  })
})

describe('deleteSkill', () => {
  it('検査を通った 1 つだけを trash に渡し、失敗は投げずに failed', async () => {
    skill(userRoot(), 'u', 'x')
    skill(userRoot(), 'keep', 'x')
    const trashed: string[] = []
    const ok = await deleteSkill({ scope: 'user', dirName: 'u', cwdUri: null }, { home, paths, canRead }, async (p) => {
      trashed.push(p)
    })
    expect(ok).toEqual({ ok: true })
    expect(trashed).toEqual([join(userRoot(), 'u')])
    const failed = await deleteSkill({ scope: 'user', dirName: 'keep', cwdUri: null }, { home, paths, canRead }, async () => {
      throw new Error('boom')
    })
    expect(failed).toEqual({ ok: false, reason: 'failed' })
    const rejected = await deleteSkill({ scope: 'user', dirName: '..', cwdUri: null }, { home, paths, canRead }, async (p) => {
      trashed.push(p)
    })
    expect(rejected).toEqual({ ok: false, reason: 'invalid' })
    expect(trashed).toHaveLength(1)
    // The trash is fake, so nothing was deleted.
    expect(existsSync(join(userRoot(), 'u', 'SKILL.md'))).toBe(true)
  })
})

describe('viewer で開く読み取りの例外 (readOnlyIncludes)', () => {
  it('SKILL.md だけ読める。書き込み・他のファイル・資格情報は通らない', () => {
    const rules = createMacosExclusions(home)
    const verdict = (path: string, access: 'read' | 'write' | 'edit') =>
      classifyAccess(path, path.split('/').pop() ?? '', false, rules, access).excluded
    const user = join(home, '.claude', 'skills', 'x', 'SKILL.md')
    const plugin = join(home, '.claude', 'plugins', 'cache', 'mkt', 'tool', '1.0.0', 'skills', 's', 'SKILL.md')
    const market = join(home, '.claude', 'plugins', 'marketplaces', 'm', 'plugins', 'p', 'skills', 's', 'SKILL.md')
    expect(verdict(user, 'read')).toBe(false)
    expect(verdict(plugin, 'read')).toBe(false)
    expect(verdict(market, 'read')).toBe(false)
    expect(verdict(user, 'write')).toBe(true)
    // Saving ('edit') is only allowed for the user's own skill SKILL.md.
    expect(verdict(user, 'edit')).toBe(false)
    expect(verdict(plugin, 'edit')).toBe(true)
    expect(verdict(market, 'edit')).toBe(true)
    expect(verdict(join(home, '.claude', 'skills', 'x', 'script.sh'), 'edit')).toBe(true)
    expect(verdict(join(home, '.claude', 'settings.json'), 'edit')).toBe(true)
    expect(verdict(join(home, '.claude', '.credentials.json'), 'edit')).toBe(true)
    expect(verdict(join(home, '.claude', 'skills', '..', 'settings.json'), 'edit')).toBe(true)
    expect(verdict(join(home, '.claude', 'skills', 'x', 'script.sh'), 'read')).toBe(true)
    expect(verdict(join(home, '.claude', '.credentials.json'), 'read')).toBe(true)
    expect(verdict(join(home, '.claude', 'settings.json'), 'read')).toBe(true)
  })
})
