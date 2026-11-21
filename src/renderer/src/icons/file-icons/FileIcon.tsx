/**
 * Icon at the head of rows in the Files tree and search results (TODO 404, Seti colors). Shapes are in `seti-shapes.ts`; which
 * shape and color is decided by `file-icons.ts` (`fileIconFor`). The fill is `currentColor`, and the color is applied by the
 * `.file-icon-<color>` class via CSS variables (7.4.1). Hidden from screen readers (the name is next to it).
 */
import { useId } from 'react'
import { fileIconFor, SPECIAL_FOLDER_COLORS } from '../../file-icons.js'
import { SETI_SHAPES, type IconShape } from './seti-shapes.js'
import { SPECIAL_FOLDER_SHAPES, type SpecialFolderName } from './special-folder-shapes.js'

export interface FileIconProps {
  readonly name: string
  readonly isDirectory: boolean
  readonly expanded?: boolean
  /** TODO 958: if this is a special folder directly under home, its name (`specialFolderFor`). It gets a dedicated shape and color. */
  readonly special?: SpecialFolderName | null
}

export function FileIcon({ name, isDirectory, expanded = false, special = null }: FileIconProps): React.JSX.Element {
  // `:` / `«»` in a useId value can be misread inside url(#...), so keep only alphanumerics.
  const maskId = `file-icon-cut-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const base = fileIconFor(name, isDirectory, expanded)
  const specialName = isDirectory ? special : null
  const spec: { icon: string; color: string } =
    specialName !== null ? { icon: `folder-${specialName}`, color: SPECIAL_FOLDER_COLORS[specialName] } : base
  const shape: IconShape = specialName !== null ? SPECIAL_FOLDER_SHAPES[specialName] : SETI_SHAPES[base.icon]
  const paths: readonly { d: string; opacity?: number; evenOdd?: boolean; transform?: string; cut?: boolean; fillVar?: string }[] =
    shape.paths
  const fills = paths.filter((p) => p.cut !== true)
  const cuts = paths.filter((p) => p.cut === true)
  const [, , w, h] = shape.viewBox.split(' ')
  return (
    <svg
      className={`file-icon file-icon-${spec.color}`}
      data-icon={spec.icon}
      width="16"
      height="16"
      viewBox={shape.viewBox}
      fill="currentColor"
      aria-hidden="true"
    >
      {cuts.length > 0 ? (
        // The part painted white in the original art is cut out instead of painted (the selected / hover background shows through).
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
          <rect x="0" y="0" width={w} height={h} fill="white" />
          {cuts.map((p, index) => (
            <path
              key={index}
              d={p.d}
              fill="black"
              fillRule={p.evenOdd === true ? 'evenodd' : undefined}
              transform={p.transform}
            />
          ))}
        </mask>
      ) : null}
      <g mask={cuts.length > 0 ? `url(#${maskId})` : undefined}>
        {fills.map((p, index) => (
          <path
            key={index}
            d={p.d}
            opacity={p.opacity}
            fillRule={p.evenOdd === true ? 'evenodd' : undefined}
            clipRule={p.evenOdd === true ? 'evenodd' : undefined}
            transform={p.transform}
            style={p.fillVar !== undefined ? { fill: `var(${p.fillVar})` } : undefined}
          />
        ))}
      </g>
    </svg>
  )
}
