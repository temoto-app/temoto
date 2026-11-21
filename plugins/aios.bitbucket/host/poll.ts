/**
 * The periodic task `poll` (TODO 1218, ARCHITECTURE 7.5.3). It does not call the model. It finds open PRs where the user was named as a reviewer, and
 * reports the new ones with `api.triggers.emit` (6.2.6). **The key is only `workspace/repo#id`** - even if a push adds commits, it is not reported a second time
 * (owner decision 2026-11-13). It only reports "found"; there is no call that writes to Bitbucket.
 *
 * How it finds them: the official API has no endpoint that returns "PRs where I am the reviewer" across everything (the argument of a workspace's
 * `pullrequests/{user}` is the *author*). So (1) learn the workspaces with `/user/workspaces`, (2) take each workspace's recently updated repositories,
 * (3) per repository, fetch PRs filtered by `state=OPEN` + `reviewers.uuid`, and (4) check eligibility one by one with the PR itself (the self URL, which includes reviewers).
 * The repository list is refetched only every 6 hours, and a per-run cap on requests is set so repositories are visited in rotation.
 */
import type { PluginApi, PluginTaskArg, PluginTaskResult, PluginTaskState } from '@shared/plugin.js'
import {
  BITBUCKET_API,
  BITBUCKET_CREDENTIAL,
  BadRequest,
  Budget,
  NotFound,
  NotSignedIn,
  RateLimited,
  Transient,
  getJson,
  prUrl,
  sameUuid,
  type Account,
  type Page,
  type PullRequest,
  type Repository,
  type WorkspaceMembership
} from './bitbucket.js'

export const TRIGGER_ID = 'review-requested'
/** The number of requests allowed in one call. */
export const REQUEST_BUDGET = 40
/** Interval for refetching the repository list. */
export const REPOS_TTL_MS = 6 * 60 * 60 * 1000
/** Upper limit on repositories in the list; ones whose last update is older than this are dropped. */
export const MAX_REPOS = 150
export const RECENT_MS = 60 * 24 * 60 * 60 * 1000
const REPO_PAGES_PER_WORKSPACE = 2
/** The absolute upper limit (count) of seen. Separately from the count limit, the oldest are dropped until the state's JSON fits within SEEN_BYTES. */
const MAX_SEEN = 200
const SEEN_BYTES = 12 * 1024
const MIN_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const TRANSIENT_BACKOFF_MS = 2 * 60_000
const HELD_BACKOFF_MS = 30 * 60_000

export interface PollState {
  me: string
  repos: string[]
  reposAt: number
  cursor: number
  /** `workspace/repo#id` -> `'done'` (reported), or the `updated_on` from when eligibility was missing (not looked at again until that PR is updated). */
  seen: Record<string, string>
  /** The other side did not accept the filter (`reviewers.uuid`). */
  noFilter: boolean
  backoffMs: number
}

function emptyState(): PollState {
  return { me: '', repos: [], reposAt: 0, cursor: 0, seen: {}, noFilter: false, backoffMs: 0 }
}

export function parseState(raw: PluginTaskState | null): PollState {
  const state = emptyState()
  if (raw === null) return state
  if (typeof raw['me'] === 'string') state.me = raw['me']
  if (Array.isArray(raw['repos'])) state.repos = raw['repos'].filter((v): v is string => typeof v === 'string' && v.includes('/')).slice(0, MAX_REPOS)
  if (typeof raw['reposAt'] === 'number') state.reposAt = raw['reposAt']
  if (typeof raw['cursor'] === 'number' && raw['cursor'] >= 0) state.cursor = Math.floor(raw['cursor'])
  const seen = raw['seen']
  if (typeof seen === 'object' && seen !== null && !Array.isArray(seen)) {
    for (const [key, value] of Object.entries(seen)) if (typeof value === 'string') state.seen[key] = value
  }
  state.noFilter = raw['noFilter'] === true
  if (typeof raw['backoffMs'] === 'number') state.backoffMs = raw['backoffMs']
  return state
}

/** Marks / re-marks. Moves the key to the end (most recent) (LRU). */
function touchSeen(state: PollState, key: string, value: string): void {
  delete state.seen[key]
  state.seen[key] = value
}

/** Fits the state into the JSON limit (16 KB). Drops the oldest first (even if dropped, the aios side removes duplicates). */
export function toTaskState(state: PollState): PluginTaskState {
  // Newer (recently seen) ones are at the end. `touchSeen` moves a key to the end each time it is seen, so the markers of PRs seen this time are not dropped first.
  const keys = Object.keys(state.seen)
  let start = Math.max(0, keys.length - MAX_SEEN)
  let bytes = 0
  for (let i = keys.length - 1; i >= start; i -= 1) {
    bytes += (keys[i] as string).length + (state.seen[keys[i] as string] as string).length + 6
    if (bytes > SEEN_BYTES) {
      start = i + 1
      break
    }
  }
  const seen: Record<string, string> = {}
  for (const key of keys.slice(start)) seen[key] = state.seen[key] as string
  return { me: state.me, repos: state.repos, reposAt: state.reposAt, cursor: state.cursor, seen, noFilter: state.noFilter, backoffMs: state.backoffMs }
}

/** Whether I should review this PR (judged from the PR itself = the response of the self URL). */
export function isReviewable(pr: PullRequest, me: string): boolean {
  if (pr.state !== 'OPEN' || pr.draft === true) return false
  if (sameUuid(pr.author?.uuid, me)) return false
  const asReviewer =
    (pr.reviewers ?? []).some((account) => sameUuid(account.uuid, me)) ||
    (pr.participants ?? []).some((p) => p.role === 'REVIEWER' && sameUuid(p.user?.uuid, me))
  if (!asReviewer) return false
  const mine = (pr.participants ?? []).find((p) => sameUuid(p.user?.uuid, me))
  return mine?.approved !== true && mine?.state !== 'approved'
}

function accountName(account: Account | undefined): string {
  return account?.display_name ?? account?.nickname ?? 'unknown'
}

/** The reference sentence put into `prompt` (constraint 9: the description and diff are not included). */
export function promptFor(workspace: string, repo: string, pr: PullRequest): string {
  const id = pr.id ?? 0
  return [
    `Pull request: ${workspace}/${repo}#${id}`,
    `Title: ${pr.title ?? ''}`,
    `Author: ${accountName(pr.author)}`,
    `Branches: ${pr.source?.branch?.name ?? '?'} -> ${pr.destination?.branch?.name ?? '?'}`,
    `URL: ${pr.links?.html?.href ?? ''}`,
    `Read it with the tools getPullRequest, getPullRequestDiff and listPullRequestComments (workspace "${workspace}", repo "${repo}", id ${id}).`
  ].join('\n')
}

async function loadRepos(api: PluginApi, budget: Budget, state: PollState, now: number): Promise<void> {
  const workspaces = await getJson<Page<WorkspaceMembership>>(api, budget, `${BITBUCKET_API}/user/workspaces?pagelen=50`)
  const slugs = (workspaces.values ?? []).map((v) => v.workspace?.slug).filter((s): s is string => typeof s === 'string' && s !== '')
  const found: { name: string; updated: number }[] = []
  for (const slug of slugs) {
    let url: string | undefined = `${BITBUCKET_API}/repositories/${encodeURIComponent(slug)}?pagelen=100&sort=-updated_on`
    for (let page = 0; page < REPO_PAGES_PER_WORKSPACE && url !== undefined && budget.left > 1; page += 1) {
      const list: Page<Repository> = await getJson<Page<Repository>>(api, budget, url)
      for (const repository of list.values ?? []) {
        const name = repository.full_name
        if (typeof name !== 'string' || !name.includes('/')) continue
        const updated = Date.parse(repository.updated_on ?? '')
        if (Number.isFinite(updated) && now - updated > RECENT_MS) continue
        found.push({ name, updated: Number.isFinite(updated) ? updated : 0 })
      }
      url = list.next
    }
  }
  found.sort((a, b) => b.updated - a.updated)
  state.repos = found.slice(0, MAX_REPOS).map((entry) => entry.name)
  state.reposAt = now
  state.cursor = 0
}

function listUrl(workspace: string, repo: string, me: string, filtered: boolean): string {
  const base = `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests?state=OPEN&pagelen=50`
  return filtered ? `${base}&q=${encodeURIComponent(`reviewers.uuid="${me}"`)}` : base
}

type Outcome = 'continue' | 'stop-held'

/** Checks one repository. Returns 'stop-held' if the destination of the report is stopped (disabled / unavailable / limit). */
async function checkRepo(api: PluginApi, budget: Budget, state: PollState, fullName: string): Promise<Outcome> {
  const [workspace, repo] = fullName.split('/')
  if (workspace === undefined || repo === undefined || repo.includes('/')) return 'continue'
  let list: Page<PullRequest>
  try {
    list = await getJson<Page<PullRequest>>(api, budget, listUrl(workspace, repo, state.me, !state.noFilter))
  } catch (err) {
    if (err instanceof NotFound) return 'continue'
    if (err instanceof BadRequest && !state.noFilter) {
      // The filter syntax is not accepted. From now on fetch without filtering and check with the PR itself (more requests are sent).
      state.noFilter = true
      return checkRepo(api, budget, state, fullName)
    }
    throw err
  }
  for (const summary of list.values ?? []) {
    const id = summary.id
    if (typeof id !== 'number' || id < 1) continue
    const key = `${workspace}/${repo}#${id}`
    const seen = state.seen[key]
    if (seen === 'done' || (seen !== undefined && seen === summary.updated_on)) {
      touchSeen(state, key, seen)
      continue
    }
    if (budget.left < 1) return 'continue'
    let pr: PullRequest
    try {
      pr = await getJson<PullRequest>(api, budget, prUrl(workspace, repo, id))
    } catch (err) {
      if (err instanceof NotFound) continue
      throw err
    }
    if (!isReviewable(pr, state.me)) {
      touchSeen(state, key, summary.updated_on ?? pr.updated_on ?? 'skip')
      continue
    }
    const url = pr.links?.html?.href
    const result = await api.triggers.emit({
      trigger: TRIGGER_ID,
      key,
      title: `${workspace}/${repo}#${id} ${pr.title ?? ''}`.trim(),
      ...(typeof url === 'string' && url.startsWith('https://') ? { url } : {}),
      // The name of the clone under the rule's working folder (the "working folder" of 6.2.6). If it is not inside, main falls back to the rule's working folder.
      cwd: repo,
      prompt: promptFor(workspace, repo, pr)
    })
    if (result.accepted || result.reason === 'duplicate') {
      touchSeen(state, key, 'done')
      continue
    }
    if (result.reason === 'invalid') {
      touchSeen(state, key, pr.updated_on ?? 'skip')
      continue
    }
    // disabled / daily-cap / unavailable: do not advance the state, and stop this run.
    return 'stop-held'
  }
  return 'continue'
}

export async function runPoll(arg: PluginTaskArg, api: PluginApi, budgetLimit: number = REQUEST_BUDGET, now: () => number = Date.now): Promise<PluginTaskResult> {
  const credential = await api.credentials.status(BITBUCKET_CREDENTIAL)
  if (!credential.present) return { more: false }
  const budget = new Budget(budgetLimit)
  const state = parseState(arg.state)
  try {
    if (state.me === '') {
      const me = await getJson<Account>(api, budget, `${BITBUCKET_API}/user`)
      if (typeof me.uuid !== 'string' || me.uuid === '') throw new Error('bitbucket: no user uuid')
      state.me = me.uuid
    }
    if (state.repos.length === 0 || now() - state.reposAt > REPOS_TTL_MS) await loadRepos(api, budget, state, now())
    let visited = 0
    while (visited < state.repos.length && budget.left >= 2) {
      const index = state.cursor % state.repos.length
      const outcome = await checkRepo(api, budget, state, state.repos[index] as string)
      if (outcome === 'stop-held') {
        state.backoffMs = 0
        return { state: toTaskState(state), more: false, retryAfterMs: HELD_BACKOFF_MS }
      }
      state.cursor = (index + 1) % state.repos.length
      visited += 1
    }
  } catch (err) {
    if (err instanceof NotSignedIn) return { state: toTaskState(state), more: false }
    if (err instanceof RateLimited) {
      const backoffMs = err.local ? TRANSIENT_BACKOFF_MS : Math.min(Math.max(state.backoffMs * 2, MIN_BACKOFF_MS), MAX_BACKOFF_MS)
      if (!err.local) state.backoffMs = backoffMs
      return { state: toTaskState(state), more: false, retryAfterMs: backoffMs }
    }
    if (err instanceof Transient) return { state: toTaskState(state), more: false, retryAfterMs: TRANSIENT_BACKOFF_MS }
    throw err
  }
  state.backoffMs = 0
  return { state: toTaskState(state), more: false }
}
