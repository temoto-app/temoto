/**
 * Presenting a plan in Plan mode (item 112, ARCHITECTURE.md 4.2.3) and the diff of the approval frame (item 97, 7.6.4): pure functions and the Broker.
 * **Neither the CLI nor the model is called.** The plan request is the real one from spike 22 (`test/fixtures/exit-plan-mode.json`).
 *
 * What is pinned down:
 * - A plan the user asked for is not passed through by either the default allow-everything or a rule. Even "always allow" does not create a rule
 * - A plan not asked for (the AI entered plan mode by itself, item 167) passes by default. In strict mode it is queued
 * - "Fix it" (the reject message) is returned as is; if empty, the default text; if too long, it is cut
 * - The Adapter's reads (`planProposalOf` / `writePreviewOf`) build a neutral shape from the table and the argument keys
 * - `applyWriteChange` builds the before/after of applying the change to the current content, and falls back to a fragment if it cannot be applied
 * - `isPlanToggle` is only a bare Shift+Tab
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovalBroker, type ApprovalResult } from '../src/main/approval/broker.js'
import { applyWriteChange } from '../src/main/approval/write-diff.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { planProposalOf, writePreviewOf } from '../src/main/session/adapter/write-preview.js'
import { isPlanToggle, type ComposerKey } from '../src/renderer/src/composer-keys.js'
import type { JsonValue } from '../src/shared/agent.js'
import type { ApprovalItem, ApprovalPolicy } from '../src/shared/thread.js'

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/exit-plan-mode.json'), 'utf8')
) as { toolName: string; input: JsonValue }

/** The same "allow everything" as the T40 default. Checks that the plan does not get past it. */
const LOOSE_POLICY: ApprovalPolicy = { autoAllowAll: true, autoAllowTools: [], bashDenyPatterns: [] }

function makeBroker(policy: ApprovalPolicy = LOOSE_POLICY): {
  broker: ApprovalBroker
  changed: () => readonly ApprovalItem[]
} {
  let last: readonly ApprovalItem[] = []
  const broker = new ApprovalBroker(
    { onChanged: (items) => (last = items), onDecided: () => undefined },
    policy
  )
  return { broker, changed: () => last }
}

const table = loadCompatTable()
const plan = planProposalOf(table, fixture.toolName, fixture.input)

describe('presenting a plan (item 112, Broker)', () => {
  it('reads the plan body from the real request', () => {
    expect(plan).not.toBeNull()
    expect(plan?.startsWith('# Plan:')).toBe(true)
  })

  it('queues even under the default of allow-all and carries the plan on the item', async () => {
    const { broker, changed } = makeBroker()
    let settled: ApprovalResult | null = null
    void broker
      .request({
        threadId: 't',
        threadTitle: '',
        toolName: fixture.toolName,
        summary: '',
        input: fixture.input,
        plan,
        planRequested: true
      })
      .then((result) => (settled = result))
    await Promise.resolve()
    expect(settled).toBeNull()
    expect(changed()).toHaveLength(1)
    expect(changed()[0]?.plan).toBe(plan)
    // An ordinary write passes with the same setting (control).
    const write = await broker.request({ threadId: 't', threadTitle: '', toolName: 'Write', summary: '', input: {} })
    expect(write).toMatchObject({ allowed: true, by: 'default' })
  })

  it('pressing "Always allow" creates no rule and drops to a one-time allow', async () => {
    const { broker } = makeBroker()
    const pending = broker.request({
      threadId: 't',
      threadTitle: '',
      toolName: fixture.toolName,
      summary: '',
      input: fixture.input,
      plan,
      planRequested: true
    })
    const item = broker.list()[0]
    if (item === undefined) throw new Error('no item')
    broker.decide(item.id, { kind: 'allow-always' })
    await expect(pending).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(broker.listRules()).toEqual([])
  })

  it('the "revise" wording is returned as is; empty gives the default wording and too long is cut', async () => {
    const { broker } = makeBroker()
    const ask = (): Promise<ApprovalResult> =>
      broker.request({
        threadId: 't',
        threadTitle: '',
        toolName: fixture.toolName,
        summary: '',
        input: {},
        plan: '',
        planRequested: true
      })
    const decideLast = (message: string): void => {
      const item = broker.list().at(-1)
      if (item === undefined) throw new Error('no item')
      broker.decide(item.id, { kind: 'deny', message })
    }
    const first = ask()
    decideLast('  先にバックアップを取って  ')
    await expect(first).resolves.toMatchObject({ allowed: false, by: 'user', message: '先にバックアップを取って' })
    const second = ask()
    decideLast('   ')
    await expect(second).resolves.toMatchObject({ allowed: false, message: 'approval-denied-user' })
    const third = ask()
    decideLast('あ'.repeat(9000))
    expect((await third).message).toHaveLength(8000)
  })

  it('a plan that was not requested (the AI entered plan on its own) passes by default and is left in the audit (item 167)', async () => {
    const decided: string[] = []
    const broker = new ApprovalBroker(
      {
        onChanged: () => undefined,
        onDecided: (item, result) => decided.push(`${item.toolName}:${result.by}:${String(item.plan !== null)}`)
      },
      LOOSE_POLICY
    )
    const base = { threadId: 't', threadTitle: '', toolName: fixture.toolName, summary: '', input: fixture.input, plan }
    // Both omitted and false mean "not asked for".
    await expect(broker.request(base)).resolves.toMatchObject({ allowed: true, by: 'default' })
    await expect(broker.request({ ...base, planRequested: false })).resolves.toMatchObject({
      allowed: true,
      by: 'default'
    })
    expect(broker.list()).toHaveLength(0)
    expect(decided).toEqual([`${fixture.toolName}:default:true`, `${fixture.toolName}:default:true`])
  })

  it('even an unrequested plan is queued in strict-mode threads and in the setting with "pass everything" turned off (item 167)', () => {
    const base = { threadId: 't', threadTitle: '', toolName: fixture.toolName, summary: '', input: fixture.input, plan }
    const strict = makeBroker()
    void strict.broker.request({ ...base, strict: true })
    expect(strict.changed()).toHaveLength(1)
    expect(strict.changed()[0]?.plan).toBe(plan)
    const narrow = makeBroker({ autoAllowAll: false, autoAllowTools: ['Bash'], bashDenyPatterns: [] })
    void narrow.broker.request(base)
    expect(narrow.changed()).toHaveLength(1)
  })

  it('even if the plan field is unreadable, a presenting tool gives an empty string (the stopping side); other tools give null', () => {
    expect(planProposalOf(table, fixture.toolName, {})).toBe('')
    expect(planProposalOf(table, fixture.toolName, 'x')).toBe('')
    expect(planProposalOf(table, 'Write', { plan: 'x' })).toBeNull()
  })
})

describe('reading writes (item 97, Adapter)', () => {
  it('Edit is a replacement (one / several), Write is the whole, NotebookEdit is a cell', () => {
    expect(writePreviewOf(table, 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      path: 'a.ts',
      change: { kind: 'replace', edits: [{ oldText: 'x', newText: 'y', replaceAll: false }] }
    })
    expect(
      writePreviewOf(table, 'Edit', {
        file_path: '/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b', replace_all: true },
          { old_string: 'c', new_string: '' }
        ]
      })?.change
    ).toEqual({
      kind: 'replace',
      edits: [
        { oldText: 'a', newText: 'b', replaceAll: true },
        { oldText: 'c', newText: '', replaceAll: false }
      ]
    })
    expect(writePreviewOf(table, 'Write', { file_path: '/a.ts', content: '' })?.change).toEqual({
      kind: 'overwrite',
      content: ''
    })
    expect(
      writePreviewOf(table, 'NotebookEdit', { notebook_path: '/n.ipynb', cell_id: 'c1', new_source: 'print(1)' })
    ).toEqual({
      path: '/n.ipynb',
      change: { kind: 'notebookCell', cellId: 'c1', newSource: 'print(1)', mode: 'replace' }
    })
    expect(
      writePreviewOf(table, 'NotebookEdit', { notebook_path: '/n.ipynb', cell_id: 'c1', edit_mode: 'delete' })?.change
    ).toEqual({ kind: 'notebookCell', cellId: 'c1', newSource: '', mode: 'delete' })
  })

  it('read-only tools, arguments without a path, and malformed arguments are null', () => {
    expect(writePreviewOf(table, 'Read', { file_path: '/a.ts' })).toBeNull()
    expect(writePreviewOf(table, 'Write', { content: 'x' })).toBeNull()
    expect(writePreviewOf(table, 'Edit', { file_path: '/a.ts', old_string: 'x' })).toBeNull()
    expect(writePreviewOf(table, 'Edit', { file_path: '/a.ts', edits: [{ old_string: 'x' }] })).toBeNull()
    expect(writePreviewOf(table, 'NotebookEdit', { notebook_path: '/n.ipynb', cell_id: 'c1' })).toBeNull()
  })
})

describe('applyWriteChange (item 97, main pure function)', () => {
  const text = (value: string) => ({ kind: 'text', text: value }) as const

  it('write the whole: from empty if missing, a fragment if unreadable', () => {
    expect(applyWriteChange(text('old'), { kind: 'overwrite', content: 'new' })).toEqual({
      before: 'old',
      after: 'new',
      basis: 'file'
    })
    expect(applyWriteChange({ kind: 'missing' }, { kind: 'overwrite', content: 'new' })).toEqual({
      before: '',
      after: 'new',
      basis: 'file'
    })
    expect(applyWriteChange({ kind: 'unavailable' }, { kind: 'overwrite', content: 'new' }).basis).toBe('fragment')
  })

  it('replace: the first one / all, and $ in the replacement string is literal', () => {
    const edit = (oldText: string, newText: string, replaceAll = false) => ({
      kind: 'replace' as const,
      edits: [{ oldText, newText, replaceAll }]
    })
    expect(applyWriteChange(text('a a a'), edit('a', 'b')).after).toBe('b a a')
    expect(applyWriteChange(text('a a a'), edit('a', 'b', true)).after).toBe('b b b')
    expect(applyWriteChange(text('x'), edit('x', '$&$&')).after).toBe('$&$&')
    expect(applyWriteChange(text('const a = 1\n'), edit('1', '2'))).toEqual({
      before: 'const a = 1\n',
      after: 'const a = 2\n',
      basis: 'file'
    })
  })

  it('falls back to a fragment when the replaced text is not found or the file is missing / unreadable', () => {
    const change = {
      kind: 'replace' as const,
      edits: [
        { oldText: 'x', newText: 'y', replaceAll: false },
        { oldText: 'p', newText: 'q', replaceAll: false }
      ]
    }
    const fragment = { before: 'x\n…\np', after: 'y\n…\nq', basis: 'fragment' }
    expect(applyWriteChange(text('only x here'), change)).toEqual(fragment)
    expect(applyWriteChange({ kind: 'missing' }, change)).toEqual(fragment)
    expect(applyWriteChange({ kind: 'unavailable' }, change)).toEqual(fragment)
  })

  it('empty → body replacement is applied as a way of creating a missing or empty file', () => {
    const create = { kind: 'replace' as const, edits: [{ oldText: '', newText: 'hello', replaceAll: false }] }
    expect(applyWriteChange({ kind: 'missing' }, create)).toEqual({ before: '', after: 'hello', basis: 'file' })
    expect(applyWriteChange(text(''), create)).toEqual({ before: '', after: 'hello', basis: 'file' })
    expect(applyWriteChange(text('not empty'), create).basis).toBe('fragment')
  })

  it('notebook: finds the cell by id / cell-N and shows only the surroundings of that cell', () => {
    const notebook = JSON.stringify({
      cells: [
        { id: 'c0', cell_type: 'code', source: ['print(0)\n', 'x = 1'] },
        { id: 'c1', cell_type: 'markdown', source: '# t' }
      ]
    })
    expect(
      applyWriteChange(text(notebook), { kind: 'notebookCell', cellId: 'c0', newSource: 'print(1)', mode: 'replace' })
    ).toEqual({ before: 'print(0)\nx = 1', after: 'print(1)', basis: 'file' })
    expect(
      applyWriteChange(text(notebook), { kind: 'notebookCell', cellId: 'cell-1', newSource: '', mode: 'delete' })
    ).toEqual({ before: '# t', after: '', basis: 'file' })
    expect(
      applyWriteChange(text(notebook), { kind: 'notebookCell', cellId: 'c0', newSource: 'new', mode: 'insert' })
    ).toEqual({ before: '', after: 'new', basis: 'file' })
    expect(
      applyWriteChange(text('not json'), { kind: 'notebookCell', cellId: 'c0', newSource: 'n', mode: 'replace' }).basis
    ).toBe('fragment')
  })
})

describe('isPlanToggle (item 112, Composer key)', () => {
  const key = (over: Partial<ComposerKey>): ComposerKey => ({
    key: 'Tab',
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 9,
    ...over
  })
  it('only a bare Shift+Tab', () => {
    expect(isPlanToggle(key({}))).toBe(true)
    expect(isPlanToggle(key({ shiftKey: false }))).toBe(false)
    expect(isPlanToggle(key({ metaKey: true }))).toBe(false)
    expect(isPlanToggle(key({ ctrlKey: true }))).toBe(false)
    expect(isPlanToggle(key({ altKey: true }))).toBe(false)
    expect(isPlanToggle(key({ isComposing: true }))).toBe(false)
    expect(isPlanToggle(key({ keyCode: 229 }))).toBe(false)
    expect(isPlanToggle(key({ key: 'Enter' }))).toBe(false)
  })
})
