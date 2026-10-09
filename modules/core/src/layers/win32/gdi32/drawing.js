/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gdi32 entry points that move pixels, and the objects that only exist
 * because drawing needs them: regions, palettes and pixel formats.
 *
 * Nothing here draws. The drawing lives one layer over, and `win32` may not
 * reach it -- `graphics` declares `win32` in its requires, so an import the
 * other way closes a cycle the boundary check refuses. So the pixels arrive as
 * an injected service, and this file is the guest ABI in front of it: read the
 * arguments, resolve the handles, call, and turn the answer back into what a
 * Win32 program expects.
 *
 * A build without that service still exports every one of these. They fail
 * truthfully -- FALSE, or a null handle -- rather than reporting success and
 * drawing nowhere, because a program that is told its blit worked has no reason
 * to look again and every reason to carry on.
 *
 * Two decisions are worth stating:
 *
 * - **A region is an area of rectangles** in the banded form `regions.js`
 *   keeps, the same pieces the drawing half clips to. Its object holds the
 *   bounding rectangle as its own four fields -- what user32 reads when a
 *   program names an area to repaint by a region -- and, when it is not that
 *   rectangle, the pieces beside them. Every way of making and combining one
 *   is exact.
 * - **A palette selects and realizes but changes nothing.** Every surface here
 *   is 32-bit BGRX, so there is no palette for a palette to be. Reporting that
 *   zero entries changed is the truth about this pipeline, and it is also what
 *   a program checks before deciding to redraw.
 */

import { readRect, writeU16, writeU32s } from '../user32/structs.js';

export { bezierPoints } from './paths.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { boundsOf, intersectArea, subtractFromArea } from './rects.js';
import {
    ALTERNATE, RGN_AND, RGN_COPY, RGN_DIFF, WINDING, areaBox, areaContains, areaOf, areasEqual,
    combineAreas, offsetArea, orderedRect, polygonArea, roundedArea,
} from './regions.js';
import {
    PT_BEZIERTO, PT_CLOSEFIGURE, PT_LINETO, PT_MOVETO, bezierPoints, createPath,
    ellipseCurves, figuresOf, flattened, pathBezierTo, pathClose, pathFigure, pathLineTo,
    pathMoved, widened,
} from './paths.js';
import {
    BITMAP,
    BITMAPCOREHEADER,
    BITMAPINFOHEADER,
    DIBSECTION,
    PALETTEENTRY_SIZE,
    colorEntryBytes,
    ddbStride,
    dibStride,
    isDibHeaderSize,
    logFontBytes,
    paletteEntryToPixel,
    readBitmapInfoHeader,
    readU32,
} from './structs.js';

/**
 * iUsage of the DIB functions: a colour table of RGBQUADs, or of WORD
 * indices into the palette the DC has selected -- or, for the calls that draw
 * a DIB, no table and pixels that are palette indices themselves.
 */
const DIB_PAL_COLORS = 1;
const DIB_PAL_INDICES = 2;

/** The drawing layer's name for a sixteen-bit surface made in 5-6-5. */
const RGB_565 = '565';

/** A FLOAT crosses the ABI as its 32 bits, on the stack and through a pointer. */
const FLOAT_BITS = new DataView(new ArrayBuffer(4));
/** @param {number} bits @returns {number} */
const floatOf = bits=>(FLOAT_BITS.setUint32(0, bits >>> 0, true), FLOAT_BITS.getFloat32(0, true));
/** @param {number} value @returns {number} */
const bitsOf = value=>(FLOAT_BITS.setFloat32(0, value, true), FLOAT_BITS.getUint32(0, true));

/**
 * The default palette's twenty colours, the ones a palette device keeps for
 * itself: eight dark, four pale, eight bright. 0x00RRGGBB. They are the
 * entries of the CreatePalette record a Windows metafile holds for the stock
 * palette, which Wine's metafile tests replay.
 */
export const DEFAULT_PALETTE_COLORS = Object.freeze([
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
    0xc0dcc0, 0xa6caf0, 0xfffbf0, 0xa0a0a4,
    0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
]);

/** The sixteen VGA colours, in the order a four-bit DIB indexes them. */
const VGA_COLORS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 12, 7, 13, 14, 15, 16, 17, 18, 19]
    .map(entry=>DEFAULT_PALETTE_COLORS[entry]));

/**
 * What an eight-bit DIB indexes when the bitmap has no table of its own: the
 * default palette's first ten and last ten colours at either end, and between
 * them a cube of three bits of red, three of green and two of blue.
 */
const EIGHT_BIT_COLORS = Object.freeze([...Array(256).keys()].map(index=>{
    if (index < 10 || index >= 246)
    {
        return DEFAULT_PALETTE_COLORS[index < 10 ? index : index - 236];
    }
    return ((index & 0x07) << 21) | ((index & 0x38) << 10) | (index & 0xc0);
}));

/**
 * A halftone palette's entries, as PALETTEENTRYs: the default palette's first
 * eight, a cube of six levels of each channel, twenty-four greys between black
 * and white, and the default palette's last eight.
 */
const HALFTONE_ENTRIES = Object.freeze((()=>{
    /** @param {number} red @param {number} green @param {number} blue */
    const entry = (red, green, blue)=>(red | green << 8 | blue << 16) >>> 0;
    /** @param {number} pixel */
    const fromPixel = pixel=>entry(pixel >>> 16 & 0xff, pixel >>> 8 & 0xff, pixel & 0xff);
    const levels = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
    const cube = levels.flatMap(red=>levels.flatMap(green=>levels.map(blue=>
        entry(red, green, blue))));
    const greys = [...Array(24).keys()].map(step=>{
        const grey = Math.round((step + 1) * 255 / 25);
        return entry(grey, grey, grey);
    });
    return [...DEFAULT_PALETTE_COLORS.slice(0, 8).map(fromPixel), ...cube, ...greys,
        ...DEFAULT_PALETTE_COLORS.slice(12).map(fromPixel)];
})());

/**
 * The colour table GetDIBits reads a bitmap out against at an indexed depth:
 * an indexed section's own at its own depth, and otherwise black and white at
 * one bit, the VGA colours at four and the default table at eight -- what
 * Wine's test_GetDIBits finds for a device-dependent bitmap.
 *
 * @param {any} shape  The bitmap's attributes.
 * @param {number} bitCount  1, 4 or 8.
 * @returns {readonly number[]}
 */
function colorTableFor(shape, bitCount){
    if ((shape.section >>> 0) !== 0 && shape.bitCount === bitCount && shape.palette)
    {
        return [...shape.palette];
    }
    if (bitCount === 1)
    {
        return [0x000000, 0xffffff];
    }
    return bitCount === 4 ? VGA_COLORS : EIGHT_BIT_COLORS;
}
/**
 * The compressions the DIB decoder reads: none, and BI_BITFIELDS -- no
 * compression either, the three channels named by masks -- at 16 and 32 bits.
 */
const BI_RGB = 0;
const BI_BITFIELDS = 3;

/**
 * Run-length encoded DIBs, each at the one depth it encodes: whole pictures
 * only, which the calls that draw a DIB decode and GetDIBits never writes.
 *
 * @param {import('./structs.js').BitmapInfoHeaderFields} header
 */
const isRle = header=>(header.compression === 1 && header.bitCount === 8)
    || (header.compression === 2 && header.bitCount === 4);

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PIXEL_FORMAT = 2000;
/** What SelectClipPath says when the DC has no closed path to clip to. */
const ERROR_CAN_NOT_COMPLETE = 1003;
const ERROR_NOACCESS = 998;

/** SetStretchBltMode's first and last modes. */
const BLACKONWHITE = 1;
const HALFTONE = 4;
/** Bits per pixel the DIB decoder reads. */
const DIB_BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);

/** CombineRgn's modes. */
/** GdiSetBatchLimit's limit until a program sets one. */
/** The two ways an arc can run. */
const AD_COUNTERCLOCKWISE = 1;
const AD_CLOCKWISE = 2;
/** The graphics mode in which a figure's box is taken whole. */
const GM_ADVANCED = 2;

/**
 * What a call that is not a path's reaches while a path is open on a DC
 * with no pixels: every method there, and none of them drawing.
 */
const NOTHING_DRAWN = new Proxy({}, { get: ()=>()=>false });
/** ExtFloodFill's types: up to a border of the colour, or over a surface of it. */
const FLOODFILLBORDER = 0;
const FLOODFILLSURFACE = 1;
/**
 * A BLENDFUNCTION's one operation, and the AlphaFormat that says the source
 * carries a premultiplied alpha in each pixel.
 */
const AC_SRC_OVER = 0;
const AC_SRC_ALPHA = 1;
/**
 * GradientFill's last mode, triangles; the two before it are rectangles
 * shaded across and shaded down.
 */
const GRADIENT_FILL_TRIANGLE = 2;
/** A TRIVERTEX: LONG x and y, then COLOR16 red, green, blue and alpha. */
const TRIVERTEX_SIZE = 16;

/**
 * A TRIVERTEX as the drawing layer takes one: the point on the device, each
 * channel its sixteen bits.
 *
 * @typedef {{ x: number, y: number, red: number, green: number, blue: number,
 *     alpha: number }} TriVertex
 */
const DEFAULT_BATCH_LIMIT = 20;
/** The static colours are the system's: GetSystemPaletteUse. */
const SYSPAL_STATIC = 1;
/** What SetSystemPaletteUse answers on a device without a system palette. */
const SYSPAL_ERROR = 0;
/** The flag that reserves a palette entry for AnimatePalette. */
const PC_RESERVED = 0x01;
/** The most entries a logical palette holds. */
const MAX_PALETTE_ENTRIES = 1024;
/** What a call that answers a colour or an index says when it failed. */
const CLR_INVALID = 0xffffffff;
/** SetMapperFlags' flag for fonts of the device's own aspect ratio. */
const ASPECT_FILTERING = 0x0001;
/** Pixels per logical inch on the display, across and down. */
const LOGICAL_DPI = 96;

/** EnumObjects' two kinds, and the styles of what it hands over. */
const OBJ_PEN = 1;
const OBJ_BRUSH = 2;
const PS_SOLID = 0;
const BS_SOLID = 0;
const BS_HATCHED = 2;
/** HS_HORIZONTAL through HS_DIAGCROSS. */
const HATCHES = Object.freeze([0, 1, 2, 3, 4, 5]);
/**
 * The sixteen colours a display offers as solid pens and brushes, as
 * COLORREFs: black and white, the six full primaries and their mixes, the
 * six at half strength, and the two greys.
 */
const STANDARD_COLORS = Object.freeze([
    0x000000, 0xffffff, 0x0000ff, 0x00ff00, 0xff0000, 0x00ffff, 0xff00ff, 0xffff00,
    0x000080, 0x008000, 0x008080, 0x800000, 0x800080, 0x808000, 0x808080, 0xc0c0c0,
]);


/** What CombineRgn and its relatives report about the shape they produced. */
const NULLREGION = 1;
const SIMPLEREGION = 2;
const COMPLEXREGION = 3;
const REGION_ERROR = 0;


/**
 * RGNDATAHEADER, then the rectangles. iType is the only value it may hold, and
 * a caller that walks the buffer reads nCount rectangles out of the tail.
 */
const RGNDATAHEADER_SIZE = 32;
const RECT_SIZE = 16;
const RDH_RECTANGLES = 1;


/** What a call that should have returned a UINT says when it failed. */
const GDI_ERROR = 0xffffffff;

/** A gamma ramp is three arrays of 256 words, one per channel. */
const GAMMA_CHANNEL_ENTRIES = 256;
const GAMMA_RAMP_BYTES = 3 * GAMMA_CHANNEL_ENTRIES * 2;

/**
 * How far an entry may stray from the identity (index times 256) before
 * SetDeviceGammaRamp refuses the ramp. Wine's dc.c test_gamma takes a ramp
 * that wraps round midway -- exactly this far out at index 128 -- and refuses
 * every ramp that goes further (a channel of zeros, of the low byte alone, or
 * one at full from its second entry), so half the range is the bound.
 */
const GAMMA_MAX_DEVIATION = 0x8000;

/**
 * @typedef {{ red: Uint16Array, green: Uint16Array, blue: Uint16Array }} GammaRamp
 */

/**
 * The ramp at `bytes`, or null when SetDeviceGammaRamp would refuse it.
 *
 * @param {Uint8Array} bytes  768 little-endian words: red, green, blue.
 * @returns {GammaRamp | null}
 */
function readGammaRamp(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, GAMMA_RAMP_BYTES);
    const channels = [0, 1, 2].map(channel=>Uint16Array.from({ length: GAMMA_CHANNEL_ENTRIES },
        (_, index)=>view.getUint16((channel * GAMMA_CHANNEL_ENTRIES + index) * 2, true)));
    for (const channel of channels)
    {
        for (let index = 0; index < GAMMA_CHANNEL_ENTRIES; index++)
        {
            if (Math.abs(channel[index] - index * 256) > GAMMA_MAX_DEVIATION)
            {
                return null;
            }
        }
    }
    return { red: channels[0], green: channels[1], blue: channels[2] };
}

/**
 * @typedef {Object} DrawingServices
 * @property {(options: { objects: any, metrics: (font: number) => any }) => any}
 *           [createDrawing]
 *           Called once, and answers with the drawing interface. Absent in a
 *           build that cannot draw.
 * @property {(record: any, bitmap: any) => any | null} [surfaceFor]
 *           The pixels a device context draws into, given the context and
 *           what it reports as its surface -- the selected bitmap's own
 *           attributes for a memory context -- or null when it has none.
 * @property {() => void} [presentDesktop]
 *           Shows the desktop the window contexts draw into. Absent in a
 *           build with nothing to show it on.
 * @property {(font: import('./structs.js').LogFontFields) => FontMeasure | null} [fontMetrics]
 *           What the font engine measures for a font; null, or absent, when
 *           there is no engine and the estimate stands.
 * @property {(code: number, font: import('./structs.js').LogFontFields) => {
 *     advance: number, left: number, top: number, width: number, height: number,
 *     coverage: Uint8Array } | null} [glyph]
 *           One character's coverage in a font, as the engine draws it; null,
 *           or absent, without an engine.
 * @property {(font: import('./structs.js').LogFontFields, text: string) => number | null}
 *           [textWidth]
 *           How wide the engine draws a string in a font; null, or absent,
 *           without an engine.
 * @property {(family: string, bytes: Uint8Array) => Promise<boolean>} [addFont]
 *           A program's own font, drawn under its family name from then on;
 *           false, or absent, where none can be taken.
 * @property {any} [pixelFormat]
 *           The pixel-format service: `choose(descriptor)`, `describe(index)`,
 *           `count()`, and `set(hdc, index)` / `get(hdc)` for the format a
 *           drawable carries. The format lives there and not on the DC: a
 *           program sets it through this library and creates its context
 *           through OPENGL32, and the two must be reading one record. Absent
 *           in a build with no rendering surface.
 * @property {(hdc: number) => boolean | Promise<boolean>} [swapBuffers]
 *           Presents the frame an OpenGL context drew into a device context.
 *           Absent in a build that cannot draw, where SwapBuffers fails rather
 *           than presenting nothing. A promise is a frame presented and the
 *           call held until the device has room for another.
 * @property {(ramp: GammaRamp) => void} [setGammaRamp]
 *           Makes a ramp the display's, which every frame is then shown
 *           through. Absent, a ramp set is kept here and read back only.
 * @property {() => GammaRamp | null} [gammaRamp]
 *           The ramp the display shows through, whoever set it -- a
 *           full-screen device's included -- or null for the identity.
 * @property {() => boolean} [appliesGamma]
 *           Whether a ramp set reaches the picture at all.
 */

/**
 * The measurements a font engine answers with, named as TEXTMETRIC names
 * them so they overlay an estimate field for field.
 *
 * @typedef {Pick<import('./structs.js').TextMetricFields, 'height' | 'ascent' | 'descent'
 *     | 'internalLeading' | 'externalLeading' | 'aveCharWidth' | 'maxCharWidth'>} FontMeasure
 */

/** @param {any} rect */
const isEmpty = rect=>rect.right <= rect.left || rect.bottom <= rect.top;

/** @param {number} mode  Whether it is ALTERNATE or WINDING. */
const isFillMode = mode=>(mode | 0) === ALTERNATE || (mode | 0) === WINDING;

/**
 * The masks GetDIBits reads a bitmap out in when it is asked for BI_BITFIELDS:
 * the bitmap's own at its own depth -- a section's masks, 5-6-5 for a
 * device-dependent bitmap or a surface made in it, 5-5-5 for any other
 * sixteen-bit section -- and otherwise the layout a display has at that depth.
 *
 * @param {any} shape  The bitmap's attributes.
 * @param {number} bitCount  The depth asked for, 16 or 32.
 * @returns {number[]} red, green and blue
 */
function masksFor(shape, bitCount){
    if (shape.bitCount === bitCount && shape.compression === BI_BITFIELDS && shape.bitfields)
    {
        return [...shape.bitfields];
    }
    if (bitCount === 32)
    {
        return [0x00ff0000, 0x0000ff00, 0x000000ff];
    }
    return shape.bitCount === 16 && (shape.section >>> 0) !== 0 && shape.format !== RGB_565
        ? [0x7c00, 0x03e0, 0x001f]
        : [0xf800, 0x07e0, 0x001f];
}

/**
 * The points of an arc along the ellipse a rectangle bounds, counterclockwise
 * on the screen from where the start radial meets it to where the end radial
 * does, a segment for about every two pixels of the way.
 *
 * @param {number} left @param {number} top @param {number} right @param {number} bottom
 * @param {number} xStart @param {number} yStart @param {number} xEnd @param {number} yEnd
 * @returns {{ x: number, y: number }[]}
 */
export function arcPoints(left, top, right, bottom, xStart, yStart, xEnd, yEnd){
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const rx = Math.abs(right - left) / 2;
    const ry = Math.abs(bottom - top) / 2;
    // Screen y grows downward, so counterclockwise is the angle of -y. A
    // radial meets the ellipse at the parameter whose point lies along it,
    // which is not the radial's own angle unless the ellipse is a circle.
    const from = Math.atan2((cy - yStart) * rx, (xStart - cx) * ry);
    let to = Math.atan2((cy - yEnd) * rx, (xEnd - cx) * ry);
    if (to <= from)
    {
        to += 2 * Math.PI;
    }
    const steps = Math.max(8, Math.ceil((to - from) * Math.max(rx, ry) / 2));
    return Array.from({ length: steps + 1 }, (_, index)=>{
        const angle = from + (to - from) * index / steps;
        return {
            x: Math.round(cx + rx * Math.cos(angle)),
            y: Math.round(cy - ry * Math.sin(angle)),
        };
    });
}

/**
 * The outline of a rounded rectangle, clockwise from the top edge: each
 * corner a quarter of an ellipse of the radii given, inside the box.
 *
 * @param {{ left: number, top: number, right: number, bottom: number }} box
 * @param {number} rx @param {number} ry
 * @returns {{ x: number, y: number }[]}
 */
export function roundRectPoints(box, rx, ry){
    const right = box.right - 1;
    const bottom = box.bottom - 1;
    const corners = [
        { cx: right - rx, cy: box.top + ry, from: Math.PI / 2 },
        { cx: right - rx, cy: bottom - ry, from: 0 },
        { cx: box.left + rx, cy: bottom - ry, from: -Math.PI / 2 },
        { cx: box.left + rx, cy: box.top + ry, from: -Math.PI },
    ];
    const steps = Math.max(2, Math.ceil(Math.max(rx, ry) / 2));
    return corners.flatMap(({ cx, cy, from })=>Array.from({ length: steps + 1 }, (_, index)=>{
        const angle = from - (Math.PI / 2) * index / steps;
        return {
            x: Math.round(cx + rx * Math.cos(angle)),
            y: Math.round(cy - ry * Math.sin(angle)),
        };
    }));
}

/**
 * The points LineDDA hands its callback: one for each step along the longer
 * axis, the last point left out, the shorter axis at the nearest whole
 * position to the true line -- a half rounded back towards the start. Those
 * are the points Windows answers with in Wine's test_linedda, in every
 * octant. The position is kept as a running quotient and remainder, so no
 * product of two coordinates is ever formed and none can outgrow a double.
 *
 * @param {number} xStart @param {number} yStart @param {number} xEnd @param {number} yEnd
 * @returns {Generator<{ x: number, y: number }>}
 */
export function* lineDdaPoints(xStart, yStart, xEnd, yEnd){
    const dx = xEnd - xStart;
    const dy = yEnd - yStart;
    const across = Math.abs(dx) >= Math.abs(dy);
    const major = Math.max(Math.abs(dx), Math.abs(dy));
    const minor = Math.min(Math.abs(dx), Math.abs(dy));
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    // The shorter axis is at floor((2 * step * minor + major - 1) / (2 * major)).
    let offset = 0;
    let remainder = major - 1;
    for (let step = 0; step < major; step++)
    {
        yield across
            ? { x: xStart + stepX * step, y: yStart + stepY * offset }
            : { x: xStart + stepX * offset, y: yStart + stepY * step };
        remainder += 2 * minor;
        while (remainder >= 2 * major)
        {
            remainder -= 2 * major;
            offset++;
        }
    }
}

/**
 * Whether three corners make a triangle GradientFill refuses: on one line
 * and not all one point. Windows takes a triangle that is a single point --
 * and draws nothing -- but fails the call over one that is a line, which is
 * what Wine's test_GdiGradientFill finds.
 *
 * @param {{ x: number, y: number }} a @param {{ x: number, y: number }} b
 * @param {{ x: number, y: number }} c
 */
const isFlatTriangle = (a, b, c)=>(b.x - a.x) * (c.y - a.y) === (c.x - a.x) * (b.y - a.y)
    && !(a.x === b.x && b.x === c.x && a.y === b.y && b.y === c.y);

/**
 * Whether a bitmap's pixels carry an alpha AlphaBlend can read: 32 bits, in
 * the 8-8-8 layout a BI_RGB DIB has -- BI_BITFIELDS naming that layout is the
 * same thing, and any other masks are not (Wine's test_GdiAlphaBlend).
 *
 * @param {any} shape  What the DC reports as its surface.
 */
const hasAlphaChannel = shape=>shape.bitCount === 32 && (shape.compression !== BI_BITFIELDS
    || [0xff0000, 0x00ff00, 0x0000ff].every((mask, index)=>
        (shape.bitfields?.[index] >>> 0) === mask));

/**
 * Whether a PolyDraw type array is one Windows draws: every entry a move, a
 * line (closing or not) or the first of three curve points whose middle one
 * does not close. Nothing is drawn from an array that is not.
 *
 * @param {Uint8Array} types
 */
export function isPolyDrawable(types){
    for (let index = 0; index < types.length; index++)
    {
        const type = types[index];
        if (type === PT_MOVETO || (type & ~PT_CLOSEFIGURE) === PT_LINETO)
        {
            continue;
        }
        if (type !== PT_BEZIERTO || index + 2 >= types.length || types[index + 1] !== PT_BEZIERTO
            || (types[index + 2] & ~PT_CLOSEFIGURE) !== PT_BEZIERTO)
        {
            return false;
        }
        index += 2;
    }
    return true;
}

/**
 * @param {Object} options
 * @param {any} options.host
 * @param {any} options.objects   The GDI object table.
 * @param {(handle: number) => any | null} options.dcOf
 * @param {(dc: any) => any} options.surfaceOf   What the DC reports about its size.
 * @param {(dc: any) => any} options.currentMetrics
 * @param {<T>(bitmap: number, action: (hdc: number) => T) => T} options.lend
 *        Runs `action` over a context of the bookkeeping half's own with the
 *        bitmap in it, wherever else the bitmap is selected.
 * @param {(at: number, count: number, usage: number, dc: any, entryBytes?: number)
 *        => number[]} options.readColorTable
 *        A DIB's colour table as colours, whatever its usage says it holds;
 *        a table of colours has entries `entryBytes` apart, four by default.
 * @param {(dc: any, point: { x: number, y: number }) => { x: number, y: number }}
 *        options.toDevice  A logical point as the device sees it, as LPtoDP maps it.
 * @param {(dc: any, point: { x: number, y: number }) => { x: number, y: number }}
 *        [options.toLogical]  A device point as the DC's logical space names it, as
 *        DPtoLP maps it; the identity when absent.
 * @param {(dc: any, text: string) => number[] | null} [options.spacedAdvances]
 *        Each character's advance under the DC's character spacing and
 *        justification, or null when neither is set.
 * @returns The entry points; `bound`, the drawing interface a context is
 *     bound to, for the window manager, which paints its own controls through
 *     the same engine without a guest string to read; and `setDIBits`, which
 *     CreateDIBitmap initialises a bitmap with.
 */
export function createDrawingFunctions(
    { host, objects, dcOf, surfaceOf, currentMetrics, lend, readColorTable, toDevice,
        toLogical = (dc, point)=>point, spacedAdvances = ()=>null })
{
    /** @type {DrawingServices} */
    const services = host.graphics ?? {};
    /** The display's ramp, when there is no graphics layer to hold it. @type {GammaRamp | null} */
    let keptGammaRamp = null;

    /**
     * The drawing interface, built on first use and only if there is one.
     *
     * Lazy because a process that never draws should not pay for it, and
     * because the object table it is given has to be this one -- a second copy
     * would resolve a pen handle to a different pen.
     */
    /** A refusal the program reads with GetLastError. @param {number} code */
    const refuse = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /** @type {any} */
    let drawing;
    const draw = ()=>{
        if (drawing === undefined)
        {
            drawing = services.createDrawing
                ? services.createDrawing({
                    objects,
                    /** @param {number} font */
                    metrics: font=>{
                        const record = objects.get(font);
                        const measured = currentMetrics({ font: record ? font : 0 });
                        return {
                            cellWidth: measured.aveCharWidth,
                            cellHeight: measured.height,
                            ascent: measured.ascent,
                        };
                    },
                })
                : null;
        }
        return drawing;
    };

    /**
     * A POINT array out of guest memory.
     *
     * @param {number} address @param {number} count
     * @returns {{ x: number, y: number }[]}
     */
    const pointsAt = (address, count)=>{
        const bytes = host.readMemory(address, Math.max(0, count) * 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: Math.floor(bytes.byteLength / 8) }, (_, at)=>(
            { x: view.getInt32(at * 8, true), y: view.getInt32(at * 8 + 4, true) }));
    };

    /**
     * DWORDs out of guest memory, signed and not.
     *
     * @param {number} address @param {number} count
     */
    const readI32s = (address, count)=>{
        const bytes = host.readMemory(address, Math.max(0, count) * 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: Math.floor(bytes.byteLength / 4) }, (_, at)=>
            view.getInt32(at * 4, true));
    };
    /** @param {number} address @param {number} count */
    const readU32s = (address, count)=>readI32s(address, count).map(value=>value >>> 0);

    /**
     * Polygons laid one after another in a POINT array, each as long as its
     * entry in an array of counts: what PolyPolygon, PolyPolyline and
     * CreatePolyPolygonRgn are given. Null when an array is missing, there
     * are no polygons, or one is shorter than `least` points.
     *
     * @param {number} points @param {number} counts @param {number} polygons
     * @param {number} least
     * @returns {{ x: number, y: number }[][] | null}
     */
    const polygonsAt = (points, counts, polygons, least)=>{
        const many = polygons >>> 0;
        if ((points >>> 0) === 0 || (counts >>> 0) === 0 || many === 0 || many > 0x10000)
        {
            return null;
        }
        const sizes = readU32s(counts >>> 0, many);
        if (sizes.some(size=>size < least || size > 0x100000))
        {
            return null;
        }
        const all = pointsAt(points >>> 0, sizes.reduce((sum, size)=>sum + size, 0));
        let at = 0;
        return sizes.map(size=>all.slice(at, at += size));
    };

    /**
     * A rectangle a clip call names in logical units, as the device has it:
     * the clip is kept in device units, as a region is.
     *
     * @param {any} dc @param {number} left @param {number} top
     * @param {number} right @param {number} bottom
     */
    const deviceArea = (dc, left, top, right, bottom)=>{
        const a = toDevice(dc, { x: left | 0, y: top | 0 });
        const b = toDevice(dc, { x: right | 0, y: bottom | 0 });
        return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
            right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
    };

    /**
     * Binds a device context to its pixels, once, and answers with the drawing
     * context. Null when this build cannot draw or this DC has no surface --
     * both of which the caller must turn into a truthful failure.
     *
     * @param {number} handle
     * @param {boolean} [present]
     *        Whether a draw through this context puts the desktop on the
     *        screen. True for a draw the program made, which is a frame; false
     *        for the window manager's own background, which is not -- showing
     *        the desktop colour as a frame was the blank screen a display was
     *        handed before the program had drawn anything.
     */
    const bound = (handle, present = true, source = 0)=>{
        const drawn = pixelsOf(handle, present, true, source);
        const dc = dcOf(handle);
        return dc?.path?.open ? recording(dc, drawn) : drawn;
    };

    /**
     * The drawing context over a DC's pixels, as `bound` describes it, for
     * every call; `bound` hands the path calls to the path instead while one
     * is open.
     *
     * @param {number} handle @param {boolean} present
     * @param {boolean} [mapped]  False for the context in device units
     *        whatever the DC's mapping, for a caller that maps for itself.
     * @param {number} [source]  A blit's source DC: mapped as well when only
     *        it moves its origin -- a program that paints a strip into a DC
     *        whose origin is the strip's corner and copies it out at the
     *        strip's place in the window names the source by the window's
     *        coordinates.
     */
    const pixelsOf = (handle, present, mapped = true, source = 0)=>{
        const dc = dcOf(handle);
        const interfaces = draw();
        if (!dc || !interfaces || !services.surfaceFor)
        {
            return null;
        }
        if (dc.kind === 'window' && dc.window !== 0)
        {
            host.windowContextCurrent?.(handle >>> 0);
        }
        // The emulator grows its memory in place, which detaches every view of
        // it taken before the growth; a view on a detached buffer is empty. A
        // bound surface is one such view, held for the bitmap's life, so after
        // a growth it would read zeroes and swallow every write. Its bytes
        // being gone is the growth, and the pixels are at the same guest
        // address, so it is taken again rather than trusted.
        if (dc.boundSurface && dc.boundSurface.bytes && dc.boundSurface.bytes.length === 0)
        {
            dc.boundSurface = null;
        }
        if (!dc.boundSurface)
        {
            const surface = services.surfaceFor(dc, surfaceOf(dc));
            if (!surface)
            {
                return null;
            }
            interfaces.bind(handle >>> 0, surface, dc);
            dc.boundSurface = surface;
            // A clip set before the pixels were bound, or before they were
            // bound again, still holds.
            pushClip(handle, dc, interfaces);
            // So does a brush origin; the drawing context starts at zero.
            if (dc.brushOrg)
            {
                interfaces.setBrushOrgEx?.(handle >>> 0, dc.brushOrg.x, dc.brushOrg.y);
            }
        }
        // A window's pixels are the desktop's, and a program that fetches its
        // window's DC once and blits into it every frame -- never through
        // BeginPaint/EndPaint, never releasing it between frames -- is a real
        // and common shape, not a special case. Gating the desktop's
        // presentation on ReleaseDC or an internal repaint, and not on the
        // draw itself, leaves such a program's every frame after the first
        // invisible. The presenter already coalesces a burst of these onto
        // one flush, so calling it once per drawing entry point costs nothing
        // a real frame does not already pay for.
        if (present && dc.kind !== 'memory')
        {
            services.presentDesktop?.();
        }
        const other = (source >>> 0) === 0 ? null : dcOf(source);
        return mapped && (mapsAway(dc) || (other ? mapsAway(other) : false))
            ? mappedView(dc, interfaces) : interfaces;
    };

    /** Whether text drawn into a path has been reported. */
    let textInPathSaid = false;

    /**
     * The drawing context while a path is open: the calls that draw lines
     * and curves add them to the path and draw nothing; the current position
     * moves as their drawing would move it. Every other call -- a blit, a
     * fill of a rectangle -- draws, as it does on Windows with a path open,
     * through the DC's pixels when it has any.
     *
     * The path is kept on the device, as Windows keeps it: each point is
     * mapped as it is added, and a box -- a rectangle's, an ellipse's -- is
     * ordered and has its far edges taken off there (Wine's test_rectangle,
     * under a mirroring viewport). GetPath maps the points back.
     *
     * Text drawn into a path adds its glyphs' outlines on Windows. The glyphs
     * here are bitmaps with no outline to add, so text adds nothing, and that
     * is reported.
     *
     * @param {any} dc @param {any} drawn  The pixels' context, or null.
     */
    const recording = (dc, drawn)=>{
        const path = dc.path;
        /** @param {{ x: number, y: number }} point */
        const device = point=>toDevice(dc, point);
        /** @param {number} x @param {number} y */
        const at = (x, y)=>({ x: x | 0, y: y | 0 });
        const clockwise = dc.arcDirection === AD_CLOCKWISE;
        // GM_COMPATIBLE leaves out the right and bottom edges of a box, as
        // the drawn figure does; GM_ADVANCED takes the box as it is.
        const inclusive = dc.graphicsMode === GM_ADVANCED;
        /** @param {number} left @param {number} top @param {number} right @param {number} bottom */
        const deviceBox = (left, top, right, bottom)=>{
            const a = device(at(left, top));
            const b = device(at(right, bottom));
            return orderedRect(a.x, a.y, b.x, b.y);
        };
        const textless = ()=>{
            if (!textInPathSaid)
            {
                textInPathSaid = true;
                host.divergence?.('BeginPath', 'text drawn into a path adds no outline to it');
            }
            return true;
        };
        /** @type {Record<string, (...args: any[]) => any>} */
        const calls = {
            moveToEx: (hdc, x, y)=>{
                const previous = { ...dc.position };
                dc.position = at(x, y);
                pathMoved(path);
                return previous;
            },
            lineTo: (hdc, x, y)=>{
                pathLineTo(path, device(dc.position), device(at(x, y)));
                dc.position = at(x, y);
                return true;
            },
            bezierTo: (hdc, first, second, end)=>{
                pathBezierTo(path, device(dc.position), device(first), device(second),
                    device(end));
                dc.position = at(end.x, end.y);
                return true;
            },
            polygon: (hdc, points)=>{
                pathFigure(path, points.map(device), { closed: true });
                return true;
            },
            polyPolygon: (hdc, rings)=>{
                for (const points of rings)
                {
                    pathFigure(path, points.map(device), { closed: true });
                }
                return true;
            },
            // Windows' own order: from the top right corner along the top
            // when counterclockwise, from the bottom right along the bottom
            // when not; an edge with no length shrinks neither side (Wine's
            // test_rectangle).
            rectangle: (hdc, left, top, right, bottom)=>{
                const box = deviceBox(left, top, right, bottom);
                if (!inclusive && box.right > box.left && box.bottom > box.top)
                {
                    box.right--;
                    box.bottom--;
                }
                const corners = [{ x: box.right, y: box.top }, { x: box.left, y: box.top },
                    { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom }];
                pathFigure(path, clockwise ? [corners[3], corners[2], corners[1], corners[0]]
                    : corners, { closed: true });
                return true;
            },
            ellipse: (hdc, left, top, right, bottom)=>{
                const box = deviceBox(left, top, right, bottom);
                if (!inclusive)
                {
                    box.right = Math.max(box.left, box.right - 1);
                    box.bottom = Math.max(box.top, box.bottom - 1);
                }
                pathFigure(path, ellipseCurves(box, clockwise), { closed: true, curves: true });
                return true;
            },
            textOutA: textless,
            extTextOutA: textless,
        };
        return Object.assign(Object.create(drawn ?? NOTHING_DRAWN), calls);
    };

    /**
     * Whether a DC's logical space is not its device's: an origin moved, an
     * extent scaled, a layout mirrored. Most never are, and are drawn into
     * as they are.
     *
     * @param {any} dc
     */
    const mapsAway = dc=>{
        const near = toDevice(dc, { x: 0, y: 0 });
        const far = toDevice(dc, { x: 4096, y: 4096 });
        return near.x !== 0 || near.y !== 0 || far.x !== 4096 || far.y !== 4096;
    };

    /**
     * The drawing context as a program addresses it through a mapped DC:
     * every point, rectangle and size a drawing call is given taken from the
     * DC's logical space to its device's, as LPtoDP maps it, and a blit's
     * source from its own DC's. A framework paints a control that has no
     * window of its own -- an image, a label -- into its parent's DC with
     * the window origin moved to the control's corner; drawn unmapped, it
     * lands at the parent's corner. The calls that map for themselves
     * (AlphaBlend, TransparentBlt, GradientFill, SetDIBitsToDevice) and the
     * clip, which is kept in device units, reach the context as they are.
     *
     * @param {any} dc @param {any} interfaces
     */
    const mappedView = (dc, interfaces)=>{
        /** @param {number} x @param {number} y */
        const point = (x, y)=>toDevice(dc, { x: x | 0, y: y | 0 });
        /** @param {{ left: number, top: number, right: number, bottom: number }} rect */
        const area = rect=>{
            const a = point(rect.left, rect.top);
            const b = point(rect.right, rect.bottom);
            return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
                right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
        };
        // A width and height are the far corner's distance, sign and all: a
        // negative extent is a mirrored stretch, which a mapping can make.
        /** @param {number} x @param {number} y @param {number} width @param {number} height */
        const box = (x, y, width, height)=>{
            const a = point(x, y);
            const b = point((x | 0) + (width | 0), (y | 0) + (height | 0));
            return [a.x, a.y, b.x - a.x, b.y - a.y];
        };
        /**
         * A call that draws from the current position and may move it.
         *
         * @template T @param {() => T} drawn @returns {T}
         */
        const through = drawn=>{
            const logical = { x: dc.position?.x | 0, y: dc.position?.y | 0 };
            const start = point(logical.x, logical.y);
            dc.position = { ...start };
            try
            {
                return drawn();
            }
            finally
            {
                const moved = dc.position ?? start;
                dc.position = { x: logical.x + (moved.x - start.x),
                    y: logical.y + (moved.y - start.y) };
            }
        };
        /** @param {number} source @param {number} x @param {number} y */
        const from = (source, x, y)=>{
            const other = dcOf(source);
            return other ? toDevice(other, { x: x | 0, y: y | 0 }) : { x: x | 0, y: y | 0 };
        };
        /** @type {Record<string, (...args: any[]) => any>} */
        const calls = {
            setPixel: (hdc, x, y, color)=>{
                const at = point(x, y);
                return interfaces.setPixel(hdc, at.x, at.y, color);
            },
            getPixel: (hdc, x, y)=>{
                const at = point(x, y);
                return interfaces.getPixel(hdc, at.x, at.y);
            },
            bitBlt: (hdc, x, y, width, height, source, srcX, srcY, rop)=>{
                const [dx, dy, dw, dh] = box(x, y, width, height);
                const at = from(source, srcX, srcY);
                return interfaces.bitBlt(hdc, dx, dy, dw, dh, source, at.x, at.y, rop);
            },
            stretchBlt: (hdc, x, y, width, height, source, srcX, srcY, srcWidth, srcHeight,
                rop)=>
            {
                const [dx, dy, dw, dh] = box(x, y, width, height);
                const other = dcOf(source);
                const [sx, sy, sw, sh] = other
                    ? (()=>{
                        const a = toDevice(other, { x: srcX | 0, y: srcY | 0 });
                        const b = toDevice(other, { x: (srcX | 0) + (srcWidth | 0),
                            y: (srcY | 0) + (srcHeight | 0) });
                        return [a.x, a.y, b.x - a.x, b.y - a.y];
                    })()
                    : [srcX, srcY, srcWidth, srcHeight];
                return interfaces.stretchBlt(hdc, dx, dy, dw, dh, source, sx, sy, sw, sh, rop);
            },
            maskBlt: (hdc, x, y, width, height, source, srcX, srcY, mask, maskX, maskY, rop)=>{
                const [dx, dy, dw, dh] = box(x, y, width, height);
                const at = from(source, srcX, srcY);
                return interfaces.maskBlt(hdc, dx, dy, dw, dh, source, at.x, at.y, mask,
                    maskX, maskY, rop);
            },
            patBlt: (hdc, x, y, width, height, rop)=>{
                const [dx, dy, dw, dh] = box(x, y, width, height);
                return interfaces.patBlt(hdc, dx, dy, dw, dh, rop);
            },
            floodFill: (hdc, x, y, color, type)=>{
                const at = point(x, y);
                return interfaces.floodFill(hdc, at.x, at.y, color, type);
            },
            fillRect: (hdc, rect, brush)=>interfaces.fillRect(hdc, area(rect), brush),
            frameRect: (hdc, rect, brush)=>interfaces.frameRect(hdc, area(rect), brush),
            invertRect: (hdc, rect, halftone)=>interfaces.invertRect(hdc, area(rect), halftone),
            rectangle: (hdc, left, top, right, bottom)=>{
                const mapped = area({ left, top, right, bottom });
                return interfaces.rectangle(hdc, mapped.left, mapped.top, mapped.right,
                    mapped.bottom);
            },
            ellipse: (hdc, left, top, right, bottom)=>{
                const mapped = area({ left, top, right, bottom });
                return interfaces.ellipse(hdc, mapped.left, mapped.top, mapped.right,
                    mapped.bottom);
            },
            polygon: (hdc, points, fillMode)=>interfaces.polygon(hdc,
                points.map((/** @type {{ x: number, y: number }} */ at)=>point(at.x, at.y)),
                fillMode),
            polyPolygon: (hdc, rings, fillMode, parts)=>interfaces.polyPolygon(hdc,
                rings.map((/** @type {{ x: number, y: number }[]} */ points)=>points.map(at=>
                    point(at.x, at.y))), fillMode, parts),
            // The current position is the DC's own, in its logical units --
            // MoveToEx sets it and GetCurrentPositionEx reads it -- and the
            // context draws from it: for the length of a call it stands in
            // device units, and afterwards it is logical again, moved by as
            // much as the call moved it.
            moveToEx: (hdc, x, y)=>{
                const previous = { ...dc.position };
                dc.position = { x: x | 0, y: y | 0 };
                return previous;
            },
            lineTo: (hdc, x, y)=>through(()=>{
                const at = point(x, y);
                return interfaces.lineTo(hdc, at.x, at.y);
            }),
            textOutA: (hdc, x, y, text)=>through(()=>{
                const at = point(x, y);
                return interfaces.textOutA(hdc, at.x, at.y, text);
            }),
            extTextOutA: (hdc, x, y, flags, rect, text, dx)=>through(()=>{
                const at = point(x, y);
                return interfaces.extTextOutA(hdc, at.x, at.y, flags, rect ? area(rect) : rect,
                    text, dx);
            }),
            drawPicture: (hdc, x, y, picture, width = picture.width, height = picture.height)=>{
                const [dx, dy, dw, dh] = box(x, y, width, height);
                return interfaces.drawPicture(hdc, dx, dy, picture, dw, dh);
            },
            stretchDIBits: (hdc, request)=>{
                const [dx, dy, dw, dh] = box(request.xDest, request.yDest, request.destWidth,
                    request.destHeight);
                return interfaces.stretchDIBits(hdc, { ...request, xDest: dx, yDest: dy,
                    destWidth: dw, destHeight: dh });
            },
        };
        return Object.assign(Object.create(interfaces), calls);
    };

    /**
     * A DIB as a program hands one to the device: the header, the colour
     * table that follows it when the format has one, and the bits, read from
     * guest memory into the shape the drawing layer decodes.
     *
     * A BI_BITFIELDS DIB's masks sit where a colour table would, forty bytes
     * in, which in a larger header is inside the header rather than after it.
     * A table shorter than the depth allows leaves the indices past it black.
     * A run-length encoded DIB is biSizeImage bytes, which it must give, and
     * bottom-up, a top-down one being ERROR_INVALID_PARAMETER; any other DIB
     * must have planes, which an RLE one need not (Wine's test_dib_formats and
     * RLE tests).
     *
     * @param {number} info @param {number} bits
     * @param {number} usage  What the colour table holds.
     * @param {any} dc  Whose palette a palette-relative table indexes.
     * @param {number} [lines]  How many rows the bits hold: all of them by default.
     * @param {boolean} [lazy]  The bits and the colour table read when the drawing
     *     first asks for them, for a caller that hands the DIB on and is done with it
     *     before it returns: a picture the clip leaves out is never read.
     * @returns {{ header: import('./structs.js').BitmapInfoHeaderFields, bits: Uint8Array,
     *             colors: number[], masks: number[] } | null}
     */
    const readDib = (info, bits, usage, dc, lines, lazy = false)=>{
        const header = readBitmapInfoHeader(host, info);
        const masked = header.compression === BI_BITFIELDS
            && (header.bitCount === 16 || header.bitCount === 32);
        const rle = isRle(header);
        if (rle && header.height < 0)
        {
            host.setLastError?.(ERROR_INVALID_PARAMETER);
            return null;
        }
        if (!isDibHeaderSize(header.size) || header.width <= 0 || header.height === 0
            || !DIB_BIT_COUNTS.has(header.bitCount) || (rle && header.sizeImage === 0)
            || (!rle && header.planes === 0)
            || (header.compression !== BI_RGB && !masked && !rle) || usage > DIB_PAL_INDICES)
        {
            return null;
        }
        const masks = masked
            ? [0, 4, 8].map(at=>readU32(host, info + BITMAPINFOHEADER.SIZE + at))
            : [];
        const stride = ((header.width * header.bitCount + 31) >> 5) * 4;
        const rows = lines ?? Math.abs(header.height);
        // DIB_PAL_INDICES has no table for biClrUsed to shorten.
        const size = 1 << header.bitCount;
        const count = usage === DIB_PAL_INDICES ? size : Math.min(header.clrUsed || size, size);
        const readColors = ()=>(header.bitCount <= 8
            ? readColorTable(info + header.size, count, usage, dc, colorEntryBytes(header))
            : []);
        const readBits = ()=>host.readMemory(bits, rle ? header.sizeImage : stride * rows);
        if (!lazy)
        {
            return { header, bits: readBits(), colors: readColors(), masks };
        }
        /** @type {Uint8Array | null} */
        let read = null;
        /** @type {number[] | null} */
        let table = null;
        return {
            header,
            masks,
            get bits(){
                const bytes = read ?? readBits();
                read = bytes;
                return bytes;
            },
            get colors(){
                const colors = table ?? readColors();
                table = colors;
                return colors;
            },
        };
    };

    /**
     * SetDIBits: scan lines of a DIB converted into a bitmap's own format.
     *
     * The DIB's picture lies against the bitmap's top-left corner and the
     * supplied lines land where they belong in it (Wine's test_SetDIBits);
     * a row outside the bitmap is dropped. The answer is the lines handed
     * in, however many of them landed. Unlike the calls that draw a DIB, this
     * one checks a BI_BITFIELDS DIB's masks, and takes DIB_PAL_INDICES only
     * into a monochrome bitmap, whose palette is its black and white (Wine's
     * test_dib_formats).
     *
     * @param {number} bitmap @param {number} start @param {number} lines
     * @param {number} bits @param {number} info @param {number} usage
     * @param {any} dc  Whose palette a palette-relative table indexes.
     * @returns {number}
     */
    const setDIBits = (bitmap, start, lines, bits, info, usage, dc)=>{
        const shape = objects.get(bitmap)?.attributes;
        const monochrome = shape?.bitCount === 1 && (shape.section >>> 0) === 0;
        const image = usage === DIB_PAL_INDICES && !monochrome ? null
            : readDib(info, bits, usage, dc, lines);
        if (!image || image.masks.some(mask=>mask === 0))
        {
            return 0;
        }
        if (usage === DIB_PAL_INDICES)
        {
            image.colors = image.colors.map((_, index)=>((index & 1) === 0 ? 0 : 0xffffff));
        }
        const header = image.header;
        const answer = lend(bitmap, target=>bound(target, false)?.setDIBitsToDevice(target, {
            xDest: 0, yDest: 0, width: header.width, height: Math.abs(header.height),
            xSrc: 0, ySrc: 0, firstScan: start, scans: lines, image,
        }) ?? null);
        // An RLE DIB answers its height, as SetDIBitsToDevice does for one.
        if (answer === null)
        {
            return 0;
        }
        return isRle(header) ? answer : lines;
    };

    /** @param {any} a @param {any} b */
    const intersect = (a, b)=>({
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    });

    /**
     * A logical rectangle on the device: its corner mapped, and its extents
     * the distance between the mapped corners, signed -- a mapping that
     * flips an axis flips the extent.
     *
     * @param {any} dc @param {number} x @param {number} y @param {number} width
     * @param {number} height
     */
    const deviceRect = (dc, x, y, width, height)=>{
        const corner = toDevice(dc, { x: x | 0, y: y | 0 });
        const far = toDevice(dc, { x: (x | 0) + (width | 0), y: (y | 0) + (height | 0) });
        return { x: corner.x, y: corner.y, width: far.x - corner.x, height: far.y - corner.y };
    };

    /**
     * The pixels a signed device rectangle covers, as a rectangle.
     *
     * @param {{ x: number, y: number, width: number, height: number }} rect
     */
    const spanOf = ({ x, y, width, height })=>({
        left: Math.min(x, x + width), top: Math.min(y, y + height),
        right: Math.max(x, x + width), bottom: Math.max(y, y + height),
    });

    /**
     * How far a DC's pixels reach: its window's part of the screen, the
     * screen, or the bitmap selected into it.
     *
     * @param {any} dc
     * @returns {{ width: number, height: number }}
     */
    const extentOf = dc=>(dc.bounds
        ? { width: dc.bounds.right - dc.bounds.left, height: dc.bounds.bottom - dc.bounds.top }
        : surfaceOf(dc));

    /**
     * A TRIVERTEX out of guest memory, its point mapped to the device.
     *
     * @param {any} dc @param {number} address
     * @returns {TriVertex}
     */
    const readVertex = (dc, address)=>{
        const bytes = host.readMemory(address, TRIVERTEX_SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, TRIVERTEX_SIZE);
        const point = toDevice(dc, { x: view.getInt32(0, true), y: view.getInt32(4, true) });
        return {
            x: point.x, y: point.y,
            red: view.getUint16(8, true), green: view.getUint16(10, true),
            blue: view.getUint16(12, true), alpha: view.getUint16(14, true),
        };
    };

    /**
     * The clip a DC is drawing under: what was last selected, or the whole
     * surface when nothing was. Kept on the DC because the drawing layer
     * holds the rectangle and answers no question about it.
     *
     * @param {any} dc
     */
    const clipOf = dc=>{
        if (dc.clip)
        {
            return dc.clip;
        }
        const surface = surfaceOf(dc);
        return { left: 0, top: 0, right: surface.width, bottom: surface.height };
    };

    /** @param {number} handle @param {any} dc @param {any} rect */
    const setClip = (handle, dc, rect)=>{
        dc.clip = { ...rect };
        dc.clipRects = null;
        dc.clipSelected = true;
        pushClip(handle, dc, bound(handle));
    };

    /**
     * The clip as the pieces it is made of: one rectangle, or the several a
     * hole cut in it left.
     *
     * @param {any} dc
     * @returns {import('./rects.js').Rect[]}
     */
    const clipAreaOf = dc=>dc.clipRects ?? [clipOf(dc)];

    /**
     * What a DC draws in: its clip, cut to the part of its window the window
     * manager leaves it -- on the screen, under no other window, inside a
     * paint's update area -- which no clip the program selects can widen.
     *
     * @param {any} dc
     * @returns {import('./rects.js').Rect[]}
     */
    const drawnAreaOf = dc=>{
        // The meta region SetMetaRgn fixed bounds the clip selected since,
        // and the window's visible part bounds both.
        const api = dc.meta
            ? dc.meta.flatMap((/** @type {import('./rects.js').Rect} */ piece)=>
                intersectArea(clipAreaOf(dc), piece))
            : clipAreaOf(dc);
        return dc.visible
            ? dc.visible.flatMap((/** @type {import('./rects.js').Rect} */ piece)=>
                intersectArea(api, piece))
            : api;
    };

    /**
     * What GetRandomRgn's APIRGN is: the meta region and the clip together,
     * whichever of them there are; null with neither.
     *
     * @param {any} dc
     * @returns {import('./rects.js').Rect[] | null}
     */
    const apiAreaOf = dc=>{
        if (dc.meta && dc.clipSelected)
        {
            return dc.meta.flatMap((/** @type {import('./rects.js').Rect} */ piece)=>
                intersectArea(clipAreaOf(dc), piece));
        }
        return dc.meta ?? (dc.clipSelected ? clipAreaOf(dc) : null);
    };

    /**
     * Gives the drawing layer what a DC draws in.
     *
     * @param {number} handle @param {any} dc @param {any} interfaces  The bound drawing layer.
     * @returns {boolean} whether the drawing layer took it
     */
    const pushClip = (handle, dc, interfaces)=>{
        if (!interfaces)
        {
            return false;
        }
        const area = areaOf(drawnAreaOf(dc));
        return (area.length > 1
            ? interfaces.setClipRegion(handle >>> 0, area)
            : interfaces.setClipRect(handle >>> 0,
                area[0] ?? { left: 0, top: 0, right: 0, bottom: 0 })) !== false;
    };

    /**
     * The part of its window a DC may draw in, in its own coordinates, as
     * the window manager works it out; null for no limit.
     *
     * @param {number} handle @param {import('./rects.js').Rect[] | null} area
     */
    const setVisible = (handle, area)=>{
        const dc = dcOf(handle);
        if (!dc)
        {
            return false;
        }
        dc.visible = area ? area.map(piece=>({ ...piece })) : null;
        return pushClip(handle, dc, bound(handle));
    };

    /**
     * Clips to an area, and answers what kind of region it is.
     *
     * @param {number} handle @param {any} dc @param {import('./rects.js').Rect[]} pieces
     */
    const setClipArea = (handle, dc, pieces)=>{
        const area = areaOf(pieces);
        if (area.length <= 1)
        {
            const rect = area[0] ?? { left: 0, top: 0, right: 0, bottom: 0 };
            setClip(handle, dc, rect);
            return isEmpty(rect) ? NULLREGION : SIMPLEREGION;
        }
        dc.clip = boundsOf(area);
        dc.clipRects = area;
        dc.clipSelected = true;
        pushClip(handle, dc, bound(handle));
        return COMPLEXREGION;
    };

    /**
     * What kind of region an area is, as the clipping calls report it.
     *
     * @param {import('./rects.js').Rect[]} area
     */
    const areaKind = area=>{
        const pieces = area.filter(piece=>!isEmpty(piece)).length;
        return pieces === 0 ? NULLREGION : pieces === 1 ? SIMPLEREGION : COMPLEXREGION;
    };

    /**
     * The rectangle an arc's ellipse lies in, whichever way round its corners
     * were given: the one Ellipse fills, its right and bottom edges left out
     * (Wine's test_arcs draws nothing on them).
     *
     * @param {number[]} box  left, top, right, bottom.
     */
    const ellipseBox = ([left, top, right, bottom])=>({
        left: Math.min(left | 0, right | 0),
        top: Math.min(top | 0, bottom | 0),
        right: Math.max(left | 0, right | 0) - 1,
        bottom: Math.max(top | 0, bottom | 0) - 1,
    });

    /**
     * An arc's outline in the DC's arc direction, from the start radial's end
     * of it to the end radial's: Arc's, ArcTo's, and the curved side of Chord
     * and Pie.
     *
     * @param {any} dc @param {number[]} box  left, top, right, bottom, then the radials.
     */
    const directedArc = (dc, box)=>{
        const { left, top, right, bottom } = ellipseBox(box);
        const [xStart, yStart, xEnd, yEnd] = box.slice(4).map(value=>value | 0);
        // Clockwise is the counterclockwise arc from the end radial back.
        return dc?.arcDirection === AD_CLOCKWISE
            ? arcPoints(left, top, right, bottom, xEnd, yEnd, xStart, yStart).reverse()
            : arcPoints(left, top, right, bottom, xStart, yStart, xEnd, yEnd);
    };

    /**
     * Chord and Pie: the arc closed into a figure -- by its chord, or through
     * the ellipse's centre -- filled with the brush and outlined with the
     * pen. A rectangle with no inside has no ellipse, and nothing is drawn.
     *
     * @param {number[]} args  hdc, the rectangle, the two radials.
     * @param {boolean} pie
     */
    const closedArc = ([handle, ...box], pie)=>{
        const interfaces = bound(handle);
        if (!interfaces)
        {
            return 0;
        }
        const { left, top, right, bottom } = ellipseBox(box);
        if (right < left || bottom < top)
        {
            return 1;
        }
        const points = directedArc(dcOf(handle), box);
        const centre = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
        return interfaces.polygon(handle >>> 0, pie ? [centre, ...points] : points) ? 1 : 0;
    };

    /**
     * Lines from the current position through each point, which leaves the
     * position at the last of them: how the -To calls draw.
     *
     * @param {any} interfaces @param {number} handle @param {{ x: number, y: number }[]} points
     */
    const lineThrough = (interfaces, handle, points)=>{
        for (const point of points)
        {
            interfaces.lineTo(handle >>> 0, point.x, point.y);
        }
    };

    /**
     * A cubic curve from the current position, which is `from`: kept as a
     * curve by a path, drawn as the lines it is made of otherwise.
     *
     * @param {any} interfaces @param {number} handle @param {{ x: number, y: number }} from
     * @param {{ x: number, y: number }} first @param {{ x: number, y: number }} second
     * @param {{ x: number, y: number }} end
     */
    const curveTo = (interfaces, handle, from, first, second, end)=>{
        if (interfaces.bezierTo)
        {
            interfaces.bezierTo(handle >>> 0, first, second, end);
            return;
        }
        lineThrough(interfaces, handle, bezierPoints(from, first, second, end).slice(1));
    };

    /**
     * What the path calls answer without a path of the kind they need: no
     * path, or one still open where a closed one is wanted.
     *
     * @param {number} handle
     */
    const pathRefused = handle=>refuse(dcOf(handle) ? ERROR_CAN_NOT_COMPLETE
        : ERROR_INVALID_HANDLE);

    /**
     * The inside of a DC's path, by its fill mode; null for a path with
     * nothing in it.
     *
     * @param {any} dc
     * @returns {import('./rects.js').Rect[] | null}
     */
    const pathArea = dc=>(dc.path.points.length === 0 ? null
        : polygonArea(figuresOf(dc.path).map(figure=>figure.points), dc.polyFillMode));

    /**
     * FillPath, StrokePath and StrokeAndFillPath: the closed path drawn, and
     * then gone. The fill goes first so that the outline is drawn over it,
     * and the outline's lines leave the current position where it was.
     *
     * @param {number} handle @param {{ fill: boolean, stroke: boolean }} parts
     */
    const drawPath = (handle, parts)=>{
        const dc = dcOf(handle);
        if (!dc?.path || dc.path.open)
        {
            return pathRefused(handle);
        }
        // The path is on the device already.
        const interfaces = pixelsOf(handle, true, false);
        if (!interfaces)
        {
            return 0;
        }
        const figures = figuresOf(dc.path);
        dc.path = null;
        if (parts.fill && figures.length > 0)
        {
            interfaces.polyPolygon(handle >>> 0, figures.map(figure=>figure.points),
                dc.polyFillMode, { fill: true, stroke: false });
        }
        if (parts.stroke)
        {
            const back = { ...dc.position };
            for (const { points, closed } of figures)
            {
                interfaces.moveToEx(handle >>> 0, points[0].x, points[0].y);
                lineThrough(interfaces, handle, closed ? [...points.slice(1), points[0]]
                    : points.slice(1));
            }
            dc.position = back;
        }
        return 1;
    };

    /**
     * A bitmap whose colour table was made palette-relative holds indices
     * into a palette, so changing the palette's entries changes what the
     * bitmap's pixels mean. The resolved arrays are kept alive on the
     * palette and refreshed here in place -- the surfaces that already hold
     * a reference to them see it.
     *
     * @param {any} record  The palette.
     */
    const refreshDependents = record=>{
        const held = record.attributes.entries;
        for (const dependent of record.attributes.dependents ?? [])
        {
            for (let index = 0; index < dependent.indices.length; index++)
            {
                dependent.table[index] = paletteEntryToPixel(held[dependent.indices[index]] ?? 0);
            }
        }
    };

    /** @param {number} handle @returns {any | null} */
    const regionOf = handle=>{
        const record = objects.get(handle);
        return record && record.type === 'region' ? record.attributes : null;
    };

    /**
     * What a region object's attributes are for an area: the bounding
     * rectangle, all zeros when it is empty, and the pieces beside it when
     * it is more than one.
     *
     * @param {import('./rects.js').Rect[]} area  In the banded form.
     */
    const regionAttributes = area=>(area.length > 1
        ? { ...areaBox(area), rects: area }
        : { ...areaBox(area) });

    /**
     * The pixels a region holds, as pieces in the banded form; null for a
     * handle that is not a region. A region another layer filled in holds
     * only its four fields.
     *
     * @param {number} handle
     * @returns {import('./rects.js').Rect[] | null}
     */
    const areaOfRegion = handle=>{
        const held = regionOf(handle);
        if (!held)
        {
            return null;
        }
        if (held.rects)
        {
            return held.rects;
        }
        const rect = orderedRect(held.left, held.top, held.right, held.bottom);
        return isEmpty(rect) ? [] : [rect];
    };

    /**
     * Makes a region object hold an area, and answers what kind of region it
     * now is.
     *
     * @param {any} record @param {import('./rects.js').Rect[]} pieces
     */
    const holdArea = (record, pieces)=>{
        const area = areaOf(pieces);
        record.attributes = regionAttributes(area);
        return areaKind(area);
    };

    /**
     * A new region holding an area.
     *
     * @param {import('./rects.js').Rect[]} pieces
     */
    const regionHolding = pieces=>objects.create('region', regionAttributes(areaOf(pieces)));

    /** @param {any} rect  Any two opposite corners. */
    const newRegion = rect=>regionHolding([orderedRect(rect.left, rect.top, rect.right,
        rect.bottom)]);

    let batchLimit = DEFAULT_BATCH_LIMIT;

    const functions = {
        /**
         * BOOL BitBlt(HDC hdc, int x, int y, int cx, int cy, HDC hdcSrc,
         *             int x1, int y1, DWORD rop)
         */
        BitBlt: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, source, x1, y1, rop])=>{
                const interfaces = bound(dest, true, source);
                if (!interfaces)
                {
                    return 0;
                }
                // A source DC is bound too, and separately: a blit whose source
                // has no pixels is a blit that cannot happen, not one that
                // reads zeroes.
                if ((source >>> 0) !== 0 && !bound(source))
                {
                    return 0;
                }
                return interfaces.bitBlt(dest >>> 0, x | 0, y | 0, cx | 0, cy | 0,
                    (source >>> 0) || null, x1 | 0, y1 | 0, rop >>> 0) ? 1 : 0;
            },
        },

        /**
         * BOOL MaskBlt(HDC hdcDest, int xDest, int yDest, int width, int height,
         *   HDC hdcSrc, int xSrc, int ySrc, HBITMAP hbmMask, int xMask, int yMask,
         *   DWORD rop)
         *
         * BitBlt with a monochrome mask laid over the destination from
         * (xMask, yMask): where its bit is 1 the foreground operation applies,
         * the ROP3 in the rop's third byte, and where it is 0 the background
         * one in its high byte, as MAKEROP4 packs them. No mask is BitBlt with
         * the foreground operation. A mask of any other depth is refused, as
         * MSDN says it is an error.
         */
        MaskBlt: {
            argBytes: 48,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, source, x1, y1, mask, xMask, yMask, rop])=>{
                if ((mask >>> 0) === 0)
                {
                    return functions.BitBlt.handler([dest, x, y, cx, cy, source, x1, y1,
                        (rop & 0x00ffffff) >>> 0]);
                }
                const record = objects.get(mask);
                const interfaces = bound(dest, true, source);
                if (!interfaces || record?.type !== 'bitmap' || record.attributes.bitCount !== 1)
                {
                    return 0;
                }
                if ((source >>> 0) !== 0 && !bound(source))
                {
                    return 0;
                }
                return lend(mask >>> 0, bits=>(bound(bits, false)
                    && interfaces.maskBlt(dest >>> 0, x | 0, y | 0, cx | 0, cy | 0, source >>> 0,
                        x1 | 0, y1 | 0, bits >>> 0, xMask | 0, yMask | 0, rop >>> 0) ? 1 : 0));
            },
        },

        /**
         * BOOL PatBlt(HDC hdc, int x, int y, int w, int h, DWORD rop)
         *
         * A blit with no source: the raster operation combines the brush with
         * what is there, which is how a program clears a rectangle to its
         * background or inverts one.
         */
        PatBlt: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, rop])=>{
                const interfaces = bound(dest);
                return interfaces && interfaces.patBlt(dest >>> 0, x | 0, y | 0, cx | 0, cy | 0,
                    rop >>> 0) ? 1 : 0;
            },
        },

        /**
         * BOOL StretchBlt(HDC hdc, int x, int y, int w, int h, HDC hdcSrc,
         *                 int x1, int y1, int w1, int h1, DWORD rop)
         */
        StretchBlt: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, source, x1, y1, cx1, cy1, rop])=>{
                const interfaces = bound(dest, true, source);
                if (!interfaces || !bound(source))
                {
                    return 0;
                }
                return interfaces.stretchBlt(dest >>> 0, x | 0, y | 0, cx | 0, cy | 0,
                    source >>> 0, x1 | 0, y1 | 0, cx1 | 0, cy1 | 0, rop >>> 0) ? 1 : 0;
            },
        },

        /**
         * BOOL GdiTransparentBlt(HDC hdcDest, int xDest, int yDest, int wDest, int hDest,
         *   HDC hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, UINT crTransparent)
         *
         * The source stretched over the destination, its pixels of the key
         * colour left out -- what msimg32's TransparentBlt is. As AlphaBlend,
         * its sibling there, both rectangles are logical and mapped through
         * their own DC, and the source must then lie inside the source's
         * pixels. A negative extent, or a source rectangle reaching outside
         * the source, fails the call; MSDN names no error for either, and
         * none is set.
         */
        GdiTransparentBlt: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, source, x1, y1, cx1, cy1, key])=>{
                const dc = dcOf(dest);
                const from = dcOf(source);
                if (!dc || !from || (cx | 0) < 0 || (cy | 0) < 0 || (cx1 | 0) < 0
                    || (cy1 | 0) < 0)
                {
                    return 0;
                }
                const target = deviceRect(dc, x, y, cx, cy);
                const read = deviceRect(from, x1, y1, cx1, cy1);
                const within = extentOf(from);
                const box = spanOf(read);
                if (box.left < 0 || box.top < 0 || box.right > within.width
                    || box.bottom > within.height)
                {
                    return 0;
                }
                const interfaces = bound(dest);
                if (!interfaces || !bound(source))
                {
                    return 0;
                }
                return interfaces.transparentBlt(dest >>> 0, target.x, target.y, target.width,
                    target.height, source >>> 0, read.x, read.y, read.width, read.height,
                    key >>> 0) ? 1 : 0;
            },
        },

        /**
         * BOOL GdiAlphaBlend(HDC hdcDest, int xDest, int yDest, int wDest, int hDest,
         *   HDC hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, BLENDFUNCTION blend)
         *
         * The source stretched over the destination and blended into it. The
         * BLENDFUNCTION comes by value, its four bytes in one argument:
         * BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat.
         *
         * Both rectangles are logical and mapped through their own DC; the
         * source must then lie inside the source's pixels. What Wine's
         * test_GdiAlphaBlend finds Windows refuses with
         * ERROR_INVALID_PARAMETER: a negative extent in either rectangle --
         * one the mapping would flip is still drawn, mirrored -- a source
         * rectangle not inside the source, the two rectangles overlapping in
         * one DC, and AC_SRC_ALPHA from a source with no alpha byte. So is a
         * BLENDFUNCTION that MSDN says cannot be: another operation, flags
         * that are not zero, a format with other bits. A null source fails
         * without a reason.
         */
        GdiAlphaBlend: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, source, x1, y1, cx1, cy1, blend])=>{
                const dc = dcOf(dest);
                const from = dcOf(source);
                if (!dc || !from)
                {
                    return 0;
                }
                const format = blend >>> 24;
                if ((blend & 0xff) !== AC_SRC_OVER || ((blend >>> 8) & 0xff) !== 0
                    || (format & ~AC_SRC_ALPHA) !== 0
                    || (cx | 0) < 0 || (cy | 0) < 0 || (cx1 | 0) < 0 || (cy1 | 0) < 0)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const target = deviceRect(dc, x, y, cx, cy);
                const read = deviceRect(from, x1, y1, cx1, cy1);
                const within = extentOf(from);
                const box = spanOf(read);
                const overlapping = (dest >>> 0) === (source >>> 0)
                    && !isEmpty(intersect(spanOf(target), box));
                if (box.left < 0 || box.top < 0 || box.right > within.width
                    || box.bottom > within.height || overlapping
                    || (format === AC_SRC_ALPHA && !hasAlphaChannel(surfaceOf(from))))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const interfaces = bound(dest);
                if (!interfaces || !bound(source))
                {
                    return 0;
                }
                return interfaces.alphaBlend(dest >>> 0, target.x, target.y, target.width,
                    target.height, source >>> 0, read.x, read.y, read.width, read.height,
                    { constantAlpha: (blend >>> 16) & 0xff, perPixel: format === AC_SRC_ALPHA })
                    ? 1 : 0;
            },
        },

        /**
         * BOOL GdiGradientFill(HDC hdc, PTRIVERTEX pVertex, ULONG nVertex,
         *   PVOID pMesh, ULONG nMesh, ULONG ulMode)
         *
         * Rectangles shaded across or down, or triangles shaded between their
         * corners; the mesh is GRADIENT_RECTs or GRADIENT_TRIANGLEs of vertex
         * indices, and the vertices are logical points mapped to the device.
         * As Wine's test_GdiGradientFill finds: a context there is not, no
         * vertices, no mesh or an unknown mode is ERROR_INVALID_PARAMETER; an
         * index past the vertices, or a triangle that is a line, fails the
         * call with no reason given and nothing drawn; a rectangle or
         * triangle that is one point draws nothing and succeeds.
         */
        GdiGradientFill: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, vertices, count, mesh, entries, mode])=>{
                const dc = dcOf(handle);
                if (!dc || (vertices >>> 0) === 0 || (count >>> 0) === 0 || (mesh >>> 0) === 0
                    || (entries >>> 0) === 0 || (mode >>> 0) > GRADIENT_FILL_TRIANGLE)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const corners = (mode >>> 0) === GRADIENT_FILL_TRIANGLE ? 3 : 2;
                const indices = host.readMemory(mesh >>> 0, (entries >>> 0) * corners * 4);
                const view = new DataView(indices.buffer, indices.byteOffset, indices.byteLength);
                const listed = Array.from({ length: entries >>> 0 }, (_, entry)=>
                    Array.from({ length: corners }, (__, corner)=>
                        view.getUint32((entry * corners + corner) * 4, true)));
                if (listed.some(entry=>entry.some(index=>index >= (count >>> 0))))
                {
                    return 0;
                }
                // Only the vertices the mesh names are read: the count is the
                // program's, and nothing says it is near the array's real size.
                /** @type {TriVertex[]} */
                const used = [];
                /** @type {Map<number, number>} */
                const placed = new Map();
                const shapes = listed.map(entry=>entry.map(index=>{
                    const known = placed.get(index);
                    if (known !== undefined)
                    {
                        return known;
                    }
                    placed.set(index, used.length);
                    used.push(readVertex(dc, ((vertices >>> 0) + index * TRIVERTEX_SIZE) >>> 0));
                    return used.length - 1;
                }));
                if (corners === 3 && shapes.some(([a, b, c])=>
                    isFlatTriangle(used[a], used[b], used[c])))
                {
                    return 0;
                }
                const interfaces = bound(handle);
                return interfaces && interfaces.gradientFill(handle >>> 0, used, shapes, mode >>> 0)
                    ? 1 : 0;
            },
        },

        /**
         * int StretchDIBits(HDC hdc, int xDest, int yDest, int DestWidth, int DestHeight,
         *                   int xSrc, int ySrc, int SrcWidth, int SrcHeight,
         *                   const VOID *lpBits, const BITMAPINFO *lpbmi, UINT iUsage,
         *                   DWORD rop)
         *
         * The bits are read as the header describes them and the colour table
         * that follows it, a palette-relative one through the DC's palette.
         */
        StretchDIBits: {
            argBytes: 52,
            /** @param {number[]} args */
            handler: ([dest, xDest, yDest, destWidth, destHeight, xSrc, ySrc, srcWidth,
                srcHeight, bits, info, usage, rop])=>{
                const interfaces = bound(dest);
                if (!interfaces || (bits >>> 0) === 0 || (info >>> 0) === 0)
                {
                    return 0;
                }
                const image = readDib(info >>> 0, bits >>> 0, usage >>> 0, dcOf(dest),
                    undefined, true);
                if (!image)
                {
                    return 0;
                }
                return interfaces.stretchDIBits(dest >>> 0, {
                    xDest: xDest | 0, yDest: yDest | 0,
                    destWidth: destWidth | 0, destHeight: destHeight | 0,
                    xSrc: xSrc | 0, ySrc: ySrc | 0,
                    srcWidth: srcWidth | 0, srcHeight: srcHeight | 0,
                    image,
                    rop: rop >>> 0,
                });
            },
        },

        /**
         * int SetDIBitsToDevice(HDC hdc, int xDest, int yDest, DWORD w, DWORD h,
         *   int xSrc, int ySrc, UINT StartScan, UINT cLines, const VOID *lpvBits,
         *   const BITMAPINFO *lpbmi, UINT ColorUse)
         *
         * The bits hold cLines scan lines from StartScan on, and only those are
         * drawn: see the drawing layer's setDIBitsToDevice for how they and the
         * source rectangle are counted, and what the answer counts. The
         * destination point is mapped to the device and the rectangle keeps
         * its size in device pixels; under an RTL layout the point is its
         * right edge (Wine's test_SetDIBitsToDevice).
         */
        SetDIBitsToDevice: {
            argBytes: 48,
            /** @param {number[]} args */
            handler: ([dest, xDest, yDest, width, height, xSrc, ySrc, start, lines, bits, info,
                usage])=>{
                const interfaces = bound(dest);
                if (!interfaces || (bits >>> 0) === 0 || (info >>> 0) === 0)
                {
                    return 0;
                }
                const dc = dcOf(dest);
                const image = readDib(info >>> 0, bits >>> 0, usage >>> 0, dc, lines >>> 0);
                if (!image)
                {
                    return 0;
                }
                const origin = toDevice(dc, { x: xDest | 0, y: yDest | 0 });
                if ((dc.layout & 1) !== 0)
                {
                    origin.x -= (width | 0) - 1;
                }
                return interfaces.setDIBitsToDevice(dest >>> 0, {
                    xDest: origin.x, yDest: origin.y, width: width | 0, height: height | 0,
                    xSrc: xSrc | 0, ySrc: ySrc | 0,
                    firstScan: start >>> 0, scans: lines >>> 0,
                    image,
                });
            },
        },

        /**
         * int SetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT cLines,
         *   const VOID *lpBits, const BITMAPINFO *lpbmi, UINT ColorUse)
         *
         * The DC only lends its palette to a palette-relative table.
         */
        SetDIBits: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, bitmap, start, lines, bits, info, usage])=>{
                const record = objects.get(bitmap);
                const dc = dcOf(handle);
                if (!dc || !record || record.type !== 'bitmap' || (bits >>> 0) === 0
                    || (info >>> 0) === 0)
                {
                    return 0;
                }
                return setDIBits(bitmap >>> 0, start >>> 0, lines >>> 0, bits >>> 0, info >>> 0,
                    usage >>> 0, dc);
            },
        },

        /** int SetStretchBltMode(HDC hdc, int mode) -- the previous mode, or zero */
        SetStretchBltMode: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, mode])=>{
                const dc = dcOf(handle);
                if (!dc || (mode | 0) < BLACKONWHITE || (mode | 0) > HALFTONE)
                {
                    return 0;
                }
                // On the DC's own record, which the drawing layer reads and
                // SaveDC copies: it outlives a bitmap selected after it.
                const previous = dc.stretchMode ?? BLACKONWHITE;
                dc.stretchMode = mode | 0;
                return previous;
            },
        },

        /** int GetStretchBltMode(HDC hdc) */
        GetStretchBltMode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                return dc ? dc.stretchMode ?? BLACKONWHITE : 0;
            },
        },

        /** BOOL LineTo(HDC hdc, int x, int y) */
        LineTo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, x, y])=>{
                const interfaces = bound(handle);
                return interfaces ? (interfaces.lineTo(handle >>> 0, x | 0, y | 0), 1) : 0;
            },
        },

        /**
         * COLORREF SetPixel(HDC hdc, int x, int y, COLORREF color)
         *
         * Answers with the colour actually set, which is not always the one
         * asked for -- and with CLR_INVALID, not zero, when nothing was set,
         * because zero is black and a program cannot tell the two apart.
         */
        SetPixel: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, x, y, color])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0xffffffff;
                }
                interfaces.setPixel(handle >>> 0, x | 0, y | 0, color >>> 0);
                return interfaces.getPixel(handle >>> 0, x | 0, y | 0) >>> 0;
            },
        },

        /** BOOL SetPixelV(HDC hdc, int x, int y, COLORREF color): SetPixel, answered as a BOOL */
        SetPixelV: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, x, y, color])=>{
                const interfaces = bound(handle);
                return interfaces && interfaces.setPixel(handle >>> 0, x | 0, y | 0, color >>> 0)
                    !== 0xffffffff ? 1 : 0;
            },
        },

        /** COLORREF GetPixel(HDC hdc, int x, int y) */
        GetPixel: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, x, y])=>{
                const interfaces = bound(handle);
                return interfaces
                    ? interfaces.getPixel(handle >>> 0, x | 0, y | 0) >>> 0
                    : 0xffffffff;
            },
        },

        /**
         * BOOL TextOutA(HDC hdc, int x, int y, LPCSTR lpString, int c)
         *
         * The count is authoritative and the string need not be terminated:
         * a program draws a piece of a longer buffer by passing the buffer
         * and the length of the piece, and reading to a terminator would
         * read past the piece -- or off the end of what is mapped. The bytes
         * are the characters they are in the ANSI page, as every ANSI string
         * is read.
         */
        TextOutA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, x, y, string, count])=>
                extTextOut([handle, x, y, 0, 0, string, count, 0], false),
        },

        /**
         * BOOL TextOutW(HDC hdc, int x, int y, LPCWSTR lpString, int c)
         *
         * The count is characters, not bytes, and it is authoritative here for
         * the same reason it is in the narrow twin: the string need not be
         * terminated. Twice the bytes are read and the pair assembled into code
         * units, which is the whole of the difference -- the glyphs come out of
         * the same engine, so the two entry points cannot draw differently.
         */
        TextOutW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, x, y, string, count])=>
                extTextOut([handle, x, y, 0, 0, string, count, 0], true),
        },

        /**
         * BOOL Arc(HDC hdc, int left, int top, int right, int bottom,
         *          int xStart, int yStart, int xEnd, int yEnd)
         *
         * The outline of the ellipse the rectangle bounds, counterclockwise
         * from where the start radial meets it to where the end radial does,
         * drawn with the pen and leaving the current position where it was.
         * The same radial twice is the whole ellipse.
         */
        Arc: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, ...box])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const points = directedArc(dcOf(handle), box);
                const back = interfaces.moveToEx(handle >>> 0, points[0].x, points[0].y);
                for (const point of points.slice(1))
                {
                    interfaces.lineTo(handle >>> 0, point.x, point.y);
                }
                if (back)
                {
                    interfaces.moveToEx(handle >>> 0, back.x, back.y);
                }
                return 1;
            },
        },

        /**
         * BOOL Chord(HDC hdc, int x1, int y1, int x2, int y2,
         *            int x3, int y3, int x4, int y4)
         *
         * Arc's arc, in the DC's direction, closed by the line from its end
         * back to its start: the part of the ellipse the chord cuts off,
         * outlined with the pen and filled with the brush. The current
         * position is not used and does not move. The same radial twice is
         * the whole ellipse.
         */
        Chord: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: args=>closedArc(args, false),
        },

        /**
         * BOOL Pie(HDC hdc, int left, int top, int right, int bottom,
         *          int xr1, int yr1, int xr2, int yr2)
         *
         * The same arc closed through the ellipse's centre instead: a wedge,
         * outlined and filled as Chord's piece is.
         */
        Pie: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: args=>closedArc(args, true),
        },

        /**
         * BOOL Polyline(HDC hdc, const POINT *apt, int cpt)
         *
         * Lines through the points with the pen, two points at least, leaving
         * the current position where it was.
         */
        Polyline: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, points, count])=>{
                const interfaces = bound(handle);
                if (!interfaces || (count | 0) < 2 || (points >>> 0) === 0)
                {
                    return 0;
                }
                const through = pointsAt(points >>> 0, count | 0);
                const back = interfaces.moveToEx(handle >>> 0, through[0].x, through[0].y);
                for (const point of through.slice(1))
                {
                    interfaces.lineTo(handle >>> 0, point.x, point.y);
                }
                if (back)
                {
                    interfaces.moveToEx(handle >>> 0, back.x, back.y);
                }
                return 1;
            },
        },

        /**
         * BOOL PolylineTo(HDC hdc, const POINT *apt, DWORD cpt)
         *
         * The same from the current position, which ends at the last point.
         */
        PolylineTo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, points, count])=>{
                const interfaces = bound(handle);
                if (!interfaces || (points >>> 0) === 0)
                {
                    return 0;
                }
                lineThrough(interfaces, handle, pointsAt(points >>> 0, count >>> 0));
                return 1;
            },
        },

        /**
         * BOOL ArcTo(HDC hdc, int left, int top, int right, int bottom,
         *            int xr1, int yr1, int xr2, int yr2)
         *
         * Arc, joined on: a line from the current position to where the arc
         * starts, then the arc in the DC's direction, and the current
         * position left where the arc ends.
         */
        ArcTo: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, ...box])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                lineThrough(interfaces, handle, directedArc(dcOf(handle), box));
                return 1;
            },
        },

        /**
         * BOOL PolyBezierTo(HDC hdc, const POINT *apt, DWORD cpt)
         *
         * Cubic curves from the current position, three points each -- two
         * control points and the end, which the next curve starts from --
         * drawn with the pen as lines do, and the position left at the last
         * end. A count that is not a whole number of curves draws nothing.
         */
        PolyBezierTo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, points, count])=>{
                const dc = dcOf(handle);
                const interfaces = bound(handle);
                if (!interfaces || (points >>> 0) === 0 || (count >>> 0) === 0
                    || (count >>> 0) % 3 !== 0)
                {
                    return 0;
                }
                const through = pointsAt(points >>> 0, count >>> 0);
                let from = { ...dc.position };
                for (let at = 0; at < through.length; at += 3)
                {
                    curveTo(interfaces, handle, from, through[at], through[at + 1],
                        through[at + 2]);
                    from = through[at + 2];
                }
                return 1;
            },
        },

        /**
         * BOOL PolyDraw(HDC hdc, const POINT *apt, const BYTE *aj, int cpt)
         *
         * Moves, lines and curves from the current position, each point's
         * type saying which; a type with PT_CLOSEFIGURE also draws a line back
         * to where the figure began -- the last move, or the position the
         * call started from. The position ends where the drawing did. A type
         * array Windows would not draw is refused before anything is drawn.
         */
        PolyDraw: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, points, kinds, count])=>{
                const dc = dcOf(handle);
                const interfaces = bound(handle);
                const total = count | 0;
                if (!interfaces || total < 0 || (total > 0
                    && ((points >>> 0) === 0 || (kinds >>> 0) === 0)))
                {
                    return 0;
                }
                const types = total === 0 ? new Uint8Array(0) : host.readMemory(kinds >>> 0, total);
                if (!isPolyDrawable(types))
                {
                    return 0;
                }
                const through = pointsAt(points >>> 0, total);
                let current = { ...dc.position };
                let figure = current;
                for (let at = 0; at < total; at++)
                {
                    const point = through[at];
                    if (types[at] === PT_MOVETO)
                    {
                        interfaces.moveToEx(handle >>> 0, point.x, point.y);
                        current = figure = point;
                    }
                    else if (types[at] === PT_BEZIERTO)
                    {
                        curveTo(interfaces, handle, current, point, through[at + 1],
                            through[at + 2]);
                        at += 2;
                        current = through[at];
                    }
                    else
                    {
                        interfaces.lineTo(handle >>> 0, point.x, point.y);
                        current = point;
                    }
                    if ((types[at] & PT_CLOSEFIGURE) !== 0)
                    {
                        interfaces.lineTo(handle >>> 0, figure.x, figure.y);
                        current = figure;
                    }
                }
                return 1;
            },
        },

        /**
         * BOOL Polygon(HDC hdc, const POINT *apt, int cpt)
         *
         * The figure through the points, closed back to the first, filled
         * with the brush by the DC's fill mode and outlined with the pen; two
         * points at least. The current position is neither used nor moved.
         */
        Polygon: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, points, count])=>{
                const dc = dcOf(handle);
                const interfaces = bound(handle);
                if (!interfaces || (points >>> 0) === 0 || (count | 0) < 2)
                {
                    return 0;
                }
                return interfaces.polygon(handle >>> 0, pointsAt(points >>> 0, count | 0),
                    dc.polyFillMode) ? 1 : 0;
            },
        },

        /**
         * BOOL PolyPolygon(HDC hdc, const POINT *apt, const INT *asz, int csz)
         *
         * Polygons one after another in one array, each as long as its count,
         * filled together -- under ALTERNATE one inside another is a hole --
         * and each outlined. Every polygon needs two points.
         */
        PolyPolygon: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, points, counts, polygons])=>{
                const dc = dcOf(handle);
                const interfaces = bound(handle);
                const rings = interfaces ? polygonsAt(points, counts, polygons, 2) : null;
                if (!rings)
                {
                    return 0;
                }
                return interfaces.polyPolygon(handle >>> 0, rings, dc.polyFillMode) ? 1 : 0;
            },
        },

        /**
         * BOOL PolyPolyline(HDC hdc, const POINT *apt, const DWORD *asz, DWORD csz)
         *
         * Polyline once for each run of points: lines through each, two
         * points at least, and the current position left where it was.
         */
        PolyPolyline: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, points, counts, lines])=>{
                const interfaces = bound(handle);
                const runs = interfaces ? polygonsAt(points, counts, lines, 2) : null;
                if (!runs)
                {
                    return 0;
                }
                const back = { ...dcOf(handle).position };
                for (const run of runs)
                {
                    interfaces.moveToEx(handle >>> 0, run[0].x, run[0].y);
                    lineThrough(interfaces, handle, run.slice(1));
                }
                interfaces.moveToEx(handle >>> 0, back.x, back.y);
                return 1;
            },
        },

        /**
         * BOOL PolyBezier(HDC hdc, const POINT *apt, DWORD cpt)
         *
         * Cubic curves from the first point, three points each after it --
         * two control points and the end the next curve starts from -- drawn
         * with the pen. The current position is neither used nor moved. A
         * count that is not one more than a whole number of curves draws
         * nothing and fails.
         */
        PolyBezier: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, points, count])=>{
                const interfaces = bound(handle);
                const total = count >>> 0;
                if (!interfaces || (points >>> 0) === 0 || total === 0 || (total - 1) % 3 !== 0)
                {
                    return 0;
                }
                const through = pointsAt(points >>> 0, total);
                const back = interfaces.moveToEx(handle >>> 0, through[0].x, through[0].y);
                for (let at = 1; at + 2 < through.length; at += 3)
                {
                    curveTo(interfaces, handle, through[at - 1], through[at], through[at + 1],
                        through[at + 2]);
                }
                if (back)
                {
                    interfaces.moveToEx(handle >>> 0, back.x, back.y);
                }
                return 1;
            },
        },

        /**
         * BOOL AngleArc(HDC hdc, int x, int y, DWORD r, FLOAT StartAngle,
         *               FLOAT SweepAngle)
         *
         * A line from the current position to where the circle of radius r
         * round (x, y) is at the start angle, then the arc round it through
         * the sweep -- counterclockwise on the screen for a positive sweep,
         * whatever the DC's arc direction, and round more than once for a
         * sweep past a whole turn -- leaving the position at the arc's end.
         * The angles are degrees from the x axis; a radius that is negative
         * as an int fails.
         */
        AngleArc: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, x, y, radius, start, sweep])=>{
                const interfaces = bound(handle);
                const from = floatOf(start) * Math.PI / 180;
                const turn = floatOf(sweep) * Math.PI / 180;
                if (!interfaces || (radius | 0) < 0 || !Number.isFinite(from)
                    || !Number.isFinite(turn))
                {
                    return 0;
                }
                const r = radius | 0;
                // A segment for about every two pixels of the way, as the
                // other arcs are drawn, and no more than a turn's worth of
                // them for each turn a sweep asks for.
                const steps = Math.min(Math.max(1, Math.ceil(Math.abs(turn) * r / 2)),
                    Math.ceil(Math.abs(turn) / (2 * Math.PI) + 1) * 4096);
                lineThrough(interfaces, handle, Array.from({ length: steps + 1 }, (_, index)=>{
                    const angle = from + turn * index / steps;
                    return { x: Math.round((x | 0) + r * Math.cos(angle)),
                        y: Math.round((y | 0) - r * Math.sin(angle)) };
                }));
                return 1;
            },
        },

        /**
         * BOOL BeginPath(HDC hdc)
         *
         * Opens a path, throwing away any the DC had: from here the line and
         * curve calls add to it and draw nothing, until EndPath.
         */
        BeginPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                dc.path = createPath();
                return 1;
            },
        },

        /**
         * BOOL EndPath(HDC hdc)
         *
         * Closes the open path, which is then the DC's to fill, stroke, clip
         * to or read; with none open, ERROR_CAN_NOT_COMPLETE.
         */
        EndPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc?.path?.open)
                {
                    return pathRefused(handle);
                }
                dc.path.open = false;
                return 1;
            },
        },

        /** BOOL AbortPath(HDC hdc): the path thrown away, open or closed */
        AbortPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                dc.path = null;
                return 1;
            },
        },

        /**
         * BOOL CloseFigure(HDC hdc)
         *
         * Ends the figure being drawn with a line back to where it began,
         * marked on its last point; the next line starts a new figure. Only
         * in an open path.
         */
        CloseFigure: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc?.path?.open)
                {
                    return pathRefused(handle);
                }
                pathClose(dc.path);
                return 1;
            },
        },

        /**
         * BOOL FillPath(HDC hdc)
         *
         * Every figure of the closed path, closed, filled with the brush by
         * the DC's fill mode, and the path gone.
         */
        FillPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>drawPath(handle, { fill: true, stroke: false }),
        },

        /**
         * BOOL StrokePath(HDC hdc)
         *
         * Every figure of the closed path outlined with the pen -- a closed
         * one back to its start -- and the path gone.
         */
        StrokePath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>drawPath(handle, { fill: false, stroke: true }),
        },

        /** BOOL StrokeAndFillPath(HDC hdc): filled, then outlined over the fill */
        StrokeAndFillPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>drawPath(handle, { fill: true, stroke: true }),
        },

        /** BOOL FlattenPath(HDC hdc): every curve of the closed path made lines */
        FlattenPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc?.path || dc.path.open)
                {
                    return pathRefused(handle);
                }
                dc.path = flattened(dc.path);
                return 1;
            },
        },

        /**
         * BOOL WidenPath(HDC hdc)
         *
         * The closed path made the outline of what the selected pen would
         * cover stroking it: see `widened` -- with a pen one unit wide too,
         * whose outline still has more points than the path (Wine's
         * test_widenpath).
         */
        WidenPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc?.path || dc.path.open)
                {
                    return pathRefused(handle);
                }
                const pen = objects.get(dc.pen);
                dc.path = widened(dc.path, Math.max(1, pen?.attributes?.width | 0));
                return 1;
            },
        },

        /**
         * HRGN PathToRegion(HDC hdc)
         *
         * The inside of the closed path's figures, by the fill mode, on the
         * device; the path is gone either way. A path with nothing in it
         * makes no region, and says nothing about why (Wine's
         * test_path_state).
         */
        PathToRegion: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc?.path || dc.path.open)
                {
                    return pathRefused(handle);
                }
                const area = pathArea(dc);
                dc.path = null;
                return area ? regionHolding(area) : 0;
            },
        },

        /**
         * BOOL SelectClipPath(HDC hdc, int mode)
         *
         * The inside of the closed path combined into the clip as
         * ExtSelectClipRgn would combine a region of it, and the path gone.
         * No closed path is ERROR_CAN_NOT_COMPLETE; an empty one fails with
         * nothing set (Wine's test_path_state).
         */
        SelectClipPath: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, mode])=>{
                const dc = dcOf(handle);
                if (!dc?.path || dc.path.open)
                {
                    return pathRefused(handle);
                }
                if ((mode | 0) < RGN_AND || (mode | 0) > RGN_COPY)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const area = pathArea(dc);
                dc.path = null;
                if (!area)
                {
                    return 0;
                }
                const clip = (mode | 0) === RGN_COPY ? area
                    : combineAreas(clipAreaOf(dc), area, mode | 0);
                if (!clip)
                {
                    return 0;
                }
                setClipArea(handle, dc, clip);
                return 1;
            },
        },

        /**
         * int GetPath(HDC hdc, LPPOINT apt, LPBYTE aj, int cpt)
         *
         * The closed path's points, in logical units, and their types. A
         * count of zero asks how many there are; one too small for them is
         * ERROR_INVALID_PARAMETER, and no closed path ERROR_CAN_NOT_COMPLETE,
         * both -1.
         */
        GetPath: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, points, kinds, count])=>{
                const dc = dcOf(handle);
                if (!dc?.path || dc.path.open)
                {
                    pathRefused(handle);
                    return 0xffffffff;
                }
                /** @type {import('./paths.js').Path} */
                const path = dc.path;
                if ((count | 0) === 0)
                {
                    return path.points.length;
                }
                if ((count | 0) < path.points.length || (points >>> 0) === 0
                    || (kinds >>> 0) === 0)
                {
                    refuse(ERROR_INVALID_PARAMETER);
                    return 0xffffffff;
                }
                writeU32s(host, points >>> 0, path.points.flatMap(point=>{
                    const logical = toLogical(dc, point);
                    return [logical.x, logical.y];
                }));
                host.writeMemory(kinds >>> 0, Uint8Array.from(path.types));
                return path.points.length;
            },
        },

        /**
         * BOOL LineDDA(int xStart, int yStart, int xEnd, int yEnd,
         *              LINEDDAPROC lpProc, LPARAM data)
         *
         * The program's `void CALLBACK proc(int x, int y, LPARAM data)` called
         * once for each point of the line, in order from the start, the end
         * point left out: see `lineDdaPoints`. Nothing is drawn and no DC is
         * involved. A line of no length calls nothing and succeeds; a line
         * with points to report and no callback to report them to -- a null
         * one, or a build that cannot call the program -- fails.
         */
        LineDDA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([xStart, yStart, xEnd, yEnd, proc, data])=>{
                if ((xStart | 0) === (xEnd | 0) && (yStart | 0) === (yEnd | 0))
                {
                    return 1;
                }
                const call = host.call;
                if (!call || (proc >>> 0) === 0)
                {
                    return 0;
                }
                // Read before the first await: after it the processor is
                // whoever's the scheduler chose.
                const thread = host.callerThread?.();
                const points = lineDdaPoints(xStart | 0, yStart | 0, xEnd | 0, yEnd | 0);
                return (async()=>{
                    for (const point of points)
                    {
                        await call(proc >>> 0, [point.x >>> 0, point.y >>> 0, data >>> 0], thread);
                    }
                    return 1;
                })();
            },
        },

        /**
         * int SetArcDirection(HDC hdc, int dir) / int GetArcDirection(HDC hdc)
         *
         * Which way Arc runs, counterclockwise until a program says otherwise;
         * anything but the two directions is ERROR_INVALID_PARAMETER.
         */
        SetArcDirection: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, direction])=>{
                const dc = dcOf(handle);
                if (!dc || ((direction | 0) !== AD_COUNTERCLOCKWISE
                    && (direction | 0) !== AD_CLOCKWISE))
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const previous = dc.arcDirection ?? AD_COUNTERCLOCKWISE;
                dc.arcDirection = direction | 0;
                return previous;
            },
        },
        GetArcDirection: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                return dc ? dc.arcDirection ?? AD_COUNTERCLOCKWISE : 0;
            },
        },

        /**
         * BOOL RoundRect(HDC hdc, int left, int top, int right, int bottom,
         *                int width, int height)
         *
         * A rectangle whose corners are quarters of the ellipse width by
         * height, outlined with the pen and filled with the brush; the
         * ellipse's size is taken without its sign and no larger than the
         * rectangle, and a flat one is the plain rectangle.
         */
        RoundRect: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, left, top, right, bottom, width, height])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const box = {
                    left: Math.min(left | 0, right | 0), top: Math.min(top | 0, bottom | 0),
                    right: Math.max(left | 0, right | 0), bottom: Math.max(top | 0, bottom | 0),
                };
                const cornerX = Math.min(Math.abs(width | 0), box.right - box.left) / 2;
                const cornerY = Math.min(Math.abs(height | 0), box.bottom - box.top) / 2;
                if (cornerX < 1 || cornerY < 1)
                {
                    return interfaces.rectangle(handle >>> 0, box.left, box.top, box.right,
                        box.bottom) ? 1 : 0;
                }
                return interfaces.polygon(handle >>> 0, roundRectPoints(box, cornerX, cornerY))
                    ? 1 : 0;
            },
        },

        /** BOOL Ellipse(HDC hdc, int left, int top, int right, int bottom) */
        Ellipse: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, left, top, right, bottom])=>{
                const interfaces = bound(handle);
                return interfaces && interfaces.ellipse(handle >>> 0,
                    left | 0, top | 0, right | 0, bottom | 0) ? 1 : 0;
            },
        },

        /** BOOL Rectangle(HDC hdc, int left, int top, int right, int bottom) */
        Rectangle: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, left, top, right, bottom])=>{
                const interfaces = bound(handle);
                return interfaces && interfaces.rectangle(handle >>> 0,
                    left | 0, top | 0, right | 0, bottom | 0) ? 1 : 0;
            },
        },

        /**
         * BOOL ExtFloodFill(HDC hdc, int x, int y, COLORREF color, UINT type)
         *
         * The area around the point painted with the selected brush:
         * FLOODFILLBORDER spreads up to pixels of the colour, FLOODFILLSURFACE
         * over pixels of it. FALSE, with nothing painted, when the point is
         * outside the clip, when it is the border's colour or not the
         * surface's, or for a type that is neither.
         */
        ExtFloodFill: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, x, y, color, type])=>{
                const interfaces = bound(handle);
                if (!interfaces || (type >>> 0) > FLOODFILLSURFACE)
                {
                    return 0;
                }
                return interfaces.floodFill(handle >>> 0, x | 0, y | 0, color >>> 0, type >>> 0)
                    ? 1 : 0;
            },
        },

        /** BOOL FloodFill(HDC hdc, int x, int y, COLORREF color): ExtFloodFill up to a border */
        FloodFill: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, x, y, color])=>
                functions.ExtFloodFill.handler([handle, x, y, color, FLOODFILLBORDER]),
        },

        /**
         * BOOL ExtTextOutA(HDC hdc, int x, int y, UINT options,
         *   const RECT *lprect, LPCSTR lpString, UINT c, const INT *lpDx)
         *
         * The character count is authoritative and the string is not
         * NUL-terminated: a program drawing a substring passes the whole buffer
         * and a shorter count, and reading to a terminator would draw the rest
         * of it.
         *
         * lpDx is one advance per character, which is how justified text is
         * positioned. Ignoring it draws the same glyphs in the wrong places,
         * which looks like a font problem and is not one.
         */
        ExtTextOutA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: args=>extTextOut(args, false),
        },

        /**
         * BOOL ExtTextOutW(HDC hdc, int x, int y, UINT options,
         *   const RECT *lprect, LPCWSTR lpString, UINT c, const INT *lpDx)
         *
         * The same call over UTF-16 code units, drawn by the same engine.
         */
        ExtTextOutW: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: args=>extTextOut(args, true),
        },

        /**
         * UINT SetTextAlign(HDC hdc, UINT align)
         *
         * Kept on the device context rather than only on the drawing service,
         * because a build with nothing to draw on still has to remember what it
         * was told and hand the previous value back: a program that sets an
         * alignment, draws, and restores would otherwise restore a zero it never
         * set.
         */
        SetTextAlign: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, align])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return GDI_ERROR;
                }
                const previous = dc.textAlign;
                dc.textAlign = align >>> 0;
                bound(handle)?.setTextAlign(handle >>> 0, align >>> 0);
                return previous;
            },
        },

        /** UINT GetTextAlign(HDC hdc) */
        GetTextAlign: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>dcOf(handle)?.textAlign ?? GDI_ERROR,
        },

        /**
         * int SetTextCharacterExtra(HDC hdc, int extra)
         *
         * The spacing added between characters, kept on the context and
         * answered back; the text drawn here is not spread by it. The old
         * value, or 0x80000000 for a context there is not.
         */
        SetTextCharacterExtra: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, extra])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0x80000000;
                }
                const previous = dc.characterExtra;
                dc.characterExtra = extra | 0;
                return previous >>> 0;
            },
        },

        /** int GetTextCharacterExtra(HDC hdc) */
        GetTextCharacterExtra: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                return dc ? (dc.characterExtra ?? 0) >>> 0 : 0x80000000;
            },
        },

        /**
         * BOOL SetMiterLimit(HDC hdc, FLOAT limit, PFLOAT old)
         *
         * A limit below one is refused with the old one left unwritten: a
         * miter is never shorter than the line is wide. Nothing drawn here
         * joins lines by it yet; the value is kept, saved and answered.
         */
        SetMiterLimit: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, limit, old])=>{
                const dc = dcOf(handle);
                const value = floatOf(limit);
                if (!dc || !(value >= 1))
                {
                    return 0;
                }
                if ((old >>> 0) !== 0)
                {
                    writeU32s(host, old >>> 0, [bitsOf(dc.miterLimit)]);
                }
                dc.miterLimit = value;
                return 1;
            },
        },

        /** BOOL GetMiterLimit(HDC hdc, PFLOAT limit) */
        GetMiterLimit: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writeU32s(host, out >>> 0, [bitsOf(dc.miterLimit)]);
                }
                return 1;
            },
        },

        /**
         * COLORREF GetNearestColor(HDC hdc, COLORREF color)
         *
         * What the context's surface keeps of a colour -- the palette entry
         * nearest it, the bits sixteen keep -- which is what a SetPixel of it
         * reads back as. A build that cannot draw keeps every colour whole.
         */
        GetNearestColor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, color])=>{
                if (!dcOf(handle))
                {
                    return 0xffffffff;
                }
                const interfaces = bound(handle, false);
                return interfaces
                    ? interfaces.nearestColor(handle >>> 0, color >>> 0) >>> 0
                    : (color & 0xffffff) >>> 0;
            },
        },

        /**
         * int GetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT cLines,
         *   LPVOID lpvBits, LPBITMAPINFO lpbmi, UINT usage)
         *
         * A null lpvBits, or no lines, asks for the header to be filled in and
         * nothing else, which is how a program discovers a bitmap's shape
         * before allocating for it; that answers 1, and answers even when
         * there is nothing to draw with, because the shape is bookkeeping and
         * the pixels are not. A biBitCount of zero asks for the bitmap's own
         * format; any other is the format the caller wants, which is kept and
         * has its image size, and for BI_BITFIELDS its masks, filled in.
         *
         * The pixels are the bitmap's, wherever it is selected: the DC only
         * says which device the format is converted for. Windows documents
         * the bitmap as not selected into any DC for this call, and a program
         * that follows the rule has just taken it out of the one it drew in.
         */
        GetDIBits: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, bitmap, start, lines, bits, info, usage])=>{
                const record = objects.get(bitmap);
                const dc = dcOf(handle);
                if (!record || record.type !== 'bitmap' || !dc || (info >>> 0) === 0
                    || (usage >>> 0) > DIB_PAL_COLORS)
                {
                    return 0;
                }
                const shape = record.attributes;
                const header = readBitmapInfoHeader(host, info);
                if (!isDibHeaderSize(header.size))
                {
                    return 0;
                }
                // A BITMAPCOREHEADER has WORD fields and none past bcBitCount,
                // and its table is RGBTRIPLEs: forty bytes written over its
                // twelve would land on the program's colour table.
                const core = header.size === BITMAPCOREHEADER.SIZE;
                const describing = (bits >>> 0) === 0 || (lines >>> 0) === 0;
                if (header.bitCount === 0)
                {
                    if (!describing)
                    {
                        return 0;
                    }
                    const depth = shape.bitCount;
                    if (core)
                    {
                        [shape.width, shape.height, 1, depth].forEach((value, index)=>
                            writeU16(host, info + BITMAPCOREHEADER.bcWidth + index * 2, value));
                        return 1;
                    }
                    writeU32s(host, info + BITMAPINFOHEADER.biWidth, [shape.width, shape.height]);
                    writeU16(host, info + BITMAPINFOHEADER.biPlanes, 1);
                    writeU16(host, info + BITMAPINFOHEADER.biBitCount, depth);
                    writeU32s(host, info + BITMAPINFOHEADER.biCompression, [
                        depth === 16 || depth === 32 ? BI_BITFIELDS : BI_RGB,
                        dibStride(shape.width, depth) * shape.height, 0, 0, 0, 0,
                    ]);
                    return 1;
                }
                const masked = header.compression === BI_BITFIELDS
                    && (header.bitCount === 16 || header.bitCount === 32);
                // An RLE DIB can be described, but nothing is written back
                // run-length encoded (Wine's test_dib_formats).
                const rle = isRle(header);
                if (!DIB_BIT_COUNTS.has(header.bitCount)
                    || (header.compression !== BI_RGB && !masked && !(rle && describing))
                    || header.width <= 0 || header.height === 0
                    || (header.planes === 0 && (lines >>> 0) !== 0))
                {
                    return 0;
                }
                if (!core && !rle)
                {
                    writeU32s(host, info + BITMAPINFOHEADER.biSizeImage,
                        [dibStride(header.width, header.bitCount) * Math.abs(header.height)]);
                    writeU32s(host, info + BITMAPINFOHEADER.biClrUsed, [0]);
                }
                const masks = masked ? masksFor(shape, header.bitCount) : [];
                if (masked)
                {
                    writeU32s(host, info + BITMAPINFOHEADER.SIZE, masks);
                }
                const colors = header.bitCount <= 8 ? colorTableFor(shape, header.bitCount) : [];
                if ((usage >>> 0) === DIB_PAL_COLORS)
                {
                    // Indices into the DC's palette instead of colours, and
                    // the identity is the table that matches.
                    colors.forEach((_, index)=>
                        writeU16(host, info + header.size + index * 2, index));
                }
                else if (core)
                {
                    host.writeMemory(info + header.size, Uint8Array.from(colors.flatMap(color=>
                        [color & 0xff, (color >>> 8) & 0xff, (color >>> 16) & 0xff])));
                }
                else if (colors.length > 0)
                {
                    writeU32s(host, info + header.size, [...colors]);
                }
                if (describing)
                {
                    return 1;
                }
                // The DIB's picture lies against the bitmap's top-left, and the
                // lines are counted from the DIB's bottom whichever way it is
                // stored, written in its own order: a line of the DIB outside
                // the bitmap is zeros, and only the lines inside it are
                // counted (Wine's test_GetDIBits_scanlines).
                const height = Math.abs(header.height);
                if ((start >>> 0) >= height)
                {
                    return 1;
                }
                const wanted = Math.min(lines >>> 0, height - (start >>> 0));
                const buffer = new Uint8Array(dibStride(header.width, header.bitCount) * wanted);
                /** @param {number} source @returns {number | null} */
                const read = source=>{
                    const interfaces = bound(source, false);
                    return interfaces
                        ? interfaces.getDIBits(source >>> 0, {
                            header,
                            bits: buffer,
                            masks,
                            colors,
                            startScan: header.height < 0
                                ? height - (start >>> 0) - wanted
                                : start >>> 0,
                            scanLines: wanted,
                        })
                        : null;
                };
                const written = dc.bitmap === (bitmap >>> 0) ? read(handle) : lend(bitmap, read);
                if (written === null)
                {
                    return 0;
                }
                host.writeMemory(bits >>> 0, buffer);
                return written;
            },
        },

        /**
         * int FillRgn(HDC hdc, HRGN hrgn, HBRUSH hbr)
         *
         * Each piece of the region painted with the brush. A region named to
         * be painted is in the DC's logical units, as a rectangle named to
         * FillRect is, and is mapped as one.
         */
        FillRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, region, brush])=>{
                const area = areaOfRegion(region);
                const interfaces = bound(handle);
                if (!area || !interfaces || objects.get(brush)?.type !== 'brush')
                {
                    return 0;
                }
                for (const piece of area)
                {
                    interfaces.fillRect(handle >>> 0, piece, brush >>> 0);
                }
                return 1;
            },
        },

        /**
         * BOOL PaintRgn(HDC hdc, HRGN hrgn)
         *
         * FillRgn with the brush the DC has selected.
         */
        PaintRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, region])=>{
                const dc = dcOf(handle);
                return dc ? functions.FillRgn.handler([handle, region, dc.brush]) : 0;
            },
        },

        /**
         * BOOL InvertRgn(HDC hdc, HRGN hrgn)
         *
         * Every pixel of the region inverted, as InvertRect inverts a
         * rectangle; the pieces never overlap, so none is inverted twice.
         */
        InvertRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, region])=>{
                const area = areaOfRegion(region);
                const interfaces = bound(handle);
                if (!area || !interfaces)
                {
                    return 0;
                }
                for (const piece of area)
                {
                    interfaces.invertRect(handle >>> 0, piece);
                }
                return 1;
            },
        },

        /**
         * BOOL FrameRgn(HDC hdc, HRGN hrgn, HBRUSH hbr, int w, int h)
         *
         * A border inside the region's edge painted with the brush: every
         * pixel of the region that is less than w across or h down from a
         * pixel outside it -- FrameRect's frame at one by one, and round a
         * region of several pieces, round each of its edges. A region
         * narrower than two sides is all border. The border is laid down as
         * pieces that do not overlap, so no pixel is painted twice under a
         * raster operation that would notice. MSDN gives no sign to the two
         * sizes, and they are taken without it.
         */
        FrameRgn: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, region, brush, width, height])=>{
                const area = areaOfRegion(region);
                const interfaces = bound(handle);
                if (!area || objects.get(brush)?.type !== 'brush' || !interfaces)
                {
                    return 0;
                }
                const across = Math.abs(width | 0);
                const down = Math.abs(height | 0);
                // What is left of the region moved each way by the border's
                // size is the part at least that far from its outside.
                const inner = [[across, 0], [-across, 0], [0, down], [0, -down]]
                    .reduce((kept, [dx, dy])=>combineAreas(kept, offsetArea(area, dx, dy),
                        RGN_AND) ?? [], area);
                for (const piece of combineAreas(area, inner, RGN_DIFF) ?? [])
                {
                    interfaces.fillRect(handle >>> 0, piece, brush >>> 0);
                }
                return 1;
            },
        },

        /** HRGN CreateRectRgn(int x1, int y1, int x2, int y2): any two opposite corners */
        CreateRectRgn: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([left, top, right, bottom])=>
                newRegion({ left, top, right, bottom }),
        },

        /** HRGN CreateRectRgnIndirect(const RECT *lprect) */
        CreateRectRgnIndirect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([rect])=>
                (rect >>> 0) === 0 ? 0 : newRegion(readRect(host, rect)),
        },

        /**
         * HRGN CreateEllipticRgn(int x1, int y1, int x2, int y2)
         *
         * The pixels inside the ellipse the rectangle bounds, the rectangle
         * given by any two opposite corners: those whose centres the ellipse
         * holds, so the region's box is the rectangle, its right and bottom
         * edges left out.
         */
        CreateEllipticRgn: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([left, top, right, bottom])=>{
                const box = orderedRect(left, top, right, bottom);
                return regionHolding(roundedArea(box, box.right - box.left,
                    box.bottom - box.top));
            },
        },

        /** HRGN CreateEllipticRgnIndirect(const RECT *lprect) */
        CreateEllipticRgnIndirect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([rect])=>{
                if ((rect >>> 0) === 0)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const { left, top, right, bottom } = readRect(host, rect >>> 0);
                return functions.CreateEllipticRgn.handler([left, top, right, bottom]);
            },
        },

        /**
         * HRGN CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)
         *
         * The rectangle with its corners rounded by quarters of an ellipse w
         * by h, the ellipse no larger than the rectangle and its size taken
         * without a sign; one too small to round a pixel is the rectangle.
         */
        CreateRoundRectRgn: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([left, top, right, bottom, width, height])=>regionHolding(
                roundedArea(orderedRect(left, top, right, bottom), width | 0, height | 0)),
        },

        /**
         * HRGN CreatePolygonRgn(const POINT *pptl, int cPoint, int iMode)
         *
         * The inside of the polygon by the fill mode, ALTERNATE or WINDING;
         * fewer than two points, or another mode, is no region. A polygon
         * with no inside -- a point, a line -- is an empty region, not a
         * failure (Wine's test_CreatePolyPolygonRgn).
         */
        CreatePolygonRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([points, count, mode])=>{
                if ((points >>> 0) === 0 || (count | 0) < 2 || !isFillMode(mode))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                return regionHolding(polygonArea([pointsAt(points >>> 0, count | 0)], mode | 0));
            },
        },

        /**
         * HRGN CreatePolyPolygonRgn(const POINT *pptl, const INT *pc, int cPoly,
         *                           int iMode)
         *
         * Polygons one after another in one array, each count in pc, filled
         * together: under ALTERNATE one inside another is a hole. Any polygon
         * of fewer than two points makes no region.
         */
        CreatePolyPolygonRgn: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([points, counts, polygons, mode])=>{
                const rings = polygonsAt(points, counts, polygons, 2);
                if (!rings || !isFillMode(mode))
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                return regionHolding(polygonArea(rings, mode | 0));
            },
        },

        /**
         * HRGN ExtCreateRegion(const XFORM *lpx, DWORD nCount, const RGNDATA *lpData)
         *
         * The rectangles of an RGNDATA, as a region, after the transform when
         * there is one. XP reads the header's size and not its type: a size
         * other than an RGNDATAHEADER's fails with nothing set, and so does
         * a buffer shorter than the header or the rectangles it counts;
         * no data at all is ERROR_INVALID_PARAMETER (Wine's
         * test_ExtCreateRegion). A transform that only scales and moves takes
         * each rectangle to a rectangle, its corners rounded to the nearest
         * pixel; one that turns or shears takes it to the polygon its corners
         * go to.
         */
        ExtCreateRegion: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([xform, size, data])=>{
                if ((data >>> 0) === 0)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const header = readU32s(data >>> 0, 3);
                const count = header[2];
                if (header[0] !== RGNDATAHEADER_SIZE || (size >>> 0) < RGNDATAHEADER_SIZE
                    || count > ((size >>> 0) - RGNDATAHEADER_SIZE) / RECT_SIZE)
                {
                    return 0;
                }
                const values = readI32s((data >>> 0) + RGNDATAHEADER_SIZE, count * 4);
                const rects = Array.from({ length: count }, (_, index)=>{
                    const [left, top, right, bottom] = values.slice(index * 4, index * 4 + 4);
                    return orderedRect(left, top, right, bottom);
                }).filter(rect=>!isEmpty(rect));
                if ((xform >>> 0) === 0)
                {
                    return regionHolding(rects);
                }
                const bytes = host.readMemory(xform >>> 0, 24);
                const view = new DataView(bytes.buffer, bytes.byteOffset, 24);
                const [m11, m12, m21, m22, dx, dy] = Array.from({ length: 6 }, (_, index)=>
                    view.getFloat32(index * 4, true));
                /** @param {number} x @param {number} y */
                const map = (x, y)=>({ x: Math.round(m11 * x + m21 * y + dx),
                    y: Math.round(m12 * x + m22 * y + dy) });
                if (m12 === 0 && m21 === 0)
                {
                    return regionHolding(rects.map(rect=>{
                        const a = map(rect.left, rect.top);
                        const b = map(rect.right, rect.bottom);
                        return orderedRect(a.x, a.y, b.x, b.y);
                    }));
                }
                return regionHolding(rects.flatMap(rect=>polygonArea([[
                    map(rect.left, rect.top), map(rect.right, rect.top),
                    map(rect.right, rect.bottom), map(rect.left, rect.bottom)]])));
            },
        },

        /**
         * BOOL SetRectRgn(HRGN hrgn, int left, int top, int right, int bottom)
         *
         * The region becomes the rectangle, whatever it held.
         */
        SetRectRgn: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([region, left, top, right, bottom])=>{
                const target = objects.get(region);
                if (!target || target.type !== 'region')
                {
                    return 0;
                }
                holdArea(target, [orderedRect(left, top, right, bottom)]);
                return 1;
            },
        },

        /**
         * BOOL EqualRgn(HRGN hrgn1, HRGN hrgn2)
         *
         * Whether the two hold the same pixels: two empty regions are the
         * same wherever they sit. A handle that is not a region answers
         * ERROR, which is zero.
         */
        EqualRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const a = areaOfRegion(first);
                const b = areaOfRegion(second);
                if (!a || !b)
                {
                    return REGION_ERROR;
                }
                return areasEqual(a, b) ? 1 : 0;
            },
        },

        /**
         * BOOL PtInRegion(HRGN hrgn, int x, int y)
         *
         * Whether the pixel is in the region: a piece's left and top edges
         * are in it, its right and bottom ones are not.
         */
        PtInRegion: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([region, x, y])=>{
                const area = areaOfRegion(region);
                return area && areaContains(area, x | 0, y | 0) ? 1 : 0;
            },
        },

        /**
         * int GetRandomRgn(HDC hdc, HRGN hrgn, INT iNum)
         *
         * SYSRGN: the part of the screen the context draws on, in screen
         * coordinates -- its window's area as far as its clip lets it.
         * CLIPRGN: the clip the program selected, as GetClipRgn answers it.
         * METARGN: the meta region SetMetaRgn made; APIRGN: that and the clip
         * together. 0 when there is no such region, -1 for a context or a
         * region there is not.
         */
        GetRandomRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, region, which])=>{
                const CLIPRGN = 1;
                const METARGN = 2;
                const APIRGN = 3;
                const SYSRGN = 4;
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0xffffffff;
                }
                if ((which | 0) === CLIPRGN)
                {
                    return functions.GetClipRgn.handler([handle, region]);
                }
                const target = objects.get(region);
                if (!target || target.type !== 'region')
                {
                    return 0xffffffff;
                }
                if ((which | 0) === METARGN || (which | 0) === APIRGN)
                {
                    const area = (which | 0) === METARGN ? dc.meta ?? null : apiAreaOf(dc);
                    if (!area)
                    {
                        return 0;
                    }
                    holdArea(target, area);
                    return 1;
                }
                if ((which | 0) !== SYSRGN)
                {
                    return 0;
                }
                const origin = dc.bounds ?? null;
                const pieces = offsetArea(dc.visible ?? [clipOf(dc)], origin?.left ?? 0,
                    origin?.top ?? 0);
                holdArea(target, origin ? intersectArea(pieces, origin) : pieces);
                return 1;
            },
        },

        /** int GetRgnBox(HRGN hrgn, LPRECT lprc): the bounds, and what kind of region */
        GetRgnBox: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([region, out])=>{
                const area = areaOfRegion(region);
                if (!area || (out >>> 0) === 0)
                {
                    return REGION_ERROR;
                }
                // An empty region has no position: Windows keeps it as zeros.
                const box = areaBox(area);
                writeU32s(host, out >>> 0, [box.left, box.top, box.right, box.bottom]);
                return areaKind(area);
            },
        },

        /**
         * int CombineRgn(HRGN hrgnDst, HRGN hrgnSrc1, HRGN hrgnSrc2, int iMode)
         *
         * Exact in every mode. RGN_COPY reads only the first source; every
         * other mode needs both, and a second that is no region is ERROR.
         */
        CombineRgn: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, first, second, mode])=>{
                const target = objects.get(destination);
                const left = areaOfRegion(first);
                const right = (mode | 0) === RGN_COPY ? [] : areaOfRegion(second);
                if (!target || target.type !== 'region' || !left || !right)
                {
                    return REGION_ERROR;
                }
                const result = combineAreas(left, right, mode);
                return result ? holdArea(target, result) : REGION_ERROR;
            },
        },

        /**
         * int SelectClipRgn(HDC hdc, HRGN hrgn)
         *
         * A null region means no clipping, which is the whole surface -- not an
         * empty one, which would clip everything away. A region is in device
         * units, and the clip is a copy of it, every piece.
         */
        SelectClipRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, region])=>{
                const dc = dcOf(handle);
                if (!dc || !bound(handle))
                {
                    return REGION_ERROR;
                }
                if ((region >>> 0) === 0)
                {
                    dc.clip = null;
                    dc.clipRects = null;
                    dc.clipSelected = false;
                    pushClip(handle, dc, bound(handle));
                    return SIMPLEREGION;
                }
                const area = areaOfRegion(region);
                if (!area)
                {
                    return REGION_ERROR;
                }
                return setClipArea(handle, dc, area);
            },
        },

        /**
         * int GetClipRgn(HDC hdc, HRGN hrgn)
         *
         * 1 with the clip the program selected copied into the region, 0 when
         * it selected none -- a paint's update area is the system's clip, not
         * the program's -- and -1 for a context or a region there is not.
         */
        GetClipRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, region])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0xffffffff;
                }
                // No clip is 0 before the region is looked at: a null region
                // asks only whether there is one (clipping.c test_GetClipRgn).
                if (!dc.clipSelected)
                {
                    return 0;
                }
                const target = objects.get(region);
                if (!target || target.type !== 'region')
                {
                    return 0xffffffff;
                }
                holdArea(target, clipAreaOf(dc));
                return 1;
            },
        },

        /**
         * int IntersectClipRect(HDC hdc, int left, int top, int right, int bottom)
         *
         * The clip narrowed to the rectangle, piece by piece.
         */
        IntersectClipRect: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, left, top, right, bottom])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return REGION_ERROR;
                }
                return setClipArea(handle, dc, intersectArea(clipAreaOf(dc),
                    deviceArea(dc, left, top, right, bottom)));
            },
        },

        /**
         * int ExcludeClipRect(HDC hdc, int left, int top, int right, int bottom)
         *
         * The clip less the rectangle. A hole in the middle leaves a frame,
         * which is a region of four pieces: a program that paints a picture,
         * excludes it and then fills its whole client area relies on the fill
         * going round the picture, not over it.
         */
        ExcludeClipRect: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, left, top, right, bottom])=>{
                const dc = dcOf(handle);
                if (!dc || !bound(handle))
                {
                    return REGION_ERROR;
                }
                const area = clipAreaOf(dc);
                const hole = deviceArea(dc, left, top, right, bottom);
                if (isEmpty(hole) || area.every(piece=>isEmpty(intersect(piece, hole))))
                {
                    return areaKind(area);
                }
                return setClipArea(handle, dc, subtractFromArea(area, hole));
            },
        },

        /**
         * int ExtSelectClipRgn(HDC hdc, HRGN hrgn, int mode)
         *
         * The clip combined with the region: RGN_COPY is SelectClipRgn, a
         * null region included; the others take the clip as it stands --
         * the whole surface when none was selected -- and AND, OR, XOR or
         * DIFF the region into it, exactly. A null region with any mode but
         * RGN_COPY is an error.
         */
        ExtSelectClipRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, region, mode])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return REGION_ERROR;
                }
                if ((mode | 0) === RGN_COPY)
                {
                    return functions.SelectClipRgn.handler([handle, region]);
                }
                const given = areaOfRegion(region);
                const area = given && (mode | 0) >= RGN_AND && (mode | 0) <= RGN_DIFF
                    ? combineAreas(clipAreaOf(dc), given, mode | 0)
                    : null;
                return area ? setClipArea(handle, dc, area) : REGION_ERROR;
            },
        },

        /**
         * int OffsetClipRgn(HDC hdc, int x, int y)
         *
         * The clip the program selected, moved; the kind of region it then
         * is. With none selected there is nothing to move, and the answer is
         * the kind the clip the DC draws under is. Like the other clipping
         * calls here the offset is taken in device units.
         */
        OffsetClipRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, x, y])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return REGION_ERROR;
                }
                if (!dc.clipSelected)
                {
                    return areaKind(clipAreaOf(dc));
                }
                return setClipArea(handle, dc, offsetArea(clipAreaOf(dc), x | 0, y | 0));
            },
        },

        /**
         * int OffsetRgn(HRGN hrgn, int x, int y)
         *
         * The region moved, and the kind it is; an empty one stays empty.
         */
        OffsetRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([region, x, y])=>{
                const area = areaOfRegion(region);
                if (!area)
                {
                    return REGION_ERROR;
                }
                return holdArea(objects.get(region), offsetArea(area, x | 0, y | 0));
            },
        },

        /**
         * BOOL SetBrushOrgEx(HDC hdc, int x, int y, LPPOINT lppt)
         *
         * Where the next brush's pattern is aligned, with the origin it
         * replaced written out. It is the DC's, kept whether or not anything
         * draws, and handed to the drawing context when there is one.
         */
        SetBrushOrgEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, x, y, out])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                const previous = dc.brushOrg ?? { x: 0, y: 0 };
                if ((out >>> 0) !== 0)
                {
                    writeU32s(host, out >>> 0, [previous.x, previous.y]);
                }
                dc.brushOrg = { x: x | 0, y: y | 0 };
                if (dc.boundSurface)
                {
                    draw()?.setBrushOrgEx?.(handle >>> 0, x | 0, y | 0);
                }
                return 1;
            },
        },

        /**
         * BOOL GetBrushOrgEx(HDC hdc, LPPOINT lppt)
         *
         * The origin SetBrushOrgEx last set, as it was given. With nowhere to
         * write it there is no answer to give, and the call fails.
         */
        GetBrushOrgEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0)
                {
                    return 0;
                }
                const origin = dc.brushOrg ?? { x: 0, y: 0 };
                writeU32s(host, out >>> 0, [origin.x, origin.y]);
                return 1;
            },
        },

        /**
         * BOOL GetDCOrgEx(HDC hdc, LPPOINT lppt)
         *
         * Where the DC's pixels start on the screen: the corner of the part
         * of its window it was made for -- the client area, or the whole
         * window for a window DC -- and the screen's own corner for a DC on
         * the screen or on a bitmap. The mapping mode does not enter into it.
         */
        GetDCOrgEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0)
                {
                    return 0;
                }
                const origin = dc.bounds ?? { left: 0, top: 0 };
                writeU32s(host, out >>> 0, [origin.left, origin.top]);
                return 1;
            },
        },

        /**
         * BOOL RectVisible(HDC hdc, const RECT *lprc)
         *
         * Whether any of the rectangle is inside the clip: what a program
         * asks before painting a part it may be able to skip.
         */
        RectVisible: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, rect])=>{
                const dc = dcOf(handle);
                if (!dc || (rect >>> 0) === 0)
                {
                    return 0;
                }
                const asked = readRect(host, rect >>> 0);
                const area = deviceArea(dc, asked.left, asked.top, asked.right, asked.bottom);
                return drawnAreaOf(dc).every(piece=>isEmpty(intersect(piece, area))) ? 0 : 1;
            },
        },

        /**
         * BOOL PtVisible(HDC hdc, int x, int y)
         *
         * Whether the pixel at the logical point is one the DC draws: inside
         * its clip, its meta region and the part of its window that shows.
         * -1 for a context there is not.
         */
        PtVisible: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, x, y])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0xffffffff;
                }
                const point = toDevice(dc, { x: x | 0, y: y | 0 });
                return areaContains(drawnAreaOf(dc), point.x, point.y) ? 1 : 0;
            },
        },

        /**
         * int GetClipBox(HDC hdc, LPRECT lprect)
         *
         * The tightest rectangle round what the DC draws in, in logical
         * units, and what kind of region that is: the window's visible part
         * for a window's context -- not the screen -- cut by the meta region
         * and the clip. A paint loop that redraws only this box redraws only
         * what changed.
         */
        GetClipBox: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, rect])=>{
                const dc = dcOf(handle);
                if (!dc || (rect >>> 0) === 0)
                {
                    return REGION_ERROR;
                }
                const area = areaOf(drawnAreaOf(dc));
                const box = area.length > 0 ? areaBox(area)
                    : { left: 0, top: 0, right: 0, bottom: 0 };
                const a = toLogical(dc, { x: box.left, y: box.top });
                const b = toLogical(dc, { x: box.right, y: box.bottom });
                writeU32s(host, rect >>> 0, [Math.min(a.x, b.x), Math.min(a.y, b.y),
                    Math.max(a.x, b.x), Math.max(a.y, b.y)]);
                return areaKind(area);
            },
        },

        /**
         * int SetMetaRgn(HDC hdc)
         *
         * The clip becomes part of the meta region -- the two intersected
         * when there is one already -- and the clip is cleared: what a
         * framework does before handing a DC on, so nothing drawn through it
         * can reach outside what it was given. Answers the meta region's kind.
         */
        SetMetaRgn: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return REGION_ERROR;
                }
                if (dc.clipSelected)
                {
                    dc.meta = apiAreaOf(dc);
                    dc.clip = null;
                    dc.clipRects = null;
                    dc.clipSelected = false;
                    if (dc.boundSurface)
                    {
                        pushClip(handle, dc, draw());
                    }
                }
                return dc.meta ? areaKind(areaOf(dc.meta)) : SIMPLEREGION;
            },
        },

        /**
         * int GetMetaRgn(HDC hdc, HRGN hrgn)
         *
         * 1 with the meta region copied into the region, 0 when the DC has
         * none.
         */
        GetMetaRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, region])=>{
                const dc = dcOf(handle);
                const target = objects.get(region);
                if (!dc || !target || target.type !== 'region')
                {
                    return 0;
                }
                if (!dc.meta)
                {
                    return 0;
                }
                holdArea(target, dc.meta);
                return 1;
            },
        },

        /**
         * int GetObjectA(HGDIOBJ h, int c, LPVOID pv)
         * int GetObjectW(HGDIOBJ h, int c, LPVOID pv)
         *
         * A null buffer asks how large one would have to be, which is how a
         * program sizes its own before asking again. The two differ only in
         * a font's face name.
         */
        GetObjectA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>getObject(args, false),
        },

        GetObjectW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>getObject(args, true),
        },

        /**
         * HPALETTE CreateHalftonePalette(HDC hdc)
         *
         * 256 colours, the stock palette's first eight and last eight at either
         * end (Wine's test_halftone_palette). Nothing pins the 240 between, and
         * they are colours spread over the whole range: a cube of six levels
         * a channel and a ramp of greys.
         */
        CreateHalftonePalette: {
            argBytes: 4,
            handler: ()=>objects.create('palette', { entries: [...HALFTONE_ENTRIES] }),
        },

        /** HPALETTE SelectPalette(HDC hdc, HPALETTE hPal, BOOL bForceBkgd) */
        SelectPalette: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, palette])=>{
                const dc = dcOf(handle);
                const record = objects.get(palette);
                if (!dc || !record || record.type !== 'palette')
                {
                    return 0;
                }
                const previous = dc.palette ?? 0;
                dc.palette = palette >>> 0;
                return previous;
            },
        },

        /**
         * UINT RealizePalette(HDC hdc)
         *
         * How many entries changed, which here is none: there is no palette in
         * a 32-bit pipeline for a realization to change. A program reads this to
         * decide whether it must redraw, and the honest answer saves it the work.
         */
        RealizePalette: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(dcOf(handle) ? 0 : 0xffffffff),
        },

        /**
         * BOOL UnrealizeObject(HGDIOBJ h)
         *
         * Undoes a realization so the next selection re-realizes it: a palette's
         * realization, or a brush's origin. This pipeline realizes no palette
         * entries and never moves a brush origin, so there is nothing to undo and
         * the call reduces to the handle check Windows itself answers with --
         * TRUE for any object that exists, FALSE for one that does not.
         */
        UnrealizeObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(objects.get(handle) ? 1 : 0),
        },

        /**
         * UINT GetPaletteEntries(HPALETTE hpal, UINT iStart, UINT cEntries,
         *                       LPPALETTEENTRY pPalEntries)
         *
         * The entries from iStart on, as far as the palette goes; a null buffer
         * asks how many entries the palette has.
         */
        GetPaletteEntries: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, start, count, out])=>{
                const record = objects.get(handle);
                if (!record || record.type !== 'palette')
                {
                    return 0;
                }
                const held = record.attributes.entries;
                if ((out >>> 0) === 0)
                {
                    return held.length;
                }
                const copied = held.slice(start >>> 0, (start >>> 0) + (count >>> 0));
                writeU32s(host, out >>> 0, copied);
                return copied.length;
            },
        },

        /**
         * UINT SetPaletteEntries(HPALETTE hpal, UINT iStart, UINT cEntries,
         *                       const PALETTEENTRY *pPalEntries)
         *
         * Bookkeeping, and honest as such: the entries are kept on the palette
         * object where GetPaletteEntries and a future realisation can read them
         * back. They change no pixel of a 32-bit surface, which has no palette
         * to change -- but a bitmap made with DIB_PAL_COLORS draws through this
         * palette, so re-filling it re-colours that bitmap.
         */
        SetPaletteEntries: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, start, count, entries])=>{
                const record = objects.get(handle);
                // The stock palette is the system's, and no program changes it.
                if (!record || record.type !== 'palette' || record.stock
                    || (entries >>> 0) === 0)
                {
                    return 0;
                }
                const first = start >>> 0;
                const wanted = count >>> 0;
                const held = record.attributes.entries;
                let written = 0;
                for (let index = 0; index < wanted; index++)
                {
                    // Past the end of the palette is not an error, it is where
                    // the copy stops -- and the count reports where it stopped.
                    if (first + index >= held.length)
                    {
                        break;
                    }
                    const bytes = host.readMemory(entries + index * PALETTEENTRY_SIZE, 4);
                    held[first + index] = (bytes[0] | bytes[1] << 8
                        | bytes[2] << 16 | bytes[3] << 24) >>> 0;
                    written++;
                }
                refreshDependents(record);
                return written;
            },
        },

        /**
         * UINT GetSystemPaletteEntries(HDC hdc, UINT iStart, UINT cEntries,
         *                             LPPALETTEENTRY pPalEntries)
         *
         * The display is not a palette device, so the count is zero -- but
         * the entries asked for are still written as the system palette
         * stands: the twenty static colours, ten at each end, black between
         * (Wine's palette.c check_system_palette_entries). A program that
         * builds its identity palette from these finds the static colours
         * where every Windows keeps them.
         */
        GetSystemPaletteEntries: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, start, count, out])=>{
                // The palette is the system's, not the DC's: it is written
                // whatever handle came with the call, a stale one included.
                if ((out >>> 0) === 0)
                {
                    return 0;
                }
                const first = start >>> 0;
                const total = Math.min(count >>> 0, Math.max(0, 256 - first));
                const bytes = new Uint8Array(total * 4);
                for (let at = 0; at < total; at++)
                {
                    const index = first + at;
                    const fixed = index < 10 ? index : index >= 246 ? index - 236 : -1;
                    const pixel = fixed < 0 ? 0 : DEFAULT_PALETTE_COLORS[fixed];
                    bytes[at * 4] = (pixel >>> 16) & 0xff;
                    bytes[at * 4 + 1] = (pixel >>> 8) & 0xff;
                    bytes[at * 4 + 2] = pixel & 0xff;
                }
                if (total > 0)
                {
                    host.writeMemory(out >>> 0, bytes);
                }
                return 0;
            },
        },

        /**
         * DWORD GetRegionData(HRGN hrgn, DWORD nCount, LPRGNDATA lpRgnData)
         *
         * The header, then every piece of the region, top to bottom and left
         * to right. A null buffer, or one too small, reports the size a
         * caller must allocate -- which is how a program sizes one before
         * asking again, and why answering with the size rather than with
         * failure matters.
         */
        GetRegionData: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([region, count, out])=>{
                const area = areaOfRegion(region);
                if (!area)
                {
                    return 0;
                }
                const needed = RGNDATAHEADER_SIZE + RECT_SIZE * area.length;
                if ((out >>> 0) === 0 || (count >>> 0) < needed)
                {
                    return needed;
                }
                const box = areaBox(area);
                writeU32s(host, out, [
                    RGNDATAHEADER_SIZE,
                    RDH_RECTANGLES,
                    area.length,
                    RECT_SIZE * area.length,
                    box.left, box.top, box.right, box.bottom,
                    ...area.flatMap(piece=>[piece.left, piece.top, piece.right, piece.bottom]),
                ]);
                return needed;
            },
        },

        /**
         * BOOL RectInRegion(HRGN hrgn, const RECT *lprect)
         *
         * Whether any pixel of the rectangle is in the region, its corners
         * taken in either order (Wine's test_region).
         */
        RectInRegion: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([region, rect])=>{
                const area = areaOfRegion(region);
                if (!area || (rect >>> 0) === 0)
                {
                    return 0;
                }
                // Any overlap at all, not containment: the question is whether
                // the region has to be redrawn, and a single shared pixel says
                // it does.
                const asked = readRect(host, rect >>> 0);
                const box = orderedRect(asked.left, asked.top, asked.right, asked.bottom);
                return intersectArea(area, box).length > 0 ? 1 : 0;
            },
        },

        /**
         * UINT GetNearestPaletteIndex(HPALETTE h, COLORREF color)
         *
         * The entry nearest the colour, by the distance between the two in
         * red, green and blue; the first of several as near. CLR_INVALID for
         * a handle that is no palette.
         */
        GetNearestPaletteIndex: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, color])=>{
                const record = objects.get(handle);
                if (record?.type !== 'palette')
                {
                    return CLR_INVALID;
                }
                const entries = record.attributes.entries;
                let best = 0;
                let nearest = Infinity;
                entries.forEach((/** @type {number} */ entry, /** @type {number} */ index)=>{
                    const distance = [0, 8, 16].reduce((sum, shift)=>{
                        const step = ((entry >>> shift) & 0xff) - ((color >>> shift) & 0xff);
                        return sum + step * step;
                    }, 0);
                    if (distance < nearest)
                    {
                        nearest = distance;
                        best = index;
                    }
                });
                return entries.length === 0 ? CLR_INVALID : best;
            },
        },

        /**
         * BOOL ResizePalette(HPALETTE hpal, UINT n)
         *
         * The palette made n entries long: cut, or grown with black ones.
         * No entries at all is refused, as is the stock palette, which is the
         * system's (Wine's test_resize_palette).
         */
        ResizePalette: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, size])=>{
                const record = objects.get(handle);
                if (record?.type !== 'palette' || record.stock || (size >>> 0) === 0
                    || (size >>> 0) > MAX_PALETTE_ENTRIES)
                {
                    return 0;
                }
                const entries = record.attributes.entries;
                const kept = entries.slice(0, size >>> 0);
                entries.length = 0;
                entries.push(...kept, ...new Array(Math.max(0, (size >>> 0) - kept.length))
                    .fill(0));
                refreshDependents(record);
                return 1;
            },
        },

        /**
         * BOOL AnimatePalette(HPALETTE hPal, UINT iStartIndex, UINT cEntries,
         *                     const PALETTEENTRY *ppe)
         *
         * The entries from iStartIndex on replaced by the ones given -- only
         * those the palette holds with PC_RESERVED, which is what reserves an
         * entry for animation; the others keep their colours. A bitmap drawn
         * through the palette changes with it. A start past the end, or the
         * stock palette, is refused.
         */
        AnimatePalette: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, start, count, entries])=>{
                const record = objects.get(handle);
                const held = record?.attributes?.entries;
                if (record?.type !== 'palette' || record.stock || (entries >>> 0) === 0
                    || (start >>> 0) >= held.length)
                {
                    return 0;
                }
                const last = Math.min(held.length, (start >>> 0) + (count >>> 0));
                const given = readU32s(entries >>> 0, last - (start >>> 0));
                for (let index = start >>> 0; index < last; index++)
                {
                    if (((held[index] >>> 24) & PC_RESERVED) !== 0)
                    {
                        held[index] = given[index - (start >>> 0)];
                    }
                }
                refreshDependents(record);
                return 1;
            },
        },

        /**
         * UINT SetSystemPaletteUse(HDC hdc, UINT use)
         *
         * SYSPAL_ERROR: the static colours can be given up only on a device
         * with a system palette, a device of eight bits or fewer, and this
         * display is 32. GetSystemPaletteUse goes on answering SYSPAL_STATIC.
         */
        SetSystemPaletteUse: {
            argBytes: 8,
            handler: ()=>SYSPAL_ERROR,
        },

        /**
         * BOOL UpdateColors(HDC hdc)
         *
         * Redraws a window's pixels through a palette realized since: there
         * is no system palette for one to have changed, so every pixel is
         * already what it shows, and the call succeeds having nothing to do.
         */
        UpdateColors: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(dcOf(handle) ? 1 : refuse(ERROR_INVALID_HANDLE)),
        },

        /**
         * BOOL GetAspectRatioFilterEx(HDC hdc, LPSIZE lpsize)
         *
         * The aspect ratio the font mapper keeps to: the device's, its
         * pixels per inch across and down, once SetMapperFlags has asked for
         * ASPECT_FILTERING, and none -- zero by zero -- until then.
         */
        GetAspectRatioFilterEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0)
                {
                    return 0;
                }
                const filtered = ((dc.mapperFlags ?? 0) & ASPECT_FILTERING) !== 0;
                writeU32s(host, out >>> 0, filtered ? [LOGICAL_DPI, LOGICAL_DPI] : [0, 0]);
                return 1;
            },
        },

        /**
         * BOOL SetBitmapDimensionEx(HBITMAP hbm, int w, int h, LPSIZE lpsz)
         * BOOL GetBitmapDimensionEx(HBITMAP hbit, LPSIZE lpsize)
         *
         * A bitmap's size in tenths of a millimetre, which only a program
         * reads back: kept on the bitmap, zero by zero until it is set, and
         * the old one written out when it is.
         */
        SetBitmapDimensionEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([bitmap, width, height, out])=>{
                const record = objects.get(bitmap);
                if (record?.type !== 'bitmap')
                {
                    return 0;
                }
                const previous = record.attributes.dimension ?? { cx: 0, cy: 0 };
                if ((out >>> 0) !== 0)
                {
                    writeU32s(host, out >>> 0, [previous.cx, previous.cy]);
                }
                record.attributes.dimension = { cx: width | 0, cy: height | 0 };
                return 1;
            },
        },
        GetBitmapDimensionEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([bitmap, out])=>{
                const record = objects.get(bitmap);
                if (record?.type !== 'bitmap' || (out >>> 0) === 0)
                {
                    return 0;
                }
                const dimension = record.attributes.dimension ?? { cx: 0, cy: 0 };
                writeU32s(host, out >>> 0, [dimension.cx, dimension.cy]);
                return 1;
            },
        },

        /**
         * int EnumObjects(HDC hdc, int nType, GOBJENUMPROC lpFunc, LPARAM lParam)
         *
         * The pens or the brushes the device offers, each as a LOGPEN or a
         * LOGBRUSH handed to the program's callback with lParam, until it
         * answers zero; the answer is the callback's last. What a display
         * offers is a solid one of each of its sixteen standard colours, and
         * for brushes the six hatches in black after them. Any other type,
         * a null callback or a build that cannot call the program enumerates
         * nothing and answers zero.
         */
        EnumObjects: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, type, proc, data])=>{
                const call = host.call;
                const scratch = host.surfaces;
                if (!dcOf(handle) || (proc >>> 0) === 0 || !call || !scratch)
                {
                    return 0;
                }
                /** @type {number[][]} */
                const offered = (type | 0) === OBJ_PEN
                    ? STANDARD_COLORS.map(color=>[PS_SOLID, 1, 0, color])
                    : (type | 0) === OBJ_BRUSH
                        ? [...STANDARD_COLORS.map(color=>[BS_SOLID, color, 0]),
                            ...HATCHES.map(hatch=>[BS_HATCHED, 0, hatch])]
                        : [];
                if (offered.length === 0)
                {
                    return refuse(ERROR_INVALID_PARAMETER);
                }
                const thread = host.callerThread?.();
                const buffer = scratch.allocate(16);
                if (!buffer)
                {
                    return 0;
                }
                return (async()=>{
                    let answer = 0;
                    try
                    {
                        for (const fields of offered)
                        {
                            writeU32s(host, buffer, fields);
                            answer = (await call(proc >>> 0, [buffer, data >>> 0], thread)) | 0;
                            if (answer === 0)
                            {
                                break;
                            }
                        }
                    }
                    finally
                    {
                        scratch.free(buffer);
                    }
                    return answer >>> 0;
                })();
            },
        },

        /**
         * BOOL GdiComment(HDC hdc, UINT nSize, const BYTE *lpData)
         *
         * A comment is for a metafile, which keeps it as a record (the
         * recording in `metafiles.js` sees the call); any other DC takes it
         * and keeps nothing.
         */
        GdiComment: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, size, data])=>{
                const dc = dcOf(handle);
                if (!dc || ((size >>> 0) !== 0 && (data >>> 0) === 0))
                {
                    return 0;
                }
                return 1;
            },
        },

        /**
         * int DrawEscape(HDC hdc, int iEscape, int cjIn, LPCSTR lpIn)
         *
         * A display driver's private drawing request. This display driver has
         * none, and zero is what an escape that is not implemented answers.
         */
        DrawEscape: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle])=>(dcOf(handle) ? 0 : 0xffffffff),
        },

        /**
         * BOOL SetObjectOwner(HGDIOBJ, HANDLE)
         *
         * Windows 95 gave a GDI object to another process with it; NT exports
         * it and does nothing, and an object here belongs to nobody either.
         */
        SetObjectOwner: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([object])=>(objects.get(object) ? 1 : 0),
        },

        /**
         * BOOL PlgBlt(HDC hdcDest, const POINT *lpPoint, HDC hdcSrc, int xSrc,
         *   int ySrc, int width, int height, HBITMAP hbmMask, int xMask, int yMask)
         *
         * The source rectangle onto the parallelogram whose corners are the
         * three points -- the rectangle's top left, top right and bottom left
         * -- in the destination's logical units, as the source rectangle is
         * in the source's: both are taken to their devices here, and the
         * drawing context is given device units (`plgBlt`). A mask, when
         * there is one, is monochrome, or the call fails as MSDN says.
         */
        PlgBlt: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([dest, points, source, x, y, width, height, mask, maskX, maskY])=>{
                const dc = dcOf(dest);
                const from = dcOf(source);
                const interfaces = bound(dest);
                const record = (mask >>> 0) === 0 ? null : objects.get(mask);
                if (!dc || !from || !interfaces || (points >>> 0) === 0 || !bound(source)
                    || ((mask >>> 0) !== 0 && (record?.type !== 'bitmap'
                        || record.attributes.bitCount !== 1)))
                {
                    return 0;
                }
                const corners = pointsAt(points >>> 0, 3).map(point=>toDevice(dc, point));
                const area = deviceRect(from, x, y, width, height);
                /** @param {number} [maskDc] */
                const blit = maskDc=>interfaces.plgBlt(dest >>> 0, corners, source >>> 0, area,
                    maskDc, { x: maskX | 0, y: maskY | 0 });
                const done = record
                    ? lend(mask, maskDc=>(bound(maskDc, false) ? blit(maskDc) : false))
                    : blit();
                return done ? 1 : 0;
            },
        },

        /** BOOL GdiFlush(void) */
        GdiFlush: {
            argBytes: 0,
            handler: ()=>1,
        },

        /**
         * DWORD GdiSetBatchLimit(DWORD dw)
         *
         * Nothing is batched here, every call draws at once, but the limit is
         * kept and the previous one answered: 20 until a program sets one, and
         * zero asks for that default back.
         */
        GdiSetBatchLimit: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([limit])=>{
                const previous = batchLimit;
                batchLimit = (limit >>> 0) === 0 ? DEFAULT_BATCH_LIMIT : limit >>> 0;
                return previous;
            },
        },

        /**
         * UINT GetSystemPaletteUse(HDC hdc)
         *
         * SYSPAL_STATIC: the twenty static colours are the system's, as on any
         * display whose palette nobody has taken over.
         */
        GetSystemPaletteUse: {
            argBytes: 4,
            handler: ()=>SYSPAL_STATIC,
        },

        /**
         * BOOL GetDeviceGammaRamp(HDC hdc, LPVOID lpRamp)
         *
         * The ramp the display shows through, written out in full, and the
         * identity when none was set: a program that reads it, adjusts it and
         * writes it back must get something it can adjust, and an untouched
         * buffer would leave it multiplying by whatever was there.
         */
        GetDeviceGammaRamp: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, ramp])=>{
                if (!dcOf(handle) || (ramp >>> 0) === 0)
                {
                    return 0;
                }
                const shown = services.setGammaRamp ? services.gammaRamp?.() : keptGammaRamp;
                const bytes = new Uint8Array(GAMMA_RAMP_BYTES);
                const view = new DataView(bytes.buffer);
                for (let channel = 0; channel < 3; channel++)
                {
                    const entries = shown ? [shown.red, shown.green, shown.blue][channel] : null;
                    for (let index = 0; index < GAMMA_CHANNEL_ENTRIES; index++)
                    {
                        const at = (channel * GAMMA_CHANNEL_ENTRIES + index) * 2;
                        view.setUint16(at, entries ? entries[index] : index * 257, true);
                    }
                }
                host.writeMemory(ramp >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL SetDeviceGammaRamp(HDC hdc, LPVOID lpRamp)
         *
         * The display's ramp, handed to the graphics layer, which shows every
         * frame through it. A ramp too far from the identity is refused, as
         * Windows refuses it, and leaves the one before it in effect.
         */
        SetDeviceGammaRamp: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, ramp])=>{
                if (!dcOf(handle) || (ramp >>> 0) === 0)
                {
                    return 0;
                }
                const read = readGammaRamp(host.readMemory(ramp >>> 0, GAMMA_RAMP_BYTES));
                if (!read)
                {
                    return 0;
                }
                if (services.setGammaRamp)
                {
                    services.setGammaRamp(read);
                }
                else
                {
                    keptGammaRamp = read;
                }
                return 1;
            },
        },

        /** BOOL OffsetViewportOrgEx(HDC hdc, int x, int y, LPPOINT lppt) */
        OffsetViewportOrgEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, x, y, point])=>{
                const dc = dcOf(handle);
                if (!dc)
                {
                    return 0;
                }
                if ((point >>> 0) !== 0)
                {
                    writeU32s(host, point, [dc.viewportOrg.x | 0, dc.viewportOrg.y | 0]);
                }
                dc.viewportOrg = {
                    x: (dc.viewportOrg.x | 0) + (x | 0),
                    y: (dc.viewportOrg.y | 0) + (y | 0),
                };
                return 1;
            },
        },

        /** int ChoosePixelFormat(HDC hdc, const PIXELFORMATDESCRIPTOR *ppfd) */
        ChoosePixelFormat: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, descriptor])=>{
                if (!dcOf(handle))
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                if (!services.pixelFormat || (descriptor >>> 0) === 0)
                {
                    return 0;
                }
                return services.pixelFormat.choose(
                    host.readMemory(descriptor >>> 0, services.pixelFormat.size())) | 0;
            },
        },

        /**
         * int DescribePixelFormat(HDC hdc, int iPixelFormat, UINT nBytes,
         *                         LPPIXELFORMATDESCRIPTOR ppfd)
         *
         * Answers with how many formats there are whether or not it describes
         * one, which is how a program enumerates them.
         */
        DescribePixelFormat: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, index, bytes, out])=>{
                if (!dcOf(handle))
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                if (!services.pixelFormat)
                {
                    return 0;
                }
                const count = services.pixelFormat.count() | 0;
                if ((out >>> 0) === 0)
                {
                    return count;
                }
                const described = services.pixelFormat.describe(index | 0, bytes | 0);
                if (!described)
                {
                    return 0;
                }
                host.writeMemory(out >>> 0, described);
                return count;
            },
        },

        /** int GetPixelFormat(HDC hdc) */
        GetPixelFormat: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                // A handle that is no context has no format: Windows answers
                // ERROR_INVALID_PIXEL_FORMAT here, where its siblings say the
                // handle is bad (Wine's opengl32 test_setpixelformat).
                if (!dcOf(handle))
                {
                    return refuse(ERROR_INVALID_PIXEL_FORMAT);
                }
                return services.pixelFormat ? services.pixelFormat.get(handle >>> 0) | 0 : 0;
            },
        },

        /**
         * BOOL SetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd)
         *
         * Set once, on the window rather than the DC -- the service keeps that
         * rule, so that a context made through OPENGL32 on a later DC of the
         * same window finds the format this call set.
         */
        SetPixelFormat: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, format])=>{
                if (!dcOf(handle))
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                return services.pixelFormat && services.pixelFormat.set(handle >>> 0, format | 0)
                    ? 1 : 0;
            },
        },

        /**
         * BOOL SwapBuffers(HDC hdc)
         *
         * GDI's spelling of wglSwapBuffers, and the one most programs call --
         * it is the end of every frame an OpenGL program draws. Missing from
         * this table it would reach the unimplemented-import stub, which cleans
         * up no arguments, so the caller would return with its stack four bytes
         * adrift once per frame and die a long way from anything that explains
         * it.
         */
        SwapBuffers: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!dcOf(handle))
                {
                    return refuse(ERROR_INVALID_HANDLE);
                }
                if (!services.swapBuffers)
                {
                    return 0;
                }
                const presented = services.swapBuffers(handle >>> 0);
                return presented instanceof Promise
                    ? presented.then(done=>(done ? 1 : 0))
                    : (presented ? 1 : 0);
            },
        },
    };

    /**
     * @param {number[]} args  The object, the room the caller has, its buffer.
     * @param {boolean} wide
     */
    const getObject = ([handle, size, out], wide)=>{
        const record = objects.get(handle);
        const shape = record
            ? describeObject(record, (out >>> 0) === 0 ? 0 : size | 0, wide)
            : null;
        if (!shape)
        {
            return 0;
        }
        if ((out >>> 0) === 0)
        {
            return shape.length;
        }
        if ((size | 0) < shape.length)
        {
            return 0;
        }
        if (host.canWrite && !host.canWrite(out >>> 0, shape.length))
        {
            host.setLastError?.(ERROR_NOACCESS);
            return 0;
        }
        host.writeMemory(out >>> 0, shape);
        return shape.length;
    };

    /**
     * ExtTextOut, spelt once: the string read as bytes in the ANSI page or as
     * UTF-16 code units, `c` of them either way and unterminated, and lpDx one
     * advance per character, which is how justified text is positioned.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const extTextOut = ([handle, x, y, options, rect, string, count, dx], wide)=>{
        // The count is a UINT, and one past INT_MAX -- the -1 a caller used
        // to "terminated" passes -- is refused rather than read as a length.
        if ((count | 0) < 0)
        {
            return 0;
        }
        const interfaces = bound(handle);
        if (!interfaces)
        {
            return 0;
        }
        const length = count >>> 0;
        const bytes = (string >>> 0) === 0 || length === 0
            ? new Uint8Array(0)
            : host.readMemory(string >>> 0, wide ? length * 2 : length);
        let text = '';
        if (!wide)
        {
            text = decodeAnsi(bytes.subarray(0, length));
        }
        else
        {
            for (let at = 0; at < length && at * 2 + 1 < bytes.length; at++)
            {
                text += String.fromCharCode(bytes[at * 2] | bytes[at * 2 + 1] << 8);
            }
        }
        // Advances the program gave are its own; without them the DC's
        // character spacing and justification decide.
        const advances = (dx >>> 0) === 0 || length === 0
            ? spacedAdvances(dcOf(handle), text) ?? undefined
            : [...Array(length).keys()].map(index=>{
                const word = host.readMemory((dx >>> 0) + index * 4, 4);
                return (word[0] | word[1] << 8 | word[2] << 16 | word[3] << 24) | 0;
            });
        return interfaces.extTextOutA(handle >>> 0, x | 0, y | 0, options >>> 0,
            (rect >>> 0) === 0 ? null : readRect(host, rect), text, advances) ? 1 : 0;
    };
    /**
     * Gives the drawing layer the clip the DC's record holds again: what
     * RestoreDC put back.
     *
     * @param {number} handle
     */
    const restoreClip = handle=>{
        const dc = dcOf(handle);
        const interfaces = dc?.boundSurface ? draw() : null;
        if (!dc || !interfaces)
        {
            return;
        }
        pushClip(handle, dc, interfaces);
    };

    /**
     * Gives the drawing layer the brush origin RestoreDC put back.
     *
     * @param {number} handle
     */
    const restoreBrushOrigin = handle=>{
        const dc = dcOf(handle);
        if (dc?.boundSurface && dc.brushOrg)
        {
            draw()?.setBrushOrgEx?.(handle >>> 0, dc.brushOrg.x, dc.brushOrg.y);
        }
    };

    /**
     * What a DC draws in, in its device coordinates: its visible part, meta
     * region and clip together, as pieces that do not overlap.
     *
     * @param {number} handle
     * @returns {import('./rects.js').Rect[]}
     */
    const drawnArea = handle=>{
        const dc = dcOf(handle);
        return dc ? areaOf(drawnAreaOf(dc)) : [];
    };

    /**
     * A region made to hold an area, as the window manager hands one back.
     *
     * @param {number} handle @param {import('./rects.js').Rect[]} pieces
     * @returns {boolean} false for a handle that is not a region
     */
    const setRegionArea = (handle, pieces)=>{
        const record = objects.get(handle >>> 0);
        if (!record || record.type !== 'region')
        {
            return false;
        }
        holdArea(record, pieces);
        return true;
    };

    return { functions, bound, setDIBits, restoreClip, restoreBrushOrigin, setVisible,
        drawnArea, setRegionArea };
}

/**
 * What GetObject reports for one object: the bytes of its struct.
 *
 * Only the shapes a program reads back are here. An object whose struct is not
 * described answers zero rather than a buffer of the wrong length, because a
 * caller that trusted the length would read past its own allocation.
 *
 * @param {any} record
 * @param {number} room  What the caller has space for. A DIB section is a
 *        DIBSECTION to a caller with room for one and a BITMAP to any other,
 *        a null buffer's question included.
 * @param {boolean} wide  GetObjectW: a font's face name is UTF-16.
 * @returns {Uint8Array | null}
 */
function describeObject(record, room, wide){
    const attributes = record.attributes ?? {};
    switch (record.type){
        // LOGPEN: style, POINT width, colour.
        // EXTLOGPEN for an ExtCreatePen pen: the style as it was asked for,
        // width, brush style, colour, hatch and the dash table. A buffer
        // short of the dashes is refused, as one short of the rest is.
        case 'pen':
            return attributes.extended !== undefined
                ? dwords([attributes.extended >>> 0, attributes.width | 0,
                    attributes.brushStyle >>> 0, attributes.color >>> 0, attributes.hatch >>> 0,
                    (attributes.entries ?? []).length, ...(attributes.entries ?? [])])
                : dwords([attributes.style | 0, attributes.width | 0, 0, attributes.color >>> 0]);
        // LOGBRUSH: style, colour, hatch.
        case 'brush':
            return dwords([attributes.style | 0, attributes.color >>> 0, attributes.hatch | 0]);
        case 'bitmap':
            return describeBitmap(attributes, room >= DIBSECTION.SIZE);
        case 'font':
            return logFontBytes(attributes, wide);
        // A palette is the WORD count of its entries.
        case 'palette':
            return new Uint8Array([attributes.entries.length & 0xff,
                (attributes.entries.length >>> 8) & 0xff]);
        default:
            return null;
    }
}

/** @param {number[]} values @returns {Uint8Array} the values as little-endian DWORDs */
function dwords(values){
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index)=>view.setUint32(index * 4, value >>> 0, true));
    return bytes;
}

/**
 * BITMAP, or DIBSECTION for a DIB section when there is room for one.
 *
 * The row stride is the one the bitmap's own rows are laid out in: a DIB
 * section pads to a DWORD, a device-dependent bitmap to a WORD. `section` is
 * the address the program was handed for a DIB section's bits; a
 * device-dependent bitmap has none, which is what a NULL bmBits says.
 *
 * @param {any} attributes @param {boolean} asSection
 */
function describeBitmap(attributes, asSection){
    const width = attributes.width | 0;
    const height = attributes.height | 0;
    const bitCount = attributes.bitCount ?? 32;
    const section = attributes.section >>> 0;
    const stride = section !== 0 ? dibStride(width, bitCount) : ddbStride(width, bitCount);
    const bytes = new Uint8Array(section !== 0 && asSection ? DIBSECTION.SIZE : BITMAP.SIZE);
    const view = new DataView(bytes.buffer);
    view.setInt32(BITMAP.bmWidth, width, true);
    view.setInt32(BITMAP.bmHeight, height, true);
    view.setInt32(BITMAP.bmWidthBytes, stride, true);
    view.setUint16(BITMAP.bmPlanes, attributes.planes ?? 1, true);
    view.setUint16(BITMAP.bmBitsPixel, bitCount, true);
    view.setUint32(BITMAP.bmBits, section, true);
    if (bytes.length === BITMAP.SIZE)
    {
        return bytes;
    }
    // The header comes back as the section is, not as it was asked for: the
    // height without its sign, the image size worked out, and the colour
    // table counted in full.
    /** @param {number} field @param {number} value */
    const header = (field, value)=>view.setInt32(DIBSECTION.dsBmih + field, value | 0, true);
    header(BITMAPINFOHEADER.biSize, BITMAPINFOHEADER.SIZE);
    header(BITMAPINFOHEADER.biWidth, width);
    header(BITMAPINFOHEADER.biHeight, height);
    view.setUint16(DIBSECTION.dsBmih + BITMAPINFOHEADER.biPlanes, 1, true);
    view.setUint16(DIBSECTION.dsBmih + BITMAPINFOHEADER.biBitCount, bitCount, true);
    header(BITMAPINFOHEADER.biCompression, attributes.compression ?? BI_RGB);
    header(BITMAPINFOHEADER.biSizeImage, stride * height);
    header(BITMAPINFOHEADER.biXPelsPerMeter, attributes.pelsPerMeter?.[0] ?? 0);
    header(BITMAPINFOHEADER.biYPelsPerMeter, attributes.pelsPerMeter?.[1] ?? 0);
    header(BITMAPINFOHEADER.biClrUsed, attributes.palette?.length ?? 0);
    const masks = attributes.bitfields ?? [0, 0, 0];
    for (let index = 0; index < 3; index++)
    {
        view.setUint32(DIBSECTION.dsBitfields + index * 4, masks[index] >>> 0, true);
    }
    return bytes;
}
