/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * gdiplus -- GDI+'s flat API, the part a program reaches for to hold pixels:
 * starting it, its allocator, bitmaps over a buffer (the program's or its own),
 * locking their pixels, their size, format and palette, and cloning them.
 * A bitmap's pixels lie in guest memory, where LockBits hands them out.
 *
 * Decoding an image from a stream, a bitmap from a GDI one, and drawing are
 * not here: they answer NotImplemented, said once as a divergence, as from a
 * GDI+ whose codec or renderer failed - a program checks each Status.
 */

import { pointerWidth } from '../common/pointers.js';

/** GpStatus (gdiplustypes.h). */
const Ok = 0;
const InvalidParameter = 2;
const OutOfMemory = 3;
const NotImplemented = 6;
const WrongState = 8;
const UnsupportedGdiplusVersion = 17;

/** ImageLockMode's flag: the caller hands its own buffer (UserInputBuf), not taken here. */
const IMAGE_LOCK_USER_INPUT_BUF = 0x4;

/** ColorPalette's header: Flags and Count, before its entries. */
const PALETTE_HEADER = 8;

/** Handles of their own, as pointers would be: never zero, never a guest address used. */
const HANDLE_BASE = 0x5e000000;
const HANDLE_STRIDE = 16;

/**
 * A pixel format's bits per pixel, from its value (gdipluspixelformats.h: bits 8-15),
 * for the formats with whole bytes per pixel and no palette; zero for any other.
 *
 * @param {number} format
 */
const bytesPerPixel = format=>{
    const bits = format >>> 8 & 0xff;
    const indexed = (format & 0x10000) !== 0;
    return indexed || bits % 8 !== 0 ? 0 : bits / 8;
};

/**
 * @typedef {Object} GdiplusHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(bytes: number) => number} allocate  zero when none is left
 * @property {(address: number) => void} free
 * @property {4 | 8} [pointerSize]
 * @property {(api: string, detail: string, kind?: string) => void} [divergence]
 */

/** @param {GdiplusHost} host */
export function createGdiplusFunctions(host){
    const pointer = pointerWidth(host.pointerSize ?? 4);
    /** BitmapData: Width, Height, Stride, PixelFormat, then Scan0 and Reserved, pointers. */
    const BITMAP_DATA_SCAN0 = 16;
    /**
     * Each bitmap: its size, format and pixels' place; whether that memory is its own
     * to free; the rectangle locked now, if one is.
     *
     * @type {Map<number, { width: number, height: number, stride: number, format: number,
     *     scan0: number, owned: boolean, locked: boolean }>}
     */
    const bitmaps = new Map();
    /** @type {Map<number, { interpolation: number }>} */
    const graphics = new Map();
    /** The divergences said: each once. @type {Set<string>} */
    const said = new Set();
    let next = HANDLE_BASE;
    const handle = ()=>{
        const made = next;
        next += HANDLE_STRIDE;
        return made;
    };
    /** @param {number} address @param {number} value */
    const putU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} address @param {number} value */
    const putPointer = (address, value)=>host.writeMemory(address >>> 0, pointer.bytes(value));
    /** @param {string} api @param {string} detail */
    const notImplemented = (api, detail)=>{
        if (!said.has(api))
        {
            said.add(api);
            host.divergence?.(api, detail);
        }
        return NotImplemented;
    };
    /**
     * A bitmap of `format`, its pixels over `scan0` or in memory of its own; its
     * handle written to `out`. The status, and the bitmap when it was made.
     *
     * @param {number} width @param {number} height @param {number} stride
     * @param {number} format @param {number} scan0 @param {number} out
     * @returns {{ status: number, made?: number }}
     */
    const makeBitmap = (width, height, stride, format, scan0, out)=>{
        const size = bytesPerPixel(format);
        if ((out >>> 0) === 0 || width <= 0 || height <= 0 || size === 0)
        {
            return { status: InvalidParameter };
        }
        let place = scan0 >>> 0;
        let rowBytes = stride | 0;
        if (place === 0)
        {
            rowBytes = Math.ceil(width * size / 4) * 4;
            place = host.allocate(rowBytes * height);
            if (place === 0)
            {
                return { status: OutOfMemory };
            }
            host.writeMemory(place, new Uint8Array(rowBytes * height));
        }
        else if (rowBytes === 0 || Math.abs(rowBytes) < width * size)
        {
            return { status: InvalidParameter };
        }
        const made = handle();
        bitmaps.set(made, { width, height, stride: rowBytes, format, scan0: place,
            owned: (scan0 >>> 0) === 0, locked: false });
        putPointer(out, made);
        return { status: Ok, made };
    };

    return {
        /**
         * Status GdiplusStartup(ULONG_PTR *token, const GdiplusStartupInput *input,
         *   GdiplusStartupOutput *output)
         *
         * Versions 1 to 3 start; another is UnsupportedGdiplusVersion. There is no
         * background thread to hand hooks for: an output is left with none.
         */
        GdiplusStartup: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([token, input, output])=>{
                if ((token >>> 0) === 0 || (input >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const version = new DataView(host.readMemory(input >>> 0, 4).slice().buffer)
                    .getUint32(0, true);
                if (version < 1 || version > 3)
                {
                    return UnsupportedGdiplusVersion;
                }
                putPointer(token, handle());
                if ((output >>> 0) !== 0)
                {
                    host.writeMemory(output >>> 0, new Uint8Array(pointer.size * 2));
                }
                return Ok;
            },
        },

        /** void GdiplusShutdown(ULONG_PTR token) */
        GdiplusShutdown: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** void *GdipAlloc(size_t size): memory GdipFree gives back, zero when none is left. */
        GdipAlloc: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([size])=>host.allocate(Math.max(1, size >>> 0)),
        },

        /** void GdipFree(void *ptr) */
        GdipFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                if ((address >>> 0) !== 0)
                {
                    host.free(address >>> 0);
                }
                return 0;
            },
        },

        /**
         * Status GdipCreateBitmapFromScan0(INT width, INT height, INT stride,
         *   PixelFormat format, BYTE *scan0, GpBitmap **bitmap)
         *
         * Over the caller's pixels, which the bitmap keeps using, or over pixels of
         * its own (zeroed, rows a multiple of four bytes) when there are none.
         */
        GdipCreateBitmapFromScan0: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([width, height, stride, format, scan0, out])=>
                makeBitmap(width | 0, height | 0, stride, format >>> 0, scan0, out).status,
        },

        /** Status GdipCreateBitmapFromHBITMAP(HBITMAP hbm, HPALETTE hpal, GpBitmap **bitmap) */
        GdipCreateBitmapFromHBITMAP: {
            argBytes: 12,
            handler: ()=>notImplemented('GdipCreateBitmapFromHBITMAP',
                'a bitmap from a GDI bitmap is not made'),
        },

        /** Status GdipCreateBitmapFromStream(IStream *stream, GpBitmap **bitmap) */
        GdipCreateBitmapFromStream: {
            argBytes: 8,
            handler: ()=>notImplemented('GdipCreateBitmapFromStream',
                'no codec decodes an image from a stream'),
        },

        /** Status GdipCloneImage(GpImage *image, GpImage **clone): its pixels in its own memory. */
        GdipCloneImage: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([image, out])=>{
                const held = bitmaps.get(image >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const { status, made } = makeBitmap(held.width, held.height, 0, held.format, 0,
                    out);
                const copy = made === undefined ? undefined : bitmaps.get(made);
                if (!copy)
                {
                    return status;
                }
                const row = held.width * bytesPerPixel(held.format);
                for (let y = 0; y < held.height; y++)
                {
                    host.writeMemory(copy.scan0 + y * copy.stride,
                        host.readMemory(held.scan0 + y * held.stride, row).slice());
                }
                return Ok;
            },
        },

        /** Status GdipDisposeImage(GpImage *image) */
        GdipDisposeImage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([image])=>{
                const held = bitmaps.get(image >>> 0);
                if (!held)
                {
                    return InvalidParameter;
                }
                if (held.owned)
                {
                    host.free(held.scan0);
                }
                bitmaps.delete(image >>> 0);
                return Ok;
            },
        },

        /** Status GdipGetImageWidth(GpImage *image, UINT *width) */
        GdipGetImageWidth: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([image, out])=>{
                const held = bitmaps.get(image >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, held.width);
                return Ok;
            },
        },

        /** Status GdipGetImageHeight(GpImage *image, UINT *height) */
        GdipGetImageHeight: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([image, out])=>{
                const held = bitmaps.get(image >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, held.height);
                return Ok;
            },
        },

        /** Status GdipGetImagePixelFormat(GpImage *image, PixelFormat *format) */
        GdipGetImagePixelFormat: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([image, out])=>{
                const held = bitmaps.get(image >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, held.format);
                return Ok;
            },
        },

        /**
         * Status GdipGetImagePaletteSize(GpImage *image, INT *size)
         *
         * A ColorPalette's bytes: these formats have no palette, so its header alone.
         */
        GdipGetImagePaletteSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([image, out])=>{
                if (!bitmaps.has(image >>> 0) || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, PALETTE_HEADER);
                return Ok;
            },
        },

        /** Status GdipGetImagePalette(GpImage *image, ColorPalette *palette, INT size) */
        GdipGetImagePalette: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([image, palette, size])=>{
                if (!bitmaps.has(image >>> 0) || (palette >>> 0) === 0
                    || (size | 0) < PALETTE_HEADER)
                {
                    return InvalidParameter;
                }
                host.writeMemory(palette >>> 0, new Uint8Array(PALETTE_HEADER));
                return Ok;
            },
        },

        /**
         * Status GdipBitmapLockBits(GpBitmap *bitmap, const GpRect *rect, UINT flags,
         *   PixelFormat format, BitmapData *data)
         *
         * The bitmap's own pixels, in place: a rectangle inside it (all of it with
         * none), in its own format. Another format, or the caller's buffer, is
         * NotImplemented; a bitmap already locked is WrongState.
         */
        GdipBitmapLockBits: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([bitmap, rect, flags, format, data])=>{
                const held = bitmaps.get(bitmap >>> 0);
                if (!held || (data >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                if (held.locked)
                {
                    return WrongState;
                }
                let [x, y, width, height] = [0, 0, held.width, held.height];
                if ((rect >>> 0) !== 0)
                {
                    const view = new DataView(host.readMemory(rect >>> 0, 16).slice().buffer);
                    [x, y, width, height] = [0, 4, 8, 12].map(at=>view.getInt32(at, true));
                }
                if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > held.width
                    || y + height > held.height)
                {
                    return InvalidParameter;
                }
                if ((format >>> 0) !== held.format || (flags & IMAGE_LOCK_USER_INPUT_BUF) !== 0)
                {
                    return notImplemented('GdipBitmapLockBits',
                        'a lock in another pixel format, or into the caller\'s buffer');
                }
                const record = new Uint8Array(BITMAP_DATA_SCAN0 + pointer.size * 2);
                const view = new DataView(record.buffer);
                view.setUint32(0, width, true);
                view.setUint32(4, height, true);
                view.setInt32(8, held.stride, true);
                view.setUint32(12, held.format, true);
                pointer.set(view, BITMAP_DATA_SCAN0,
                    held.scan0 + y * held.stride + x * bytesPerPixel(held.format));
                host.writeMemory(data >>> 0, record);
                held.locked = true;
                return Ok;
            },
        },

        /** Status GdipBitmapUnlockBits(GpBitmap *bitmap, BitmapData *data) */
        GdipBitmapUnlockBits: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([bitmap, data])=>{
                const held = bitmaps.get(bitmap >>> 0);
                if (!held || (data >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                if (!held.locked)
                {
                    return WrongState;
                }
                held.locked = false;
                return Ok;
            },
        },

        /** Status GdipCreateFromHDC(HDC hdc, GpGraphics **graphics) */
        GdipCreateFromHDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, out])=>{
                if ((hdc >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return OutOfMemory;
                }
                const made = handle();
                graphics.set(made, { interpolation: 0 });
                putPointer(out, made);
                return Ok;
            },
        },

        /** Status GdipGetImageGraphicsContext(GpImage *image, GpGraphics **graphics) */
        GdipGetImageGraphicsContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([image, out])=>{
                if (!bitmaps.has(image >>> 0) || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const made = handle();
                graphics.set(made, { interpolation: 0 });
                putPointer(out, made);
                return Ok;
            },
        },

        /** Status GdipDeleteGraphics(GpGraphics *graphics) */
        GdipDeleteGraphics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([target])=>(graphics.delete(target >>> 0) ? Ok : InvalidParameter),
        },

        /** Status GdipSetInterpolationMode(GpGraphics *graphics, InterpolationMode mode) */
        GdipSetInterpolationMode: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([target, mode])=>{
                const held = graphics.get(target >>> 0);
                // InterpolationModeInvalid (-1) and anything past HighQualityBicubic (7).
                if (!held || (mode | 0) < 0 || (mode | 0) > 7)
                {
                    return InvalidParameter;
                }
                held.interpolation = mode | 0;
                return Ok;
            },
        },

        /** Status GdipDrawImageI(GpGraphics *graphics, GpImage *image, INT x, INT y) */
        GdipDrawImageI: {
            argBytes: 16,
            handler: ()=>notImplemented('GdipDrawImageI', 'nothing is drawn through GDI+'),
        },

        /**
         * Status GdipDrawImageRectI(GpGraphics *graphics, GpImage *image, INT x, INT y,
         *   INT width, INT height)
         */
        GdipDrawImageRectI: {
            argBytes: 24,
            handler: ()=>notImplemented('GdipDrawImageRectI', 'nothing is drawn through GDI+'),
        },
    };
}
