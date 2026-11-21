/**
 * TODO 1019: the guidance for installing OpenCode / Ollama (one line of setup state). Building the state is a pure function, and
 * neither OpenCode nor Ollama is called (Ollama is a fake fetch; the OpenCode that is not found is a command name that does not exist).
 */
import { describe, expect, it } from 'vitest'
import { OpenCodeAdapter } from '../src/main/session/adapter-opencode/index.js'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'
import { notInstalledOf, ollamaNoteOf, providerNotesOf, usageLimitNoteOf } from '../src/main/session/adapter-opencode/local.js'
import { parseReason } from '../src/shared/reason.js'

const table = loadOpenCodeTable()

function tags(models: unknown[]): typeof fetch {
  return async () => new Response(JSON.stringify({ models }), { status: 200 })
}

describe('ollamaNoteOf', () => {
  it('応答しなければ down、pull の手順は表から', () => {
    const r = parseReason(ollamaNoteOf(table, null))
    expect(r?.code).toBe('ollama-down')
    expect(r?.params).toEqual({ pull: 'ollama pull gpt-oss:20b' })
  })
  it('モデルが無ければ no-model', () => {
    expect(parseReason(ollamaNoteOf(table, { base: 'http://localhost:11434', names: [] }))?.code).toBe('ollama-no-model')
  })
  it('あれば ready、名前は 3 個まで', () => {
    const r = parseReason(ollamaNoteOf(table, { base: 'x', names: ['a', 'b', 'c', 'd'] }))
    expect(r?.code).toBe('ollama-ready')
    expect(r?.params).toEqual({ count: 4, models: 'a, b, c, …' })
  })
})

describe('OpenCodeAdapter.getStatus の案内', () => {
  it('見つからなければ入れ方つきの符丁 (brew のコマンドは表から)', async () => {
    const adapter = new OpenCodeAdapter({ command: '/nonexistent/aios-test-opencode' }, table)
    const status = await adapter.getStatus()
    expect(status.available).toBe(false)
    expect(status.messageCode).toBe(notInstalledOf(table, 'OpenCode'))
    expect(parseReason(status.messageCode)?.params).toEqual({ backend: 'OpenCode', install: 'brew install opencode' })
  })

  it('使えるときは Ollama の状態を messageCode に 1 行', async () => {
    const link = { baseUrl: '', authorization: 'x' }
    const up = new OpenCodeAdapter({ link, fetch: tags([{ name: 'gpt-oss:20b' }]) }, table)
    expect(parseReason((await up.getStatus()).messageCode)?.code).toBe('ollama-ready')
    const down = new OpenCodeAdapter(
      {
        link,
        fetch: async () => {
          throw new Error('ECONNREFUSED')
        }
      },
      table
    )
    expect(parseReason((await down.getStatus()).messageCode)?.code).toBe('ollama-down')
  })
})

describe('provider の案内 (TODO 529 段 2)', () => {
  it('一覧に Moonshot のモデルがあれば ready、無ければ auth login の案内 (一覧が未着でも案内)', () => {
    const ready = providerNotesOf(table, ['opencode/big-pickle', 'moonshotai/kimi-k2.6', 'moonshotai-cn/kimi-k2'])
    expect(parseReason(ready[1] ?? null)).toEqual({
      code: 'provider-ready',
      params: { provider: 'Moonshot AI (Kimi K2)', count: 2 }
    })
    for (const models of [['opencode/big-pickle'], null]) {
      const setup = parseReason(providerNotesOf(table, models)[1] ?? null)
      expect(setup?.code).toBe('provider-setup')
      expect(setup?.params).toEqual({ provider: 'Moonshot AI (Kimi K2)', command: 'opencode auth login', url: 'https://platform.moonshot.ai' })
    }
  })

  it('getStatus は使えるときだけ notes を添え、一覧が未着なら案内', async () => {
    const link = { baseUrl: '', authorization: 'x' }
    const adapter = new OpenCodeAdapter({ link }, table)
    const status = await adapter.getStatus()
    expect(status.notes?.map((n) => parseReason(n)?.code)).toEqual([
      'provider-intro',
      'provider-setup',
      'provider-setup-login',
      'provider-usage',
      'provider-setup',
      'provider-api-key-only'
    ])
    const missing = new OpenCodeAdapter({ command: '/nonexistent/aios-test-opencode' }, table)
    expect((await missing.getStatus()).notes).toBeUndefined()
  })
})

describe('OpenAI / Google の案内と使用量の案内 (TODO 1101 / 1102)', () => {
  it('冒頭に「ログインは契約を使うときだけ」、OpenAI は ChatGPT のログイン + 使用量の画面、Google は API キーだけ', () => {
    const notes = providerNotesOf(table, null).map((n) => parseReason(n))
    expect(notes[0]?.code).toBe('provider-intro')
    expect(notes).toContainEqual({
      code: 'provider-setup-login',
      params: { provider: 'OpenAI (ChatGPT)', command: 'opencode auth login', url: 'https://platform.openai.com/api-keys' }
    })
    expect(notes).toContainEqual({
      code: 'provider-usage',
      params: { provider: 'OpenAI (ChatGPT)', url: 'https://chatgpt.com/#settings/Usage' }
    })
    expect(notes).toContainEqual({ code: 'provider-api-key-only', params: { provider: 'Google (Gemini)' } })
  })

  it('一覧に openai / google のモデルがあれば ready', () => {
    const notes = providerNotesOf(table, ['openai/gpt-5', 'google/gemini-2.5-pro']).map((n) => parseReason(n))
    expect(notes.filter((n) => n?.code === 'provider-ready').map((n) => n?.params['provider'])).toEqual([
      'OpenAI (ChatGPT)',
      'Google (Gemini)'
    ])
  })

  it('上限らしい失敗の文は openai のモデルのときだけ使用量の画面の案内に包む。表が空でも落ちない', () => {
    const hit = parseReason(usageLimitNoteOf(table, 'openai/gpt-5', 'You exceeded your current quota'))
    expect(hit?.code).toBe('usage-limit')
    expect(hit?.params).toEqual({ message: 'You exceeded your current quota', url: 'https://chatgpt.com/#settings/Usage' })
    expect(usageLimitNoteOf(table, 'openai/gpt-5', 'model not found')).toBeNull()
    // A long sentence is not cut either / a word made only of digits is not matched against part of a request id
    const long = `quota ${'x'.repeat(500)}`
    expect(parseReason(usageLimitNoteOf(table, 'openai/gpt-5', long))?.params['message']).toBe(long)
    expect(usageLimitNoteOf(table, 'openai/gpt-5', 'failed req_14291 id 4290')).toBeNull()
    expect(usageLimitNoteOf(table, 'openai/gpt-5', 'HTTP 429: slow down')).not.toBeNull()
    expect(usageLimitNoteOf(table, 'moonshotai/kimi', 'rate limit')).toBeNull()
    expect(usageLimitNoteOf(table, null, 'rate limit')).toBeNull()
    const empty = { ...table, providerGuides: { ...table.providerGuides!, usageLimitPatterns: [] } }
    expect(usageLimitNoteOf(empty, 'openai/gpt-5', 'rate limit')).toBeNull()
    expect(usageLimitNoteOf({ ...table, providerGuides: undefined }, 'openai/gpt-5', 'rate limit')).toBeNull()
  })
})
