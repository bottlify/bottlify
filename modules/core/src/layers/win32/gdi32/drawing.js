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
import { BITMAPINFOHEADER, PALETTEENTRY_SIZE, readBitmapInfoHeader }
    from './structs.js';

/** iUsage of the DIB functions: a colour table of RGBQUADs, not palette indices. */
const DIB_RGB_COLORS = 0;
/** BI_RGB: the one compression the DIB decoder reads. */
const BI_RGB = 0;
/** Bits per pixel the DIB decoder reads. */
const DIB_BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);

/** CombineRgn's modes. */
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

/** ABC: three LONGs, the left bearing, the black width and the right bearing. */
const ABC_SIZE = 12;

/** What a call that should have returned a UINT says when it failed. */
const GDI_ERROR = 0xffffffff;

/** A gamma ramp is three arrays of 256 words, one per channel. */
const GAMMA_CHANNEL_ENTRIES = 256;
const GAMMA_RAMP_BYTES = 3 * GAMMA_CHANNEL_ENTRIES * 2;

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
 * @property {any} [pixelFormat]
 *           The pixel-format service: `choose(descriptor)`, `describe(index)`
 *           and `count()`. Absent in a build with no rendering surface.
 * @property {(hdc: number) => boolean} [swapBuffers]
 *           Presents the frame an OpenGL context drew into a device context.
 *           Absent in a build that cannot draw, where SwapBuffers fails rather
 *           than presenting nothing.
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
 * @param {Object} options
 * @param {any} options.host
 * @param {any} options.objects   The GDI object table.
 * @param {(handle: number) => any | null} options.dcOf
 * @param {(dc: any) => any} options.surfaceOf   What the DC reports about its size.
 * @param {(dc: any) => any} options.currentMetrics
 */
export function createDrawingFunctions({ host, objects, dcOf, surfaceOf, currentMetrics }){
    /** @type {DrawingServices} */
    const services = host.graphics ?? {};

    /**
     * The drawing interface, built on first use and only if there is one.
     *
     * Lazy because a process that never draws should not pay for it, and
     * because the object table it is given has to be this one -- a second copy
     * would resolve a pen handle to a different pen.
     */
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
     */
    const bound = handle=>{
        const dc = dcOf(handle);
        const interfaces = draw();
        if (!dc || !interfaces || !services.surfaceFor)
        {
            return null;
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
        return interfaces;
    };

    /**
     * A DIB as a program hands one to the device: the header, the colour
     * table that follows it when the format has one, and the bits, read from
     * guest memory into the shape the drawing layer decodes.
     *
     * @param {number} info @param {number} bits
     * @returns {{ header: import('./structs.js').BitmapInfoHeaderFields, bits: Uint8Array,
     *             colors: number[] } | null}
     */
    const readDib = (info, bits)=>{
        const header = readBitmapInfoHeader(host, info);
        if (header.size < BITMAPINFOHEADER.SIZE || header.width <= 0 || header.height === 0
            || !DIB_BIT_COUNTS.has(header.bitCount) || header.compression !== BI_RGB)
        {
            return null;
        }
        const stride = ((header.width * header.bitCount + 31) >> 5) * 4;
        const rows = Math.abs(header.height);
        const colors = [];
        if (header.bitCount <= 8)
        {
            const used = header.clrUsed || (1 << header.bitCount);
            const table = host.readMemory(info + header.size, used * 4);
            for (let index = 0; index < used; index++)
            {
                colors.push((table[index * 4] | table[index * 4 + 1] << 8
                    | table[index * 4 + 2] << 16) >>> 0);
            }
        }
        return { header, bits: host.readMemory(bits, stride * rows), colors };
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

    return {
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
         * int StretchDIBits(HDC hdc, int xDest, int yDest, int DestWidth, int DestHeight,
         *                   int xSrc, int ySrc, int SrcWidth, int SrcHeight,
         *                   const VOID *lpBits, const BITMAPINFO *lpbmi, UINT iUsage,
         *                   DWORD rop)
         *
         * The bits are read as the header describes them and the colour table
         * that follows it; a palette-relative table (DIB_PAL_COLORS) is not
         * decoded, which is reported as zero lines rather than drawn wrongly.
         */
        StretchDIBits: {
            argBytes: 52,
            /** @param {number[]} args */
            handler: ([dest, xDest, yDest, destWidth, destHeight, xSrc, ySrc, srcWidth,
                srcHeight, bits, info, usage, rop])=>{
                const interfaces = bound(dest);
                if (!interfaces || (bits >>> 0) === 0 || (info >>> 0) === 0
                    || (usage >>> 0) !== DIB_RGB_COLORS)
                {
                    return 0;
                }
                const image = readDib(info >>> 0, bits >>> 0);
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

        /** BOOL TextOutA(HDC hdc, int x, int y, LPCSTR lpString, int c) */
        TextOutA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, x, y, string, count])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const text = (string >>> 0) === 0
                    ? ''
                    : host.readCString(string, Math.max(count | 0, 0) || 0x10000)
                        .slice(0, Math.max(count | 0, 0) || undefined);
                interfaces.textOutA(handle >>> 0, x | 0, y | 0, text);
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
            handler: ([handle, x, y, options, rect, string, count, dx])=>{
                const interfaces = bound(handle);
                if (!interfaces)
                {
                    return 0;
                }
                const length = count >>> 0;
                const text = (string >>> 0) === 0 || length === 0
                    ? ''
                    : String.fromCharCode(...host.readMemory(string >>> 0, length));
                const advances = (dx >>> 0) === 0 || length === 0
                    ? undefined
                    : [...Array(length).keys()].map(index=>{
                        const bytes = host.readMemory((dx >>> 0) + index * 4, 4);
                        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16
                            | bytes[3] << 24) | 0;
                    });
                return interfaces.extTextOutA(handle >>> 0, x | 0, y | 0, options >>> 0,
                    (rect >>> 0) === 0 ? null : readRect(host, rect), text, advances) ? 1 : 0;
            },
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
         * int GetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT cLines,
         *   LPVOID lpvBits, LPBITMAPINFO lpbmi, UINT usage)
         *
         * A null lpvBits asks for the header to be filled in and nothing else,
         * which is how a program discovers a bitmap shape before allocating for
         * it. That path answers even when there is nothing to draw with, because
         * the shape is bookkeeping and the pixels are not.
         *
         * The pixels come from the device context, so the bitmap asked about has
         * to be the one selected into it. Any other bitmap has no surface this
         * layer can reach, and reporting rows that came from somewhere else
         * would be worse than reporting none.
         */
        GetDIBits: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, bitmap, start, lines, bits, info])=>{
                const record = objects.get(bitmap);
                const dc = dcOf(handle);
                if (!record || record.type !== 'bitmap' || !dc || (info >>> 0) === 0)
                {
                    return 0;
                }
                const shape = record.attributes;
                if ((bits >>> 0) === 0)
                {
                    writeU32s(host, info + BITMAPINFOHEADER.biSize,
                        [BITMAPINFOHEADER.SIZE, shape.width, shape.height]);
                    writeU16(host, info + BITMAPINFOHEADER.biPlanes, 1);
                    writeU16(host, info + BITMAPINFOHEADER.biBitCount, shape.bitCount);
                    writeU32s(host, info + BITMAPINFOHEADER.biCompression, [0, 0, 0, 0, 0, 0]);
                    return shape.height;
                }
                const interfaces = dc.bitmap === (bitmap >>> 0) ? bound(handle) : null;
                if (!interfaces)
                {
                    return 0;
                }
                const header = readBitmapInfoHeader(host, info);
                const wanted = Math.min(lines >>> 0, shape.height);
                const buffer = new Uint8Array(
                    (((header.width * header.bitCount + 31) / 32 | 0) * 4) * wanted);
                const written = interfaces.getDIBits(handle >>> 0, {
                    header,
                    bits: buffer,
                    startScan: start >>> 0,
                    scanLines: wanted,
                });
                host.writeMemory(bits >>> 0, buffer);
                return written;
            },
        },

        /**
         * BOOL GetCharABCWidthsA(HDC hdc, UINT wFirst, UINT wLast, LPABC lpABC)
         *
         * An estimate, and consistent with every other measurement this build
         * makes: the whole advance is the black box, with no bearing either
         * side. Real bearings need a rasterised glyph, and a program that lays
         * text out against these stays consistent with what is drawn, which is
         * what matters until there are real ones.
         */
        GetCharABCWidthsA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, first, last, out])=>{
                const dc = dcOf(handle);
                if (!dc || (out >>> 0) === 0 || (last >>> 0) < (first >>> 0))
                {
                    return 0;
                }
                const width = currentMetrics(dc).aveCharWidth;
                const count = (last >>> 0) - (first >>> 0) + 1;
                for (let index = 0; index < count; index++)
                {
                    writeU32s(host, (out >>> 0) + index * ABC_SIZE, [0, width, 0]);
                }
                return 1;
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
                    const surface = surfaceOf(dc);
                    setClip(handle, dc, {
                        left: 0, top: 0, right: surface.width, bottom: surface.height,
                    });
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
         *
         * A null buffer asks how large one would have to be, which is how a
         * program sizes its own before asking again.
         */
        GetObjectA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, size, out])=>{
                const record = objects.get(handle);
                if (!record)
                {
                    return 0;
                }
                const shape = describeObject(record);
                if (!shape)
                {
                    return 0;
                }
                if ((out >>> 0) === 0)
                {
                    return shape.size;
                }
                if ((size | 0) < shape.size)
                {
                    return 0;
                }
                writeU32s(host, out, shape.words);
                return shape.size;
            },
        },

        /**
         * HPALETTE CreateHalftonePalette(HDC hdc)
         *
         * Real, and empty. Every surface here is 32-bit, so a halftone palette
         * has nothing to hold -- but a program that gets a null handle back
         * treats it as an error, and this is not one.
         */
        CreateHalftonePalette: {
            argBytes: 4,
            handler: ()=>objects.create('palette', { entries: [] }),
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
         * UINT GetDIBColorTable(HDC hdc, UINT iStart, UINT cEntries,
         *                       RGBQUAD *prgbq)
         *
         * Zero entries copied, for the same reason: a colour table belongs to a
         * DIB of eight bits or fewer, and this pipeline has none.
         */
        GetDIBColorTable: {
            argBytes: 16,
            handler: ()=>0,
        },

        /**
         * UINT SetPaletteEntries(HPALETTE hpal, UINT iStart, UINT cEntries,
         *                       const PALETTEENTRY *pPalEntries)
         *
         * Bookkeeping, and honest as such: the entries are kept on the palette
         * object where GetPaletteEntries and a future realisation can read them
         * back. What they do not do is change any pixel, because every surface
         * here is 32-bit and has no palette to change.
         */
        SetPaletteEntries: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, start, count, entries])=>{
                const record = objects.get(handle);
                if (!record || record.type !== 'palette' || (entries >>> 0) === 0)
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
         * BOOL GetDeviceGammaRamp(HDC hdc, LPVOID lpRamp)
         *
         * The identity ramp, written out in full. A program that reads it,
         * adjusts it and writes it back must get something it can adjust, and
         * an untouched buffer would leave it multiplying by whatever was there.
         */
        GetDeviceGammaRamp: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, ramp])=>{
                if (!dcOf(handle) || (ramp >>> 0) === 0)
                {
                    return 0;
                }
                const bytes = new Uint8Array(GAMMA_RAMP_BYTES);
                const view = new DataView(bytes.buffer);
                for (let channel = 0; channel < 3; channel++)
                {
                    for (let index = 0; index < GAMMA_CHANNEL_ENTRIES; index++)
                    {
                        const at = (channel * GAMMA_CHANNEL_ENTRIES + index) * 2;
                        view.setUint16(at, index * 257, true);
                    }
                }
                host.writeMemory(ramp >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL SetDeviceGammaRamp(HDC hdc, LPVOID lpRamp)
         *
         * Accepted and discarded. Refusing would send a program down a fallback
         * path over a setting that changes no pixel it can observe here.
         */
        SetDeviceGammaRamp: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>(dcOf(handle) ? 1 : 0),
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
                if (!dcOf(handle) || !services.pixelFormat || (descriptor >>> 0) === 0)
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
                if (!dcOf(handle) || !services.pixelFormat)
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
                const dc = dcOf(handle);
                return dc ? dc.pixelFormat ?? 0 : 0;
            },
        },

        /**
         * BOOL SetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd)
         *
         * Set once. Setting the format already in effect succeeds and changes
         * nothing; setting a different one fails, which is what a program that
         * probes formats depends on.
         */
        SetPixelFormat: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, format])=>{
                const dc = dcOf(handle);
                if (!dc || !services.pixelFormat)
                {
                    return 0;
                }
                const wanted = format | 0;
                if (wanted < 1 || wanted > services.pixelFormat.count())
                {
                    return 0;
                }
                if ((dc.pixelFormat ?? 0) !== 0)
                {
                    return dc.pixelFormat === wanted ? 1 : 0;
                }
                dc.pixelFormat = wanted;
                return 1;
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
                if (!dcOf(handle) || !services.swapBuffers)
                {
                    return 0;
                }
                return services.swapBuffers(handle >>> 0) ? 1 : 0;
            },
        },
    };
}

/**
 * What GetObject reports for one object, as the words of its struct.
 *
 * Only the shapes a program reads back are here. An object whose struct is not
 * described answers zero rather than a buffer of the wrong length, because a
 * caller that trusted the length would read past its own allocation.
 *
 * @param {any} record
 * @returns {{ size: number, words: number[] } | null}
 */
function describeObject(record){
    const attributes = record.attributes ?? {};
    switch (record.type){
        // LOGPEN: style, POINT width, colour.
        case 'pen':
            return {
                size: 16,
                words: [
                    attributes.style | 0,
                    attributes.width | 0,
                    0,
                    attributes.color >>> 0,
                ],
            };
        // LOGBRUSH: style, colour, hatch.
        case 'brush':
            return {
                size: 12,
                words: [
                    attributes.style | 0,
                    attributes.color >>> 0,
                    attributes.hatch | 0,
                ],
            };
        // BITMAP: type, width, height, widthBytes, planes+bitsPixel, bits.
        case 'bitmap':
            return {
                size: 24,
                words: [
                    0,
                    attributes.width | 0,
                    attributes.height | 0,
                    attributes.pitch | 0,
                    (attributes.planes ?? 1) & 0xffff
                        | ((attributes.bitCount ?? 32) & 0xffff) << 16,
                    attributes.bits >>> 0,
                ],
            };
        default:
            return null;
    }
}
