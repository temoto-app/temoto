/**
 * Contract test (the homework of ARCHITECTURE.md 4.6 / 12.6).
 *
 * It checks **whether the full set of flags aios depends on is still accepted by the latest installed CLI**.
 * `parse-event` in Phase 2 is a unit test based on fixtures, so changes on the CLI side cannot be detected. This test takes that role.
 *
 * Cost: like the probe, it **stops once `system/init` arrives**, so no model
 * response is generated. Even so, starting the session costs something (about 21k cache-creation tokens), so it is not part of `npm test`
 * (`npm run test:contract`).
 *
 * What to do when it fails:
 * 1. Add a row for the new version to the table of known versions in `compat/`.
 * 2. If the failing feature has really been removed, update the Adapter's degradation (table in 4.6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { GatewayServer } from '../../src/main/approval/server.js'
import { ClaudeCodeAdapter } from '../../src/main/session/adapter/index.js'
import type { AiosEvent } from '../../src/shared/agent.js'
import type { SpawnOptions } from '../../src/main/session/types.js'
import { makeTestDir } from '../helpers/tmp.js'

let workDir: string
let runtimeDir: string
let gateway: GatewayServer
let adapter: ClaudeCodeAdapter

beforeAll(async () => {
  // Create a throwaway directory so that the places scan and index could target are not polluted.
  workDir = makeTestDir('contract')
  runtimeDir = makeTestDir('contract-run')
  gateway = new GatewayServer(runtimeDir, async () => ({ allowed: false, message: 'contract' }))
  await gateway.start()
  adapter = new ClaudeCodeAdapter()
})

afterAll(async () => {
  await gateway.stop()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(runtimeDir, { recursive: true, force: true })
})

describe('contract with the backend CLI', () => {
  it('detects the installed CLI and can read the login state', async () => {
    const status = await adapter.getStatus(true)
    expect(status.available).toBe(true)
    expect(status.version).not.toBeNull()
    // Detection itself works even when not logged in (stdout is still correct JSON when logged out).
    expect(typeof status.loggedIn).toBe('boolean')
  })

  it("the set of flags aios passes is accepted, and the gateway is visible as MCP (the user's servers may be mixed in)", async () => {
    const gatewayFactory = (): SpawnOptions['gateway'] => ({
      socketPath: gateway.socketPath,
      token: gateway.issueToken(`contract-${Date.now()}`),
      scriptPath: join(import.meta.dirname, '../../out/main/gateway.js'),
      runtimePath: process.execPath,
      configDir: join(runtimeDir, 'mcp')
    })

    const result = await adapter.probe(gatewayFactory, workDir)
    // Even on failure, the feature table is returned with provisional values (the table's values for a known version), so success or failure is checked first (item 81).
    expect(result.ok).toBe(true)
    const features = result.status.features

    // Launch succeeded = the full set of flags passed was accepted (4.6).
    expect(features['structured-io']).toBe(true)
    expect(features['permission-prompt-tool']).toBe(true)
    expect(features['permission-mode']).toBe(true)
    expect(features['partial-messages']).toBe(true)
    // The gateway is connected (constraint 7: the gateway is always included). Since item 110 dropped `--strict-mcp-config`,
    // the user's MCP servers (claude.ai connectors etc.) may be listed alongside it.
    expect(features['mcp-config']).toBe(true)
    // T5: the model / thinking flags (measured on 2.1.207 at T0). The probe starts with both.
    expect(features['model-select']).toBe(true)
    expect(features['thinking-level']).toBe(true)
  })

  it('waits for connector connections before the first message, so no pending remains at init (TODO 869)', async () => {
    const events: AiosEvent[] = []
    const session = await adapter.spawn(
      {
        sessionId: randomUUID(),
        threadId: 'contract-wait',
        cwd: workDir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: {
          socketPath: gateway.socketPath,
          token: gateway.issueToken(`contract-wait-${Date.now()}`),
          scriptPath: join(import.meta.dirname, '../../out/main/gateway.js'),
          runtimePath: process.execPath,
          configDir: join(runtimeDir, 'mcp')
        }
      },
      { onEvent: (event) => events.push(event), onExit: () => undefined }
    )
    try {
      const sentAt = Date.now()
      session.send({ text: 'hi' })
      // init is emitted at the start of a turn. It stops here, so it does not wait for the model's response (same as the probe).
      let init: AiosEvent | undefined
      while (Date.now() - sentAt < 30_000 && (init = events.find((e) => e.kind === 'session_started')) === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(init).toBeDefined()
      const servers = (init?.payload as { mcpServers?: { gateway?: boolean; state: string }[] }).mcpServers ?? []
      console.log(`[contract] init まで ${Date.now() - sentAt} ms`, servers.map((x) => x.state))
      expect(servers.filter((x) => x.gateway !== true && x.state === 'pending')).toEqual([])
    } finally {
      await session.stop()
    }
  })

  it('init arrives even when launched with the OS sandbox enabled (`--settings`) (TODO 1106); not checked for versions not in the feature table', async () => {
    if (!adapter.supports('os-sandbox')) {
      console.log('[contract] os-sandbox の無い版なので skip')
      return
    }
    const events: AiosEvent[] = []
    const session = await adapter.spawn(
      {
        sessionId: randomUUID(),
        threadId: 'contract-sandbox',
        cwd: workDir,
        allowedDirs: [runtimeDir],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        osSandbox: { allowedDomains: ['registry.npmjs.org'], allowWrite: ['~/.npm'] },
        gateway: {
          socketPath: gateway.socketPath,
          token: gateway.issueToken(`contract-sandbox-${Date.now()}`),
          scriptPath: join(import.meta.dirname, '../../out/main/gateway.js'),
          runtimePath: process.execPath,
          configDir: join(runtimeDir, 'mcp')
        }
      },
      { onEvent: (event) => events.push(event), onExit: () => undefined }
    )
    try {
      const sentAt = Date.now()
      session.send({ text: 'hi' })
      let init: AiosEvent | undefined
      while (Date.now() - sentAt < 30_000 && (init = events.find((e) => e.kind === 'session_started')) === undefined) {
        if (events.some((e) => e.kind === 'error')) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(events.filter((e) => e.kind === 'error')).toEqual([])
      expect(init).toBeDefined()
      // Even with failIfUnavailable: true, the launch does not fail, and no feature is turned off.
      expect(adapter.supports('os-sandbox')).toBe(true)
    } finally {
      await session.stop()
    }
  })
})
