/**
 * The rainbow color of the viewer heading (item 190). The viewer is remembered per thread (item 63), so the color is
 * **the color of the working directory of the thread currently shown** (`Thread.rainbow`, decided by main, item 108).
 * Even if the opened file is outside the cwd, it is painted in the thread's color. No-folder (scratch area) and no-cwd give null
 * (= no color, same as the conversation heading). The temporary view (`aios.diff`, item 104) uses the same color.
 *
 * The selector returns only the number (a number or null) and does not build a value (React #185).
 */
import type React from 'react'
import { useThreads } from './threadStore.js'
import { rainbowStyle } from './rainbow.js'

export function useViewerAccentStyle(): React.CSSProperties | undefined {
  const rainbow = useThreads((state) =>
    state.activeThreadId === null
      ? null
      : (state.threadsById[state.activeThreadId]?.thread.rainbow ?? null)
  )
  return rainbowStyle(rainbow)
}
