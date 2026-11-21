/**
 * TODO 519: draws the attachment mark `(attachment: name)` in the user's own utterance in the display language. The model is not called.
 *
 * The mark is added by main regardless of language (in the text sent to the CLI and the saved `user_text`), and the renderer's `foldTimeline`
 * replaces only the first line.
 */
import { describe, expect, it } from 'vitest'
import {
  attachmentMark,
  attachmentNamesInLine,
  relabelAttachmentMarks,
  stripLeadingAttachmentMarks
} from '../src/shared/attachment-mark.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import { conversationSnippet } from '../src/renderer/src/search-snippet.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import type { AiosEvent } from '../src/shared/agent.js'
import type { SearchHit } from '../src/shared/search.js'

const en = (name: string): string => translate('en', 'timeline.user.attachmentMark', { name })

describe('添付の印 (TODO 519)', () => {
  it('main の印は以前と同じ形 (保存済みの行・モデルの見る文と揃う)', () => {
    expect(attachmentMark('shot.png')).toBe('(添付: shot.png)')
  })

  it('1 行目の印だけを置き換え、2 行目以降 (利用者の文) には触れない', () => {
    const text = '(添付: a.png) @src/a.ts (添付: b c.png)\nここも (添付: x.png) のまま'
    expect(relabelAttachmentMarks(text, en)).toBe(
      '(Attached: a.png) @src/a.ts (Attached: b c.png)\nここも (添付: x.png) のまま'
    )
  })

  it('印が無ければそのまま。JA の文言は印と同じ', () => {
    expect(relabelAttachmentMarks('見て', en)).toBe('見て')
    const ja = (name: string): string => translate('ja', 'timeline.user.attachmentMark', { name })
    expect(relabelAttachmentMarks('(添付: a.png)\n見て', ja)).toBe('(添付: a.png)\n見て')
  })

  it('TODO 608: stripLeadingAttachmentMarks は先頭の印だけを剥がす', () => {
    expect(stripLeadingAttachmentMarks('(添付: a.png)')).toBe('')
    expect(stripLeadingAttachmentMarks('(添付: a.png) (添付: b.png)')).toBe('')
    expect(stripLeadingAttachmentMarks('(添付: a.png) @src/a.ts')).toBe('@src/a.ts')
    expect(stripLeadingAttachmentMarks('見て')).toBe('見て')
  })

  it('TODO 608: attachmentNamesInLine は印の名前を順に返す', () => {
    expect(attachmentNamesInLine('(添付: a.png) (添付: b c.png)')).toEqual(['a.png', 'b c.png'])
    expect(attachmentNamesInLine('見て')).toEqual([])
  })

  it('code-review: 名前に括弧を含む印 (image (1).png) も印として読む (519 / 608)', () => {
    const text = '(添付: image (1).png) (添付: スクリーンショット (2).png) @src/a.ts\n見て'
    expect(relabelAttachmentMarks(text, en)).toBe(
      '(Attached: image (1).png) (Attached: スクリーンショット (2).png) @src/a.ts\n見て'
    )
    expect(stripLeadingAttachmentMarks('(添付: image (1).png) (添付: b (x) c.png)')).toBe('')
    expect(stripLeadingAttachmentMarks('(添付: image (1).png) @src/a.ts')).toBe('@src/a.ts')
    expect(attachmentNamesInLine('(添付: image (1).png) (添付: b.png)')).toEqual(['image (1).png', 'b.png'])
  })

  it('foldTimeline は attachmentLabel があるときだけ自分の発言の文を置き換える', () => {
    const event = {
      id: 'u1',
      sessionId: 's',
      threadId: 't',
      ts: 1,
      actor: 'main',
      kind: 'user_text',
      payload: { text: '(添付: shot.png)\n見て' }
    } as AiosEvent
    const plain = foldTimeline([event]).items[0]
    const relabeled = foldTimeline([event], { attachmentLabel: en }).items[0]
    expect(plain?.kind === 'user' ? plain.text : null).toBe('(添付: shot.png)\n見て')
    expect(relabeled?.kind === 'user' ? relabeled.text : null).toBe('(Attached: shot.png)\n見て')
  })
})

/** Fills only the fields of `SearchHit` that the test does not care about. */
function searchHit(partial: Partial<SearchHit>): SearchHit {
  return {
    id: '1',
    uri: 'thread://t/e1',
    title: '',
    source: 'conversation',
    kind: 'message',
    updatedAt: 0,
    score: 0,
    snippet: '',
    threadId: 't',
    eventId: 'e1',
    context: 'あなた',
    contextCode: null,
    ...partial
  }
}

describe('会話検索 (⌘K) のスニペットの添付の印 (TODO 621、519 の続き)', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
    translate('en', key, params)

  it('自分の発言 (contextCode === "user") の印を表示言語に描き直す', () => {
    const hit = searchHit({ contextCode: 'user', snippet: '(添付: shot.png)\n見て' })
    expect(conversationSnippet(t, hit)).toBe('(Attached: shot.png)\n見て')
  })

  it('回答・ツール・転写のヒットには触れない (印そっくりの文字列でもそのまま)', () => {
    for (const contextCode of ['assistant', 'tool', 'transcript'] as const) {
      const hit = searchHit({ contextCode, snippet: '(添付: shot.png)\n見て' })
      expect(conversationSnippet(t, hit)).toBe('(添付: shot.png)\n見て')
    }
  })

  it('code-review: 名前に括弧を含む印も、改行が空白に畳まれたスニペットでも描き直す', () => {
    const hit = searchHit({ contextCode: 'user', snippet: '(添付: image (1).png) 見て (かっこ)…' })
    expect(conversationSnippet(t, hit)).toBe('(Attached: image (1).png) 見て (かっこ)…')
  })

  it('印が無ければそのまま', () => {
    const hit = searchHit({ contextCode: 'user', snippet: '見て' })
    expect(conversationSnippet(t, hit)).toBe('見て')
  })
})
