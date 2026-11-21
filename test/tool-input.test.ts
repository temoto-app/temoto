/**
 * Item 286 (wave 16 bundle A): formatting of tool call arguments (`thread/tool-input.ts`, pure functions).
 * Decided by the argument keys, not the tool name / input not in the table is shown as JSON / a field not shown by the table is kept as JSON / the actual string after escapes are undone / masked in display too / the full text of the bubble has the same key priority as the summary (`summarizeToolInput`).
 */
import { describe, expect, it } from 'vitest'
import {
  displayToolSummary,
  HOVER_KEYS,
  MAX_HOVER_CHARS,
  toolHover,
  toolInputView
} from '../src/renderer/src/thread/tool-input.js'
import { SUMMARY_KEYS, summarizeToolInput } from '../src/main/session/adapter/parse.js'

describe('toolInputView (項目 286)', () => {
  it('Bash の形: command をコード、description を下に、残りの欄 (timeout) は JSON で残す', () => {
    const view = toolInputView({
      command: 'ssh u@h "tail -n 80 /x.log" 2>&1 | grep -v "post-quantum\\|store now"',
      description: 'Tail cron log',
      timeout: 60000
    })
    expect(view.kind).toBe('formatted')
    if (view.kind !== 'formatted') return
    // The actual command string, not JSON escapes (\" / \\\\).
    expect(view.command).toBe('ssh u@h "tail -n 80 /x.log" 2>&1 | grep -v "post-quantum\\|store now"')
    expect(view.command).not.toContain('\\"')
    expect(view.description).toBe('Tail cron log')
    expect(view.fields).toEqual([])
    expect(JSON.parse(view.rest ?? 'null')).toEqual({ timeout: 60000 })
  })

  it('Read の形: file_path / offset / limit を見出し付きの行に。余りが無ければ rest は null', () => {
    const view = toolInputView({ file_path: '/a/b.ts', offset: 10, limit: 50 })
    expect(view).toEqual({
      kind: 'formatted',
      command: null,
      description: null,
      fields: [
        { key: 'file_path', value: '/a/b.ts', kind: 'path' },
        { key: 'offset', value: '10', kind: 'text' },
        { key: 'limit', value: '50', kind: 'text' }
      ],
      rest: null
    })
  })

  it('Grep の形: pattern → path → glob の順、表に無い欄 (output_mode / -i) は JSON で残す', () => {
    const view = toolInputView({ path: 'src', glob: '*.ts', pattern: 'foo\\(', output_mode: 'content', '-i': true })
    if (view.kind !== 'formatted') throw new Error('formatted のはず')
    expect(view.fields.map((f) => f.key)).toEqual(['pattern', 'path', 'glob'])
    expect(view.fields[0]!.value).toBe('foo\\(')
    expect(JSON.parse(view.rest ?? 'null')).toEqual({ output_mode: 'content', '-i': true })
  })

  it('Edit の形: file_path だけ行に、old_string / new_string は JSON で残す (情報を落とさない)', () => {
    const view = toolInputView({ file_path: '/x', old_string: 'a', new_string: 'b', replace_all: false })
    if (view.kind !== 'formatted') throw new Error('formatted のはず')
    expect(view.fields).toEqual([{ key: 'file_path', value: '/x', kind: 'path' }])
    expect(JSON.parse(view.rest ?? 'null')).toEqual({ old_string: 'a', new_string: 'b', replace_all: false })
  })

  it('WebFetch / Glob の形', () => {
    const fetch = toolInputView({ url: 'https://example.com/a', prompt: '要約して' })
    if (fetch.kind !== 'formatted') throw new Error('formatted のはず')
    expect(fetch.fields).toEqual([{ key: 'url', value: 'https://example.com/a', kind: 'text' }])
    expect(JSON.parse(fetch.rest ?? 'null')).toEqual({ prompt: '要約して' })
    const glob = toolInputView({ pattern: '**/*.md' })
    expect(glob).toMatchObject({ kind: 'formatted', fields: [{ key: 'pattern', value: '**/*.md' }], rest: null })
  })

  it('錨の鍵が無い入力 (Task / 知らないツール) と object でない入力は JSON のまま', () => {
    const task = { description: 'x', prompt: 'y', subagent_type: 'general' }
    expect(toolInputView(task)).toEqual({ kind: 'json', json: JSON.stringify(task, null, 2) })
    expect(toolInputView(['a', 1])).toEqual({ kind: 'json', json: JSON.stringify(['a', 1], null, 2) })
    expect(toolInputView('raw')).toEqual({ kind: 'json', json: '"raw"' })
    expect(toolInputView({})).toEqual({ kind: 'json', json: '{}' })
  })

  it('欄の型が想定と違えば行にせず JSON に残す (command が object、offset が文字列、空の file_path)', () => {
    const view = toolInputView({ command: { nested: 1 }, file_path: '/ok', offset: '10', path: '  ' })
    if (view.kind !== 'formatted') throw new Error('formatted のはず')
    expect(view.command).toBeNull()
    expect(view.fields).toEqual([{ key: 'file_path', value: '/ok', kind: 'path' }])
    expect(JSON.parse(view.rest ?? 'null')).toEqual({ command: { nested: 1 }, offset: '10', path: '  ' })
  })

  it('description はコマンドが無ければ行にしない (JSON に残る)', () => {
    const view = toolInputView({ file_path: '/x', description: 'd' })
    if (view.kind !== 'formatted') throw new Error('formatted のはず')
    expect(view.description).toBeNull()
    expect(JSON.parse(view.rest ?? 'null')).toEqual({ description: 'd' })
  })

  it('受信中の (保存前の) 引数でも表示は伏せ字 — コマンドにも JSON の残りにも', () => {
    const view = toolInputView({
      command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x',
      env: 'GITHUB=ghp_abcdefghijklmnopqrstuvwxyz0123'
    })
    if (view.kind !== 'formatted') throw new Error('formatted のはず')
    expect(view.command).toContain('[redacted]')
    expect(view.command).not.toContain('abcdefghijklmnop1234')
    expect(view.rest).not.toContain('ghp_')
    // Applying masking twice to a row that is already masked (saved) does not change its shape.
    const again = toolInputView({ command: view.command ?? '' })
    if (again.kind !== 'formatted') throw new Error('formatted のはず')
    expect(again.command).toBe(view.command)
  })
})

describe('toolHover (項目 286: 畳んだ行の吹き出し)', () => {
  it('要約と同じ鍵の優先順で全文を拾う (要約は切り詰め・空白の畳み込み)', () => {
    const long = `echo ${'x'.repeat(500)}\n  && ls`
    const inputs: readonly Record<string, string>[] = [
      { command: long, description: 'd' },
      { file_path: '/very/long/' + 'd/'.repeat(150) + 'f.ts' },
      { query: 'q', prompt: 'p' },
      { description: 'only description', prompt: '' },
      { subagent_type: 'Explore' }
    ]
    for (const input of inputs) {
      const summary = summarizeToolInput(input)
      const hover = toolHover(input, summary)
      const clipped = summary.endsWith('…') ? summary.slice(0, -1) : summary
      expect(hover.text.replace(/\s+/g, ' ').startsWith(clipped), JSON.stringify(input).slice(0, 40)).toBe(true)
    }
    expect(toolHover({ command: long }, summarizeToolInput({ command: long }))).toMatchObject({ text: long.trim(), more: true })
  })

  it('要約で全部見えているなら more は偽', () => {
    expect(toolHover({ command: 'ls -la' }, 'ls -la')).toEqual({ text: 'ls -la', more: false })
  })

  it('引数が無い (子の呼び出し、項目 257) ときは要約そのもの', () => {
    expect(toolHover(null, 'Read /x')).toEqual({ text: 'Read /x', more: false })
  })

  it('上限を超えた分は切る', () => {
    const big = 'a'.repeat(MAX_HOVER_CHARS + 100)
    const hover = toolHover({ command: big }, 'a…')
    expect(hover.text.length).toBe(MAX_HOVER_CHARS + 1)
    expect(hover.text.endsWith('…')).toBe(true)
  })

  it('吹き出しも伏せ字', () => {
    const hover = toolHover({ command: 'mysql -u root -psecretpass db' }, 'mysql -u root -psecretpass db')
    expect(hover.text).not.toContain('secretpass')
  })
})

/**
 * Item 321 (wave 17 bundle G): the heading of a subagent block uses the description (`description`). Only the key order changed; it is not split by tool name. The two tables (main's summary and the renderer's copy) have the same order.
 */
describe('項目 321: 見出しの鍵の順と強調記号', () => {
  it('要約の表 (SUMMARY_KEYS) と吹き出しの表 (HOVER_KEYS) は同じ並びで、description が prompt より先', () => {
    expect([...HOVER_KEYS]).toEqual([...SUMMARY_KEYS])
    expect(HOVER_KEYS.indexOf('description')).toBeLessThan(HOVER_KEYS.indexOf('prompt'))
    // command / url / query come before description and prompt (so the summaries of Bash / WebFetch / search do not change).
    for (const key of ['command', 'url', 'query']) {
      expect(HOVER_KEYS.indexOf(key)).toBeLessThan(HOVER_KEYS.indexOf('description'))
    }
  })

  it('Bash / WebFetch / Agent の要約', () => {
    expect(summarizeToolInput({ command: 'rm -rf /tmp/x', description: 'Clean temp' })).toBe('rm -rf /tmp/x')
    expect(summarizeToolInput({ url: 'https://example.com/a', prompt: '要約して' })).toBe('https://example.com/a')
    expect(
      summarizeToolInput({ description: '束 G: 子の塊', prompt: 'あなたは aios の第 17 波 **束 G** を担当する', subagent_type: 'general-purpose' })
    ).toBe('束 G: 子の塊')
  })

  it('保存済みの古い行 (要約が prompt のまま) は、引数の description から見出しを作り直す', () => {
    const input = { description: '束 **A**: 版情報', prompt: 'あなたは aios の第 17 波 **束 A** を担当する…', subagent_type: 'general-purpose' }
    expect(displayToolSummary(input, 'あなたは aios の第 17 波 **束 A** を担当する…')).toBe('束 A: 版情報')
    // Rows with no arguments (a child's tool call), and rows decided by a key that is not prose, stay as the saved summary.
    expect(displayToolSummary(null, 'f1.ts')).toBe('f1.ts')
    expect(displayToolSummary({ command: 'ls', description: 'd' }, 'ls')).toBe('ls')
    expect(displayToolSummary({ pattern: '**/*.ts' }, '**/*.ts')).toBe('**/*.ts')
    // A new row matches main's summary.
    const fresh = { description: 'Run echo 17', prompt: 'Run the bash command `echo 17`' }
    expect(displayToolSummary(fresh, summarizeToolInput(fresh))).toBe(summarizeToolInput(fresh))
  })

  it('吹き出しは題の後ろに指示文 (prompt) を足す。prompt だけの行は今までどおり', () => {
    const input = { description: 'Run echo 17', prompt: 'Run the bash command\n`echo 17`' }
    const hover = toolHover(input, summarizeToolInput(input))
    expect(hover.text).toBe('Run echo 17\n\nRun the bash command\n`echo 17`')
    expect(hover.more).toBe(true)
    expect(toolHover({ prompt: 'p' }, 'p')).toEqual({ text: 'p', more: false })
    // If it matches the summary with the emphasis marks removed, `more` is false (no bubble is shown).
    expect(toolHover({ description: '**短い**題' }, '短い題')).toEqual({ text: '**短い**題', more: false })
  })
})
