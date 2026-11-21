import { describe, expect, it } from 'vitest'
import { AttachmentService } from '../src/main/session/attachments.js'
import type { SendInput, Thread } from '../src/shared/thread.js'

// TODO 917: an attachment whose path contains spaces is wrapped in `@"…"` (without wrapping, the reference is cut at the space).
function service(cwd: string): AttachmentService {
  const host = { workingCwdOf: () => cwd } as unknown as ConstructorParameters<typeof AttachmentService>[0]
  return new AttachmentService(host)
}
const thread = {} as Thread
function input(uri: string): SendInput {
  return {
    text: 'hi',
    attachments: [{ uri, name: 'x', kind: 'file' }]
  } as unknown as SendInput
}

describe('composeText の @ 参照', () => {
  it('空白を含む絶対パスは引用符で包む', () => {
    const text = service('/work').composeText(thread, input('file:///Users/alice/VirtualBox%20VMs/notes.txt'))
    expect(text).toBe('@"/Users/alice/VirtualBox VMs/notes.txt"\nhi')
  })
  it('空白を含む相対パスも包む', () => {
    const text = service('/work').composeText(thread, input('file:///work/my%20dir/a.txt'))
    expect(text).toBe('@"my dir/a.txt"\nhi')
  })
  it('空白が無ければ包まない', () => {
    const text = service('/work').composeText(thread, input('file:///work/a.txt'))
    expect(text).toBe('@a.txt\nhi')
  })
})
