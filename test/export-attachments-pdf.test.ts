/**
 * @vitest-environment jsdom
 *
 * TODO 1273: images the user attached / pasted are in the exported PDF. Chain under test: `buildExportTurns` (attachments ride on the question) ->
 * `exportDocumentHtml` (a gallery under the message) -> `embedImages` (main reads the file after `assertAllowed`) -> what `renderPdf` receives.
 * No model is called; the fixture images are made here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportDocumentHtml } from '../src/renderer/src/thread/export-pdf.js'
import { buildExportTurns, EXPORT_IMAGE_MAX_BYTES } from '../src/shared/conversation-export.js'
import { embedImages } from '../src/main/export/embed-images.js'
import { ConversationExporter } from '../src/main/export/conversation-pdf.js'
import type { AiosEvent, SentAttachment } from '../src/shared/agent.js'
import type { AppSettingsStore } from '../src/common/settings.js'

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (size = 16): Uint8Array => {
  const data = new Uint8Array(size)
  data.set(PNG_HEAD)
  return data
}
const THUMB = `data:image/png;base64,${Buffer.from(png()).toString('base64')}`

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-1273-'))
  writeFileSync(join(dir, 'shot.png'), png())
  writeFileSync(join(dir, 'secret.png'), png())
  writeFileSync(join(dir, 'big.png'), png(EXPORT_IMAGE_MAX_BYTES + 1))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const userEvent = (attachments: SentAttachment[]): AiosEvent =>
  ({ id: 'e1', ts: 1, kind: 'user_text', payload: { text: '(添付: x)\n見て', attachments } }) as unknown as AiosEvent

async function pdfHtmlFor(attachments: SentAttachment[]): Promise<{ html: string; embedded: number; omitted: number }> {
  const turns = buildExportTurns([userEvent(attachments)])
  const html = exportDocumentHtml({ title: 't', meta: '', lang: 'ja', appCss: '', turns, format: 'pdf' })
  return embedImages(html, {
    assertAllowed: (uri) => {
      if (uri.endsWith('/secret.png')) throw new Error('excluded')
    },
    baseDir: null,
    omittedLabel: '画像を省略しました'
  })
}

describe('images the user attached go into the PDF (TODO 1273)', () => {
  it('buildExportTurns puts attachments on a message, and does not when there are none', () => {
    const [turn] = buildExportTurns([userEvent([{ name: 'a.png', uri: 'file:///a.png' }])])
    expect(turn?.question?.attachments).toEqual([{ name: 'a.png', uri: 'file:///a.png' }])
    const [plain] = buildExportTurns([{ id: 'e2', ts: 1, kind: 'user_text', payload: { text: 'q' } } as unknown as AiosEvent])
    expect(plain?.question).not.toHaveProperty('attachments')
  })

  it('both a paste (thumbnail data URL) and an attached file (file: URI) become a data: <img>', async () => {
    const out = await pdfHtmlFor([
      { name: 'paste.png', thumbnail: THUMB },
      { name: 'shot.png', uri: pathToFileURL(join(dir, 'shot.png')).href }
    ])
    expect(out.embedded).toBe(2)
    expect(out.omitted).toBe(0)
    expect(out.html).toContain('class="export-attachments"')
    expect(out.html.match(/<img src="data:image\/png;base64,/g)).toHaveLength(2)
    expect(out.html).not.toContain('file://')
  })

  it('when the canonical copy is missing, becomes an omission row (with the file name) and the export does not stop', async () => {
    const out = await pdfHtmlFor([{ name: 'gone.png', uri: pathToFileURL(join(dir, 'gone.png')).href }])
    expect(out.omitted).toBe(1)
    expect(out.html).toContain('[画像を省略しました: gone.png]')
  })

  it('does not read a path that is not allowed (exclusion rules) and makes it an omission row', async () => {
    const out = await pdfHtmlFor([{ name: 'secret.png', uri: pathToFileURL(join(dir, 'secret.png')).href }])
    expect(out.embedded).toBe(0)
    expect(out.omitted).toBe(1)
    expect(out.html).not.toContain('base64')
  })

  it('an image over the per-image limit (5 MB) becomes an omission row; an attachment with neither thumbnail nor uri is a name row', async () => {
    const out = await pdfHtmlFor([
      { name: 'big.png', uri: pathToFileURL(join(dir, 'big.png')).href },
      { name: 'nothing.png' }
    ])
    expect(out.embedded).toBe(0)
    expect(out.html).toContain('[画像を省略しました: big.png]')
    expect(out.html).toContain('<span class="export-image-omitted">[nothing.png]</span>')
  })

  it('ConversationExporter embeds images before passing to renderPdf even for PDF', async () => {
    const rendered: string[] = []
    const subject = new ConversationExporter<string>({
      settings: { readTyped: () => null, writeTyped: () => undefined } as unknown as AppSettingsStore,
      askSavePath: async () => '/tmp/out.pdf',
      renderPdf: async (html) => {
        rendered.push(html)
        return new Uint8Array([1])
      },
      embedImages: async (html) => html.replace('SRC', THUMB),
      threadTitle: () => 't',
      defaultDir: () => '/tmp',
      fallbackName: () => 'c',
      writeFile: async () => undefined
    })
    await subject.save('t1', { kind: 'all' }, '<img src="SRC">', 'win', 'pdf')
    expect(rendered[0]).toContain(THUMB)
  })
})
