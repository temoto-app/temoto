/**
 * TODO 1126: regression for the real `TranscriptReader.findToolResult` (until then, only fakes existed in test/).
 *
 * - A tool result that comes after a transcript over 16 MB is also found (previously it searched only the first 16 MB, because of the `readHead` limit).
 * - Even when a line straddles a chunk boundary (1 MB), only the line that contains the id is parsed and picked up.
 * - An `assistant` line that contains the same id (`tool_use`) is skipped, and the last line that does not end with a newline (still being written) is also read.
 *
 * The transcript is synthetic JSONL. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBackendPaths } from '../src/main/session/adapter/compat.js'
import { TranscriptReader } from '../src/main/session/adapter/transcript.js'

let home: string
let projectDir: string

function toolUse(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] }
  })
}

function toolResult(id: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }
  })
}

/** Large filler (imitates base64 of images). One line repeatedly straddles the 1 MB chunks. */
function filler(n: number, bytes: number): string {
  return JSON.stringify({
    type: 'user',
    uuid: `f-${n}`,
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes) } }] }
  })
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'aios-transcript-tool-result-'))
  const configured = loadBackendPaths().transcriptDir
  const root = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  projectDir = join(root, '-work-project')
  mkdirSync(projectDir, { recursive: true })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('TranscriptReader.findToolResult (TODO 1126)', () => {
  it('16 MB より後ろの結果も見つけ、tool_use の行は飛ばす', async () => {
    const lines = [
      toolResult('toolu_early', 'early result'),
      // 3 lines x 6 MB = 18 MB of filler (each line straddles a chunk boundary).
      filler(1, 6 * 1024 * 1024),
      filler(2, 6 * 1024 * 1024),
      filler(3, 6 * 1024 * 1024),
      toolUse('toolu_late'),
      toolResult('toolu_late', 'late result 日本語')
    ]
    writeFileSync(join(projectDir, 'sess-big.jsonl'), `${lines.join('\n')}\n`)
    const reader = new TranscriptReader(home)
    expect(await reader.findToolResult('sess-big', 'toolu_early')).toMatchObject({ text: 'early result', truncated: false })
    const late = await reader.findToolResult('sess-big', 'toolu_late')
    expect(late).toEqual({ text: 'late result 日本語', bytes: Buffer.byteLength('late result 日本語'), truncated: false })
    expect(await reader.findToolResult('sess-big', 'toolu_missing')).toBeNull()
    expect(await reader.findToolResult('no-such-session', 'toolu_late')).toBeNull()
  })

  it('改行で終わらない最後の行も読み、長い結果は 64 KB で切る', async () => {
    const long = 'x'.repeat(100 * 1024)
    writeFileSync(join(projectDir, 'sess-tail.jsonl'), `${toolUse('toolu_t')}\n${toolResult('toolu_t', long)}`)
    const reader = new TranscriptReader(home)
    const found = await reader.findToolResult('sess-tail', 'toolu_t')
    expect(found?.bytes).toBe(long.length)
    expect(found?.truncated).toBe(true)
    expect(found?.text.length).toBe(64 * 1024)
  })
})
