/**
 * TODO 1235 / 1253 (wave 92 bundle B): the entry through which the gateway's `getDocument` / `getDocumentText` can point at a document by uri or by (source, source_id), and the `thread_uri` / `thread_title` that the conversation hits of `search` attach.
 *
 *  - main runs no SQL: it resolves one id through the index process's `resolveDocument`, then reads by id as before
 *  - zero results, multiple results, and fs return the tool error shape (`{ error }`) without reading
 *
 * Uses neither the model nor Electron.
 */
import { describe, expect, it } from 'vitest'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'

type Resolved = { id: string } | { reason: 'not-found' | 'ambiguous' | 'unsupported' | 'source-required' }

function gateway(resolved: Resolved): { requests: GatewayRequests; resolves: unknown[]; reads: string[] } {
  const resolves: unknown[] = []
  const reads: string[] = []
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: () => 't1',
    index: {
      resolveDocument: async (query: unknown, forAgent: boolean) => {
        resolves.push({ query, forAgent })
        return resolved
      },
      getDocument: async (id: string) => {
        reads.push(`doc:${id}`)
        return { id }
      },
      getDocumentText: async (id: string) => {
        reads.push(`text:${id}`)
        return { id }
      },
      search: async () => ({
        hits: [
          {
            id: '5', uri: 'thread://t9/e1', title: 'https://example.com', source: 'conversation', kind: 'message',
            updatedAt: 1, score: 1, snippet: 's', threadId: 't9', eventId: 'e1', context: '', contextCode: null
          },
          {
            id: '7', uri: 'thread://t8/e2', title: '', source: 'conversation', kind: 'message',
            updatedAt: 1, score: 1, snippet: 's', threadId: 't8', eventId: 'e2', context: 'あなた', contextCode: 'user'
          },
          {
            id: '8', uri: 'thread://t7/e3', title: 'あなた', source: 'conversation', kind: 'message',
            updatedAt: 1, score: 1, snippet: 's', threadId: 't7', eventId: 'e3', context: 'あなた', contextCode: 'user'
          },
          {
            id: '6', uri: 'file:///a.md', title: 'a.md', source: 'fs', kind: 'file',
            updatedAt: 1, score: 1, snippet: 's', threadId: null, eventId: null, context: '', contextCode: null
          }
        ],
        total: 4,
        truncated: false
      })
    } as unknown as GatewayRequestHost['index']
  }
  return { requests: new GatewayRequests(host as GatewayRequestHost), resolves, reads }
}

const call = (requests: GatewayRequests, kind: string, payload: Record<string, unknown>): Promise<unknown> =>
  requests.handle({ sessionId: 's1', kind, payload })

describe('calling getDocument / getDocumentText with a uri (TODO 1235)', () => {
  it('reads an id as is (no re-lookup)', async () => {
    const { requests, resolves, reads } = gateway({ reason: 'not-found' })
    await call(requests, 'getDocument', { id: '7' })
    expect(resolves).toEqual([])
    expect(reads).toEqual(['doc:7'])
  })

  it('resolves uri + source to one item in the index process (as agent) and reads by that id', async () => {
    const { requests, resolves, reads } = gateway({ id: '42' })
    expect(await call(requests, 'getDocument', { uri: 'gmail://t/m', source: 'aios.gmail' })).toEqual({ id: '42' })
    expect(await call(requests, 'getDocumentText', { uri: 'gmail://t/m' })).toEqual({ id: '42' })
    expect(resolves).toEqual([
      { query: { uri: 'gmail://t/m', source: 'aios.gmail' }, forAgent: true },
      { query: { uri: 'gmail://t/m' }, forAgent: true }
    ])
    expect(reads).toEqual(['doc:42', 'text:42'])
  })

  it('can also be resolved by source + source_id', async () => {
    const { requests, resolves } = gateway({ id: '3' })
    await call(requests, 'getDocument', { source: 'aios.gmail', source_id: 'm1' })
    expect(resolves).toEqual([{ query: { source: 'aios.gmail', sourceId: 'm1' }, forAgent: true }])
  })

  it('0 matches, multiple matches, fs and no specifier return a reason without reading', async () => {
    for (const reason of ['not-found', 'ambiguous', 'unsupported', 'source-required'] as const) {
      const { requests, reads } = gateway({ reason })
      const reply = await call(requests, 'getDocument', { uri: 'x://y' })
      expect(reply).toHaveProperty('error')
      expect(reads).toEqual([])
    }
    const { requests, resolves, reads } = gateway({ id: '1' })
    expect(await call(requests, 'getDocumentText', { source: 'aios.gmail' })).toHaveProperty('error')
    expect(await call(requests, 'getDocument', {})).toHaveProperty('error')
    expect(resolves).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('conversation hits in search (TODO 1253)', () => {
  it('only conversation hits get thread_uri (no event) and thread_title', async () => {
    const { requests } = gateway({ id: '1' })
    const reply = (await call(requests, 'search', { query: 'x', source: 'conversation' })) as {
      hits: Record<string, unknown>[]
    }
    expect(reply.hits[0]).toMatchObject({ uri: 'thread://t9/e1', thread_uri: 'thread://t9', thread_title: 'https://example.com' })
    // An untitled thread (empty title) and a thread whose name could not be read (title = the role label) have no thread_title.
    expect(reply.hits[1]).toMatchObject({ thread_uri: 'thread://t8' })
    expect(reply.hits[1]).not.toHaveProperty('thread_title')
    expect(reply.hits[2]).toMatchObject({ thread_uri: 'thread://t7' })
    expect(reply.hits[2]).not.toHaveProperty('thread_title')
    expect(reply.hits[3]).not.toHaveProperty('thread_uri')
  })
})
