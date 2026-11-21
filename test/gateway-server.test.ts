/**
 * Reading lines in the approval server (`src/main/approval/server.ts`) (TODO 565) and checking frames (TODO 569).
 * Connects through a real Unix socket. The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayServer, type GatewayRequest } from '../src/main/approval/server.js'
import { LineReader } from '../src/common/line-reader.js'

let dir: string
let server: GatewayServer
let requests: GatewayRequest[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aios-gw-'))
  requests = []
  server = new GatewayServer(dir, async (request) => {
    requests.push(request)
    return { echo: request.payload }
  })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

function open(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function firstLine(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    const reader = new LineReader()
    socket.on('data', (chunk: Buffer) => {
      const lines = reader.push(chunk)
      if (lines.length > 0) resolve(lines[0] ?? '')
    })
  })
}

describe('GatewayServer', () => {
  it('writing one frame containing Japanese one byte at a time still yields a payload equal to the original (565)', async () => {
    const token = server.issueToken('s1')
    const payload = { kind: 'approve', input: { content: '日本語の本文。'.repeat(50), q: '🍣を選ぶ?' } }
    const bytes = Buffer.from(`${JSON.stringify({ id: 7, token, payload })}\n`, 'utf8')
    const socket = await open()
    const reply = firstLine(socket)
    for (let i = 0; i < bytes.length; i += 1) {
      await new Promise<void>((resolve) => socket.write(bytes.subarray(i, i + 1), () => resolve()))
    }
    const message = JSON.parse(await reply) as { id: number; result: { echo: unknown } }
    expect(message.id).toBe(7)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.payload).toEqual(payload)
    expect(message.result.echo).toEqual(payload)
    socket.destroy()
  })

  it.each(['null', '42', '"text"', '[1]', '{"id":"1","token":"t"}', '{"id":1,"token":"t","payload":3}'])(
    'a frame of the wrong shape %s disconnects instead of causing a TypeError (569)',
    async (line) => {
      const rejections: unknown[] = []
      const onRejection = (reason: unknown): void => {
        rejections.push(reason)
      }
      process.on('unhandledRejection', onRejection)
      try {
        const socket = await open()
        const done = closed(socket)
        socket.write(`${line}\n`)
        await done
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(requests).toHaveLength(0)
        expect(rejections).toEqual([])
      } finally {
        process.off('unhandledRejection', onRejection)
      }
    }
  )

  it('disconnects when an unterminated fragment exceeds the limit (569)', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'aios-gw-'))
    const small = new GatewayServer(dir2, async () => 'ok', 1024)
    await small.start()
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = connect(small.socketPath)
        s.once('connect', () => resolve(s))
        s.once('error', reject)
      })
      socket.on('error', () => undefined)
      const done = closed(socket)
      socket.write('x'.repeat(2048))
      await done
      expect(socket.destroyed).toBe(true)
    } finally {
      await small.stop()
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve()
    else socket.once('close', () => resolve())
  })
}
