// @vitest-environment jsdom
/**
 * TODO 553 (wave 27 bundle B): open a Slack link in a response directly to the message, without going through a relay page.
 *
 * - The rewrite table (`@shared/slack-link.js`): `<name>.slack.com/archives/<C>/p<ts>` -> `app.slack.com/client/<T>/<C>/p<ts>` (only when the workspace ID is remembered). The shape of the rewrite target is not yet confirmed on a real device (the owner checks it on the device).
 * - How it is remembered (`SlackTeams`): on the same webContents, when a name URL reaches `app.slack.com/client/<T>/`, remember it.
 * - Routing in the renderer (`openExternalLink`): only Slack message links ask main to rewrite them, then open in a new tab.
 *
 * Neither a model nor electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  MAX_SLACK_TEAMS,
  SLACK_LINK_FORMS,
  rewriteSlackLink,
  sanitizeSlackTeams,
  slackClientTeamOf,
  slackMessageOf,
  slackWorkspaceOf
} from '../src/shared/slack-link.js'
import { OBSERVE_WINDOW_MS, SlackTeams } from '../src/main/web/slack.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { WEB_SLACK_TEAMS } from '../src/common/settings-keys.js'

const TEAMS = { axell: 'T2U94AUKA' }

describe('rewrite table (TODO 553)', () => {
  const cases: [string, string][] = [
    // Rewrite.
    [
      'https://axell.slack.com/archives/C07SWH5T1QE/p1791331203635719',
      'https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE/p1791331203635719'
    ],
    // Drop the query of a thread reply (there is one target shape).
    [
      'https://axell.slack.com/archives/C07SWH5T1QE/p1791331203635719?thread_ts=1791331100.000100&cid=C07SWH5T1QE',
      'https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE/p1791331203635719'
    ],
    // Uppercase hosts are the same.
    [
      'https://AXELL.slack.com/archives/G01ABCDEF/p1791331203635719',
      'https://app.slack.com/client/T2U94AUKA/G01ABCDEF/p1791331203635719'
    ],
    // Do not rewrite: an unknown workspace / channel only / http / wrong digit count / not Slack / app.slack.com
    ['https://other.slack.com/archives/C07SWH5T1QE/p1791331203635719', ''],
    ['https://axell.slack.com/archives/C07SWH5T1QE', ''],
    ['http://axell.slack.com/archives/C07SWH5T1QE/p1791331203635719', ''],
    ['https://axell.slack.com/archives/C07SWH5T1QE/p179133120363571', ''],
    ['https://axell.slack.com.evil.example/archives/C07SWH5T1QE/p1791331203635719', ''],
    ['https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE', '']
  ]
  it.each(cases)('%s', (input, expected) => {
    expect(rewriteSlackLink(input, TEAMS)).toBe(expected === '' ? input : expected)
  })

  it('parts: extracting the name, message and ID', () => {
    expect(slackWorkspaceOf('https://axell.slack.com/')).toBe('axell')
    expect(slackWorkspaceOf('https://app.slack.com/client/T1')).toBeNull()
    expect(slackWorkspaceOf('https://slack.com/')).toBeNull()
    expect(slackMessageOf('https://axell.slack.com/archives/C1AB/p1791331203635719')).toEqual({
      workspace: 'axell',
      channel: 'C1AB',
      ts: '1791331203635719'
    })
    expect(slackClientTeamOf('https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE')).toBe('T2U94AUKA')
    expect(slackClientTeamOf('https://app.slack.com/client/E0ENTERPRISE')).toBe('E0ENTERPRISE')
    expect(slackClientTeamOf('https://app.slack.com/client/x')).toBeNull()
    expect(slackClientTeamOf('https://axell.slack.com/client/T2U94AUKA')).toBeNull()
  })

  it("the rewrite target's form is in one place in the table (messageUrl)", () => {
    expect(SLACK_LINK_FORMS.messageUrl('T1AB', { workspace: 'w', channel: 'C1AB', ts: '1' })).toBe(
      'https://app.slack.com/client/T1AB/C1AB/p1'
    )
  })

  it('validating stored values: drops pairs of the wrong shape, and drops the oldest first when over the limit', () => {
    expect(sanitizeSlackTeams(null)).toEqual({})
    expect(sanitizeSlackTeams(['x'])).toEqual({})
    expect(sanitizeSlackTeams({ axell: 'T2U94AUKA', app: 'T111', bad: 'x', 'a.b': 'T111', ok: 7 })).toEqual({
      axell: 'T2U94AUKA'
    })
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_SLACK_TEAMS + 5; i++) many[`w${i}`] = `T${i}AA`
    const kept = sanitizeSlackTeams(many)
    expect(Object.keys(kept)).toHaveLength(MAX_SLACK_TEAMS)
    expect(kept['w0']).toBeUndefined()
    expect(kept[`w${MAX_SLACK_TEAMS + 4}`]).toBe(`T${MAX_SLACK_TEAMS + 4}AA`)
  })
})

describe('TODO 1228: input and output of the URL rewrite that reaches the search screen (pins that it behaves as the table says)', () => {
  it('a reported URL matches the table, and for a remembered workspace it is rewritten to /client/<T>/<C>/p<ts>', () => {
    const url = 'https://axell.slack.com/archives/GAX29NY07/p1794446094011799'
    expect(slackMessageOf(url)).toEqual({ workspace: 'axell', channel: 'GAX29NY07', ts: '1794446094011799' })
    expect(rewriteSlackLink(url, { axell: 'T2U94AUKA' })).toBe(
      'https://app.slack.com/client/T2U94AUKA/GAX29NY07/p1794446094011799'
    )
    // If the workspace was not remembered, do not rewrite (it goes through the relay page).
    expect(rewriteSlackLink(url, {})).toBe(url)
  })
})

describe('SlackTeams: remembers from Web view navigation (TODO 553)', () => {
  let clock = 1_000_000
  let saved: Record<string, string>[] = []
  const make = (initial: Record<string, string> = {}): SlackTeams =>
    new SlackTeams({ read: () => initial, write: (teams) => saved.push({ ...teams }), now: () => clock })

  beforeEach(() => {
    clock = 1_000_000
    saved = []
  })

  it('remembers from a name URL -> (through SSO) app.slack.com/client/T... and uses it for rewriting', () => {
    const teams = make()
    const link = 'https://axell.slack.com/archives/C07SWH5T1QE/p1791331203635719'
    expect(teams.rewrite(link)).toBe(link)
    teams.observe(7, link)
    teams.observe(7, 'https://accounts.example/sso')
    clock += 60_000
    teams.observe(7, 'https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE')
    expect(saved).toEqual([{ axell: 'T2U94AUKA' }])
    expect(teams.rewrite(link)).toBe('https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE/p1791331203635719')
  })

  it('does not remember another webContents, a timeout, or when the name was not seen', () => {
    const teams = make()
    teams.observe(1, 'https://axell.slack.com/')
    teams.observe(2, 'https://app.slack.com/client/T2U94AUKA/')
    clock += OBSERVE_WINDOW_MS + 1
    teams.observe(1, 'https://app.slack.com/client/T2U94AUKA/')
    teams.observe(3, 'https://app.slack.com/client/T2U94AUKA/')
    expect(saved).toEqual([])
  })

  it('the last opened name wins. The same pair is not rewritten. A closed webContents is forgotten', () => {
    const teams = make({ axell: 'T2U94AUKA' })
    teams.observe(1, 'https://axell.slack.com/')
    teams.observe(1, 'https://app.slack.com/client/T2U94AUKA/')
    expect(saved).toEqual([])
    teams.observe(1, 'https://axell.slack.com/')
    teams.observe(1, 'https://other.slack.com/')
    teams.observe(1, 'https://app.slack.com/client/T0OTHER/')
    expect(saved.at(-1)).toEqual({ axell: 'T2U94AUKA', other: 'T0OTHER' })
    teams.observe(4, 'https://third.slack.com/')
    teams.forget(4)
    teams.observe(4, 'https://app.slack.com/client/T0THIRD/')
    expect(saved).toHaveLength(1)
  })

  it("non-http(s) is null (main's re-validation)", () => {
    expect(make().rewrite('javascript:alert(1)')).toBeNull()
    expect(make().rewrite(42)).toBeNull()
  })

  it('round-trips with the app_settings key web.slackTeams (owner main)', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const settings = new AppSettingsStore(db)
    expect(WEB_SLACK_TEAMS.owner).toBe('main')
    expect(settings.readTyped(WEB_SLACK_TEAMS)).toEqual({})
    settings.writeTyped(WEB_SLACK_TEAMS, { axell: 'T2U94AUKA' })
    expect(settings.readTyped(WEB_SLACK_TEAMS)).toEqual({ axell: 'T2U94AUKA' })
    db.close()
  })
})

describe('renderer dispatch: openExternalLink (TODO 553)', () => {
  const calls: string[] = []
  let resolved: string | null = null

  beforeEach(() => {
    calls.length = 0
    resolved = null
    ;(window as unknown as { aios: unknown }).aios = {
      web: {
        newTab: vi.fn(async (url: string | null) => {
          calls.push(`newTab:${url ?? 'blank'}`)
        }),
        load: vi.fn(async () => true),
        resolveLink: vi.fn(async (url: string) => {
          calls.push(`resolve:${url}`)
          return resolved ?? url
        })
      },
      app: { openExternal: vi.fn(async () => true) }
    }
  })

  afterEach(() => {
    delete (window as unknown as { aios?: unknown }).aios
  })

  it('a Slack message asks main for a rewrite and then opens a new tab. Other links do not ask', async () => {
    const { openExternalLink } = await import('../src/renderer/src/markdown-link.js')
    const { useStore } = await import('../src/renderer/src/store.js')
    resolved = 'https://app.slack.com/client/T2U94AUKA/C07SWH5T1QE/p1791331203635719'
    openExternalLink('https://axell.slack.com/archives/C07SWH5T1QE/p1791331203635719')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual([
      'resolve:https://axell.slack.com/archives/C07SWH5T1QE/p1791331203635719',
      `newTab:${resolved}`
    ])
    expect(useStore.getState().selectedUri).toBe(resolved)

    calls.length = 0
    openExternalLink('https://example.com/a')
    expect(calls).toEqual(['newTab:https://example.com/a'])
  })
})
