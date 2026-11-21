/**
 * What ViewerPane may send to the iframe's port (item 149, ARCHITECTURE.md 7.4).
 *
 * A symptom found in the proxy verification (TODO 147): after opening Markdown and switching to PNG, the heading list of `aios.markdown` went to read the PNG's URI,
 * and the Broker refused it with `no-grant`. The cause was that the host sent 'the new URI + the contents of the previous file' to the previous iframe.
 * Here the state transitions of ViewerPane are lined up in order, and what is sent at each point is checked with pure functions.
 *
 * Neither the model nor Electron is started.
 */
import { describe, expect, it } from 'vitest'
import type { ViewerResource } from '../src/shared/types.js'
import {
  acceptsDraft,
  currentResource,
  routableResource,
  type LoadedResource,
  type RouteViewer
} from '../src/renderer/src/viewer-route.js'

const MD_A = 'file:///Users/me/a.md'
const MD_B = 'file:///Users/me/b.md'
const PNG = 'file:///Users/me/c.png'

const markdown: RouteViewer = { pluginId: 'aios.markdown', url: 'aios-plugin://aios.markdown/index.html' }
const image: RouteViewer = { pluginId: 'aios.image', url: 'aios-plugin://aios.image/index.html' }

const text = (body: string): ViewerResource => ({
  kind: 'text',
  text: body,
  truncated: false,
  size: body.length,
  mtimeMs: 1
})
const binary: ViewerResource = {
  kind: 'binary',
  resourceUrl: 'aios-res://local/0123456789abcdef0123456789abcdef/c.png',
  size: 10,
  mtimeMs: 1
}

const loadedA: LoadedResource = { uri: MD_A, pluginId: 'aios.markdown', resource: text('# A') }
const loadedB: LoadedResource = { uri: MD_B, pluginId: 'aios.markdown', resource: text('# B') }
const loadedPng: LoadedResource = { uri: PNG, pluginId: 'aios.image', resource: binary }

describe('routableResource: sends nothing in the middle of switching (item 149)', () => {
  it('sends when everything agrees', () => {
    expect(routableResource(MD_A, markdown, loadedA, markdown.url)).toBe(loadedA.resource)
  })

  it('Markdown → PNG: at no point sends the new URI to the previous iframe', () => {
    // 1) Only the URI changed (a draw). The viewer, contents, and port are still Markdown. Before, here
    //    'PNG URI + a.md contents' was sent to aios.markdown, and the heading list went to read the PNG.
    expect(routableResource(PNG, markdown, loadedA, markdown.url)).toBeNull()
    // 2) The viewer's resolution came back (aios.image). The contents are still a.md, and the port is also the Markdown iframe's.
    expect(routableResource(PNG, image, loadedA, markdown.url)).toBeNull()
    // 3) The iframe's src changed and the port was detached (effect).
    expect(routableResource(PNG, image, loadedA, null)).toBeNull()
    // 4) A new iframe loaded and the port connected. The contents are still a.md (waiting for the read round trip).
    expect(routableResource(PNG, image, loadedA, image.url)).toBeNull()
    // 5) The PNG contents were read. Only now is it sent.
    expect(routableResource(PNG, image, loadedPng, image.url)).toBe(binary)
  })

  it('does not send even if the read returns first when the port belongs to the previous viewer', () => {
    expect(routableResource(PNG, image, loadedPng, markdown.url)).toBeNull()
  })

  it('files of the same plugin (md → md) are sent to the same port without recreating the iframe (Phase 4)', () => {
    // While waiting for resolution and read, a.md's contents are not sent as b.md.
    expect(routableResource(MD_B, markdown, loadedA, markdown.url)).toBeNull()
    // Once b.md is read, the port can be used as is, since the iframe's src is the same.
    expect(routableResource(MD_B, markdown, loadedB, markdown.url)).toBe(loadedB.resource)
  })

  it('the same rule applies when going back from PNG → Markdown', () => {
    expect(routableResource(MD_A, image, loadedPng, image.url)).toBeNull()
    expect(routableResource(MD_A, markdown, loadedPng, image.url)).toBeNull()
    expect(routableResource(MD_A, markdown, loadedA, markdown.url)).toBe(loadedA.resource)
  })

  it('does not send when closed, there is no viewer, or there is no port', () => {
    expect(routableResource(null, markdown, loadedA, markdown.url)).toBeNull()
    expect(routableResource(MD_A, null, loadedA, markdown.url)).toBeNull()
    expect(routableResource(MD_A, markdown, null, markdown.url)).toBeNull()
    expect(routableResource(MD_A, markdown, loadedA, null)).toBeNull()
  })
})

describe('currentResource: the base for editing and saving is only the content of the shown file', () => {
  it('only when the source URI and the plugin match', () => {
    expect(currentResource(MD_A, markdown, loadedA)).toBe(loadedA.resource)
    expect(currentResource(MD_B, markdown, loadedA)).toBeNull()
    expect(currentResource(MD_A, image, loadedA)).toBeNull()
  })

  it('does not use content read by another plugin even for the same URI', () => {
    const viaText: LoadedResource = { uri: MD_A, pluginId: 'aios.text', resource: text('# A') }
    expect(currentResource(MD_A, markdown, viaText)).toBeNull()
  })
})

describe("acceptsDraft: does not take the previous file's draft as the new file's", () => {
  it('accepts only when what the viewer draws is the shown URI', () => {
    expect(acceptsDraft(MD_A, MD_A)).toBe(true)
    // A draft that arrives mid-switch (while a.md is still drawn) is discarded.
    expect(acceptsDraft(MD_A, MD_B)).toBe(false)
    // A draft from a port that has not yet sent anything (just after loading) is also discarded.
    expect(acceptsDraft(null, MD_A)).toBe(false)
    expect(acceptsDraft(MD_A, null)).toBe(false)
  })

  it("**TODO 938: discards a draft whose stated URI differs from the resource just sent** (A's draft arriving right after B was sent)", () => {
    expect(acceptsDraft(MD_B, MD_B, MD_A)).toBe(false)
    expect(acceptsDraft(MD_B, MD_B, MD_B)).toBe(true)
    expect(acceptsDraft(MD_B, MD_B, 42)).toBe(false)
  })

  it('a draft that does not state a uri (previous bridge) enters the current file by the old matching', () => {
    expect(acceptsDraft(MD_B, MD_B, undefined)).toBe(true)
    expect(acceptsDraft(MD_A, MD_B, undefined)).toBe(false)
  })
})
