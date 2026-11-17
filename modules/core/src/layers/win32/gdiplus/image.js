/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s images: bitmaps over guest memory, the program's or their own, in
 * any of GDI+'s pixel formats, with a palette, a resolution, property items
 * and - for an image decoded from a file or a stream - its frames.
 *
 * A bitmap's pixels lie in guest memory, where LockBits hands them out in
 * place or converted into a buffer that is written back on unlock. Every
 * conversion is Windows' imaging component's (`windowscodecs/formats.js`):
 * a GDI+ format is the WIC format of the same bytes. A file or stream is
 * decoded by the codec its first bytes name (`windowscodecs/frames.js`),
 * keeping its depth where GDI+ has a format of it, else as 32bpp ARGB.
 * Bitmaps reach GDI as DIB sections and come from GDI bitmaps, DIBs and
 * icons through gdi32 and user32. Encoding is `codecs.js`'s.
 */

import { convertRow, FORMATS } from '../windowscodecs/formats.js';
import { CodecError, sniff } from '../windowscodecs/frames.js';
import { medianCut, predefinedPalette } from '../windowscodecs/palettes.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';
import { Status, fn } from './kit.js';
import {
    IMAGE_FORMAT, codecInfos, decoders, encodeBmp, encodePng, encoders,
    formatOfContainer, gifTiming,
} from './codecs.js';

/** PixelFormat (gdipluspixelformats.h). */
export const PixelFormat = Object.freeze({
    Indexed1: 0x30101, Indexed4: 0x30402, Indexed8: 0x30803, Gray16: 0x101004,
    RGB555: 0x21005, RGB565: 0x21006, ARGB1555: 0x61007, RGB24: 0x21808, RGB32: 0x22009,
    ARGB32: 0x26200a, PARGB32: 0xe200b, RGB48: 0x10300c, ARGB64: 0x34400d, PARGB64: 0x1a400e,
    CMYK32: 0x200f,
});

/** Each GDI+ format: the WIC format of its bytes. */
/** @type {Map<number, string>} */
const WIC_NAME = new Map([
    [PixelFormat.Indexed1, '1bppIndexed'], [PixelFormat.Indexed4, '4bppIndexed'],
    [PixelFormat.Indexed8, '8bppIndexed'], [PixelFormat.Gray16, '16bppGray'],
    [PixelFormat.RGB555, '16bppBGR555'], [PixelFormat.RGB565, '16bppBGR565'],
    [PixelFormat.ARGB1555, '16bppBGRA5551'], [PixelFormat.RGB24, '24bppBGR'],
    [PixelFormat.RGB32, '32bppBGR'], [PixelFormat.ARGB32, '32bppBGRA'],
    [PixelFormat.PARGB32, '32bppPBGRA'], [PixelFormat.RGB48, '48bppBGR'],
    [PixelFormat.ARGB64, '64bppBGRA'], [PixelFormat.PARGB64, '64bppPBGRA'],
    [PixelFormat.CMYK32, '32bppCMYK'],
]);
/** @param {string} name */
const wic = name=>/** @type {import('../windowscodecs/formats.js').PixelFormat} */ (
    FORMATS.find(f=>f.name === name));
const BGRA = wic('32bppBGRA');
/** A decoded frame's WIC format: the GDI+ format of the same bytes, if there is one. */
const GDIP_OF_WIC = new Map([...WIC_NAME].map(([gdip, name])=>[name, gdip]));

/** @param {number} format */
const wicOf = format=>{
    const name = WIC_NAME.get(format);
    return name ? wic(name) : null;
};
const isIndexed = (/** @type {number} */ format)=>(format & 0x10000) !== 0;
const bitsOf = (/** @type {number} */ format)=>format >>> 8 & 0xff;
const hasAlpha = (/** @type {number} */ format)=>(format & 0xc0000) !== 0;

/** PaletteFlags. */
const PaletteFlagsGrayScale = 2;
const PaletteFlagsHalftone = 4;

/** ImageLockMode. */
const ImageLockModeRead = 1;
const ImageLockModeWrite = 2;
const ImageLockModeUserInputBuf = 4;

/** ImageFlags. */
const ImageFlagsHasAlpha = 2;
const ImageFlagsColorSpaceRGB = 0x10;
const ImageFlagsHasRealDPI = 0x1000;
const ImageFlagsHasRealPixelSize = 0x2000;
const ImageFlagsReadOnly = 0x10000;

/** FrameDimension GUIDs. */
const FrameDimensionTime = '{6AEDBD6D-3FB5-418A-83A6-7F45229DC872}';
const FrameDimensionPage = '{7462DC86-6180-4C7E-8E3F-EE7333A7A483}';

/** PropertyTag ids and types GDI+ reports for a GIF animation. */
const PropertyTagFrameDelay = 0x5100;
const PropertyTagLoopCount = 0x5101;
const PropertyTagTypeShort = 3;
const PropertyTagTypeLong = 4;

/** UnitPixel. */
const UnitPixel = 2;

/**
 * The palette GDI+ gives a new bitmap of an indexed format: black and
 * white; the sixteen VGA colours; or its 256-entry halftone - those
 * sixteen, 24 empty entries, then the 6x6x6 cube, blue fastest.
 *
 * @param {number} format
 * @returns {{ flags: number, entries: number[] }}
 */
const defaultPalette = format=>{
    const halftone = Array.from({ length: 256 }, (_, i)=>{
        if (i < 8)
        {
            return (0xff000000 | (i & 1 ? 0x800000 : 0) | (i & 2 ? 0x8000 : 0)
                | (i & 4 ? 0x80 : 0)) >>> 0;
        }
        if (i === 8)
        {
            return 0xffc0c0c0;
        }
        if (i < 16)
        {
            return (0xff000000 | (i & 1 ? 0xff0000 : 0) | (i & 2 ? 0xff00 : 0)
                | (i & 4 ? 0xff : 0)) >>> 0;
        }
        if (i < 40)
        {
            return 0;
        }
        const level = [0, 0x33, 0x66, 0x99, 0xcc, 0xff];
        const n = i - 40;
        return (0xff000000 | level[Math.floor(n / 36) % 6] << 16 | level[Math.floor(n / 6) % 6] << 8
            | level[n % 6]) >>> 0;
    });
    switch (format)
    {
        case PixelFormat.Indexed1: return { flags: PaletteFlagsGrayScale,
            entries: [0xff000000, 0xffffffff] };
        case PixelFormat.Indexed4: return { flags: 0, entries: halftone.slice(0, 16) };
        case PixelFormat.Indexed8: return { flags: PaletteFlagsHalftone, entries: halftone };
        default: return { flags: 0, entries: [] };
    }
};

/**
 * @typedef {Object} Lock
 * @property {number} x @property {number} y @property {number} width @property {number} height
 * @property {number} flags @property {number} format
 * @property {number} buffer  where the caller's pixels are
 * @property {number} stride
 * @property {boolean} inPlace  the bitmap's own pixels, nothing to write back
 * @property {boolean} owned  a buffer of ours, freed on unlock
 */

/**
 * @typedef {Object} Bitmap
 * @property {'bitmap'} type
 * @property {number} width @property {number} height @property {number} format
 * @property {number} stride @property {number} scan0
 * @property {boolean} owned  whether its pixels are its own memory, freed with it
 * @property {Lock | null} lock
 * @property {{ flags: number, entries: number[] }} palette
 * @property {number} dpiX @property {number} dpiY
 * @property {string} raw  its ImageFormat GUID
 * @property {number} flags  ImageFlags beyond what its format says
 * @property {{ frames: import('../windowscodecs/frames.js').DecodedFrame[],
 *     dimension: string, active: number } | null} decoded
 * @property {Map<number, { type: number, value: Uint8Array }>} properties
 */

/**
 * @typedef {Object} ImageHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(bytes: number) => number} allocate  zero when none is left
 * @property {(address: number) => void} free
 * @property {(address: number) => string} [readWideString]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 * @property {(path: string, bytes: Uint8Array) => boolean} [writeFile]
 * @property {(name: string, args: number[]) => number} [gdi32]
 * @property {(name: string, args: number[]) => number} [user32]
 * @property {{ read: (stream: number) => Promise<Uint8Array | null>,
 *     write: (stream: number, bytes: Uint8Array) => Promise<number> }} [streams]
 */

/**
 * @param {import('./kit.js').Kit} kit @param {ImageHost} host
 */
export function createImageFunctions(kit, host){
    const { Ok, InvalidParameter, OutOfMemory, GenericError, WrongState, FileNotFound,
        UnknownImageFormat, PropertyNotFound, NotImplemented, Win32Error } = Status;
    const pointer = kit.pointer.size;
    /** @param {number} at @returns {Bitmap | undefined} */
    const get = at=>kit.get(at, 'image');
    /** @param {Bitmap} image @param {number} y */
    const rowAt = (image, y)=>image.scan0 + y * image.stride;
    /** @param {Bitmap} image */
    const rowLength = image=>Math.ceil(image.width * bitsOf(image.format) / 8);

    /**
     * Memory of `bytes`, zeroed; 0 when none is left.
     *
     * @param {number} bytes
     */
    const allocate = bytes=>{
        const at = host.allocate(Math.max(1, bytes));
        if (at !== 0)
        {
            host.writeMemory(at, new Uint8Array(bytes));
        }
        return at;
    };

    /**
     * A bitmap of `format`, its pixels over `scan0` or zeroed memory of its
     * own; null when no memory was left.
     *
     * @param {number} width @param {number} height @param {number} format
     * @param {number} [stride] @param {number} [scan0]
     * @returns {Bitmap | null}
     */
    const makeBitmap = (width, height, format, stride = 0, scan0 = 0)=>{
        let place = scan0 >>> 0;
        let rowBytes = stride | 0;
        if (place === 0)
        {
            rowBytes = Math.ceil(width * bitsOf(format) / 32) * 4;
            place = allocate(rowBytes * height);
            if (place === 0)
            {
                return null;
            }
        }
        return { type: 'bitmap', width, height, format, stride: rowBytes, scan0: place,
            owned: (scan0 >>> 0) === 0, lock: null, palette: defaultPalette(format), dpiX: 96,
            dpiY: 96, raw: IMAGE_FORMAT.MemoryBMP, flags: 0, decoded: null,
            properties: new Map() };
    };

    /**
     * A rectangle of the bitmap's pixels as BGRA, straight alpha.
     *
     * @param {Bitmap} image @param {number} x @param {number} y
     * @param {number} width @param {number} height
     */
    const readBgra = (image, x, y, width, height)=>{
        const out = new Uint8Array(width * height * 4);
        const from = /** @type {NonNullable<ReturnType<typeof wicOf>>} */ (wicOf(image.format));
        for (let row = 0; row < height; row++)
        {
            const bytes = host.readMemory(rowAt(image, y + row), rowLength(image)).slice();
            const bgra = convertRow(from, BGRA, bytes, image.width, image.palette.entries, null);
            out.set(bgra.subarray(x * 4, (x + width) * 4), row * width * 4);
        }
        return out;
    };

    /**
     * BGRA pixels, straight alpha, into a rectangle of the bitmap: only those
     * pixels are changed, an indexed one to its palette's nearest colour.
     *
     * @param {Bitmap} image @param {number} x @param {number} y
     * @param {number} width @param {number} height @param {Uint8Array} bgra
     */
    const writeBgra = (image, x, y, width, height, bgra)=>{
        const to = /** @type {NonNullable<ReturnType<typeof wicOf>>} */ (wicOf(image.format));
        const bits = bitsOf(image.format);
        for (let row = 0; row < height; row++)
        {
            const piece = convertRow(BGRA, to, bgra.subarray(row * width * 4,
                (row + 1) * width * 4), width, null, image.palette.entries);
            const at = rowAt(image, y + row);
            if (bits % 8 === 0)
            {
                host.writeMemory(at + x * bits / 8, piece.subarray(0, width * bits / 8));
                continue;
            }
            const bytes = host.readMemory(at, rowLength(image)).slice();
            const mask = (1 << bits) - 1;
            for (let i = 0; i < width; i++)
            {
                const value = piece[i * bits >> 3] >> (8 - bits - (i * bits & 7)) & mask;
                const bit = (x + i) * bits;
                const shift = 8 - bits - (bit & 7);
                bytes[bit >> 3] = bytes[bit >> 3] & ~(mask << shift) | value << shift;
            }
            host.writeMemory(at, bytes);
        }
    };

    /**
     * Rows of one format in another, `width` pixels from column `x`.
     *
     * @param {Bitmap} image @param {number} format  the other
     * @param {Uint8Array} bytes  a whole row of the image's format
     * @param {number} x @param {number} width
     */
    const rowIn = (image, format, bytes, x, width)=>{
        const bgra = convertRow(/** @type {any} */ (wicOf(image.format)), BGRA, bytes,
            image.width, image.palette.entries, null).subarray(x * 4, (x + width) * 4);
        return convertRow(BGRA, /** @type {any} */ (wicOf(format)), bgra, width, null,
            image.palette.entries);
    };

    /**
     * A bitmap made from a decoded frame, keeping its format where GDI+ has
     * one of the same bytes.
     *
     * @param {import('../windowscodecs/frames.js').DecodedFrame} frame
     * @returns {Bitmap | null}
     */
    const fromFrame = frame=>{
        const own = GDIP_OF_WIC.get(frame.format.name);
        const format = own ?? PixelFormat.ARGB32;
        const image = makeBitmap(frame.width, frame.height, format);
        if (!image)
        {
            return null;
        }
        fillFromFrame(image, frame);
        image.dpiX = frame.dpiX || 96;
        image.dpiY = frame.dpiY || 96;
        return image;
    };

    /** @param {Bitmap} image @param {import('../windowscodecs/frames.js').DecodedFrame} frame */
    const fillFromFrame = (image, frame)=>{
        const own = GDIP_OF_WIC.get(frame.format.name) === image.format;
        if (frame.palette && isIndexed(image.format))
        {
            image.palette = { flags: 0, entries: [...frame.palette] };
        }
        const from = Math.ceil(frame.width * frame.format.bpp / 8);
        const width = Math.min(frame.width, image.width);
        for (let y = 0; y < Math.min(frame.height, image.height); y++)
        {
            const row = frame.pixels.subarray(y * from, (y + 1) * from);
            const bytes = own ? row : convertRow(frame.format, /** @type {any} */ (
                wicOf(image.format)), row, frame.width, frame.palette, image.palette.entries);
            host.writeMemory(rowAt(image, y), bytes.subarray(0, Math.ceil(width
                * bitsOf(image.format) / 8)));
        }
    };

    /**
     * An image decoded from a file's or a stream's bytes, its first frame
     * active; the status where none was made.
     *
     * @param {Uint8Array} bytes
     * @returns {Bitmap | number}
     */
    const decode = bytes=>{
        const container = sniff(bytes);
        /** @type {import('../windowscodecs/frames.js').DecodedImage | undefined} */
        let decoded;
        try
        {
            decoded = container?.decode?.(bytes);
        }
        catch (e){
            if (!(e instanceof CodecError))
            {
                throw e;
            }
        }
        const first = decoded?.frames[0];
        if (!container || !decoded || !first)
        {
            return UnknownImageFormat;
        }
        const image = fromFrame(first);
        if (!image)
        {
            return OutOfMemory;
        }
        image.raw = formatOfContainer(container.name);
        image.flags = ImageFlagsColorSpaceRGB | ImageFlagsHasRealDPI | ImageFlagsHasRealPixelSize
            | ImageFlagsReadOnly;
        image.decoded = { frames: decoded.frames,
            dimension: container.name === 'Gif' ? FrameDimensionTime : FrameDimensionPage,
            active: 0 };
        if (container.name === 'Gif' && decoded.frames.length > 1)
        {
            const { delays, loop } = gifTiming(bytes);
            image.properties.set(PropertyTagFrameDelay, { type: PropertyTagTypeLong,
                value: new Uint8Array(Uint32Array.from(decoded.frames.map((_, i)=>delays[i] ?? 0))
                    .buffer) });
            image.properties.set(PropertyTagLoopCount, { type: PropertyTagTypeShort,
                value: new Uint8Array(Uint16Array.of(loop).buffer) });
        }
        return image;
    };

    /** @param {Bitmap} image @param {number} out */
    const publish = (image, out)=>{
        kit.add('image', image, out);
        return Ok;
    };

    /** @param {Bitmap} image */
    const dispose = image=>{
        if (image.lock?.owned)
        {
            host.free(image.lock.buffer);
        }
        if (image.owned)
        {
            host.free(image.scan0);
        }
    };

    /**
     * A copy of a rectangle of a bitmap in `format`, in memory of its own.
     *
     * @param {Bitmap} image @param {number} x @param {number} y
     * @param {number} width @param {number} height @param {number} format
     */
    const copyArea = (image, x, y, width, height, format)=>{
        const copy = makeBitmap(width, height, format);
        if (!copy)
        {
            return null;
        }
        copy.palette = { flags: image.palette.flags, entries: [...image.palette.entries] };
        copy.dpiX = image.dpiX;
        copy.dpiY = image.dpiY;
        const sameBits = format === image.format && (x * bitsOf(format)) % 8 === 0;
        for (let row = 0; row < height; row++)
        {
            const bytes = host.readMemory(rowAt(image, y + row), rowLength(image)).slice();
            host.writeMemory(rowAt(copy, row), sameBits
                ? bytes.subarray(x * bitsOf(format) / 8, x * bitsOf(format) / 8 + rowLength(copy))
                : rowIn(image, format, bytes, x, width));
        }
        return copy;
    };

    /**
     * BITMAPINFO and bits as GDI hands them: a bitmap of their depth, rows
     * bottom-up unless the height is negative. Null for a header GDI+ does
     * not take.
     *
     * @param {number} info @param {number} bits
     * @returns {Bitmap | null}
     */
    const fromDib = (info, bits)=>{
        const header = kit.view(info, 40);
        const width = header.getInt32(4, true);
        const height = header.getInt32(8, true);
        const depth = header.getUint16(14, true);
        const compression = header.getUint32(16, true);
        const format = { 1: PixelFormat.Indexed1, 4: PixelFormat.Indexed4, 8: PixelFormat.Indexed8,
            16: PixelFormat.RGB555, 24: PixelFormat.RGB24, 32: PixelFormat.RGB32 }[depth];
        // BI_RGB, or BI_BITFIELDS of 16 or 32 bits read as their usual masks.
        if (!format || width <= 0 || height === 0 || (compression !== 0 && compression !== 3))
        {
            return null;
        }
        const rows = Math.abs(height);
        const image = makeBitmap(width, rows, format);
        if (!image)
        {
            return null;
        }
        const headerSize = header.getUint32(0, true);
        if (isIndexed(format))
        {
            const used = header.getUint32(32, true) || 1 << depth;
            const table = kit.read(info + headerSize, used * 4);
            image.palette = { flags: 0, entries: Array.from({ length: used }, (_, i)=>
                (0xff000000 | table[i * 4 + 2] << 16 | table[i * 4 + 1] << 8 | table[i * 4])
                    >>> 0) };
        }
        const stride = Math.ceil(width * depth / 32) * 4;
        for (let y = 0; y < rows; y++)
        {
            const from = height > 0 ? rows - 1 - y : y;
            host.writeMemory(rowAt(image, y), kit.read(bits + from * stride, rowLength(image)));
        }
        return image;
    };

    /**
     * The pixels of a GDI bitmap, read through GetDIBits at its own depth.
     *
     * @param {number} hbm
     * @returns {Bitmap | null}
     */
    const fromHbitmap = hbm=>{
        const gdi32 = host.gdi32;
        if (!gdi32)
        {
            return null;
        }
        const scratch = allocate(40 + 256 * 4 + 32);
        if (scratch === 0)
        {
            return null;
        }
        const dc = gdi32('CreateCompatibleDC', [0]);
        try
        {
            if (gdi32('GetObjectW', [hbm, 24, scratch + 40 + 1024]) === 0)
            {
                return null;
            }
            const object = kit.view(scratch + 40 + 1024, 24);
            const width = object.getInt32(4, true);
            const height = object.getInt32(8, true);
            const depth = Math.max(1, object.getUint16(18, true));
            const header = new DataView(new ArrayBuffer(40));
            header.setUint32(0, 40, true);
            header.setInt32(4, width, true);
            header.setInt32(8, -height, true);
            header.setUint16(12, 1, true);
            header.setUint16(14, depth === 16 ? 24 : depth, true);
            host.writeMemory(scratch, new Uint8Array(header.buffer));
            const stride = Math.ceil(width * (depth === 16 ? 24 : depth) / 32) * 4;
            const bits = allocate(stride * height);
            if (bits === 0)
            {
                return null;
            }
            try
            {
                if (gdi32('GetDIBits', [dc, hbm, 0, height, bits, scratch, 0]) === 0)
                {
                    return null;
                }
                return fromDib(scratch, bits);
            }
            finally
            {
                host.free(bits);
            }
        }
        finally
        {
            gdi32('DeleteDC', [dc]);
            host.free(scratch);
        }
    };

    /**
     * A 32-bit top-down DIB section of the image's pixels, each laid over
     * `background` by its alpha as GDI+ hands one to GDI - or keeping its
     * alpha, as an icon's colour does, with none; 0 for none made.
     *
     * @param {Bitmap} image @param {number | null} background
     */
    const toHbitmap = (image, background)=>{
        const gdi32 = /** @type {NonNullable<ImageHost['gdi32']>} */ (host.gdi32);
        const info = allocate(44);
        if (info === 0)
        {
            return 0;
        }
        try
        {
            const header = new DataView(new ArrayBuffer(40));
            header.setUint32(0, 40, true);
            header.setInt32(4, image.width, true);
            header.setInt32(8, -image.height, true);
            header.setUint16(12, 1, true);
            header.setUint16(14, 32, true);
            host.writeMemory(info, new Uint8Array(header.buffer));
            const section = gdi32('CreateDIBSection', [0, info, 0, info + 40, 0, 0]) >>> 0;
            if (section === 0)
            {
                return 0;
            }
            const bits = kit.u32(info + 40);
            const pixels = readBgra(image, 0, 0, image.width, image.height);
            if (background === null)
            {
                host.writeMemory(bits, pixels);
                return section;
            }
            const back = [background & 0xff, background >>> 8 & 0xff, background >>> 16 & 0xff];
            for (let i = 0; i < pixels.length; i += 4)
            {
                const alpha = pixels[i + 3];
                for (let c = 0; c < 3; c++)
                {
                    pixels[i + c] = Math.round((pixels[i + c] * alpha + back[c] * (255 - alpha))
                        / 255);
                }
                pixels[i + 3] = 255;
            }
            host.writeMemory(bits, pixels);
            return section;
        }
        finally
        {
            host.free(info);
        }
    };

    /**
     * The image as a file of an encoder's container.
     *
     * @param {Bitmap} image @param {string} clsid
     * @returns {Uint8Array | null}
     */
    const encode = (image, clsid)=>{
        const codec = encoders().find(c=>c.clsid === clsid);
        if (!codec)
        {
            return null;
        }
        const indexed = isIndexed(image.format);
        const bits = bitsOf(image.format);
        const keep = indexed || bits === 24 || bits === 32;
        const bpp = keep ? bits : 32;
        const alpha = hasAlpha(image.format) || !keep;
        const rows = Array.from({ length: image.height }, (_, y)=>{
            const bytes = host.readMemory(rowAt(image, y), rowLength(image)).slice();
            if (indexed || image.format === PixelFormat.RGB24 || image.format === PixelFormat.RGB32
                || image.format === PixelFormat.ARGB32)
            {
                return bytes;
            }
            return convertRow(/** @type {any} */ (wicOf(image.format)), BGRA, bytes, image.width,
                image.palette.entries, null);
        });
        const encodable = { width: image.width, height: image.height, bpp, rows,
            palette: image.palette.entries, alpha };
        return codec.name === 'Bmp' ? encodeBmp(encodable) : encodePng(encodable);
    };

    /**
     * @param {(image: Bitmap, args: number[]) => number | Promise<number>} body
     * @returns {(args: number[]) => number | Promise<number>}
     */
    const onImage = body=>([at, ...rest])=>{
        const image = get(at);
        return image ? body(image, rest) : InvalidParameter;
    };

    /** @param {Bitmap} image @param {number} x @param {number} y */
    const inside = (image, x, y)=>x >= 0 && y >= 0 && x < image.width && y < image.height;

    /**
     * A PropertyItem, then its value, at `at`.
     *
     * @param {number} at @param {number} id @param {{ type: number, value: Uint8Array }} item
     * @param {number} valueAt
     */
    const putProperty = (at, id, item, valueAt)=>{
        kit.putU32(at, id);
        kit.putU32(at + 4, item.value.length);
        kit.write(at + 8, new Uint8Array(Uint16Array.of(item.type, 0).buffer));
        kit.putPointer(at + (pointer === 8 ? 16 : 12), valueAt);
        kit.write(valueAt, item.value);
    };
    const propertyHeader = pointer === 8 ? 24 : 16;

    /** The GUID at an address, in its canonical form. @param {number} at */
    const clsidAt = at=>formatGuid(kit.read(at, 16));

    /**
     * Loads an image from a stream or file and publishes it.
     *
     * @param {Uint8Array | null} bytes @param {number} out @param {number} missing
     */
    const load = (bytes, out, missing)=>{
        kit.putPointer(out, 0);
        if (!bytes)
        {
            return missing;
        }
        const made = decode(bytes);
        return typeof made === 'number' ? made : publish(made, out);
    };

    /** @param {number} stream */
    const streamBytes = stream=>host.streams?.read(stream) ?? Promise.resolve(null);
    /** @param {number} name */
    const fileBytes = async name=>(host.readFile && host.readWideString
        ? await host.readFile(host.readWideString(name >>> 0)) : null);

    /**
     * Rotates or flips the bitmap in place: RotateFlipType's rotation of
     * 0, 90, 180 or 270 degrees clockwise, then a flip in x for 4 to 7.
     *
     * @param {Bitmap} image @param {number} type
     */
    const rotateFlip = (image, type)=>{
        const bits = bitsOf(image.format);
        const { width, height } = image;
        const quarter = type & 3;
        const flip = (type & 4) !== 0;
        const swap = quarter % 2 === 1;
        const outWidth = swap ? height : width;
        const outHeight = swap ? width : height;
        const rows = Array.from({ length: height }, (_, y)=>host.readMemory(rowAt(image, y),
            rowLength(image)).slice());
        /** @param {Uint8Array} row @param {number} x */
        const pixelOf = (row, x)=>{
            if (bits >= 8)
            {
                return row.subarray(x * bits / 8, (x + 1) * bits / 8);
            }
            const bit = x * bits;
            return Uint8Array.of(row[bit >> 3] >> (8 - bits - (bit & 7)) & (1 << bits) - 1);
        };
        const stride = Math.ceil(outWidth * bits / 32) * 4;
        const out = new Uint8Array(stride * outHeight);
        for (let y = 0; y < outHeight; y++)
        {
            for (let x = 0; x < outWidth; x++)
            {
                const fx = flip ? outWidth - 1 - x : x;
                // The source pixel this one comes from, turning clockwise.
                const [sx, sy] = quarter === 0 ? [fx, y] : quarter === 1 ? [y, height - 1 - fx]
                    : quarter === 2 ? [width - 1 - fx, height - 1 - y] : [width - 1 - y, fx];
                const value = pixelOf(rows[sy], sx);
                if (bits >= 8)
                {
                    out.set(value, y * stride + x * bits / 8);
                }
                else
                {
                    const bit = x * bits;
                    out[y * stride + (bit >> 3)] |= value[0] << (8 - bits - (bit & 7));
                }
            }
        }
        if (swap && !image.owned)
        {
            // The caller's buffer keeps its stride; the turned pixels need their own.
            const place = allocate(out.length);
            if (place === 0)
            {
                return OutOfMemory;
            }
            image.scan0 = place;
            image.owned = true;
        }
        else if (swap)
        {
            host.free(image.scan0);
            image.scan0 = allocate(out.length);
            if (image.scan0 === 0)
            {
                return OutOfMemory;
            }
        }
        if (swap)
        {
            image.stride = stride;
            [image.dpiX, image.dpiY] = [image.dpiY, image.dpiX];
        }
        image.width = outWidth;
        image.height = outHeight;
        for (let y = 0; y < outHeight; y++)
        {
            host.writeMemory(rowAt(image, y), out.subarray(y * stride, y * stride
                + rowLength(image)));
        }
        return Ok;
    };

    const functions = {
        /**
         * Status GdipCreateBitmapFromScan0(INT width, INT height, INT stride,
         *   PixelFormat format, BYTE *scan0, GpBitmap **bitmap)
         *
         * Over the caller's pixels, which the bitmap keeps using - its stride a
         * nonzero multiple of four, negative for rows bottom-up - or zeroed
         * pixels of its own when there are none.
         */
        GdipCreateBitmapFromScan0: fn(24, ([width, height, stride, format, scan0, out])=>{
            if ((out >>> 0) === 0 || ((scan0 >>> 0) !== 0 && (stride | 0) === 0))
            {
                return InvalidParameter;
            }
            if ((width | 0) <= 0 || (height | 0) <= 0 || !WIC_NAME.has(format >>> 0)
                || ((scan0 >>> 0) !== 0 && (stride | 0) % 4 !== 0))
            {
                kit.putPointer(out, 0);
                return InvalidParameter;
            }
            const image = makeBitmap(width | 0, height | 0, format >>> 0, stride, scan0);
            return image ? publish(image, out) : OutOfMemory;
        }),
        /**
         * Status GdipCreateBitmapFromFile(const WCHAR *filename, GpBitmap **bitmap)
         *
         * The file's first image, decoded by the codec its first bytes name. A
         * file not there is InvalidParameter, as GDI+ answers it; one no codec
         * reads, UnknownImageFormat.
         */
        GdipCreateBitmapFromFile: fn(8, async([name, out])=>{
            if ((name >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            return load(await fileBytes(name), out, InvalidParameter);
        }),
        /** Status GdipCreateBitmapFromFileICM(const WCHAR *filename, GpBitmap **bitmap) */
        GdipCreateBitmapFromFileICM: fn(8, ([name, out])=>
            functions.GdipCreateBitmapFromFile.handler([name, out])),
        /**
         * Status GdipLoadImageFromFile(const WCHAR *filename, GpImage **image): a
         * file not there is OutOfMemory, as GDI+ answers it.
         */
        GdipLoadImageFromFile: fn(8, async([name, out])=>{
            if ((name >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            return load(await fileBytes(name), out, OutOfMemory);
        }),
        /** Status GdipLoadImageFromFileICM(const WCHAR *filename, GpImage **image) */
        GdipLoadImageFromFileICM: fn(8, ([name, out])=>
            functions.GdipLoadImageFromFile.handler([name, out])),
        /**
         * Status GdipCreateBitmapFromStream(IStream *stream, GpBitmap **bitmap)
         *
         * The image from where the stream stands to its end.
         */
        GdipCreateBitmapFromStream: fn(8, async([stream, out])=>{
            if ((stream >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            return load(await streamBytes(stream), out, InvalidParameter);
        }),
        /** Status GdipCreateBitmapFromStreamICM(IStream *stream, GpBitmap **bitmap) */
        GdipCreateBitmapFromStreamICM: fn(8, ([stream, out])=>
            functions.GdipCreateBitmapFromStream.handler([stream, out])),
        /** Status GdipLoadImageFromStream(IStream *stream, GpImage **image) */
        GdipLoadImageFromStream: fn(8, ([stream, out])=>
            functions.GdipCreateBitmapFromStream.handler([stream, out])),
        /** Status GdipLoadImageFromStreamICM(IStream *stream, GpImage **image) */
        GdipLoadImageFromStreamICM: fn(8, ([stream, out])=>
            functions.GdipCreateBitmapFromStream.handler([stream, out])),
        /**
         * Status GdipCreateBitmapFromGdiDib(const BITMAPINFO *info, void *bits,
         *   GpBitmap **bitmap)
         */
        GdipCreateBitmapFromGdiDib: fn(12, ([info, bits, out])=>{
            if ((info >>> 0) === 0 || (bits >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const image = fromDib(info, bits);
            return image ? publish(image, out) : InvalidParameter;
        }),
        /**
         * Status GdipCreateBitmapFromHBITMAP(HBITMAP hbm, HPALETTE hpal, GpBitmap **bitmap)
         *
         * A copy of the GDI bitmap's pixels at its depth: 16 bits as 24, its
         * colour table the palette of an indexed one.
         */
        GdipCreateBitmapFromHBITMAP: fn(12, ([hbm, , out])=>{
            if ((hbm >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const image = fromHbitmap(hbm);
            return image ? publish(image, out) : InvalidParameter;
        }),
        /**
         * Status GdipCreateBitmapFromHICON(HICON icon, GpBitmap **bitmap)
         *
         * The icon's colour as 32bpp ARGB: its own alpha where it has any,
         * else opaque where its mask is clear.
         */
        GdipCreateBitmapFromHICON: fn(8, ([icon, out])=>{
            if ((icon >>> 0) === 0 || (out >>> 0) === 0 || !host.user32 || !host.gdi32)
            {
                return InvalidParameter;
            }
            const info = allocate(20 + pointer * 2);
            if (info === 0)
            {
                return OutOfMemory;
            }
            try
            {
                if (host.user32('GetIconInfo', [icon, info]) === 0)
                {
                    return InvalidParameter;
                }
                const maskBitmap = kit.u32(info + 12);
                const colourBitmap = kit.u32(info + 16);
                const mask = fromHbitmap(maskBitmap);
                const colour = colourBitmap ? fromHbitmap(colourBitmap) : null;
                if (!mask || (colourBitmap && !colour))
                {
                    return InvalidParameter;
                }
                const width = mask.width;
                const height = colour ? colour.height : mask.height / 2;
                const image = makeBitmap(width, height, PixelFormat.ARGB32);
                if (!image)
                {
                    return OutOfMemory;
                }
                const andBits = readBgra(mask, 0, 0, width, height);
                const pixels = colour ? readBgra(colour, 0, 0, width, height)
                    : readBgra(mask, 0, height, width, height);
                // A 32-bit colour bitmap carries alpha in its fourth byte, which
                // its format as GDI hands it (32bpp RGB) does not read.
                const raw = colour?.format === PixelFormat.RGB32
                    ? host.readMemory(colour.scan0, colour.stride * height).slice() : null;
                const ownAlpha = raw?.some((b, i)=>i % 4 === 3 && b !== 0) ?? false;
                for (let i = 0; i < width * height; i++)
                {
                    pixels[i * 4 + 3] = ownAlpha && raw ? raw[i * 4 + 3]
                        : andBits[i * 4] === 0 ? 255 : 0;
                }
                writeBgra(image, 0, 0, width, height, pixels);
                for (const made of [mask, colour])
                {
                    if (made)
                    {
                        dispose(made);
                    }
                }
                host.gdi32('DeleteObject', [maskBitmap]);
                if (colourBitmap)
                {
                    host.gdi32('DeleteObject', [colourBitmap]);
                }
                return publish(image, out);
            }
            finally
            {
                host.free(info);
            }
        }),
        /**
         * Status GdipCreateHBITMAPFromBitmap(GpBitmap *bitmap, HBITMAP *hbm, ARGB background)
         */
        GdipCreateHBITMAPFromBitmap: fn(12, onImage((image, [out, background])=>{
            if ((out >>> 0) === 0 || !host.gdi32)
            {
                return InvalidParameter;
            }
            const section = toHbitmap(image, background);
            if (section === 0)
            {
                return GenericError;
            }
            kit.putU32(out, section);
            return Ok;
        })),
        /**
         * Status GdipCreateHICONFromBitmap(GpBitmap *bitmap, HICON *icon)
         *
         * An icon of the bitmap's pixels with their alpha, its mask clear.
         */
        GdipCreateHICONFromBitmap: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0 || !host.gdi32 || !host.user32)
            {
                return InvalidParameter;
            }
            const info = allocate(20);
            if (info === 0)
            {
                return OutOfMemory;
            }
            try
            {
                const colour = toHbitmap(image, null);
                const mask = host.gdi32('CreateBitmap', [image.width, image.height, 1, 1, 0]);
                if (colour === 0 || mask === 0)
                {
                    return GenericError;
                }
                kit.putU32(info, 1);
                kit.putU32(info + 12, mask);
                kit.putU32(info + 16, colour);
                const icon = host.user32('CreateIconIndirect', [info]) >>> 0;
                host.gdi32('DeleteObject', [colour]);
                host.gdi32('DeleteObject', [mask]);
                if (icon === 0)
                {
                    return GenericError;
                }
                kit.putU32(out, icon);
                return Ok;
            }
            finally
            {
                host.free(info);
            }
        })),
        /** Status GdipCloneImage(GpImage *image, GpImage **clone): its pixels in its own memory. */
        GdipCloneImage: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const copy = copyArea(image, 0, 0, image.width, image.height, image.format);
            if (!copy)
            {
                return OutOfMemory;
            }
            Object.assign(copy, { raw: image.raw, flags: image.flags, decoded: image.decoded,
                properties: new Map(image.properties) });
            return publish(copy, out);
        })),
        /**
         * Status GdipCloneBitmapArea(REAL x, REAL y, REAL width, REAL height,
         *   PixelFormat format, GpBitmap *source, GpBitmap **bitmap)
         */
        GdipCloneBitmapArea: fn(28, ([x, y, width, height, format, source, out])=>
            functions.GdipCloneBitmapAreaI.handler([kit.real(x), kit.real(y), kit.real(width),
                kit.real(height)].map(v=>Math.round(v)).concat([format, source, out]))),
        /**
         * Status GdipCloneBitmapAreaI(INT x, INT y, INT width, INT height,
         *   PixelFormat format, GpBitmap *source, GpBitmap **bitmap)
         */
        GdipCloneBitmapAreaI: fn(28, ([x, y, width, height, format, source, out])=>{
            const image = get(source);
            const rect = [x, y, width, height].map(v=>v | 0);
            if (!image || (out >>> 0) === 0 || rect[0] < 0 || rect[1] < 0 || rect[2] <= 0
                || rect[3] <= 0 || rect[0] + rect[2] > image.width
                || rect[1] + rect[3] > image.height || !WIC_NAME.has(format >>> 0))
            {
                return InvalidParameter;
            }
            const copy = copyArea(image, rect[0], rect[1], rect[2], rect[3], format >>> 0);
            return copy ? publish(copy, out) : OutOfMemory;
        }),
        /** Status GdipDisposeImage(GpImage *image) */
        GdipDisposeImage: fn(4, ([at])=>{
            const image = get(at);
            if (!image)
            {
                return InvalidParameter;
            }
            dispose(image);
            kit.remove(at, 'image');
            return Ok;
        }),
        /** Status GdipGetImageWidth(GpImage *image, UINT *width) */
        GdipGetImageWidth: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, image.width);
            return Ok;
        })),
        /** Status GdipGetImageHeight(GpImage *image, UINT *height) */
        GdipGetImageHeight: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, image.height);
            return Ok;
        })),
        /** Status GdipGetImageDimension(GpImage *image, REAL *width, REAL *height) */
        GdipGetImageDimension: fn(12, onImage((image, [width, height])=>{
            if ((width >>> 0) === 0 || (height >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(width, image.width);
            kit.putF32(height, image.height);
            return Ok;
        })),
        /** Status GdipGetImageBounds(GpImage *image, GpRectF *rect, GpUnit *unit): in pixels. */
        GdipGetImageBounds: fn(12, onImage((image, [rect, unit])=>{
            if ((rect >>> 0) === 0 || (unit >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(rect, [0, 0, image.width, image.height]);
            kit.putU32(unit, UnitPixel);
            return Ok;
        })),
        /** Status GdipGetImageType(GpImage *image, ImageType *type): a bitmap. */
        GdipGetImageType: fn(8, onImage((_image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, 1);
            return Ok;
        })),
        /** Status GdipGetImagePixelFormat(GpImage *image, PixelFormat *format) */
        GdipGetImagePixelFormat: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, image.format);
            return Ok;
        })),
        /** Status GdipGetImageRawFormat(GpImage *image, GUID *format) */
        GdipGetImageRawFormat: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.write(out, /** @type {Uint8Array} */ (parseGuid(image.raw)));
            return Ok;
        })),
        /** Status GdipGetImageFlags(GpImage *image, UINT *flags) */
        GdipGetImageFlags: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, image.flags | (hasAlpha(image.format) ? ImageFlagsHasAlpha : 0));
            return Ok;
        })),
        /** Status GdipGetImageHorizontalResolution(GpImage *image, REAL *resolution) */
        GdipGetImageHorizontalResolution: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(out, image.dpiX);
            return Ok;
        })),
        /** Status GdipGetImageVerticalResolution(GpImage *image, REAL *resolution) */
        GdipGetImageVerticalResolution: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(out, image.dpiY);
            return Ok;
        })),
        /** Status GdipBitmapSetResolution(GpBitmap *bitmap, REAL x, REAL y) */
        GdipBitmapSetResolution: fn(12, onImage((image, [x, y])=>{
            const [dpiX, dpiY] = [kit.real(x), kit.real(y)];
            if (!(dpiX > 0) || !(dpiY > 0))
            {
                return InvalidParameter;
            }
            image.dpiX = dpiX;
            image.dpiY = dpiY;
            return Ok;
        })),
        /**
         * Status GdipGetImagePaletteSize(GpImage *image, INT *size)
         *
         * A ColorPalette's bytes: its header and its entries, room for one
         * at least, as GDI+ answers for an image with none.
         */
        GdipGetImagePaletteSize: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, 8 + 4 * Math.max(1, image.palette.entries.length));
            return Ok;
        })),
        /** Status GdipGetImagePalette(GpImage *image, ColorPalette *palette, INT size) */
        GdipGetImagePalette: fn(12, onImage((image, [out, size])=>{
            const { flags, entries } = image.palette;
            if ((out >>> 0) === 0 || (size | 0) < 8 + 4 * entries.length)
            {
                return InvalidParameter;
            }
            kit.putU32(out, flags);
            kit.putU32(out + 4, entries.length);
            kit.write(out + 8, new Uint8Array(Uint32Array.from(entries).buffer));
            return Ok;
        })),
        /** Status GdipSetImagePalette(GpImage *image, const ColorPalette *palette) */
        GdipSetImagePalette: fn(8, onImage((image, [palette])=>{
            if ((palette >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const count = kit.u32(palette + 4);
            if (count > 256)
            {
                return InvalidParameter;
            }
            image.palette = { flags: kit.u32(palette),
                entries: kit.i32s(palette + 8, count).map(c=>c >>> 0) };
            return Ok;
        })),
        /**
         * Status GdipInitializePalette(ColorPalette *palette, PaletteType type,
         *   INT optimalColors, BOOL useTransparentColor, GpBitmap *bitmap)
         *
         * A fixed palette is WIC's of the same type, its flags the type in the
         * second byte; an optimal one the bitmap's median cut, in a palette
         * with room for it.
         */
        GdipInitializePalette: fn(20, ([palette, type, optimal, transparent, bitmap])=>{
            if ((palette >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((type | 0) === 0)
            {
                return Ok;
            }
            if ((type | 0) === 1)
            {
                const image = get(bitmap);
                if (!image)
                {
                    return InvalidParameter;
                }
                if (kit.u32(palette + 4) < (optimal >>> 0) || (optimal | 0) <= 0)
                {
                    return GenericError;
                }
                const colours = medianCut(readBgra(image, 0, 0, image.width, image.height),
                    optimal | 0, transparent !== 0);
                kit.putU32(palette, 0);
                kit.putU32(palette + 4, colours.length);
                kit.write(palette + 8, new Uint8Array(Uint32Array.from(colours).buffer));
                return Ok;
            }
            const colours = predefinedPalette(type | 0, transparent !== 0);
            if (!colours || (type | 0) > 9)
            {
                return InvalidParameter;
            }
            kit.putU32(palette, (type | 0) << 8);
            kit.putU32(palette + 4, colours.length);
            kit.write(palette + 8, new Uint8Array(Uint32Array.from(colours).buffer));
            return Ok;
        }),
        /** Status GdipBitmapGetPixel(GpBitmap *bitmap, INT x, INT y, ARGB *color) */
        GdipBitmapGetPixel: fn(16, onImage((image, [x, y, out])=>{
            if ((out >>> 0) === 0 || !inside(image, x | 0, y | 0))
            {
                return InvalidParameter;
            }
            if (image.lock)
            {
                return WrongState;
            }
            const [b, g, r, a] = readBgra(image, x | 0, y | 0, 1, 1);
            kit.putU32(out, (a << 24 | r << 16 | g << 8 | b) >>> 0);
            return Ok;
        })),
        /**
         * Status GdipBitmapSetPixel(GpBitmap *bitmap, INT x, INT y, ARGB color)
         *
         * An indexed bitmap takes its palette's nearest colour.
         */
        GdipBitmapSetPixel: fn(16, onImage((image, [x, y, colour])=>{
            if (!inside(image, x | 0, y | 0))
            {
                return InvalidParameter;
            }
            if (image.lock)
            {
                return WrongState;
            }
            writeBgra(image, x | 0, y | 0, 1, 1, Uint8Array.of(colour & 0xff, colour >>> 8 & 0xff,
                colour >>> 16 & 0xff, colour >>> 24));
            return Ok;
        })),
        /**
         * Status GdipBitmapLockBits(GpBitmap *bitmap, const GpRect *rect, UINT flags,
         *   PixelFormat format, BitmapData *data)
         *
         * A rectangle (all of it with none): the bitmap's own pixels in place
         * when the format is its own, else converted into a buffer - the
         * caller's with ImageLockModeUserInputBuf - read in when the lock
         * reads, written back on unlock when it writes.
         */
        GdipBitmapLockBits: fn(20, onImage((image, [rect, flags, format, data])=>{
            if ((data >>> 0) === 0 || !WIC_NAME.has(format >>> 0)
                || (flags & (ImageLockModeRead | ImageLockModeWrite)) === 0)
            {
                return InvalidParameter;
            }
            if (image.lock)
            {
                return WrongState;
            }
            let [x, y, width, height] = [0, 0, image.width, image.height];
            if ((rect >>> 0) !== 0)
            {
                [x, y, width, height] = kit.i32s(rect, 4);
            }
            if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width
                || y + height > image.height)
            {
                return InvalidParameter;
            }
            // A conversion into an indexed format from one that is not has no palette to reach.
            if (isIndexed(format >>> 0) && format >>> 0 !== image.format)
            {
                return InvalidParameter;
            }
            const bits = bitsOf(format >>> 0);
            const user = (flags & ImageLockModeUserInputBuf) !== 0;
            const inPlace = !user && (format >>> 0) === image.format && (x * bits) % 8 === 0;
            let buffer = rowAt(image, y) + x * bits / 8;
            let stride = image.stride;
            if (user)
            {
                stride = kit.i32(data + 8);
                buffer = kit.pointerAt(data + 16);
            }
            else if (!inPlace)
            {
                stride = Math.ceil(width * bits / 32) * 4;
                buffer = allocate(stride * height);
                if (buffer === 0)
                {
                    return OutOfMemory;
                }
            }
            if (!inPlace && (flags & ImageLockModeRead) !== 0)
            {
                for (let row = 0; row < height; row++)
                {
                    const bytes = host.readMemory(rowAt(image, y + row), rowLength(image)).slice();
                    host.writeMemory(buffer + row * stride, rowIn(image, format >>> 0, bytes, x,
                        width));
                }
            }
            const record = new Uint8Array(16 + pointer * 2);
            const view = new DataView(record.buffer);
            view.setUint32(0, width, true);
            view.setUint32(4, height, true);
            view.setInt32(8, stride, true);
            view.setUint32(12, format >>> 0, true);
            kit.pointer.set(view, 16, buffer);
            kit.write(data, record);
            image.lock = { x, y, width, height, flags, format: format >>> 0, buffer, stride,
                inPlace, owned: !inPlace && !user };
            return Ok;
        })),
        /** Status GdipBitmapUnlockBits(GpBitmap *bitmap, BitmapData *data) */
        GdipBitmapUnlockBits: fn(8, onImage((image, [data])=>{
            const lock = image.lock;
            if ((data >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if (!lock)
            {
                return WrongState;
            }
            if (!lock.inPlace && (lock.flags & ImageLockModeWrite) !== 0)
            {
                const from = /** @type {any} */ (wicOf(lock.format));
                const rowBytes = Math.ceil(lock.width * bitsOf(lock.format) / 8);
                for (let row = 0; row < lock.height; row++)
                {
                    const bytes = host.readMemory(lock.buffer + row * lock.stride, rowBytes)
                        .slice();
                    writeBgra(image, lock.x, lock.y + row, lock.width, 1, convertRow(from, BGRA,
                        bytes, lock.width, image.palette.entries, null));
                }
            }
            if (lock.owned)
            {
                host.free(lock.buffer);
            }
            image.lock = null;
            return Ok;
        })),
        /** Status GdipImageRotateFlip(GpImage *image, RotateFlipType type) */
        GdipImageRotateFlip: fn(8, onImage((image, [type])=>{
            if ((type >>> 0) > 7)
            {
                return InvalidParameter;
            }
            if (image.lock)
            {
                return WrongState;
            }
            return rotateFlip(image, type >>> 0);
        })),
        /**
         * Status GdipGetImageThumbnail(GpImage *image, UINT width, UINT height,
         *   GpImage **thumb, GetThumbnailImageAbort callback, void *data)
         *
         * The image scaled to the size (120 by 120 for none), nearest pixel,
         * as 32bpp PARGB.
         */
        GdipGetImageThumbnail: fn(24, onImage((image, [width, height, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const w = (width >>> 0) || 120;
            const h = (height >>> 0) || 120;
            const thumb = makeBitmap(w, h, PixelFormat.PARGB32);
            if (!thumb)
            {
                return OutOfMemory;
            }
            const source = readBgra(image, 0, 0, image.width, image.height);
            const pixels = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++)
            {
                const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / h));
                for (let x = 0; x < w; x++)
                {
                    const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / w));
                    pixels.set(source.subarray((sy * image.width + sx) * 4,
                        (sy * image.width + sx) * 4 + 4), (y * w + x) * 4);
                }
            }
            writeBgra(thumb, 0, 0, w, h, pixels);
            return publish(thumb, out);
        })),
        /** Status GdipImageGetFrameDimensionsCount(GpImage *image, UINT *count): one. */
        GdipImageGetFrameDimensionsCount: fn(8, onImage((_image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, 1);
            return Ok;
        })),
        /**
         * Status GdipImageGetFrameDimensionsList(GpImage *image, GUID *dimensions, UINT count)
         *
         * Time for a GIF, Page for any other image.
         */
        GdipImageGetFrameDimensionsList: fn(12, onImage((image, [out, count])=>{
            if ((out >>> 0) === 0 || (count >>> 0) !== 1)
            {
                return InvalidParameter;
            }
            kit.write(out, /** @type {Uint8Array} */ (parseGuid(image.decoded?.dimension
                ?? FrameDimensionPage)));
            return Ok;
        })),
        /** Status GdipImageGetFrameCount(GpImage *image, const GUID *dimension, UINT *count) */
        GdipImageGetFrameCount: fn(12, onImage((image, [dimension, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const own = image.decoded?.dimension ?? FrameDimensionPage;
            if ((dimension >>> 0) !== 0 && clsidAt(dimension) !== own)
            {
                return InvalidParameter;
            }
            kit.putU32(out, image.decoded?.frames.length ?? 1);
            return Ok;
        })),
        /**
         * Status GdipImageSelectActiveFrame(GpImage *image, const GUID *dimension, UINT index)
         *
         * The frame's pixels into the image, its size and format kept.
         */
        GdipImageSelectActiveFrame: fn(12, onImage((image, [dimension, index])=>{
            const own = image.decoded?.dimension ?? FrameDimensionPage;
            if ((dimension >>> 0) !== 0 && clsidAt(dimension) !== own)
            {
                return InvalidParameter;
            }
            const frames = image.decoded?.frames;
            if (!frames)
            {
                return (index >>> 0) === 0 ? Ok : InvalidParameter;
            }
            const frame = frames[index >>> 0];
            if (!frame)
            {
                return Win32Error;
            }
            if (image.lock)
            {
                return WrongState;
            }
            fillFromFrame(image, frame);
            /** @type {NonNullable<Bitmap['decoded']>} */ (image.decoded).active = index >>> 0;
            return Ok;
        })),
        /** Status GdipGetPropertyCount(GpImage *image, UINT *count) */
        GdipGetPropertyCount: fn(8, onImage((image, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, image.properties.size);
            return Ok;
        })),
        /** Status GdipGetPropertyIdList(GpImage *image, UINT count, PROPID *list) */
        GdipGetPropertyIdList: fn(12, onImage((image, [count, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((count >>> 0) !== image.properties.size)
            {
                return InvalidParameter;
            }
            kit.write(out, new Uint8Array(Uint32Array.from(image.properties.keys()).buffer));
            return Ok;
        })),
        /** Status GdipGetPropertyItemSize(GpImage *image, PROPID id, UINT *size) */
        GdipGetPropertyItemSize: fn(12, onImage((image, [id, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const item = image.properties.get(id >>> 0);
            if (!item)
            {
                return PropertyNotFound;
            }
            kit.putU32(out, propertyHeader + item.value.length);
            return Ok;
        })),
        /** Status GdipGetPropertyItem(GpImage *image, PROPID id, UINT size, PropertyItem *item) */
        GdipGetPropertyItem: fn(16, onImage((image, [id, size, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const item = image.properties.get(id >>> 0);
            if (!item)
            {
                return PropertyNotFound;
            }
            if ((size >>> 0) !== propertyHeader + item.value.length)
            {
                return InvalidParameter;
            }
            putProperty(out, id >>> 0, item, out + propertyHeader);
            return Ok;
        })),
        /** Status GdipGetPropertySize(GpImage *image, UINT *totalSize, UINT *count) */
        GdipGetPropertySize: fn(12, onImage((image, [total, count])=>{
            if ((total >>> 0) === 0 || (count >>> 0) === 0)
            {
                return InvalidParameter;
            }
            let bytes = 0;
            for (const item of image.properties.values())
            {
                bytes += propertyHeader + item.value.length;
            }
            kit.putU32(total, bytes);
            kit.putU32(count, image.properties.size);
            return Ok;
        })),
        /**
         * Status GdipGetAllPropertyItems(GpImage *image, UINT totalSize, UINT count,
         *   PropertyItem *items)
         *
         * The items, then their values after the last of them.
         */
        GdipGetAllPropertyItems: fn(16, onImage((image, [total, count, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const items = [...image.properties];
            const bytes = items.reduce((n, [, item])=>n + propertyHeader + item.value.length, 0);
            if ((count >>> 0) !== items.length || (total >>> 0) !== bytes)
            {
                return InvalidParameter;
            }
            let valueAt = out + propertyHeader * items.length;
            items.forEach(([id, item], i)=>{
                putProperty(out + i * propertyHeader, id, item, valueAt);
                valueAt += item.value.length;
            });
            return Ok;
        })),
        /** Status GdipSetPropertyItem(GpImage *image, const PropertyItem *item) */
        GdipSetPropertyItem: fn(8, onImage((image, [item])=>{
            if ((item >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const length = kit.u32(item + 4);
            const value = kit.pointerAt(item + (pointer === 8 ? 16 : 12));
            image.properties.set(kit.u32(item), { type: kit.view(item + 8, 2).getUint16(0, true),
                value: length === 0 ? new Uint8Array(0) : kit.read(value, length) });
            return Ok;
        })),
        /** Status GdipRemovePropertyItem(GpImage *image, PROPID id) */
        GdipRemovePropertyItem: fn(8, onImage((image, [id])=>(image.properties.delete(id >>> 0)
            ? Ok : PropertyNotFound))),
        /** Status GdipGetImageDecodersSize(UINT *count, UINT *size) */
        GdipGetImageDecodersSize: fn(8, ([count, size])=>{
            if ((count >>> 0) === 0 || (size >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(count, decoders().length);
            kit.putU32(size, codecInfos(decoders(), 0, pointer, guidBytes).length);
            return Ok;
        }),
        /** Status GdipGetImageDecoders(UINT count, UINT size, ImageCodecInfo *codecs) */
        GdipGetImageDecoders: fn(12, ([count, size, out])=>listCodecs(decoders(), count, size,
            out)),
        /** Status GdipGetImageEncodersSize(UINT *count, UINT *size) */
        GdipGetImageEncodersSize: fn(8, ([count, size])=>{
            if ((count >>> 0) === 0 || (size >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(count, encoders().length);
            kit.putU32(size, codecInfos(encoders(), 0, pointer, guidBytes).length);
            return Ok;
        }),
        /** Status GdipGetImageEncoders(UINT count, UINT size, ImageCodecInfo *codecs) */
        GdipGetImageEncoders: fn(12, ([count, size, out])=>listCodecs(encoders(), count, size,
            out)),
        /**
         * Status GdipGetEncoderParameterListSize(GpImage *image, const CLSID *encoder,
         *   UINT *size)
         *
         * BMP and PNG take no parameters: GDI+ has no list for them.
         */
        GdipGetEncoderParameterListSize: fn(12, ([at, encoder, out])=>{
            if (!get(at) || (encoder >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            return encoders().some(c=>c.clsid === clsidAt(encoder)) ? NotImplemented
                : FileNotFound;
        }),
        /**
         * Status GdipSaveImageToFile(GpImage *image, const WCHAR *filename,
         *   const CLSID *encoder, const EncoderParameters *params)
         */
        GdipSaveImageToFile: fn(16, onImage((image, [name, encoder])=>{
            if ((name >>> 0) === 0 || (encoder >>> 0) === 0 || !host.readWideString
                || !host.writeFile)
            {
                return InvalidParameter;
            }
            const bytes = encode(image, clsidAt(encoder));
            if (!bytes)
            {
                return UnknownImageFormat;
            }
            return host.writeFile(host.readWideString(name >>> 0), bytes) ? Ok : Win32Error;
        })),
        /**
         * Status GdipSaveImageToStream(GpImage *image, IStream *stream,
         *   const CLSID *encoder, const EncoderParameters *params)
         */
        GdipSaveImageToStream: fn(16, onImage(async(image, [stream, encoder])=>{
            if ((stream >>> 0) === 0 || (encoder >>> 0) === 0 || !host.streams)
            {
                return InvalidParameter;
            }
            const bytes = encode(image, clsidAt(encoder));
            if (!bytes)
            {
                return UnknownImageFormat;
            }
            return await host.streams.write(stream, bytes) < 0 ? Win32Error : Ok;
        })),
        /** Status GdipImageForceValidation(GpImage *image): decoded already. */
        GdipImageForceValidation: fn(4, onImage(()=>Ok)),
        /** Status GdipImageSetAbort(GpImage *image, GdiplusAbort *abort): nothing runs long. */
        GdipImageSetAbort: fn(8, onImage(()=>Ok)),
        /**
         * Status GdipBitmapConvertFormat(GpBitmap *bitmap, PixelFormat format,
         *   DitherType dither, PaletteType paletteType, ColorPalette *palette,
         *   REAL alphaThreshold)
         *
         * The pixels in another format, in memory of their own; an indexed
         * one takes the palette given, else the predefined palette of its type.
         */
        GdipBitmapConvertFormat: fn(24, onImage((image, [format, , paletteType, palette])=>{
            if (!WIC_NAME.has(format >>> 0))
            {
                return InvalidParameter;
            }
            if (image.lock)
            {
                return WrongState;
            }
            const before = image.palette;
            if (isIndexed(format >>> 0))
            {
                const given = (palette >>> 0) === 0 ? null
                    : kit.i32s(palette + 8, kit.u32(palette + 4)).map(c=>c >>> 0);
                const entries = given ?? predefinedPalette(paletteType | 0, false)
                    ?? defaultPalette(format >>> 0).entries;
                image.palette = { flags: 0, entries };
            }
            const copy = copyArea({ ...image, palette: before }, 0, 0, image.width, image.height,
                format >>> 0);
            if (!copy)
            {
                image.palette = before;
                return OutOfMemory;
            }
            if (image.owned)
            {
                host.free(image.scan0);
            }
            Object.assign(image, { format: format >>> 0, scan0: copy.scan0, stride: copy.stride,
                owned: true, palette: isIndexed(format >>> 0) ? image.palette : copy.palette });
            return Ok;
        })),
        /**
         * Status GdipCreateBitmapFromResource(HINSTANCE instance, const WCHAR *name,
         *   GpBitmap **bitmap): the module's bitmap resource, through LoadBitmap.
         */
        GdipCreateBitmapFromResource: fn(12, ([instance, name, out])=>{
            if ((name >>> 0) === 0 || (out >>> 0) === 0 || !host.user32 || !host.gdi32)
            {
                return InvalidParameter;
            }
            const hbm = host.user32('LoadBitmapW', [instance, name]) >>> 0;
            if (hbm === 0)
            {
                return InvalidParameter;
            }
            const image = fromHbitmap(hbm);
            host.gdi32('DeleteObject', [hbm]);
            return image ? publish(image, out) : InvalidParameter;
        }),
        /** Status GdipBitmapGetHistogramSize(HistogramFormat format, UINT *entries): 256. */
        GdipBitmapGetHistogramSize: fn(8, ([, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, 256);
            return Ok;
        }),
        /**
         * Status GdipBitmapGetHistogram(GpBitmap *bitmap, HistogramFormat format,
         *   UINT entries, UINT *ch0, UINT *ch1, UINT *ch2, UINT *ch3)
         *
         * A count of each value of each channel the format names: A, R, G, B
         * (premultiplied for PARGB), R, G, B, grey, or one of them alone.
         */
        GdipBitmapGetHistogram: fn(28, onImage((image, [format, entries, ...channels])=>{
            const kind = format >>> 0;
            const needs = [4, 4, 3, 1, 1, 1, 1, 1][kind];
            if (needs === undefined || (entries >>> 0) !== 256
                || channels.slice(0, needs).some(c=>(c >>> 0) === 0)
                || channels.slice(needs).some(c=>(c >>> 0) !== 0))
            {
                return InvalidParameter;
            }
            const counts = Array.from({ length: needs }, ()=>new Uint32Array(256));
            const pixels = readBgra(image, 0, 0, image.width, image.height);
            for (let i = 0; i < pixels.length; i += 4)
            {
                const [b, g, r, a] = pixels.subarray(i, i + 4);
                /** @param {number} v */
                const pre = v=>Math.round(v * a / 255);
                const values = [[a, r, g, b], [a, pre(r), pre(g), pre(b)], [r, g, b],
                    [Math.round(0.299 * r + 0.587 * g + 0.114 * b)], [b], [g], [r], [a]][kind];
                values.forEach((v, c)=>counts[c][v]++);
            }
            counts.forEach((count, c)=>kit.write(channels[c], new Uint8Array(count.buffer)));
            return Ok;
        })),
    };

    /** @param {string} text */
    function guidBytes(text){
        return /** @type {Uint8Array} */ (parseGuid(text));
    }

    /**
     * The codecs into the caller's buffer: its count and size exactly those
     * the matching Size call answered, else GenericError.
     *
     * @param {import('./codecs.js').Codec[]} codecs @param {number} count
     * @param {number} size @param {number} out
     */
    function listCodecs(codecs, count, size, out){
        const bytes = codecInfos(codecs, out >>> 0, pointer, guidBytes);
        if ((out >>> 0) === 0 || (count >>> 0) !== codecs.length || (size >>> 0) !== bytes.length)
        {
            return GenericError;
        }
        kit.write(out, bytes);
        return Ok;
    }

    return {
        functions,
        get,
        readBgra,
        writeBgra,
        /**
         * A new bitmap of `format`, its handle; 0 when no memory was left.
         *
         * @param {number} width @param {number} height @param {number} format
         * @param {number} [dpiX] @param {number} [dpiY]
         */
        create: (width, height, format, dpiX = 96, dpiY = 96)=>{
            const image = makeBitmap(width, height, format);
            if (!image)
            {
                return 0;
            }
            image.dpiX = dpiX;
            image.dpiY = dpiY;
            return kit.add('image', image);
        },
        /** A copy of an image in memory of its own, its handle; 0 for none. @param {number} at */
        clone: at=>{
            const image = get(at);
            const copy = image && copyArea(image, 0, 0, image.width, image.height, image.format);
            return copy ? kit.add('image', copy) : 0;
        },
        /** @param {number} at */
        size: at=>{
            const image = get(at);
            return image ? { width: image.width, height: image.height } : null;
        },
    };
}
