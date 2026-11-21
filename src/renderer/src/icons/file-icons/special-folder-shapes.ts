/**
 * TODO 958 / 968: our own shapes for the special folders directly under home (the ones Finder gives dedicated icons).
 *
 * Apple's art cannot be bundled, so only glyphs that convey the meaning are drawn (arrow, screen, document, film, note,
 * mountain, person, columns, the letter A, trash). In TODO 968 the 958 design of cutting the glyph out of the folder outline was
 * dropped (users already know it is a folder). The glyphs are drawn at the center of the 32 frame (about 9-23 x 10-24), so
 * `GLYPH_TRANSFORM` scales them by 2.1 (TODO 968 used 1.5, TODO 1011 made it 1.4 times that. A normal folder is Seti's folder:
 * 0.6-31.2 x 3.2-28.8). `FileIcon` applies the fill with `currentColor` (7.4.1). Same shape open or closed.
 */
import type { IconShape } from './seti-shapes.js'

const GLYPH_TRANSFORM = 'translate(16 16) scale(2.1) translate(-16 -17)'

function shape(glyph: string, evenOdd = false): IconShape {
  return { viewBox: '0 0 32 32', paths: [{ d: glyph, transform: GLYPH_TRANSFORM, ...(evenOdd ? { evenOdd: true } : {}) }] }
}

/** Shape of multiple paths (a 2-color drawing, a faint surface for a fold). */
function multi(...paths: readonly { d: string; evenOdd?: boolean; opacity?: number; fillVar?: string }[]): IconShape {
  return { viewBox: '0 0 32 32', paths: paths.map((p) => ({ ...p, transform: GLYPH_TRANSFORM })) }
}

export const SPECIAL_FOLDER_SHAPES = {
  // Down arrow + tray
  Downloads: shape('M14.6 11h2.8v6.2h3.1L16 22.2l-4.5-5h3.1zM11 23.2h10v1.6H11z'),
  // Screen + stand
  Desktop: shape('M9.5 11.5h13v8.5h-13zM13.5 21.5h5v1.5h-5z'),
  // Paper with a folded corner + text lines (the lines are cut out with evenodd; the folded corner is a faint surface)
  Documents: multi(
    { d: 'M11 10h6.5v3.5H21V24H11zM13 15.3h6v1.2h-6zM13 18h6v1.2h-6zM13 20.7h4v1.2h-4z', evenOdd: true },
    { d: 'M17.5 10L21 13.5h-3.5z', opacity: 0.5 }
  ),
  // Red rounded rectangle + white play triangle (both colors are CSS variables)
  Movies: multi(
    { d: 'M12.5 11h7a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z', fillVar: '--file-icon-movies-bg' },
    { d: 'M14.4 14.1l4.8 2.9-4.8 2.9z', fillVar: '--file-icon-movies-mark' }
  ),
  // Eighth note
  Music: shape('M17.6 11.2l4.4-1v3.3l-2.9.7v6.5a2.6 2.6 0 1 1-1.5-2.3z'),
  // Mountain + sun
  Pictures: shape('M10 23l4.2-6 2.8 3.5 2.2-2.7 3.8 5.2zM12.9 11.6a1.7 1.7 0 1 0 .01 0z'),
  // Person
  Public: shape('M16 11a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4zM10.8 23.5c0-3.4 2.3-5.3 5.2-5.3s5.2 1.9 5.2 5.3z'),
  // Building with columns
  Library: shape('M16 10.5l6.5 3.2h-13zM11 15h2v6.5h-2zM15 15h2v6.5h-2zM19 15h2v6.5h-2zM9.8 22.5h12.4v1.6H9.8z'),
  // Rounded rectangle with a white-cut A (App Store style; the outline of the A is cut out with evenodd)
  Applications: shape(
    'M13 10.5h6a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z' +
      'M15.1 12.5h1.8l3.2 9h-1.6l-.7-2h-3.6l-.7 2h-1.6zM16 15.2l-1.1 2.9h2.2z',
    true
  ),
  // Trash can
  Trash: shape('M13.8 10.5h4.4v1.5h3.5v1.5H10.3V12h3.5zM11.2 14.6h9.6l-.7 8.9h-8.2z')
} as const satisfies Record<string, IconShape>

export type SpecialFolderName = keyof typeof SPECIAL_FOLDER_SHAPES
