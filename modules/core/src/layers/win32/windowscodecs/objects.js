/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WIC's objects: the imaging factory and what it makes - decoders and their
 * frames, bitmaps and their locks, palettes, format converters, scalers,
 * clippers, flip-rotators, streams and colour contexts. Every bitmap source
 * among them is a Source (sources.js); a source, stream or palette the
 * program implemented is reached through its vtable.
 *
 * A bitmap's pixels live in guest memory, since its lock hands out a pointer
 * into them. A decoder reads its whole stream when initialized and decodes
 * every frame then (frames.js); what Windows defers to CopyPixels it does at
 * once, which changes nothing a program can observe but when the work is
 * done. Encoders, metadata readers and writers and colour transforms are not
 * provided: refused with the HRESULT Windows gives for a component it does
 * not have, and said through the divergence reporter.
 */

import { CodecError, CONTAINERS, WINCODEC, sniff } from './frames.js';
import { defaultConverts, formatOf, rowBytes } from './formats.js';
import { GUID, INTERFACES } from './layout.js';
import { PALETTE_TYPE, medianCut, predefinedPalette } from './palettes.js';
import { bgraOf, checkedRect, clippedSource, conversionOf, convertedSource, flippedSource,
    guestSource, heldSource, scaledSource, withBlock } from './sources.js';
import { E_INVALIDARG, E_NOTIMPL, E_OUTOFMEMORY, S_OK, createKit } from './kit.js';
import { createInfos } from './info.js';

/** @typedef {import('./sources.js').Source} Source */
/** @typedef {import('../ole32/objects.js').ComObject} ComObject */

/** CLSIDs of objects of ours no program creates by CLSID. */
const CLSID = Object.freeze({
    BITMAP: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E901}',
    LOCK: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E902}',
    PALETTE: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E903}',
    FRAME: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E904}',
    SCALER: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E905}',
    CLIPPER: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E906}',
    FLIP_ROTATOR: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E907}',
    STREAM: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E908}',
    COLOR_CONTEXT: '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E909}',
});

/** CLSID_WICImagingFactory2, which wincodec.h's IDL names beside the first. */
export const CLSID_IMAGING_FACTORY2 = '{317D06E8-5F24-433D-BDF7-79CE68D8ABC2}';

const STREAM_SEEK = Object.freeze({ SET: 0, CUR: 1, END: 2 });
const STG_E_INVALIDFUNCTION = 0x80030001 | 0;
const STG_E_MEDIUMFULL = 0x80030070 | 0;
const STG_E_ACCESSDENIED = 0x80030005 | 0;
const ERROR_FILE_NOT_FOUND = 0x80070002 | 0;
const ERROR_ARITHMETIC_OVERFLOW = 0x80070216 | 0;
const WICBitmapDecoderCapabilityCanDecodeAllImages = 2;
const READ_CHUNK = 0x10000;

/** @param {import('./kit.js').CodecsHost} host */
export function createCodecs(host){
    const kit = createKit(host);
    const { make, hand, u32, putU32, putF64, f64, guid, putGuid, rect, method, diverge } = kit;
    const access = { readMemory: host.readMemory, writeMemory: host.writeMemory,
        heap: host.heap, method };
    const thread = ()=>host.currentThread();

    /** @param {number} pointer @returns {ComObject | null} */
    const ours = pointer=>{
        const object = pointer === 0 ? null : host.objectAt(pointer >>> 0);
        return object && typeof object === 'object' && 'state' in object ? object : null;
    };

    // ---- holding what an object was given -------------------------------

    /**
     * A reference an object keeps on another it was handed: AddRef now, and
     * Release when it goes (lastRelease, on the program's thread).
     *
     * @typedef {{ object: ComObject | null, pointer: number }} Held
     */

    /** @param {Held[]} held @param {number} pointer @param {unknown} caller */
    const hold = async(held, pointer, caller)=>{
        const object = ours(pointer);
        if (object)
        {
            object.addRef();
        }
        else
        {
            await method(caller, pointer, 1, []);
        }
        held.push({ object, pointer });
    };

    /** @param {Held[]} held @param {unknown} caller */
    const letGo = async(held, caller)=>{
        for (const { object, pointer } of held.splice(0))
        {
            if (!object)
            {
                await method(caller, pointer, 2, []);
            }
            else if (!object.destroyed)
            {
                if (object.refCount === 1 && object.lastRelease)
                {
                    await object.lastRelease();
                }
                object.release();
            }
        }
    };

    /** @param {Held[]} held */
    const holding = held=>({
        lastRelease: ()=>letGo(held, thread()),
        destroy: ()=>{
            // Released without the program's Release (by another object of
            // ours): what it holds of ours goes with it.
            for (const { object } of held.splice(0))
            {
                if (object && !object.destroyed)
                {
                    object.release();
                }
            }
        },
    });

    // ---- palettes --------------------------------------------------------

    /**
     * @typedef {{ type: number, colours: number[] }} PaletteState
     */

    /** @param {PaletteState} [initial] @returns {ComObject} */
    const makePalette = (initial = { type: PALETTE_TYPE.CUSTOM, colours: [] })=>{
        /** @type {PaletteState} */
        const state = { ...initial, colours: [...initial.colours] };
        /**
         * @param {(colours: number[]) => boolean} test
         * @returns {import('./kit.js').Method}
         */
        const answer = test=>(object, [out])=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            putU32(out, test(state.colours) ? 1 : 0);
            return S_OK;
        };
        /** @param {number} c */
        const grey = c=>((c >> 16) & 0xff) === ((c >> 8) & 0xff)
            && ((c >> 8) & 0xff) === (c & 0xff);
        return make(CLSID.PALETTE, ['IWICPalette'], {
            InitializePredefined: (object, [type, transparent])=>{
                const colours = predefinedPalette(type, transparent !== 0);
                if (!colours)
                {
                    return E_INVALIDARG;
                }
                state.type = type;
                state.colours = colours;
                return S_OK;
            },
            InitializeCustom: (object, [colours, count])=>{
                if (colours === 0 && count !== 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = count ? host.readMemory(colours >>> 0, count * 4).slice() : null;
                const view = bytes ? new DataView(bytes.buffer) : null;
                state.type = PALETTE_TYPE.CUSTOM;
                state.colours = Array.from({ length: count }, (_, i)=>
                    /** @type {DataView} */ (view).getUint32(i * 4, true));
                return S_OK;
            },
            InitializeFromBitmap: async(object, [source, count, transparent])=>{
                if (source === 0 || count < 2 || count > 256)
                {
                    return E_INVALIDARG;
                }
                const bgra = await bgraOf(sourceAt(source), thread());
                const colours = medianCut(bgra, count - (transparent ? 1 : 0), false);
                state.type = PALETTE_TYPE.CUSTOM;
                state.colours = transparent ? [...colours, 0] : colours;
                return S_OK;
            },
            InitializeFromPalette: async(object, [palette])=>{
                if (palette === 0)
                {
                    return E_INVALIDARG;
                }
                const other = await paletteOf(palette, thread());
                state.type = other.type;
                state.colours = other.colours;
                return S_OK;
            },
            GetType: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, state.type);
                return S_OK;
            },
            GetColorCount: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, state.colours.length);
                return S_OK;
            },
            GetColors: (object, [count, colours, actual])=>{
                if (colours === 0 || actual === 0)
                {
                    return E_INVALIDARG;
                }
                const given = state.colours.slice(0, count);
                const bytes = new Uint8Array(given.length * 4);
                given.forEach((c, i)=>new DataView(bytes.buffer).setUint32(i * 4, c >>> 0, true));
                host.writeMemory(colours >>> 0, bytes);
                putU32(actual, given.length);
                return S_OK;
            },
            IsBlackWhite: answer(colours=>state.type === PALETTE_TYPE.FIXED_BW
                || (state.type === PALETTE_TYPE.CUSTOM && colours.length === 2
                    && colours.includes(0xff000000) && colours.includes(0xffffffff))),
            IsGrayscale: answer(colours=>colours.length > 0 && colours.every(grey)),
            HasAlpha: answer(colours=>colours.some(c=>(c >>> 24) !== 0xff)),
        }, state);
    };

    /**
     * A palette's type and colours, of ours or the program's (GetType 7,
     * GetColorCount 8, GetColors 9).
     *
     * @param {number} pointer @param {unknown} caller
     * @returns {Promise<PaletteState>}
     */
    const paletteOf = async(pointer, caller)=>{
        const object = ours(pointer);
        if (object?.state && Array.isArray(object.state.colours))
        {
            return { type: object.state.type, colours: [...object.state.colours] };
        }
        return withBlock(access, 8 + 256 * 4, async at=>{
            await method(caller, pointer, 7, [at]);
            await method(caller, pointer, 8, [at + 4]);
            const type = u32(at);
            const count = Math.min(256, u32(at + 4));
            await method(caller, pointer, 9, [count, at + 8, at + 4]);
            const got = Math.min(count, u32(at + 4));
            return { type, colours: Array.from({ length: got }, (_, i)=>u32(at + 8 + i * 4)) };
        });
    };

    /**
     * Puts colours into a palette the caller handed over (CopyPalette).
     *
     * @param {number} pointer @param {number[]} colours @param {unknown} caller
     */
    const fillPalette = async(pointer, colours, caller)=>{
        const object = ours(pointer);
        if (object?.state && Array.isArray(object.state.colours))
        {
            object.state.type = PALETTE_TYPE.CUSTOM;
            object.state.colours = [...colours];
            return S_OK;
        }
        return withBlock(access, Math.max(4, colours.length * 4), async at=>{
            const bytes = new Uint8Array(colours.length * 4);
            colours.forEach((c, i)=>new DataView(bytes.buffer).setUint32(i * 4, c >>> 0, true));
            host.writeMemory(at, bytes);
            return method(caller, pointer, 4, [at, colours.length]);
        });
    };

    /** A palette of ours published for a guest source's CopyPalette. @param {unknown} caller */
    const scratchPalette = async caller=>{
        void caller;
        const object = makePalette();
        const pointer = host.vtables.publish(object, INTERFACES.IWICPalette.iid) >>> 0;
        return { pointer, colours: ()=>/** @type {PaletteState} */ (object.state).colours,
            done: ()=>void object.release() };
    };

    // ---- sources -----------------------------------------------------------

    /**
     * The Source behind a pointer: one of ours, or the program's own.
     *
     * @param {number} pointer
     * @returns {Source}
     */
    const sourceAt = pointer=>{
        if (pointer === 0)
        {
            throw new CodecError(E_INVALIDARG, 'no source');
        }
        const object = ours(pointer);
        if (object?.state?.source)
        {
            return /** @type {{ source: Source }} */ (object.state).source;
        }
        if (object?.state && 'source' in object.state)
        {
            throw new CodecError(WINCODEC.NOTINITIALIZED, 'a source not initialized');
        }
        return guestSource(access, pointer, scratchPalette);
    };

    /**
     * IWICBitmapSource's five methods over `state.source`, null until the
     * object is initialized (WINCODEC_ERR_NOTINITIALIZED).
     *
     * @param {{ source: Source | null }} state
     * @param {number} [unready]  what a method answers before Initialize
     * @returns {Record<string, import('./kit.js').Method>}
     */
    const sourceMethods = (state, unready = WINCODEC.NOTINITIALIZED)=>{
        const live = ()=>{
            if (!state.source)
            {
                throw new CodecError(unready, 'not initialized');
            }
            return state.source;
        };
        return {
            GetSize: async(object, [width, height])=>{
                if (width === 0 || height === 0)
                {
                    return E_INVALIDARG;
                }
                const d = await live().describe(thread());
                putU32(width, d.width);
                putU32(height, d.height);
                return S_OK;
            },
            GetPixelFormat: async(object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putGuid(out, (await live().describe(thread())).format);
                return S_OK;
            },
            GetResolution: async(object, [x, y])=>{
                if (x === 0 || y === 0)
                {
                    return E_INVALIDARG;
                }
                const d = await live().describe(thread());
                putF64(x, d.dpiX);
                putF64(y, d.dpiY);
                return S_OK;
            },
            CopyPalette: async(object, [palette])=>{
                if (palette === 0)
                {
                    return E_INVALIDARG;
                }
                const caller = thread();
                const colours = await live().palette(caller);
                if (!colours)
                {
                    return WINCODEC.PALETTEUNAVAILABLE;
                }
                return fillPalette(palette, colours, caller);
            },
            CopyPixels: async(object, [area, stride, size, buffer])=>{
                const caller = thread();
                const source = live();
                const d = await source.describe(caller);
                const r = checkedRect(d, rect(area));
                const f = formatOf(d.format);
                if (!f)
                {
                    return WINCODEC.UNSUPPORTEDPIXELFORMAT;
                }
                const row = rowBytes(f, r.width);
                if (buffer === 0 || stride < row)
                {
                    return E_INVALIDARG;
                }
                if (r.height > 0 && size < stride * (r.height - 1) + row)
                {
                    return E_INVALIDARG;
                }
                if (r.width === 0 || r.height === 0)
                {
                    return S_OK;
                }
                const rows = await source.copy(caller, r);
                if (stride === row)
                {
                    host.writeMemory(buffer >>> 0, rows.subarray(0, row * r.height));
                }
                else
                {
                    for (let y = 0; y < r.height; y++)
                    {
                        host.writeMemory((buffer + y * stride) >>> 0,
                            rows.subarray(y * row, (y + 1) * row));
                    }
                }
                return S_OK;
            },
        };
    };

    // ---- bitmaps -------------------------------------------------------------

    /**
     * A bitmap over guest memory: its own block, or a section's view.
     *
     * @param {number} width @param {number} height @param {import('./formats.js').PixelFormat} f
     * @param {{ address?: number, stride?: number, palette?: number[] | null,
     *     dpi?: [number, number] }} [options]
     */
    const makeBitmap = (width, height, f, options = {})=>{
        const stride = options.stride ?? Math.ceil(width * f.bpp / 32) * 4;
        const owned = options.address === undefined;
        const address = owned ? host.heap.allocate(Math.max(4, stride * height)) >>> 0
            : /** @type {number} */ (options.address) >>> 0;
        if (address === 0)
        {
            throw new CodecError(E_OUTOFMEMORY, 'no memory for a bitmap');
        }
        if (owned)
        {
            host.writeMemory(address, new Uint8Array(stride * height));
        }
        /**
         * @type {{ width: number, height: number, format: import('./formats.js').PixelFormat,
         *     stride: number, address: number, palette: number[] | null, dpi: number[],
         *     readers: number, writer: boolean, source: Source | null }}
         */
        const state = { width, height, format: f, stride, address,
            palette: options.palette ?? null, dpi: options.dpi ?? [0, 0],
            readers: 0, writer: false, source: null };
        state.source = {
            describe: async()=>({ width, height, format: f.guid, dpiX: state.dpi[0],
                dpiY: state.dpi[1] }),
            palette: async()=>state.palette,
            copy: async(caller, r)=>heldSource({ width, height, format: f.guid, dpiX: 0, dpiY: 0 },
                ()=>null, ()=>({ bytes: host.readMemory(address, stride * height), stride }))
                .copy(caller, r),
        };
        return make(CLSID.BITMAP, ['IWICBitmap'], {
            ...sourceMethods(state),
            Lock: (object, [area, flags, out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                const r = checkedRect({ width, height, format: f.guid, dpiX: 0, dpiY: 0 },
                    rect(area));
                if (r.width === 0 || r.height === 0 || (flags & 3) === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.writer || ((flags & 2) && state.readers > 0))
                {
                    return WINCODEC.ALREADYLOCKED;
                }
                if (flags & 2)
                {
                    state.writer = true;
                }
                else
                {
                    state.readers++;
                }
                object.addRef();
                const lock = makeLock(state, r, (flags & 2) !== 0, ()=>{
                    if (flags & 2)
                    {
                        state.writer = false;
                    }
                    else
                    {
                        state.readers--;
                    }
                    object.release();
                });
                return hand(lock, 'IWICBitmapLock', out);
            },
            SetPalette: async(object, [palette])=>{
                if (palette === 0)
                {
                    return E_INVALIDARG;
                }
                state.palette = (await paletteOf(palette, thread())).colours;
                return S_OK;
            },
            SetResolution: (object, [xl, xh, yl, yh])=>{
                state.dpi = [f64(xl, xh), f64(yl, yh)];
                return S_OK;
            },
        }, state, { destroy: ()=>{
            if (owned)
            {
                host.heap.free(address);
            }
        } });
    };

    /**
     * A lock on a rectangle of a bitmap: where its rows start in guest memory.
     *
     * @param {{ address: number, stride: number,
     *     format: import('./formats.js').PixelFormat }} bitmap
     * @param {import('./sources.js').Rect} r @param {boolean} write @param {() => void} unlock
     */
    const makeLock = (bitmap, r, write, unlock)=>{
        void write;
        const { stride, format: f } = bitmap;
        const first = bitmap.address + r.y * stride + Math.floor(r.x * f.bpp / 8);
        const size = stride * (r.height - 1) + Math.ceil(((r.x * f.bpp) % 8 + r.width * f.bpp) / 8);
        return make(CLSID.LOCK, ['IWICBitmapLock'], {
            GetSize: (object, [width, height])=>{
                if (width === 0 || height === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(width, r.width);
                putU32(height, r.height);
                return S_OK;
            },
            GetStride: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, stride);
                return S_OK;
            },
            GetDataPointer: (object, [bytes, data])=>{
                if (bytes === 0 || data === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(bytes, size);
                putU32(data, first);
                return S_OK;
            },
            GetPixelFormat: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putGuid(out, f.guid);
                return S_OK;
            },
        }, null, { destroy: unlock });
    };

    /**
     * A bitmap holding a copy of a source's rectangle and its palette.
     *
     * @param {Source} source @param {import('./sources.js').Rect | null} area
     * @param {unknown} caller
     */
    const bitmapFrom = async(source, area, caller)=>{
        const d = await source.describe(caller);
        const f = formatOf(d.format);
        if (!f)
        {
            throw new CodecError(WINCODEC.UNSUPPORTEDPIXELFORMAT, `a source of format ${d.format}`);
        }
        const r = area ?? { x: 0, y: 0, width: d.width, height: d.height };
        const palette = await source.palette(caller).catch(()=>null);
        const bitmap = makeBitmap(r.width, r.height, f, { palette, dpi: [d.dpiX, d.dpiY] });
        const state = /** @type {{ address: number, stride: number }} */ (bitmap.state);
        if (r.width > 0 && r.height > 0)
        {
            const rows = await source.copy(caller, r);
            const row = rowBytes(f, r.width);
            for (let y = 0; y < r.height; y++)
            {
                host.writeMemory(state.address + y * state.stride, rows.subarray(y * row,
                    (y + 1) * row));
            }
        }
        return bitmap;
    };

    // ---- transforms ---------------------------------------------------------

    /**
     * An object that is a source once Initialize gives it one.
     *
     * @param {string} clsid @param {string} name
     * @param {(state: { source: Source | null, held: Held[], palette: number[] | null,
     *     sourcePointer: number }, args: number[]) => Promise<number>} initialize
     * @param {Record<string, import('./kit.js').Method> |
     *     ((state: { source: Source | null, palette: number[] | null,
     *     sourcePointer: number }) => Record<string, import('./kit.js').Method>)} [more]
     * @param {number} [unready]
     */
    const makeTransform = (clsid, name, initialize, more = {}, unready = undefined)=>{
        /**
         * @type {{ source: Source | null, held: Held[], palette: number[] | null,
         *     sourcePointer: number }}
         */
        const state = { source: null, held: [], palette: null, sourcePointer: 0 };
        return make(clsid, [name], {
            ...sourceMethods(state, unready),
            Initialize: async(object, args)=>{
                if (state.source)
                {
                    return WINCODEC.WRONGSTATE;
                }
                return initialize(state, args);
            },
            ...(typeof more === 'function' ? more(state) : more),
        }, state, holding(state.held));
    };

    /** A format converter, for the factory and CLSID_WICDefaultFormatConverter. */
    const makeConverter = ()=>makeTransform(GUID.CLSID_DefaultFormatConverter,
        'IWICFormatConverter', async(state, [source, format, dither, palette, , , translate])=>{
            void dither;
            if (source === 0 || format === 0)
            {
                return E_INVALIDARG;
            }
            const caller = thread();
            const from = sourceAt(source);
            const target = guid(format);
            const d = await from.describe(caller);
            const hr = conversionOf(d.format, target);
            if (hr !== S_OK)
            {
                return hr;
            }
            const to = /** @type {import('./formats.js').PixelFormat} */ (formatOf(target));
            /** @type {number[] | null} */
            let colours = null;
            if (to.indexed)
            {
                if (palette !== 0)
                {
                    colours = (await paletteOf(palette, caller)).colours;
                }
                else if (translate === PALETTE_TYPE.MEDIAN_CUT)
                {
                    colours = medianCut(await bgraOf(from, caller), 1 << Math.min(8, to.bpp),
                        false);
                }
                else
                {
                    // A predefined palette the format has no room for is
                    // refused, as a custom one with none given is.
                    colours = predefinedPalette(translate, false);
                    if (!colours || colours.length > 1 << to.bpp)
                    {
                        return E_INVALIDARG;
                    }
                }
            }
            await hold(state.held, source, caller);
            state.sourcePointer = source;
            state.palette = colours;
            state.source = convertedSource(from, to, colours);
            return S_OK;
        }, state=>({
            // To a format with no palette, the source's own CopyPalette
            // answers, its HRESULT as it gives it.
            CopyPalette: async(object, [palette])=>{
                if (!state.source)
                {
                    return WINCODEC.WRONGSTATE;
                }
                if (palette === 0)
                {
                    return E_INVALIDARG;
                }
                const caller = thread();
                if (state.palette)
                {
                    return fillPalette(palette, state.palette, caller);
                }
                const pointer = state.sourcePointer;
                const inner = ours(pointer);
                const copy = inner?.interfaceFor(INTERFACES.IWICBitmapSource.iid)
                    ?.methods.find(m=>m.name === 'CopyPalette');
                return inner && copy?.invoke ? copy.invoke(inner, [palette])
                    : method(caller, pointer, 6, [palette]);
            },
            CanConvert: (object, [from, to, out])=>{
                if (from === 0 || to === 0 || out === 0)
                {
                    return E_INVALIDARG;
                }
                const can = defaultConverts(formatOf(guid(from)), formatOf(guid(to)));
                putU32(out, can ? 1 : 0);
                return can ? S_OK : WINCODEC.UNSUPPORTEDPIXELFORMAT;
            },
        }), WINCODEC.WRONGSTATE);

    const makeScaler = ()=>makeTransform(CLSID.SCALER, 'IWICBitmapScaler',
        async(state, [source, width, height, mode])=>{
            if (source === 0 || width === 0 || height === 0)
            {
                return E_INVALIDARG;
            }
            const caller = thread();
            const from = sourceAt(source);
            await from.describe(caller);
            await hold(state.held, source, caller);
            state.source = scaledSource(from, width, height, mode);
            return S_OK;
        });

    const makeClipper = ()=>makeTransform(CLSID.CLIPPER, 'IWICBitmapClipper',
        async(state, [source, area])=>{
            if (source === 0 || area === 0)
            {
                return E_INVALIDARG;
            }
            const caller = thread();
            const from = sourceAt(source);
            const clip = checkedRect(await from.describe(caller), rect(area));
            await hold(state.held, source, caller);
            state.source = clippedSource(from, clip);
            return S_OK;
        });

    const makeFlipRotator = ()=>makeTransform(CLSID.FLIP_ROTATOR, 'IWICBitmapFlipRotator',
        async(state, [source, options])=>{
            if (source === 0)
            {
                return E_INVALIDARG;
            }
            const caller = thread();
            const from = sourceAt(source);
            await from.describe(caller);
            await hold(state.held, source, caller);
            state.source = flippedSource(from, options);
            return S_OK;
        });

    // ---- streams --------------------------------------------------------------

    /**
     * What an IWICStream reads and writes: memory, a file's bytes, another
     * IStream or a region of one.
     *
     * @typedef {Object} StreamBody
     * @property {(caller: unknown) => Promise<number>} size
     * @property {(caller: unknown, at: number, length: number) => Promise<Uint8Array>} read
     * @property {(caller: unknown, at: number, bytes: Uint8Array) => Promise<number>} write
     *     the bytes written, short at the end of a fixed medium
     * @property {(caller: unknown) => Promise<void>} [rewind]
     *     back to the start, where a decoder that read it all leaves a stream of
     *     the program's (Wine's pngformat test asks it be short of the end)
     */

    /**
     * The bytes of a stream of the program's (IStream: Read 3, Seek 5, Stat 12).
     *
     * @param {number} pointer
     * @returns {StreamBody}
     */
    const guestStreamBody = pointer=>({
        size: caller=>withBlock(access, 72, async at=>{
            const hr = await method(caller, pointer, 12, [at, 1]);
            if (hr < 0)
            {
                throw new CodecError(hr, 'IStream::Stat');
            }
            return u32(at + 8) + u32(at + 12) * 0x100000000;
        }),
        read: (caller, at, length)=>withBlock(access, 16 + length, async block=>{
            const seek = await method(caller, pointer, 5, [at >>> 0, Math.floor(at / 0x100000000),
                STREAM_SEEK.SET, 0]);
            if (seek < 0)
            {
                throw new CodecError(seek, 'IStream::Seek');
            }
            const hr = await method(caller, pointer, 3, [block + 16, length, block]);
            if (hr < 0)
            {
                throw new CodecError(hr, 'IStream::Read');
            }
            return host.readMemory(block + 16, Math.min(length, u32(block))).slice();
        }),
        write: (caller, at, bytes)=>withBlock(access, 16 + bytes.length, async block=>{
            await method(caller, pointer, 5, [at >>> 0, Math.floor(at / 0x100000000),
                STREAM_SEEK.SET, 0]);
            host.writeMemory(block + 16, bytes);
            const hr = await method(caller, pointer, 4, [block + 16, bytes.length, block]);
            if (hr < 0)
            {
                throw new CodecError(hr, 'IStream::Write');
            }
            return u32(block);
        }),
        rewind: async caller=>{
            await method(caller, pointer, 5, [0, 0, STREAM_SEEK.SET, 0]);
        },
    });

    /** @param {number} address @param {number} length @returns {StreamBody} */
    const memoryBody = (address, length)=>({
        size: async()=>length,
        read: async(_, at, count)=>(at >= length ? new Uint8Array(0)
            : host.readMemory((address + at) >>> 0, Math.min(count, length - at)).slice()),
        write: async(_, at, bytes)=>{
            const fits = Math.max(0, Math.min(bytes.length, length - at));
            if (fits > 0)
            {
                host.writeMemory((address + at) >>> 0, bytes.subarray(0, fits));
            }
            return fits;
        },
    });

    /** @param {Uint8Array} data @returns {StreamBody} */
    const bytesBody = data=>({
        size: async()=>data.length,
        read: async(_, at, count)=>data.slice(at, at + count),
        write: async()=>{
            throw new CodecError(STG_E_ACCESSDENIED, 'a file stream opened for reading');
        },
    });

    /** @param {StreamBody} inner @param {number} offset @param {number} limit @returns {StreamBody} */
    const regionBody = (inner, offset, limit)=>({
        size: async caller=>Math.max(0, Math.min(limit, await inner.size(caller) - offset)),
        read: (caller, at, count)=>(at >= limit ? Promise.resolve(new Uint8Array(0))
            : inner.read(caller, offset + at, Math.min(count, limit - at))),
        write: (caller, at, bytes)=>(at >= limit ? Promise.resolve(0)
            : inner.write(caller, offset + at, bytes.subarray(0, Math.max(0, limit - at)))),
    });

    /**
     * Every byte of a stream of ours or of the program's.
     *
     * @param {number} pointer @param {unknown} caller
     */
    const streamBytes = async(pointer, caller)=>{
        const object = ours(pointer);
        if (object?.state && 'body' in object.state && !object.state.body)
        {
            throw new CodecError(WINCODEC.NOTINITIALIZED, 'a stream not initialized');
        }
        /** @type {StreamBody} */
        const body = object?.state?.body ?? guestStreamBody(pointer);
        /** @type {Uint8Array[]} */
        const parts = [];
        let total = 0;
        for (;;)
        {
            const part = await body.read(caller, total, READ_CHUNK);
            parts.push(part);
            total += part.length;
            if (part.length < READ_CHUNK)
            {
                break;
            }
        }
        await body.rewind?.(caller);
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of parts)
        {
            out.set(part, at);
            at += part.length;
        }
        return out;
    };

    /**
     * An IWICStream. Over memory, a file's bytes or a region of another
     * stream it keeps its own position; over a whole IStream it is that
     * stream, every IStream method passed on. Memory refuses a seek past its
     * end with E_INVALIDARG, and one whose position does not fit 32 bits
     * (before the start, as an unsigned number) with
     * HRESULT_FROM_WIN32(ERROR_ARITHMETIC_OVERFLOW); a region refuses either
     * with WINCODEC_ERR_VALUEOUTOFRANGE. Memory refuses a write that does
     * not fit whole, a region writes what fits (Wine's stream test).
     */
    const makeStream = ()=>{
        /**
         * @type {{ body: StreamBody | null, position: number,
         *     kind: '' | 'memory' | 'file' | 'region' | 'istream', inner: number }}
         */
        const state = { body: null, position: 0, kind: '', inner: 0 };
        /** @type {Held[]} */
        const held = [];
        const live = ()=>{
            if (!state.body)
            {
                throw new CodecError(WINCODEC.NOTINITIALIZED, 'a stream not initialized');
            }
            return state.body;
        };
        /**
         * @param {typeof state.kind} kind @param {StreamBody} body @param {number} [inner]
         */
        const start = (kind, body, inner = 0)=>{
            if (state.body)
            {
                return WINCODEC.WRONGSTATE;
            }
            Object.assign(state, { kind, body, inner, position: 0 });
            return S_OK;
        };
        /**
         * An IStream method: passed on to the stream this one is, or this one's.
         *
         * @param {string} name @param {number} slot @param {import('./kit.js').Method} fn
         * @returns {import('./kit.js').Method}
         */
        const own = (name, slot, fn)=>(object, args)=>{
            live();
            if (state.kind !== 'istream')
            {
                return fn(object, args);
            }
            const inner = ours(state.inner);
            const passed = inner?.interfaceFor(INTERFACES.IStream.iid)?.methods
                .find(m=>m.name === name);
            return inner && passed?.invoke ? passed.invoke(inner, args)
                : method(thread(), state.inner, slot, args);
        };
        const refused = ()=>E_NOTIMPL;
        return make(CLSID.STREAM, ['IWICStream'], {
            Read: own('Read', 3, async(object, [buffer, count, done])=>{
                if (buffer === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = count === 0 ? new Uint8Array(0)
                    : await live().read(thread(), state.position, count);
                host.writeMemory(buffer >>> 0, bytes);
                state.position += bytes.length;
                if (done !== 0)
                {
                    putU32(done, bytes.length);
                }
                return S_OK;
            }),
            Write: own('Write', 4, async(object, [buffer, count, done])=>{
                if (buffer === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.kind === 'file')
                {
                    return STG_E_ACCESSDENIED;
                }
                const body = live();
                const caller = thread();
                if (state.kind !== 'region' && state.position + count > await body.size(caller))
                {
                    return STG_E_MEDIUMFULL;
                }
                const written = count === 0 ? 0 : await body.write(caller, state.position,
                    host.readMemory(buffer >>> 0, count).slice());
                state.position += written;
                if (done !== 0)
                {
                    putU32(done, written);
                }
                return S_OK;
            }),
            Seek: own('Seek', 5, async(object, [low, high, origin, out])=>{
                const move = Number(BigInt.asIntN(64,
                    BigInt(high >>> 0) << 32n | BigInt(low >>> 0)));
                const size = await live().size(thread());
                const base = origin === STREAM_SEEK.SET ? 0 : origin === STREAM_SEEK.CUR
                    ? state.position : origin === STREAM_SEEK.END ? size : -1;
                if (base < 0)
                {
                    return STG_E_INVALIDFUNCTION;
                }
                const next = base + move;
                if (next < 0 || next > size)
                {
                    return state.kind === 'region' ? WINCODEC.VALUEOUTOFRANGE
                        : next < 0 || next >= 0x100000000 ? ERROR_ARITHMETIC_OVERFLOW
                            : E_INVALIDARG;
                }
                state.position = next;
                if (out !== 0)
                {
                    putU32(out, next >>> 0);
                    putU32(out + 4, Math.floor(next / 0x100000000));
                }
                return S_OK;
            }),
            SetSize: own('SetSize', 6, refused),
            CopyTo: own('CopyTo', 7, refused),
            Commit: own('Commit', 8, ()=>S_OK),
            Revert: own('Revert', 9, refused),
            LockRegion: own('LockRegion', 10, refused),
            UnlockRegion: own('UnlockRegion', 11, refused),
            Stat: own('Stat', 12, async(object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                const size = await live().size(thread());
                const statstg = new Uint8Array(72);
                const view = new DataView(statstg.buffer);
                view.setUint32(4, 2, true);
                view.setUint32(8, size >>> 0, true);
                view.setUint32(12, Math.floor(size / 0x100000000), true);
                host.writeMemory(out >>> 0, statstg);
                return S_OK;
            }),
            Clone: own('Clone', 13, refused),
            InitializeFromIStream: async(object, [stream])=>{
                if (stream === 0)
                {
                    return E_INVALIDARG;
                }
                const hr = start('istream', ours(stream)?.state?.body ?? guestStreamBody(stream),
                    stream);
                if (hr === S_OK)
                {
                    await hold(held, stream, thread());
                }
                return hr;
            },
            InitializeFromFilename: async(object, [name, mode])=>{
                if (name === 0)
                {
                    return E_INVALIDARG;
                }
                if (mode & 0x40000000)
                {
                    diverge('IWICStream::InitializeFromFilename', 'a file opened for writing');
                    return E_NOTIMPL;
                }
                const data = await host.readFile(host.readWideString(name >>> 0, 260 * 2));
                if (!data)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                return start('file', bytesBody(data));
            },
            InitializeFromMemory: (object, [buffer, size])=>{
                if (buffer === 0)
                {
                    return E_INVALIDARG;
                }
                return start('memory', memoryBody(buffer >>> 0, size >>> 0));
            },
            InitializeFromIStreamRegion: async(object, args)=>{
                const [stream, offLow, offHigh, maxLow, maxHigh] = args;
                if (stream === 0)
                {
                    return E_INVALIDARG;
                }
                const inner = ours(stream)?.state?.body ?? guestStreamBody(stream);
                const offset = (offHigh >>> 0) * 0x100000000 + (offLow >>> 0);
                const limit = (maxHigh >>> 0) * 0x100000000 + (maxLow >>> 0);
                const hr = start('region', regionBody(inner, offset, limit));
                if (hr === S_OK)
                {
                    await hold(held, stream, thread());
                }
                return hr;
            },
        }, { held,
            get body(){
                return state.body;
            } }, holding(held));
    };

    /** @param {ComObject} object @returns {Held[]} */
    const heldOf = object=>object.state.held;

    // ---- decoders --------------------------------------------------------------

    /**
     * A decoder for one container, Initialize not called yet or called.
     *
     * @param {import('./frames.js').Container} container
     */
    const makeDecoder = container=>{
        /** @type {{ image: import('./frames.js').DecodedImage | null, queried: boolean }} */
        const state = { image: null, queried: false };
        /** @type {Held[]} */
        const held = [];
        /** @type {ComObject | null} */
        let decoderInfo = null;
        const live = ()=>{
            if (!state.image)
            {
                throw new CodecError(WINCODEC.WRONGSTATE, 'a decoder not initialized');
            }
            return state.image;
        };
        /** @param {Uint8Array} bytes */
        const decode = bytes=>{
            if (!container.decode)
            {
                diverge(`IWICBitmapDecoder (${container.name})`, 'this container is not decoded');
                throw new CodecError(WINCODEC.COMPONENTNOTFOUND, 'no decoder');
            }
            return container.decode(bytes);
        };
        const decoder = make(container.decoder, ['IWICBitmapDecoder'], {
            QueryCapability: async(object, [stream, out])=>{
                if (stream === 0 || out === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.image || state.queried)
                {
                    return WINCODEC.WRONGSTATE;
                }
                // A decoder asked once is spent: Initialize after answers
                // WRONGSTATE (Wine's bmpformat test).
                state.queried = true;
                const bytes = await streamBytes(stream, thread());
                let capability = 0;
                try
                {
                    decode(bytes);
                    capability = WICBitmapDecoderCapabilityCanDecodeAllImages;
                }
                catch (e){
                    if (!(e instanceof CodecError))
                    {
                        throw e;
                    }
                }
                putU32(out, capability);
                return S_OK;
            },
            Initialize: async(object, [stream])=>{
                if (stream === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.image || state.queried)
                {
                    return WINCODEC.WRONGSTATE;
                }
                const caller = thread();
                state.image = decode(await streamBytes(stream, caller));
                await hold(held, stream, caller);
                return S_OK;
            },
            GetContainerFormat: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putGuid(out, container.guid);
                return S_OK;
            },
            GetDecoderInfo: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                // One info a decoder, handed out again each time it is asked.
                if (!decoderInfo || decoderInfo.destroyed)
                {
                    decoderInfo = infos.make(container.decoder);
                    if (!decoderInfo)
                    {
                        return WINCODEC.COMPONENTNOTFOUND;
                    }
                }
                else
                {
                    decoderInfo.addRef();
                }
                return hand(decoderInfo, 'IWICBitmapDecoderInfo', out);
            },
            CopyPalette: async(object, [palette])=>{
                if (palette === 0)
                {
                    return E_INVALIDARG;
                }
                const image = live();
                return image.palette ? fillPalette(palette, image.palette, thread())
                    : WINCODEC.PALETTEUNAVAILABLE;
            },
            GetMetadataQueryReader: (object, [out])=>{
                if (out !== 0)
                {
                    putU32(out, 0);
                }
                diverge('IWICBitmapDecoder::GetMetadataQueryReader', 'metadata is not read');
                return WINCODEC.UNSUPPORTEDOPERATION;
            },
            GetPreview: (object, [out])=>{
                if (out !== 0)
                {
                    putU32(out, 0);
                }
                return WINCODEC.UNSUPPORTEDOPERATION;
            },
            GetColorContexts: ()=>WINCODEC.UNSUPPORTEDOPERATION,
            GetThumbnail: (object, [out])=>{
                if (out !== 0)
                {
                    putU32(out, 0);
                }
                return WINCODEC.CODECNOTHUMBNAIL;
            },
            GetFrameCount: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, live().frames.length);
                return S_OK;
            },
            GetFrame: (object, [index, out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                const image = live();
                if (index >>> 0 >= image.frames.length)
                {
                    putU32(out, 0);
                    // A container of several frames says the one asked for is
                    // missing; one of a single frame calls the index wrong.
                    return container.multiframe ? WINCODEC.FRAMEMISSING : E_INVALIDARG;
                }
                object.addRef();
                return hand(makeFrame(image.frames[index >>> 0], ()=>void object.release(),
                    container), 'IWICBitmapFrameDecode', out);
            },
        }, { ...state, held,
            get image(){
                return state.image;
            },
            set image(value){
                state.image = value;
            } }, holding(held));
        return decoder;
    };

    /**
     * A decoded frame, keeping its decoder alive as Windows' frames do.
     *
     * @param {import('./frames.js').DecodedFrame} frame @param {() => void} done
     * @param {import('./frames.js').Container} container
     * @returns {ComObject}
     */
    const makeFrame = (frame, done, container)=>{
        const stride = rowBytes(frame.format, frame.width);
        const state = { source: heldSource({ width: frame.width, height: frame.height,
            format: frame.format.guid, dpiX: frame.dpiX, dpiY: frame.dpiY },
        ()=>frame.palette, ()=>({ bytes: frame.pixels, stride })) };
        return make(CLSID.FRAME, ['IWICBitmapFrameDecode'], {
            ...sourceMethods(state),
            GetMetadataQueryReader: (object, [out])=>{
                if (out !== 0)
                {
                    putU32(out, 0);
                }
                diverge('IWICBitmapFrameDecode::GetMetadataQueryReader', 'metadata is not read');
                return WINCODEC.UNSUPPORTEDOPERATION;
            },
            GetColorContexts: (object, [count, contexts, actual])=>{
                void count;
                void contexts;
                if (container.name === 'Bmp')
                {
                    return WINCODEC.UNSUPPORTEDOPERATION;
                }
                if (actual === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(actual, 0);
                return S_OK;
            },
            GetThumbnail: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                if (container.name === 'Ico')
                {
                    // An icon's image is its own thumbnail.
                    return hand(makeFrame(frame, ()=>{}, container), 'IWICBitmapSource', out);
                }
                putU32(out, 0);
                return WINCODEC.CODECNOTHUMBNAIL;
            },
        }, state, { destroy: done });
    };

    /**
     * A decoder for bytes, by the container their first bytes name.
     *
     * @param {Uint8Array} bytes
     */
    const decoderFor = bytes=>{
        const container = sniff(bytes);
        if (!container || !container.decode)
        {
            if (container)
            {
                diverge(`IWICImagingFactory (${container.name})`, 'this container is not decoded');
            }
            throw new CodecError(WINCODEC.COMPONENTNOTFOUND, 'no decoder for these bytes');
        }
        const decoder = makeDecoder(container);
        /** @type {{ image: import('./frames.js').DecodedImage | null }} */ (decoder.state).image =
            container.decode(bytes);
        return decoder;
    };

    // ---- colour contexts ---------------------------------------------------------

    const makeColorContext = ()=>{
        const state = { type: 0, profile: /** @type {Uint8Array | null} */ (null), space: 0 };
        return make(CLSID.COLOR_CONTEXT, ['IWICColorContext'], {
            InitializeFromFilename: async(object, [name])=>{
                if (name === 0)
                {
                    return E_INVALIDARG;
                }
                const data = await host.readFile(host.readWideString(name >>> 0, 260 * 2));
                if (!data)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                state.type = 1;
                state.profile = data;
                return S_OK;
            },
            InitializeFromMemory: (object, [buffer, size])=>{
                if (buffer === 0)
                {
                    return E_INVALIDARG;
                }
                state.type = 1;
                state.profile = host.readMemory(buffer >>> 0, size).slice();
                return S_OK;
            },
            InitializeFromExifColorSpace: (object, [space])=>{
                // A profile stays; an EXIF colour space may be named again.
                if (state.type === 1)
                {
                    return WINCODEC.WRONGSTATE;
                }
                state.type = 2;
                state.space = space;
                return S_OK;
            },
            GetType: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, state.type);
                return S_OK;
            },
            GetProfileBytes: (object, [size, buffer, actual])=>{
                if (state.type !== 1 || !state.profile)
                {
                    return WINCODEC.NOTINITIALIZED;
                }
                if (actual === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(actual, state.profile.length);
                if (buffer !== 0 && size >= state.profile.length)
                {
                    host.writeMemory(buffer >>> 0, state.profile);
                }
                return buffer !== 0 && size < state.profile.length
                    ? WINCODEC.INSUFFICIENTBUFFER : S_OK;
            },
            GetExifColorSpace: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, state.type === 2 ? state.space : 0xffffffff);
                return S_OK;
            },
        }, state);
    };

    // ---- the factory -------------------------------------------------------------

    /**
     * Something this build does not make: refused, said once.
     *
     * @param {string} what @returns {import('./kit.js').Method}
     */
    const refuse = what=>(object, args)=>{
        const out = args[args.length - 1];
        if (out !== 0 && out !== undefined)
        {
            putU32(out, 0);
        }
        diverge(`IWICImagingFactory::${what}`, 'not provided');
        return WINCODEC.COMPONENTNOTFOUND;
    };

    /** @param {() => ComObject} maker @param {string} name */
    const creator = (maker, name)=>(/** @type {ComObject} */ object, /** @type {number[]} */ [out])=>
        (out === 0 ? E_INVALIDARG : hand(maker(), name, out));

    /** @type {Record<string, import('./kit.js').Method>} */
    const factoryMethods = {
        CreateDecoderFromFilename: async(object, [name, vendor, mode, options, out])=>{
            void vendor;
            void mode;
            void options;
            if (name === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            putU32(out, 0);
            const data = await host.readFile(host.readWideString(name >>> 0, 260 * 2));
            if (!data)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            return hand(decoderFor(data), 'IWICBitmapDecoder', out);
        },
        CreateDecoderFromStream: async(object, [stream, vendor, options, out])=>{
            void vendor;
            void options;
            if (stream === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            putU32(out, 0);
            const caller = thread();
            const decoder = decoderFor(await streamBytes(stream, caller));
            await hold(decoder.state.held, stream, caller);
            return hand(decoder, 'IWICBitmapDecoder', out);
        },
        CreateDecoderFromFileHandle: async(object, [handle, vendor, options, out])=>{
            void vendor;
            void options;
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            putU32(out, 0);
            if (!host.readHandle)
            {
                diverge('IWICImagingFactory::CreateDecoderFromFileHandle', 'not provided');
                return E_NOTIMPL;
            }
            const data = await host.readHandle(handle);
            if (!data)
            {
                return E_INVALIDARG;
            }
            return hand(decoderFor(data), 'IWICBitmapDecoder', out);
        },
        CreateComponentInfo: (object, [clsid, out])=>{
            if (clsid === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            const info = infos.make(guid(clsid));
            if (!info)
            {
                putU32(out, 0);
                return WINCODEC.COMPONENTNOTFOUND;
            }
            return hand(info, 'IWICComponentInfo', out);
        },
        CreateDecoder: (object, [format, vendor, out])=>{
            void vendor;
            if (format === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            const wanted = guid(format);
            const container = CONTAINERS.find(c=>c.guid === wanted && c.decode);
            if (!container)
            {
                putU32(out, 0);
                return WINCODEC.COMPONENTNOTFOUND;
            }
            return hand(makeDecoder(container), 'IWICBitmapDecoder', out);
        },
        CreateEncoder: (object, [format, vendor, out])=>{
            void vendor;
            if (out !== 0)
            {
                putU32(out, 0);
            }
            const container = format === 0 ? null : CONTAINERS.find(c=>c.guid === guid(format));
            diverge('IWICImagingFactory::CreateEncoder',
                `no encoder is provided (${container?.name ?? 'unknown container'})`);
            return WINCODEC.COMPONENTNOTFOUND;
        },
        CreatePalette: creator(()=>makePalette(), 'IWICPalette'),
        CreateFormatConverter: creator(makeConverter, 'IWICFormatConverter'),
        CreateBitmapScaler: creator(makeScaler, 'IWICBitmapScaler'),
        CreateBitmapClipper: creator(makeClipper, 'IWICBitmapClipper'),
        CreateBitmapFlipRotator: creator(makeFlipRotator, 'IWICBitmapFlipRotator'),
        CreateStream: creator(makeStream, 'IWICStream'),
        CreateColorContext: creator(makeColorContext, 'IWICColorContext'),
        CreateColorTransformer: refuse('CreateColorTransformer'),
        CreateBitmap: (object, [width, height, format, option, out])=>{
            void option;
            if (format === 0 || out === 0 || width === 0 || height === 0)
            {
                return E_INVALIDARG;
            }
            const f = formatOf(guid(format));
            if (!f)
            {
                putU32(out, 0);
                return WINCODEC.UNSUPPORTEDPIXELFORMAT;
            }
            return hand(makeBitmap(width, height, f), 'IWICBitmap', out);
        },
        CreateBitmapFromSource: async(object, [source, option, out])=>{
            void option;
            if (source === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            return hand(await bitmapFrom(sourceAt(source), null, thread()), 'IWICBitmap', out);
        },
        CreateBitmapFromSourceRect: async(object, [source, x, y, width, height, out])=>{
            if (source === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            const caller = thread();
            const from = sourceAt(source);
            const d = await from.describe(caller);
            // Windows clips the rectangle to the source rather than refusing it.
            const left = Math.min(x >>> 0, d.width);
            const top = Math.min(y >>> 0, d.height);
            const r = { x: left, y: top, width: Math.min(width >>> 0, d.width - left),
                height: Math.min(height >>> 0, d.height - top) };
            if (r.width === 0 || r.height === 0)
            {
                return E_INVALIDARG;
            }
            return hand(await bitmapFrom(from, r, caller), 'IWICBitmap', out);
        },
        CreateBitmapFromMemory: (object, [width, height, format, stride, size, buffer, out])=>{
            if (format === 0 || buffer === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            const f = formatOf(guid(format));
            if (!f)
            {
                return WINCODEC.UNSUPPORTEDPIXELFORMAT;
            }
            const row = rowBytes(f, width);
            if (stride < row)
            {
                return E_INVALIDARG;
            }
            if (size < stride * height)
            {
                return WINCODEC.INSUFFICIENTBUFFER;
            }
            const bitmap = makeBitmap(width, height, f);
            const state = /** @type {{ address: number, stride: number }} */ (bitmap.state);
            for (let y = 0; y < height; y++)
            {
                host.writeMemory(state.address + y * state.stride,
                    host.readMemory((buffer + y * stride) >>> 0, row).slice());
            }
            return hand(bitmap, 'IWICBitmap', out);
        },
        CreateBitmapFromHBITMAP: (object, [bitmap, palette, options, out])=>{
            void palette;
            if (out === 0 || bitmap === 0)
            {
                return E_INVALIDARG;
            }
            const pixels = host.bitmapOf?.(bitmap) ?? null;
            if (!pixels)
            {
                if (!host.bitmapOf)
                {
                    diverge('IWICImagingFactory::CreateBitmapFromHBITMAP', 'not provided');
                }
                return E_INVALIDARG;
            }
            // WICBitmapUseAlpha 0, UsePremultipliedAlpha 1, IgnoreAlpha 2.
            const name = options === 2 || !pixels.alpha ? '32bppBGR'
                : options === 1 ? '32bppPBGRA' : '32bppBGRA';
            return hand(bitmapOfBgra(pixels, name), 'IWICBitmap', out);
        },
        CreateBitmapFromHICON: (object, [icon, out])=>{
            if (out === 0 || icon === 0)
            {
                return E_INVALIDARG;
            }
            const pixels = host.iconOf?.(icon) ?? null;
            if (!pixels)
            {
                if (!host.iconOf)
                {
                    diverge('IWICImagingFactory::CreateBitmapFromHICON', 'not provided');
                }
                return E_INVALIDARG;
            }
            return hand(bitmapOfBgra(pixels, '32bppBGRA'), 'IWICBitmap', out);
        },
        CreateComponentEnumerator: (object, [types, options, out])=>{
            void options;
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            return infos.enumerate(types >>> 0, out);
        },
        CreateFastMetadataEncoderFromDecoder: refuse('CreateFastMetadataEncoderFromDecoder'),
        CreateFastMetadataEncoderFromFrameDecode:
            refuse('CreateFastMetadataEncoderFromFrameDecode'),
        CreateQueryWriter: refuse('CreateQueryWriter'),
        CreateQueryWriterFromReader: refuse('CreateQueryWriterFromReader'),
        CreateImageEncoder: refuse('CreateImageEncoder'),
        CreateMetadataReader: refuse('CreateMetadataReader'),
        CreateMetadataReaderFromContainer: refuse('CreateMetadataReaderFromContainer'),
        CreateMetadataWriter: refuse('CreateMetadataWriter'),
        CreateMetadataWriterFromReader: refuse('CreateMetadataWriterFromReader'),
        CreateQueryReaderFromBlockReader: refuse('CreateQueryReaderFromBlockReader'),
        CreateQueryWriterFromBlockWriter: refuse('CreateQueryWriterFromBlockWriter'),
        CreateEncoderPropertyBag: refuse('CreateEncoderPropertyBag'),
    };

    /**
     * A bitmap of top-down BGRA texels in a 32-bit format.
     *
     * @param {{ width: number, height: number, bgra: Uint8Array }} pixels @param {string} name
     */
    const bitmapOfBgra = (pixels, name)=>{
        const f = /** @type {import('./formats.js').PixelFormat} */ (formatOf(
            /** @type {Record<string, string>} */ (GUID)[`PixelFormat${name}`]));
        const bitmap = makeBitmap(pixels.width, pixels.height, f);
        let bgra = pixels.bgra;
        if (name === '32bppPBGRA')
        {
            bgra = bgra.slice();
            for (let i = 0; i < bgra.length; i += 4)
            {
                for (let c = 0; c < 3; c++)
                {
                    bgra[i + c] = Math.round(bgra[i + c] * bgra[i + 3] / 255);
                }
            }
        }
        host.writeMemory(/** @type {{ address: number }} */ (bitmap.state).address, bgra);
        return bitmap;
    };

    const makeFactory = ()=>make(GUID.CLSID_ImagingFactory,
        ['IWICImagingFactory', 'IWICImagingFactory2', 'IWICComponentFactory'], factoryMethods, {});

    const infos = createInfos(kit, host, {
        decoder: container=>makeDecoder(container),
        converter: makeConverter,
    });

    /**
     * WICConvertBitmapSource: the source itself (another reference) when it
     * is in the format already, else a converter over it.
     *
     * @param {number} format @param {number} source @param {number} out
     * @returns {Promise<number>}
     */
    const convertBitmapSource = async(format, source, out)=>{
        if (format === 0 || source === 0 || out === 0)
        {
            return E_INVALIDARG;
        }
        putU32(out, 0);
        const caller = thread();
        const target = guid(format);
        try
        {
            const d = await sourceAt(source).describe(caller);
            if (d.format === target)
            {
                const object = ours(source);
                if (object)
                {
                    object.addRef();
                }
                else
                {
                    await method(caller, source, 1, []);
                }
                putU32(out, source);
                return S_OK;
            }
        }
        catch (e){
            if (e instanceof CodecError)
            {
                return e.hr;
            }
            throw e;
        }
        const converter = makeConverter();
        const initialize = converter.interfaceFor(INTERFACES.IWICFormatConverter.iid)
            ?.methods.find(m=>m.name === 'Initialize');
        const hr = await /** @type {any} */ (initialize).invoke(converter,
            [source, format, 0, 0, 0, 0, PALETTE_TYPE.MEDIAN_CUT]);
        if (hr < 0)
        {
            await letGo(heldOf(converter), caller);
            converter.release();
            return hr;
        }
        return hand(converter, 'IWICBitmapSource', out);
    };

    /**
     * WICCreateBitmapFromSection(Ex): a bitmap over a view of a section.
     *
     * @param {number[]} args  width, height, format, section, stride, offset, [access,] out
     */
    const bitmapFromSection = args=>{
        const [width, height, format, section, stride, offset] = args;
        const out = args[args.length - 1];
        if (format === 0 || out === 0 || section === 0)
        {
            return E_INVALIDARG;
        }
        const f = formatOf(guid(format));
        if (!f)
        {
            return WINCODEC.UNSUPPORTEDPIXELFORMAT;
        }
        if (stride < rowBytes(f, width))
        {
            return E_INVALIDARG;
        }
        const address = host.mapSection?.(section, offset, stride * height) ?? 0;
        if (address === 0)
        {
            if (!host.mapSection)
            {
                diverge('WICCreateBitmapFromSection', 'not provided');
            }
            return E_INVALIDARG;
        }
        return hand(makeBitmap(width, height, f, { address, stride }), 'IWICBitmap', out);
    };

    return {
        kit, makeFactory, makeConverter, makePalette, convertBitmapSource, bitmapFromSection,
        makeColorContext,
        /** Each class a program can make by CLSID, with the factory of its objects. */
        classes: /** @type {[string, () => ComObject][]} */ ([
            [GUID.CLSID_ImagingFactory, makeFactory],
            [CLSID_IMAGING_FACTORY2, makeFactory],
            [GUID.CLSID_DefaultFormatConverter, makeConverter],
            ...CONTAINERS.filter(c=>c.decode).map(c=>/** @type {[string, () => ComObject]} */ (
                [c.decoder, ()=>makeDecoder(c)])),
        ]),
    };
}
