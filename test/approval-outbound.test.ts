/**
 * TODO 959 (ARCHITECTURE 4.2.1 "outbound operations ask by default"): outbound operations such as sending or posting are queued in the approval inbox
 * and not passed through, even under the default allow-everything or a rule. Reads pass as before.
 *
 *  - Judgment (`classifyOutbound` / `matchOutboundCommand` / `matchOutboundToolName`) against the real table in compat
 *  - `ApprovalBroker` + `DEFAULT_APPROVAL_POLICY`: queues, is not silenced by a rule, does not create "always allow", and the deadline (`expiresAt`)
 *  - `GatewayRequests`: carries the Adapter's `outboundAction` and the deadline (`approvalDeadline`) into the Broker
 *  - Notification text (`outboundNotifyText`), and the default strict mode for scheduled jobs (`validateScheduledJobInput`)
 *
 * Neither the model nor the CLI is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '../src/shared/agent.js'
import type { ApprovalItem, Thread } from '../src/shared/thread.js'
import { DEFAULT_APPROVAL_POLICY } from '../src/shared/thread.js'
import { validateScheduledJobInput } from '../src/shared/schedule.js'
import {
  classifyOutbound,
  matchOutboundCommand,
  matchOutboundToolName,
  type OutboundTable
} from '../src/main/approval/outbound.js'
import { ApprovalBroker, type ApprovalRequestInput, type ApprovalResult } from '../src/main/approval/broker.js'
import { APPROVAL_CANCEL_REASONS, fallbackApprovalReply } from '../src/main/approval/reply.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { AgentAdapter } from '../src/main/session/types.js'
import { outboundNotifyText } from '../src/main/notify.js'
import { loadOutboundVocabulary } from '../src/main/approval/outbound-vocabulary.js'
import { OpenCodeAdapter } from '../src/main/session/adapter-opencode/index.js'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'

const TABLE: OutboundTable = (() => {
  const table = loadCompatTable().outbound
  if (table === undefined) throw new Error('compat has no outbound table')
  return table
})()

const SHELL = TABLE.shellTools[0] ?? 'Bash'
const mcp = (server: string, tool: string): string => `${TABLE.mcpPrefix}${server}${TABLE.mcpSeparator}${tool}`

describe('shell commands (matchOutboundCommand, TODO 1191: only sending messages that reach people)', () => {
  const outbound: readonly [string, string][] = [
    // Writes to a chat webhook / API (ask, with the host limited)
    ['curl -X POST -H "Content-type: application/json" --data \'{"text":"hi"}\' https://hooks.slack.com/services/T0/B0/xyz', 'chat-webhook'],
    ['curl -d "payload={}" https://hooks.slack.com/services/T0/B0/xyz', 'chat-webhook'],
    ['curl -sSd text=hi -H "Authorization: Bearer $T" https://slack.com/api/chat.postMessage', 'chat-webhook'],
    ['curl -X POST https://slack.com/api/chat.update -d ts=1', 'chat-webhook'],
    ['curl -H "Content-Type: application/json" -d \'{"content":"hi"}\' https://discord.com/api/webhooks/1/abc', 'chat-webhook'],
    ['curl -F file=@a.png https://discordapp.com/api/webhooks/1/abc', 'chat-webhook'],
    ['curl --json \'{"content":"hi"}\' https://discord.com/api/v10/webhooks/1/abc', 'chat-webhook'],
    ['curl -X POST -d \'{"text":"hi"}\' https://contoso.webhook.office.com/webhookb2/x', 'chat-webhook'],
    ['curl -X POST -d \'{"text":"hi"}\' https://chat.googleapis.com/v1/spaces/S/messages?key=k', 'chat-webhook'],
    ['/usr/bin/curl --request POST https://HOOKS.slack.com/services/x', 'chat-webhook'],
    ['FOO=1 curl -d x https://hooks.slack.com/services/x', 'chat-webhook'],
    ['bash -c "curl -d x https://hooks.slack.com/services/x"', 'chat-webhook'],
    ['wget --post-data=a=1 https://hooks.slack.com/services/x', 'chat-webhook'],
    ['http POST https://hooks.slack.com/services/x text=hi', 'chat-webhook'],
    // review (1191): not slipped past by an uppercase scheme, a trailing dot, or a path containing `//`, `./`, or `..`.
    ['curl -d x HTTPS://hooks.slack.com/services/x', 'chat-webhook'],
    ['curl -d x https://hooks.slack.com./services/x', 'chat-webhook'],
    ['curl -d text=hi https://slack.com//api/./chat.postMessage', 'chat-webhook'],
    ['curl -d text=hi https://slack.com/x/../api/chat.postMessage', 'chat-webhook'],
    ['curl -d x https://discord.com/api/%2e/webhooks/1/abc', 'chat-webhook'],
    // review X-1: if the destination is a chat, ask regardless of method (Slack's Web API can post even with GET query).
    ["curl 'https://slack.com/api/chat.postMessage?channel=C&text=hi'", 'chat-webhook'],
    ['curl https://hooks.slack.com/services/x', 'chat-webhook'],
    ['wget -qO- https://hooks.slack.com/services/x', 'chat-webhook'],
    ['http GET https://hooks.slack.com/services/x', 'chat-webhook'],
    // review X-2: also catches a destination put into a variable within the same command.
    ['WEBHOOK=https://hooks.slack.com/services/x; curl -d x "$WEBHOOK"', 'chat-webhook'],
    ['export URL="https://hooks.slack.com/services/x" && curl -d x $URL', 'chat-webhook'],
    ["URL='https://slack.com/api/chat.postMessage'; curl --url \"$URL\" -d text=hi", 'chat-webhook'],
    // review X-3: subdomains (`*.` also includes the bare host).
    ['curl -d text=hi https://myteam.slack.com/api/chat.postMessage', 'chat-webhook'],
    ['curl -d text=hi https://www.slack.com/api/chat.postMessage', 'chat-webhook'],
    ['curl -d text=hi https://slack.com/api/chat.postMessage', 'chat-webhook'],
    ['curl -d x https://canary.discord.com/api/webhooks/1/abc', 'chat-webhook'],
    ['curl -d x https://ptb.discord.com/api/webhooks/1/abc', 'chat-webhook'],
    ['curl -d x https://discord.com/api/webhooks/1/abc', 'chat-webhook'],
    ['curl -d x https://sub.discordapp.com/api/webhooks/1/abc', 'chat-webhook'],
    // review X-4: double encoding, %2F as a path separator, and % in the host (if it cannot be decoded, lean toward asking).
    ['curl -d x https://hooks.slack.com/%2573ervices/x', 'chat-webhook'],
    ['curl -d x https://slack.com/api%2Fchat.postMessage', 'chat-webhook'],
    ['curl -d x https://slack.com/api/%252e/chat.postMessage', 'chat-webhook'],
    ['curl -d x https://hooks%2eslack.com/services/x', 'chat-webhook'],
    ['curl -d x https://discord.com/api/%77ebhooks%ZZ', 'chat-webhook'],
    ['curl -d x https://hooks.slack.com/%73ervices%ZZ/x', 'chat-webhook'],
    ['curl -d x https://slack.com/api/%63hat.postMessage%E3', 'chat-webhook'],
    ['curl -d x https://hooks.slack%zz.com/services/x', 'chat-webhook'],
    // Mail / osascript
    ['osascript -e \'tell application "Mail" to send theMessage\'', 'osascript-send'],
    ['sudo -u me sendmail a@example.com < mail.txt', 'mail'],
    ['echo body | mail -s hi a@example.com', 'mail']
  ]
  for (const [command, match] of outbound) {
    it(`asks: ${command}`, () => {
      expect(matchOutboundCommand(command)).toBe(match)
    })
  }

  const quiet = [
    // Generic curl / wget / httpie do not ask
    'curl -X POST https://hooks.example.com/x',
    'curl -d text=hi https://slack.example.com/api',
    'curl -sSd @body.json https://redmine.example.com/issues.json',
    'curl -XPUT https://api.example.com/a',
    'curl --data-binary @f https://x',
    'curl -s -X PUT http://127.0.0.1:9555/json/version',
    'wget --post-data=a=1 https://x',
    'http POST https://x a=1',
    // Even on a chat host, reading only does not ask; a different host asks
    'curl -X GET https://slack.com/api/conversations.list',
    'curl -d token=x https://slack.com/api/auth.test',
    'curl -d \'{"url":"https://hooks.slack.com/x"}\' https://example.com/api',
    'curl -d x https://notslack.com/api/chat.postMessage',
    'curl -d x https://hooks.slack.com.evil.example/x',
    'curl -d x https://hooks.slack.com%2eevil.example/x',
    'curl -d x https://evilslack.com/api/chat.postMessage',
    'WEBHOOK=https://hooks.slack.com/services/x; echo $WEBHOOK',
    'URL=https://example.com/a; curl -d x "$URL"',
    'curl -d x https://example.com/discord.com/api/webhooks/1',
    // Publishing, forwarding, gh, and git do not ask
    'gh pr create --fill',
    'gh issue comment 3 --body hi',
    'gh pr merge 12 --squash',
    'gh release create v1.0 --notes x',
    'gh api repos/o/r/issues -f title=t',
    'git push origin main',
    'git push --force origin main',
    'git -C "/a b" push',
    'git send-email --to a@example.com 0001.patch',
    'npm publish --access public',
    'docker push me/image:1',
    'cargo publish',
    'scp report.pdf me@host.example.com:/tmp/',
    'rsync -av ./dist/ me@host:/var/www/',
    'sftp me@host',
    'nc host.example.com 9000 < secret.txt',
    'aws s3 cp out.zip s3://bucket/key',
    'gsutil cp a.txt gs://bucket/',
    'rclone copy ./dir remote:bucket/dir',
    // Ordinary work
    'git status',
    'git commit -m "push later"',
    'grep -rn "git push" docs',
    'ls -la',
    'make all',
    'npm test',
    'osascript -e \'display notification "done"\'',
    'ssh host ls'
  ]
  for (const command of quiet) {
    it(`does not ask: ${command}`, () => {
      expect(matchOutboundCommand(command)).toBeNull()
    })
  }
})

describe('TODO 1169 / 1191: heredoc bodies are not matched by string even in the remaining-match check', () => {
  const trailers = ['', '\nnpm run typecheck && npm test', '\nmake', '\n$(cat f)']
  const hook = 'curl -X POST https://hooks.slack.com/services/x -d x'
  for (const body of [hook, 'sendmail a@example.com']) {
    for (const trailer of trailers) {
      it(`does not match data bodies: ${body} / trailer ${JSON.stringify(trailer)}`, () => {
        expect(matchOutboundCommand(`cat >> docs/notes/x.md <<'EOF'\n説明: ${body}\nEOF${trailer}`)).toBeNull()
      })
    }
  }
  it('matches delimiters other than the body', () => {
    expect(matchOutboundCommand(`cat > a <<'EOF'\nx\nEOF\n${hook}`)).toBe('chat-webhook')
    expect(matchOutboundCommand("cat <<'EOF' > a && curl -X POST -d x https://hooks.slack.com/x\nx\nEOF")).toBe('chat-webhook')
  })
  it('when the receiver is an interpreter, the body is looked at as before (only in the remaining-match check)', () => {
    expect(matchOutboundCommand("sh <<'EOF'\nsendmail a@example.com\nEOF")).toBe('mail')
    expect(matchOutboundCommand("cat > x.sh <<'EOF'\nsendmail a@example.com\nEOF\nbash x.sh")).toBe('mail')
  })
  it('gh release create inside a python3 body string does not match (the trigger of 1191)', () => {
    const script = [
      "python3 - <<'PY'",
      'import re',
      "text = open('RELEASE.md').read()",
      "text = text.replace('x', 'gh release create v1.2 -R o/r --notes-file notes.md')",
      "print('git push --force origin main')",
      'PY'
    ].join('\n')
    expect(matchOutboundCommand(script)).toBeNull()
    expect(classifyOutbound(TABLE, SHELL, { command: script })).toBeNull()
  })
})

describe('MCP tool names (matchOutboundToolName)', () => {
  it('names that send, post, or create something visible to people match', () => {
    expect(matchOutboundToolName('send_message')).toBe('send')
    expect(matchOutboundToolName('reply')).toBe('reply')
    expect(matchOutboundToolName('forward')).toBe('forward')
    expect(matchOutboundToolName('slack_post_message')).toBe('post')
    expect(matchOutboundToolName('createIssue')).toBe('create+issue')
    expect(matchOutboundToolName('update_issue')).toBe('update+issue')
    expect(matchOutboundToolName('add_comment_to_issue')).toBe('comment')
    expect(matchOutboundToolName('create_event')).toBe('create+event')
    expect(matchOutboundToolName('create_and_send_draft')).toBe('send')
    expect(matchOutboundToolName('push_files')).toBe('push')
    expect(matchOutboundToolName('create_or_update_file')).toBe('create+file')
    expect(matchOutboundToolName('delete_file')).toBe('delete+file')
    expect(matchOutboundToolName('create_branch')).toBe('create+branch')
    expect(matchOutboundToolName('create_repository')).toBe('create+repository')
    expect(matchOutboundToolName('fork_repository')).toBe('fork')
    expect(matchOutboundToolName('merge_pull_request')).toBe('merge')
  })

  it('names that read, drafts, and labels do not match', () => {
    for (const name of [
      'get_message',
      'search_threads',
      'list_labels',
      'get_comments',
      'slack_read_channel',
      'github_list_posts',
      'create_draft',
      'create_label',
      'update_label',
      'trash_message',
      'fetchThread',
      'get_file_contents',
      'list_branches',
      'list_commits',
      'search_repositories'
    ]) {
      expect(matchOutboundToolName(name), name).toBeNull()
    }
  })
})

describe('classifyOutbound (compat table)', () => {
  it('a shell tool extracts the whole command and an MCP tool extracts destination, subject, and body', () => {
    expect(classifyOutbound(TABLE, SHELL, { command: 'curl -X POST -d x=1 https://hooks.slack.com/services/T/B/x' })).toEqual({
      channel: 'shell',
      match: 'chat-webhook',
      to: null,
      subject: null,
      body: null,
      command: 'curl -X POST -d x=1 https://hooks.slack.com/services/T/B/x'
    })
    // TODO 1191: gh / push / publishing / forwarding / generic curl do not ask. Even in a compound command, if there is no remaining separator that asks, it does not ask.
    for (const command of [
      'git push origin main',
      'git push --force origin main',
      'git push origin main && gh release create v1 --notes x',
      "git push origin main && gh release create v1 --notes-file - <<'EOF'\nnotes\nEOF",
      'npm publish',
      'gh pr create --fill',
      'rsync -a dist/ host:/srv/site && git push origin main',
      'scp a.txt host:/tmp/',
      'curl -d x https://example.com',
      "git commit -F - <<'EOF'\ncurl -d x https://hooks.slack.com/x\nEOF\ngit push origin main"
    ]) {
      expect(classifyOutbound(TABLE, SHELL, { command }), command).toBeNull()
    }
    // If a separator that asks is mixed in, it asks under that name.
    expect(classifyOutbound(TABLE, SHELL, { command: 'git push origin main && sendmail a@example.com < m.txt' })).toMatchObject({
      match: 'mail'
    })
    const listed = TABLE.tools[0]
    if (listed === undefined) throw new Error('compat outbound.tools is empty')
    expect(
      classifyOutbound(TABLE, listed, { to: ['a@example.com', 'b@example.com'], subject: 'Hi', body: 'Hello' })
    ).toMatchObject({ channel: 'tool', match: 'listed', to: 'a@example.com, b@example.com', subject: 'Hi', body: 'Hello' })
    expect(
      classifyOutbound(TABLE, mcp('slack', 'post_message'), { channel: 'C123', text: 'deploy done' })
    ).toMatchObject({ channel: 'tool', match: 'post', to: 'channel: C123', subject: null, body: 'deploy done' })
  })

  it('read tools, built-in tools, and aios gateway tools do not match', () => {
    expect(classifyOutbound(TABLE, SHELL, { command: 'ls' })).toBeNull()
    expect(classifyOutbound(TABLE, SHELL, {})).toBeNull()
    expect(classifyOutbound(TABLE, mcp('slack', 'read_channel'), {})).toBeNull()
    expect(classifyOutbound(TABLE, 'WebFetch', { url: 'https://example.com' })).toBeNull()
    expect(classifyOutbound(TABLE, 'Write', { file_path: '/tmp/a', content: 'send' })).toBeNull()
    // The relay stage asks for plugin tools with side effects (7.6.7) - do not ask twice here.
    expect(classifyOutbound(TABLE, mcp('aios', 'aios_gmail__send'), {})).toBeNull()
  })

  it('every send tool listed by name is in the form of an MCP tool name and also matches by verb', () => {
    for (const name of TABLE.tools) {
      expect(name.startsWith(TABLE.mcpPrefix), name).toBe(true)
      const tool = name.slice(name.lastIndexOf(TABLE.mcpSeparator) + TABLE.mcpSeparator.length)
      expect(matchOutboundToolName(tool), name).not.toBeNull()
    }
  })
})

/** The Broker with the default policy. Records the decisions (including automatic allows). */
function makeBroker(): { broker: ApprovalBroker; changed: (readonly ApprovalItem[])[]; decided: ApprovalResult[] } {
  const changed: (readonly ApprovalItem[])[] = []
  const decided: ApprovalResult[] = []
  const broker = new ApprovalBroker(
    {
      onChanged: (items) => changed.push(items),
      onDecided: (_item, result) => decided.push(result)
    },
    DEFAULT_APPROVAL_POLICY
  )
  return { broker, changed, decided }
}

function requestOf(toolName: string, input: JsonValue, over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    threadId: 't1',
    threadTitle: 'T',
    toolName,
    summary: '',
    input,
    outbound: classifyOutbound(TABLE, toolName, input),
    ...over
  }
}

describe('ApprovalBroker: queues outbound operations even under the default of allow-all', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('outbound MCP tools and outbound Bash are queued, and read ones pass by: default', async () => {
    const { broker } = makeBroker()
    let settled = false
    void broker.request(requestOf(mcp('claude_ai_Gmail', 'send_message'), { to: 'a@example.com', body: 'x' })).then(() => {
      settled = true
    })
    void broker.request(requestOf(SHELL, { command: 'curl -X POST -d x=1 https://hooks.slack.com/services/T/B/x' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    const queued = broker.list()
    expect(queued).toHaveLength(2)
    expect(queued[0]?.outbound).toMatchObject({ channel: 'tool', to: 'a@example.com', body: 'x' })
    expect(queued[1]?.outbound).toMatchObject({ channel: 'shell', match: 'chat-webhook' })

    await expect(broker.request(requestOf(mcp('claude_ai_Gmail', 'get_message'), { id: '1' }))).resolves.toMatchObject({
      allowed: true,
      by: 'default'
    })
    await expect(broker.request(requestOf(SHELL, { command: 'curl -X POST -d x=1 https://example.com' }))).resolves.toMatchObject({
      allowed: true,
      by: 'default'
    })
    expect(broker.list()).toHaveLength(2)
  })

  it('"Always allow" creates no rule and an existing rule does not silence it', async () => {
    const { broker } = makeBroker()
    const tool = mcp('slack', 'post_message')
    const first = broker.request(requestOf(tool, { channel: 'C1', text: 'a' }))
    const id = broker.list()[0]?.id ?? ''
    expect(broker.decide(id, { kind: 'allow-always' })).toBe(true)
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(broker.listRules()).toEqual([])

    // Even if a rule was made by a call that does not go outside, a call that does go outside is queued.
    const plain = broker.request({ threadId: 't1', threadTitle: 'T', toolName: tool, summary: '', input: {}, strict: true })
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-always' })
    await plain
    expect(broker.listRules()).toHaveLength(1)
    void broker.request(requestOf(tool, { channel: 'C1', text: 'b' }))
    expect(broker.list()).toHaveLength(1)
  })

  it('after the deadline (expiresAt) it is refused by the system withdrawal (expired); answering earlier clears the deadline', async () => {
    vi.useFakeTimers()
    const { broker } = makeBroker()
    const late = broker.request(requestOf(SHELL, { command: 'sendmail a@example.com' }, { expiresAt: Date.now() + 60_000 }))
    const early = broker.request(requestOf(SHELL, { command: 'mail -s hi b@example.com' }, { expiresAt: Date.now() + 60_000 }))
    broker.decide(broker.list()[1]?.id ?? '', { kind: 'allow' })
    await expect(early).resolves.toMatchObject({ allowed: true, by: 'user' })
    vi.advanceTimersByTime(59_999)
    expect(broker.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await expect(late).resolves.toEqual({
      allowed: false,
      by: 'system',
      message: 'approval-cancelled-expired',
      reply: { kind: 'cancelled', reason: 'expired' }
    })
    expect(broker.list()).toHaveLength(0)
  })

  it('a request without a deadline keeps waiting (ordinary threads have no timeout)', async () => {
    vi.useFakeTimers()
    const { broker } = makeBroker()
    void broker.request(requestOf(SHELL, { command: 'sendmail a@example.com' }))
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
    expect(broker.list()).toHaveLength(1)
    broker.shutdown()
  })

  it('expired also has the English sentence returned to the model (neutral table and compat table)', () => {
    expect(APPROVAL_CANCEL_REASONS).toContain('expired')
    expect(fallbackApprovalReply({ kind: 'cancelled', reason: 'expired' })).toMatch(/NOT run/)
    expect(loadCompatTable().approvalReplies?.cancelled.expired).toMatch(/NOT run/)
  })
})

describe("GatewayRequests: carries the Adapter's judgment and the deadline on approve", () => {
  function setup(deadline: number | null): { requests: GatewayRequests; approvals: ApprovalRequestInput[] } {
    const approvals: ApprovalRequestInput[] = []
    const adapter = {
      outboundAction: (toolName: string, input: unknown) => classifyOutbound(TABLE, toolName, input)
    } as unknown as AgentAdapter
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
      getThread: (id) =>
        id === 't1'
          ? ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread)
          : null,
      getLive: () => undefined,
      getAdapter: () => adapter,
      emitThread: () => undefined,
      record: () => undefined,
      hasPlanMode: () => false,
      viewsOf: () => [],
      requestApproval: async (input) => {
        approvals.push(input)
        return { allowed: true, by: 'user', message: '' }
      },
      approvalDeadline: () => deadline
    }
    return { requests: new GatewayRequests(host as GatewayRequestHost), approvals }
  }

  it('carries outbound for an outbound operation and expiresAt for an unattended turn', async () => {
    const { requests, approvals } = setup(1_900_000_000_000)
    await requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: SHELL, input: { command: 'mail -s hi a@example.com' }, toolUseId: 'tu1' }
    })
    expect(approvals[0]?.outbound).toMatchObject({ channel: 'shell', match: 'mail' })
    expect(approvals[0]?.expiresAt).toBe(1_900_000_000_000)
  })

  it('a read has no outbound and an ordinary thread has no expiresAt either', async () => {
    const { requests, approvals } = setup(null)
    await requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName: SHELL, input: { command: 'ls' } } })
    expect(approvals[0]?.outbound).toBeUndefined()
    expect(approvals[0]?.expiresAt).toBeUndefined()
  })
})

describe('defaults for notifications and scheduled jobs', () => {
  it('the notification for an outbound operation shows neither destination nor body, and an unattended job gets the ⏰ heading', () => {
    expect(outboundNotifyText('Mail triage', false, 'en')).toEqual({
      title: 'Mail triage',
      body: 'Waiting for approval to send something outside'
    })
    expect(outboundNotifyText('朝の確認', true, 'ja')).toEqual({
      title: '⏰ 朝の確認',
      body: '定期実行が外へ送る操作の承認待ちで止まっています'
    })
  })

  it("a scheduled job's input reads an omitted strict mode as false (TODO 1015) and sets only an explicit true", () => {
    const base = {
      name: 'job',
      enabled: true,
      spec: { kind: 'daily', time: '08:00' },
      action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null }
    }
    const omitted = validateScheduledJobInput(base)
    expect(typeof omitted === 'object' && omitted.action.kind === 'prompt' && omitted.action.approvalStrict).toBe(false)
    const strict = validateScheduledJobInput({ ...base, action: { ...base.action, approvalStrict: true } })
    expect(typeof strict === 'object' && strict.action.kind === 'prompt' && strict.action.approvalStrict).toBe(true)
  })
})

describe('TODO 1020: both Adapters use the single vocabulary in compat/outbound.json', () => {
  const opencode = new OpenCodeAdapter({ link: { baseUrl: 'http://127.0.0.1:9', authorization: 'x' } }, loadOpenCodeTable())
  const commands = [
    'git push origin main',
    'curl -X POST https://example.com -d a=1',
    'curl -X POST -d x=1 https://hooks.slack.com/services/T/B/x',
    'gh pr create --fill',
    'npm publish',
    'sendmail a@example.com < body.txt',
    'osascript -e \'tell application "Mail" to send m\'',
    'scp a.txt host:/tmp/',
    'ls -la',
    'git status',
    'curl https://example.com'
  ]

  it('the vocabulary is readable and has no missing keys', () => {
    const vocabulary = loadOutboundVocabulary()
    expect(vocabulary.mcp.sendVerbs).toContain('send')
    expect(vocabulary.shell.chatEndpoints).toContain('hooks.slack.com')
    expect(vocabulary.display.to[0]).toBe('to')
  })

  it("the same judgment applies to OpenCode's shell (shell → Bash)", () => {
    for (const command of commands) {
      const claude = classifyOutbound(TABLE, SHELL, { command })
      const other = opencode.outboundAction('Bash', { command })
      expect(other?.match ?? null, command).toBe(claude?.match ?? null)
    }
    expect(opencode.outboundAction('Bash', { command: 'sendmail a@example.com' })).toMatchObject({ channel: 'shell', match: 'mail' })
    // Writes, web fetches, and confirming paths outside the working folder are not outbound operations.
    expect(opencode.outboundAction('Edit', { path: 'a.ts', oldString: 'a', newString: 'send' })).toBeNull()
    expect(opencode.outboundAction('WebFetch', { url: 'https://example.com' })).toBeNull()
    expect(opencode.outboundAction('ExternalDirectory', { path: '/etc', resources: ['/etc/*'] })).toBeNull()
  })

  it("through GatewayRequests, OpenCode's push also carries outbound, a write that can show a diff is diffable, and a refusal has no message", async () => {
    const approvals: ApprovalRequestInput[] = []
    let answer: ApprovalResult = { allowed: true, by: 'user', message: '' }
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
      getThread: (id) =>
        id === 't1'
          ? ({ id, title: 'T', backend: 'opencode', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread)
          : null,
      getLive: () => undefined,
      getAdapter: () => opencode,
      emitThread: () => undefined,
      record: () => undefined,
      hasPlanMode: () => false,
      viewsOf: () => [],
      // The write target can be read (writeToolTargetPath), so the check proceeds to draft collision matching.
      conflictingViews: () => [],
      requestApproval: async (input) => {
        approvals.push(input)
        return answer
      },
      approvalDeadline: () => null
    }
    const requests = new GatewayRequests(host as GatewayRequestHost)
    await requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName: 'Bash', input: { command: 'sendmail a@example.com' } } })
    expect(approvals[0]?.outbound).toMatchObject({ channel: 'shell', match: 'mail' })
    await requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: 'Edit', input: { path: 'a.ts', oldString: 'a', newString: 'b' } }
    })
    expect(approvals[1]?.diffable).toBe(true)
    expect(approvals[1]?.outbound).toBeUndefined()
    answer = { allowed: false, by: 'user', message: 'denied', reply: { kind: 'stop' } }
    const denied = (await requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName: 'Bash', input: { command: 'ls' } } })) as {
      allowed: boolean
      message: string
    }
    expect(denied).toMatchObject({ allowed: false, message: '' })
    answer = { allowed: false, by: 'user', message: 'use git status', reply: { kind: 'feedback', text: 'use git status' } }
    const corrected = (await requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName: 'Bash', input: { command: 'ls' } } })) as {
      message: string
    }
    expect(corrected.message).toBe('use git status')
  })
})
