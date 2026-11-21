/**
 * The plugin-host side of `aios.reddit` (TODO 848, ARCHITECTURE.md 7.6.7 / 7.7).
 *
 * **This code does not run in main** (constraint 8). Pages can be fetched only through `api.browser.fetchPage` = the CapabilityBroker, and
 * the Broker refuses anything outside the manifest's `browser.hosts` (reddit.com), including redirects that leave it. The first time needs the user's consent
 * (the relay asks in the approval inbox). The job here is only "which page to fetch and how to format it". Fetched pages are not stored.
 */
import type { PluginApi, PluginModule } from '@shared/plugin.js'
import {
  DEFAULT_MAX_COMMENTS,
  SORTS,
  isRedditHost,
  threadJsonUrl,
  threadPathOf,
  threadToMarkdown,
  type Sort
} from './thread.js'

interface Args {
  readonly url: string
  readonly maxComments: number
  readonly sort: Sort
}

function readArgs(arg: unknown): Args {
  const record = (typeof arg === 'object' && arg !== null ? arg : {}) as Record<string, unknown>
  const url = record['url']
  if (typeof url !== 'string' || url === '') throw new Error('url is required')
  const max = record['maxComments']
  const sort = record['sort']
  return {
    url,
    maxComments: typeof max === 'number' && Number.isInteger(max) && max > 0 ? Math.min(max, 1000) : DEFAULT_MAX_COMMENTS,
    sort: typeof sort === 'string' && (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : 'confidence'
  }
}

export async function fetchRedditThread(arg: unknown, api: PluginApi): Promise<string> {
  const args = readArgs(arg)
  let url: URL
  try {
    url = new URL(args.url)
  } catch {
    throw new Error('not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not an http(s) URL')
  if (!isRedditHost(url.hostname)) throw new Error('only reddit.com URLs are supported')
  url.protocol = 'https:'

  let thread = threadPathOf(url)
  if (thread === null) {
    // A share link (`/r/<sub>/s/<code>`) and the like: fetch the page and look at the redirect destination (the URL after the Broker has checked it).
    const page = await api.browser.fetchPage(url.toString())
    thread = threadPathOf(new URL(page.url))
    if (thread === null) throw new Error('this URL does not point to a Reddit thread (…/comments/<id>/…)')
  }

  const response = await api.browser.fetchPage(threadJsonUrl(thread, args.sort, args.maxComments))
  if (response.status !== 200) {
    throw new Error(
      response.status === 403 || response.status === 401
        ? `Reddit answered ${response.status}. Sign in to Reddit in the aios Web view and try again.`
        : `Reddit answered ${response.status}`
    )
  }
  if (response.contentType !== 'application/json') throw new Error(`Reddit did not return JSON (${response.contentType})`)
  // JSON cut at the limit cannot be read. Have the caller ask again with fewer comments.
  if (response.truncated) throw new Error('the thread is larger than the size limit: try a smaller maxComments')
  const markdown = threadToMarkdown(response.text, { maxComments: args.maxComments })
  if (markdown === null) throw new Error('Reddit returned JSON in a shape this plugin does not understand')
  return markdown
}

const plugin: PluginModule = {
  mcp: { fetchRedditThread }
}

export default plugin
