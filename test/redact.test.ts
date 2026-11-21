/**
 * Secret redaction (ARCHITECTURE.md 4.3.1 / constraint 10).
 *
 * Premise: **some things are missed.** It only has meaning in combination with whole-DB encryption (chapter 8).
 * What is checked here is both that "common shapes get masked" and that "false positives do not make the conversation unreadable".
 */
import { describe, expect, it } from 'vitest'
import {
  REDACTION_MAX_GROWTH,
  redactJson,
  redactSlice,
  redactText,
  redactionRanges
} from '../src/common/redact.js'

describe('redactText — 既知パターン', () => {
  const cases: [string, string, string][] = [
    ['Authorization ヘッダ', 'curl -H "Authorization: Bearer sk-abc123DEF456ghi789"', 'sk-abc123DEF456ghi789'],
    ['裸の Bearer', 'token is Bearer abcdefghij0123456789', 'abcdefghij0123456789'],
    ['AWS アクセスキー ID', 'key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
    ['AWS シークレット', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI/K7MDENG'],
    ['password=', 'psql "password=hunter2secret"', 'hunter2secret'],
    ['api_key=', 'api_key=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['token=', 'token=abcdef0123456789xyz', 'abcdef0123456789xyz'],
    ['GitHub トークン', 'ghp_0123456789abcdefghijABCDEFGHIJ', 'ghp_0123456789abcdefghijABCDEFGHIJ'],
    ['Slack トークン', 'xoxb-1234567890-abcdefg', 'xoxb-1234567890-abcdefg'],
    ['Google API キー', 'AIzaSyA0123456789abcdefghijklmnopqrstuv', 'AIzaSyA0123456789abcdefghijklmnopqrstuv'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJhbGciOiJIUzI1NiJ9'],
    ['mysql の -p', 'mysql -u root -phunter2 mydb', 'hunter2'],
    // TODO 761 (fix of 752, 2026-10-12): a single `.` after an identifier was taken as a code shape, so real dot-separated tokens passed through unmasked.
    ['Google OAuth のアクセストークン', 'access_token=ya29.a0AfH6SMBxFAKEFAKEFAKE', 'ya29.a0AfH6SMBxFAKEFAKEFAKE'],
    ['Discord のトークン', 'token=MTk4NjIyMzQ1Njc4OTAxMjM0.Cl2FMQ.ZnCjm1XVfakefakefake', 'ZnCjm1XVfakefakefake'],
    ['password= (ドット付きの本物の値)', 'password=hunter2.prod', 'hunter2.prod']
  ]

  for (const [name, input, secret] of cases) {
    it(`${name} を伏せる`, () => {
      const result = redactText(input)
      expect(result.text).not.toContain(secret)
      expect(result.text).toContain('[redacted]')
      expect(result.hits.length).toBeGreaterThan(0)
    })
  }

  it('PEM 秘密鍵は本文ごと落とす', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qN',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n')
    const result = redactText(`鍵です\n${pem}\n以上`)
    expect(result.text).not.toContain('MIIEowIBAAKCAQEA')
    expect(result.text).toContain('鍵です')
    expect(result.text).toContain('以上')
  })

  it('文脈は残す (会話が読めなくならない)', () => {
    const result = redactText('curl -H "Authorization: Bearer sk-abc123DEF456ghi789" https://a.test')
    expect(result.text).toContain('curl')
    expect(result.text).toContain('https://a.test')
    expect(result.text).toContain('Authorization')
  })
})

describe('redactText — 誤検出しない', () => {
  const safe = [
    'git log -p HEAD~3',
    'git log --pretty=oneline',
    'この機能の設計は ARCHITECTURE.md 4.2 に書いてある',
    'password の入力欄を追加する',
    'ls -la /Users/tester/work',
    // TODO 752 (a)+(b), 2026-10-12: code shapes are not masked (type names, values where an identifier is followed by ( . [, and environment variable references).
    'interface User { password: string; token: string }',
    'def login(password: str) -> bool:',
    'const pwd = process.cwd()',
    'password: z.string().min(8),',
    'secret: process.env.SECRET_VALUE'
  ]
  const safeExact: [string, string][] = [
    // TODO 761 (fix of 752 (b), 2026-10-12): a matched pair of brackets is part of the value, and an unpaired closing bracket ends the value. The former is masked whole; the latter stays outside the mask.
    ['password=Pa(ss)w0rd!', 'password=[redacted]'],
    ['mysql -pS3cr[et]99', 'mysql -p[redacted]']
  ]
  for (const text of safe) {
    it(`そのまま残す: ${text}`, () => {
      expect(redactText(text).text).toBe(text)
      expect(redactText(text).hits).toEqual([])
    })
  }
  for (const [input, expected] of safeExact) {
    it(`対になった括弧は値ごと伏せ、対の無い括弧は外に残す: ${input}`, () => {
      expect(redactText(input).text).toBe(expected)
    })
  }
})

describe('redactJson', () => {
  it('構造を保ったまま文字列だけを伏せる', () => {
    const input = {
      command: 'curl -H "Authorization: Bearer sk-abc123DEF456ghi789"',
      timeout: 1000,
      nested: { flag: true, list: ['api_key=abcd1234efgh5678', 'ok'] },
      nothing: null
    }
    const { value, hits } = redactJson(input)
    expect(value.timeout).toBe(1000)
    expect(value.nested.flag).toBe(true)
    expect(value.nothing).toBeNull()
    expect(value.nested.list[1]).toBe('ok')
    expect(JSON.stringify(value)).not.toContain('sk-abc123DEF456ghi789')
    expect(JSON.stringify(value)).not.toContain('abcd1234efgh5678')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('当たらなければ元のまま', () => {
    const input = { a: 'hello', b: [1, 2, 3] }
    const { value, hits } = redactJson(input)
    expect(value).toEqual(input)
    expect(hits).toEqual([])
  })
})

describe('TODO 858: 環境変数の形・JSON・URL の資格情報・鍵名', () => {
  const hidden: Array<[string, string]> = [
    ['DB_PASSWORD=hunter2secret', 'hunter2secret'],
    ['GITHUB_TOKEN=abcdef0123456789xyz', 'abcdef0123456789xyz'],
    ['export ANTHROPIC_API_KEY=abcd1234efgh5678ijkl', 'abcd1234efgh5678ijkl'],
    ['STRIPE_SECRET=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['{"api_key":"abcd1234efgh5678"}', 'abcd1234efgh5678'],
    ['"password": "hunter2secret"', 'hunter2secret'],
    ['DATABASE_URL=postgres://user:hunter2secret@db:5432/x', 'hunter2secret'],
    ['mongodb+srv://admin:hunter2secret@cluster0.x.net', 'hunter2secret'],
    ['https://x.blob.core.windows.net/a?sv=1&sig=abcdEFGH1234%2Bxyz', 'abcdEFGH1234'],
    ['SECRET_KEY=abcd1234efgh5678', 'abcd1234efgh5678']
  ]
  for (const [input, secret] of hidden) {
    it(`伏せる: ${input}`, () => {
      const out = redactText(input)
      expect(out.text).not.toContain(secret)
      expect(out.hits.length).toBeGreaterThan(0)
    })
  }

  const kept = [
    'MAX_TOKENS=4096',
    'PASSWORD_MIN_LENGTH=12',
    'tokenizer=kuromoji',
    'TOKEN_SPLIT = /\\s+/',
    'password: string',
    'const t = process.env.GITHUB_TOKEN',
    'DATABASE_URL=postgres://user:${DB_PASS}@db:5432/x',
    'http://localhost:3000/path'
  ]
  for (const input of kept) {
    it(`伏せない: ${input}`, () => {
      expect(redactText(input).text).toBe(input)
    })
  }

  it('redactJson は親の鍵が機微なら値を形に関わらず伏せる', () => {
    const { value, hits } = redactJson({
      password: 'hunter2secret',
      api_key: 'abcd1234efgh5678',
      env: { GITHUB_TOKEN: 'abcdef0123456789xyz', max_tokens: 4096, tokenizer: 'kuromoji' },
      accessToken: 'x',
      password_min_length: 12
    })
    const s = JSON.stringify(value)
    expect(s).not.toMatch(/hunter2secret|abcd1234efgh5678|abcdef0123456789xyz/)
    expect(value.accessToken).toBe('[redacted]')
    expect(value.env.max_tokens).toBe(4096)
    expect(value.env.tokenizer).toBe('kuromoji')
    expect(value.password_min_length).toBe(12)
    expect(hits).toContain('json-key')
  })
})

describe('redactSlice — 窓で当てる (第 42 波 code-review 束 X)', () => {
  const none = { before: '', after: '', moreBefore: false, moreAfter: false }

  it('境目で鍵の名前が割れても、文脈の窓で値を伏せる', () => {
    const doc = 'config\nDB_PASSWORD=hunter2secret\nnext line\n'
    const cut = doc.indexOf('SSWORD')
    const slice = doc.slice(cut)
    // Not matched by the body alone (this is the hole before the fix)
    expect(redactText(slice).text).toContain('hunter2secret')
    const result = redactSlice(slice, { ...none, before: doc.slice(0, cut) })
    expect(result.text).not.toContain('hunter2')
    expect(result.text).toBe('SSWORD=[redacted]\nnext line\n')
  })

  it('値の途中で始まる / 終わるページも、交わる部分だけを伏せる', () => {
    const doc = 'a\napi_key=abcdefgh12345678\nb\n'
    const mid = doc.indexOf('12345678')
    const head = redactSlice(doc.slice(0, mid), { ...none, after: doc.slice(mid) })
    expect(head.text).toBe('a\napi_key=[redacted]')
    const tail = redactSlice(doc.slice(mid), { ...none, before: doc.slice(0, mid) })
    expect(tail.text).toBe('[redacted]\nb\n')
  })

  it('PEM の秘密鍵が窓の外まで続くときは、対の無い BEGIN / END から窓の端までを伏せる', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n'.repeat(4)
    const begin = 'x\n-----BEGIN RSA PRIVATE KEY-----\n'
    const end = '-----END RSA PRIVATE KEY-----\ny\n'
    // Only BEGIN is in the window, and the canonical copy continues after it
    expect(redactSlice(begin + body.slice(0, 40), { ...none, moreAfter: true }).text).toBe('x\n[redacted]')
    // Only END is in the window, and the canonical copy continues before it
    expect(redactSlice(body.slice(40) + end, { ...none, moreBefore: true }).text).toBe('[redacted]\ny\n')
    // In a window that reaches both ends of the canonical copy, an unpaired marker is not masked (same as redactText)
    expect(redactSlice('-----BEGIN RSA PRIVATE KEY----- only a header', none).text).toContain('BEGIN')
  })

  it('伏せ字 1 つの伸びは REDACTION_MAX_GROWTH 以下', () => {
    const doc = 'password=x\n'
    const result = redactSlice(doc.slice(9), { ...none, before: doc.slice(0, 9) })
    expect(result.text).toBe('[redacted]\n')
    expect(Buffer.byteLength(result.text) - Buffer.byteLength(doc.slice(9))).toBeLessThanOrEqual(
      REDACTION_MAX_GROWTH
    )
  })

  it('redactionRanges は redactText が伏せる値の範囲を覆う', () => {
    const doc = 'token: ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5 and postgres://u:pw1234@h/db'
    const masked = redactionRanges(doc).map((r) => doc.slice(r.start, r.end))
    expect(masked.join(' ')).toContain('ghp_A1b2C3d4E5')
    expect(masked).toContain('pw1234')
  })
})
