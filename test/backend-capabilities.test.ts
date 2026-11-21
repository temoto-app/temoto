/** TODO 987: the 4 items of the feature table -> "what this backend can do". */
import { describe, expect, it } from 'vitest'
import { AGENT_FEATURES, BACKEND_CAPABILITY_KEYS, capabilitiesOf, type AgentFeature } from '../src/shared/agent.js'
import { featureMapOf, loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'

const all = (value: boolean): Record<AgentFeature, boolean> =>
  Object.fromEntries(AGENT_FEATURES.map((f) => [f, value])) as Record<AgentFeature, boolean>

describe('capabilitiesOf', () => {
  it('all five items true when all are true, and all five false when all are false', () => {
    expect(Object.values(capabilitiesOf(all(true)))).toEqual([true, true, true, true, true])
    expect(Object.values(capabilitiesOf(all(false)))).toEqual([false, false, false, false, false])
    expect(Object.keys(capabilitiesOf(all(true)))).toEqual([...BACKEND_CAPABILITY_KEYS])
  })

  it('each item follows only the one corresponding row of the feature table', () => {
    expect(capabilitiesOf({ ...all(false), rewind: true })).toEqual({ approval: false, subagents: false, rewind: true, mcp: false, instructions: false })
    expect(capabilitiesOf({ ...all(false), 'permission-prompt-tool': true }).approval).toBe(true)
    expect(capabilitiesOf({ ...all(false), 'subagent-text': true }).subagents).toBe(true)
    expect(capabilitiesOf({ ...all(false), 'mcp-config': true }).mcp).toBe(true)
    expect(capabilitiesOf({ ...all(false), 'standing-instructions': true }).instructions).toBe(true)
  })

  it('the OpenCode table has no rewind, subagents or standing instructions (they are ignored) and has approval and MCP', () => {
    expect(capabilitiesOf(featureMapOf(loadOpenCodeTable()))).toEqual({
      approval: true,
      subagents: false,
      rewind: false,
      mcp: true,
      instructions: false
    })
  })
})
