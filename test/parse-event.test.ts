/**
 * Unit tests for `parseEvent` (required by IMPLEMENTATION_BRIEF chapter 7, PHASE2_BRIEF 3.9).
 *
 * The fixture (`test/fixtures/stream-session.jsonl`) is the raw event sequence **actually captured by running one turn of CLI 2.1.207**;
 * only the values that depend on the personal environment (paths, session UUID, thinking signatures) are replaced with synthetic values. The structure is unchanged.
 * Included: system/init, system/status, rate_limit_event, stream_event
 * (message_start / content_block_start / content_block_delta with text, thinking, signature, input_json / content_block_stop / message_delta / message_stop),
 * assistant (thinking, tool_use, text), user (tool_result), result.
 *
 * **It runs without calling a model.**
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AiosEvent } from '../src/shared/agent.js'
import { parseEvent, summarizeToolInput } from '../src/main/session/adapter/parse.js'
import { MAX_ARG_CHARS } from '../src/common/clip-json.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'

const fixtureDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const lines = readFileSync(join(fixtureDir, 'stream-session.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000,
  newId: () => `e${(counter += 1)}`
}

function parseAll(): AiosEvent[] {
  counter = 0
  return lines.flatMap((line) => [...parseEvent(line, ctx)])
}

describe('parseEvent: a measured stream-json sequence', () => {
  it('normalizes one turn without dropping anything', () => {
    const events = parseAll()
    const kinds = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.kind] = (acc[event.kind] ?? 0) + 1
      return acc
    }, {})

    expect(kinds['session_started']).toBe(1)
    expect(kinds['assistant_delta']).toBe(2) // "O" and "K"
    // In this capture the thinking_delta contents were empty strings, so there are 0 of them.
    // An empty delta carries no information, so it is dropped (there is a test below for the case with contents).
    expect(kinds['thinking_delta']).toBeUndefined()
    expect(kinds['assistant_text']).toBe(1)
    expect(kinds['tool_use']).toBe(1)
    expect(kinds['tool_result']).toBe(1)
    expect(kinds['result']).toBe(1)
    expect(kinds['rate_limit']).toBe(1)
    // assistant has 3 lines (thinking / tool_use / text), each carrying usage (item 60).
    expect(kinds['turn_usage']).toBe(3)
  })

  it('turn_usage arrives per assistant and the last one becomes 「いまのコンテキスト」 (item 60)', () => {
    const events = parseAll()
    const usages = events.filter((e) => e.kind === 'turn_usage')
    expect(usages).toHaveLength(3)
    // usage comes out before the text (assistant_text / tool_use).
    const firstText = events.findIndex((e) => e.kind === 'assistant_text')
    const lastUsage = events.lastIndexOf(usages[usages.length - 1]!)
    expect(lastUsage).toBeLessThan(firstText)

    const last = usages[usages.length - 1]
    if (last?.kind !== 'turn_usage') throw new Error('no turn_usage')
    // Real (CLI 2.1.207): the second API call = 2 + 27,564 + 168 = 27,734 is the context.
    expect(last.payload.model).toBe('claude-sonnet-5')
    expect(last.payload.inputTokens).toBe(2)
    expect(last.payload.cacheReadTokens).toBe(27_564)
    expect(last.payload.cacheCreationTokens).toBe(168)
    expect(last.payload.inputTokens + last.payload.cacheReadTokens + last.payload.cacheCreationTokens).toBe(27_734)

    // The first call (two lines, thinking and tool_use, with the same message.id) gives 2 identical entries.
    const [a, b] = usages
    if (a?.kind !== 'turn_usage' || b?.kind !== 'turn_usage') throw new Error('missing')
    expect(a.payload).toEqual(b.payload)
    expect(a.payload.cacheCreationTokens).toBe(27_564)

    // The result's usage is the sum within the turn, close to twice the last call's. Do not use it for the numerator.
    const result = events.find((e) => e.kind === 'result')
    if (result?.kind !== 'result') throw new Error('no result')
    const sum = result.payload.usage.inputTokens + result.payload.usage.cacheReadTokens + result.payload.usage.cacheCreationTokens
    expect(sum).toBe(55_300)
    expect(sum).toBeGreaterThan(27_734)
  })

  it('result carries the context window limit reported by the backend (items 60 / 74)', () => {
    const event = parseAll().find((e) => e.kind === 'result')
    if (event?.kind !== 'result') throw new Error('no result')
    expect(event.payload.contextWindows).toEqual(
      expect.arrayContaining([
        { model: 'claude-sonnet-5', contextWindow: 1_000_000 },
        { model: 'claude-haiku-4-5-20251001', contextWindow: 200_000 }
      ])
    )
  })

  it('does not emit turn_usage from an assistant without usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'm', content: [{ type: 'text', text: 'hi' }] }
    })
    const kinds = parseEvent(line, ctx).map((e) => e.kind)
    expect(kinds).toEqual(['assistant_text'])
  })

  it("turn_usage of a subagent's assistant arrives with actor=subagent", () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { model: 'm', usage: { input_tokens: 5 }, content: [] }
    })
    const [event] = parseEvent(line, ctx)
    expect(event?.kind).toBe('turn_usage')
    expect(event?.actor).toBe('subagent')
  })

  it('does not make known but unused events unknown', () => {
    // system/status, signature_delta, input_json_delta, message_start, and the like are
    // dropped. Making them unknown would add dozens of lines of noise per turn.
    const events = parseAll()
    expect(events.filter((event) => event.kind === 'unknown')).toHaveLength(0)
  })

  it("session_started carries the backend's session ID and version", () => {
    const event = parseAll().find((e) => e.kind === 'session_started')
    expect(event?.kind).toBe('session_started')
    if (event?.kind !== 'session_started') return
    expect(event.payload.backendSessionId).toBe('11111111-2222-3333-4444-555555555555')
    expect(event.payload.backendVersion).toBe('2.1.207')
    expect(event.payload.model).toBe('claude-sonnet-5')
    expect(event.payload.tools.length).toBeGreaterThan(0)
  })

  it('item 68: puts the list of commands usable non-interactively in session_started (no btw)', () => {
    const event = parseAll().find((e) => e.kind === 'session_started')
    if (event?.kind !== 'session_started') throw new Error('no init')
    const commands = event.payload.commands ?? []
    // The real thing from the fixture (CLI 2.1.207). No leading `/` is attached.
    expect(commands).toContain('compact')
    expect(commands).toContain('context')
    expect(commands).toContain('model')
    // Commands only for the interactive UI do not appear in the stream-json list (the TODO 68 investigation).
    expect(commands).not.toContain('btw')
    expect(commands.every((name) => !name.startsWith('/'))).toBe(true)
  })

  it('item 68: null for a version without the list field (= no judgment)', () => {
    counter = 0
    const [event] = parseEvent(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' }),
      ctx
    )
    if (event?.kind !== 'session_started') throw new Error('no init')
    expect(event.payload.commands).toBeNull()
    expect(event.payload.skills).toBeNull()
  })

  it('TODO 564: puts the skills of init in session_started (the same names are also in commands)', () => {
    const event = parseAll().find((e) => e.kind === 'session_started')
    if (event?.kind !== 'session_started') throw new Error('no init')
    const skills = event.payload.skills ?? []
    expect(skills).toContain('simplify')
    expect(skills).not.toContain('compact')
    expect(skills.every((name) => (event.payload.commands ?? []).includes(name))).toBe(true)
  })

  // Item 110: since `--strict-mcp-config` was dropped, the user's servers are listed in init's `mcp_servers`.
  // The gateway is told apart by name, and the state names are normalized to neutral vocabulary.
  it('item 110: carries mcp_servers with name, state and source and recognizes the gateway', () => {
    counter = 0
    const mcpCtx = {
      ...ctx,
      mcp: {
        serverName: 'aios',
        gatewaySource: 'dynamic',
        statusValues: { connected: 'connected', failed: 'failed', 'needs-auth': 'needs-auth' } as const
      }
    }
    const [event] = parseEvent(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        model: 'm',
        mcp_servers: [
          { name: 'aios', status: 'connected', source: 'dynamic' },
          { name: 'probe', status: 'connected', source: 'project' },
          { name: 'Gmail', status: 'needs-auth', source: 'claudeai' },
          { name: 'broken', status: 'failed' },
          { name: 'odd', status: 'something-new', source: 'user' },
          'legacy-string'
        ]
      }),
      mcpCtx
    )
    if (event?.kind !== 'session_started') throw new Error('no init')
    // In a context where the scope table (item 164) is not passed, everything is unknown.
    expect(event.payload.mcpServers).toEqual([
      { name: 'aios', state: 'connected', source: 'dynamic', gateway: true, scope: 'unknown' },
      { name: 'probe', state: 'connected', source: 'project', gateway: false, scope: 'unknown' },
      { name: 'Gmail', state: 'needs-auth', source: 'claudeai', gateway: false, scope: 'unknown' },
      { name: 'broken', state: 'failed', source: null, gateway: false, scope: 'unknown' },
      { name: 'odd', state: 'other', source: 'user', gateway: false, scope: 'unknown' },
      { name: 'legacy-string', state: 'other', source: null, gateway: false, scope: 'unknown' }
    ])
    expect(event.payload.gatewayConflict).toBe(false)
    // The list of names (which probe uses to see the gateway's connection) is unchanged.
    expect(event.payload.toolServers).toEqual(['aios', 'probe', 'Gmail', 'broken', 'odd', 'legacy-string'])
  })

  it("item 110: gatewayConflict when a server with the gateway's name comes from another source", () => {
    counter = 0
    const mcpCtx = { ...ctx, mcp: { serverName: 'aios', gatewaySource: 'dynamic', statusValues: {} } }
    const parse = (servers: unknown[]): boolean => {
      const [event] = parseEvent(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', mcp_servers: servers }),
        mcpCtx
      )
      if (event?.kind !== 'session_started') throw new Error('no init')
      return event.payload.gatewayConflict === true
    }
    expect(parse([{ name: 'aios', status: 'connected', source: 'user' }])).toBe(true)
    expect(
      parse([
        { name: 'aios', status: 'connected', source: 'dynamic' },
        { name: 'aios', status: 'failed', source: 'project' }
      ])
    ).toBe(true)
    expect(parse([{ name: 'aios', status: 'connected', source: 'dynamic' }])).toBe(false)
    // In a version without the source field (an old CLI), a conflict is not reported.
    expect(parse([{ name: 'aios', status: 'connected' }])).toBe(false)
    // If the way of telling them apart is not passed (tests and the like), the gateway counts as absent.
    const [plain] = parseEvent(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', mcp_servers: [{ name: 'aios', status: 'connected' }] }),
      ctx
    )
    if (plain?.kind !== 'session_started') throw new Error('no init')
    expect(plain.payload.mcpServers).toEqual([
      { name: 'aios', state: 'other', source: null, gateway: false, scope: 'unknown' }
    ])
  })

  // Item 164: the source (`source`) is sorted into global side / folder side. The table is the real compat (from the description of the zod in the 2.1.280 binary).
  it('item 164: folds the source of mcp_servers into global side / folder side / unknown (the real compat table)', () => {
    counter = 0
    const table = loadCompatTable()
    const mcpCtx = {
      ...ctx,
      mcp: {
        serverName: table.mcp.serverName,
        gatewaySource: table.mcp.gatewaySource ?? null,
        statusValues: table.mcp.statusValues ?? {},
        globalSources: table.mcp.globalSources ?? [],
        folderSources: table.mcp.folderSources ?? []
      }
    }
    const sources = ['claudeai', 'user', 'plugin', 'managed', 'enterprise', 'project', 'local', 'dynamic', 'sdk', 'agent', 'brand-new']
    const [event] = parseEvent(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        model: 'm',
        mcp_servers: [
          ...sources.map((source) => ({ name: `s-${source}`, status: 'connected', source })),
          { name: 'no-source', status: 'failed' },
          'legacy-string'
        ]
      }),
      mcpCtx
    )
    if (event?.kind !== 'session_started') throw new Error('no init')
    const scopes = Object.fromEntries((event.payload.mcpServers ?? []).map((s) => [s.name, s.scope]))
    expect(scopes).toEqual({
      's-claudeai': 'global',
      's-user': 'global',
      's-plugin': 'global',
      's-managed': 'global',
      's-enterprise': 'global',
      's-project': 'folder',
      's-local': 'folder',
      // The gateway's source, the SDK host, agent definitions (which can live in either user or project), and values not in the table are unknown.
      's-dynamic': 'unknown',
      's-sdk': 'unknown',
      's-agent': 'unknown',
      's-brand-new': 'unknown',
      // An old CLI with no source is also unknown (it leans to the heading side).
      'no-source': 'unknown',
      'legacy-string': 'unknown'
    })
    // The gateway's own row (dynamic) is also unknown in scope, but since `gateway: true`, it appears nowhere.
    expect(event.payload.gatewayConflict).toBe(false)
  })

  it('keeps the reported permission mode without using it for the supports judgment', () => {
    // spike 9a: even when `manual` is passed, init returns `default`.
    // The value is held only for display and is not used for feature judgments.
    const event = parseAll().find((e) => e.kind === 'session_started')
    if (event?.kind !== 'session_started') throw new Error('no init')
    expect(event.payload.reportedPermissionMode).toBe('default')
  })

  it('concatenated deltas match the finalized assistant message', () => {
    // As measured in spike 8. The Adapter only needs to accumulate the differences; no correction is needed.
    const events = parseAll()
    const joined = events
      .filter((e) => e.kind === 'assistant_delta')
      .map((e) => (e.kind === 'assistant_delta' ? e.payload.text : ''))
      .join('')
    const final = events.find((e) => e.kind === 'assistant_text')
    if (final?.kind !== 'assistant_text') throw new Error('no assistant_text')
    expect(joined).toBe(final.payload.text)
  })

  it('tool_use has the tool name and a summary of the main arguments', () => {
    const event = parseAll().find((e) => e.kind === 'tool_use')
    if (event?.kind !== 'tool_use') throw new Error('no tool_use')
    expect(event.payload.name).toBe('Read')
    expect(event.payload.toolUseId).toBe('toolu_01PVDzt1Az2iUXupCFUL4c6n')
    expect(event.payload.summary).toBe('/Users/tester/work/note.txt')
  })

  it('tool_result has only the length and success, and links by the same toolUseId', () => {
    const events = parseAll()
    const use = events.find((e) => e.kind === 'tool_use')
    const result = events.find((e) => e.kind === 'tool_result')
    if (use?.kind !== 'tool_use' || result?.kind !== 'tool_result') throw new Error('missing')
    expect(result.payload.toolUseId).toBe(use.payload.toolUseId)
    expect(result.payload.ok).toBe(true)
    expect(result.payload.bytes).toBeGreaterThan(0)
  })

  it('result does not treat num_turns as cumulative and has a container for the denial history', () => {
    const event = parseAll().find((e) => e.kind === 'result')
    if (event?.kind !== 'result') throw new Error('no result')
    expect(event.payload.ok).toBe(true)
    expect(event.payload.subtype).toBe('success')
    expect(event.payload.turns).toBe(2) // This turn's value. The running total is counted by SessionManager
    expect(event.payload.costUsd).toBeGreaterThan(0)
    expect(event.payload.denials).toEqual([])
    expect(event.payload.usage.cacheCreationTokens).toBeGreaterThan(0)
  })

  it('extracts rate_limit with the window kind', () => {
    const event = parseAll().find((e) => e.kind === 'rate_limit')
    if (event?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(event.payload.status).toBe('allowed')
    expect(event.payload.windowType).toBe('five_hour')
    expect(event.payload.resetsAt).toBeTypeOf('number')
  })
})

describe('parseEvent: unknown events (4.6)', () => {
  it('keeps an unknown type as is, as unknown', () => {
    const line = JSON.stringify({ type: 'brand_new_event', payload: { a: 1 } })
    const [event] = parseEvent(line, ctx)
    expect(event?.kind).toBe('unknown')
    if (event?.kind !== 'unknown') return
    // **Not dropped.** The line is kept as it is.
    expect(event.payload.raw).toBe(line)
    expect(event.payload.hint).toBe('brand_new_event')
  })

  it('also keeps an unknown stream delta as is', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'audio_delta', audio: 'x' } }
    })
    const [event] = parseEvent(line, ctx)
    expect(event?.kind).toBe('unknown')
    if (event?.kind !== 'unknown') return
    expect(event.payload.hint).toBe('delta/audio_delta')
    expect(event.payload.raw).toBe(line)
  })

  it('returns unknown without throwing even for a broken line', () => {
    const [event] = parseEvent('{not json', ctx)
    expect(event?.kind).toBe('unknown')
    if (event?.kind !== 'unknown') return
    expect(event.payload.hint).toBe('invalid-json')
  })

  it('a thinking delta with content becomes thinking_delta (not saved)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'なるほど' } }
    })
    const [event] = parseEvent(line, ctx)
    expect(event?.kind).toBe('thinking_delta')
  })

  it('drops an empty delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }
    })
    expect(parseEvent(line, ctx)).toHaveLength(0)
  })

  it('an empty line gives 0 events', () => {
    expect(parseEvent('   ', ctx)).toHaveLength(0)
  })
})

describe('parseEvent: subagents (4.6)', () => {
  it('marks a message with parent_tool_use_id as subagent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] }
    })
    const [event] = parseEvent(line, ctx)
    expect(event?.actor).toBe('subagent')
    expect(event?.parentToolUseId).toBe('toolu_parent')
  })

  it('main when there is no parent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'main' }] }
    })
    const [event] = parseEvent(line, ctx)
    expect(event?.actor).toBe('main')
    expect(event?.parentToolUseId).toBeUndefined()
  })
})

describe('parseEvent: argument truncation (4.3.1 / constraint 10)', () => {
  it('does not keep the body of huge arguments', () => {
    const big = 'x'.repeat(50_000)
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a.txt', content: big } }
        ]
      }
    })
    const [event] = parseEvent(line, ctx)
    if (event?.kind !== 'tool_use') throw new Error('no tool_use')
    expect(event.payload.truncated).toBe(true)
    const input = event.payload.input as Record<string, string | undefined>
    expect(input['content']?.length).toBeLessThan(MAX_ARG_CHARS + 60)
    expect(input['file_path']).toBe('/a.txt')
  })

  it('redaction is applied before cutting: the body of a PEM longer than 1,000 characters does not remain (TODO 844)', () => {
    const body = 'QUJDREVGRw'.repeat(300)
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/k.pem', content: pem } }]
      }
    })
    const [event] = parseEvent(line, ctx)
    if (event?.kind !== 'tool_use') throw new Error('no tool_use')
    expect(JSON.stringify(event.payload.input)).not.toContain('QUJDREVGRw')
  })

  it('the summary is also cut after redaction: a secret does not escape the rule at the 200-character cut (TODO 844)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const command = `echo ${'a'.repeat(185)} ${key}`
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] }
    })
    const [event] = parseEvent(line, ctx)
    if (event?.kind !== 'tool_use') throw new Error('no tool_use')
    expect(event.payload.summary).not.toContain('AKIAIOS')
  })

  it('the one-line progress report (progress.label) is also built from the input after redaction (TODO 1073)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'AKIAIOSFODNN7EXAMPLE usage' } }]
      }
    })
    const [event] = parseEvent(line, ctx)
    if (event?.kind !== 'tool_use') throw new Error('no tool_use')
    expect(event.payload.progress?.kind).toBe('search')
    expect(event.payload.progress?.label ?? '').not.toContain('AKIAIOS')
  })

  it('even for long input (a string of several MB, an array of 10,000 elements) the result has the same shape and a leading secret is masked (TODO 844)', () => {
    const content = `AKIAIOSFODNN7EXAMPLE ${'x'.repeat(3_000_000)}`
    const items = Array.from({ length: 10_000 }, (_, i) => `item-${i}`)
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a', content, items } }]
      }
    })
    const [event] = parseEvent(line, ctx)
    if (event?.kind !== 'tool_use') throw new Error('no tool_use')
    expect(event.payload.truncated).toBe(true)
    const input = event.payload.input as { content: string; items: string[]; file_path: string }
    expect(input.file_path).toBe('/a')
    expect(input.items).toHaveLength(50)
    expect(input.content.length).toBeLessThan(MAX_ARG_CHARS + 60)
    expect(input.content).not.toContain('AKIAIOS')
  })

  it('the summary prefers command strings and paths', () => {
    expect(summarizeToolInput({ command: 'ls -la', timeout: 1 })).toBe('ls -la')
    expect(summarizeToolInput({ file_path: '/tmp/a' })).toBe('/tmp/a')
    expect(summarizeToolInput({ url: 'https://example.test' })).toBe('https://example.test')
    expect(summarizeToolInput({})).toBe('')
  })

  it('item 321: description comes before prompt; tools with command / url / query are unchanged; ** drops only in prose', () => {
    expect(summarizeToolInput({ description: '束 A: 版情報', prompt: 'あなたは **束 A** を担当する', subagent_type: 'general-purpose' })).toBe('束 A: 版情報')
    expect(summarizeToolInput({ command: 'npm test', description: 'Run tests' })).toBe('npm test')
    expect(summarizeToolInput({ url: 'https://example.test', prompt: 'summarize' })).toBe('https://example.test')
    expect(summarizeToolInput({ query: 'q', description: 'd' })).toBe('q')
    expect(summarizeToolInput({ prompt: 'あなたは **束 A** を担当する' })).toBe('あなたは 束 A を担当する')
    expect(summarizeToolInput({ description: '**' , prompt: 'p' })).toBe('p')
    // The ** in paths, globs and commands is not dropped.
    expect(summarizeToolInput({ pattern: 'src/**/*.ts' })).toBe('src/**/*.ts')
    expect(summarizeToolInput({ command: 'ls **/a/**' })).toBe('ls **/a/**')
  })
})

describe('parseEvent: when one line becomes several events', () => {
  it('emits both when text and tool_use are in the same message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 's' },
          { type: 'text', text: '確認します' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }
        ]
      }
    })
    const events = parseEvent(line, ctx)
    expect(events.map((e) => e.kind)).toEqual(['assistant_text', 'tool_use'])
  })
})

/**
 * Item 93: notifications for work running in the background (`system/task_*`). `test/fixtures/subagents.jsonl` is **one real turn in which two subagents ran in parallel with haiku on CLI 2.1.280** (spike 19).
 * Only the values from the personal environment (paths, account, thinking signatures) are replaced; the initialize response has its contents emptied (its shape is in `initialize-response.json`).
 * Shapes that do not appear in the real capture (tool execution, stopping midway, internal chores, and the like) are kept as synthetic lines written from the binary's output schema.
 */
describe('parseEvent: work running in the background (item 93)', () => {
  const one = (value: Record<string, unknown>): AiosEvent[] => [
    ...parseEvent(JSON.stringify({ type: 'system', uuid: 'u1', session_id: 's1', ...value }), ctx)
  ]
  const subagentLines = readFileSync(join(fixtureDir, 'subagents.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  const parseSubagents = (): AiosEvent[] => {
    counter = 0
    return subagentLines.flatMap((line) => [...parseEvent(line, ctx)])
  }
  const AGENT_1 = 'toolu_01Gfe7iMozkfgreA8c88HX5E'
  const AGENT_2 = 'toolu_01RUK3sK2Ynya1aHz6v1ezJQ'

  it('real: the starts of 2 tasks have the description and kind but not the body of the instruction to the child (prompt)', () => {
    const events = parseSubagents()
    const starts = events.flatMap((e) => (e.kind === 'subtask_started' ? [e.payload] : []))
    expect(starts).toEqual([
      {
        taskId: 'a3a38f1eee28eb7ef',
        toolUseId: AGENT_1,
        description: 'Run echo 17',
        subagentType: 'general-purpose',
        isSubagent: true,
        isBackgroundShell: false,
        // TODO 1196: the real is_backgrounded (a background child).
        backgrounded: true
      },
      {
        taskId: 'a989556c3d2c0a82f',
        toolUseId: AGENT_2,
        description: 'Run echo 25',
        subagentType: 'general-purpose',
        isSubagent: true,
        isBackgroundShell: false,
        backgrounded: true
      }
    ])
    // The task_started line carries the prompt ("Run the bash command `echo 17` …"), but it does not appear in the work event.
    // **The same text is also in the arguments of the parent's `Agent` tool_use.** That one is handled like the arguments of any other tool (summary, truncation, redaction before saving), and is not stopped here.
    expect(subagentLines.some((line) => line.includes('Run the bash command'))).toBe(true)
    const subtaskEvents = events.filter((e) => e.kind.startsWith('subtask_'))
    expect(JSON.stringify(subtaskEvents)).not.toContain('Run the bash command')
  })

  it('item 321: the summary of the real parent `Agent` call is the title (description), not the instruction (prompt)', () => {
    const agentCalls = parseSubagents().flatMap((e) =>
      e.kind === 'tool_use' && (e.payload.toolUseId === AGENT_1 || e.payload.toolUseId === AGENT_2) && e.payload.summary !== ''
        ? [e.payload.summary]
        : []
    )
    expect(agentCalls).toEqual(['Run echo 17', 'Run echo 25'])
    // Other real tools (a child's Bash) are still command, as before.
    const bash = parseSubagents().flatMap((e) =>
      e.kind === 'tool_use' && e.actor === 'subagent' ? [e.payload.summary] : []
    )
    expect(bash.length).toBeGreaterThan(0)
    for (const summary of bash) expect(summary).toMatch(/^echo \d+$/)
  })

  it("real: the progress description is the child's current activity and does not overwrite the heading", () => {
    const progress = parseSubagents().flatMap((e) =>
      e.kind === 'subtask_progress' && e.payload.usage !== null ? [e.payload] : []
    )
    expect(progress[0]).toEqual({
      taskId: 'a3a38f1eee28eb7ef',
      toolUseId: AGENT_1,
      description: null,
      activity: 'Running echo 17',
      subagentType: 'general-purpose',
      status: null,
      usage: { totalTokens: 19_728, toolUses: 1, durationMs: 1_478 },
      lastToolName: 'Bash',
      summary: null
    })
    expect(progress).toHaveLength(2)
  })

  it('real: task_updated carries only the completion state and the end notification has the summary and usage', () => {
    const events = parseSubagents()
    const updates = events.flatMap((e) =>
      e.kind === 'subtask_progress' && e.payload.usage === null ? [e.payload] : []
    )
    expect(updates.map((u) => [u.taskId, u.status, u.description])).toEqual([
      ['a3a38f1eee28eb7ef', 'completed', null],
      ['a989556c3d2c0a82f', 'completed', null]
    ])
    const ends = events.flatMap((e) => (e.kind === 'subtask_finished' ? [e.payload] : []))
    expect(ends[0]).toEqual({
      taskId: 'a3a38f1eee28eb7ef',
      toolUseId: AGENT_1,
      status: 'completed',
      summary: '17',
      usage: { totalTokens: 20_579, toolUses: 1, durationMs: 2_611 },
      outputFile: expect.stringMatching(/\/tasks\/a3a38f1eee28eb7ef\.output$/)
    })
    expect(ends.map((e) => e.summary)).toEqual(['17', '25'])
  })

  it("real: a child's messages flow as subagent with parentToolUseId, and the parent stacks its own turn after the child ends", () => {
    const events = parseSubagents()
    const child = events.filter((e) => e.actor === 'subagent')
    expect(new Set(child.map((e) => e.parentToolUseId))).toEqual(new Set([AGENT_1, AGENT_2]))
    // The child's tool call (the key that ties it to the approval request's tool_use_id) and the child's last remark.
    expect(
      child.flatMap((e) => (e.kind === 'tool_use' ? [[e.parentToolUseId, e.payload.name]] : []))
    ).toEqual([
      [AGENT_1, 'Bash'],
      [AGENT_2, 'Bash']
    ])
    expect(
      child.flatMap((e) => (e.kind === 'assistant_text' ? [e.payload.text] : []))
    ).toEqual(['17', '25'])
    // Parent flow: the child's end comes after the parent's first result, and the parent adds a second result (with no user input).
    const main = events
      .filter((e) => e.actor === 'main')
      .map((e) => e.kind)
      .filter((k) => k === 'result' || k === 'subtask_finished')
    expect(main).toEqual(['result', 'subtask_finished', 'subtask_finished', 'result', 'result'])
    const texts = events.flatMap((e) => (e.kind === 'result' ? [e.payload.text] : []))
    expect(texts.at(-1)).toBe('42')
  })

  it('real: the full set of background work (background_tasks_changed) is background_tasks with only shell ids, and unknown only for the initialize response', () => {
    const events = parseSubagents()
    const unknown = events.flatMap((e) => (e.kind === 'unknown' ? [e.payload.hint] : []))
    // control_response is pulled out by LiveSession before parseEvent (it does not actually appear in the stream).
    expect(unknown).toEqual(['control_response'])
    // TODO 1196: the real set has only the children (local_agent), so the shell's id is empty all four times (the children go 1 → 2 → 1 → 0).
    // Children are not counted in the set (the foreground child is not included), only the start and end pairs.
    const sets = events.flatMap((e) => (e.kind === 'background_tasks' ? [e.payload.shellTaskIds] : []))
    expect(sets).toEqual([[], [], [], []])
    const [empty] = one({ subtype: 'background_tasks_changed', tasks: [] })
    expect(empty?.kind).toBe('background_tasks')
  })

  it('the same notification also arrives for tool execution (no subagent_type); marks it as not a child', () => {
    const [event] = one({
      subtype: 'task_started',
      task_id: 'b77',
      tool_use_id: 'toolu_bash_1',
      description: 'sleep 10',
      task_type: 'local_bash'
    })
    if (event?.kind !== 'subtask_started') throw new Error('kind')
    expect(event.payload.isSubagent).toBe(false)
    expect(event.payload.subagentType).toBeNull()
    // Item 105: if task_type is local_bash (a shell run with `run_in_background`), the mark is set.
    // Eviction (isEvictable) uses it to judge "counted with a time limit".
    expect(event.payload.isBackgroundShell).toBe(true)
  })

  it('item 105: tool execution whose task_type is not local_bash does not set the background shell mark', () => {
    const [event] = one({
      subtype: 'task_started',
      task_id: 'b78',
      tool_use_id: 'toolu_read_1',
      description: 'read a file',
      task_type: 'local_tool'
    })
    if (event?.kind !== 'subtask_started') throw new Error('kind')
    expect(event.payload.isSubagent).toBe(false)
    expect(event.payload.isBackgroundShell).toBe(false)
  })

  it('item 105: a child agent (with subagent_type) does not set the background shell mark', () => {
    const [event] = one({
      subtype: 'task_started',
      task_id: 'b79',
      tool_use_id: 'toolu_agent_1',
      description: 'Run echo 1',
      subagent_type: 'general-purpose',
      task_type: 'local_agent'
    })
    if (event?.kind !== 'subtask_started') throw new Error('kind')
    expect(event.payload.isSubagent).toBe(true)
    expect(event.payload.isBackgroundShell).toBe(false)
  })

  it('carries the state diff (task_updated) as progress and folds killed into stopped', () => {
    const [event] = one({
      subtype: 'task_updated',
      task_id: 'a1b2c3',
      patch: { status: 'killed', end_time: 1 }
    })
    if (event?.kind !== 'subtask_progress') throw new Error('kind')
    expect(event.payload.status).toBe('stopped')
    expect(event.payload.usage).toBeNull()
    // Differences with no change usable for display are not emitted.
    expect(one({ subtype: 'task_updated', task_id: 'a1b2c3', patch: { total_paused_ms: 5 } })).toEqual([])
  })

  it('the end usage may be omitted; an empty output_file / summary is null', () => {
    const [event] = one({
      subtype: 'task_notification',
      task_id: 'x',
      status: 'failed',
      output_file: '',
      summary: ''
    })
    if (event?.kind !== 'subtask_finished') throw new Error('kind')
    expect(event.payload.status).toBe('failed')
    expect(event.payload.usage).toBeNull()
    expect(event.payload.outputFile).toBeNull()
    expect(event.payload.summary).toBeNull()
  })

  it('drops the start and end of skip_transcript (internal chores)', () => {
    expect(
      one({ subtype: 'task_started', task_id: 'd', description: 'dream', skip_transcript: true })
    ).toEqual([])
    expect(
      one({
        subtype: 'task_notification',
        task_id: 'd',
        status: 'completed',
        output_file: '',
        summary: '',
        skip_transcript: true
      })
    ).toEqual([])
  })

  it('drops a line without task_id because it cannot be linked (does not keep it as unknown either, since the prompt is not saved)', () => {
    expect(one({ subtype: 'task_started', description: 'x', prompt: '指示' })).toEqual([])
  })

  it('drops session-wide progress without a task id (task_summary)', () => {
    expect(one({ subtype: 'task_summary', detail: 'Editing files' })).toEqual([])
  })

  it('truncates a long summary', () => {
    const [event] = one({
      subtype: 'task_notification',
      task_id: 'x',
      status: 'completed',
      output_file: '',
      summary: 'あ'.repeat(MAX_ARG_CHARS + 50)
    })
    if (event?.kind !== 'subtask_finished') throw new Error('kind')
    expect(event.payload.summary?.length).toBe(MAX_ARG_CHARS + 1)
  })
})

describe('parseEvent: message identifiers and echoes (item 113)', () => {
  it("real: the assistant body and tool calls have the line's uuid as messageId", () => {
    const events = parseAll()
    const texts = events.filter((e) => e.kind === 'assistant_text')
    const uses = events.filter((e) => e.kind === 'tool_use')
    expect(texts.length).toBeGreaterThan(0)
    for (const event of [...texts, ...uses]) {
      if (event.kind !== 'assistant_text' && event.kind !== 'tool_use') throw new Error('kind')
      expect(typeof event.payload.messageId).toBe('string')
      expect(event.payload.messageId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('an echoed user line (text + uuid) becomes user_replay and the body is not stacked as user_text', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] },
      session_id: 's',
      parent_tool_use_id: null,
      uuid: '1fcf82f3-4f15-429b-a0ca-540b29d0a46a',
      timestamp: '2026-09-27T00:00:00.000Z',
      isReplay: true
    })
    const events = [...parseEvent(line, ctx)]
    expect(events.map((e) => e.kind)).toEqual(['user_replay'])
    const [event] = events
    if (event?.kind !== 'user_replay') throw new Error('kind')
    expect(event.payload).toEqual({
      messageId: '1fcf82f3-4f15-429b-a0ca-540b29d0a46a',
      text: 'Reply only OK.'
    })
    expect(event.actor).toBe('main')
  })

  it('an echo with images takes only the text blocks as the body', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'これは何' }
        ]
      },
      uuid: 'u-1'
    })
    const [event] = [...parseEvent(line, ctx)]
    if (event?.kind !== 'user_replay') throw new Error('kind')
    expect(event.payload.text).toBe('これは何')
  })

  it('a user line with tool_result stays tool_result as before and is not made an echo even with a uuid', () => {
    const events = parseAll().filter((e) => e.kind === 'user_replay')
    expect(events).toEqual([])
    expect(parseAll().filter((e) => e.kind === 'tool_result')).toHaveLength(1)
  })

  it('an instruction to a child agent (with parent_tool_use_id) and a user line without uuid are not made echoes', () => {
    const child = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '子への指示' }] },
      parent_tool_use_id: 'toolu_parent',
      uuid: 'u-child'
    })
    expect([...parseEvent(child, ctx)]).toEqual([])
    const bare = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'x' }] }
    })
    expect([...parseEvent(bare, ctx)]).toEqual([])
  })
})

// ---- wave 13 bundle E: the hooks events of the settings (item 126-3), and the replacement of the command list (the rest of item 117) ----
//
// **There is no real fixture** (spike 25 only recorded the shape). The lines are **synthetic**, built from the list of keys recorded in spike 25's RESULTS
// (`hook_id` / `hook_name` "SessionStart:startup" / `hook_event` / `output` / `stdout` / `stderr` / `exit_code` / `outcome` / `uuid` / `session_id`) and from the zod schema of the CLI 2.1.280 binary.

const hookLine = (subtype: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'system',
    subtype,
    hook_id: 'hook-1',
    hook_name: 'SessionStart:startup',
    hook_event: 'SessionStart',
    uuid: '00000000-0000-4000-8000-00000000abcd',
    session_id: '00000000-0000-4000-8000-000000000001',
    ...extra
  })

const SECRET_OUTPUT = 'HOOK-SECRET-OUTPUT sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

describe('parseEvent: hooks of the settings (item 126-3, synthesized lines)', () => {
  it('hook_response is 1 hook_run with only the name, event, outcome and exit code; the output is not included', () => {
    const events = parseEvent(
      hookLine('hook_response', {
        output: SECRET_OUTPUT,
        stdout: SECRET_OUTPUT,
        stderr: SECRET_OUTPUT,
        exit_code: 0,
        outcome: 'success'
      }),
      ctx
    )
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event?.kind).toBe('hook_run')
    if (event?.kind !== 'hook_run') return
    expect(event.actor).toBe('main')
    expect(event.payload).toEqual({
      hookId: 'hook-1',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      outcome: 'success',
      exitCode: 0
    })
    // No output remains anywhere in the event (it is not kept even while alive).
    expect(JSON.stringify(event)).not.toContain('HOOK-SECRET-OUTPUT')
  })

  it('drops hook_started and hook_progress (output while running), without making them unknown either', () => {
    expect(parseEvent(hookLine('hook_started'), ctx)).toEqual([])
    expect(
      parseEvent(hookLine('hook_progress', { stdout: SECRET_OUTPUT, stderr: '', output: SECRET_OUTPUT }), ctx)
    ).toEqual([])
  })

  it('failures, cancellations and outcomes not in the table; exit_code is optional (null when missing) and null if not an integer', () => {
    const run = (extra: Record<string, unknown>): AiosEvent | undefined =>
      parseEvent(hookLine('hook_response', { output: '', stdout: '', stderr: '', ...extra }), ctx)[0]
    const failed = run({ outcome: 'error', exit_code: 2 })
    expect(failed?.kind === 'hook_run' && failed.payload).toMatchObject({ outcome: 'error', exitCode: 2 })
    const cancelled = run({ outcome: 'cancelled' })
    expect(cancelled?.kind === 'hook_run' && cancelled.payload).toMatchObject({ outcome: 'cancelled', exitCode: null })
    const odd = run({ outcome: 'blocked', exit_code: 1.5 })
    expect(odd?.kind === 'hook_run' && odd.payload).toMatchObject({ outcome: 'other', exitCode: null })
    const none = run({})
    expect(none?.kind === 'hook_run' && none.payload.outcome).toBe('other')
  })

  it('uses the event name when there is no name, and ? when neither exists; cuts long names', () => {
    const noName = parseEvent(
      JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event: 'Setup', outcome: 'success' }),
      ctx
    )[0]
    expect(noName?.kind === 'hook_run' && noName.payload).toMatchObject({
      hookName: 'Setup',
      hookEvent: 'Setup',
      hookId: null
    })
    const bare = parseEvent(JSON.stringify({ type: 'system', subtype: 'hook_response' }), ctx)[0]
    expect(bare?.kind === 'hook_run' && bare.payload.hookName).toBe('?')
    const long = parseEvent(hookLine('hook_response', { hook_name: 'x'.repeat(5000), outcome: 'success' }), ctx)[0]
    expect(long?.kind === 'hook_run' && long.payload.hookName.length).toBeLessThan(300)
  })
})

describe('parseEvent: replacing the command list (the rest of item 117, synthesized lines)', () => {
  const changedLine = (commands: unknown): string =>
    JSON.stringify({
      type: 'system',
      subtype: 'commands_changed',
      commands,
      uuid: '00000000-0000-4000-8000-00000000abce',
      session_id: '00000000-0000-4000-8000-000000000001'
    })

  it('takes only the element names, fixes them with the table (item 117) and makes commands_changed; does not read descriptions', () => {
    const [event] = parseEvent(
      changedLine([
        { name: 'compact', description: 'Compact the conversation', argumentHint: '', builtin: true },
        { name: 'my-skill', description: 'SECRET-DESCRIPTION', argumentHint: '<file>', aliases: ['ms'] },
        { name: 'status', description: 'x', argumentHint: '' }
      ]),
      ctx
    )
    expect(event?.kind).toBe('commands_changed')
    if (event?.kind !== 'commands_changed') return
    // `status` does not work (dropped); `cost` works even if it is not in the list (added). See builtinCommands in compat/.
    expect(event.payload.commands).toEqual(['compact', 'my-skill', 'cost'])
    expect(JSON.stringify(event)).not.toContain('SECRET-DESCRIPTION')
  })

  it('emits nothing when no name can be taken (empty, no field, wrong shape): trusting an empty list would stop everything', () => {
    expect(parseEvent(changedLine([]), ctx)).toEqual([])
    expect(parseEvent(changedLine('compact'), ctx)).toEqual([])
    expect(parseEvent(changedLine([{ description: 'no name' }, 3, null]), ctx)).toEqual([])
  })
})

/**
 * Item 259 (wave 15 bundle G): the progress of running tools (`tool_progress`). `test/fixtures/tool-progress.jsonl` is two real lines (CLI 2.1.280) that stayed as `unknown` in a duplicate DB of the real userData; only the ids and the session id were replaced.
 * **`parent_tool_use_id` is not a mark for a child; it is the call whose progress was reported** (the parent's Bash).
 */
describe('parseEvent: tool progress (item 259)', () => {
  const progressLines = readFileSync(join(fixtureDir, 'tool-progress.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  const TOOL = 'toolu_01AbCdEfGhIjKlMnOpQrStUv'

  it('the type names are in streamEvents of compat/', () => {
    expect(loadCompatTable().streamEvents?.toolProgress).toBe('tool_progress')
  })

  it('the 2 real heartbeat lines become tool_progress and not 「未知のイベント」', () => {
    counter = 0
    const events = progressLines.flatMap((line) => [...parseEvent(line, ctx)])
    expect(events.map((e) => e.kind)).toEqual(['tool_progress', 'tool_progress'])
    expect(events.map((e) => (e.kind === 'tool_progress' ? e.payload : null))).toEqual([
      { toolUseId: TOOL, toolName: 'Bash', elapsedSeconds: 300, heartbeat: true },
      { toolUseId: TOOL, toolName: 'Bash', elapsedSeconds: 330, heartbeat: true }
    ])
  })

  it("the envelope stays the parent's (does not copy parent_tool_use_id as the child mark: that would fold it under the Bash row)", () => {
    counter = 0
    const [event] = parseEvent(progressLines[0]!, ctx)
    expect(event?.actor).toBe('main')
    expect(event?.parentToolUseId).toBeUndefined()
  })

  it('also reads shell progress (no heartbeat, the form for remote execution); tool_use_id when there is no parent', () => {
    const shell = JSON.stringify({
      type: 'tool_progress',
      tool_use_id: 'bash-progress-3',
      tool_name: 'Bash',
      parent_tool_use_id: 'toolu_parent',
      elapsed_time_seconds: 12.7,
      task_id: 'b1',
      session_id: 's',
      uuid: 'u'
    })
    const [event] = parseEvent(shell, ctx)
    expect(event?.kind === 'tool_progress' && event.payload).toEqual({
      toolUseId: 'toolu_parent',
      toolName: 'Bash',
      elapsedSeconds: 12,
      heartbeat: false
    })
    const orphan = JSON.stringify({
      type: 'tool_progress',
      tool_use_id: 'toolu_x',
      tool_name: 'WebFetch',
      parent_tool_use_id: null,
      elapsed_time_seconds: 30,
      heartbeat: true
    })
    const [second] = parseEvent(orphan, ctx)
    expect(second?.kind === 'tool_progress' && second.payload.toolUseId).toBe('toolu_x')
  })

  it('drops lines that are not progress (calls inside the REPL, API retries of a child)', () => {
    const repl = {
      type: 'tool_progress',
      tool_use_id: 'r',
      tool_name: 'REPL',
      parent_tool_use_id: 'p',
      elapsed_time_seconds: 0,
      repl_call: { inner_tool_name: 'Read', inner_tool_input: { file_path: '/x' }, inner_tool_use_id: 'i', phase: 'start' }
    }
    const retry = {
      type: 'tool_progress',
      tool_use_id: 'agent_msg',
      tool_name: 'Agent',
      parent_tool_use_id: 'p',
      elapsed_time_seconds: 0,
      subagent_type: 'general-purpose',
      subagent_retry: {
        agent_id: 'a',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: null,
        error_category: 'unknown'
      }
    }
    const resolved = {
      type: 'tool_progress',
      tool_use_id: 'agent_msg',
      tool_name: 'Agent',
      parent_tool_use_id: 'p',
      elapsed_time_seconds: 0,
      subagent_type: 'general-purpose'
    }
    for (const row of [repl, retry, resolved]) expect(parseEvent(JSON.stringify(row), ctx)).toEqual([])
  })

  it('keeps a malformed line as unknown instead of dropping it (4.6)', () => {
    const broken = JSON.stringify({ type: 'tool_progress', tool_use_id: 'x', tool_name: 'Bash', parent_tool_use_id: 'p' })
    const [event] = parseEvent(broken, ctx)
    expect(event?.kind).toBe('unknown')
    expect(event?.kind === 'unknown' && event.payload.hint).toBe('tool_progress')
    expect(event?.actor).toBe('main')
  })
})

describe('parseEvent: usage limit windows (item 317, wave 17 bundle B)', () => {
  const rateLimits = (file: string): AiosEvent[] =>
    readFileSync(join(fixtureDir, file), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"rate_limit_event"'))
      .flatMap((line) => [...parseEvent(line, ctx)])

  it('picks up unifiedWindows of the real 2.1.280 output (builtins.jsonl) as the 5-hour / 7-day ratios and reset times', () => {
    const events = rateLimits('builtins.jsonl')
    expect(events).toHaveLength(3)
    const first = events[0]
    if (first?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(first.payload.windows).toEqual({
      fiveHour: { utilization: 0.23, resetsAt: 1790446800 },
      sevenDay: { utilization: 0.21, resetsAt: 1790798400 }
    })
    expect(first.payload.status).toBe('allowed')
    expect(first.payload.usingOverage).toBe(false)
    // The subagent fixture has the same shape (the 0.13 / 0.07 that TODO 317 pulled).
    const sub = rateLimits('subagents.jsonl')[0]
    if (sub?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(sub.payload.windows?.fiveHour?.utilization).toBe(0.13)
    expect(sub.payload.windows?.sevenDay?.utilization).toBe(0.07)
  })

  it('picks up seven_day_overage_included, the third key in the 2.1.310 Fable turn, as sevenDayFable (TODO 1000)', () => {
    const events = rateLimits('rate-limit-fable-2.1.310.jsonl')
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(event.payload.windows).toEqual({
      fiveHour: { utilization: 0.3, resetsAt: 1792914000 },
      sevenDay: { utilization: 0.19, resetsAt: 1793217600 },
      sevenDayFable: { utilization: 0.07, resetsAt: 1793217600 }
    })
    // On a line with no third key (a Sonnet turn, 2.1.280), the field is absent altogether.
    const old = rateLimits('builtins.jsonl')[0]
    if (old?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(old.payload.windows).not.toHaveProperty('sevenDayFable')
  })

  it('omits windows for an old version without unifiedWindows (stream-session.jsonl of 2.1.207)', () => {
    const event = rateLimits('stream-session.jsonl')[0]
    if (event?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(event.payload.windows).toBeUndefined()
    expect('windows' in event.payload).toBe(false)
  })

  it('with only one window or a broken value, keeps only the windows that could be read (omitted if neither can be read)', () => {
    const names = loadCompatTable().usageWindows
    if (names === undefined) throw new Error('compat に usageWindows が無い')
    const line = (group: unknown): string =>
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', isUsingOverage: true, [names.field]: group }
      })
    const [one] = parseEvent(line({ [names.sevenDay]: { [names.utilization]: 0.5 } }), ctx)
    if (one?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(one.payload.windows).toEqual({ sevenDay: { utilization: 0.5, resetsAt: null } })
    expect(one.payload.usingOverage).toBe(true)
    const [broken] = parseEvent(line({ [names.fiveHour]: { [names.utilization]: 'x' } }), ctx)
    if (broken?.kind !== 'rate_limit') throw new Error('no rate_limit')
    expect(broken.payload.windows).toBeUndefined()
  })
})

describe('parseEvent: prompt cache lifetime (TODO 466, wave 23 bundle D)', () => {
  const results = (file: string): AiosEvent[] =>
    readFileSync(join(fixtureDir, file), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"type":"result"'))
      .flatMap((line) => [...parseEvent(line, ctx)])
      .filter((event) => event.kind === 'result')

  it('reads 1 hour from the real CLI output (written to the 1-hour tier)', () => {
    for (const file of ['stream-session.jsonl', 'subagents.jsonl']) {
      const events = results(file)
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        if (event.kind !== 'result') throw new Error('no result')
        expect(event.payload.cacheTtlMs).toBe(3_600_000)
      }
    }
  })

  it('omits it for a turn that wrote nothing (built-in commands, both 0); the carry-over is on the display side', () => {
    // builtins.jsonl has 10 turns: turns in which the API was called (turns > 0) are written to the 1-hour tier, and turns of built-in commands (`/context` and the like, turns = 0) have both at 0.
    const events = results('builtins.jsonl')
    expect(events).toHaveLength(10)
    let skipped = 0
    for (const event of events) {
      if (event.kind !== 'result') throw new Error('no result')
      if (event.payload.turns === 0) {
        skipped += 1
        expect('cacheTtlMs' in event.payload).toBe(false)
      } else {
        expect(event.payload.cacheTtlMs).toBe(3_600_000)
      }
    }
    expect(skipped).toBeGreaterThan(0)
    expect(skipped).toBeLessThan(events.length)
  })

  it('5 minutes when written only to the 5-minute tier, omitted when the field is missing', () => {
    const names = loadCompatTable().cacheLifetimes
    if (names === undefined) throw new Error('compat に cacheLifetimes が無い')
    const short = names.tiers.find((tier) => tier.ms === 300_000)
    if (short === undefined) throw new Error('5 分の段が無い')
    const zeros = Object.fromEntries(names.tiers.map((tier) => [tier.key, 0]))
    const make = (usage: Record<string, unknown>): string =>
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, usage })
    const [five] = parseEvent(make({ [names.field]: { ...zeros, [short.key]: 12 } }), ctx)
    if (five?.kind !== 'result') throw new Error('no result')
    expect(five.payload.cacheTtlMs).toBe(300_000)
    const [none] = parseEvent(make({ input_tokens: 1 }), ctx)
    if (none?.kind !== 'result') throw new Error('no result')
    expect(none.payload.cacheTtlMs).toBeUndefined()
  })
})
