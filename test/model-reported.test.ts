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

describe('modelIdForReported (item 140)', () => {
  it("reproduces proxy verification 138: claude-opus-5-5 is opus (matches by the table's reportedAs even before being told)", () => {
    expect(modelIdForReported(table, NONE, 'claude-opus-5-5')).toBe('opus')
  })

  it("every full name in the table's reportedAs matches its alias; the [1m] suffix is treated as the same", () => {
    for (const entry of table.models.list) {
      for (const name of entry.reportedAs ?? []) {
        expect(modelIdForReported(table, NONE, name)).toBe(entry.id)
        expect(modelIdForReported(table, NONE, `${name}[1m]`)).toBe(entry.id)
      }
    }
  })

  it('aliases themselves and old ids can also be looked up as they are', () => {
    expect(modelIdForReported(table, NONE, 'sonnet')).toBe('sonnet')
    expect(modelIdForReported(table, NONE, 'claude-haiku-4-5-20251001')).toBe('haiku')
  })

  it('matches by the full name the CLI told us (resolvedModel of initialize)', () => {
    const learned = learnedFromFixture()
    expect(modelIdForReported(table, learned, 'claude-opus-4-8')).toBe('opus')
    expect(modelIdForReported(table, learned, 'claude-fable-5')).toBe('fable')
    expect(modelIdForReported(table, learned, 'claude-sonnet-5')).toBe('sonnet')
  })

  it('even for a version not in the table, the same family gives the same alias (old Opus 4.7 is opus, a future Sonnet 5.5 is sonnet)', () => {
    expect(modelIdForReported(table, NONE, 'claude-opus-4-7')).toBe('opus')
    expect(modelIdForReported(table, NONE, 'claude-sonnet-5-5')).toBe('sonnet')
    expect(modelIdForReported(table, NONE, 'claude-haiku-4-6-20260101')).toBe('haiku')
  })

  it('a family not in the table and a malformed name give null (the caller falls back to the settings default)', () => {
    expect(modelIdForReported(table, NONE, 'claude-3-5-sonnet-20241022')).toBeNull()
    expect(modelIdForReported(table, NONE, 'claude-mystery-9')).toBeNull()
    expect(modelIdForReported(table, NONE, 'gpt-something')).toBeNull()
    expect(modelIdForReported(table, NONE, '')).toBeNull()
  })
})
