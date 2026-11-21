/**
 * Entry point to the Bitbucket Cloud REST API 2.0 (TODO 1218, ARCHITECTURE 7.5.3). **Read-only** - not a single write call is written.
 * All sending goes through `api.net.fetch` (CapabilityBroker): the allowed host is the manifest's `network.hosts` (`api.bitbucket.org`),
 * and if a credential is attached by name (`auth`), the Broker adds `Authorization: Basic …`. The plugin sees neither the token nor the email.
 */
import type { PluginApi } from '@shared/plugin.js'

export const BITBUCKET_CREDENTIAL = 'bitbucket:api-token'
export const BITBUCKET_API = 'https://api.bitbucket.org/2.0'

/** Rate limit (429 / the Broker's per-minute limit). Leave a gap. */
export class RateLimited extends Error {
  constructor(readonly local: boolean) {
    super(local ? 'rate-limited (aios)' : 'rate-limited (bitbucket)')
    this.name = 'RateLimited'
  }
}
/** The credential is missing or not accepted (401 / 403). It must be entered again. */
export class NotSignedIn extends Error {
  constructor(readonly status: number = 401) {
    super('not signed in')
    this.name = 'NotSignedIn'
  }
}
/** A temporary failure on the other side (5xx). */
export class Transient extends Error {
  constructor(readonly status: number) {
    super(`bitbucket ${status}`)
    this.name = 'Transient'
  }
}
/** 400 (such as a filter syntax not accepted). */
export class BadRequest extends Error {
  constructor() {
    super('bitbucket 400')
    this.name = 'BadRequest'
  }
}
/** 404 (the PR or repository does not exist or is not visible). */
export class NotFound extends Error {
  constructor() {
    super('bitbucket 404')
    this.name = 'NotFound'
  }
}

/** The number of requests that one call may use. */
export class Budget {
  used = 0
  constructor(readonly limit: number) {}
  get left(): number {
    return this.limit - this.used
  }
  take(): void {
    this.used += 1
  }
}

const decoder = new TextDecoder('utf-8')

function brokerError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('rate-limited')) return new RateLimited(true)
  if (message.includes('no-credential') || message.includes('not-consented')) return new NotSignedIn()
  return err instanceof Error ? err : new Error(message)
}

export interface TextResponse {
  readonly text: string
  readonly truncated: boolean
}

/** Does a GET and returns the body. Tells failures apart by the status. */
export async function getText(api: PluginApi, budget: Budget, url: string): Promise<TextResponse> {
  budget.take()
  let response
  try {
    response = await api.net.fetch(url, { method: 'GET', headers: { accept: 'application/json, text/plain' }, auth: BITBUCKET_CREDENTIAL })
  } catch (err) {
    throw brokerError(err)
  }
  const status = response.status
  if (status >= 200 && status < 300) return { text: decoder.decode(response.body), truncated: response.truncated }
  if (status === 429) throw new RateLimited(false)
  if (status === 401 || status === 403) throw new NotSignedIn(status)
  if (status === 404) throw new NotFound()
  if (status === 400) throw new BadRequest()
  if (status >= 500) throw new Transient(status)
  throw new Error(`bitbucket ${status}`)
}

export async function getJson<T>(api: PluginApi, budget: Budget, url: string): Promise<T> {
  const response = await getText(api, budget, url)
  if (response.truncated) throw new Error('bitbucket response too large')
  return JSON.parse(response.text) as T
}

// ---- Response shapes (from the official OpenAPI definition https://api.bitbucket.org/swagger.json, only the keys we use) ----

export interface Account {
  readonly uuid?: string
  readonly display_name?: string
  readonly nickname?: string
}

export interface Participant {
  readonly user?: Account
  readonly role?: string
  readonly approved?: boolean
  readonly state?: string | null
}

export interface PullRequest {
  readonly id?: number
  readonly title?: string
  readonly state?: string
  readonly draft?: boolean
  readonly author?: Account
  readonly summary?: { readonly raw?: string }
  readonly description?: string
  readonly source?: { readonly branch?: { readonly name?: string }; readonly repository?: { readonly full_name?: string } }
  readonly destination?: { readonly branch?: { readonly name?: string } }
  readonly reviewers?: readonly Account[]
  readonly participants?: readonly Participant[]
  readonly comment_count?: number
  readonly created_on?: string
  readonly updated_on?: string
  readonly links?: { readonly html?: { readonly href?: string } }
}

export interface Page<T> {
  readonly values?: readonly T[]
  readonly next?: string
}

export interface Workspace {
  readonly slug?: string
}
export interface WorkspaceMembership {
  readonly workspace?: Workspace
}
export interface Repository {
  readonly slug?: string
  readonly full_name?: string
  readonly updated_on?: string
}

export interface Comment {
  readonly id?: number
  readonly created_on?: string
  readonly deleted?: boolean
  readonly content?: { readonly raw?: string }
  readonly user?: Account
  readonly parent?: { readonly id?: number }
  readonly inline?: { readonly path?: string; readonly from?: number | null; readonly to?: number | null }
}

/** A slug (workspace / repo) that may be used in a URL part. */
export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
}

export function prUrl(workspace: string, repo: string, id: number): string {
  return `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${id}`
}

/** Compares uuids with the `{...}` braces removed (also ignoring case). */
export function sameUuid(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return a.replace(/[{}]/g, '').toLowerCase() === b.replace(/[{}]/g, '').toLowerCase()
}
