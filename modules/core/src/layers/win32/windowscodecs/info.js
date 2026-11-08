/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WIC's component information: what CreateComponentInfo and the component
 * enumerator hand out about the decoders, encoders, the format converter and
 * the pixel formats - each as the interface its kind has
 * (IWICBitmapDecoderInfo, IWICBitmapEncoderInfo, IWICFormatConverterInfo,
 * IWICPixelFormatInfo2). An encoder's info is given, its CreateInstance
 * refused: no encoder is provided.
 */

import { createComObject } from '../ole32/objects.js';
import { publishEnumerator } from '../ole32/enumerator.js';
import { CONTAINERS, WINCODEC } from './frames.js';
import { FORMATS, formatOf } from './formats.js';
import { GUID, INTERFACES } from './layout.js';
import { E_INVALIDARG, S_OK } from './kit.js';

/** WICComponentType. */
const TYPE = Object.freeze({ DECODER: 1, ENCODER: 2, CONVERTER: 4, PIXEL_FORMAT: 0x20 });

const IID_IENUMUNKNOWN = '{00000100-0000-0000-C000-000000000046}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const CLSID_COMPONENT_ENUMERATOR = '{B7A73A04-9D07-4E54-8C4C-C3B8E1A6E90A}';

/** The pixel formats each decoder hands frames out in (frames.js). */
const DECODED = Object.freeze({
    Bmp: ['1bppIndexed', '2bppIndexed', '4bppIndexed', '8bppIndexed', '16bppBGR555',
        '16bppBGR565', '24bppBGR', '32bppBGR', '32bppBGRA'],
    Png: ['BlackWhite', '2bppGray', '4bppGray', '8bppGray', '16bppGray', '1bppIndexed',
        '2bppIndexed', '4bppIndexed', '8bppIndexed', '24bppBGR', '48bppRGB', '32bppBGRA',
        '64bppRGBA'],
    Ico: ['32bppBGRA'],
    Jpeg: ['8bppGray', '24bppBGR', '32bppCMYK'],
    Gif: ['8bppIndexed'],
    Tiff: ['32bppBGRA'],
    Dds: ['32bppBGRA'],
    Wmp: ['32bppBGRA'],
});

/** @param {string} name */
const formatGuid = name=>/** @type {Record<string, string>} */ (GUID)[`PixelFormat${name}`];

/**
 * @typedef {Object} Component
 * @property {number} type
 * @property {string} clsid
 * @property {string} friendly
 * @property {string} iface  the interface its info answers to
 * @property {import('./frames.js').Container} [container]
 * @property {import('./formats.js').PixelFormat} [format]
 * @property {string[]} formats  GUIDs of the pixel formats it handles
 */

/** @type {Component[]} */
const COMPONENTS = [
    ...CONTAINERS.map(c=>({ type: TYPE.DECODER, clsid: c.decoder, friendly: c.friendly,
        iface: 'IWICBitmapDecoderInfo', container: c,
        formats: (/** @type {Record<string, string[]>} */ (DECODED)[c.name] ?? []).map(formatGuid) })),
    ...CONTAINERS.filter(c=>c.encoder).map(c=>({ type: TYPE.ENCODER, clsid: c.encoder,
        friendly: c.friendly.replace('Decoder', 'Encoder'), iface: 'IWICBitmapEncoderInfo',
        container: c, formats: [] })),
    { type: TYPE.CONVERTER, clsid: GUID.CLSID_DefaultFormatConverter,
        friendly: 'Default Format Converter', iface: 'IWICFormatConverterInfo',
        formats: FORMATS.filter(f=>f.read && f.write).map(f=>f.guid) },
    ...FORMATS.map(f=>({ type: TYPE.PIXEL_FORMAT, clsid: f.guid, friendly: f.name,
        iface: 'IWICPixelFormatInfo2', format: f, formats: [] })),
];

/** The bytes of one WICBitmapPattern on a 32-bit process. */
const PATTERN_SIZE = 24;

/**
 * Which bits of a pixel a channel takes: the packed formats by their fields,
 * the rest in equal parts in memory order, an indexed format's one channel
 * every bit.
 *
 * @param {import('./formats.js').PixelFormat} f @param {number} channel
 * @returns {Uint8Array | null}
 */
export function channelMask(f, channel){
    if (channel >= f.channels)
    {
        return null;
    }
    const bytes = new Uint8Array(Math.ceil(f.bpp / 8));
    /** @type {Record<string, number[][]>} */
    const packed = { '16bppBGR555': [[0, 5], [5, 5], [10, 5]],
        '16bppBGR565': [[0, 5], [5, 6], [11, 5]],
        '16bppBGRA5551': [[0, 5], [5, 5], [10, 5], [15, 1]] };
    const width = f.bpp / f.channels;
    const [start, length] = packed[f.name]?.[channel] ?? [channel * width, width];
    for (let bit = start; bit < start + length; bit++)
    {
        bytes[bit >> 3] |= 1 << (bit & 7);
    }
    return bytes;
}

/**
 * @param {import('./kit.js').Kit} kit @param {import('./kit.js').CodecsHost} host
 * @param {{ decoder: (container: import('./frames.js').Container) =>
 *     import('../ole32/objects.js').ComObject,
 *     converter: () => import('../ole32/objects.js').ComObject }} makers
 */
export function createInfos(kit, host, makers){
    const { make, hand, putU32, putGuid, giveString, guid, u32, diverge } = kit;

    /** @param {boolean} value @returns {import('./kit.js').Method} */
    const flag = value=>(object, [out])=>{
        if (out === 0)
        {
            return E_INVALIDARG;
        }
        putU32(out, value ? 1 : 0);
        return S_OK;
    };
    /** @param {string} value @returns {import('./kit.js').Method} */
    const text = value=>(object, [cch, buffer, actual])=>giveString(value, cch, buffer, actual);
    /** @param {string} value @returns {import('./kit.js').Method} */
    const guidOut = value=>(object, [out])=>{
        if (out === 0)
        {
            return E_INVALIDARG;
        }
        putGuid(out, value);
        return S_OK;
    };

    /** @param {Component} c @returns {import('../ole32/objects.js').ComObject} */
    const infoOf = c=>{
        /** @type {Record<string, import('./kit.js').Method>} */
        const impl = {
            GetComponentType: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, c.type);
                return S_OK;
            },
            GetCLSID: guidOut(c.clsid),
            GetSigningStatus: (object, [out])=>{
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, 1);
                return S_OK;
            },
            GetAuthor: text('Microsoft'),
            GetVendorGUID: guidOut(GUID.VendorMicrosoft),
            GetVersion: text('1.0.0.0'),
            GetSpecVersion: text('1.0.0.0'),
            GetFriendlyName: text(c.friendly),
            GetPixelFormats: (object, [count, formats, actual])=>{
                if (actual === 0)
                {
                    return E_INVALIDARG;
                }
                // With a buffer, the count is what was put in it.
                const given = formats === 0 ? c.formats : c.formats.slice(0, count);
                if (formats !== 0)
                {
                    given.forEach((g, i)=>putGuid(formats + i * 16, g));
                }
                putU32(actual, given.length);
                return S_OK;
            },
        };
        const container = c.container;
        if (container)
        {
            const decoder = c.type === TYPE.DECODER;
            /** @type {Record<string, import('./kit.js').Method>} */
            const codec = {
                GetContainerFormat: guidOut(container.guid),
                GetColorManagementVersion: text('1.0.0.0'),
                GetDeviceManufacturer: text(''),
                GetDeviceModels: text(''),
                GetMimeTypes: text(container.mime),
                GetFileExtensions: text(container.extensions),
                DoesSupportAnimation: flag(container.animation),
                DoesSupportChromakey: flag(container.name === 'Gif'),
                DoesSupportLossless: flag(container.lossless),
                DoesSupportMultiframe: flag(container.multiframe),
                MatchesMimeType: (object, [mime, out])=>{
                    if (mime === 0 || out === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const asked = host.readWideString(mime >>> 0, 256 * 2).toLowerCase();
                    putU32(out, container.mime.split(',').includes(asked) ? 1 : 0);
                    return S_OK;
                },
                CreateInstance: (object, [out])=>{
                    if (out === 0)
                    {
                        return E_INVALIDARG;
                    }
                    if (!decoder || !container.decode)
                    {
                        putU32(out, 0);
                        diverge(`${c.friendly}::CreateInstance`, 'not provided');
                        return WINCODEC.COMPONENTNOTFOUND;
                    }
                    return hand(makers.decoder(container), 'IWICBitmapDecoder', out);
                },
            };
            Object.assign(impl, codec);
            if (decoder)
            {
                /** @type {Record<string, import('./kit.js').Method>} */
                const matching = {
                    GetPatterns: (object, [size, patterns, count, actual])=>{
                        if (count === 0 || actual === 0)
                        {
                            return E_INVALIDARG;
                        }
                        const list = container.patterns;
                        const total = list.length * PATTERN_SIZE
                            + list.reduce((sum, p)=>sum + p.length * 2, 0);
                        putU32(count, list.length);
                        putU32(actual, total);
                        if (patterns === 0)
                        {
                            return S_OK;
                        }
                        if (size < total)
                        {
                            return WINCODEC.INSUFFICIENTBUFFER;
                        }
                        let bytesAt = patterns + list.length * PATTERN_SIZE;
                        list.forEach((p, i)=>{
                            const record = new Uint8Array(PATTERN_SIZE);
                            const view = new DataView(record.buffer);
                            view.setUint32(8, p.length, true);
                            view.setUint32(12, bytesAt, true);
                            view.setUint32(16, bytesAt + p.length, true);
                            host.writeMemory(patterns + i * PATTERN_SIZE, record);
                            host.writeMemory(bytesAt, Uint8Array.from(p));
                            host.writeMemory(bytesAt + p.length,
                                new Uint8Array(p.length).fill(0xff));
                            bytesAt += p.length * 2;
                        });
                        return S_OK;
                    },
                    MatchesPattern: async(object, [stream, out])=>{
                        if (stream === 0 || out === 0)
                        {
                            return E_INVALIDARG;
                        }
                        const caller = host.currentThread();
                        await kit.method(caller, stream, 5, [0, 0, 0, 0]);
                        const at = host.heap.allocate(16) >>> 0;
                        let head;
                        try
                        {
                            await kit.method(caller, stream, 3, [at, 8, at + 8]);
                            head = host.readMemory(at, Math.min(8, u32(at + 8))).slice();
                        }
                        finally
                        {
                            host.heap.free(at);
                        }
                        putU32(out, container.patterns.some(p=>p.every((b, i)=>head[i] === b))
                            ? 1 : 0);
                        return S_OK;
                    },
                };
                Object.assign(impl, matching);
            }
        }
        if (c.type === TYPE.CONVERTER)
        {
            impl.CreateInstance = (object, [out])=>(out === 0 ? E_INVALIDARG
                : hand(makers.converter(), 'IWICFormatConverter', out));
        }
        const f = c.format;
        if (f)
        {
            /** @type {Record<string, import('./kit.js').Method>} */
            const pixel = {
                GetFormatGUID: guidOut(f.guid),
                GetBitsPerPixel: (object, [out])=>{
                    if (out === 0)
                    {
                        return E_INVALIDARG;
                    }
                    putU32(out, f.bpp);
                    return S_OK;
                },
                GetChannelCount: (object, [out])=>{
                    if (out === 0)
                    {
                        return E_INVALIDARG;
                    }
                    putU32(out, f.channels);
                    return S_OK;
                },
                GetChannelMask: (object, [channel, size, buffer, actual])=>{
                    const mask = channelMask(f, channel >>> 0);
                    if (!mask || actual === 0)
                    {
                        return E_INVALIDARG;
                    }
                    putU32(actual, mask.length);
                    if (buffer !== 0)
                    {
                        if (size < mask.length)
                        {
                            return E_INVALIDARG;
                        }
                        host.writeMemory(buffer >>> 0, mask);
                    }
                    return S_OK;
                },
                SupportsTransparency: flag(f.alpha || f.indexed),
                GetNumericRepresentation: (object, [out])=>{
                    if (out === 0)
                    {
                        return E_INVALIDARG;
                    }
                    // WICPixelFormatNumericRepresentation: indexed 1, unsigned
                    // integer 2, fixed 4, float 5.
                    putU32(out, f.indexed ? 1 : f.name.includes('FixedPoint') ? 4
                        : f.linear ? 5 : 2);
                    return S_OK;
                },
            };
            Object.assign(impl, pixel);
        }
        return make(c.clsid, [c.iface], impl, { component: c });
    };

    /** @param {string} clsid */
    const find = clsid=>COMPONENTS.find(c=>c.clsid === clsid)
        ?? (formatOf(clsid) ? COMPONENTS.find(c=>c.format?.guid === clsid) ?? null : null);

    return {
        /** The info of a component, or null for one this build does not know. @param {string} clsid */
        make: clsid=>{
            const c = find(clsid);
            return c ? infoOf(c) : null;
        },
        /**
         * An IEnumUnknown over the infos of the kinds `types` names.
         *
         * @param {number} types @param {number} out
         */
        enumerate: (types, out)=>publishEnumerator({
            writeMemory: host.writeMemory,
            makeObject: (clsid, definition)=>createComObject(clsid, definition),
            publish: (object, iid)=>host.vtables.publish(object, iid),
            callerThread: host.currentThread,
        }, { clsid: CLSID_COMPONENT_ENUMERATOR, iid: IID_IENUMUNKNOWN, size: 4 }, {
            items: COMPONENTS.filter(c=>(c.type & types) !== 0),
            write: (at, c)=>{
                const pointer = host.vtables.publish(infoOf(c), IID_IUNKNOWN) >>> 0;
                putU32(at, pointer);
                return pointer !== 0;
            },
        }, out),
        guid,
    };
}

export { INTERFACES };
