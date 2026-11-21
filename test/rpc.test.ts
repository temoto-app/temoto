/** TODO 1073 (3): `RpcPeer.dispatch` looks up only its own methods (an inherited name is an unknown method). */
import { describe, expect, it } from 'vitest'
import { RpcPeer } from '../src/common/rpc.js'

describe('RpcPeer.dispatch', () => {
  it('constructor のような継承した名前は unknown method で返す', async () => {
    const sent: unknown[] = []
    const peer = new RpcPeer((m) => sent.push(m), { ping: () => 'pong' })
    peer.receive({ kind: 'req', id: 1, method: 'constructor', params: { a: 1 } } as never)
    peer.receive({ kind: 'req', id: 2, method: 'ping', params: null } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(sent[0]).toMatchObject({ kind: 'res', id: 1, ok: false })
    expect(sent[1]).toMatchObject({ kind: 'res', id: 2, ok: true, result: 'pong' })
  })
})
