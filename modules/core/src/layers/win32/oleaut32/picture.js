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

export const IID_IPICTURE = '{7BF80980-BF32-101A-8BBB-00AA00300CAB}';
export const IID_IPICTUREDISP = '{7BF80981-BF32-101A-8BBB-00AA00300CAB}';
export const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

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
const DIB_RGB_COLORS = 0;
const CBM_INIT = 4;
/** The header a StdPicture's persisted form starts with: "lt", then the size of what follows. */
const SAVED_PICTURE = 0x0000746c;
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
            invoke: ({ state }, [stream, , sizeOut])=>{
                if ((stream >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (!state.original)
                {
                    host.divergence?.('IPicture::SaveAsFile',
                        'a picture made from a handle is not written as a file', 'loss');
                    return E_FAIL;
                }
                const bytes = state.original;
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

    const interfaces = Object.freeze({
        [IID_IPICTURE]: PICTURE_METHODS,
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
            return fromBytes(bytes.subarray(8, 8 + size));
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
            // Compatible with the screen, as a picture is: a memory DC's own
            // bitmap is one bit deep.
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
            const bitmap = bitmapOf(image.width, image.height, image.bgra);
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
            return readStream(stream >>> 0, limit, host.callerThread()).then(bytes=>{
                if (!bytes)
                {
                    return E_OUTOFMEMORY;
                }
                const state = fromBytes(bytes);
                if (!state)
                {
                    host.divergence?.('OleLoadPicture', `${bytes.length} bytes that begin `
                        + `${[...bytes.subarray(0, 4)].map(b=>b.toString(16).padStart(2, '0'))
                            .join(' ')} make no picture here (BMP, JPEG, PNG, ICO, WMF and EMF`
                        + ' are read; GIF is not)', 'loss');
                    return CTL_E_INVALIDPICTURE;
                }
                return publish(state, iid, out);
            });
        },
    };
}
