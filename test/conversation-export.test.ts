/**
 * Saves a conversation as a PDF (TODO 818). Building of turns, the range, and file names (shared); the save procedure (main's
 * `ConversationExporter`; the dialog and the PDF conversion are fakes). The HTML for printing is in `export-pdf-html.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import {
  EXPORT_HTML_MAX_BYTES,
  asExportScope,
  buildExportTurns,
  exportFileName,
  turnOfQuestion,
  turnsInScope
} from '../src/shared/conversation-export.js'
import { ConversationExporter, type SaveDialogRequest } from '../src/main/export/conversation-pdf.js'
import type { AppSettingsStore } from '../src/common/settings.js'
import type { SettingKey } from '../src/common/settings-keys.js'
import { parseReason } from '../src/shared/reason.js'

let seq = 0
function ev(kind: string, payload: unknown, extra: Partial<{ actor: 'main' | 'subagent'; parentToolUseId: string }> = {}): AiosEvent {
  seq += 1
  return { id: `e${seq}`, sessionId: 's', threadId: 't', ts: seq, actor: extra.actor ?? 'main', ...(extra.parentToolUseId === undefined ? {} : { parentToolUseId: extra.parentToolUseId }), kind, payload } as AiosEvent
}

describe('buildExportTurns (TODO 818)', () => {
  it('発言 1 件と次の発言までの親の回答を 1 問 1 答にし、ツール・思考・子エージェントは出さない', () => {
    const events = [
      ev('assistant_text', { text: '頭の回答' }),
      ev('user_text', { text: 'Q1' }),
      ev('thinking_delta', { text: '考え中' }),
      ev('tool_use', { toolUseId: 'u1', name: 'Read', input: {}, summary: 'a.ts' }),
      ev('assistant_text', { text: '子の発言' }, { actor: 'subagent', parentToolUseId: 'u1' }),
      ev('assistant_text', { text: '入れ子' }, { parentToolUseId: 'u1' }),
      ev('assistant_text', { text: 'A1-1' }),
      ev('assistant_text', { text: '   ' }),
      ev('assistant_text', { text: 'A1-2' }),
      ev('user_text', { text: 'Q2 (中断)' }),
      ev('user_text', { text: 'Q3' }),
      ev('assistant_text', { text: 'A3' })
    ]
    const turns = buildExportTurns(events, (text) => text.toUpperCase())
    expect(turns.map((turn) => [turn.number, turn.question?.text ?? null, turn.answers])).toEqual([
      [0, null, ['頭の回答']],
      [1, 'Q1', ['A1-1', 'A1-2']],
      [2, 'Q2 (中断)', []],
      [3, 'Q3', ['A3']]
    ])
    const q3 = turns[3]!.question!
    expect(turnOfQuestion(turns, q3.id)?.number).toBe(3)
    expect(turnOfQuestion(turns, 'nope')).toBeNull()
    expect(turnsInScope(turns, { kind: 'turn', number: 1 }).map((turn) => turn.number)).toEqual([1])
    expect(turnsInScope(turns, { kind: 'all' })).toHaveLength(4)
    expect(turnsInScope(turns, { kind: 'turn', number: 9 })).toEqual([])
  })

  it('mapText は発言と回答の両方に掛かる (main の redaction)', () => {
    const turns = buildExportTurns([ev('user_text', { text: 'q' }), ev('assistant_text', { text: 'a' })], (text) => `[${text}]`)
    expect(turns[0]?.question?.text).toBe('[q]')
    expect(turns[0]?.answers).toEqual(['[a]'])
  })
})

describe('asExportScope / exportFileName (TODO 818)', () => {
  it('範囲は形が合うものだけ通す', () => {
    expect(asExportScope({ kind: 'all' })).toEqual({ kind: 'all' })
    expect(asExportScope({ kind: 'turn', number: 2 })).toEqual({ kind: 'turn', number: 2 })
    expect(asExportScope({ kind: 'turn', number: 0 })).toBeNull()
    expect(asExportScope({ kind: 'turn', number: 1.5 })).toBeNull()
    expect(asExportScope({ kind: 'other' })).toBeNull()
    expect(asExportScope(null)).toBeNull()
  })

  it('既定のファイル名は題名 + 日付 (+ 何問目か)、使えない文字は空白に、空なら代わりの名前', () => {
    const at = new Date(2026, 9, 7, 23, 59)
    expect(exportFileName('索引の設計', at, '会話')).toBe('索引の設計 2026-10-07.pdf')
    expect(exportFileName('索引の設計', at, '会話', 3)).toBe('索引の設計 2026-10-07 - 3.pdf')
    expect(exportFileName('a/b:c\nd', at, '会話')).toBe('a b c d 2026-10-07.pdf')
    expect(exportFileName('', at, '会話')).toBe('会話 2026-10-07.pdf')
    expect(exportFileName('...', at, 'Conversation')).toBe('Conversation 2026-10-07.pdf')
    const long = exportFileName('あ'.repeat(200), at, '会話')
    expect([...long.replace(/ 2026-10-07\.pdf$/, '')]).toHaveLength(80)
  })

  it('HTML (TODO 866) は拡張子だけが .html', () => {
    const at = new Date(2026, 9, 7, 23, 59)
    expect(exportFileName('索引の設計', at, '会話', undefined, 'html')).toBe('索引の設計 2026-10-07.html')
    expect(exportFileName('索引の設計', at, '会話', 3, 'html')).toBe('索引の設計 2026-10-07 - 3.html')
  })
})

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(key: SettingKey<T>): T {
    return key.parse(this.values.get(key.key) ?? null)
  }
  writeTyped<T>(key: SettingKey<T>, value: T): void {
    this.values.set(key.key, key.serialize(value))
  }
}

function exporter(options: { answer?: string | null; failRender?: boolean; failEmbed?: boolean } = {}) {
  const settings = new MemorySettings()
  const asked: SaveDialogRequest<string>[] = []
  const written: { path: string; bytes: number; text: string }[] = []
  const embedCalls: { html: string; threadId: string }[] = []
  const rendered: string[] = []
  const subject = new ConversationExporter<string>({
    settings: settings as unknown as AppSettingsStore,
    askSavePath: async (request) => {
      asked.push(request)
      return options.answer === undefined ? '/Users/me/Documents/out.pdf' : options.answer
    },
    renderPdf: async (html) => {
      if (options.failRender === true) throw new Error('boom')
      rendered.push(html)
      return new Uint8Array([1, 2, 3])
    },
    embedImages: async (html, threadId) => {
      if (options.failEmbed === true) throw new Error('boom')
      embedCalls.push({ html, threadId })
      return html.replace('<img src="/a.png">', '<img src="data:image/png;base64,AA==">')
    },
    threadTitle: (threadId) => (threadId === 't1' ? '設計' : threadId === 'untitled' ? '' : null),
    defaultDir: () => '/Users/me/Downloads',
    fallbackName: () => '会話',
    writeFile: async (path, data) => {
      written.push({ path, bytes: data.byteLength, text: Buffer.from(data).toString('utf8') })
    },
    now: () => new Date(2026, 9, 17)
  })
  return { subject, settings, asked, written, rendered, embedCalls }
}

describe('ConversationExporter (TODO 818)', () => {
  it('毎回ダイアログで聞き、初回は ~/Downloads、2 回目からは前回のフォルダから始める', async () => {
    const { subject, asked, written, rendered } = exporter()
    const first = await subject.save('t1', { kind: 'all' }, '<html></html>', 'win')
    expect(first).toEqual({ saved: true, uri: 'file:///Users/me/Documents/out.pdf' })
    expect(asked[0]).toEqual({ defaultPath: '/Users/me/Downloads/設計 2026-10-17.pdf', owner: 'win', format: 'pdf' })
    expect(written.map(({ path, bytes }) => ({ path, bytes }))).toEqual([{ path: '/Users/me/Documents/out.pdf', bytes: 3 }])
    expect(rendered).toEqual(['<html></html>'])
    await subject.save('t1', { kind: 'turn', number: 2 }, '<html></html>', 'win')
    expect(asked[1]?.defaultPath).toBe('/Users/me/Documents/設計 2026-10-17 - 2.pdf')
  })

  it('ダイアログを閉じたら描かず書かず、フォルダも覚えない', async () => {
    const { subject, written, rendered, settings } = exporter({ answer: null })
    expect(await subject.save('untitled', { kind: 'all' }, 'x', 'win')).toEqual({ saved: false })
    expect(written).toEqual([])
    expect(rendered).toEqual([])
    expect(settings.values.size).toBe(0)
  })

  it('仮題は代わりの名前、知らないスレッド・大きすぎる HTML・描画の失敗は理由コード', async () => {
    const { subject, asked } = exporter()
    await subject.save('untitled', { kind: 'all' }, 'x', 'win')
    expect(asked[0]?.defaultPath).toBe('/Users/me/Downloads/会話 2026-10-17.pdf')
    await expect(subject.save('gone', { kind: 'all' }, 'x', 'win')).rejects.toSatisfy(
      (err: Error) => parseReason(err.message)?.code === 'invalid-value'
    )
    await expect(subject.save('t1', { kind: 'all' }, 'x'.repeat(EXPORT_HTML_MAX_BYTES + 1), 'win')).rejects.toSatisfy(
      (err: Error) => parseReason(err.message)?.code === 'invalid-value'
    )
    const failing = exporter({ failRender: true })
    await expect(failing.subject.save('t1', { kind: 'all' }, 'x', 'win')).rejects.toSatisfy(
      (err: Error) => parseReason(err.message)?.code === 'export-pdf-failed'
    )
    expect(failing.settings.values.size).toBe(0)
  })
})

describe('ConversationExporter の HTML (TODO 866)', () => {
  it('印刷せず、画像を埋めた HTML をそのまま書く。ダイアログは .html、前回のフォルダは PDF と共有', async () => {
    const { subject, asked, written, rendered, embedCalls } = exporter({ answer: '/Users/me/Documents/out.html' })
    const result = await subject.save('t1', { kind: 'turn', number: 2 }, '<p>x</p><img src="/a.png">', 'win', 'html')
    expect(result).toEqual({ saved: true, uri: 'file:///Users/me/Documents/out.html' })
    expect(asked[0]).toEqual({ defaultPath: '/Users/me/Downloads/設計 2026-10-17 - 2.html', owner: 'win', format: 'html' })
    expect(rendered).toEqual([])
    expect(embedCalls).toEqual([{ html: '<p>x</p><img src="/a.png">', threadId: 't1' }])
    expect(written[0]?.text).toBe('<p>x</p><img src="data:image/png;base64,AA==">')
    await subject.save('t1', { kind: 'all' }, 'y', 'win', 'pdf')
    expect(asked[1]?.defaultPath).toBe('/Users/me/Documents/設計 2026-10-17.pdf')
  })

  it('Markdown (TODO 1014): 印刷も画像の埋め込みもせず、.md で書く。redaction は掛け直す', async () => {
    const { subject, written, rendered, embedCalls, asked } = exporter({ answer: '/tmp/out.md' })
    const secret = 'ghp_' + 'a'.repeat(36)
    const result = await subject.save('t1', { kind: 'turn', number: 2 }, `# t\n\ntoken ${secret}\n`, 'win', 'md')
    expect(result).toEqual({ saved: true, uri: 'file:///tmp/out.md' })
    expect(asked[0]).toEqual({ defaultPath: '/Users/me/Downloads/設計 2026-10-17 - 2.md', owner: 'win', format: 'md' })
    expect(rendered).toEqual([])
    expect(embedCalls).toEqual([])
    expect(written[0]?.text).not.toContain('ghp_')
    expect(written[0]?.text).toContain('[redacted]')
  })

  it('renderer から来た HTML には書く前に redaction を掛け直す (PDF も HTML も)', async () => {
    const { subject, written, rendered } = exporter({ answer: '/tmp/out.html' })
    const secret = 'token ghp_' + 'a'.repeat(36)
    await subject.save('t1', { kind: 'all' }, `<p>${secret}</p>`, 'win', 'html')
    expect(written[0]?.text).not.toContain('ghp_')
    expect(written[0]?.text).toContain('[redacted]')
    await subject.save('t1', { kind: 'all' }, `<p>${secret}</p>`, 'win', 'pdf')
    expect(rendered[0]).not.toContain('ghp_')
  })

  it('redaction は data: の画像と <style> の中には掛けない (base64 が鍵のパターンに当たっても壊さない)、本文には掛ける', async () => {
    const { redactExportHtml } = await import('../src/main/export/conversation-pdf.js')
    const token = 'ghp_' + 'a'.repeat(36)
    const img = `data:image/png;base64,ghp${'a'.repeat(36)}AAAA`
    const html = `<style>.x{background:url(${token})}</style><img src="${img}" alt=""><pre data-code="${token}">${token}</pre><p>data:image/png;base64,${token}</p>`
    const out = redactExportHtml(html)
    expect(out).toContain(`<style>.x{background:url(${token})}</style>`)
    expect(out).toContain(`<img src="${img}" alt="">`)
    expect(out).toContain('<pre data-code="[redacted]">[redacted]</pre>')
    expect(out).toContain('<p>data:image/png;base64,[redacted]</p>')
  })

  it('TODO 875: 数 MB の HTML でも 1 回で全体に掛ける (画像と <style> の後ろ・節の境目の秘密も伏せる)', async () => {
    const { redactExportHtml } = await import('../src/main/export/conversation-pdf.js')
    const token = 'ghp_' + 'b'.repeat(36)
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    const style = `<style>${'.a{color:var(--x)}\n'.repeat(50_000)}</style>`
    const img = `<img src="data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}">`
    const turns = Array.from({ length: 4000 }, (_, i) => `<section><p>発言 ${i} の本文</p></section>`).join('')
    const html = `${style}${img}${turns}<p>${token}</p><section><pre>${pem.replace('\n-----END', '</pre></section><section><pre>-----END')}</pre></section>`
    const out = redactExportHtml(html)
    expect(out).not.toContain(token)
    expect(out).not.toContain('MIIabc')
    expect(out.startsWith(style)).toBe(true)
    expect(out).toContain(img)
  })

  it('組み立ての失敗は export-html-failed、フォルダは覚えない', async () => {
    const failing = exporter({ failEmbed: true, answer: '/tmp/out.html' })
    await expect(failing.subject.save('t1', { kind: 'all' }, 'x', 'win', 'html')).rejects.toSatisfy(
      (err: Error) => parseReason(err.message)?.code === 'export-html-failed'
    )
    expect(failing.settings.values.size).toBe(0)
    expect(failing.written).toEqual([])
  })
})
