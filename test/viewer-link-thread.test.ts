/**
 * TODO 1161: `thread://` links in the body of a plugin viewer (`aios.markdown`). The viewer sorts it as 'thread' with `viewerLinkAction` and passes it to the host with
 * `bridge.openLink` (the host's `open-link` -> `openLinkHref` jumps by the route of 1155). The host's `open-link` is also the entry point that carries relative and `file:` links,
 * so it also checks that dangerous schemes other than `thread:` do not get through.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { linkAction, viewerLinkAction } from '../src/shared/link.js'
import { parseThreadLink } from '../src/shared/thread-link.js'

describe('viewerLinkAction', () => {
  it('thread://<id>[/<id>] は thread', () => {
    expect(viewerLinkAction('thread://t1/e1')).toBe('thread')
    expect(viewerLinkAction('thread://t1')).toBe('thread')
    expect(viewerLinkAction(' THREAD://t1/e1 ')).toBe('thread')
  })

  it('形が違う thread: ・他のスキームは none のまま', () => {
    expect(viewerLinkAction('thread://a/b/c')).toBe('none')
    expect(viewerLinkAction('thread://')).toBe('none')
    expect(viewerLinkAction('thread:foo')).toBe('none')
    expect(viewerLinkAction('javascript:alert(1)')).toBe('none')
    expect(viewerLinkAction('data:text/html,x')).toBe('none')
  })

  it('thread 以外は linkAction と同じ (http(s) は external、相対は resolve)', () => {
    for (const href of ['https://x.test/', 'mailto:a@b.c', 'file:///a', 'docs/a.md', '#h', '', null]) {
      expect(viewerLinkAction(href)).toBe(linkAction(href))
    }
  })

  it('thread と判定したものは host の openLinkHref (parseThreadLink) が必ず読める', () => {
    for (const href of ['thread://t1/e1', 'thread://t1', 'thread://t1/e1#x']) {
      expect(viewerLinkAction(href) === 'thread').toBe(parseThreadLink(href) !== null)
    }
  })
})

describe("aios.office の hyperlink (TODO 1164)", () => {
  it("viewer は viewerLinkAction を通す (linkAction のままだと thread:// を捨てる)", () => {
    const source = readFileSync("plugins/aios.office/viewer/main.ts", "utf8")
    expect(source).toContain("viewerLinkAction(href)")
    expect(source).not.toMatch(/\blinkAction\(/)
    expect(linkAction("thread://t1/e1")).toBe("none")
    expect(viewerLinkAction("thread://t1/e1")).toBe("thread")
  })
})
