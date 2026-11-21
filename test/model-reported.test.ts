/**
 * Reported full name → the alias of a choice (item 140, ARCHITECTURE.md 4.5.9).
 *
 * The model of a thread continued from a transcript is decided from the `message.model` (full name) of the transcript's last response.
 * `canonicalModelId` only translates old ids, so with a full name (`claude-opus-5-5`) it did not match the list and fell back to the settings default
 * (proxy verification 138). `modelIdForReported` looks up, in order: the table (`reportedAs`), the full name learned from the CLI (`resolvedModel` of `initialize`), and the family (the head without the version).
 *
 * It uses the real compat table and the `initialize` response from spike 16 (CLI 2.1.207). It does not call a model.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import {
  learnFromInitialize,
  modelIdForReported,
  parseReportedModels,
  type LearnedModel
} from '../src/main/session/adapter/models.js'
import { readControlResponse } from '../src/main/session/adapter/control.js'

const table = loadCompatTable()
const NONE: ReadonlyMap<string, LearnedModel> = new Map()

function learnedFromFixture(): Map<string, LearnedModel> {
  const line = readFileSync(new URL('./fixtures/initialize-response.json', import.meta.url), 'utf8')
    .split('\n')
    .join('')
  const reply = readControlResponse(table.control, line)
  if (reply === null) throw new Error('fixture did not parse')
  return learnFromInitialize(table, parseReportedModels(reply.response))
}

describe('modelIdForReported (項目 140)', () => {
  it('代理確認 138 の再現: claude-opus-5-5 は opus (教わる前でも表の reportedAs で当たる)', () => {
    expect(modelIdForReported(table, NONE, 'claude-opus-5-5')).toBe('opus')
  })

  it('表の reportedAs の完全名は全部その別名に当たる。[1m] の接尾辞は同じとみなす', () => {
    for (const entry of table.models.list) {
      for (const name of entry.reportedAs ?? []) {
        expect(modelIdForReported(table, NONE, name)).toBe(entry.id)
        expect(modelIdForReported(table, NONE, `${name}[1m]`)).toBe(entry.id)
      }
    }
  })

  it('別名そのものと旧 id もそのまま引ける', () => {
    expect(modelIdForReported(table, NONE, 'sonnet')).toBe('sonnet')
    expect(modelIdForReported(table, NONE, 'claude-haiku-4-5-20251001')).toBe('haiku')
  })

  it('CLI から教わった完全名 (initialize の resolvedModel) で当たる', () => {
    const learned = learnedFromFixture()
    expect(modelIdForReported(table, learned, 'claude-opus-4-8')).toBe('opus')
    expect(modelIdForReported(table, learned, 'claude-fable-5')).toBe('fable')
    expect(modelIdForReported(table, learned, 'claude-sonnet-5')).toBe('sonnet')
  })

  it('表に無い版でも族が同じなら同じ別名 (古い Opus 4.7 は opus、将来の Sonnet 5.5 は sonnet)', () => {
    expect(modelIdForReported(table, NONE, 'claude-opus-4-7')).toBe('opus')
    expect(modelIdForReported(table, NONE, 'claude-sonnet-5-5')).toBe('sonnet')
    expect(modelIdForReported(table, NONE, 'claude-haiku-4-6-20260101')).toBe('haiku')
  })

  it('表に無い族・命名の崩れた名前は null (呼び出し側が設定の既定に落とす)', () => {
    expect(modelIdForReported(table, NONE, 'claude-3-5-sonnet-20241022')).toBeNull()
    expect(modelIdForReported(table, NONE, 'claude-mystery-9')).toBeNull()
    expect(modelIdForReported(table, NONE, 'gpt-something')).toBeNull()
    expect(modelIdForReported(table, NONE, '')).toBeNull()
  })
})
