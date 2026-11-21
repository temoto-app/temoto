/**
 * Factory for the second and later backends (TODO 529, ARCHITECTURE 4.6.1).
 *
 * The composition root (`src/main/index.ts`) writes neither implementation names nor directory names and calls only the neutral names here
 * (constraint 6: specific terms stay inside the adapter directories and `compat/`. This file is inside the allowed area).
 * The default (first) backend is still `createAgentAdapter`.
 */
import type { AgentAdapter } from '../types.js'
import { createOpenCodeAdapter } from '../adapter-opencode/index.js'

/** Additional backends listed after the default. Those whose table cannot be read are left out. */
export function createSecondaryAdapters(): readonly AgentAdapter[] {
  const extra: AgentAdapter[] = []
  const second = createOpenCodeAdapter()
  if (second !== null) extra.push(second)
  return extra
}
