/**
 * @vitest-environment jsdom
 *
 * TODO 834 stage 1: the `aios.git` extension (the Source Control view) and the host's `open-diff` gate.
 *
 * - which two versions a picked change compares (VS Code's Staged Changes / Changes, and two versions);
 * - the host commands re-check their arguments and only state intents through `api.git` (no argv);
 * - the view draws the groups and rows from state, and opening a row goes through the handler;
 * - the host accepts `open-diff` only for the displayed URI and only sides of the right shape and size;
 * - colors only from CSS variables, and the manifest declares only the read-only git capability.
 * The model is not called; git is not run (the Broker side is `git-capability.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeSides, statusLetter } from '../plugins/aios.git/common/sides.js'
import plugin, { changeOf, repoOf } from '../plugins/aios.git/host/index.js'
import { describeGitError, renderGitView, splitPath, type GitViewState } from '../plugins/aios.git/viewer/git-view.js'
import { acceptOpenDiff } from '../src/renderer/src/transient-file.js'
import { hasSourceControlExtension, sourceControlMenuItem } from '../src/renderer/src/path-context-menu.js'
import { parseManifest, declaredCapabilities } from '../src/main/plugin/manifest.js'
import { GIT_INDEX, GIT_WORKTREE, type GitChange } from '../src/shared/plugin-git.js'
import { MAX_GUEST_DIFF_CHARS, type PluginApi } from '../src/shared/plugin.js'

const repoRoot = process.cwd()

describe('which two versions a change compares', () => {
  const modified: GitChange = { path: 'src/a.ts', status: 'modified' }
  it('staged: HEAD -> index, unstaged: index -> working tree, compare: from -> to / working tree', () => {
    expect(changeSides('staged', modified)).toEqual({ before: { rev: 'HEAD', path: 'src/a.ts' }, after: { rev: GIT_INDEX, path: 'src/a.ts' } })
    expect(changeSides('unstaged', modified)).toEqual({ before: { rev: GIT_INDEX, path: 'src/a.ts' }, after: { rev: GIT_WORKTREE, path: 'src/a.ts' } })
    expect(changeSides('compare', modified, 'v1', 'v2')).toEqual({ before: { rev: 'v1', path: 'src/a.ts' }, after: { rev: 'v2', path: 'src/a.ts' } })
    expect(changeSides('compare', modified, 'v1').after).toEqual({ rev: GIT_WORKTREE, path: 'src/a.ts' })
  })

  it('added / untracked have no left side, deleted has no right side, a rename reads the old path on the left, a conflict compares with HEAD', () => {
    expect(changeSides('unstaged', { path: 'n.txt', status: 'untracked' }).before).toBeNull()
    expect(changeSides('staged', { path: 'n.txt', status: 'added' }).before).toBeNull()
    expect(changeSides('staged', { path: 'g.txt', status: 'deleted' }).after).toBeNull()
    expect(changeSides('staged', { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' }).before).toEqual({ rev: 'HEAD', path: 'old.txt' })
    expect(changeSides('unstaged', { path: 'c.txt', status: 'conflicted' }).before).toEqual({ rev: 'HEAD', path: 'c.txt' })
    expect(statusLetter('untracked')).toBe('U')
    expect(statusLetter('conflicted')).toBe('!')
  })
})

describe('host commands (plugin-host side)', () => {
  function fakeApi(): { api: PluginApi; calls: unknown[][] } {
    const calls: unknown[][] = []
    const git: PluginApi['git'] = {
      status: async (...args) => {
        calls.push(['status', ...args])
        return { branch: 'main', head: null, staged: [], unstaged: [], truncated: false, hidden: 0 }
      },
      diff: async (...args) => {
        calls.push(['diff', ...args])
        return { files: [], truncated: false, hidden: 0 }
      },
      show: async (...args) => {
        calls.push(['show', ...args])
        return { kind: 'text', text: String(args[1]), size: 1 }
      },
      log: async (...args) => {
        calls.push(['log', ...args])
        return { commits: [], more: false }
      }
    }
    return { api: { git } as unknown as PluginApi, calls }
  }

  it('turns the view URI into the folder URI and refuses anything else', () => {
    expect(repoOf({ repo: 'aios-git:///Users/x/repo' })).toBe('file:///Users/x/repo')
    for (const repo of ['file:///Users/x/repo', 'aios-git:relative', 42, undefined]) expect(() => repoOf({ repo })).toThrow('invalid-repo')
    expect(() => changeOf({ path: '../x', status: 'modified' })).toThrow('invalid-change')
    expect(() => changeOf({ path: 'x', status: 'exec' })).toThrow('invalid-change')
  })

  it('sides reads exactly the two versions of the change through api.git.show', async () => {
    const { api, calls } = fakeApi()
    const sides = (await plugin.commands?.['sides']?.(
      { repo: 'aios-git:///r', mode: 'staged', change: { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' } },
      api
    )) as { before: unknown; after: unknown }
    expect(calls).toEqual([
      ['show', 'file:///r', 'HEAD', 'old.txt'],
      ['show', 'file:///r', GIT_INDEX, 'new.txt']
    ])
    expect(sides.before).toEqual({ kind: 'text', text: 'HEAD', size: 1 })
  })

  it('sides refuses a range (a..b / a...b) instead of reading it as an empty side', async () => {
    const { api, calls } = fakeApi()
    for (const from of ['a..b', 'a...b']) {
      await expect(
        (async () => plugin.commands?.['sides']?.({ repo: 'aios-git:///r', mode: 'compare', from, change: { path: 'a.txt', status: 'modified' } }, api))()
      ).rejects.toThrow('invalid-rev')
    }
    expect(calls).toEqual([])
  })

  it('compare refuses a flag-like rev before reaching the Broker', async () => {
    const { api, calls } = fakeApi()
    await expect((async () => plugin.commands?.['compare']?.({ repo: 'aios-git:///r', from: '--output=/tmp/x' }, api))()).rejects.toThrow('invalid-rev')
    await plugin.commands?.['compare']?.({ repo: 'aios-git:///r', from: 'HEAD~2' }, api)
    expect(calls).toEqual([['diff', 'file:///r', { from: 'HEAD~2' }]])
  })
})

describe('the Source Control view', () => {
  const state: GitViewState = {
    folder: 'repo',
    status: {
      branch: 'main',
      head: null,
      staged: [{ path: 'src/a.ts', status: 'modified' }],
      unstaged: [
        { path: 'b.txt', status: 'deleted' },
        { path: 'n.txt', status: 'untracked' }
      ],
      truncated: false,
      hidden: 2
    },
    loading: false,
    error: null,
    notice: null,
    compare: { from: '', to: '', result: null, loading: false, error: null },
    commits: []
  }

  it('draws Staged Changes and Changes, and a row press opens that change', () => {
    const root = document.createElement('div')
    const opened: unknown[] = []
    renderGitView(root, state, { refresh: () => undefined, open: (mode, change) => opened.push([mode, change.path]), setCompare: () => undefined, runCompare: () => undefined })
    const groups = [...root.querySelectorAll('.git-group-title')].map((node) => node.textContent)
    expect(groups.length).toBe(3)
    const rows = [...root.querySelectorAll<HTMLButtonElement>('.git-row')]
    expect(rows.map((row) => row.querySelector('.git-letter')?.textContent)).toEqual(['M', 'D', 'U'])
    rows[0]?.click()
    expect(opened).toEqual([['staged', 'src/a.ts']])
    expect(root.textContent).toContain('2')
    expect(splitPath('src/a.ts')).toEqual({ name: 'a.ts', folder: 'src' })
  })

  it('describes the git capability reasons', () => {
    expect(describeGitError('not-a-repo')).not.toContain('not-a-repo')
    expect(describeGitError('Error: unsupported-repo')).not.toBe(describeGitError('not-a-repo'))
    expect(describeGitError('busy')).toContain('busy')
  })

  it('uses colors only from CSS variables', () => {
    const css = readFileSync(join(repoRoot, 'plugins/aios.git/viewer/git.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})

describe('the host gate for open-diff', () => {
  const side = { name: 'HEAD: a.ts', text: 'x', language: null }
  const open = { declaresGit: true, transientShown: false, ownedBySender: false }
  it('accepts sides of the right shape only for the displayed URI', () => {
    expect(acceptOpenDiff({ uri: 'aios-git:///r', before: side, after: side }, 'aios-git:///r', open)).toEqual({ before: side, after: side })
    expect(acceptOpenDiff({ uri: 'aios-git:///other', before: side, after: side }, 'aios-git:///r', open)).toBeNull()
    expect(acceptOpenDiff({ uri: 'aios-git:///r', before: side, after: side }, null, open)).toBeNull()
    expect(acceptOpenDiff({ uri: 'aios-git:///r', before: { ...side, text: 1 }, after: side }, 'aios-git:///r', open)).toBeNull()
    expect(acceptOpenDiff({ uri: 'aios-git:///r', before: side, after: side, layout: 'weird' }, 'aios-git:///r', open)).toBeNull()
    expect(
      acceptOpenDiff({ uri: 'aios-git:///r', before: { ...side, text: 'x'.repeat(MAX_GUEST_DIFF_CHARS + 1) }, after: side }, 'aios-git:///r', open)
    ).toBeNull()
  })
})

describe('who may replace a temporary display with open-diff', () => {
  const side = { name: 'a', text: 'x', language: null }
  const ask = (gate: Parameters<typeof acceptOpenDiff>[2]): unknown => acceptOpenDiff({ uri: 'u', before: side, after: side }, 'u', gate)
  it('refuses an extension that does not declare git', () => {
    expect(ask({ declaresGit: false, transientShown: false, ownedBySender: false })).toBeNull()
  })
  it('refuses to take over a temporary display the sender did not open', () => {
    expect(ask({ declaresGit: true, transientShown: true, ownedBySender: false })).toBeNull()
  })
  it('allows over nothing or over its own earlier diff', () => {
    expect(ask({ declaresGit: true, transientShown: false, ownedBySender: false })).not.toBeNull()
    expect(ask({ declaresGit: true, transientShown: true, ownedBySender: true })).not.toBeNull()
  })
})

describe('the file tree entry and the manifest', () => {
  it('"Open in Source Control" appears only with an enabled git extension, and opens the aios-git URI', () => {
    expect(hasSourceControlExtension(null)).toBe(false)
    expect(hasSourceControlExtension([{ enabled: false, capabilities: ['git'] }])).toBe(false)
    expect(hasSourceControlExtension([{ enabled: true, capabilities: ['fs', 'git'] }])).toBe(true)
    const opened: string[] = []
    const item = sourceControlMenuItem('file:///Users/x/repo', (key) => key, (uri) => opened.push(uri))
    item?.onSelect()
    expect(opened).toEqual(['aios-git:///Users/x/repo'])
    expect(sourceControlMenuItem('thread://x', (key) => key, () => undefined)).toBeNull()
  })

  it('aios.git declares only read-only git (plus the viewer fs every viewer has), and claims the aios-git scheme', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(repoRoot, 'plugins/aios.git/manifest.json'), 'utf8')))
    expect(manifest.capabilities.git).toEqual({ read: true })
    expect(declaredCapabilities(manifest)).toEqual(['fs', 'git'])
    expect(manifest.viewer?.schemes).toEqual(['aios-git'])
    expect(manifest.command?.commands.every((command) => command.sideEffect !== true)).toBe(true)
  })
})
