/**
 * @vitest-environment jsdom
 *
 * `.diff` / `.patch` are shown read-only (TODO 901, plugins/aios.diff/viewer/patch-view.ts).
 */
import { describe, expect, it } from 'vitest'
import { mountPatchView, parsePatch, patchRenderKey } from '../plugins/aios.diff/viewer/patch-view.js'

const git = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '--- removed line that looks like a header',
  '+added',
  ' tail',
  'diff --git a/b.txt b/b.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/b.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('parsePatch / mountPatchView (TODO 901)', () => {
  it('splits multiple files lined up with diff --git into sections and counts --- inside a hunk as a deleted line', () => {
    const files = parsePatch(git)
    expect(files.map((f) => f.name)).toEqual(['src/a.ts', 'b.txt'])
    const lines = files[0]!.hunks[0]!.lines
    expect(lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'ctx'])
    expect(lines[1]).toMatchObject({ text: '-- removed line that looks like a header', oldNo: 2, newNo: null })
    expect(lines[2]).toMatchObject({ newNo: 2 })
    expect(files[1]!.notes).toEqual(['new file mode 100644'])
    expect(files[1]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['add', 'note'])
  })

  it('also parses a plain diff -u (only --- / +++)', () => {
    const text = '--- a/x.txt\t2024-01-01\n+++ b/x.txt\t2024-01-02\n@@ -1 +1 @@\n-a\n+b\n--- y\n+++ y\n@@ -1 +1 @@\n-c\n+d\n'
    expect(parsePatch(text).map((f) => f.name)).toEqual(['x.txt', 'y'])
  })

  it('draws into the DOM and has no editing parts; shows guidance when it does not look like a diff', () => {
    const root = document.createElement('div')
    mountPatchView(root, { text: git, truncated: true, emptyLabel: 'none', truncatedLabel: 'trunc' })
    expect(root.querySelectorAll('.patch-file')).toHaveLength(2)
    expect(root.querySelectorAll('.patch-add')).toHaveLength(2)
    expect(root.querySelectorAll('.patch-del')).toHaveLength(1)
    expect(root.querySelector('.banner')?.textContent).toBe('trunc')
    expect(root.querySelector('textarea, input, [contenteditable]')).toBeNull()
    const empty = document.createElement('div')
    mountPatchView(empty, { text: 'just text', truncated: false, emptyLabel: 'none', truncatedLabel: 't' })
    expect(empty.textContent).toBe('none')
  })

  it("does not make the next file's heading a deleted line even when the hunk count is larger than the actual", () => {
    const text = [
      '--- a/one',
      '+++ b/one',
      '@@ -1,2 +1,3 @@',
      '-x',
      '-y',
      'diff --git a/next b/next',
      '--- a/next',
      '+++ b/next',
      '@@ -1 +1 @@',
      '-p',
      '+q',
      ''
    ].join('\n')
    const files = parsePatch(text)
    expect(files.map((f) => f.name)).toEqual(['one', 'next'])
    expect(files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'del'])
    expect(files[1]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'add'])
    // Even a heading with only --- / +++ (no diff --git) starts a new file when @@ follows
    const plain = parsePatch('--- a/o\n+++ b/o\n@@ -1,1 +1,3 @@\n-x\n--- a/n\n+++ b/n\n@@ -1 +1 @@\n-p\n+q\n')
    expect(plain.map((f) => f.name)).toEqual(['o', 'n'])
    expect(plain[0]!.hunks[0]!.lines).toHaveLength(1)
  })

  it('does not continue a hunk with the marker of the side whose count is used up (the count never goes negative)', () => {
    const files = parsePatch('--- a/o\n+++ b/o\n@@ -1,1 +1,1 @@\n-x\n-y\n+z\n')
    expect(files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'add'])
  })

  it('the same body and language give the same re-render key, and it changes when the body or language changes', () => {
    expect(patchRenderKey('a', false, 'en')).toBe(patchRenderKey('a', false, 'en'))
    expect(patchRenderKey('a', false, 'en')).not.toBe(patchRenderKey('b', false, 'en'))
    expect(patchRenderKey('a', false, 'en')).not.toBe(patchRenderKey('a', false, 'ja'))
    expect(patchRenderKey('a', false, 'en')).not.toBe(patchRenderKey('a', true, 'en'))
  })
})

describe('patch hunk navigation (TODO 1341)', () => {
  const text = [
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '@@ -10 +10 @@',
    '-c',
    '+d',
    '@@ -20 +20 @@',
    '-e',
    '+f',
    ''
  ].join('\n')
  const mount = (): { root: HTMLElement; handle: ReturnType<typeof mountPatchView>; wrap: HTMLElement } => {
    const root = document.createElement('div')
    document.body.append(root)
    const handle = mountPatchView(root, { text, truncated: false, emptyLabel: 'none', truncatedLabel: 't' })
    return { root, handle, wrap: root.querySelector<HTMLElement>('.patch-view')! }
  }
  const press = (init: KeyboardEventInit): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init }))
  }
  it('has the same buttons and keys, stays at the top on open, and shows N / M', () => {
    const { root, handle, wrap } = mount()
    expect(handle.hunkCount).toBe(3)
    expect(handle.hunk).toBe(-1)
    expect(wrap.scrollTop).toBe(0)
    expect(root.querySelector('.diff-nav-pos')?.textContent).toBe('– / 3')
    root.querySelector<HTMLButtonElement>('button[data-nav="next"]')!.click()
    expect(handle.hunk).toBe(0)
    press({ key: 'F7' })
    press({ key: 'F5', altKey: true })
    expect(handle.hunk).toBe(2)
    press({ key: 'F7' })
    expect(handle.hunk).toBe(0)
    press({ key: 'F7', shiftKey: true })
    expect(handle.hunk).toBe(2)
    expect(root.querySelector('.diff-nav-pos')?.textContent).toBe('3 / 3')
    handle.destroy()
    press({ key: 'F7' })
    expect(handle.hunk).toBe(2)
    expect(root.querySelector('.diff-nav')).toBeNull()
  })
  it('previous from the idle state goes to the last hunk', () => {
    const { root, handle } = mount()
    root.querySelector<HTMLButtonElement>('button[data-nav="prev"]')!.click()
    expect(handle.hunk).toBe(2)
    handle.destroy()
  })
  it('after the person scrolls, picks from the hunk headings around the middle of the view', () => {
    const { root, handle, wrap } = mount()
    const heads = [...root.querySelectorAll<HTMLElement>('.patch-hunk')]
    heads.forEach((head, i) => {
      head.getBoundingClientRect = () => ({ top: 100 + i * 1000, height: 10 }) as DOMRect
    })
    wrap.getBoundingClientRect = () => ({ top: 0, height: 500 }) as DOMRect
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, value: 1200 })
    root.querySelector<HTMLButtonElement>('button[data-nav="next"]')!.click()
    expect(handle.hunk).toBe(0)
    // The jump's own scroll arrives with no input before it: not the person's.
    wrap.dispatchEvent(new Event('scroll'))
    // Middle is 600 px; the person scrolls, so the base is the view, not hunk 0.
    wrap.dispatchEvent(new Event('wheel'))
    wrap.dispatchEvent(new Event('scroll'))
    press({ key: 'F7' })
    expect(handle.hunk).toBe(1)
    wrap.dispatchEvent(new Event('wheel'))
    wrap.dispatchEvent(new Event('scroll'))
    press({ key: 'F7', shiftKey: true })
    expect(handle.hunk).toBe(0)
    handle.destroy()
  })
})
