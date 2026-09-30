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
 * Two decisions are worth stating because they are ceilings rather than
 * omissions:
 *
 * - **A region is one rectangle.** The drawing half made the same choice for
 *   clipping, and a second, richer region model here would be a second answer
 *   to the same question. `CombineRgn` therefore answers with a bounding box
 *   where a real region would answer with a shape: an OR of two far-apart
 *   rectangles covers the span between them, which repaints more than it must
 *   and never less.
 * - **A palette selects and realizes but changes nothing.** Every surface here
 *   is 32-bit BGRX, so there is no palette for a palette to be. Reporting that
 *   zero entries changed is the truth about this pipeline, and it is also what
 *   a program checks before deciding to redraw.
 */

import { readRect, writeU16, writeU32s } from '../user32/structs.js';
import { decodeAnsi } from '../kernel32/locale.js';
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
/** Bits per pixel the DIB decoder reads. */
const DIB_BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);

/** CombineRgn's modes. */
/** GdiSetBatchLimit's limit until a program sets one. */
/** The raster operation that copies the source as it is. */
const SRCCOPY = 0x00cc0020;
const DEFAULT_BATCH_LIMIT = 20;
/** The static colours are the system's: GetSystemPaletteUse. */
const SYSPAL_STATIC = 1;

const RGN_AND = 1;
const RGN_OR = 2;
const RGN_XOR = 3;
const RGN_DIFF = 4;
const RGN_COPY = 5;

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
 * @property {(font: import('./structs.js').LogFontFields, text: string) => number | null}
 *           [textWidth]
 *           How wide the engine draws a string in a font; null, or absent,
 *           without an engine.
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

/** An empty rectangle, which is what a region with no extent is. */
const EMPTY = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

/** @param {any} rect */
const isEmpty = rect=>rect.right <= rect.left || rect.bottom <= rect.top;

/**
 * The rectangle two regions combine to.
 *
 * AND is exact. OR, XOR and DIFF are the bounding box of what a real region
 * would hold, which is the ceiling this file's header names -- and for DIFF it
 * is the source rectangle unchanged, because anything smaller could remove a
 * pixel the difference still contains.
 *
 * @param {any} first @param {any} second @param {number} mode
 */
export function combine(first, second, mode){
    switch (mode | 0){
        case RGN_COPY:
            return first;
        case RGN_AND:
            return {
                left: Math.max(first.left, second.left),
                top: Math.max(first.top, second.top),
                right: Math.min(first.right, second.right),
                bottom: Math.min(first.bottom, second.bottom),
            };
        case RGN_OR:
        case RGN_XOR:
            if (isEmpty(first))
            {
                return second;
            }
            if (isEmpty(second))
            {
                return first;
            }
            return {
                left: Math.min(first.left, second.left),
                top: Math.min(first.top, second.top),
                right: Math.max(first.right, second.right),
                bottom: Math.max(first.bottom, second.bottom),
            };
        case RGN_DIFF:
            return first;
        default:
            return null;
    }
}

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
 * on the screen from the start radial to the end radial, a segment for about
 * every two pixels of the way.
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
    // Screen y grows downward, so counterclockwise is the angle of -y.
    const from = Math.atan2(cy - yStart, xStart - cx);
    let to = Math.atan2(cy - yEnd, xEnd - cx);
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
 * @returns The entry points; `bound`, the drawing interface a context is
 *     bound to, for the window manager, which paints its own controls through
 *     the same engine without a guest string to read; and `setDIBits`, which
 *     CreateDIBitmap initialises a bitmap with.
 */
export function createDrawingFunctions(
    { host, objects, dcOf, surfaceOf, currentMetrics, lend, readColorTable, toDevice })
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
    const bound = (handle, present = true)=>{
        const dc = dcOf(handle);
        const interfaces = draw();
        if (!dc || !interfaces || !services.surfaceFor)
        {
            return null;
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
        return interfaces;
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
     * @returns {{ header: import('./structs.js').BitmapInfoHeaderFields, bits: Uint8Array,
     *             colors: number[], masks: number[] } | null}
     */
    const readDib = (info, bits, usage, dc, lines)=>{
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
        const colors = header.bitCount <= 8
            ? readColorTable(info + header.size, count, usage, dc, colorEntryBytes(header))
            : [];
        return { header, bits: host.readMemory(bits, rle ? header.sizeImage : stride * rows),
            colors, masks };
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
        dc.clipSelected = true;
        bound(handle)?.setClipRect(handle >>> 0, rect);
    };

    /** @param {number} handle @returns {any | null} */
    const regionOf = handle=>{
        const record = objects.get(handle);
        return record && record.type === 'region' ? record.attributes : null;
    };

    /** @param {any} rect */
    const newRegion = rect=>objects.create('region', {
        left: rect.left | 0,
        top: rect.top | 0,
        right: rect.right | 0,
        bottom: rect.bottom | 0,
    });

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
                const interfaces = bound(dest);
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
                const interfaces = bound(dest);
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
         * A stretch that leaves the key colour's pixels out. The drawing
         * layer copies every pixel, the key's too, so the copy is made whole
         * and that is reported; a negative size is refused, as it is there.
         */
        GdiTransparentBlt: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([dest, x, y, cx, cy, source, x1, y1, cx1, cy1])=>{
                const interfaces = bound(dest);
                if (!interfaces || !bound(source) || (cx | 0) < 0 || (cy | 0) < 0
                    || (cx1 | 0) < 0 || (cy1 | 0) < 0)
                {
                    return 0;
                }
                host.divergence?.('GdiTransparentBlt', 'the key colour is copied too');
                return interfaces.stretchBlt(dest >>> 0, x | 0, y | 0, cx | 0, cy | 0,
                    source >>> 0, x1 | 0, y1 | 0, cx1 | 0, cy1 | 0, SRCCOPY) ? 1 : 0;
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
                const image = readDib(info >>> 0, bits >>> 0, usage >>> 0, dcOf(dest));
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
                const interfaces = bound(handle);
                return interfaces ? interfaces.setStretchBltMode(handle >>> 0, mode | 0) : 0;
            },
        },

        /** int GetStretchBltMode(HDC hdc) */
        GetStretchBltMode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const interfaces = bound(handle);
                return interfaces ? interfaces.getStretchBltMode(handle >>> 0) : 0;
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
            handler: ([handle, x, y, string, count])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const length = Math.max(count | 0, 0);
                const text = (string >>> 0) === 0 || length === 0
                    ? ''
                    : decodeAnsi(host.readMemory(string >>> 0, length));
                interfaces.textOutA(handle >>> 0, x | 0, y | 0, text);
                return 1;
            },
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
            handler: ([handle, x, y, string, count])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const length = Math.max(count | 0, 0);
                const bytes = (string >>> 0) === 0 || length === 0
                    ? new Uint8Array(0)
                    : host.readMemory(string >>> 0, length * 2);
                let text = '';
                for (let at = 0; at * 2 + 1 < bytes.length; at++)
                {
                    text += String.fromCharCode(bytes[at * 2] | (bytes[at * 2 + 1] << 8));
                }
                interfaces.textOutA(handle >>> 0, x | 0, y | 0, text);
                return 1;
            },
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
            handler: ([handle, left, top, right, bottom, xStart, yStart, xEnd, yEnd])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const points = arcPoints(left | 0, top | 0, right | 0, bottom | 0,
                    xStart | 0, yStart | 0, xEnd | 0, yEnd | 0);
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

        /** int FillRgn(HDC hdc, HRGN hrgn, HBRUSH hbr) */
        FillRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, region, brush])=>{
                const rect = regionOf(region);
                const interfaces = bound(handle);
                if (!rect || !interfaces)
                {
                    return 0;
                }
                interfaces.fillRect(handle >>> 0, rect, brush >>> 0);
                return 1;
            },
        },

        /** HRGN CreateRectRgn(int x1, int y1, int x2, int y2) */
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

        /** int GetRgnBox(HRGN hrgn, LPRECT lprc): the bounds, and what kind of region */
        GetRgnBox: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([region, out])=>{
                const rect = regionOf(region);
                if (!rect || (out >>> 0) === 0)
                {
                    return REGION_ERROR;
                }
                // An empty region has no position: Windows keeps it as zeros.
                const empty = isEmpty(rect);
                writeU32s(host, out >>> 0,
                    empty ? [0, 0, 0, 0] : [rect.left, rect.top, rect.right, rect.bottom]);
                return empty ? NULLREGION : SIMPLEREGION;
            },
        },

        /** int CombineRgn(HRGN hrgnDst, HRGN hrgnSrc1, HRGN hrgnSrc2, int iMode) */
        CombineRgn: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, first, second, mode])=>{
                const target = objects.get(destination);
                const left = regionOf(first);
                if (!target || target.type !== 'region' || !left)
                {
                    return REGION_ERROR;
                }
                const right = regionOf(second) ?? EMPTY;
                const result = combine(left, right, mode);
                if (!result)
                {
                    return REGION_ERROR;
                }
                target.attributes = { ...result };
                return isEmpty(result) ? NULLREGION : SIMPLEREGION;
            },
        },

        /**
         * int SelectClipRgn(HDC hdc, HRGN hrgn)
         *
         * A null region means no clipping, which is the whole surface -- not an
         * empty one, which would clip everything away.
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
                    dc.clipSelected = false;
                    bound(handle)?.setClipRect(handle >>> 0, clipOf(dc));
                    return SIMPLEREGION;
                }
                const rect = regionOf(region);
                if (!rect)
                {
                    return REGION_ERROR;
                }
                setClip(handle, dc, rect);
                return isEmpty(rect) ? NULLREGION : SIMPLEREGION;
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
                const target = objects.get(region);
                if (!dc || !target || target.type !== 'region')
                {
                    return 0xffffffff;
                }
                if (!dc.clipSelected)
                {
                    return 0;
                }
                target.attributes = { ...clipOf(dc) };
                return 1;
            },
        },

        /**
         * int IntersectClipRect(HDC hdc, int left, int top, int right, int bottom)
         *
         * The clip narrowed to the rectangle, which a rectangle always is.
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
                const clip = intersect(clipOf(dc), {
                    left: left | 0, top: top | 0, right: right | 0, bottom: bottom | 0,
                });
                setClip(handle, dc, clip);
                return isEmpty(clip) ? NULLREGION : SIMPLEREGION;
            },
        },

        /**
         * int ExcludeClipRect(HDC hdc, int left, int top, int right, int bottom)
         *
         * A clip is one rectangle here, so taking a rectangle out of it is
         * exact only when what is left is still one: nothing, or the clip
         * less a band across its full width or height. That is the common
         * case -- a program excludes the strip it has already painted -- and
         * it is done. Any other cut would leave an L or a frame, which this
         * model cannot hold; the clip is left as it was and the answer says
         * the region is more complex than what is drawn under, which is true.
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
                const clip = clipOf(dc);
                const cut = intersect(clip, {
                    left: left | 0, top: top | 0, right: right | 0, bottom: bottom | 0,
                });
                if (isEmpty(cut))
                {
                    return isEmpty(clip) ? NULLREGION : SIMPLEREGION;
                }
                const spansWidth = cut.left <= clip.left && cut.right >= clip.right;
                const spansHeight = cut.top <= clip.top && cut.bottom >= clip.bottom;
                /** @param {any} rect */
                const keep = rect=>{
                    setClip(handle, dc, rect);
                    return isEmpty(rect) ? NULLREGION : SIMPLEREGION;
                };
                if (spansWidth && spansHeight)
                {
                    return keep({ left: 0, top: 0, right: 0, bottom: 0 });
                }
                if (spansWidth && cut.top <= clip.top)
                {
                    return keep({ ...clip, top: cut.bottom });
                }
                if (spansWidth && cut.bottom >= clip.bottom)
                {
                    return keep({ ...clip, bottom: cut.top });
                }
                if (spansHeight && cut.left <= clip.left)
                {
                    return keep({ ...clip, left: cut.right });
                }
                if (spansHeight && cut.right >= clip.right)
                {
                    return keep({ ...clip, right: cut.left });
                }
                return COMPLEXREGION;
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
                if (!dc || (rect >>> 0) === 0 || !bound(handle))
                {
                    return 0;
                }
                return isEmpty(intersect(clipOf(dc), readRect(host, rect >>> 0))) ? 0 : 1;
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
                // A bitmap whose colour table was made palette-relative holds
                // indices into this palette, so changing the entries changes
                // what the bitmap's pixels mean. The resolved arrays are kept
                // alive on the palette and refreshed here in place -- the
                // surfaces that already hold a reference to them see it.
                for (const dependent of record.attributes.dependents ?? [])
                {
                    for (let index = 0; index < dependent.indices.length; index++)
                    {
                        dependent.table[index]
                            = paletteEntryToPixel(held[dependent.indices[index]] ?? 0);
                    }
                }
                return written;
            },
        },

        /**
         * UINT GetSystemPaletteEntries(HDC hdc, UINT iStart, UINT cEntries,
         *                             LPPALETTEENTRY pPalEntries)
         *
         * None. A system palette exists on a device of eight bits or fewer, and
         * this one is 32; reporting entries a program could then match against
         * would have it choose colours from a palette nothing draws through.
         */
        GetSystemPaletteEntries: {
            argBytes: 16,
            handler: ()=>0,
        },

        /**
         * DWORD GetRegionData(HRGN hrgn, DWORD nCount, LPRGNDATA lpRgnData)
         *
         * A null buffer, or one too small, reports the size a caller must
         * allocate -- which is how a program sizes one before asking again, and
         * why answering with the size rather than with failure matters.
         *
         * One rectangle comes back because a region is one rectangle here. That
         * is the ceiling this file's header names; a caller walking the buffer
         * sees a well-formed region that covers more than a real one would.
         */
        GetRegionData: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([region, count, out])=>{
                const rect = regionOf(region);
                if (!rect)
                {
                    return 0;
                }
                const needed = RGNDATAHEADER_SIZE + RECT_SIZE;
                if ((out >>> 0) === 0 || (count >>> 0) < needed)
                {
                    return needed;
                }
                writeU32s(host, out, [
                    RGNDATAHEADER_SIZE,
                    RDH_RECTANGLES,
                    1,
                    RECT_SIZE,
                    rect.left, rect.top, rect.right, rect.bottom,
                ]);
                writeU32s(host, out + RGNDATAHEADER_SIZE,
                    [rect.left, rect.top, rect.right, rect.bottom]);
                return needed;
            },
        },

        /** BOOL RectInRegion(HRGN hrgn, const RECT *lprect) */
        RectInRegion: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([region, rect])=>{
                const held = regionOf(region);
                if (!held || (rect >>> 0) === 0)
                {
                    return 0;
                }
                // Any overlap at all, not containment: the question is whether
                // the region has to be redrawn, and a single shared pixel says
                // it does.
                return isEmpty(combine(held, readRect(host, rect), RGN_AND)) ? 0 : 1;
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
        const advances = (dx >>> 0) === 0 || length === 0
            ? undefined
            : [...Array(length).keys()].map(index=>{
                const word = host.readMemory((dx >>> 0) + index * 4, 4);
                return (word[0] | word[1] << 8 | word[2] << 16 | word[3] << 24) | 0;
            });
        return interfaces.extTextOutA(handle >>> 0, x | 0, y | 0, options >>> 0,
            (rect >>> 0) === 0 ? null : readRect(host, rect), text, advances) ? 1 : 0;
    };
    return { functions, bound, setDIBits };
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
        case 'pen':
            return dwords([attributes.style | 0, attributes.width | 0, 0, attributes.color >>> 0]);
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
