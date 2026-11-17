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
 * An image file is decoded by the codecs Windows' imaging component has
 * (`windowscodecs/frames.js`), into 32bpp ARGB as GDI+ holds a decoded image,
 * and a bitmap is handed to GDI as a DIB section. Decoding from a stream, a
 * bitmap from a GDI one, and drawing are not here: they answer
 * NotImplemented, said once as a divergence, as from a GDI+ whose codec or
 * renderer failed - a program checks each Status. Its fonts are `fonts.js`'s.
 */

import { pointerWidth } from '../common/pointers.js';
import { CodecError, sniff } from '../windowscodecs/frames.js';
import { convertRow, formatOf, rowBytes as wicRowBytes } from '../windowscodecs/formats.js';
import { createFontFunctions } from './fonts.js';
import { createKit } from './kit.js';
import { createMatrixFunctions } from './matrix.js';
import { createPathFunctions } from './path.js';
import { createBrushFunctions } from './brush.js';
import { createPenFunctions } from './pen.js';
import { createPathIteratorFunctions } from './pathiterator.js';

/** GpStatus (gdiplustypes.h). */
const Ok = 0;
const InvalidParameter = 2;
const OutOfMemory = 3;
const NotImplemented = 6;
const GenericError = 1;
const FileNotFound = 10;
const UnknownImageFormat = 13;

/** PixelFormat32bppARGB: what a decoded image of colour is held as. */
const PIXEL_FORMAT_32BPP_ARGB = 0x26200a;
/** GUID_WICPixelFormat32bppBGRA: the same bytes, B, G, R, A. */
const WIC_32BPP_BGRA = '{6FDDC324-4E03-4BFE-B185-3D77768DC90F}';
const WrongState = 8;
const UnsupportedGdiplusVersion = 17;

/** ImageLockMode's flag: the caller hands its own buffer (UserInputBuf), not taken here. */
const IMAGE_LOCK_USER_INPUT_BUF = 0x4;

/** ColorPalette's header: Flags and Count, before its entries. */
const PALETTE_HEADER = 8;


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
 * @property {(address: number) => string} [readWideString]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 *     a file of the volume, whole; null for none
 * @property {(name: string, args: number[]) => number} [gdi32]  a GDI32 export, called
 * @property {(name: string) => Promise<number> | number} [procAddress]  where an export of
 *     this library is, for a pointer to it handed out
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
    // One table of handles for every family: a handle names one object.
    const kit = createKit(host);
    const handle = kit.handle;
    const matrices = createMatrixFunctions(kit);
    const paths = createPathFunctions(kit, matrices);
    /** A copy of a bitmap in memory of its own, its handle; 0 for none. @param {number} image */
    const cloneImage = image=>{
        const held = bitmaps.get(image >>> 0);
        if (!held)
        {
            return 0;
        }
        const scratch = host.allocate(pointer.size);
        if (scratch === 0)
        {
            return 0;
        }
        try
        {
            const { made } = makeBitmap(held.width, held.height, 0, held.format, 0, scratch);
            const copy = made === undefined ? undefined : bitmaps.get(made);
            if (!copy || made === undefined)
            {
                return 0;
            }
            const row = held.width * bytesPerPixel(held.format);
            for (let y = 0; y < held.height; y++)
            {
                host.writeMemory(copy.scan0 + y * copy.stride,
                    host.readMemory(held.scan0 + y * held.stride, row).slice());
            }
            return made;
        }
        finally
        {
            host.free(scratch);
        }
    };
    const images = {
        clone: cloneImage,
        /** @param {number} image */
        size: image=>{
            const held = bitmaps.get(image >>> 0);
            return held ? { width: held.width, height: held.height } : null;
        },
    };
    const brushes = createBrushFunctions(kit, { matrices, paths, images });
    const pens = createPenFunctions(kit, { matrices, paths, brushes });
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
        ...matrices.functions,
        ...paths.functions,
        ...brushes.functions,
        ...pens.functions,
        ...createPathIteratorFunctions(kit, paths).functions,
        ...createFontFunctions({ host, handle, putPointer,
            isGraphics: target=>graphics.has(target) }),

        /**
         * Status GdiplusStartup(ULONG_PTR *token, const GdiplusStartupInput *input,
         *   GdiplusStartupOutput *output)
         *
         * Versions 1 and 2 start (GDI+ 1.0 and 1.1); another is
         * UnsupportedGdiplusVersion. A caller that suppressed the background
         * thread is handed the hook and unhook it must call itself in the
         * output, as GDI+ hands them - the library's own GdiplusNotificationHook
         * and GdiplusNotificationUnhook - and must call: left null, its first
         * call went to address zero.
         */
        GdiplusStartup: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([token, input, output])=>{
                if ((token >>> 0) === 0 || (input >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                // GdiplusStartupInput: the version, the debug callback, then
                // SuppressBackgroundThread.
                const fields = new DataView(host.readMemory(input >>> 0, pointer.size * 2 + 4)
                    .slice().buffer);
                const version = fields.getUint32(0, true);
                if (version < 1 || version > 2)
                {
                    return UnsupportedGdiplusVersion;
                }
                putPointer(token, handle());
                if ((output >>> 0) !== 0)
                {
                    const suppressed = fields.getUint32(pointer.size * 2, true) !== 0;
                    const hook = suppressed
                        ? await host.procAddress?.('GdiplusNotificationHook') ?? 0 : 0;
                    const unhook = suppressed
                        ? await host.procAddress?.('GdiplusNotificationUnhook') ?? 0 : 0;
                    putPointer(output, hook);
                    putPointer((output >>> 0) + pointer.size, unhook);
                }
                return Ok;
            },
        },

        /**
         * Status GdiplusNotificationHook(ULONG_PTR *token): the work the background
         * thread would do on the caller's message loop. There is none here; a
         * token for the unhook.
         */
        GdiplusNotificationHook: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([token])=>{
                if ((token >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putPointer(token, handle());
                return Ok;
            },
        },

        /** void GdiplusNotificationUnhook(ULONG_PTR token) */
        GdiplusNotificationUnhook: {
            argBytes: 4,
            handler: ()=>0,
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

        /**
         * Status GdipCreateBitmapFromFile(const WCHAR *filename, GpBitmap **bitmap)
         *
         * The file's first image, decoded by the codec its first bytes name,
         * as a bitmap of 32bpp ARGB in memory of its own. A file not there is
         * FileNotFound; one no codec reads, UnknownImageFormat.
         */
        GdipCreateBitmapFromFile: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([name, out])=>{
                if ((name >>> 0) === 0 || (out >>> 0) === 0 || !host.readWideString
                    || !host.readFile)
                {
                    return InvalidParameter;
                }
                const bytes = await host.readFile(host.readWideString(name >>> 0));
                if (!bytes)
                {
                    return FileNotFound;
                }
                const decode = sniff(bytes)?.decode;
                /** @type {import('../windowscodecs/frames.js').DecodedFrame | undefined} */
                let frame;
                try
                {
                    frame = decode?.(bytes).frames[0];
                }
                catch (e){
                    if (!(e instanceof CodecError))
                    {
                        throw e;
                    }
                }
                if (!frame)
                {
                    return UnknownImageFormat;
                }
                const argb = /** @type {import('../windowscodecs/formats.js').PixelFormat} */ (
                    formatOf(WIC_32BPP_BGRA));
                const { status, made } = makeBitmap(frame.width, frame.height, 0,
                    PIXEL_FORMAT_32BPP_ARGB, 0, out);
                const held = made === undefined ? undefined : bitmaps.get(made);
                if (!held)
                {
                    return status;
                }
                const from = wicRowBytes(frame.format, frame.width);
                for (let y = 0; y < frame.height; y++)
                {
                    host.writeMemory(held.scan0 + y * held.stride, convertRow(frame.format, argb,
                        frame.pixels.subarray(y * from, (y + 1) * from), frame.width,
                        frame.palette, null));
                }
                return Ok;
            },
        },

        /**
         * Status GdipCreateHBITMAPFromBitmap(GpBitmap *bitmap, HBITMAP *hbm, ARGB background)
         *
         * A 32-bit DIB section of the bitmap's pixels, each laid over the
         * background colour by its alpha, as GDI+ hands one to GDI. A bitmap of
         * a format other than 32bpp ARGB is refused, said once.
         */
        GdipCreateHBITMAPFromBitmap: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([image, out, background])=>{
                const held = bitmaps.get(image >>> 0);
                if (!held || (out >>> 0) === 0 || !host.gdi32)
                {
                    return InvalidParameter;
                }
                if (held.format !== PIXEL_FORMAT_32BPP_ARGB)
                {
                    return notImplemented('GdipCreateHBITMAPFromBitmap',
                        'only a bitmap of 32bpp ARGB is handed to GDI');
                }
                const { width, height } = held;
                // BITMAPINFOHEADER, top-down, then the slot the bits' address lands in.
                const info = host.allocate(44);
                if (info === 0)
                {
                    return OutOfMemory;
                }
                try
                {
                    const header = new DataView(new ArrayBuffer(40));
                    header.setUint32(0, 40, true);
                    header.setInt32(4, width, true);
                    header.setInt32(8, -height, true);
                    header.setUint16(12, 1, true);
                    header.setUint16(14, 32, true);
                    host.writeMemory(info, new Uint8Array(header.buffer));
                    const section = host.gdi32('CreateDIBSection', [0, info, 0, info + 40, 0, 0])
                        >>> 0;
                    if (section === 0)
                    {
                        return GenericError;
                    }
                    const bits = new DataView(host.readMemory(info + 40, 4).slice().buffer)
                        .getUint32(0, true);
                    const back = [background & 0xff, background >>> 8 & 0xff,
                        background >>> 16 & 0xff];
                    for (let y = 0; y < height; y++)
                    {
                        const row = host.readMemory(held.scan0 + y * held.stride, width * 4)
                            .slice();
                        for (let x = 0; x < width * 4; x += 4)
                        {
                            const alpha = row[x + 3];
                            for (let c = 0; c < 3; c++)
                            {
                                row[x + c] = Math.round((row[x + c] * alpha
                                    + back[c] * (255 - alpha)) / 255);
                            }
                            row[x + 3] = 255;
                        }
                        host.writeMemory(bits + y * width * 4, row);
                    }
                    putU32(out, section);
                    return Ok;
                }
                finally
                {
                    host.free(info);
                }
            },
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

        /**
         * Status GdipCreateFromHWND(HWND hwnd, GpGraphics **graphics)
         *
         * A window's graphics, as a DC's are: what WinForms makes for a
         * control (Control.CreateGraphics), NULL being the screen's.
         */
        GdipCreateFromHWND: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if ((out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const made = handle();
                graphics.set(made, { interpolation: 0 });
                putPointer(out, made);
                return Ok;
            },
        },

        /**
         * HPALETTE GdipCreateHalftonePalette(void)
         *
         * GDI's halftone palette, which WinForms selects into a DC at every
         * WM_PAINT of a control (Control.SetUpPalette); the caller owns it.
         */
        GdipCreateHalftonePalette: {
            argBytes: 0,
            handler: ()=>(host.gdi32 ? host.gdi32('CreateHalftonePalette', [0]) >>> 0 : 0),
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
