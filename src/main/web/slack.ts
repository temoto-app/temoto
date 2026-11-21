/**
 * Remembers the Slack workspace "name -> ID" from navigation in the web view (`persist:aios-web`) (TODO 553, wave 27 bundle B).
 * **It does not import electron** (the wiring is in `web/extras.ts`; tests call it directly).
 *
 * How it learns: after a webContents opens `https://<name>.slack.com/…`, if the same webContents reaches
 * `https://app.slack.com/client/<T>/…` within `OBSERVE_WINDOW_MS`, record `<name> -> <T>` (the flow of going from an intermediate page to "open in browser", or
 * being redirected from the workspace's entrance). So that an SSO login in between (on another host) is fine,
 * navigation to other hosts does not make it forget. If a different name is opened later, it overwrites with that name (the last opened name wins).
 *
 * The rewriting (`rewrite`) is left to the pure function of the table (`@shared/slack-link.js`). URL bodies are not logged (nor are names).
 */
import {
  MAX_SLACK_TEAMS,
  rewriteSlackLink,
  sanitizeSlackTeams,
  slackClientTeamOf,
  slackWorkspaceOf,
  type SlackTeamMap
} from '@shared/slack-link.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { log } from '../../common/logger.js'

/** The time within which opening a name URL and reaching an ID URL count as the same flow. */
export const OBSERVE_WINDOW_MS = 10 * 60 * 1000

export interface SlackTeamsDeps {
  read(): SlackTeamMap
  write(teams: SlackTeamMap): void
  now?(): number
}

export class SlackTeams {
  /** The "last opened name" per webContents. */
  private readonly pending = new Map<number, { readonly name: string; readonly at: number }>()
  private teams: SlackTeamMap | null = null

  constructor(private readonly deps: SlackTeamsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The remembered table (read only the first time). */
  current(): SlackTeamMap {
    if (this.teams === null) {
      try {
        this.teams = sanitizeSlackTeams(this.deps.read())
      } catch {
        this.teams = {}
      }
    }
    return this.teams
  }

  /** The web view's webContents (`contentsId`) reached `url` (`did-navigate` / `did-navigate-in-page`). */
  observe(contentsId: number, url: string): void {
    const name = slackWorkspaceOf(url)
    if (name !== null) {
      this.pending.set(contentsId, { name, at: this.now() })
      return
    }
    const team = slackClientTeamOf(url)
    if (team === null) return
    const seen = this.pending.get(contentsId)
    if (seen === undefined || this.now() - seen.at > OBSERVE_WINDOW_MS) return
    this.pending.delete(contentsId)
    this.learn(seen.name, team)
  }

  /** The webContents closed. */
  forget(contentsId: number): void {
    this.pending.delete(contentsId)
  }

  /** Rewrites a link in an answer (as is if unknown). If the rewritten result is not http(s) either, it stays as is. */
  rewrite(url: unknown): string | null {
    if (!isWebViewerUrl(url)) return null
    const next = rewriteSlackLink(url, this.current())
    return isWebViewerUrl(next) ? next : url
  }

  private learn(name: string, team: string): void {
    const teams = this.current()
    if (teams[name] === team) return
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(teams)) if (key !== name) next[key] = value
    next[name] = team
    const keys = Object.keys(next)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SLACK_TEAMS))) delete next[key]
    this.teams = sanitizeSlackTeams(next)
    try {
      this.deps.write(this.teams)
      log.info('web.slack.learned', { count: Object.keys(this.teams).length })
    } catch (err) {
      log.warn('web.slack.saveFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }
}
