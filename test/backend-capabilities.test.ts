/** TODO 987: the 4 items of the feature table -> "what this backend can do". */
import { describe, expect, it } from 'vitest'
import { AGENT_FEATURES, BACKEND_CAPABILITY_KEYS, capabilitiesOf, type AgentFeature } from '../src/shared/agent.js'
import { featureMapOf, loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'

const all = (value: boolean): Record<AgentFeature, boolean> =>
  Object.fromEntries(AGENT_FEATURES.map((f) => [f, value])) as Record<AgentFeature, boolean>

describe('capabilitiesOf', () => {
  it('全部真なら 4 項目とも真、全部偽なら 4 項目とも偽', () => {
    expect(Object.values(capabilitiesOf(all(true)))).toEqual([true, true, true, true])
    expect(Object.values(capabilitiesOf(all(false)))).toEqual([false, false, false, false])
    expect(Object.keys(capabilitiesOf(all(true)))).toEqual([...BACKEND_CAPABILITY_KEYS])
  })

  it('各項目は対応する機能表の 1 行だけに従う', () => {
    expect(capabilitiesOf({ ...all(false), rewind: true })).toEqual({ approval: false, subagents: false, rewind: true, mcp: false })
    expect(capabilitiesOf({ ...all(false), 'permission-prompt-tool': true }).approval).toBe(true)
    expect(capabilitiesOf({ ...all(false), 'subagent-text': true }).subagents).toBe(true)
    expect(capabilitiesOf({ ...all(false), 'mcp-config': true }).mcp).toBe(true)
  })

  it('OpenCode の表は巻き戻しと子エージェントを持たず、承認と MCP は持つ', () => {
    expect(capabilitiesOf(featureMapOf(loadOpenCodeTable()))).toEqual({
      approval: true,
      subagents: false,
      rewind: false,
      mcp: true
    })
  })
})
