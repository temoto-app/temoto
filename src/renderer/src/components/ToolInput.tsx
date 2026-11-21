/**
 * Display of a tool call's arguments (item 286, wave 16 bundle A). Used by the tool group of the timeline (`ToolBlock` of `ThreadPane`;
 * rows inside a sub-agent group use the same component) and the approval frame (the "content" of `ApprovalPrompt`).
 * The formatting rules are in `thread/tool-input.ts` (pure function, decided by the argument key, not the tool name).
 */
import { useMemo } from 'react'
import type { JsonValue } from '@shared/agent.js'
import { toolHover, toolInputView } from '../thread/tool-input.js'
import { CopyButton } from './CopyButton.js'

export function ToolInput({ input, className }: { input: JsonValue; className: string }): React.JSX.Element {
  const view = useMemo(() => toolInputView(input), [input])
  if (view.kind === 'json') return <pre className={className}>{view.json}</pre>
  return (
    <div className={`${className} tool-input-view`}>
      {view.command === null ? null : (
        <div className="tool-command">
          <pre className="tool-command-code">{view.command}</pre>
          <CopyButton code={view.command} />
        </div>
      )}
      {view.description === null ? null : <div className="tool-command-description">{view.description}</div>}
      {view.fields.length === 0 ? null : (
        <dl className="tool-fields">
          {view.fields.map((field) => (
            <div key={field.key} className="tool-field">
              <dt>{field.key}</dt>
              <dd className={field.kind === 'text' ? undefined : 'mono'}>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.rest === null ? null : <pre className="tool-input-rest">{view.rest}</pre>}
    </div>
  )
}

/** Contents (full text) of the balloon of a collapsed row. The balloon's frame has the scrolling. */
export function ToolHoverBody({ input, summary }: { input: JsonValue | null; summary: string }): React.JSX.Element {
  return <pre className="tool-hover-text">{toolHover(input, summary).text}</pre>
}
