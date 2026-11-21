/**
 * TODO 848: the plugin-host side of the bundled `aios.reddit`. Reading the URLs, shaping `.json` into Markdown, and that
 * `fetchRedditThread` uses only the Broker (`api.browser.fetchPage`). A fake `api` is passed in: the real reddit is not connected to.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrokerBrowserFetchPageResult, PluginApi } from '../src/shared/plugin.js'
import { parseManifest, isDeclaredExport } from '../src/main/plugin/manifest.js'
import { DEFAULT_DISABLED_PLUGIN_IDS } from '../src/main/plugin/host.js'
import plugin, { fetchRedditThread } from '../plugins/aios.reddit/host/index.js'
import {
  MAX_MARKDOWN_CHARS,
  isRedditHost,
  threadJsonUrl,
  threadPathOf,
  threadToMarkdown
} from '../plugins/aios.reddit/host/thread.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => undefined } }))

const THREAD = [
  {
    kind: 'Listing',
    data: {
      children: [
        {
          kind: 't3',
          data: {
            title: 'How do I X?',
            author: 'alice',
            subreddit_name_prefixed: 'r/test',
            score: 42,
            num_comments: 3,
            created_utc: 1_760_000_000,
            permalink: '/r/test/comments/abc123/how_do_i_x/',
            is_self: true,
            selftext: 'Body line 1\n\nBody line 2'
          }
        }
      ]
    }
  },
  {
    kind: 'Listing',
    data: {
      children: [
        {
          kind: 't1',
          data: {
            author: 'bob',
            score: 10,
            body: 'Top answer\nsecond line',
            replies: {
              kind: 'Listing',
              data: { children: [{ kind: 't1', data: { author: 'carol', score: 2, body: 'Reply', replies: '' } }] }
            }
          }
        },
        { kind: 'more', data: { count: 5 } }
      ]
    }
  }
]

function api(pages: Record<string, BrokerBrowserFetchPageResult>): PluginApi & { fetched: string[] } {
  const fetched: string[] = []
  const unused = (): never => {
    throw new Error('aios.reddit must use only api.browser')
  }
  return {
    fetched,
    fs: { read: unused },
    triggers: { emit: unused },
    settings: { get: unused },
    net: { fetch: unused },
    credentials: { status: unused },
    index: { put: unused, remove: unused },
    ui: { notify: unused },
    sidebar: { setRows: unused },
    status: { report: unused },
    browser: {
      fetchPage: async (url) => {
        fetched.push(url)
        const page = pages[url]
        if (page === undefined) throw new Error('host-not-allowed')
        return page
      }
    }
  }
}

const json = (url: string, text: string, status = 200): BrokerBrowserFetchPageResult => ({
  status,
  url,
  contentType: 'application/json',
  text,
  truncated: false
})

describe('telling URLs apart', () => {
  it('takes the id and subreddit from a thread URL and builds the .json URL aligned to www', () => {
    expect(threadPathOf(new URL('https://old.reddit.com/r/test/comments/ABC123/title/'))).toEqual({ subreddit: 'test', id: 'abc123' })
    expect(threadPathOf(new URL('https://www.reddit.com/comments/abc123'))).toEqual({ subreddit: null, id: 'abc123' })
    expect(threadPathOf(new URL('https://www.reddit.com/r/test/s/XyZ'))).toBeNull()
    expect(threadJsonUrl({ subreddit: 'test', id: 'abc123' }, 'top', 50)).toBe(
      'https://www.reddit.com/r/test/comments/abc123/.json?raw_json=1&sort=top&limit=50'
    )
    expect(isRedditHost('old.reddit.com')).toBe(true)
    expect(isRedditHost('reddit.com.evil.example')).toBe(false)
  })
})

describe('formatting to Markdown', () => {
  it('post, nested comments, and the count of more', () => {
    const markdown = threadToMarkdown(JSON.stringify(THREAD), { maxComments: 200 })
    expect(markdown).toBe(
      [
        '# How do I X?',
        'r/test · u/alice · 42 points · 3 comments · 2025-10-09',
        '<https://www.reddit.com/r/test/comments/abc123/how_do_i_x/>',
        '',
        'Body line 1\n\nBody line 2',
        '',
        '## Comments',
        '',
        '- **u/bob** (10)\n  Top answer\n  second line',
        '  - **u/carol** (2)\n    Reply',
        '',
        '(5 more comments not included)'
      ].join('\n')
    )
  })

  it('count limit, JSON of a different shape, and oversized output', () => {
    expect(threadToMarkdown(JSON.stringify(THREAD), { maxComments: 1 })).toContain('(6 more comments not included)')
    expect(threadToMarkdown('<html>', { maxComments: 1 })).toBeNull()
    expect(threadToMarkdown('{}', { maxComments: 1 })).toBeNull()
    const huge = structuredClone(THREAD)
    ;(huge[0]!.data.children[0]!.data as Record<string, unknown>)['selftext'] = 'x'.repeat(MAX_MARKDOWN_CHARS + 10)
    expect(threadToMarkdown(JSON.stringify(huge), { maxComments: 1 })).toMatch(/truncated at/)
  })
})

describe('fetchRedditThread', () => {
  const jsonUrl = 'https://www.reddit.com/r/test/comments/abc123/.json?raw_json=1&sort=confidence&limit=200'

  it('fetches .json only once for a thread URL', async () => {
    const fake = api({ [jsonUrl]: json(jsonUrl, JSON.stringify(THREAD)) })
    const markdown = await fetchRedditThread({ url: 'https://old.reddit.com/r/test/comments/abc123/x/' }, fake)
    expect(markdown).toMatch(/^# How do I X\?/)
    expect(fake.fetched).toEqual([jsonUrl])
  })

  it('a share link fetches the page and finds the thread from the URL after the Broker followed it', async () => {
    const share = 'https://www.reddit.com/r/test/s/XyZ'
    const fake = api({
      [share]: {
        status: 200,
        url: 'https://www.reddit.com/r/test/comments/abc123/how_do_i_x/',
        contentType: 'text/html',
        text: '<html></html>',
        truncated: false
      },
      [jsonUrl]: json(jsonUrl, JSON.stringify(THREAD))
    })
    await fetchRedditThread({ url: share }, fake)
    expect(fake.fetched).toEqual([share, jsonUrl])
  })

  it('errors for outside reddit, not a thread, login required, not JSON, or too large', async () => {
    await expect(fetchRedditThread({ url: 'https://mail.google.com/' }, api({}))).rejects.toThrow('only reddit.com')
    await expect(fetchRedditThread({ url: 'nope' }, api({}))).rejects.toThrow('not a URL')
    await expect(fetchRedditThread({}, api({}))).rejects.toThrow('url is required')
    await expect(
      fetchRedditThread({ url: 'https://www.reddit.com/r/test/comments/abc123/' }, api({ [jsonUrl]: json(jsonUrl, '', 403) }))
    ).rejects.toThrow(/Sign in to Reddit in the aios Web view/)
    await expect(
      fetchRedditThread(
        { url: 'https://www.reddit.com/r/test/comments/abc123/' },
        api({ [jsonUrl]: { ...json(jsonUrl, '<html>'), contentType: 'text/html' } })
      )
    ).rejects.toThrow(/did not return JSON/)
    await expect(
      fetchRedditThread(
        { url: 'https://www.reddit.com/r/test/comments/abc123/' },
        api({ [jsonUrl]: { ...json(jsonUrl, '[1'), truncated: true } })
      )
    ).rejects.toThrow(/smaller maxComments/)
  })
})

describe('bundled manifest', () => {
  it('browser.hosts is only reddit.com, the tools are exported as declared, and it is disabled by default', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(process.cwd(), 'plugins/aios.reddit/manifest.json'), 'utf8')))
    expect(manifest.capabilities).toEqual({ browser: { hosts: ['reddit.com', '*.reddit.com'] } })
    expect(manifest.mcp?.tools?.map((tool) => [tool.name, tool.sideEffect ?? false])).toEqual([['fetchRedditThread', false]])
    expect(isDeclaredExport(manifest, 'mcp', 'fetchRedditThread')).toBe(true)
    expect(Object.keys(plugin.mcp ?? {})).toEqual(['fetchRedditThread'])
    expect(DEFAULT_DISABLED_PLUGIN_IDS.has('aios.reddit')).toBe(true)
  })
})
