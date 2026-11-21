/**
 * The mapping from OpenCode's SSE to `AiosEvent` (TODO 529 / 874). The fixture is one real run captured in spike 34
 * (`test/fixtures/opencode-events.jsonl`, only the paths replaced). The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenCodeEventMapper, summarizeToolInput, type ServerEvent } from '../src/main/session/adapter-opencode/events.js'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'
import { mcpServersOf, mcpToolNameOf } from '../src/main/session/adapter-opencode/mcp.js'
import type { AiosEvent } from '../src/shared/agent.js'

const table = loadOpenCodeTable()
const fixture: ServerEvent[] = readFileSync(join(__dirname, 'fixtures/opencode-events.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => (JSON.parse(line) as { ev: ServerEvent }).ev)

const SESSION_A = 'ses_e8bfe1efdffeOE326GAiJKhYIr' // bash `ls` + permission, then the model is switched (SWITCHED)
const SESSION_B = 'ses_e8bfe0df6ffejnMpqhBIv9jUxj' // An MCP tool (aios.ping called from inside execute)
const SESSION_D = 'ses_e8bfdfb4fffeoE0rZiau7liGIl' // interrupt → AFTER
const SESSION_E = 'ses_e8bfde87fffe0xSAUy0G6SFlrv' // The local model does not exist (404 from the provider)

function run(backendSessionId: string): { events: AiosEvent[]; asks: NonNullable<ReturnType<OpenCodeEventMapper['map']>['ask']>[] } {
  let seq = 0
  let now = 1_000
  const mapper = new OpenCodeEventMapper(table, {
    sessionId: 's1',
    threadId: 't1',
    backendSessionId,
    now: () => (now += 1),
    newId: () => `s1:${(seq += 1)}`
  })
  const events: AiosEvent[] = []
  const asks: NonNullable<ReturnType<OpenCodeEventMapper['map']>['ask']>[] = []
  for (const ev of fixture) {
    const mapped = mapper.map(ev)
    events.push(...mapped.events)
    if (mapped.ask !== null) asks.push(mapped.ask)
  }
  return { events, asks }
}

describe('OpenCode SSE to AiosEvent (fixture)', () => {
  it('(a) shell tool, permission request, result and model switch on the second turn', () => {
    const { events, asks } = run(SESSION_A)
    const kinds = events.map((e) => e.kind)
    expect(kinds.filter((k) => k === 'result')).toHaveLength(2)

    const toolUse = events.find((e) => e.kind === 'tool_use')
    // TODO 1020: the tool names in the timeline are also aligned with the approval box table (`shell` → `Bash`).
    expect(toolUse?.kind === 'tool_use' && toolUse.payload.name).toBe('Bash')
    expect(toolUse?.kind === 'tool_use' && toolUse.payload.summary).toBe('ls')
    expect(toolUse?.kind === 'tool_use' && toolUse.payload.input).toEqual({ command: 'ls' })

    expect(asks).toHaveLength(1)
    expect(asks[0]?.action).toBe('shell')
    expect(asks[0]?.resources).toEqual(['ls'])
    // The arguments of the original tool call of the request become the material (not resources).
    expect(asks[0]?.toolUseId).toBe(toolUse?.kind === 'tool_use' ? toolUse.payload.toolUseId : null)
    expect(asks[0]?.input).toEqual({ command: 'ls' })

    const toolResult = events.find((e) => e.kind === 'tool_result')
    expect(toolResult?.kind === 'tool_result' && toolResult.payload.ok).toBe(true)
    expect(toolResult?.kind === 'tool_result' && toolResult.payload.text).toBe('hello.txt\nnotes.md\n')

    // Usage for each step (the first turn has 2 steps).
    const usages = events.filter((e) => e.kind === 'turn_usage')
    expect(usages.length).toBeGreaterThanOrEqual(3)
    expect(usages[0]?.kind === 'turn_usage' && usages[0].payload.model).toBe('opencode/big-pickle')
    expect(usages[0]?.kind === 'turn_usage' && usages[0].payload.cacheReadTokens).toBe(4096)

    const results = events.filter((e) => e.kind === 'result')
    expect(results[0]?.kind === 'result' && results[0].payload.ok).toBe(true)
    expect(results[0]?.kind === 'result' && results[0].payload.text).toBe('2')
    expect(results[0]?.kind === 'result' && results[0].payload.usage.inputTokens).toBe(3619 + 205)
    expect(results[0]?.kind === 'result' && results[0].payload.interrupted).toBeUndefined()
    // The second turn answered with the switched model.
    expect(results[1]?.kind === 'result' && results[1].payload.text).toBe('SWITCHED')
    const lastUsage = usages.at(-1)
    expect(lastUsage?.kind === 'turn_usage' && lastUsage.payload.model).toBe('opencode/glm-5.3-flash-free')

    // The text goes delta → ended. Thinking also streams.
    expect(kinds).toContain('thinking_delta')
    expect(kinds).toContain('assistant_delta')
    const texts = events.filter((e) => e.kind === 'assistant_text')
    expect(texts.map((e) => (e.kind === 'assistant_text' ? e.payload.text : ''))).toEqual(['2', 'SWITCHED'])
  })

  it('(b) an MCP tool is called from inside execute and the result body is mirrored to tool_result', () => {
    const { events, asks } = run(SESSION_B)
    expect(asks).toHaveLength(0)
    const toolUse = events.find((e) => e.kind === 'tool_use')
    expect(toolUse?.kind === 'tool_use' && toolUse.payload.name).toBe('execute')
    expect(toolUse?.kind === 'tool_use' && toolUse.payload.summary).toBe('const r = await tools.aios.ping({ n: 7 });')
    const toolResult = events.find((e) => e.kind === 'tool_result')
    expect(toolResult?.kind === 'tool_result' && toolResult.payload.text).toBe('{\n  "pong": 7\n}')
    const result = events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.text).toBe('{"pong":7}')
  })

  it('(d) an interrupt gives an interrupted result (not an error) and the next turn continues', () => {
    const { events } = run(SESSION_D)
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)
    const results = events.filter((e) => e.kind === 'result')
    expect(results).toHaveLength(2)
    expect(results[0]?.kind === 'result' && results[0].payload.ok).toBe(false)
    expect(results[0]?.kind === 'result' && results[0].payload.subtype).toBe('interrupted')
    expect(results[0]?.kind === 'result' && results[0].payload.interrupted).toBe(true)
    expect(results[1]?.kind === 'result' && results[1].payload.ok).toBe(true)
    expect(results[1]?.kind === 'result' && results[1].payload.text).toBe('AFTER')
  })

  it('(e) a provider failure is an error plus a failed result', () => {
    const { events } = run(SESSION_E)
    const error = events.find((e) => e.kind === 'error')
    expect(error?.kind === 'error' && error.payload.message).toContain('not found')
    expect(error?.kind === 'error' && error.payload.code).toBe('provider.invalid-request')
    const result = events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.ok).toBe(false)
    expect(result?.kind === 'result' && result.payload.subtype).toBe('error')
  })

  it('a tool failure (session.tool.failed, wrong arguments from gpt-oss) is a tool_result with ok=false and the sentence is error.message', () => {
    let seq = 0
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_x',
      now: () => 1,
      newId: () => `s1:${(seq += 1)}`
    })
    mapper.map({ type: table.events.toolInputStarted, data: { sessionID: 'ses_x', id: 'call_1', name: 'execute' } })
    mapper.map({ type: table.events.toolCalled, data: { sessionID: 'ses_x', id: 'call_1', input: { cmd: ['bash', '-lc', 'ls'] } } })
    const failed = mapper.map({
      type: table.events.toolError,
      data: { sessionID: 'ses_x', id: 'call_1', error: { type: 'tool.execution', message: 'Invalid arguments for tool "execute":\n- code: Missing key' }, executed: false }
    })
    expect(failed.events).toHaveLength(1)
    const ev = failed.events[0]
    expect(ev?.kind === 'tool_result' && ev.payload.ok).toBe(false)
    expect(ev?.kind === 'tool_result' && ev.payload.text).toContain('Missing key')
    expect(table.events.toolError).toBe('session.tool.failed')
  })

  it('drops events of other sessions and notices that belong to no session', () => {
    const { events, asks } = run('ses_nobody')
    expect(events).toHaveLength(0)
    expect(asks).toHaveLength(0)
  })

  it('summarizeToolInput picks the command / path / first line of code', () => {
    expect(summarizeToolInput('shell', { command: 'git status' })).toBe('git status')
    expect(summarizeToolInput('edit', { filePath: '/a/b.ts', oldString: 'x' })).toBe('/a/b.ts')
    expect(summarizeToolInput('execute', { code: '\n// c\nreturn 1' })).toBe('// c')
    expect(summarizeToolInput('todowrite', { todos: [] })).toBe('todowrite')
    expect(summarizeToolInput('shell', { command: 'x'.repeat(300) })).toHaveLength(201)
  })
})

/**
 * TODO 1023: the end of the turn after a rejection. The fixtures are real captures of spike 34's (r) with OpenCode 2.1.4 + gpt-oss:20b
 * (`test/fixtures/opencode-reject.jsonl`, only the paths replaced): two sessions, a reject without a message and a reject with one.
 */
describe('after an OpenCode denial (fixture, TODO 1023)', () => {
  const rejectFixture: ServerEvent[] = readFileSync(join(__dirname, 'fixtures/opencode-reject.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { ev: ServerEvent }).ev)
  const BARE = 'ses_e6e44e0f4ffem56vQ8VWa7FJRe' // A reject without a message → the turn stops with DeclinedError
  const WITH_MESSAGE = 'ses_e6e44d03dffeqAQZxQ93tM7CL6' // A reject with a message → the turn continues and answers "OK."

  function runReject(backendSessionId: string, interruptFirst = false): AiosEvent[] {
    let seq = 0
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId,
      now: () => 1,
      newId: () => `s1:${(seq += 1)}`
    })
    const events: AiosEvent[] = []
    for (const ev of rejectFixture) {
      if (interruptFirst && ev.type === table.events.permissionReplied) mapper.markInterrupt()
      events.push(...mapper.map(ev).events)
    }
    return events
  }

  it('without message: no error row appears and the result is 「中断」 with 1 denial', () => {
    const events = runReject(BARE)
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    const toolResult = events.find((e) => e.kind === 'tool_result')
    expect(toolResult?.kind === 'tool_result' && toolResult.payload.ok).toBe(false)
    expect(toolResult?.kind === 'tool_result' && toolResult.payload.text).toBe('The user declined this tool call')
    const results = events.filter((e) => e.kind === 'result')
    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result?.kind === 'result' && result.payload.subtype).toBe('interrupted')
    expect(result?.kind === 'result' && result.payload.interrupted).toBe(true)
    expect(result?.kind === 'result' && result.payload.denials).toEqual([{ toolName: 'Edit', toolUseId: 'call_h4lwhi4f' }])
  })

  it("with message: the tool failure's sentence is the message, the turn continues and succeeds, with 1 denial", () => {
    const events = runReject(WITH_MESSAGE)
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    const toolResult = events.find((e) => e.kind === 'tool_result')
    expect(toolResult?.kind === 'tool_result' && toolResult.payload.text).toBe('Do not create files; just reply OK.')
    const result = events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.ok).toBe(true)
    expect(result?.kind === 'result' && result.payload.text).toBe('OK.')
    expect(result?.kind === 'result' && result.payload.denials).toEqual([{ toolName: 'Edit', toolUseId: 'call_tumm61kp' }])
  })

  it('TODO 1024: a request for an MCP tool uses metadata.input as the arguments (not the execute code) and gets the mcp mark', () => {
    let seq = 0
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_m',
      now: () => 1,
      newId: () => `s1:${(seq += 1)}`
    })
    mapper.map({ type: table.events.toolInputStarted, data: { sessionID: 'ses_m', id: 'call_71', name: 'execute' } })
    mapper.map({ type: table.events.toolCalled, data: { sessionID: 'ses_m', id: 'call_71', input: { code: 'return await tools.aios.ping({ n: 7 })' } } })
    // The real capture from spike 34's (b) (OpenCode 2.1.4 + gpt-oss:20b, the rules' `*: ask`, 2026-10-31).
    const asked = mapper.map({
      type: table.events.permissionAsked,
      data: {
        id: 'per_191bfe665001dNsvbKt2dvm6Jq',
        sessionID: 'ses_m',
        action: 'aios_ping',
        resources: ['*'],
        save: ['*'],
        metadata: { input: { n: 7 } },
        source: { type: 'tool', messageID: 'msg_191bf8690001LVHJsi23DA44gY', id: 'call_71' }
      }
    })
    expect(asked.ask).toMatchObject({ action: 'aios_ping', mcp: true, input: { n: 7 }, toolUseId: 'call_71' })
    // A built-in tool is not mcp.
    const edit = mapper.map({ type: table.events.permissionAsked, data: { id: 'per_2', sessionID: 'ses_m', action: 'edit', resources: ['a'], metadata: { files: [] } } })
    expect(edit.ask?.mcp).toBe(false)
    // The name of the rejection is also split without the server list (at the first delimiter).
    mapper.map({ type: table.events.permissionReplied, data: { sessionID: 'ses_m', requestID: 'per_191bfe665001dNsvbKt2dvm6Jq', reply: 'reject' } })
    const end = mapper.map({ type: table.events.executionEnded[0] ?? '', data: { sessionID: 'ses_m' } })
    const result = end.events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.denials).toEqual([{ toolName: 'mcp__aios__ping', toolUseId: 'call_71' }])
  })

  it("review: the denial's name is replaced with the name the session passed to the approval inbox (split by the server list)", () => {
    let seq = 0
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_m',
      now: () => 1,
      newId: () => `s1:${(seq += 1)}`
    })
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_m' } })
    mapper.map({ type: table.events.permissionAsked, data: { id: 'per_x', sessionID: 'ses_m', action: 'my_server_search', resources: ['*'], metadata: { input: {} }, source: { id: 'call_9' } } })
    mapper.resolveAskedToolName('per_x', 'mcp__my_server__search')
    // A request that does not exist does nothing.
    mapper.resolveAskedToolName('per_none', 'mcp__x__y')
    mapper.map({ type: table.events.permissionReplied, data: { sessionID: 'ses_m', requestID: 'per_x', reply: 'reject' } })
    const end = mapper.map({ type: table.events.executionEnded[0] ?? '', data: { sessionID: 'ses_m' } })
    const result = end.events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.denials).toEqual([{ toolName: 'mcp__my_server__search', toolUseId: 'call_9' }])
  })

  it('review: requests that get no reply are forgotten at the end of the turn and on interrupt (a later reject is not counted for the next turn)', () => {
    let seq = 0
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_m',
      now: () => 1,
      newId: () => `s1:${(seq += 1)}`
    })
    const ask = (id: string): void => {
      mapper.map({ type: table.events.permissionAsked, data: { id, sessionID: 'ses_m', action: 'edit', resources: ['a'], metadata: { files: [] }, source: { id: `call_${id}` } } })
    }
    const reject = (id: string): void => {
      mapper.map({ type: table.events.permissionReplied, data: { sessionID: 'ses_m', requestID: id, reply: 'reject' } })
    }
    const denialsOfEnd = (): unknown => {
      const end = mapper.map({ type: table.events.executionEnded[0] ?? '', data: { sessionID: 'ses_m' } })
      const result = end.events.find((e) => e.kind === 'result')
      return result?.kind === 'result' ? result.payload.denials : undefined
    }
    // Turn 1: ends without a reply arriving.
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_m' } })
    ask('per_a')
    expect(denialsOfEnd()).toEqual([])
    // Turn 2: a late reject for the previous turn's request is not counted.
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_m' } })
    reject('per_a')
    // A reject that arrives after the interrupt (once interruptPending is down) is not counted either.
    ask('per_b')
    mapper.markInterrupt()
    expect(denialsOfEnd()).toEqual([])
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_m' } })
    reject('per_b')
    expect(denialsOfEnd()).toEqual([])
  })

  it('TODO 1024: mcpToolNameOf splits by the longest match in the server list, and by the first separator when there is none', () => {
    expect(mcpToolNameOf(table, 'slack_work_send_message', ['slack', 'slack.work'])).toBe('mcp__slack.work__send_message')
    expect(mcpToolNameOf(table, 'slack_work_send_message', null)).toBe('mcp__slack__work_send_message')
    expect(mcpToolNameOf(table, 'nodash', null)).toBe('nodash')
    expect(mcpServersOf({ data: [{ name: 'aios' }, { name: '' }, {}] })).toEqual(['aios'])
    expect(mcpServersOf([{ name: 'x' }])).toEqual(['x'])
  })

  it('does not count a request withdrawn by an aios interrupt as a denial', () => {
    const result = runReject(BARE, true).find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.interrupted).toBe(true)
    expect(result?.kind === 'result' && result.payload.denials).toEqual([])
  })
})

describe('TODO 1066: wraps the failure of an unloadable model in a broken-download guide', () => {
  it("even for a failure before step arrives, matches by the conversation's model (ctx.modelId) and calls onModelBroken", () => {
    const broken: string[] = []
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_x',
      now: () => 1,
      newId: () => 'id',
      modelId: 'ollama/gemma4:12b-mlx',
      onModelBroken: (model) => broken.push(model)
    })
    const message = 'mlx runner failed: Error: layer 5: missing attention q/o projections'
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_x' } })
    const end = mapper.map({ type: table.events.executionFailed, data: { sessionID: 'ses_x', error: { type: 'provider.unknown', message } } })
    const error = end.events.find((e) => e.kind === 'error')
    expect(error?.kind === 'error' && error.payload.message.startsWith('aios-reason:')).toBe(true)
    expect(error?.kind === 'error' && error.payload.message).toContain('local-model-broken')
    expect(broken).toEqual(['gemma4:12b-mlx'])
  })
  it('when a turn succeeds, calls onModelLoaded with the model used (a derived model uses the original name)', () => {
    const loaded: string[] = []
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_x',
      now: () => 1,
      newId: () => 'id',
      modelId: 'ollama/aios-gpt-oss:20b',
      onModelLoaded: (model) => loaded.push(model)
    })
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_x' } })
    mapper.map({ type: table.events.executionEnded[0]!, data: { sessionID: 'ses_x' } })
    expect(loaded).toEqual(['gpt-oss:20b'])
  })
  it('does not touch other failures', () => {
    const broken: string[] = []
    const mapper = new OpenCodeEventMapper(table, {
      sessionId: 's1',
      threadId: 't1',
      backendSessionId: 'ses_x',
      now: () => 1,
      newId: () => 'id',
      modelId: 'ollama/gpt-oss:20b',
      onModelBroken: (model) => broken.push(model)
    })
    mapper.map({ type: table.events.executionStarted, data: { sessionID: 'ses_x' } })
    const end = mapper.map({ type: table.events.executionFailed, data: { sessionID: 'ses_x', error: { type: 'x', message: "model 'gpt-oss:20b' not found" } } })
    const error = end.events.find((e) => e.kind === 'error')
    expect(error?.kind === 'error' && error.payload.message).toBe("model 'gpt-oss:20b' not found")
    expect(broken).toEqual([])
  })
})
