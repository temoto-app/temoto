/**
 * Telling Reddit thread URLs apart, and formatting a `.json` response into Markdown (TODO 848). **Pure functions with no I/O** —
 * `index.ts` passes the body it fetched through the Broker (`api.browser.fetchPage`) here. Tests call them directly.
 *
 * Reddit returns `[the post's Listing, the comments' Listing]` when `.json` is appended to a thread URL (no rendering is needed).
 * A share link (`/r/<sub>/s/<code>`) reaches the real URL by a redirect, so the page is fetched first to see the destination.
 */

/** The upper limit of the Markdown returned (characters). Kept within the relay's limit (256 KB as JSON) and the gateway's truncation. */
export const MAX_MARKDOWN_CHARS = 120_000
/** The upper limit of the depth to which nested comments are followed. */
export const MAX_DEPTH = 8
export const DEFAULT_MAX_COMMENTS = 200

export const SORTS = ['confidence', 'top', 'new', 'controversial', 'old', 'qa'] as const
export type Sort = (typeof SORTS)[number]

/** Whether it is reddit.com (or a subdomain of it). The same range as `browser.hosts`. */
export function isRedditHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'reddit.com' || host.endsWith('.reddit.com')
}

/** For `/r/<sub>/comments/<id>/…` or `/comments/<id>/…`, the thread id and the subreddit. */
export function threadPathOf(url: URL): { readonly subreddit: string | null; readonly id: string } | null {
  const match = /^\/(?:r\/([A-Za-z0-9_]{1,64})\/)?comments\/([a-z0-9]{1,16})(?:\/|$)/i.exec(url.pathname)
  if (match === null || match[2] === undefined) return null
  return { subreddit: match[1] ?? null, id: match[2].toLowerCase() }
}

/** The `.json` URL of a thread. The host is normalized to `www.reddit.com` (absorbing aliases such as old / new / np). */
export function threadJsonUrl(thread: { readonly subreddit: string | null; readonly id: string }, sort: Sort, limit: number): string {
  const base = thread.subreddit === null ? `/comments/${thread.id}` : `/r/${thread.subreddit}/comments/${thread.id}`
  const query = new URLSearchParams({ raw_json: '1', sort, limit: String(limit) })
  return `https://www.reddit.com${base}/.json?${query.toString()}`
}

interface Thing {
  readonly kind?: unknown
  readonly data?: Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function childrenOf(listing: unknown): readonly Thing[] {
  if (typeof listing !== 'object' || listing === null) return []
  const data = (listing as Thing).data
  const children = data?.['children']
  return Array.isArray(children) ? (children as Thing[]) : []
}

function dateOf(createdUtc: unknown): string {
  const seconds = num(createdUtc)
  if (seconds === null) return ''
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/** Indent every line of the body (to put nested comments under a Markdown list). */
function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? prefix.trimEnd() : `${prefix}${line}`))
    .join('\n')
}

/**
 * Turn a `.json` response (a string) into Markdown. null if the shape is different (the caller turns it into an error).
 * Comments are taken depth-first up to `maxComments`, and only the count is written for `more` (continuations).
 */
export function threadToMarkdown(jsonText: string, options: { readonly maxComments: number }): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < 1) return null
  const post = childrenOf(parsed[0])[0]?.data
  if (post === undefined) return null

  const lines: string[] = []
  lines.push(`# ${str(post['title']).trim() || '(untitled)'}`)
  const meta = [
    str(post['subreddit_name_prefixed']),
    post['author'] === undefined ? '' : `u/${str(post['author'])}`,
    num(post['score']) === null ? '' : `${num(post['score'])} points`,
    num(post['num_comments']) === null ? '' : `${num(post['num_comments'])} comments`,
    dateOf(post['created_utc'])
  ].filter((part) => part !== '')
  lines.push(meta.join(' · '))
  const permalink = str(post['permalink'])
  if (permalink !== '') lines.push(`<https://www.reddit.com${permalink}>`)
  if (post['is_self'] !== true && str(post['url']) !== '') lines.push(`Link: <${str(post['url'])}>`)
  const selftext = str(post['selftext']).trim()
  if (selftext !== '') lines.push('', selftext)

  lines.push('', '## Comments', '')
  let count = 0
  let omitted = 0
  const walk = (things: readonly Thing[], depth: number): void => {
    for (const thing of things) {
      const data = thing.data
      if (data === undefined) continue
      if (thing.kind === 'more') {
        omitted += num(data['count']) ?? 0
        continue
      }
      if (thing.kind !== 't1') continue
      if (count >= options.maxComments || depth > MAX_DEPTH) {
        omitted += 1
        continue
      }
      count += 1
      const pad = '  '.repeat(depth)
      const score = num(data['score'])
      const head = `${pad}- **u/${str(data['author']) || '[deleted]'}**${score === null ? '' : ` (${score})`}`
      const body = str(data['body']).trim()
      lines.push(body === '' ? head : `${head}\n${indent(body, `${pad}  `)}`)
      const replies = data['replies']
      if (typeof replies === 'object' && replies !== null) walk(childrenOf(replies), depth + 1)
    }
  }
  walk(parsed.length > 1 ? childrenOf(parsed[1]) : [], 0)
  if (count === 0) lines.push('(no comments)')
  if (omitted > 0) lines.push('', `(${omitted} more comments not included)`)

  const text = lines.join('\n')
  if (text.length <= MAX_MARKDOWN_CHARS) return text
  return `${text.slice(0, MAX_MARKDOWN_CHARS)}\n\n(truncated at ${MAX_MARKDOWN_CHARS} characters)`
}
