/**
 * TODO 1042: writes that stay resident or remove the gate are asked about even by default (`src/main/approval/persistence.ts`; the tables are `persistence` in `compat/outbound.json`
 * and `persistence` in each Adapter's compat table).
 *
 * - Judgment: paths for Write / Edit (relative, `~`, realpath), Bash redirection, writing commands, and crontab / launchctl / git config.
 * - Ordinary work (editing source in the working folder, `npm install`, `git commit`) does not match.
 * - Broker: queued even under default allow-everything, even in the set of never-asked commands, and even when a rule exists; no "always allow" is created. The reason is `persistence`.
 *
 * Neither the model nor the CLI is called.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_POLICY, approvalQueueReasonCode } from '../src/shared/thread.js'
import { classifyPersistenceCommand } from '../src/main/approval/persistence.js'
import { matchPathPattern, pathSegments } from '../src/main/approval/path-pattern.js'
import { ApprovalBroker, type ApprovalRequestInput } from '../src/main/approval/broker.js'
import { ClaudeCodeAdapter } from '../src/main/session/adapter/index.js'
import { OpenCodeAdapter } from '../src/main/session/adapter-opencode/index.js'
import { approvalReasonMessage } from '../src/renderer/src/approval-reason.js'
import { isQuietCommand } from '../src/main/approval/quiet.js'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '../src/shared/thread.js'
import { pathToUri } from '../src/common/uri.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { AgentAdapter } from '../src/main/session/types.js'

const adapter = new ClaudeCodeAdapter()
const opencode = new OpenCodeAdapter()
const SETTINGS_DIR = '.claude'

describe('パスの形 (path-pattern.ts)', () => {
  it('** は 0 段以上、* は 1 段の中。大文字小文字と . / .. を揃える', () => {
    expect(matchPathPattern('/Users/me/.zshrc', '**/.zshrc')).toBe(true)
    expect(matchPathPattern('~/.ZSHRC', '**/.zshrc')).toBe(true)
    expect(matchPathPattern('.zshrc', '**/.zshrc')).toBe(true)
    expect(matchPathPattern('/Library/LaunchAgents/x.plist', '**/Library/LaunchAgents/**')).toBe(true)
    expect(matchPathPattern('repo/.git/x/../hooks/pre-commit', '**/.git/hooks/**')).toBe(true)
    expect(matchPathPattern('src/zshrc.ts', '**/.zshrc')).toBe(false)
    expect(matchPathPattern('a/settings.json', '**/b/settings*.json')).toBe(false)
    expect(matchPathPattern('b/settings.local.json', '**/b/settings*.json')).toBe(true)
    expect(pathSegments('/a//./b/../c')).toEqual(['a', 'c'])
  })
})

describe('Write / Edit (Adapter の persistenceAction)', () => {
  const edit = (path: string, resolve?: (p: string) => readonly string[]) =>
    adapter.persistenceAction('Edit', { file_path: path, old_string: 'a', new_string: 'b' }, resolve)

  it.each([
    ['/Users/me/.zshrc', 'shell-startup'],
    ['/Users/me/.bash_profile', 'shell-startup'],
    ['/Users/me/Library/LaunchAgents/com.x.plist', 'launch-agent'],
    ['/repo/.git/hooks/pre-commit', 'git-hooks'],
    ['/repo/.git/config', 'git-hooks'],
    ['/Users/me/.gitconfig', 'git-config'],
    ['/Users/me/.ssh/authorized_keys', 'ssh'],
    ['/Users/me/.ssh/config', 'ssh'],
    ['/repo/.mcp.json', 'mcp-config'],
    [`/Users/me/${SETTINGS_DIR}/settings.json`, 'cli-settings'],
    [`/repo/${SETTINGS_DIR}/settings.local.json`, 'cli-settings'],
    [`/Users/me/${SETTINGS_DIR}.json`, 'cli-settings']
  ])('聞く: %s (%s)', (path, match) => {
    expect(edit(path)).toEqual({ match, target: path })
  })

  it.each([
    '/repo/src/main.ts',
    '/repo/package.json',
    '/repo/README.md',
    '/repo/.gitignore',
    '/repo/.github/workflows/ci.yml',
    `/repo/${SETTINGS_DIR}/worktrees/agent-x/src/a.ts`,
    `/repo/${SETTINGS_DIR}/skills/x/SKILL.md`,
    '/repo/docs/zshrc.md'
  ])('聞かない (普段の作業): %s', (path) => {
    expect(edit(path)).toBeNull()
  })

  it('symlink の先 (resolve が返す realpath) も見る', () => {
    expect(edit('notes.txt', () => ['/repo/notes.txt', '/Users/me/.zshrc'])).toEqual({ match: 'shell-startup', target: 'notes.txt' })
    expect(edit('notes.txt', () => ['/repo/notes.txt'])).toBeNull()
  })

  it('読むだけの道具は見ない', () => {
    expect(adapter.persistenceAction('Read', { file_path: '/Users/me/.zshrc' })).toBeNull()
  })

  it('OpenCode: 書き込みの道具の読み替えた名前と、OpenCode の設定の置き場', () => {
    expect(opencode.persistenceAction('Write', { path: '/Users/me/.zshrc', content: 'x' })?.match).toBe('shell-startup')
    expect(opencode.persistenceAction('Edit', { path: '/repo/opencode.json', oldString: 'a', newString: 'b' })?.match).toBe('cli-settings')
    expect(opencode.persistenceAction('Bash', { command: 'echo x >> ~/.zshrc' })?.match).toBe('shell-startup')
    expect(opencode.persistenceAction('Write', { path: '/repo/src/a.ts', content: 'x' })).toBeNull()
  })
})

describe('Bash (classifyPersistenceCommand)', () => {
  it.each([
    ['echo "export PATH=/x:$PATH" >> ~/.zshrc', 'shell-startup'],
    ['echo x>>$HOME/.bashrc', 'shell-startup'],
    ['printf x > "${HOME}/.zprofile"', 'shell-startup'],
    ['cat > ~/Library/LaunchAgents/com.x.plist <<\'EOF\'\n<plist/>\nEOF', 'launch-agent'],
    ['cp evil.plist ~/Library/LaunchAgents/', 'launch-agent'],
    ['tee -a ~/.ssh/authorized_keys < key.pub', 'ssh'],
    ['ln -s ../../hook.sh .git/hooks/pre-commit', 'git-hooks'],
    ['chmod +x .git/hooks/pre-commit', 'git-hooks'],
    ['sed -i "" "s/a/b/" ~/.gitconfig', 'git-config'],
    ["sed 'w /Users/me/.zshrc' payload", 'shell-startup'],
    ['sort -o ~/.zshrc payload', 'shell-startup'],
    ['uniq payload ~/.zshrc', 'shell-startup'],
    ['tar -xf evil.tar ~/.ssh/authorized_keys', 'ssh'],
    ['unzip evil.zip .git/hooks/pre-commit', 'git-hooks'],
    ['jq . a.json > ~/.zshrc', 'shell-startup'],
    // review fix (X): the expansion target (-C / -d) is home or the table's parent, and git --output
    ['tar -xf a.tar -C ~', 'shell-startup'],
    ['tar -C $HOME -xzf a.tgz', 'shell-startup'],
    ['tar xf a.tar --directory=/Users/me', 'shell-startup'],
    ['tar -xf a.tar -C ~/.ssh', 'ssh'],
    ['tar -cf ~/.zshrc src', 'shell-startup'],
    ['unzip a.zip -d ~/.ssh', 'ssh'],
    ['unzip -o a.zip -d "$HOME"', 'shell-startup'],
    ['git diff --output=$HOME/.zshrc', 'shell-startup'],
    ['git log --output ~/.zshrc', 'shell-startup'],
    ['git show --outp=~/.bashrc HEAD', 'shell-startup'],
    ["sed -n 'w ~/.zshrc' payload", 'shell-startup'],
    ["sed 's/a/b/w /Users/me/.zshrc' payload", 'shell-startup'],
    ['awk \'BEGIN{print "x" > "/Users/me/" ".zshrc"}\'', 'shell-startup'],
    ['python3 -c "open(\'/Users/me/.zshrc\',\'a\').write(\'x\')"', 'shell-startup'],
    ['bash -c "echo x >> ~/.zshrc"', 'shell-startup'],
    ['sudo tee /Library/LaunchDaemons/x.plist', 'launch-agent'],
    ['crontab -', 'crontab'],
    ['crontab my.cron', 'crontab'],
    ['echo "* * * * * x" | crontab', 'crontab'],
    ['crontab -e', 'crontab'],
    ['launchctl load ~/Library/LaunchAgents/x.plist', 'launchctl'],
    ['launchctl bootstrap gui/501 x.plist', 'launchctl'],
    ['git config core.hooksPath .hooks', 'git-config'],
    ['git config --global alias.st "!sh x"', 'git-config'],
    ['git -C /repo config --local core.fsmonitor ./x', 'git-config'],
    ['git config set core.pager "sh x"', 'git-config'],
    ['git config --global --edit', 'git-config'],
    ['echo "{}" > .mcp.json', 'mcp-config'],
    // review 57-1: a redirection target that is only partly quoted (a word is split by quotes, so `/.zshrc` matches)
    ['echo x >> "$HOME"/.zshrc', 'shell-startup'],
    ['echo x >> ~/".zshrc"', 'shell-startup'],
    ['printf x > "${HOME}"/.ssh/authorized_keys', 'ssh'],
    ["echo x >> ~/'.bash_profile'", 'shell-startup'],
    // TODO 1206: even after narrowing, the forms that really write still match
    ["cat > /tmp/a <<'EOF'\nx\nEOF\ncat > .mcp.json <<'EOF'\n{}\nEOF", 'mcp-config'],
    ['python3 /tmp/x.py && echo {} >> .mcp.json', 'mcp-config'],
    ['echo {} | tee .mcp.json', 'mcp-config'],
    ['cp /tmp/x.json project/.mcp.json', 'mcp-config'],
    ['mv /tmp/x.json "$HOME"/.mcp.json', 'mcp-config'],
    ['echo x > /tmp/a && cp evil ~/.zshrc', 'shell-startup'],
    ['cat >"$HOME/.zshrc" <<EOF\nx\nEOF', 'shell-startup'],
    // TODO 1206 (security review): when the write target is not statically known, all words are matched as before
    ['VAR=~/.zshrc; echo x >> "$VAR"', 'shell-startup'],
    ['cd ~ && echo x >> .zshrc', 'shell-startup'],
    ['echo x > "$(echo ~/.zshrc)"', 'shell-startup'],
    ['F=.mcp.json; cp /tmp/a "$F"', 'mcp-config'],
    ['echo .mcp.json | xargs cp /tmp/a', 'mcp-config'],
    ['cd .git/hooks && cp /tmp/a pre-commit', 'git-hooks'],
    // review 82: forms where the working-folder change is not at the head of the statement, or the wrapper flag form, also go back to matching all words
    ['(cd .git/hooks && cp /tmp/a pre-commit)', 'git-hooks'],
    ['{ cd .git/hooks; cp /tmp/a pre-commit; }', 'git-hooks'],
    ['if cd .git/hooks; then cp /tmp/a pre-commit; fi', 'git-hooks'],
    ['builtin cd .git/hooks && cp /tmp/a pre-commit', 'git-hooks'],
    ['env -C .git/hooks cp /tmp/a pre-commit', 'git-hooks'],
    ['(cd ~ && echo x >> .zshrc)', 'shell-startup'],
    ['pushd /tmp; popd; echo x >> .zshrc', 'shell-startup'],
    ['for f in a; do cp /tmp/a .mcp.json; done', 'mcp-config'],
    ['if true; then tee .mcp.json < /tmp/a; fi', 'mcp-config'],
    ['then sudo cp /tmp/a .mcp.json', 'mcp-config'],
    // wave 82 review: no narrowing. Outside the writing statement, inside an interpreter, or with a writer not in the table, the whole-statement words are matched if it is a writing command
    ["python3 -c \"import os; open(os.path.expanduser('~/.zshrc'),'a').write('x')\"", 'shell-startup'],
    ["node -e \"const fs=require('fs'); fs.appendFileSync('/Users/u/.zshrc','x')\"", 'shell-startup'],
    ["python3 <<EOF\nopen('/Users/u/.zshrc','a').write('x')\nEOF", 'shell-startup'],
    ["python3 - <<'PY'\nimport pathlib\npathlib.Path('/Users/u/.zshrc').write_text('x')\nPY", 'shell-startup'],
    ['rm ~/.zshrc 2>/dev/null', 'shell-startup'],
    ["echo hi > /tmp/a; vim -es -c 'wq' ~/.zshrc", 'shell-startup'],
    ["cat > /tmp/upd.py <<'EOF'\nimport re\nEOF\npython3 /tmp/upd.py && cat .mcp.json", 'mcp-config'],
    ['cp a.txt b.txt && cat .mcp.json', 'mcp-config'],
    // A heredoc, pipe, or stderr-only redirection that is not redirected to a file: if it could run, its body is matched
    ["cat <<EOF | sh\necho x >> ~/.zshrc\nEOF", 'shell-startup'],
    ["eval \"$(cat <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["cat <<EOF 2>/dev/null; bash /tmp/x\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["cat <<EOF > >(sh)\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    // Security review (4th time): forms where it cannot be said that output ends in an ordinary file, and redirections of another command, are not dropped
    ["cat > /tmp/f <<EOF > /dev/stdout | sh\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["eval \"$(cat > /tmp/f <<EOF >&1\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["eval \"$(cat > /tmp/f <<EOF > /dev/stdout\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["echo a > /tmp/log & cat <<EOF; bash /tmp/x\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["{ echo a > /tmp/log; cat <<EOF; } | sh\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["tee /tmp/f <<EOF > /tmp/g; sh /tmp/f\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["cat <<EOF > /tmp/f > >(sh)\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    // 5th time: `>` inside a comment or quotes, variants of fd notation, a target that normalizes to /dev, and a variable target are not treated as definitely a file
    ["cat <<EOF # > /tmp/f\ncp /tmp/a ~/.zshrc\nEOF\nbash /tmp/x", 'shell-startup'],
    ["cat '>' /tmp/f <<EOF | sh\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["eval \"$(cat 01> /tmp/f <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["eval \"$(cat > /tmp/../dev/stdout <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["eval \"$(cat > //dev/stdout <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["O=/dev/stdout; eval \"$(cat > $O <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    // 6th time: the target is a symlink or fifo, or a relative path after cd, so something could receive the output
    ["ln -s /dev/stdout /tmp/f; eval \"$(cat > /tmp/f <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["cd /dev && cat > stdout <<EOF | sh\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["eval \"$(cat > /tmp/f <<EOF\ncp /tmp/a ~/.zshrc\nEOF\n)\"", 'shell-startup'],
    ["mkfifo /tmp/p; sh /tmp/p & cat > /tmp/p <<EOF\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["cat <> /tmp/f <<EOF | sh\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    // 7th time: forms that slip past the word table with quotes or backslashes, and forms that read in the background
    ["\\cd /dev; cat > stdout <<EOF\ncp /tmp/a ~/.zshrc\nEOF\nbash /tmp/x", 'shell-startup'],
    ["'ln' -s /dev/stdout /tmp/f; cat > /tmp/f <<EOF\ncp /tmp/a ~/.zshrc\nEOF\nbash /tmp/x", 'shell-startup'],
    ["sh /tmp/p & cat > /tmp/p <<EOF\ncp /tmp/a ~/.zshrc\nEOF", 'shell-startup'],
    ["/bin/ln -s /dev/stdout /tmp/f; cat > /tmp/f <<EOF\ncp /tmp/a ~/.zshrc\nEOF\nbash /tmp/x", 'shell-startup'],
    ["l$@n -s /dev/stdout /tmp/f; cat > /tmp/f <<EOF\ncp /tmp/a ~/.zshrc\nEOF\nbash /tmp/x", 'shell-startup'],
    ["cat > ~/.zshrc <<'EOF'\nx\nEOF\npython3 /tmp/u.py", 'shell-startup'],
    ['pushd ~/.ssh; tee authorized_keys < /tmp/k', 'ssh'],
    ['X=$(echo .mcp.json); python3 /tmp/w.py "$X"', 'mcp-config']
  ])('聞く: %s (%s)', (command, match) => {
    expect(classifyPersistenceCommand(command)?.match).toBe(match)
  })

  it.each([
    'npm install',
    'npm ci && npm run build',
    'git add -A && git commit -m "fix: update .zshrc docs"',
    'git push origin main',
    'cat ~/.zshrc',
    'grep -n PATH ~/.zshrc ~/.bash_profile',
    'ls -la ~/.ssh',
    'ls .git/hooks',
    'cat .mcp.json',
    'crontab -l',
    'launchctl list',
    'git config user.name me',
    'git config --get core.hooksPath',
    'git config --list',
    'echo x > src/a.ts && cp a b',
    'cat > README.md <<\'EOF\'\nAdd `echo x >> ~/.zshrc` to your shell\nEOF',
    'npx vitest run test/a.test.ts 2>&1 | tail -20',
    'make all > build.log 2>&1',
    // review fix (X): read-only sed / awk / jq / sort / uniq / tar / unzip are not asked about
    "sed -n '1,20p' ~/.zshrc",
    "sed 's/a/b/' ~/.zshrc",
    'jq . ~/.claude/settings.json',
    'jq .a ~/.ssh/config',
    'grep PATH ~/.zshrc | sort',
    'sort ~/.zshrc',
    'uniq ~/.zshrc',
    "awk '{print $1}' ~/.zshrc",
    'tar tf backup.tar',
    'tar -tzf ~/.ssh/backup.tgz',
    'tar -cf backup.tar ~/.zshrc',
    'tar -xf a.tar -C out',
    'unzip -l ~/.ssh/a.zip',
    'unzip a.zip -d out',
    'unzip -p a.zip x > out.txt',
    'git diff --output=out.patch',
    'git log --oneline -5',
    // TODO 1206: even if there is a redirection, if the target is outside protection, words of another statement or another separator are not matched
    "cat > /tmp/upd.py <<'EOF'\nimport re\np = 'x/.mcp.json'\nEOF\npython3 /tmp/upd.py",
    // TODO 1206: the body of a heredoc redirected to a file is not seen as words, even if it is run later
    "cat <<'EOF' > /tmp/upd.py\nopen('.mcp.json')\nEOF\npython3 /tmp/upd.py",
    "cat > /tmp/a.sh <<EOF\necho x >> ~/.zshrc\nEOF\nbash /tmp/a.sh"
  ])('聞かない: %s', (command) => {
    expect(classifyPersistenceCommand(command)).toBeNull()
  })
})

describe('Broker: 既定でも聞かない定番でも規則があっても積む', () => {
  function makeBroker(): ApprovalBroker {
    return new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, DEFAULT_APPROVAL_POLICY)
  }
  const request = (over: Partial<ApprovalRequestInput>): ApprovalRequestInput => ({
    threadId: 't1',
    threadTitle: 'T',
    toolName: 'Edit',
    summary: '',
    input: { file_path: '/Users/me/.zshrc' },
    persistence: { match: 'shell-startup', target: '/Users/me/.zshrc' },
    ...over
  })

  it('Bypass 相当の既定で Edit の ~/.zshrc は積まれ、理由は persistence', async () => {
    const broker = makeBroker()
    void broker.request(request({}))
    const item = broker.list()[0]
    expect(item?.reason).toEqual({ kind: 'persistence', match: 'shell-startup', target: '/Users/me/.zshrc' })
    expect(approvalQueueReasonCode(item!.reason!)).toBe('persistence:shell-startup')
    expect(approvalReasonMessage(item!)).toEqual({ key: 'approval.reason.persistence', params: { target: '/Users/me/.zshrc' } })
  })

  it('聞かない定番の表に入る Bash (echo >> ~/.zshrc) でも積む', async () => {
    const command = 'echo x >> ~/.zshrc'
    expect(isQuietCommand(command)).toBe(true)
    const broker = makeBroker()
    void broker.request(
      request({ toolName: 'Bash', input: { command }, persistence: classifyPersistenceCommand(command), strict: true })
    )
    expect(broker.list()).toHaveLength(1)
    expect(broker.list()[0]?.quietHosts).toBeUndefined()
  })

  it('「常に許可」は作らず、次も積む', async () => {
    const broker = makeBroker()
    const first = broker.request(request({}))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-always' })
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(broker.listRules()).toHaveLength(0)
    void broker.request(request({}))
    expect(broker.list()).toHaveLength(1)
  })

  it('当たらない書き込みは今までどおり既定で通る', async () => {
    const broker = makeBroker()
    await expect(broker.request(request({ input: { file_path: '/repo/src/a.ts' }, persistence: null }))).resolves.toMatchObject({
      allowed: true,
      by: 'default'
    })
  })
})

describe('GatewayRequests: approve に居座りの判定を載せる (相対パスは作業フォルダで解く)', () => {
  function setup(cwd: string): { requests: GatewayRequests; approvals: ApprovalRequestInput[] } {
    const approvals: ApprovalRequestInput[] = []
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
      getThread: (id) =>
        id === 't1'
          ? ({ id, title: 'T', backend: 'x', cwdUri: pathToUri(cwd), worktreeUri: null, approvalStrict: false } as unknown as Thread)
          : null,
      getLive: () => undefined,
      getAdapter: () => adapter as unknown as AgentAdapter,
      emitThread: () => undefined,
      record: () => undefined,
      hasPlanMode: () => false,
      viewsOf: () => [],
      conflictingViews: () => [],
      requestApproval: async (input) => {
        approvals.push(input)
        return { allowed: true, by: 'user', message: '' }
      }
    }
    return { requests: new GatewayRequests(host as GatewayRequestHost), approvals }
  }
  const approve = (requests: GatewayRequests, toolName: string, input: Record<string, unknown>) =>
    requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName, input, toolUseId: 'tu1' } })

  it('作業フォルダの中の .git/hooks は相対パスでも当たり、ソースの編集・npm install・git commit は当たらない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aios-persist-'))
    try {
      mkdirSync(join(root, 'src'))
      const { requests, approvals } = setup(root)
      await approve(requests, 'Write', { file_path: '.git/hooks/pre-commit', content: 'x' })
      await approve(requests, 'Write', { file_path: 'src/a.ts', content: 'x' })
      await approve(requests, 'Bash', { command: 'npm install && git add -A && git commit -qm x' })
      expect(approvals[0]?.persistence).toEqual({ match: 'git-hooks', target: '.git/hooks/pre-commit' })
      expect(approvals[1]?.persistence).toBeUndefined()
      expect(approvals[2]?.persistence).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('作業フォルダの中の symlink の先が起動ファイルなら当たる', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aios-persist-'))
    try {
      mkdirSync(join(root, 'home'))
      writeFileSync(join(root, 'home', '.zshrc'), '')
      symlinkSync(join(root, 'home', '.zshrc'), join(root, 'notes.txt'))
      const { requests, approvals } = setup(root)
      await approve(requests, 'Edit', { file_path: 'notes.txt', old_string: 'a', new_string: 'b' })
      expect(approvals[0]?.persistence?.match).toBe('shell-startup')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
