/**
 * TODO 1073 (1): even if `requestApproval` in `approve` throws, the id in `pendingApprovals` is not left behind, and the state is restored.
 * The model is not called.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import type { Thread } from '../src/shared/thread.js'
import { GatewayRequests, type GatewayLiveHandle, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'

describe('GatewayRequests approve: when requestApproval throws', () => {
  it('removes the id from pendingApprovals and returns awaiting-approval', async () => {
    const recorded: AiosEvent[] = []
    const live = { pendingApprovals: new Set<string>(), state: 'running' } as unknown as GatewayLiveHandle
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: () => 't1',
      getThread: (id) =>
        ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false }) as unknown as Thread,
      getLive: () => live,
      getAdapter: () => undefined,
      emitThread: () => undefined,
      record: (_id, event) => {
        recorded.push(event)
      },
      hasPlanMode: () => false,
      viewsOf: () => [],
      conflictingViews: () => [],
      isQueueAwaitingResult: () => false,
      subtaskOfToolUse: () => null,
      requestApproval: async () => {
        throw new Error('boom')
      }
    }
    const requests = new GatewayRequests(host as GatewayRequestHost)
    await expect(
      requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName: 'Write', input: {}, toolUseId: 'tu1' } } as never)
    ).rejects.toThrow('boom')
    expect(live.pendingApprovals.size).toBe(0)
    expect(live.state).toBe('idle')
    // After the pending row, leave a settlement row with the same id, equivalent to a refusal (an internal error).
    expect(recorded).toHaveLength(2)
    expect(recorded[1]!.id).toBe(recorded[0]!.id)
    const payload = recorded[1]!.payload as { decidedAt: number | null; outcome: { kind: string; by: string; message: string } }
    expect(payload.decidedAt).not.toBeNull()
    expect(payload.outcome).toEqual({ kind: 'denied', by: 'system', message: 'internal-error' })
  })
})
