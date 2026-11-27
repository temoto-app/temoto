// @vitest-environment jsdom
/**
 * TODO 496 (wave 24 bundle A): matching for in-thread search and DOM traversal (`thread/find-text.ts` / `thread/find-dom.ts`).
 * The wiring of the floating search box is in `test/thread-find-dom.test.ts`. No model is called.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findRanges,
  findTerms,
  foldText,
  nfkcSameLength,
  termsCaseSensitive,
  textHasMatch
} from '../src/renderer/src/thread/find-text.js'
import {
  collectText,
  FIND_PENDING_ATTR,
  indexOfSpotKey,
  scanFindSpots,
  spotKeyAt
} from '../src/renderer/src/thread/find-dom.js'
import { itemFindText, toolFindText } from '../src/renderer/src/thread/find-hidden.js'
import type { TimelineItem } from '../src/renderer/src/thread/timeline.js'

const texts = (text: string, query: string): string[] =>
  findRanges(text, findTerms(query)).map((range) => text.slice(range.from, range.to))

describe('findTerms / findRanges (smart case, full-width letters, per term)', () => {
  it('splits into terms by whitespace (including full-width) and highlights each term, dropping empty ones and duplicates', () => {
    expect(findTerms('  foo\u3000bar foo ').map((term) => term.needle)).toEqual(['foo', 'bar'])
    expect(texts('bar then foo', 'foo bar')).toEqual(['bar', 'foo'])
  })

  it('a lowercase-only term is case-insensitive (TODO 291)', () => {
    expect(texts('Deploy and deploy and DEPLOY', 'deploy')).toEqual(['Deploy', 'deploy', 'DEPLOY'])
    expect(termsCaseSensitive(findTerms('deploy'))).toBe(false)
  })

  it('a term containing uppercase matches only the same case (per term)', () => {
    expect(texts('Deploy and deploy', 'Deploy')).toEqual(['Deploy'])
    expect(texts('System config / system Config', 'System config')).toEqual(['System', 'config', 'Config'])
    expect(termsCaseSensitive(findTerms('System config'))).toBe(true)
  })

  it('full-width letters (TODO 301) are folded to half-width in both the term and the body, and positions stay those of the original body', () => {
    expect(nfkcSameLength('ＡＷＳ')).toBe('AWS')
    expect(texts('Deploy to ＡＷＳ now', 'aws')).toEqual(['ＡＷＳ'])
    expect(texts('Deploy to AWS now', 'ａｗｓ')).toEqual(['AWS'])
    // Full-width capital words are distinguished as capitals (judged after NFKC).
    expect(texts('aws AWS', 'ＡＷＳ')).toEqual(['AWS'])
  })

  it('characters whose length changes are not folded (positions do not shift)', () => {
    // `ﬁ` (a ligature) becomes 2 characters under NFKC, so it is not folded. The position of the later match is correct.
    expect(texts('ﬁle file', 'file')).toEqual(['file'])
  })

  it('for overlapping matches only the earlier one counts, and exactly identical ranges count as one', () => {
    expect(texts('abc', 'ab bc')).toEqual(['ab'])
    expect(findRanges('foo FOO', findTerms('foo foo'))).toHaveLength(2)
  })

  it('textHasMatch judges folded content (any of the terms)', () => {
    const terms = findTerms('npm Deploy')
    expect(textHasMatch('run npm test', terms)).toBe(true)
    expect(textHasMatch('deploy only', terms)).toBe(false)
    expect(textHasMatch('', terms)).toBe(false)
    expect(textHasMatch('x', [])).toBe(false)
  })

  it('the same when foldText is passed', () => {
    const terms = findTerms('foo')
    expect(findRanges(foldText('a Foo b'), terms)).toEqual(findRanges('a Foo b', terms))
  })
})

function html(markup: string): HTMLElement {
  const body = document.createElement('div')
  body.className = 'thread-body'
  body.innerHTML = markup
  document.body.append(body)
  return body
}

describe('scanFindSpots (counts with Range without rewriting the DOM)', () => {
  it('does not cross rows, crosses inline elements, and does not change the DOM', () => {
    const body = html(
      '<div id="ev-a" class="timeline-item"><div class="markdown"><p>foo<strong>bar</strong></p><p>baz</p></div></div>'
    )
    const before = body.innerHTML
    const spots = scanFindSpots(body, findTerms('foobar barbaz'))
    expect(spots.map((spot) => (spot.kind === 'hit' ? spot.range.toString() : spot.key))).toEqual(['foobar'])
    expect(spots[0]!.itemId).toBe('a')
    expect(body.innerHTML).toBe(before)
    body.remove()
  })

  it("does not count inside copy buttons, rewind buttons, 「さらに読む」, or svg, and separates a tool's name and summary", () => {
    const body = html(
      [
        '<div class="timeline-older"><button>Load older foo</button></div>',
        '<div id="ev-a" class="timeline-item"><div class="code-block"><pre>foo</pre><button class="code-copy">foo</button></div>',
        '<button class="rewind-button">foo</button></div>',
        '<div id="ev-t" class="timeline-item"><div class="tool-block"><button class="tool-head"><span class="tool-name">Bash</span><span class="tool-summary">npm foo</span></button></div></div>'
      ].join('')
    )
    const spots = scanFindSpots(body, findTerms('foo bashnpm'))
    expect(spots.map((spot) => [spot.itemId, spot.kind === 'hit' ? spot.range.toString() : ''])).toEqual([
      ['a', 'foo'],
      ['t', 'foo']
    ])
    expect(collectText(body).text).toContain('Bash\nnpm foo')
    body.remove()
  })

  it('a collapsed chunk (mark) comes after the visible matches inside it, and for nesting the inner one comes first', () => {
    const body = html(
      [
        '<div id="ev-1" class="timeline-item"><p>foo</p></div>',
        `<div id="ev-2" class="timeline-item"><div class="tool-block" ${FIND_PENDING_ATTR}="tool:2">`,
        '<button class="tool-head"><span class="tool-summary">foo head</span></button>',
        `<div class="plan-block" ${FIND_PENDING_ATTR}="plan:2"><button>Plan</button></div>`,
        '</div></div>',
        '<div id="ev-3" class="timeline-item"><p>last foo</p></div>'
      ].join('')
    )
    const spots = scanFindSpots(body, findTerms('foo'))
    expect(spots.map((spot) => (spot.kind === 'hit' ? `${spot.itemId}:hit` : `${spot.itemId}:${spot.key}`))).toEqual([
      '1:hit',
      '2:hit',
      '2:plan:2',
      '2:tool:2',
      '3:hit'
    ])
    body.remove()
  })

  it('the key of the current place (row and the nth within the row) points to the same place after rescanning, and the last of the row when the count decreases', () => {
    const body = html('<div id="ev-a"><p>foo foo foo</p></div><div id="ev-b"><p>foo</p></div>')
    const terms = findTerms('foo')
    const first = scanFindSpots(body, terms)
    const key = spotKeyAt(first, 2)!
    expect(key).toEqual({ itemId: 'a', ordinal: 2, kind: 'hit' })
    // A row was added at the head (an earlier page was read).
    body.insertAdjacentHTML('afterbegin', '<div id="ev-z"><p>foo</p></div>')
    const again = scanFindSpots(body, terms)
    expect(indexOfSpotKey(again, key)).toBe(3)
    body.querySelector('#ev-a p')!.textContent = 'foo'
    expect(indexOfSpotKey(scanFindSpots(body, terms), key)).toBe(1)
    expect(indexOfSpotKey(scanFindSpots(body, terms), { itemId: 'gone', ordinal: 0, kind: 'hit' })).toBe(-1)
    body.remove()
  })
})

const toolItem = (over: Partial<Extract<TimelineItem, { kind: 'tool' }>> = {}): TimelineItem => ({
  kind: 'tool',
  id: 't1',
  ts: 0,
  toolUseId: 'tu1',
  name: 'Bash',
  summary: 'npm test',
  input: { command: 'npm test -- --grep Deploy', description: 'run the tests' },
  truncated: false,
  approval: null,
  result: null,
  children: [],
  ...over
})

describe('text of folded content (decision 5)', () => {
  it('tool row: the arguments (formatted like ToolInput) and the in-flight result body', () => {
    const text = toolFindText(toolItem({ result: { ok: true, bytes: 3, text: 'all green' } as never }))
    expect(text).toContain('npm test -- --grep Deploy')
    expect(text).toContain('run the tests')
    expect(text).toContain('all green')
    // A row after restart has no result body (constraint 10).
    expect(toolFindText(toolItem({ result: { ok: true, bytes: 3 } as never }))).not.toContain('all green')
    expect(toolFindText({ kind: 'user', id: 'u', ts: 0, text: 'x' })).toBe('')
  })

  it("rows hidden behind a child agent's 「+N」: the message, and the tool's name, summary, arguments, and plan", () => {
    expect(itemFindText({ kind: 'user', id: 'u', ts: 0, text: 'hello' })).toBe('hello')
    const text = itemFindText(toolItem({ plan: 'step one' }))
    expect(text).toContain('Bash')
    expect(text).toContain('npm test')
    expect(text).toContain('step one')
  })
})

describe('threadPaneHasFocus (⌘F dispatch)', () => {
  it('whether the focused element is inside ThreadPane (including the Composer), and the last pressed place if there is none', async () => {
    const { installThreadPointerTracker, threadPaneHasFocus } = await import('../src/renderer/src/threadFindStore.js')
    const untrack = installThreadPointerTracker()
    const pane = document.createElement('div')
    pane.className = 'thread-pane'
    pane.innerHTML = '<p class="text">answer</p><textarea class="composer-input"></textarea>'
    const side = document.createElement('div')
    side.innerHTML = '<input class="search-input"><p class="side-text">x</p>'
    document.body.append(pane, side)
    pane.querySelector('textarea')!.focus()
    expect(threadPaneHasFocus()).toBe(true)
    side.querySelector('input')!.focus()
    expect(threadPaneHasFocus()).toBe(false)
    ;(document.activeElement as HTMLElement).blur()
    // Only the text was pressed (focus stays on body).
    pane.querySelector('.text')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(threadPaneHasFocus()).toBe(true)
    side.querySelector('.side-text')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(threadPaneHasFocus()).toBe(false)
    untrack()
    pane.remove()
    side.remove()
  })

  it('settings, scheduled runs, and extension details (`thread-pane settings-editor`) are not ThreadPane (review 2026-10-06)', async () => {
    const { installThreadPointerTracker, threadPaneHasFocus } = await import('../src/renderer/src/threadFindStore.js')
    const untrack = installThreadPointerTracker()
    const settings = document.createElement('div')
    settings.className = 'thread-pane settings-editor'
    settings.innerHTML = '<input class="setting"><p class="label">theme</p>'
    document.body.append(settings)
    settings.querySelector('input')!.focus()
    expect(threadPaneHasFocus()).toBe(false)
    ;(document.activeElement as HTMLElement).blur()
    settings.querySelector('.label')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(threadPaneHasFocus()).toBe(false)
    untrack()
    settings.remove()
  })
})

describe('wiring (checked by source)', () => {
  const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

  it('ThreadPane: 🔍 in the heading, a search box right before the body, and the landing at the end (464) is stopped during search', () => {
    const src = read('src/renderer/src/components/ThreadPane.tsx')
    expect(src).toMatch(/thread-find-open[\s\S]*<ThreadSettingsMenu/)
    const find = src.indexOf('<ThreadFind threadId={threadId} bodyRef={scrollRef} />')
    expect(find).toBeGreaterThan(0)
    expect(find).toBeLessThan(src.indexOf('<StickyQuestion handle={jump}'))
    expect(src).toMatch(/activeFindTerms\(useThreadFind\.getState\(\)\)\.length > 0\) return/)
  })

  it('collapsing parts mark themselves (tool, plan, child chunk, thinking)', () => {
    expect(read('src/renderer/src/components/ThreadPane.tsx')).toMatch(/useFindPending\(`tool:\$\{item\.id\}`/)
    expect(read('src/renderer/src/components/ThreadPane.tsx')).toMatch(/useFindPending\('thinking'/)
    expect(read('src/renderer/src/components/PlanBlock.tsx')).toMatch(/useFindPending\(/)
    expect(read('src/renderer/src/components/SubagentBlock.tsx')).toMatch(/useFindPending\(`subagent:\$\{toolUseId\}`/)
  })

  it('the search field is a target of Latin-letter input (the mark of 463)', () => {
    expect(read('src/renderer/src/components/ThreadFind.tsx')).toMatch(/\{\.\.\.ASCII_INPUT\}/)
  })

  it("App's keydown dispatches ThreadPane's ⌘F via appShortcut", () => {
    const src = read('src/renderer/src/App.tsx')
    expect(src).toMatch(/appShortcut\(event, \{ inThreadPane: threadPaneHasFocus\(\) \}\)/)
    expect(src).toMatch(/installThreadPointerTracker\(\)/)
  })
})

describe('math in the search scan (review X3)', () => {
  it('searches the visible KaTeX glyphs once, not the hidden MathML or its annotation', () => {
    const body = document.createElement('div')
    body.innerHTML =
      '<p>energy <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span>' +
      '<span class="katex-html" aria-hidden="true"><span class="mord">E</span><span class="mrel">=</span><span class="mord">mc2</span></span></span> here</p>'
    expect(collectText(body).text).toBe('energy E=mc2 here')
  })
  it('still skips other aria-hidden content', () => {
    const body = document.createElement('div')
    body.innerHTML = '<p>a<span aria-hidden="true">hidden</span>b</p>'
    expect(collectText(body).text).toBe('ab')
  })
})
