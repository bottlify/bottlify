/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The drawing half of gdi32: typedefs and the semantics they imply.
 *
 * The bookkeeping half (`win32/gdi32/`) owns what is drawn *with* -- the object
 * table, the pens, brushes, fonts and bitmaps, and the struct offsets they are
 * read from. This half owns what happens to pixels, and it reaches the other
 * half's objects through the same table rather than keeping a second copy of
 * them.
 *
 * Decisions made here, which the functions below must not relitigate:
 *
 * - **A surface is 32-bit BGRX and nothing else.** One pixel width means one
 *   code path for every raster operation, and the conversion cost is paid once,
 *   at the DIB boundary, instead of on every blit. A pixel is stored as the
 *   little-endian DWORD `0x00RRGGBB`, which is the byte order (B, G, R, X) a
 *   32bpp DIB has on disk; a COLORREF is `0x00BBGGRR`, so the two differ by a
 *   red/blue swap and the conversion is not the identity.
 * - **Two pitch rules, and the caller says which.** A DIB pads each row to a
 *   four-byte boundary; a device-dependent bitmap pads to two. Both are
 *   `pitchFor()`, and a surface handed to us by something that already chose a
 *   stride keeps that stride instead. One pixel per row of error is invisible
 *   at the first row and unmistakable by the last.
 * - **Row order is a property of the surface, not of the drawing.** Every
 *   drawing coordinate has its origin at the top-left. A bottom-up surface --
 *   which is what a DIB with a positive height is -- reverses only in the one
 *   function that turns a y into a byte offset.
 * - **Raster operations are decoded, not enumerated.** The high byte of a ROP3
 *   index *is* its truth table over (pattern, source, destination); the fifteen
 *   named codes are entries in a table of 256 and get no special handling. The
 *   operation is bitwise over the whole 32-bit pixel, which is why NOTSRCCOPY
 *   sets the unused byte as well.
 * - **The filling convention is Windows': leading edge in, trailing edge out.**
 *   A filled rectangle covers `[left, right)` by `[top, bottom)`. A shape drawn
 *   with a pen outlines that same half-open rectangle, so its border sits on
 *   `right - 1` and `bottom - 1` and the figure never writes a pixel the next
 *   tile along would also write. `LineTo` draws from the current position up to
 *   but not including its endpoint, for the same reason.
 * - **Clipping is one rectangle.** Regions are a separate piece of work; a
 *   rectangle is what a DirectDraw clipper and an `ETO_CLIPPED` call need.
 *
 * @typedef {Object} Surface
 * @property {number} width
 * @property {number} height
 * @property {number} pitch          Bytes between the starts of two rows.
 * @property {boolean} topDown       False when row zero is the bottom row.
 * @property {Uint8Array} bytes      The whole allocation the rows live in.
 * @property {number} offset         Where row zero starts inside `bytes`.
 * @property {(x: number, y: number) => number} read     Raw 32-bit pixel.
 * @property {(x: number, y: number, pixel: number) => void} write
 * @property {(left: number, top: number, right: number, bottom: number, pixel: number) => void
 *     } [fill]  Every pixel of the half-open rectangle written as `write` writes one, in
 *     runs rather than a call a pixel.
 * @property {(pixel: number) => number} [nearest]
 *           What a write of `pixel` reads back as: the entry an indexed
 *           surface would store, the colour sixteen bits keep. A 32-bit
 *           surface keeps the pixel whole, its unused byte included.
 * @property {boolean} [mono]
 *           A monochrome device-dependent bitmap, which a blit converts to and
 *           from other kinds by the device context's colours rather than by
 *           nearest colour: its 0 bits become the destination's text colour
 *           and its 1 bits the background colour, and a source pixel equal to
 *           the source's background colour becomes 1 in it and every other
 *           pixel 0. A one-bit DIB is not one of these: its bits index a
 *           colour table like any indexed DIB's.
 */

/**
 * A rectangle in the half-open convention above: the pixel at `right` is the
 * first one *not* covered.
 *
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * What a brush contributes at a given surface coordinate. Solid brushes ignore
 * both, hatched ones fold in the brush origin, and a pattern brush tiles.
 *
 * The raw 32-bit pixel the pattern shows at a point; `solid` is that pixel
 * when it is the same everywhere.
 *
 * @typedef {((x: number, y: number) => number) & { solid?: number }} PatternSource
 */

/**
 * The font measurements text positioning is driven by. They arrive injected
 * because the bookkeeping half is what a program asks for them, and a second
 * estimator here would be a second answer to the same question.
 *
 * @typedef {Object} TextMetrics
 * @property {number} cellWidth    Advance from one character origin to the next.
 * @property {number} cellHeight   Full line height, ascent plus descent.
 * @property {number} ascent       Baseline offset from the top of the cell.
 * @property {(code: number) => import("./fonts.js").Glyph | null} [glyphs]
 *           The font engine's glyphs for the selected font, when there is an
 *           engine: each carries its own advance, and `cellWidth` is then
 *           only an average.
 */

/**
 * A device context, as far as drawing is concerned: pixels, the objects
 * selected into it, and the state that says how they are applied.
 *
 * @typedef {Object} DrawingContext
 * @property {Surface} surface
 * @property {Rect} clip
 * @property {number} pen
 * @property {number} brush
 * @property {number} font
 * @property {number} textColor
 * @property {number} bkColor
 * @property {number} bkMode
 * @property {number} rop2
 * @property {number} textAlign
 * @property {number} stretchMode
 * @property {{ x: number, y: number }} position
 * @property {{ x: number, y: number }} brushOrigin
 */

// Intentionally no runtime exports: types are used through JSDoc-import.
