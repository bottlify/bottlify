/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The standard picture object: what OleCreatePictureIndirect wraps around a
 * bitmap, an icon or a metafile a program already has, and what
 * OleLoadPicture makes out of the bytes of an image in a stream -- a BMP, a
 * JPEG, a PNG, an icon, a Windows or enhanced metafile, or any of them behind
 * the "lt" header a saved StdPicture carries.
 *
 * One object, IPicture and its dispinterface IPictureDisp. Its size is in
 * HIMETRIC (hundredths of a millimetre) at the screen's 96 pixels an inch,
 * and Render's source rectangle is in the same units with y running up, so
 * a program draws the whole picture upright by naming its height as the
 * source's top and minus its height as the source's height. A picture made
 * with fOwn gives back its handle when the last reference goes.
 */

import { after } from '../user32/controls.js';
import { decodeJpeg } from '../../media/internal/jpeg.js';
import { isPng, readPng } from '../d3dx9/png.js';
import { decodeGifFrames, isGif } from '../../media/internal/gif.js';

export const IID_IPICTURE = '{7BF80980-BF32-101A-8BBB-00AA00300CAB}';
export const IID_IPICTUREDISP = '{7BF80981-BF32-101A-8BBB-00AA00300CAB}';
export const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
const IID_IPERSISTSTREAM = '{00000109-0000-0000-C000-000000000046}';
/** CLSID_StdPicture {0BE35204-8F91-11CE-9DE3-00AA004BB851}, as its bytes. */
const CLSID_STDPICTURE_BYTES = Uint8Array.from([0x04, 0x52, 0xe3, 0x0b, 0x91, 0x8f, 0xce, 0x11,
    0x9d, 0xe3, 0x00, 0xaa, 0x00, 0x4b, 0xb8, 0x51]);

/** PICTYPE_*: what a picture holds. */
export const PICTYPE = Object.freeze({
    UNINITIALIZED: -1, NONE: 0, BITMAP: 1, METAFILE: 2, ICON: 3, ENHMETAFILE: 4,
});

const S_OK = 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_FAIL = 0x80004005 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const S_FALSE = 1;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** CTL_E_INVALIDPICTURE: bytes that are no picture this object can hold. */
export const CTL_E_INVALIDPICTURE = 0x800a01e1 | 0;
const DISP_E_MEMBERNOTFOUND = 0x80020003 | 0;
const DISP_E_UNKNOWNNAME = 0x80020006 | 0;
const DISP_E_BADINDEX = 0x8002000b | 0;
const DISP_E_BADPARAMCOUNT = 0x8002000e | 0;

/** get_Attributes' bits. */
const PICTURE_SCALABLE = 0x1;
const PICTURE_TRANSPARENT = 0x2;

/** The Picture dispinterface's members, by DISPID. */
const DISPIDS = new Map([['handle', 0], ['hpal', 2], ['type', 3], ['width', 4], ['height', 5],
    ['render', 6]]);
const DISPATCH_METHOD = 1;
const DISPATCH_PROPERTYGET = 2;
const DISPATCH_PROPERTYPUT = 4;
const VT_I2 = 2;
const VT_I4 = 3;
const VARIANT_BYTES = 16;

/** The screen's pixels an inch, and HIMETRIC units an inch. */
const PIXELS_PER_INCH = 96;
const HIMETRIC_PER_INCH = 2540;

const SRCCOPY = 0x00cc0020;
const DI_NORMAL = 3;
const SM_CXICON = 11;
const SM_CYICON = 12;
const BI_RGB = 0;
/** BI_BITFIELDS: uncompressed, with masks for the colours after the header. */
const BI_BITFIELDS = 3;
/** BI_RLE8 and BI_RLE4: runs of 8- and 4-bit indices. */
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const DIB_RGB_COLORS = 0;
const CBM_INIT = 4;
/** The header a StdPicture's persisted form starts with: "lt", then the size of what follows. */
const SAVED_PICTURE = 0x0000746c;
/** The header a saved picture starts with: the key and the size after it. */
const SAVED_HEADER = 8;
/** What readPicture answers for a saved picture with nothing in it. */
const EMPTY_PICTURE = Symbol('empty picture');
/** An Aldus placeable metafile's key, ahead of a Windows metafile and its 22-byte header. */
const PLACEABLE_KEY = 0x9ac6cdd7;
const PLACEABLE_HEADER = 22;
/** The most of a stream OleLoadPicture reads when it is not told how much: 64 MiB. */
const MOST_BYTES = 64 << 20;
const READ_PIECE = 0x10000;
/** IStream::Read, IStream::Write. */
const STREAM_READ = 3;
const STREAM_WRITE = 4;

/** @param {number} value */
const toHimetric = value=>Math.round(value * HIMETRIC_PER_INCH / PIXELS_PER_INCH);

/**
 * @typedef {Object} PictureState
 * @property {number} type          PICTYPE
 * @property {number} handle
 * @property {number} hpal
 * @property {number} width         HIMETRIC
 * @property {number} height        HIMETRIC
 * @property {number} pixelWidth    a bitmap's or an icon's own size; 0 for a metafile
 * @property {number} pixelHeight
 * @property {boolean} own          its handle is given back when the last reference goes
 * @property {boolean} keep         KeepOriginalFormat
 * @property {Uint8Array | null} original  the bytes it was loaded from
 * @property {number} curDC
 */

/**
 * @typedef {Object} PictureHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(name: string, args: number[]) => any} gdi32
 * @property {(name: string, args: number[]) => any} user32
 * @property {(object: any, interfaceId: string) => number} publish
 * @property {(state: PictureState, interfaces: Record<string, readonly any[]>,
 *     destroy: () => void) => any} adapt
 * @property {(entry: number, args: number[], thread?: unknown) => any} call
 * @property {() => unknown} callerThread
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/** @param {PictureHost} host */
export function createPictureObjects(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>
        host.writeMemory(address >>> 0, new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** @param {number} address @param {number} value */
    const writeU16 = (address, value)=>
        host.writeMemory(address >>> 0, new Uint8Array(new Uint16Array([value & 0xffff]).buffer));
    /**
     * Guest memory holding `bytes` while `use` runs, given back after; null
     * when there is none.
     *
     * @template T
     * @param {Uint8Array} bytes @param {(address: number) => T} use
     * @returns {T | null}
     */
    const lend = (bytes, use)=>{
        const at = host.allocate(Math.max(bytes.length, 4)) >>> 0;
        if (at === 0)
        {
            return null;
        }
        host.writeMemory(at, bytes);
        try
        {
            return use(at);
        }
        finally
        {
            host.free(at);
        }
    };

    /**
     * `lend` for a call whose answer may still be on its way: the memory is
     * given back once it has come.
     *
     * @param {Uint8Array} bytes @param {(address: number) => any} use
     * @returns {number | Promise<number>}
     */
    const lendUntil = (bytes, use)=>{
        const at = host.allocate(Math.max(bytes.length, 4)) >>> 0;
        if (at === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(at, bytes);
        let answer;
        try
        {
            answer = use(at);
        }
        catch (e){
            host.free(at);
            throw e;
        }
        return after(answer, value=>{
            host.free(at);
            return value | 0;
        });
    };

    /**
     * A bitmap's size in pixels, through GetObject's BITMAP.
     *
     * @param {number} bitmap @returns {{ width: number, height: number } | null}
     */
    const bitmapSize = bitmap=>lend(new Uint8Array(24), at=>{
        if ((host.gdi32('GetObjectW', [bitmap, 24, at]) | 0) === 0)
        {
            return null;
        }
        const words = new Int32Array(host.readMemory(at, 12).slice().buffer);
        return { width: words[1], height: Math.abs(words[2]) };
    });

    /**
     * A bitmap as a BMP file, at its own depth: the file header, a
     * BITMAPINFOHEADER and, for a depth with indices, its colour table, then
     * the bits bottom-up, all as GetDIBits gives them. Null when GDI cannot
     * read the bitmap.
     *
     * @param {number} bitmap @returns {Uint8Array | null}
     */
    const bitmapFile = bitmap=>lend(new Uint8Array(24), at=>{
        if ((host.gdi32('GetObjectW', [bitmap, 24, at]) | 0) === 0)
        {
            return null;
        }
        const object = new DataView(host.readMemory(at, 24).slice().buffer);
        const width = object.getInt32(4, true);
        const height = Math.abs(object.getInt32(8, true));
        const depth = object.getUint16(18, true) * object.getUint16(16, true);
        // A depth past a colour table's is written at 24 bits.
        const bitCount = depth <= 1 ? 1 : depth <= 4 ? 4 : depth <= 8 ? 8 : 24;
        const colours = bitCount <= 8 ? 1 << bitCount : 0;
        const stride = ((width * bitCount + 31) >>> 5) * 4;
        const infoBytes = 40 + colours * 4;
        const file = new Uint8Array(14 + infoBytes + stride * height);
        const view = new DataView(file.buffer);
        view.setUint16(0, 0x4d42, true);
        view.setUint32(2, file.length, true);
        view.setUint32(10, 14 + infoBytes, true);
        view.setUint32(14, 40, true);
        view.setInt32(18, width, true);
        view.setInt32(22, height, true);
        view.setUint16(26, 1, true);
        view.setUint16(28, bitCount, true);
        view.setUint32(34, stride * height, true);
        view.setUint32(46, colours, true);
        const filled = lend(file.subarray(14), info=>{
            const screen = host.user32('GetDC', [0]) >>> 0;
            const lines = host.gdi32('GetDIBits',
                [screen, bitmap, 0, height, info + infoBytes, info, DIB_RGB_COLORS]) | 0;
            host.user32('ReleaseDC', [0, screen]);
            return lines === 0 ? null : host.readMemory(info, file.length - 14).slice();
        });
        if (!filled)
        {
            return null;
        }
        file.set(filled, 14);
        // GetDIBits may write what it understood into the header; the file's
        // own counts stand.
        view.setUint32(14 + 32, colours, true);
        return file;
    });

    /**
     * An icon as an ICO file of one image: its colour bitmap as bitmapFile
     * writes it, the header's height doubled over the AND mask's rows after
     * the colour bits, as an icon resource keeps them. Null when GDI cannot
     * read it.
     *
     * @param {number} icon @returns {Uint8Array | null}
     */
    const iconFile = icon=>lend(new Uint8Array(20), at=>{
        if ((host.user32('GetIconInfo', [icon, at]) | 0) === 0)
        {
            return null;
        }
        const [, , , mask, colour] = new Uint32Array(host.readMemory(at, 20).slice().buffer);
        try
        {
            const image = bitmapFile(colour === 0 ? mask : colour);
            const size = bitmapSize(colour === 0 ? mask : colour);
            if (!image || !size)
            {
                return null;
            }
            const { width, height } = size;
            const maskStride = ((width + 31) >>> 5) * 4;
            const maskBits = colour === 0 ? new Uint8Array(0) : maskOf(mask, width, height);
            if (!maskBits)
            {
                return null;
            }
            const dib = image.subarray(14);
            const bitCount = new DataView(dib.buffer, dib.byteOffset, 40).getUint16(14, true);
            const length = dib.length + (colour === 0 ? 0 : maskStride * height);
            const file = new Uint8Array(22 + length);
            const view = new DataView(file.buffer);
            view.setUint16(2, 1, true);
            view.setUint16(4, 1, true);
            file[6] = width >= 256 ? 0 : width;
            file[7] = height >= 256 ? 0 : height;
            file[8] = bitCount < 8 ? 1 << bitCount : 0;
            view.setUint16(10, 1, true);
            view.setUint16(12, bitCount, true);
            view.setUint32(14, length, true);
            view.setUint32(18, 22, true);
            file.set(dib, 22);
            // The header names the colour rows and the mask's together.
            view.setInt32(22 + 8, height * 2, true);
            view.setUint32(22 + 20, 0, true);
            file.set(maskBits, 22 + dib.length);
            return file;
        }
        finally
        {
            host.gdi32('DeleteObject', [mask]);
            if (colour !== 0)
            {
                host.gdi32('DeleteObject', [colour]);
            }
        }
    });

    /**
     * A monochrome bitmap's rows, bottom-up, as a 1-bit DIB holds them.
     *
     * @param {number} bitmap @param {number} width @param {number} height
     * @returns {Uint8Array | null}
     */
    const maskOf = (bitmap, width, height)=>{
        const stride = ((width + 31) >>> 5) * 4;
        const info = new Uint8Array(48 + stride * height);
        const view = new DataView(info.buffer);
        view.setUint32(0, 40, true);
        view.setInt32(4, width, true);
        view.setInt32(8, height, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 1, true);
        return lend(info, at=>{
            const screen = host.user32('GetDC', [0]) >>> 0;
            const lines = host.gdi32('GetDIBits',
                [screen, bitmap, 0, height, at + 48, at, DIB_RGB_COLORS]) | 0;
            host.user32('ReleaseDC', [0, screen]);
            return lines === 0 ? null : host.readMemory(at + 48, stride * height).slice();
        });
    };

    /**
     * The file a picture made from a handle is written as: a bitmap's BMP,
     * an icon's ICO, an enhanced metafile's records; null for a kind with no
     * file form here.
     *
     * @param {PictureState} state @returns {Uint8Array | null}
     */
    const fileOfHandle = state=>{
        switch (state.type)
        {
            case PICTYPE.BITMAP:
                return bitmapFile(state.handle);
            case PICTYPE.ICON:
                return iconFile(state.handle);
            case PICTYPE.ENHMETAFILE:
                return enhancedBits(state.handle);
            default:
                return null;
        }
    };

    /**
     * An enhanced metafile's records, as a .emf file holds them; null when
     * GDI has none for the handle.
     *
     * @param {number} metafile @returns {Uint8Array | null}
     */
    const enhancedBits = metafile=>{
        const size = host.gdi32('GetEnhMetaFileBits', [metafile, 0, 0]) >>> 0;
        if (size === 0)
        {
            return null;
        }
        return lend(new Uint8Array(size), at=>((host.gdi32('GetEnhMetaFileBits',
            [metafile, size, at]) >>> 0) === size ? host.readMemory(at, size).slice() : null));
    };

    /**
     * An enhanced metafile's frame, which is in HIMETRIC already.
     *
     * @param {number} metafile @returns {{ width: number, height: number }}
     */
    const enhancedSize = metafile=>lend(new Uint8Array(100), at=>{
        if ((host.gdi32('GetEnhMetaFileHeader', [metafile, 100, at]) | 0) === 0)
        {
            return { width: 0, height: 0 };
        }
        const frame = new Int32Array(host.readMemory(at + 24, 16).slice().buffer);
        return { width: frame[2] - frame[0], height: frame[3] - frame[1] };
    }) ?? { width: 0, height: 0 };

    /** @param {PictureState} state */
    const destroy = state=>{
        if (!state.own || state.handle === 0)
        {
            return;
        }
        switch (state.type)
        {
            case PICTYPE.BITMAP:
                host.gdi32('DeleteObject', [state.handle]);
                break;
            case PICTYPE.ICON:
                host.user32('DestroyIcon', [state.handle]);
                break;
            case PICTYPE.METAFILE:
                host.gdi32('DeleteMetaFile', [state.handle]);
                break;
            case PICTYPE.ENHMETAFILE:
                host.gdi32('DeleteEnhMetaFile', [state.handle]);
                break;
            default:
                break;
        }
    };

    /**
     * Draws the picture's source rectangle, in HIMETRIC with y up, into
     * (x, y, cx, cy) of the DC.
     *
     * @param {PictureState} state @param {number[]} box
     * @returns {number | Promise<number>}
     */
    const render = (state, [hdc, x, y, cx, cy, xSrc, ySrc, cxSrc, cySrc])=>{
        if ((cx | 0) === 0 || (cy | 0) === 0 || (cxSrc | 0) === 0 || (cySrc | 0) === 0)
        {
            return E_INVALIDARG;
        }
        switch (state.type)
        {
            case PICTYPE.BITMAP:
            {
                const { pixelWidth: w, pixelHeight: h, width: hw, height: hh } = state;
                const xs = Math.round((xSrc | 0) * w / hw);
                const ys = Math.round((hh - (ySrc | 0)) * h / hh);
                const ws = Math.round((cxSrc | 0) * w / hw);
                const hs = Math.round(-(cySrc | 0) * h / hh);
                const memoryDc = host.gdi32('CreateCompatibleDC', [hdc]) >>> 0;
                if (memoryDc === 0)
                {
                    return E_FAIL;
                }
                const previous = host.gdi32('SelectObject', [memoryDc, state.handle]) >>> 0;
                return after(host.gdi32('StretchBlt', [hdc, x, y, cx, cy, memoryDc, xs, ys, ws, hs,
                    SRCCOPY]), ()=>{
                    host.gdi32('SelectObject', [memoryDc, previous]);
                    host.gdi32('DeleteDC', [memoryDc]);
                    return S_OK;
                });
            }
            case PICTYPE.ICON:
                return after(host.user32('DrawIconEx', [hdc, x, y, state.handle, cx, cy, 0, 0,
                    DI_NORMAL]), ()=>S_OK);
            case PICTYPE.ENHMETAFILE:
            {
                const rect = new Uint8Array(new Int32Array([x, y, (x | 0) + (cx | 0),
                    (y | 0) + (cy | 0)]).buffer);
                return after(lendUntil(rect, at=>host.gdi32('PlayEnhMetaFile',
                    [hdc, state.handle, at])), ()=>S_OK);
            }
            case PICTYPE.METAFILE:
                host.divergence?.('IPicture::Render',
                    'a Windows metafile is played at its own origin and size, not fitted to the'
                    + ' rectangle');
                return after(host.gdi32('PlayMetaFile', [hdc, state.handle]), ()=>S_OK);
            case PICTYPE.NONE:
                return S_OK;
            default:
                return E_FAIL;
        }
    };

    /**
     * IStream::Write of `bytes` whole.
     *
     * @param {number} stream @param {Uint8Array} bytes @param {unknown} thread
     * @returns {Promise<number> | number}
     */
    const writeStream = (stream, bytes, thread)=>{
        const entry = readU32(readU32(stream) + STREAM_WRITE * 4);
        return lendUntil(bytes, at=>host.call(entry, [stream, at, bytes.length, 0], thread));
    };

    /** @param {string} name @param {number} argBytes @param {(state: PictureState) => number} get */
    const getter = (name, argBytes, get)=>({
        name, argBytes,
        /** @param {{ state: PictureState }} object @param {number[]} args */
        invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, get(object.state));
            return S_OK;
        },
    });

    const IUNKNOWN = [
        { name: 'QueryInterface', argBytes: 12, builtin: 'queryInterface' },
        { name: 'AddRef', argBytes: 4, builtin: 'addRef' },
        { name: 'Release', argBytes: 4, builtin: 'release' },
    ];

    const PICTURE_METHODS = Object.freeze([
        ...IUNKNOWN,
        getter('get_Handle', 8, state=>state.handle),
        { name: 'get_hPal', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (state.type !== PICTYPE.BITMAP && state.type !== PICTYPE.NONE
                    && state.type !== PICTYPE.UNINITIALIZED)
                {
                    return E_FAIL;
                }
                writeU32(out, state.hpal);
                return S_OK;
            } },
        { name: 'get_Type', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU16(out, state.type);
                return S_OK;
            } },
        getter('get_Width', 8, state=>state.width),
        getter('get_Height', 8, state=>state.height),
        { name: 'Render', argBytes: 44,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, args)=>render(state, args) },
        { name: 'set_hPal', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [palette])=>{
                if (state.type !== PICTYPE.BITMAP)
                {
                    return E_FAIL;
                }
                state.hpal = palette >>> 0;
                return S_OK;
            } },
        getter('get_CurDC', 8, state=>state.curDC),
        { name: 'SelectPicture', argBytes: 16,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [hdc, dcOut, bitmapOut])=>{
                if (state.type !== PICTYPE.BITMAP)
                {
                    return E_FAIL;
                }
                if ((dcOut >>> 0) !== 0)
                {
                    writeU32(dcOut, state.curDC);
                }
                host.gdi32('SelectObject', [hdc, state.handle]);
                state.curDC = hdc >>> 0;
                if ((bitmapOut >>> 0) !== 0)
                {
                    writeU32(bitmapOut, state.handle);
                }
                return S_OK;
            } },
        { name: 'get_KeepOriginalFormat', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, state.keep ? 1 : 0);
                return S_OK;
            } },
        { name: 'put_KeepOriginalFormat', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [keep])=>{
                state.keep = (keep >>> 0) !== 0;
                return S_OK;
            } },
        { name: 'PictureChanged', argBytes: 4, invoke: ()=>S_OK },
        { name: 'SaveAsFile', argBytes: 16,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [stream, saveCopy, sizeOut])=>{
                if ((stream >>> 0) === 0)
                {
                    return E_POINTER;
                }
                // A picture made from a handle has no file of its own; it is
                // written as one only when the caller asks for a copy in memory.
                const bytes = state.original
                    ?? ((saveCopy >>> 0) !== 0 ? fileOfHandle(state) : null);
                if (!bytes)
                {
                    host.divergence?.('IPicture::SaveAsFile', `a picture of type ${state.type}`
                        + ' made from a handle is not written as a file', 'loss');
                    return E_FAIL;
                }
                return after(writeStream(stream, bytes, host.callerThread()), hr=>{
                    if ((hr | 0) >= 0 && (sizeOut >>> 0) !== 0)
                    {
                        writeU32(sizeOut, bytes.length);
                    }
                    return hr | 0;
                });
            } },
        { name: 'get_Attributes', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, state.type === PICTYPE.ICON ? PICTURE_TRANSPARENT
                    : state.type === PICTYPE.METAFILE || state.type === PICTYPE.ENHMETAFILE
                        ? PICTURE_SCALABLE | PICTURE_TRANSPARENT : 0);
                return S_OK;
            } },
    ]);

    /** @param {number} address @returns {string} */
    const readWide = address=>{
        let text = '';
        for (let at = address >>> 0; text.length < 256; at += 2)
        {
            const [low, high] = host.readMemory(at, 2);
            if ((low | high) === 0)
            {
                break;
            }
            text += String.fromCharCode(low | high << 8);
        }
        return text;
    };

    const DISPATCH_METHODS = Object.freeze([
        ...IUNKNOWN,
        { name: 'GetTypeInfoCount', argBytes: 8,
            /** @param {unknown} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                return S_OK;
            } },
        { name: 'GetTypeInfo', argBytes: 16, invoke: ()=>DISP_E_BADINDEX },
        { name: 'GetIDsOfNames', argBytes: 24,
            /** @param {unknown} object @param {number[]} args */
            invoke: (object, [, names, count, , out])=>{
                let hr = S_OK;
                for (let index = 0; index < (count >>> 0); index++)
                {
                    const name = readWide(readU32(names + index * 4)).toLowerCase();
                    const id = index === 0 ? DISPIDS.get(name) : undefined;
                    writeU32(out + index * 4, id ?? -1);
                    if (id === undefined)
                    {
                        hr = DISP_E_UNKNOWNNAME;
                    }
                }
                return hr;
            } },
        { name: 'Invoke', argBytes: 36,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [member, , , flags, params, result])=>{
                const id = member | 0;
                if ((flags & DISPATCH_PROPERTYGET) !== 0 && [0, 2, 3, 4, 5].includes(id))
                {
                    if ((result >>> 0) === 0)
                    {
                        return S_OK;
                    }
                    const value = id === 0 ? state.handle : id === 2 ? state.hpal
                        : id === 3 ? state.type : id === 4 ? state.width : state.height;
                    const variant = new Uint8Array(VARIANT_BYTES);
                    const view = new DataView(variant.buffer);
                    view.setUint16(0, id === 3 ? VT_I2 : VT_I4, true);
                    view.setInt32(8, value | 0, true);
                    host.writeMemory(result >>> 0, variant);
                    return S_OK;
                }
                if ((flags & DISPATCH_PROPERTYPUT) !== 0 && id === 2)
                {
                    // DISPPARAMS: rgvarg, rgdispidNamedArgs, cArgs, cNamedArgs.
                    if ((params >>> 0) === 0 || readU32(params + 8) < 1
                        || state.type !== PICTYPE.BITMAP)
                    {
                        return (params >>> 0) === 0 ? E_INVALIDARG : DISP_E_BADPARAMCOUNT;
                    }
                    state.hpal = readU32(readU32(params) + 8);
                    return S_OK;
                }
                if ((flags & DISPATCH_METHOD) !== 0 && id === 6)
                {
                    host.divergence?.('IPictureDisp::Invoke',
                        'Render is called through IPicture, not through the dispinterface');
                }
                return DISP_E_MEMBERNOTFOUND;
            } },
    ]);

    /**
     * The bytes IPersistStream::Save writes after its header: the image the
     * picture was read from, or a bitmap's as a BMP file; empty for an empty
     * picture, null for one that has no file form here.
     *
     * @param {PictureState} state @returns {Uint8Array | null}
     */
    const savedBytes = state=>state.original
        ?? (state.type === PICTYPE.NONE || state.type === PICTYPE.UNINITIALIZED
            ? new Uint8Array(0) : fileOfHandle(state));

    const PERSIST_STREAM_METHODS = Object.freeze([
        ...IUNKNOWN,
        { name: 'GetClassID', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writeMemory(out >>> 0, CLSID_STDPICTURE_BYTES);
                return S_OK;
            } },
        { name: 'IsDirty', argBytes: 4, invoke: ()=>S_FALSE },
        { name: 'Load', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [stream])=>{
                if ((stream >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return readPicture(stream >>> 0, MOST_BYTES, host.callerThread()).then(bytes=>{
                    const loaded = bytes === EMPTY_PICTURE ? made(PICTYPE.NONE, 0)
                        : bytes ? fromBytes(bytes) : null;
                    if (!loaded)
                    {
                        return bytes ? CTL_E_INVALIDPICTURE : E_FAIL;
                    }
                    destroy(state);
                    Object.assign(state, loaded);
                    return S_OK;
                });
            } },
        { name: 'Save', argBytes: 12,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [stream])=>{
                if ((stream >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const bytes = savedBytes(state);
                if (!bytes)
                {
                    host.divergence?.('IPersistStream::Save', `a picture of type ${state.type}`
                        + ' is not written as a file', 'loss');
                    return E_FAIL;
                }
                const saved = new Uint8Array(SAVED_HEADER + bytes.length);
                const view = new DataView(saved.buffer);
                view.setUint32(0, SAVED_PICTURE, true);
                view.setUint32(4, bytes.length, true);
                saved.set(bytes, SAVED_HEADER);
                return after(writeStream(stream >>> 0, saved, host.callerThread()), hr=>hr | 0);
            } },
        { name: 'GetSizeMax', argBytes: 8,
            /** @param {{ state: PictureState }} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = savedBytes(state);
                if (!bytes)
                {
                    return E_FAIL;
                }
                writeU32(out >>> 0, SAVED_HEADER + bytes.length);
                writeU32((out >>> 0) + 4, 0);
                return S_OK;
            } },
    ]);

    const interfaces = Object.freeze({
        [IID_IPICTURE]: PICTURE_METHODS,
        [IID_IPERSISTSTREAM]: PERSIST_STREAM_METHODS,
        [IID_IPERSIST]: PERSIST_STREAM_METHODS,
        [IID_IPICTUREDISP]: DISPATCH_METHODS,
        [IID_IDISPATCH]: DISPATCH_METHODS,
    });

    /**
     * Publishes a picture as the interface asked for: IUnknown, IPicture,
     * IPictureDisp or IDispatch; anything else is E_NOINTERFACE, and the
     * picture goes (its handle with it, if it owns one).
     *
     * @param {PictureState} state @param {string} iid @param {number} out
     */
    const publish = (state, iid, out)=>{
        if (iid !== IID_IUNKNOWN && !(iid in interfaces))
        {
            writeU32(out, 0);
            destroy(state);
            return E_NOINTERFACE;
        }
        const adapter = host.adapt(state, interfaces, ()=>destroy(state));
        const pointer = host.publish(adapter, iid === IID_IUNKNOWN ? IID_IPICTURE : iid) >>> 0;
        writeU32(out, pointer);
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /**
     * @param {number} type @param {number} handle
     * @returns {PictureState}
     */
    const made = (type, handle)=>({ type, handle: handle >>> 0, hpal: 0, width: 0, height: 0,
        pixelWidth: 0, pixelHeight: 0, own: false, keep: true, original: null, curDC: 0 });

    /** @param {PictureState} state @param {number} width @param {number} height */
    const sized = (state, width, height)=>{
        state.pixelWidth = width;
        state.pixelHeight = height;
        state.width = toHimetric(width);
        state.height = toHimetric(height);
        return state;
    };

    /** @param {number} icon */
    const iconPicture = icon=>sized(made(PICTYPE.ICON, icon),
        host.user32('GetSystemMetrics', [SM_CXICON]) | 0 || 32,
        host.user32('GetSystemMetrics', [SM_CYICON]) | 0 || 32);

    /**
     * A picture over what a PICTDESC names; null for a type it has none of.
     *
     * @param {number} desc
     * @returns {PictureState | null}
     */
    const fromDescription = desc=>{
        if ((desc >>> 0) === 0)
        {
            return made(PICTYPE.UNINITIALIZED, 0);
        }
        const type = readU32(desc + 4) | 0;
        const handle = readU32(desc + 8);
        switch (type)
        {
            case PICTYPE.UNINITIALIZED:
            case PICTYPE.NONE:
                return made(type, 0);
            case PICTYPE.BITMAP:
            {
                const state = made(type, handle);
                state.hpal = readU32(desc + 12);
                const size = bitmapSize(handle);
                return size ? sized(state, size.width, size.height) : state;
            }
            case PICTYPE.ICON:
                return iconPicture(handle);
            case PICTYPE.METAFILE:
            {
                const state = made(type, handle);
                state.width = readU32(desc + 12) | 0;
                state.height = readU32(desc + 16) | 0;
                return state;
            }
            case PICTYPE.ENHMETAFILE:
            {
                const state = made(type, handle);
                const size = enhancedSize(handle);
                state.width = size.width;
                state.height = size.height;
                return state;
            }
            default:
                return null;
        }
    };

    /**
     * A bitmap of 32-bit pixels, top row first, BGRA, as a DIB section.
     *
     * @param {number} width @param {number} height @param {Uint8Array} bgra
     * @returns {number} the HBITMAP, 0 when it could not be made
     */
    const bitmapOf = (width, height, bgra)=>lend(new Uint8Array(48), info=>{
        host.writeMemory(info, new Uint8Array(new Int32Array([40, width, -height,
            32 << 16 | 1, BI_RGB, 0, 0, 0, 0, 0, 0]).buffer));
        const bitmap = host.gdi32('CreateDIBSection', [0, info, DIB_RGB_COLORS, info + 44, 0, 0])
            >>> 0;
        const bits = bitmap === 0 ? 0 : readU32(info + 44);
        if (bits !== 0)
        {
            host.writeMemory(bits, bgra);
        }
        return bitmap;
    }) ?? 0;

    /**
     * A DIB section over a packed DIB - a BITMAPINFO and, `offset` bytes from
     * its start, the bits - with the bits copied in; 0 for a format a DIB
     * section cannot hold (run-length encoded) or bits the bytes do not have.
     *
     * @param {Uint8Array} dib @param {number} offset
     * @returns {number} the HBITMAP, or 0
     */
    const dibSectionOf = (dib, offset)=>{
        if (dib.length < 40)
        {
            return 0;
        }
        const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
        const width = view.getInt32(4, true);
        const height = Math.abs(view.getInt32(8, true));
        const depth = view.getUint16(14, true);
        const compression = view.getUint32(16, true);
        if (view.getUint32(0, true) < 40)
        {
            return 0;
        }
        if ((compression === BI_RLE8 && depth === 8) || (compression === BI_RLE4 && depth === 4))
        {
            return expandedSectionOf(dib, offset);
        }
        if (compression !== BI_RGB && compression !== BI_BITFIELDS)
        {
            return 0;
        }
        const length = ((width * depth + 31) >>> 5) * 4 * height;
        if (offset < 0 || offset + length > dib.length)
        {
            return 0;
        }
        const header = new Uint8Array(offset + 4);
        header.set(dib.subarray(0, offset));
        return lend(header, info=>{
            const bitmap = host.gdi32('CreateDIBSection',
                [0, info, DIB_RGB_COLORS, info + offset, 0, 0]) >>> 0;
            const bits = bitmap === 0 ? 0 : readU32(info + offset);
            if (bits !== 0)
            {
                host.writeMemory(bits, dib.subarray(offset, offset + length));
            }
            return bitmap;
        }) ?? 0;
    };

    /**
     * An uncompressed DIB section of a run-length encoded DIB's depth and
     * colours, its rows expanded into it by SetDIBits, which reads the runs.
     *
     * @param {Uint8Array} dib @param {number} offset  where the runs start
     * @returns {number} the HBITMAP, or 0
     */
    const expandedSectionOf = (dib, offset)=>{
        const header = new Uint8Array(offset + 4);
        header.set(dib.subarray(0, offset));
        const plain = new DataView(header.buffer);
        plain.setUint32(16, BI_RGB, true);
        plain.setUint32(20, 0, true);
        const bitmap = lend(header, info=>host.gdi32('CreateDIBSection',
            [0, info, DIB_RGB_COLORS, info + offset, 0, 0]) >>> 0) ?? 0;
        if (bitmap === 0)
        {
            return 0;
        }
        const rows = Math.abs(new DataView(dib.buffer, dib.byteOffset, 12).getInt32(8, true));
        const screen = host.user32('GetDC', [0]) >>> 0;
        const copied = lend(dib, info=>host.gdi32('SetDIBits',
            [screen, bitmap, 0, rows, info + offset, info, DIB_RGB_COLORS]) >>> 0) ?? 0;
        host.user32('ReleaseDC', [0, screen]);
        if (copied === 0)
        {
            host.gdi32('DeleteObject', [bitmap]);
            return 0;
        }
        return bitmap;
    };

    /**
     * A bottom-up 24-bit DIB section of pixels given top row first as BGRA.
     *
     * @param {number} width @param {number} height @param {Uint8Array} bgra
     * @returns {number} the HBITMAP, or 0
     */
    const rgbSectionOf = (width, height, bgra)=>{
        const stride = ((width * 24 + 31) >>> 5) * 4;
        const dib = new Uint8Array(40 + stride * height);
        const view = new DataView(dib.buffer);
        view.setUint32(0, 40, true);
        view.setInt32(4, width, true);
        view.setInt32(8, height, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 24, true);
        for (let y = 0; y < height; y++)
        {
            const row = 40 + (height - 1 - y) * stride;
            for (let x = 0; x < width; x++)
            {
                dib.set(bgra.subarray((y * width + x) * 4, (y * width + x) * 4 + 3), row + x * 3);
            }
        }
        return dibSectionOf(dib, 40);
    };

    /**
     * A bottom-up DIB section of colour indices, top row first in `indices`,
     * with an RGB triplet table: 1, 4 or 8 bits a pixel, the fewest that hold
     * every entry of the table.
     *
     * @param {number} width @param {number} height
     * @param {Uint8Array} indices @param {Uint8Array} table
     * @returns {number} the HBITMAP, or 0
     */
    const indexedSectionOf = (width, height, indices, table)=>{
        const entries = Math.min(256, Math.max(1, Math.floor(table.length / 3)));
        const depth = entries <= 2 ? 1 : entries <= 16 ? 4 : 8;
        const stride = ((width * depth + 31) >>> 5) * 4;
        const dib = new Uint8Array(40 + entries * 4 + stride * height);
        const view = new DataView(dib.buffer);
        view.setUint32(0, 40, true);
        view.setInt32(4, width, true);
        view.setInt32(8, height, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, depth, true);
        view.setUint32(32, entries, true);
        for (let entry = 0; entry < entries; entry++)
        {
            dib[40 + entry * 4] = table[entry * 3 + 2];
            dib[40 + entry * 4 + 1] = table[entry * 3 + 1];
            dib[40 + entry * 4 + 2] = table[entry * 3];
        }
        const bits = 40 + entries * 4;
        for (let y = 0; y < height; y++)
        {
            const row = bits + (height - 1 - y) * stride;
            for (let x = 0; x < width; x++)
            {
                const index = indices[y * width + x] & ((1 << depth) - 1);
                const bit = x * depth;
                dib[row + (bit >>> 3)] |= index << (8 - depth - (bit & 7));
            }
        }
        return dibSectionOf(dib, bits);
    };

    /**
     * What OleLoadPicture makes of an image's bytes.
     *
     * @param {Uint8Array} bytes
     * @returns {PictureState | null}  null for bytes no picture is made of
     */
    const fromBytes = bytes=>{
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length >= 8 && view.getUint32(0, true) === SAVED_PICTURE)
        {
            const size = view.getUint32(4, true);
            // A picture saved with nothing in it is an empty picture, as
            // IPersistStream::Save writes one of PICTYPE_NONE.
            return size === 0 ? made(PICTYPE.NONE, 0)
                : fromBytes(bytes.subarray(8, 8 + size));
        }
        const keep = (/** @type {PictureState | null} */ state)=>{
            if (state)
            {
                state.original = bytes.slice();
                state.own = true;
            }
            return state;
        };
        if (bytes.length >= 54 && bytes[0] === 0x42 && bytes[1] === 0x4d)
        {
            // BITMAPFILEHEADER, then the BITMAPINFO and the bits it names.
            const offset = view.getUint32(10, true);
            const width = view.getInt32(18, true);
            const height = Math.abs(view.getInt32(22, true));
            // A DIB section of the file's own format and colours, as Windows
            // keeps a bitmap it reads; a compressed one, which a DIB section
            // cannot hold, is drawn into one compatible with the screen.
            const section = dibSectionOf(bytes.subarray(14), offset - 14);
            if (section !== 0)
            {
                return keep(sized(made(PICTYPE.BITMAP, section), width, height));
            }
            const screen = host.user32('GetDC', [0]) >>> 0;
            const bitmap = lend(bytes.subarray(14), info=>host.gdi32('CreateDIBitmap', [
                screen, info, CBM_INIT, info + offset - 14, info, DIB_RGB_COLORS]) >>> 0) ?? 0;
            host.user32('ReleaseDC', [0, screen]);
            return bitmap === 0 ? null : keep(sized(made(PICTYPE.BITMAP, bitmap), width, height));
        }
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)
        {
            const image = decodeImage(()=>decodeJpeg(bytes));
            if (!image)
            {
                return null;
            }
            // A JPEG's picture is a 24-bit DIB section, the depth of its samples.
            const bitmap = rgbSectionOf(image.width, image.height, image.bgra);
            return bitmap === 0 ? null
                : keep(sized(made(PICTYPE.BITMAP, bitmap), image.width, image.height));
        }
        if (isPng(bytes))
        {
            let png;
            try
            {
                png = readPng(bytes);
            }
            catch {
                return null;
            }
            const bitmap = bitmapOf(png.width, png.height, png.bgra);
            return bitmap === 0 ? null
                : keep(sized(made(PICTYPE.BITMAP, bitmap), png.width, png.height));
        }
        if (isGif(bytes))
        {
            // An indexed DIB section of the first image, as deep as its colour
            // table needs (1, 4 or 8 bits) and with that table.
            let frame;
            try
            {
                [frame] = decodeGifFrames(bytes).frames;
            }
            catch {
                return null;
            }
            if (!frame)
            {
                return null;
            }
            const section = indexedSectionOf(frame.width, frame.height, frame.indices, frame.table);
            return section === 0 ? null
                : keep(sized(made(PICTYPE.BITMAP, section), frame.width, frame.height));
        }
        if (bytes.length >= 22 && view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1
            && view.getUint16(4, true) >= 1)
        {
            // ICONDIR, then the first ICONDIRENTRY: the image's size and where it is.
            const size = view.getUint32(14, true);
            const at = view.getUint32(18, true);
            const icon = lend(bytes.subarray(at, at + size), image=>host.user32(
                'CreateIconFromResourceEx', [image, size, 1, 0x00030000, 0, 0, 0]) >>> 0) ?? 0;
            return icon === 0 ? null : keep(iconPicture(icon));
        }
        if (bytes.length >= PLACEABLE_HEADER && view.getUint32(0, true) === PLACEABLE_KEY)
        {
            // The placeable header's bounding box, in its own units an inch.
            const box = [6, 8, 10, 12].map(at=>view.getInt16(at, true));
            const unitsPerInch = view.getUint16(14, true) || 1440;
            const body = bytes.subarray(PLACEABLE_HEADER);
            const metafile = lend(body, at=>host.gdi32('SetMetaFileBitsEx', [body.length, at])
                >>> 0) ?? 0;
            if (metafile === 0)
            {
                return null;
            }
            const state = made(PICTYPE.METAFILE, metafile);
            state.width = Math.round((box[2] - box[0]) * HIMETRIC_PER_INCH / unitsPerInch);
            state.height = Math.round((box[3] - box[1]) * HIMETRIC_PER_INCH / unitsPerInch);
            return keep(state);
        }
        if (bytes.length >= 44 && view.getUint32(0, true) === 1
            && view.getUint32(40, true) === 0x464d4520)
        {
            const metafile = lend(bytes, at=>host.gdi32('SetEnhMetaFileBits', [bytes.length, at])
                >>> 0) ?? 0;
            if (metafile === 0)
            {
                return null;
            }
            const state = made(PICTYPE.ENHMETAFILE, metafile);
            const size = enhancedSize(metafile);
            state.width = size.width;
            state.height = size.height;
            return keep(state);
        }
        return null;
    };

    /**
     * A JPEG's pixels as BGRA, its components made colour as JFIF and Adobe say.
     *
     * @param {() => any} decode
     * @returns {{ width: number, height: number, bgra: Uint8Array } | null}
     */
    const decodeImage = decode=>{
        let image;
        try
        {
            image = decode();
        }
        catch {
            return null;
        }
        const { width, height, components: n, samples } = image;
        const clamp = (/** @type {number} */ v)=>Math.max(0, Math.min(255, Math.round(v)));
        const ycc = n === 3 ? !image.adobe || image.transform === 1
            : n === 4 && image.transform === 2;
        const bgra = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++)
        {
            const at = i * n;
            let [r, g, b] = n < 3 ? [samples[at], samples[at], samples[at]]
                : [samples[at], samples[at + 1], samples[at + 2]];
            if (ycc)
            {
                const [y, cb, cr] = [r, g - 128, b - 128];
                [r, g, b] = [clamp(y + 1.402 * cr), clamp(y - 0.344136 * cb - 0.714136 * cr),
                    clamp(y + 1.772 * cb)];
            }
            if (n === 4)
            {
                const k = samples[at + 3];
                [r, g, b] = [r * k / 255, g * k / 255, b * k / 255].map(clamp);
            }
            bgra.set([b, g, r, 255], i * 4);
        }
        return { width, height, bgra };
    };

    /**
     * Everything a stream has from its position, up to `limit` bytes,
     * through its own Read.
     *
     * @param {number} stream @param {number} limit @param {unknown} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const readStream = async(stream, limit, thread)=>{
        const block = host.allocate(READ_PIECE + 4) >>> 0;
        if (block === 0)
        {
            return null;
        }
        try
        {
            const read = readU32(readU32(stream) + STREAM_READ * 4);
            /** @type {Uint8Array[]} */
            const pieces = [];
            let total = 0;
            while (total < limit)
            {
                const wanted = Math.min(READ_PIECE, limit - total);
                writeU32(block + READ_PIECE, 0);
                const hr = (await host.call(read, [stream, block, wanted, block + READ_PIECE],
                    thread)) | 0;
                const count = hr < 0 ? 0 : Math.min(readU32(block + READ_PIECE), wanted);
                pieces.push(host.readMemory(block, count).slice());
                total += count;
                if (hr < 0 || count < wanted)
                {
                    break;
                }
            }
            const bytes = new Uint8Array(total);
            let at = 0;
            for (const piece of pieces)
            {
                bytes.set(piece, at);
                at += piece.length;
            }
            return bytes;
        }
        finally
        {
            host.free(block);
        }
    };

    /**
     * The image a stream holds from where it stands. A picture IPersistStream
     * saved starts with a header - "lt" and the size of what follows - and
     * that size, not the caller's, says how much is the picture; headers one
     * after another are read past to the last, and one that says nothing
     * follows is an empty picture. Bytes with no header are the image, the
     * caller's size of them.
     *
     * @param {number} stream @param {number} limit @param {unknown} thread
     * @returns {Promise<Uint8Array | null | typeof EMPTY_PICTURE>}
     */
    const readPicture = async(stream, limit, thread)=>{
        let head = await readStream(stream, Math.min(SAVED_HEADER, limit), thread);
        let size = -1;
        while (head && head.length === SAVED_HEADER
            && new DataView(head.buffer, head.byteOffset, 8).getUint32(0, true) === SAVED_PICTURE)
        {
            size = new DataView(head.buffer, head.byteOffset, 8).getUint32(4, true);
            if (size === 0)
            {
                return EMPTY_PICTURE;
            }
            head = await readStream(stream, Math.min(SAVED_HEADER, size), thread);
        }
        if (!head)
        {
            return null;
        }
        const total = size >= 0 ? size : limit;
        const rest = total > head.length
            ? await readStream(stream, total - head.length, thread) : new Uint8Array(0);
        if (!rest)
        {
            return null;
        }
        const bytes = new Uint8Array(head.length + rest.length);
        bytes.set(head);
        bytes.set(rest, head.length);
        return bytes;
    };

    return {
        /**
         * OleCreatePictureIndirect's work: the picture over a PICTDESC (NULL for
         * an uninitialised one), published as `iid` into `out`.
         *
         * @param {number} desc @param {string} iid @param {boolean} own @param {number} out
         * @returns {number} the HRESULT
         */
        create(desc, iid, own, out){
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            if ((desc >>> 0) !== 0 && readU32(desc) < 12)
            {
                return E_INVALIDARG;
            }
            const state = fromDescription(desc);
            if (!state)
            {
                return E_UNEXPECTED;
            }
            state.own = own;
            return publish(state, iid, out);
        },

        /**
         * The picture a file's bytes make, saved headers read past as from a
         * stream (OleLoadPicturePath's work once the file is read).
         *
         * @param {Uint8Array} bytes @param {string} iid @param {number} out
         * @returns {number} the HRESULT
         */
        fromFile(bytes, iid, out){
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            let image = bytes;
            while (image.length >= SAVED_HEADER && new DataView(image.buffer, image.byteOffset, 8)
                .getUint32(0, true) === SAVED_PICTURE)
            {
                const size = new DataView(image.buffer, image.byteOffset, 8).getUint32(4, true);
                if (size === 0)
                {
                    return publish(made(PICTYPE.NONE, 0), iid, out);
                }
                image = image.subarray(SAVED_HEADER, SAVED_HEADER + size);
            }
            const state = fromBytes(image);
            return state ? publish(state, iid, out) : CTL_E_INVALIDPICTURE;
        },

        /**
         * OleLoadPicture's work: the picture a stream's image makes, read from
         * its position, `size` bytes of it or what it has when that is 0.
         *
         * @param {number} stream @param {number} size @param {string} iid @param {number} out
         * @returns {number | Promise<number>} the HRESULT
         */
        load(stream, size, iid, out){
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            if ((stream >>> 0) === 0)
            {
                return E_POINTER;
            }
            const limit = (size | 0) > 0 ? size | 0 : MOST_BYTES;
            return readPicture(stream >>> 0, limit, host.callerThread()).then(bytes=>{
                if (bytes === EMPTY_PICTURE)
                {
                    return publish(made(PICTYPE.NONE, 0), iid, out);
                }
                if (!bytes)
                {
                    return E_OUTOFMEMORY;
                }
                const state = fromBytes(bytes);
                if (!state)
                {
                    host.divergence?.('OleLoadPicture', `${bytes.length} bytes that begin `
                        + `${[...bytes.subarray(0, 4)].map(b=>b.toString(16).padStart(2, '0'))
                            .join(' ')} make no picture here (BMP, JPEG, PNG, GIF, ICO, WMF and EMF`
                        + ' are read)', 'loss');
                    return CTL_E_INVALIDPICTURE;
                }
                return publish(state, iid, out);
            });
        },
    };
}
