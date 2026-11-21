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

describe('composeText @ references', () => {
  it('wraps an absolute path containing spaces in quotes', () => {
    const text = service('/work').composeText(thread, input('file:///Users/alice/VirtualBox%20VMs/notes.txt'))
    expect(text).toBe('@"/Users/alice/VirtualBox VMs/notes.txt"\nhi')
  })
  it('wraps a relative path containing spaces too', () => {
    const text = service('/work').composeText(thread, input('file:///work/my%20dir/a.txt'))
    expect(text).toBe('@"my dir/a.txt"\nhi')
  })
  it('does not wrap when there are no spaces', () => {
    const text = service('/work').composeText(thread, input('file:///work/a.txt'))
    expect(text).toBe('@a.txt\nhi')
  })
})
