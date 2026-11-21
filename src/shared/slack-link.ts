/**
 * Rewrites a Slack link in an answer into a form that opens the message directly, without going through the relay page ("You will be redirected in a few moments")
 * (TODO 553, wave 27 bundle B, ARCHITECTURE 5.2.1). Pure functions, independent of the DOM and Node.
 *
 * `https://<name>.slack.com/archives/<C>/p<ts>` -> `https://app.slack.com/client/<T>/<C>/p<ts>`.
 * `<T>` (the workspace ID) does not appear in the name-based URL, so the "name -> ID" mapping is remembered from the
 * `app.slack.com/client/<T>/…` seen when Slack was once opened in the Web view (main's `SlackTeams`, `web.slackTeams` in `app_settings`).
 * Nothing is rewritten while it is unknown (it goes through the relay page - proceeding from there makes it remembered).
 *
 * **The URL forms live in this one table (`SLACK_LINK_FORMS`).** The rewritten form was unverified against the real thing as of 2026-10-09
 * (owner decision: implement with the known form, and the owner verifies it on a real machine). If it is wrong, fixing `messageUrl` is enough.
 */

export interface SlackMessageRef {
  /** The name of `<name>.slack.com` (lowercase). */
  readonly workspace: string
  /** Channel ID (`C…` / `G…` / `D…`). */
  readonly channel: string
  /** The 16 digits after `p` (10 digits of seconds + 6 digits of microseconds, no dot). */
  readonly ts: string
}

export const SLACK_LINK_FORMS = {
  /** The workspace host `<name>.slack.com`. */
  workspaceHost: /^([a-z0-9][a-z0-9-]{0,62})\.slack\.com$/,
  /** Hosts that look like a workspace name but are Slack's own entry points (not remembered, not rewritten). */
  reservedNames: ['app', 'api', 'www', 'files', 'status', 'slack', 'edgeapi', 'wss-primary', 'downloads', 'my'],
  /** What gets rewritten: `/archives/<C>/p<16 digits>` (the query - `thread_ts` / `cid` - is dropped). */
  archivePath: /^\/archives\/([CGD][A-Z0-9]{2,})\/p(\d{16})\/?$/,
  /** What gets remembered: `https://app.slack.com/client/<T>/…`. Enterprise Grid uses `E…`. */
  clientHost: 'app.slack.com',
  clientPath: /^\/client\/([TE][A-Z0-9]{2,})(?:\/|$)/,
  /** The rewrite target (a known but unverified form). */
  messageUrl: (team: string, ref: SlackMessageRef): string =>
    `https://app.slack.com/client/${team}/${ref.channel}/p${ref.ts}`
} as const

/** Upper limit of how many are remembered (oldest are dropped first). */
export const MAX_SLACK_TEAMS = 50

/** Name -> workspace ID (the value of `web.slackTeams`). */
export type SlackTeamMap = Readonly<Record<string, string>>

function parseHttps(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length > 8192) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed : null
  } catch {
    return null
  }
}

/** The name if the host is `<name>.slack.com` (lowercase). null for Slack's own entry points (`app` / `api` …). */
export function slackWorkspaceOf(url: unknown): string | null {
  const parsed = parseHttps(url)
  if (parsed === null) return null
  const match = SLACK_LINK_FORMS.workspaceHost.exec(parsed.hostname.toLowerCase())
  const name = match?.[1]
  if (name === undefined || (SLACK_LINK_FORMS.reservedNames as readonly string[]).includes(name)) return null
  return name
}

/** The split-up parts if it is `https://<name>.slack.com/archives/<C>/p<ts>`, otherwise null. */
export function slackMessageOf(url: unknown): SlackMessageRef | null {
  const workspace = slackWorkspaceOf(url)
  if (workspace === null) return null
  const parsed = parseHttps(url)
  const match = parsed === null ? null : SLACK_LINK_FORMS.archivePath.exec(parsed.pathname)
  const channel = match?.[1]
  const ts = match?.[2]
  if (channel === undefined || ts === undefined) return null
  return { workspace, channel, ts }
}

/** The workspace ID if it is `https://app.slack.com/client/<T>/…`, otherwise null. */
export function slackClientTeamOf(url: unknown): string | null {
  const parsed = parseHttps(url)
  if (parsed === null || parsed.hostname.toLowerCase() !== SLACK_LINK_FORMS.clientHost) return null
  return SLACK_LINK_FORMS.clientPath.exec(parsed.pathname)?.[1] ?? null
}

/** The rewrite (only links to messages of known workspaces). When not rewriting, the original `url`. */
export function rewriteSlackLink(url: string, teams: SlackTeamMap): string {
  const ref = slackMessageOf(url)
  if (ref === null) return url
  const team = Object.prototype.hasOwnProperty.call(teams, ref.workspace) ? teams[ref.workspace] : undefined
  if (team === undefined || !/^[TE][A-Z0-9]{2,}$/.test(team)) return url
  return SLACK_LINK_FORMS.messageUrl(team, ref)
}

/** Validates the saved value of `web.slackTeams` (empty if broken, pairs of the wrong shape are dropped, and if over the limit the oldest are dropped). */
export function sanitizeSlackTeams(raw: unknown): SlackTeamMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const valid: [string, string][] = []
  for (const [name, team] of Object.entries(raw as Record<string, unknown>)) {
    if (!SLACK_LINK_FORMS.workspaceHost.test(`${name}.slack.com`)) continue
    if ((SLACK_LINK_FORMS.reservedNames as readonly string[]).includes(name)) continue
    if (typeof team !== 'string' || !/^[TE][A-Z0-9]{2,}$/.test(team)) continue
    valid.push([name, team])
  }
  // The order is the order remembered (old -> new). What exceeds the limit is dropped from the oldest.
  const out: Record<string, string> = {}
  for (const [name, team] of valid.slice(-MAX_SLACK_TEAMS)) out[name] = team
  return out
}
