// @vitest-environment jsdom
/**
 * TODO 370 (wave 20 bundle C): the inline input for "new file / folder" in the Files tree (jsdom).
 *
 * - `InlineNameInput`: Enter creates; the Enter that confirms IME input is not picked up; Esc or a click outside cancels; a red validation bubble on each keystroke; a bubble with the text main refused.
 * - `FileMode`: the heading button opens the input right after the row where the key position is (the parent, for a file), and it takes focus. ↑↓ inside the input does not move the tree behind it (no conflict with 356). Enter calls the main entry point and, once created, asks for the view to be updated.
 * - Pure functions: `newEntryParent` / `newEntryProblem` / `createdChain` / `toViewIndex` / `fromViewIndex`
 *
 * The virtual list is a fake that renders every row (as in `file-tree-keys.test.ts`). Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry } from '../src/shared/types.js'
import { useStore } from '../src/renderer/src/store.js'
import type { CreateEntryResult, RenameEntryResult } from '../src/shared/new-entry.js'
import {
  createdChain,
  fromViewIndex,
  newEntryParent,
  newEntryProblem,
  renameProblem,
  replaceUriPrefix,
  toViewIndex
} from '../src/renderer/src/file-tree.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => options.count * 24,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 24,
        size: options.estimateSize(index),
        key: index
      })),
    scrollToIndex: () => undefined
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = 'file:///w'
function entry(uri: string, isDirectory: boolean, parentUri: string | null): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri, name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}
const root = entry(ROOT, true, null)
const dirA = entry(`${ROOT}/a`, true, ROOT)
const fileB = entry(`${ROOT}/b.ts`, false, ROOT)
const fileInA = entry(`${ROOT}/a/x.ts`, false, `${ROOT}/a`)

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(target: Element, keyName: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('pure functions (TODO 370)', () => {
  it('newEntryParent: a folder row gives that folder, a file row gives its parent', () => {
    expect(newEntryParent(dirA)).toBe(dirA.uri)
    expect(newEntryParent(fileB)).toBe(ROOT)
    expect(newEntryParent(root)).toBe(ROOT)
  })

  it('newEntryProblem: name rules plus a check against the visible list (case folded)', () => {
    const siblings = [dirA, fileB]
    expect(newEntryProblem('c.ts', 'file', siblings)).toBeNull()
    expect(newEntryProblem('B.TS', 'file', siblings)).toEqual({ code: 'create-exists', params: { name: 'b.ts' } })
    expect(newEntryProblem('a', 'folder', siblings)).toEqual({ code: 'create-exists', params: { name: 'a' } })
    expect(newEntryProblem('a/new.ts', 'file', siblings)).toBeNull()
    expect(newEntryProblem('b.ts/x', 'file', siblings)).toEqual({
      code: 'create-not-directory',
      params: { name: 'b.ts' }
    })
    expect(newEntryProblem('../x', 'file', siblings)).toEqual({ code: 'create-name-segment' })
  })

  it('createdChain: from the parent up to one above what was created', () => {
    expect(createdChain(ROOT, `${ROOT}/x.ts`)).toEqual([ROOT])
    expect(createdChain(ROOT, `${ROOT}/a/b/c.ts`)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`])
    expect(createdChain('file:///', 'file:///tmp/x')).toEqual(['file:///', 'file:///tmp'])
  })

  it('toViewIndex / fromViewIndex: indexes of the virtual list with the input row inserted', () => {
    expect(toViewIndex(0, 2)).toBe(0)
    expect(toViewIndex(2, 2)).toBe(3)
    expect(fromViewIndex(2, 2)).toBeNull()
    expect(fromViewIndex(3, 2)).toBe(2)
    expect(fromViewIndex(1, null)).toBe(1)
  })
})

describe('InlineNameInput (jsdom)', () => {
  let reactRoot: Root
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    reactRoot = createRoot(host)
  })

  afterEach(() => {
    act(() => reactRoot.unmount())
    host.remove()
  })

  async function render(props: {
    validate?: (value: string) => string | null
    onSubmit?: (value: string) => Promise<string | null>
    onCancel?: (why: string) => void
  }): Promise<HTMLInputElement> {
    const { InlineNameInput } = await import('../src/renderer/src/components/InlineNameInput.js')
    act(() =>
      reactRoot.render(
        createElement(InlineNameInput, {
          depth: 1,
          icon: '·',
          ariaLabel: 'name',
          validate: props.validate ?? (() => null),
          onSubmit: props.onSubmit ?? (async () => null),
          onCancel: props.onCancel ?? (() => undefined)
        })
      )
    )
    const input = host.querySelector('input')
    if (input === null) throw new Error('no input')
    return input
  }

  it('takes focus on open and calls onSubmit on Enter (the string as is)', async () => {
    const onSubmit = vi.fn(async () => null)
    const input = await render({ onSubmit })
    expect(document.activeElement).toBe(input)
    typeInto(input, 'new.ts')
    key(input, 'Enter')
    await settle()
    expect(onSubmit).toHaveBeenCalledWith('new.ts')
  })

  it('ignores the Enter that confirms IME composition (isComposing / keyCode 229 / composing)', async () => {
    const onSubmit = vi.fn(async () => null)
    const input = await render({ onSubmit })
    typeInto(input, 'にほんご')
    key(input, 'Enter', { isComposing: true })
    key(input, 'Enter', { keyCode: 229 })
    act(() => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    key(input, 'Enter')
    act(() => {
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()
    key(input, 'Enter')
    await settle()
    expect(onSubmit).toHaveBeenCalledWith('にほんご')
  })

  it('cancels on Esc (escape) and on blur outside the field (blur)', async () => {
    const onCancel = vi.fn()
    const input = await render({ onCancel })
    key(input, 'Escape')
    expect(onCancel).toHaveBeenCalledWith('escape')

    act(() => reactRoot.render(createElement('div')))
    const onCancel2 = vi.fn()
    const input2 = await render({ onCancel: onCancel2 })
    // jsdom's `document.hasFocus()` has no window focus, so it is set to match when something else is pressed inside the window.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() => input2.blur())
    expect(onCancel2).toHaveBeenCalledWith('blur')
    hasFocus.mockRestore()
  })

  it('does not cancel on a blur where the whole window lost focus (to another app)', async () => {
    const onCancel = vi.fn()
    const input = await render({ onCancel })
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => input.blur())
    expect(onCancel).not.toHaveBeenCalled()
    hasFocus.mockRestore()
  })

  it('cancels on Enter with an empty value (does not call onSubmit)', async () => {
    const onSubmit = vi.fn(async () => null)
    const onCancel = vi.fn()
    const input = await render({ onSubmit, onCancel })
    key(input, 'Enter')
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledWith('escape')
  })

  it('shows a red bubble from the per-keystroke check and does not create on Enter either', async () => {
    const onSubmit = vi.fn(async () => null)
    const input = await render({
      onSubmit,
      validate: (value) => (value === 'b.ts' ? 'exists' : null)
    })
    typeInto(input, 'b.ts')
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('exists')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    key(input, 'Enter')
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()
    typeInto(input, 'c.ts')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the message main refused in the bubble and keeps the field (there are moments blur does not close it)', async () => {
    const onCancel = vi.fn()
    const input = await render({ onSubmit: async () => 'refused by main', onCancel })
    typeInto(input, 'x')
    key(input, 'Enter')
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('refused by main')
    expect(host.querySelector('input')).toBe(input)
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('pure functions for renaming (TODO 1145)', () => {
  it('renameProblem: does not collide with itself; compares with siblings folding case and normalization; / and empty have the same reasons as main', () => {
    const siblings = [dirA, fileB]
    expect(renameProblem('b.ts', fileB, siblings)).toBeNull()
    expect(renameProblem('B.TS', fileB, siblings)).toBeNull()
    expect(renameProblem('A', fileB, siblings)).toEqual({ code: 'create-exists', params: { name: 'a' } })
    expect(renameProblem('x/y', fileB, siblings)).toEqual({ code: 'rename-name-slash' })
    expect(renameProblem('  ', fileB, siblings)).toEqual({ code: 'create-name-empty' })
  })

  it('replaceUriPrefix: the item itself and what is inside go to the new URI; a sibling that only shares a prefix is untouched', () => {
    expect(replaceUriPrefix(`${ROOT}/a`, `${ROOT}/a`, `${ROOT}/z`)).toBe(`${ROOT}/z`)
    expect(replaceUriPrefix(`${ROOT}/a/x.ts`, `${ROOT}/a`, `${ROOT}/z`)).toBe(`${ROOT}/z/x.ts`)
    expect(replaceUriPrefix(`${ROOT}/ab/x.ts`, `${ROOT}/a`, `${ROOT}/z`)).toBe(`${ROOT}/ab/x.ts`)
    expect(replaceUriPrefix(null, `${ROOT}/a`, `${ROOT}/z`)).toBeNull()
  })
})

describe('new file / folder in FileMode (jsdom)', () => {
  let reactRoot: Root
  let host: HTMLDivElement
  let createFile: ReturnType<typeof vi.fn>
  let createFolder: ReturnType<typeof vi.fn>
  let noteCreated: ReturnType<typeof vi.fn>
  let rename: ReturnType<typeof vi.fn>
  let refresh: ReturnType<typeof vi.fn>
  let selectCalls: string[]

  beforeEach(async () => {
    vi.useFakeTimers()
    selectCalls = []
    createFile = vi.fn(
      async (parentUri: string, name: string): Promise<CreateEntryResult> => ({
        uri: `${parentUri}/${name}`,
        reason: null
      })
    )
    createFolder = vi.fn(
      async (): Promise<CreateEntryResult> => ({ uri: null, reason: 'create-exists', params: { name: 'zz' } })
    )
    noteCreated = vi.fn(async () => undefined)
    rename = vi.fn(
      async (uri: string, name: string): Promise<RenameEntryResult> => ({
        uri: `${uri.slice(0, uri.lastIndexOf('/'))}/${name}`,
        reason: null
      })
    )
    refresh = vi.fn(async () => undefined)
    ;(window as unknown as { aios: unknown }).aios = {
      editor: { reveal: vi.fn() },
      app: { onMenuCommand: () => () => undefined },
      fs: { createFile, createFolder, rename }
    }
    useStore.setState({
      roots: [root],
      children: { [ROOT]: [dirA, fileB], [`${ROOT}/a`]: [fileInA] },
      expanded: new Set([ROOT]),
      loading: new Set(),
      results: null,
      selectedUri: null,
      revealedUri: null,
      revealTick: 0,
      revealTarget: null,
      select: (uri: string | null) => {
        if (uri !== null) selectCalls.push(uri)
        useStore.setState({ selectedUri: uri, revealedUri: null })
      },
      toggle: async () => undefined,
      expand: async (uri: string) => {
        useStore.setState({ expanded: new Set(useStore.getState().expanded).add(uri) })
      },
      setQuery: () => undefined,
      noteCreated,
      refresh
    })
    host = document.createElement('div')
    document.body.append(host)
    reactRoot = createRoot(host)
    const { FileMode } = await import('../src/renderer/src/components/Sidebar.js')
    act(() => reactRoot.render(createElement(FileMode)))
  })

  afterEach(() => {
    act(() => reactRoot.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const tree = (): HTMLElement => host.querySelector<HTMLElement>('.file-tree') as HTMLElement
  const button = (label: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`.files-action[aria-label="${label}"]`) as HTMLButtonElement
  const rowNames = (): string[] =>
    [...tree().querySelectorAll('[role="treeitem"], .row-inline-name')].map((el) =>
      el.classList.contains('row-inline-name') ? '<input>' : (el.querySelector('.row-name')?.textContent ?? '')
    )

  it('the heading button is icon-only (no title, aria-label); pressing it puts the input right after the parent of the file at the key position', () => {
    const newFile = button('New File…')
    expect(newFile).not.toBeNull()
    expect(newFile.hasAttribute('title')).toBe(false)
    // Puts the key position on b.ts (a file).
    act(() => tree().focus())
    key(tree(), 'End')
    act(() => newFile.click())
    expect(rowNames()).toEqual(['w', '<input>', 'a', 'b.ts'])
    const input = host.querySelector<HTMLInputElement>('.inline-name-input')
    expect(document.activeElement).toBe(input)
    expect(input?.getAttribute('aria-label')).toBe('New file name')
  })

  it('puts it inside the folder (right after the row, one level deeper) when the key position is a folder row', () => {
    act(() => tree().focus())
    key(tree(), 'Home')
    key(tree(), 'ArrowDown') // a
    act(() => button('New Folder…').click())
    // The closed a is opened (its child x.ts appears too), and the input is right after a's row (one level deeper).
    expect(rowNames()).toEqual(['w', 'a', '<input>', 'x.ts', 'b.ts'])
    expect([...useStore.getState().expanded]).toContain(`${ROOT}/a`)
    const field = host.querySelector<HTMLElement>('.inline-name')
    expect(field?.style.paddingLeft).toBe('32px')
  })

  it('↑↓ in the field do not move the tree behind or open anything in the viewer (no collision with 356)', () => {
    act(() => tree().focus())
    key(tree(), 'End')
    const before = tree().getAttribute('aria-activedescendant')
    act(() => button('New File…').click())
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    key(input, 'ArrowUp')
    key(input, 'ArrowDown')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(tree().getAttribute('aria-activedescendant')).toBe(before)
    expect(selectCalls).toEqual([])
    expect(document.activeElement).toBe(input)
  })

  it("on Enter calls main's entry (parent URI + string), asks for a refresh when created, closes the field and moves focus to the tree", async () => {
    act(() => button('New File…').click())
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    typeInto(input, 'new/deep.ts')
    key(input, 'Enter')
    await settle()
    expect(createFile).toHaveBeenCalledWith(ROOT, 'new/deep.ts')
    expect(noteCreated).toHaveBeenCalledWith(ROOT, `${ROOT}/new/deep.ts`, false)
    expect(host.querySelector('.inline-name-input')).toBeNull()
    expect(document.activeElement).toBe(tree())
  })

  it('shows a red bubble as soon as an existing name is typed and does not call main on Enter either', async () => {
    act(() => button('New File…').click())
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    typeInto(input, 'b.ts')
    expect(host.querySelector('.inline-name-error')?.textContent).toContain('b.ts')
    key(input, 'Enter')
    await settle()
    expect(createFile).not.toHaveBeenCalled()
  })

  it('shows the reason-code message in the bubble when main refuses and keeps the field', async () => {
    act(() => button('New Folder…').click())
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    typeInto(input, 'zz')
    key(input, 'Enter')
    await settle()
    expect(createFolder).toHaveBeenCalledWith(ROOT, 'zz')
    expect(host.querySelector('.inline-name-error')?.textContent).toBe(
      'A file or folder zz already exists here. Choose a different name'
    )
    expect(host.querySelector('.inline-name-input')).not.toBeNull()
    expect(noteCreated).not.toHaveBeenCalled()
  })

  it("has 「New File… / New Folder…」 at the top of the row's right-click menu; for a file row it opens in the parent", async () => {
    const rowB = [...tree().querySelectorAll('[role="treeitem"]')].find(
      (el) => el.querySelector('.row-name')?.textContent === 'b.ts'
    ) as HTMLElement
    await act(async () => {
      rowB.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    })
    const labels = [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent)
    expect(labels.slice(0, 2)).toEqual(['New File…', 'New Folder…'])
    expect(labels).toContain('Copy path')
    await act(async () => {
      ;(document.querySelector('.context-menu-item') as HTMLButtonElement).click()
    })
    expect(document.querySelector('.context-menu')).toBeNull()
    expect(rowNames()).toEqual(['w', '<input>', 'a', 'b.ts'])
    // The input takes focus after the focus restore when the menu closes (365-1).
    expect(document.activeElement).toBe(host.querySelector('.inline-name-input'))
  })

  it('「New Folder…」 in the right-click of a folder row opens inside that folder', async () => {
    const rowA = [...tree().querySelectorAll('[role="treeitem"]')].find(
      (el) => el.querySelector('.row-name')?.textContent === 'a'
    ) as HTMLElement
    await act(async () => {
      rowA.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    })
    await act(async () => {
      ;(document.querySelectorAll('.context-menu-item')[1] as HTMLButtonElement).click()
    })
    expect(rowNames()).toEqual(['w', 'a', '<input>', 'x.ts', 'b.ts'])
    expect(host.querySelector('.inline-name-input')?.getAttribute('aria-label')).toBe('New folder name')
  })

  const rowOf = (name: string): HTMLElement =>
    [...tree().querySelectorAll('[role="treeitem"]')].find(
      (el) => el.querySelector('.row-name')?.textContent === name
    ) as HTMLElement

  it('TODO 1145: 「Rename…」 in the right-click turns the row into an input with the old name; Enter calls main and the open file switches to the new URI', async () => {
    useStore.setState({ selectedUri: fileB.uri })
    await act(async () => {
      rowOf('b.ts').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      )
    })
    const labels = [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent ?? '')
    const renameItem = [...document.querySelectorAll('.context-menu-item')].find((el) =>
      (el.textContent ?? '').startsWith('Rename…')
    ) as HTMLButtonElement
    expect(labels.some((label) => label.startsWith('Rename…'))).toBe(true)
    await act(async () => renameItem.click())
    // The b.ts row itself becomes the input (no row is added).
    expect(rowNames()).toEqual(['w', 'a', '<input>'])
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    expect(input.value).toBe('b.ts')
    expect(document.activeElement).toBe(input)
    typeInto(input, 'c.ts')
    key(input, 'Enter')
    await settle()
    expect(rename).toHaveBeenCalledWith(fileB.uri, 'c.ts')
    expect(refresh).toHaveBeenCalledWith(ROOT)
    expect(selectCalls).toContain(`${ROOT}/c.ts`)
    expect(host.querySelector('.inline-name-input')).toBeNull()
    expect(document.activeElement).toBe(tree())
  })

  it("TODO 1145: F2 also starts it and Esc restores (main is not called); a name equal to a sibling's shows a red bubble as soon as it is typed", async () => {
    act(() => tree().focus())
    key(tree(), 'End') // b.ts
    key(tree(), 'F2')
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    expect(input.value).toBe('b.ts')
    typeInto(input, 'A')
    expect(host.querySelector('.inline-name-error')?.textContent).toContain('a')
    key(input, 'Enter')
    await settle()
    expect(rename).not.toHaveBeenCalled()
    key(input, 'Escape')
    expect(host.querySelector('.inline-name-input')).toBeNull()
    expect(rowNames()).toEqual(['w', 'a', 'b.ts'])
    expect(document.activeElement).toBe(tree())
  })

  it('TODO 1145: the message main refused appears in the bubble and the field stays', async () => {
    rename.mockResolvedValueOnce({ uri: null, reason: 'rename-name-slash' })
    act(() => tree().focus())
    key(tree(), 'End')
    key(tree(), 'F2')
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    typeInto(input, 'x.ts')
    key(input, 'Enter')
    await settle()
    expect(host.querySelector('.inline-name-error')?.textContent).toContain('/')
    expect(host.querySelector('.inline-name-input')).not.toBeNull()
  })

  it('closes on Esc and returns focus to the tree', () => {
    act(() => button('New File…').click())
    const input = host.querySelector<HTMLInputElement>('.inline-name-input') as HTMLInputElement
    key(input, 'Escape')
    expect(host.querySelector('.inline-name-input')).toBeNull()
    expect(document.activeElement).toBe(tree())
  })
})
