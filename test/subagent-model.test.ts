/**
 * TODO 403 (wave 21 bundle C): where a subagent's model comes from, and its display name. No model is called.
 *
 * - (b) `message.model` of a child's message (an assistant row with `parent_tool_use_id`) is put by the adapter into `turn_usage` (`actor: 'subagent'`, `parentToolUseId` = the parent call that started the child). Checked against the real fixture (`subagents.jsonl`, two haiku children with CLI 2.1.280).
 * - (a) The `model` in the input of the parent's `Agent` call (only when specified) is `ToolUsePayload.subagentModel`.
 * - The display name (`Sonnet 5`) is written in the same way as the model switch table (item 91; `reportedAs` + `versionPattern`).
 * - main's memo (`applySubagentModel`): provisionally set from the parent's specification, and overwritten with the actual model of the child's first message.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AiosEvent } from '../src/shared/agent.js'
import type { RunningSubtask } from '../src/shared/thread.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { reportedModelLabel, type LearnedModel } from '../src/main/session/adapter/models.js'
import {
  applySubagentModel,
  applySubtaskEvent,
  MAX_SUBAGENT_MODELS
} from '../src/main/session/subtasks.js'

const fixtureDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000,
  newId: () => `e${(counter += 1)}`
}
const AGENT_1 = 'toolu_01Gfe7iMozkfgreA8c88HX5E'
const AGENT_2 = 'toolu_01RUK3sK2Ynya1aHz6v1ezJQ'

const table = loadCompatTable()
const NONE: ReadonlyMap<string, LearnedModel> = new Map()
const label = (model: string): string | null => reportedModelLabel(table, NONE, model)

function parseFixture(): AiosEvent[] {
  counter = 0
  return readFileSync(join(fixtureDir, 'subagents.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => [...parseEvent(line, ctx)])
}

describe('parseEvent — 子の model の出どころ (TODO 403)', () => {
  it('実物: 子の発言の turn_usage は子を起こした親の呼び出しと実際の完全名を持つ', () => {
    const child = parseFixture().flatMap((e) =>
      e.kind === 'turn_usage' && e.actor === 'subagent' ? [e] : []
    )
    expect(child.length).toBeGreaterThan(0)
    expect(new Set(child.map((e) => e.parentToolUseId))).toEqual(new Set([AGENT_1, AGENT_2]))
    for (const e of child) expect(e.payload.model).toBe('claude-haiku-4-5-20251001')
  })

  it('実物: 親の Agent 呼び出しに model の指定が無ければ subagentModel は付かない', () => {
    const spawns = parseFixture().flatMap((e) =>
      e.kind === 'tool_use' && e.actor === 'main' && e.payload.name === 'Agent' ? [e.payload] : []
    )
    expect(spawns).toHaveLength(2)
    for (const payload of spawns) expect('subagentModel' in payload).toBe(false)
  })

  it('親が model を指定した Agent / Task 呼び出しは subagentModel に別名を載せる。他のツール・子の呼び出しには付けない', () => {
    const assistant = (name: string, input: Record<string, unknown>, parent: string | null = null): AiosEvent[] => [
      ...parseEvent(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: parent,
          message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu-x', name, input }] }
        }),
        ctx
      )
    ]
    const toolUse = (events: AiosEvent[]) => {
      const found = events.find((e) => e.kind === 'tool_use')
      if (found?.kind !== 'tool_use') throw new Error('no tool_use')
      return found.payload
    }
    expect(toolUse(assistant('Agent', { description: 'd', prompt: 'p', model: 'sonnet' })).subagentModel).toBe('sonnet')
    expect(toolUse(assistant('Task', { description: 'd', prompt: 'p', model: ' haiku ' })).subagentModel).toBe('haiku')
    expect(toolUse(assistant('Agent', { description: 'd', prompt: 'p', model: '' })).subagentModel).toBeUndefined()
    expect(toolUse(assistant('Read', { file_path: '/x', model: 'sonnet' })).subagentModel).toBeUndefined()
    // A call that starts a grandchild does not appear in the list, so it is not attached.
    expect(toolUse(assistant('Agent', { prompt: 'p', model: 'opus' }, AGENT_1)).subagentModel).toBeUndefined()
  })
})

describe('reportedModelLabel (TODO 403、項目 91 の表と同じ書き方)', () => {
  it('完全名は表の label + 名前から読んだ版', () => {
    expect(label('claude-sonnet-5')).toBe('Sonnet 5')
    expect(label('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(label('claude-opus-5-5')).toBe('Opus 5.5')
    expect(label('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    // Even for a version not in the table, if the family matches, the version is read from the name.
    expect(label('claude-opus-4-7')).toBe('Opus 4.7')
  })

  it('別名は CLI から教わった完全名の版 (教わる前は名前だけ)', () => {
    expect(label('sonnet')).toBe('Sonnet')
    const learned = new Map<string, LearnedModel>([
      ['sonnet', { resolved: 'claude-sonnet-5', supportsEffort: true, effortLevels: null }]
    ])
    expect(reportedModelLabel(table, learned, 'sonnet')).toBe('Sonnet 5')
  })

  it('表のどの族にも当たらなければ null (呼び出し側が報告の名前のまま出す)', () => {
    expect(label('inherit')).toBeNull()
    expect(label('some-other-model')).toBeNull()
  })
})

describe('applySubagentModel (main の控え、TODO 403)', () => {
  const base = { sessionId: 's', threadId: 't', ts: 10 }
  const spawn = (toolUseId: string, model?: string): AiosEvent =>
    ({
      ...base,
      id: `tu-${toolUseId}`,
      actor: 'main',
      kind: 'tool_use',
      payload: {
        toolUseId,
        name: 'Agent',
        summary: '',
        input: {},
        truncated: false,
        ...(model === undefined ? {} : { subagentModel: model })
      }
    }) as AiosEvent
  const started = (taskId: string, toolUseId: string): AiosEvent =>
    ({
      ...base,
      id: `st-${taskId}`,
      actor: 'main',
      kind: 'subtask_started',
      payload: {
        taskId,
        toolUseId,
        description: 'd',
        subagentType: 'general-purpose',
        isSubagent: true,
        isBackgroundShell: false
      }
    }) as AiosEvent
  const childUsage = (toolUseId: string, model: string | null): AiosEvent =>
    ({
      ...base,
      id: `u-${toolUseId}`,
      actor: 'subagent',
      parentToolUseId: toolUseId,
      kind: 'turn_usage',
      payload: { model, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }
    }) as AiosEvent

  it('親の指定で仮に入れ、開始で控えに写し、子の最初の発言の実際のモデルで上書きする', () => {
    const running = new Map<string, RunningSubtask>()
    const models = new Map<string, string>()
    const confirmed = new Set<string>()
    expect(applySubagentModel(running, models, confirmed, spawn('a1', 'sonnet'), label)).toBe(true)
    expect(models.get('a1')).toBe('Sonnet')
    applySubtaskEvent(running, started('task-1', 'a1'), models)
    expect(running.get('task-1')?.model).toBe('Sonnet')
    expect(applySubagentModel(running, models, confirmed, childUsage('a1', 'claude-haiku-4-5-20251001'), label)).toBe(true)
    expect(running.get('task-1')?.model).toBe('Haiku 4.5')
    expect(models.get('a1')).toBe('Haiku 4.5')
    // Even when messages from the same model keep coming, it is not redistributed.
    expect(applySubagentModel(running, models, confirmed, childUsage('a1', 'claude-haiku-4-5-20251001'), label)).toBe(false)
    // A parent's specification for the same id that arrives after the child has confirmed it does not overwrite.
    expect(applySubagentModel(running, models, confirmed, spawn('a1', 'opus'), label)).toBe(false)
    expect(models.get('a1')).toBe('Haiku 4.5')
  })

  it('指定の無い子は最初の発言まで null。表に当たらない指定は入れず、当たらない実際の名前はそのまま', () => {
    const running = new Map<string, RunningSubtask>()
    const models = new Map<string, string>()
    const confirmed = new Set<string>()
    expect(applySubagentModel(running, models, confirmed, spawn('a2'), label)).toBe(false)
    expect(applySubagentModel(running, models, confirmed, spawn('a2', 'inherit'), label)).toBe(false)
    applySubtaskEvent(running, started('task-2', 'a2'), models)
    expect(running.get('task-2')?.model).toBeNull()
    expect(applySubagentModel(running, models, confirmed, childUsage('a2', 'mystery-model'), label)).toBe(true)
    expect(running.get('task-2')?.model).toBe('mystery-model')
    // Usage without a model name and the parent's turn_usage are not looked at.
    expect(applySubagentModel(running, models, confirmed, childUsage('a2', null), label)).toBe(false)
  })

  it('終わった子 (控えから外れた) の model も表に残り、上限を超えたら古い呼び出しから捨てる', () => {
    const running = new Map<string, RunningSubtask>()
    const models = new Map<string, string>()
    const confirmed = new Set<string>()
    for (let i = 0; i <= MAX_SUBAGENT_MODELS; i += 1) {
      applySubagentModel(running, models, confirmed, childUsage(`p${i}`, 'claude-sonnet-5'), label)
    }
    expect(models.size).toBe(MAX_SUBAGENT_MODELS)
    expect(models.has('p0')).toBe(false)
    expect(confirmed.has('p0')).toBe(false)
    expect(models.get(`p${MAX_SUBAGENT_MODELS}`)).toBe('Sonnet 5')
  })
})
