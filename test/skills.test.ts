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
  it('a one-line description and name', () => {
    const meta = parseSkillFrontmatter('---\nname: deploy\ndescription: Ship it\n---\n# body\n')
    expect(meta).toEqual({ name: 'deploy', description: 'Ship it' })
  })
  it('quotes, folded blocks and continuation lines', () => {
    expect(parseSkillFrontmatter('---\ndescription: "A: b"\n---\n').description).toBe('A: b')
    expect(parseSkillFrontmatter('---\ndescription: >\n  one\n  two\n\n  three\nname: x\n---\n')).toEqual({
      name: 'x',
      description: 'one two three'
    })
    expect(parseSkillFrontmatter('---\ndescription: first\n  second\n---\n').description).toBe('first second')
  })
  it('empty if there is no frontmatter / a long description is cut', () => {
    expect(parseSkillFrontmatter('# just text\ndescription: no\n')).toEqual({ name: null, description: '' })
    const long = parseSkillFrontmatter(`---\ndescription: ${'a'.repeat(500)}\n---\n`).description
    expect(long.length).toBe(301)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('listSkills', () => {
  it('lists user and project per scope. Only user if there is no cwd', async () => {
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

  it('if cwd is home, does not list the same location twice', async () => {
    skill(userRoot(), 'only', '---\ndescription: x\n---\n')
    const listing = await listSkills(home, { home, paths, canRead })
    expect(listing.skills).toHaveLength(1)
    expect(listing.skills[0]?.scope).toBe('user')
  })

  it('does not list a body that fails the read choke point', async () => {
    skill(userRoot(), 'ok', 'x')
    skill(userRoot(), 'denied', 'x')
    const listing = await listSkills(null, { home, paths, canRead: (p) => !p.includes('denied') })
    expect(listing.skills.map((s) => s.dirName)).toEqual(['ok'])
  })

  it('a link outside the settings directory (dotfiles) is listed as linked, and a link to another place inside is not listed', async () => {
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

  it("a plugin skill is read-only, and carries the plugin's name", async () => {
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

  it('a plugin installed only for another project appears only for that project', async () => {
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

  it('a broken plugin list is silently empty', async () => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{not json')
    expect((await listSkills(null, { home, paths, canRead })).skills).toEqual([])
  })
})

describe('deletion check', () => {
  const request = (dirName: string, scope: 'user' | 'project' = 'user') => ({
    scope,
    dirName,
    cwdUri: pathToUri(cwd)
  })

  it('passes a user / project skill as one directly under the location', () => {
    const user = skill(userRoot(), 'u', 'x')
    const project = skill(projectRoot(), 'p', 'x')
    expect(checkSkillDelete(request('u'), { home, paths, canRead })).toEqual({ ok: true, path: user })
    expect(checkSkillDelete(request('p', 'project'), { home, paths, canRead })).toEqual({ ok: true, path: project })
  })

  it('a separator, .., hidden, empty, plugin and unknown scope are invalid', () => {
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

  it('a missing one and a directory without a body are not-found', () => {
    mkdirSync(join(userRoot(), 'empty'), { recursive: true })
    expect(checkSkillDelete(request('missing'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-found' })
    expect(checkSkillDelete(request('empty'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('deletion does not depend on the read choke point (canRead) (a deletion-only check)', () => {
    const user = skill(userRoot(), 'u', 'x')
    expect(checkSkillDelete(request('u'), { home, paths, canRead: () => false })).toEqual({ ok: true, path: user })
  })

  it('the location itself and a link to a position containing the location are not-allowed', () => {
    skill(userRoot(), 'u', 'x')
    writeFileSync(join(userRoot(), 'SKILL.md'), 'x')
    symlinkSync(userRoot(), join(userRoot(), 'self'))
    expect(checkSkillDelete(request('self'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
    writeFileSync(join(home, '.claude', 'SKILL.md'), 'x')
    symlinkSync(join(home, '.claude'), join(userRoot(), 'up'))
    expect(checkSkillDelete(request('up'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('even if the location is a link to another place, a real directory one level down passes, and a link pointing two levels down discards only the name side', () => {
    skill(outside, 'real', 'x')
    rmSync(userRoot(), { recursive: true })
    symlinkSync(outside, userRoot())
    expect(checkSkillDelete(request('real'), { home, paths, canRead })).toEqual({ ok: true, path: join(userRoot(), 'real') })
    skill(join(outside, 'sub'), 'deep', 'x')
    symlinkSync(join(outside, 'sub', 'deep'), join(outside, 'lnk'))
    // Drop the link (the link itself directly under it, not the entity two levels down at its target).
    expect(checkSkillDelete(request('lnk'), { home, paths, canRead })).toEqual({ ok: true, path: join(userRoot(), 'lnk') })
  })

  it('a skill in a plugin location cannot be pointed at (invalid if the scope is plugin)', () => {
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

  it('a link pointing to credentials is not made to be discarded. A link to dotfiles points only at the link', () => {
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

  it('a link to another place inside the settings directory is not-allowed', () => {
    skill(join(home, '.claude', 'projects', 'x', 'memory'), 'm', 'x')
    symlinkSync(join(home, '.claude', 'projects', 'x', 'memory', 'm'), join(userRoot(), 'mem'))
    expect(checkSkillDelete(request('mem'), { home, paths, canRead })).toEqual({ ok: false, reason: 'not-allowed' })
  })
})

describe('deleteSkill', () => {
  it('passes only the one that cleared the check to trash, and a failure does not throw but is failed', async () => {
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

describe('exception for reads opened in the viewer (readOnlyIncludes)', () => {
  it('only SKILL.md is readable. Writes, other files and credentials do not pass', () => {
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
