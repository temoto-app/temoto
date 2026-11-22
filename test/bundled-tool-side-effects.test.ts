/**
 * TODO 1291: every tool (and command) the bundled extensions declare, with its `sideEffect` declaration, pinned in one table.
 *
 * A tool without `sideEffect: true` runs in an unattended turn (a scheduled job, a trigger) without any approval, so a missing
 * declaration on a tool that leaves the machine, leaves something behind, or deletes is a silent hole. Adding a tool, or removing
 * a declaration, fails this test: update the table AND decide the declaration on purpose (see docs/notes/wave99.md for the audit).
 * The table mirrors the gateway's own table in `test/gateway-unattended-turns.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ManifestError, parseManifest, readManifest } from '../src/main/plugin/manifest.js'

const pluginsDir = join(new URL('..', import.meta.url).pathname, 'plugins')

/** `<plugin id>/<tool or command id>` -> declared `sideEffect` and what the entry does. */
const EXPECTED: Record<string, { readonly sideEffect: boolean; readonly does: string }> = {
  'aios.bitbucket/getPullRequest': { sideEffect: false, does: 'GET a pull request (read-only, api.bitbucket.org)' },
  'aios.bitbucket/getPullRequestDiff': { sideEffect: false, does: 'GET a pull request diff (read-only)' },
  'aios.bitbucket/listPullRequestComments': { sideEffect: false, does: 'GET pull request comments (read-only)' },
  'aios.calendar/listCalendars': { sideEffect: false, does: 'GET calendar list (readonly scope)' },
  'aios.calendar/listEvents': { sideEffect: false, does: 'GET events (readonly scope)' },
  'aios.calendar/getEvent': { sideEffect: false, does: 'GET one event (readonly scope)' },
  'aios.reddit/fetchRedditThread': { sideEffect: false, does: 'loads a Reddit thread in the Web view and returns Markdown (read)' },
  'aios.markdown/command:outline': { sideEffect: false, does: 'extracts headings from the open document (local, user-triggered)' },
  // TODO 834 stage 1: the Source Control view's commands. Read-only git through the Broker, only on a folder the user opened (viewer-triggered).
  'aios.git/command:status': { sideEffect: false, does: 'git status of the opened folder (read-only)' },
  'aios.git/command:compare': { sideEffect: false, does: 'files that differ between two versions (read-only)' },
  'aios.git/command:log': { sideEffect: false, does: 'recent commits (read-only)' },
  'aios.git/command:sides': { sideEffect: false, does: 'both versions of one changed file (read-only)' }
}

function declared(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const dir of readdirSync(pluginsDir)) {
    if (!existsSync(join(pluginsDir, dir, 'manifest.json'))) continue
    const manifest = readManifest(join(pluginsDir, dir))
    for (const tool of manifest.mcp?.tools ?? []) out[`${manifest.id}/${tool.name}`] = tool.sideEffect === true
    for (const command of manifest.command?.commands ?? []) out[`${manifest.id}/command:${command.id}`] = command.sideEffect === true
  }
  return out
}

describe('bundled extensions: tools and their sideEffect declarations (TODO 1291)', () => {
  it('the set of tools and commands is exactly the audited table', () => {
    expect(Object.keys(declared()).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it('every declaration matches the audited value', () => {
    const actual = declared()
    for (const [key, expected] of Object.entries(EXPECTED)) {
      expect({ key, sideEffect: actual[key] }).toEqual({ key, sideEffect: expected.sideEffect })
    }
  })
})

describe('a malformed sideEffect never reads as "no declaration" (TODO 1291)', () => {
  const tool = { name: 'doIt', description: 'x', inputSchema: { type: 'object', properties: {} } }
  const manifestWith = (extra: Record<string, unknown>): unknown => ({
    id: 'aios.sample',
    name: 'Sample',
    version: '1.0.0',
    host: { entry: 'host/index.js' },
    mcp: { tools: [{ ...tool, ...extra }] }
  })

  it('accepts a boolean', () => {
    expect(parseManifest(manifestWith({ sideEffect: true })).mcp?.tools?.[0]?.sideEffect).toBe(true)
  })

  it('rejects a string, a number and null instead of treating them as absent', () => {
    for (const value of ['true', 'yes', 1, 0, null]) {
      expect(() => parseManifest(manifestWith({ sideEffect: value }))).toThrow(ManifestError)
    }
  })

  it('rejects a misspelled key instead of dropping it', () => {
    expect(() => parseManifest(manifestWith({ sideEffects: true }))).toThrow(ManifestError)
    expect(() => parseManifest(manifestWith({ sideeffect: true }))).toThrow(ManifestError)
  })
})
