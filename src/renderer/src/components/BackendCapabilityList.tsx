/**
 * TODO 987 (ARCHITECTURE 4.6.1.1): the 4 items of "what this backend can do" (approval / subagent / rewind / MCP).
 * A missing feature is not removed but shown grayed out with a strikethrough, and the reason is given in the title. Shared by the create dialog and settings.
 */
import { BACKEND_CAPABILITY_KEYS, type BackendCapabilities } from '@shared/agent.js'
import { useT } from '../i18n/index.js'

export function BackendCapabilityList({ capabilities }: { readonly capabilities: BackendCapabilities }): React.JSX.Element {
  const t = useT()
  return (
    <ul className="backend-caps" aria-label={t('backendCaps.title')}>
      {BACKEND_CAPABILITY_KEYS.map((key) => (
        <li
          key={key}
          className={capabilities[key] ? 'on' : 'off'}
          title={capabilities[key] ? undefined : t('backendCaps.unavailable')}
        >
          {capabilities[key] ? '✓' : '×'} {t(`backendCaps.${key}`)}
        </li>
      ))}
    </ul>
  )
}
