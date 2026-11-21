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
  it('down when there is no response; the pull steps come from the table', () => {
    const r = parseReason(ollamaNoteOf(table, null))
    expect(r?.code).toBe('ollama-down')
    expect(r?.params).toEqual({ pull: 'ollama pull gpt-oss:20b' })
  })
  it('no-model when there is no model', () => {
    expect(parseReason(ollamaNoteOf(table, { base: 'http://localhost:11434', names: [] }))?.code).toBe('ollama-no-model')
  })
  it('ready when present, with up to 3 names', () => {
    const r = parseReason(ollamaNoteOf(table, { base: 'x', names: ['a', 'b', 'c', 'd'] }))
    expect(r?.code).toBe('ollama-ready')
    expect(r?.params).toEqual({ count: 4, models: 'a, b, c, …' })
  })
})

describe('OpenCodeAdapter.getStatus guidance', () => {
  it('when not found, a code with how to install (the brew command comes from the table)', async () => {
    const adapter = new OpenCodeAdapter({ command: '/nonexistent/aios-test-opencode' }, table)
    const status = await adapter.getStatus()
    expect(status.available).toBe(false)
    expect(status.messageCode).toBe(notInstalledOf(table, 'OpenCode'))
    expect(parseReason(status.messageCode)?.params).toEqual({ backend: 'OpenCode', install: 'brew install opencode' })
  })

  it('when usable, one line of the Ollama state in messageCode', async () => {
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

describe('provider guidance (TODO 529 stage 2)', () => {
  it('ready if the list has a Moonshot model, otherwise the auth login guide (guided even if the list has not arrived)', () => {
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

  it('getStatus adds notes only when usable and gives guidance when the list has not arrived', async () => {
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

describe('OpenAI / Google guidance and usage guidance (TODO 1101 / 1102)', () => {
  it('the top says 「ログインは契約を使うときだけ」; OpenAI is ChatGPT login + the usage screen, Google is API key only', () => {
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

  it('ready if the list has openai / google models', () => {
    const notes = providerNotesOf(table, ['openai/gpt-5', 'google/gemini-2.5-pro']).map((n) => parseReason(n))
    expect(notes.filter((n) => n?.code === 'provider-ready').map((n) => n?.params['provider'])).toEqual([
      'OpenAI (ChatGPT)',
      'Google (Gemini)'
    ])
  })

  it('a limit-like failure sentence is wrapped in the usage-screen guide only for openai models; does not fail with an empty table', () => {
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
