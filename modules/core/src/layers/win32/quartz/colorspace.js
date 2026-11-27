/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz's Color Space Converter on the filter base: it takes one uncompressed
 * RGB video type and passes the frames on as another, as the documentation
 * describes it - between 8-bit palettised, 555, 565, 24-bit and 32-bit RGB. A
 * graph puts it between a decompressor that makes one depth and a renderer
 * that takes another.
 *
 * The output pin offers the input's own type first, which passes the frames
 * through unchanged, then 32-bit, 24-bit, 565 and 555 RGB of the same size; it
 * makes no palettised output, which would need a palette chosen and the frame
 * dithered to it. A frame is converted a row at a time, in the order of the
 * input's rows: a bottom-up input to a top-down output (a negative height) is
 * turned over.
 */

import { FORMAT_VIDEO_INFO, MEDIATYPE_VIDEO } from './filter.js';

const S_OK = 0x00000000;
const VFW_E_TYPE_NOT_ACCEPTED = 0x8004022a | 0;
const VFW_E_NOT_CONNECTED = 0x80040209 | 0;
const VFW_S_NO_STOP_TIME = 0x00040270;

const CLSID_COLOR_SPACE_CONVERTER = '{1643E180-90F5-11CE-97D5-00AA0055595A}';

const MEDIASUBTYPE = {
    RGB8: '{E436EB7A-524F-11CE-9F53-0020AF0BA770}',
    RGB565: '{E436EB7B-524F-11CE-9F53-0020AF0BA770}',
    RGB555: '{E436EB7C-524F-11CE-9F53-0020AF0BA770}',
    RGB24: '{E436EB7D-524F-11CE-9F53-0020AF0BA770}',
    RGB32: '{E436EB7E-524F-11CE-9F53-0020AF0BA770}',
    ARGB32: '{773C9AC0-3274-11D0-B724-00AA006C1A01}',
};

/** The kind each RGB subtype is, ARGB32 drawn as 32-bit RGB. */
const KIND_OF_SUBTYPE = /** @type {Record<string, '8' | '555' | '565' | '24' | '32'>} */ ({
    [MEDIASUBTYPE.RGB8]: '8', [MEDIASUBTYPE.RGB555]: '555', [MEDIASUBTYPE.RGB565]: '565',
    [MEDIASUBTYPE.RGB24]: '24', [MEDIASUBTYPE.RGB32]: '32', [MEDIASUBTYPE.ARGB32]: '32',
});
const BITS_OF_KIND = { 8: 8, 555: 16, 565: 16, 24: 24, 32: 32 };

const BI_RGB = 0;
const BI_BITFIELDS = 3;
/** VIDEOINFOHEADER's BITMAPINFOHEADER, at its end. */
const BITMAP_AT = 0x30;
const BITMAP_BYTES = 40;
/** The 565 masks a BI_BITFIELDS 16-bit frame carries after its header. */
const MASKS_565 = [0xf800, 0x07e0, 0x001f];

/** IMediaSample's slots the converter reads. */
const SAMPLE = { GetPointer: 3, GetTime: 5, IsSyncPoint: 7, GetActualDataLength: 11,
    IsDiscontinuity: 15, GetMediaTime: 17 };

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

/**
 * The layout of one RGB frame, read off its media type; null for a type the
 * converter does not take.
 *
 * @typedef {Object} Layout
 * @property {number} width
 * @property {number} height     Rows, whatever their order.
 * @property {boolean} topDown
 * @property {'8' | '555' | '565' | '24' | '32'} kind
 * @property {number} stride
 * @property {Uint32Array | null} palette  0x00RRGGBB for each index of an 8-bit frame.
 *
 * @param {import('./filter.js').MediaType} type
 * @returns {Layout | null}
 */
export function layoutOf(type){
    if (type.major !== MEDIATYPE_VIDEO || type.formatType !== FORMAT_VIDEO_INFO
        || type.format.length < BITMAP_AT + BITMAP_BYTES)
    {
        return null;
    }
    const view = viewOf(type.format);
    const width = view.getInt32(BITMAP_AT + 4, true);
    const signed = view.getInt32(BITMAP_AT + 8, true);
    const bits = view.getUint16(BITMAP_AT + 14, true);
    const compression = view.getUint32(BITMAP_AT + 16, true);
    if (width <= 0 || signed === 0)
    {
        return null;
    }
    // The subtype names the kind; the header must agree with it on the depth,
    // and is BI_RGB or, for the masked kinds, BI_BITFIELDS.
    const kind = KIND_OF_SUBTYPE[type.sub.toUpperCase()] ?? null;
    if (kind === null || bits !== BITS_OF_KIND[kind]
        || (compression !== BI_RGB
            && !(compression === BI_BITFIELDS && kind !== '8' && kind !== '24')))
    {
        return null;
    }
    let palette = null;
    if (kind === '8')
    {
        const used = view.getUint32(BITMAP_AT + 32, true) || 256;
        const room = Math.floor((type.format.length - BITMAP_AT - BITMAP_BYTES) / 4);
        const entries = Math.min(used, 256, room);
        palette = new Uint32Array(256);
        for (let index = 0; index < entries; index++)
        {
            palette[index] = view.getUint32(BITMAP_AT + BITMAP_BYTES + index * 4, true) & 0xffffff;
        }
    }
    return { width, height: Math.abs(signed), topDown: signed < 0, kind,
        stride: (width * bits + 31 >>> 5) * 4, palette };
}

/**
 * Converts one frame between two layouts of the same size.
 *
 * @param {Uint8Array} source @param {Layout} from @param {Layout} to
 * @returns {Uint8Array}
 */
export function convertFrame(source, from, to){
    const out = new Uint8Array(to.stride * to.height);
    const rows = Math.min(from.height, to.height);
    const width = Math.min(from.width, to.width);
    const turned = from.topDown !== to.topDown;
    for (let row = 0; row < rows; row++)
    {
        const at = row * from.stride;
        const into = (turned ? to.height - 1 - row : row) * to.stride;
        for (let x = 0; x < width; x++)
        {
            let rgb;
            switch (from.kind)
            {
                case '8':
                    rgb = /** @type {Uint32Array} */ (from.palette)[source[at + x] ?? 0];
                    break;
                case '555': {
                    const word = (source[at + x * 2] ?? 0) | (source[at + x * 2 + 1] ?? 0) << 8;
                    const r = word >>> 10 & 31;
                    const g = word >>> 5 & 31;
                    const b = word & 31;
                    rgb = (r << 3 | r >>> 2) << 16 | (g << 3 | g >>> 2) << 8 | (b << 3 | b >>> 2);
                    break;
                }
                case '565': {
                    const word = (source[at + x * 2] ?? 0) | (source[at + x * 2 + 1] ?? 0) << 8;
                    const r = word >>> 11 & 31;
                    const g = word >>> 5 & 63;
                    const b = word & 31;
                    rgb = (r << 3 | r >>> 2) << 16 | (g << 2 | g >>> 4) << 8 | (b << 3 | b >>> 2);
                    break;
                }
                case '24':
                    rgb = (source[at + x * 3 + 2] ?? 0) << 16 | (source[at + x * 3 + 1] ?? 0) << 8
                        | (source[at + x * 3] ?? 0);
                    break;
                default:
                    rgb = (source[at + x * 4 + 2] ?? 0) << 16 | (source[at + x * 4 + 1] ?? 0) << 8
                        | (source[at + x * 4] ?? 0);
            }
            const r = rgb >>> 16 & 0xff;
            const g = rgb >>> 8 & 0xff;
            const b = rgb & 0xff;
            switch (to.kind)
            {
                case '555': {
                    const word = (r >>> 3) << 10 | (g >>> 3) << 5 | b >>> 3;
                    out[into + x * 2] = word & 0xff;
                    out[into + x * 2 + 1] = word >>> 8;
                    break;
                }
                case '565': {
                    const word = (r >>> 3) << 11 | (g >>> 2) << 5 | b >>> 3;
                    out[into + x * 2] = word & 0xff;
                    out[into + x * 2 + 1] = word >>> 8;
                    break;
                }
                case '24':
                    out[into + x * 3] = b;
                    out[into + x * 3 + 1] = g;
                    out[into + x * 3 + 2] = r;
                    break;
                default:
                    out[into + x * 4] = b;
                    out[into + x * 4 + 1] = g;
                    out[into + x * 4 + 2] = r;
            }
        }
    }
    return out;
}

/**
 * A VIDEOINFOHEADER type of this size in one of the converter's output kinds,
 * the rectangles and frame time of `like` kept.
 *
 * @param {Layout} size @param {'555' | '565' | '24' | '32'} kind
 * @param {Uint8Array} like  The input's VIDEOINFOHEADER.
 * @returns {import('./filter.js').MediaType}
 */
export function rgbType(size, kind, like){
    const bits = kind === '24' ? 24 : kind === '32' ? 32 : 16;
    const masks = kind === '565';
    const format = new Uint8Array(BITMAP_AT + BITMAP_BYTES + (masks ? 12 : 0));
    format.set(like.subarray(0, BITMAP_AT));
    const view = viewOf(format);
    const stride = (size.width * bits + 31 >>> 5) * 4;
    view.setUint32(BITMAP_AT, BITMAP_BYTES, true);
    view.setInt32(BITMAP_AT + 4, size.width, true);
    view.setInt32(BITMAP_AT + 8, size.topDown ? -size.height : size.height, true);
    view.setUint16(BITMAP_AT + 12, 1, true);
    view.setUint16(BITMAP_AT + 14, bits, true);
    view.setUint32(BITMAP_AT + 16, masks ? BI_BITFIELDS : BI_RGB, true);
    view.setUint32(BITMAP_AT + 20, stride * size.height, true);
    if (masks)
    {
        MASKS_565.forEach((mask, index)=>
            view.setUint32(BITMAP_AT + BITMAP_BYTES + index * 4, mask, true));
    }
    const sub = kind === '24' ? MEDIASUBTYPE.RGB24 : kind === '32' ? MEDIASUBTYPE.RGB32
        : kind === '565' ? MEDIASUBTYPE.RGB565 : MEDIASUBTYPE.RGB555;
    return { major: MEDIATYPE_VIDEO, sub, fixed: true, temporal: false,
        sampleSize: stride * size.height, formatType: FORMAT_VIDEO_INFO, format };
}

/**
 * The converter's class over the filter base, by CLSID.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 * @param {ReturnType<typeof import('./passthru.js').createPassThru>} passThru
 * @returns {Map<string, () => import('../ole32/objects.js').ComClassDefinition>}
 */
export function createColorSpaceConverter(base, host, passThru){
    /**
     * @typedef {Object} ConverterState
     * @property {import('./filter.js').MediaType | null} source
     * @property {Layout | null} from
     * @property {Layout | null} to
     */

    /** @param {import('./filter.js').Filter} filter @returns {ConverterState} */
    const stateOf = filter=>filter.state2;

    /** @param {import('./filter.js').Filter} filter */
    const outputOf = filter=>filter.pins.find(pin=>pin.spec.direction === 'output');
    /** @param {import('./filter.js').Filter} filter */
    const inputOf = filter=>filter.pins.find(pin=>pin.spec.direction === 'input');

    /**
     * What the output offers once the input is connected: the input's own
     * type, then each RGB kind it is not already.
     *
     * @param {import('./filter.js').Filter} filter
     * @returns {import('./filter.js').MediaType[]}
     */
    const offers = filter=>{
        const { source, from } = stateOf(filter);
        if (!source || !from)
        {
            return [];
        }
        /** @type {('32' | '24' | '565' | '555')[]} */
        const kinds = ['32', '24', '565', '555'];
        return [source, ...kinds.filter(kind=>kind !== from.kind)
            .map(kind=>rgbType(from, kind, source.format))];
    };

    /**
     * Converts one sample and pushes it on, on the thread that pushed it.
     *
     * @param {import('./filter.js').Pin} pin @param {number} sample
     */
    const receive = async(pin, sample)=>{
        const { from, to } = stateOf(pin.filter);
        const out = outputOf(pin.filter);
        if (!out || out.peer === 0 || !from || !to)
        {
            return VFW_E_NOT_CONNECTED;
        }
        const scratch = host.allocate(36);
        /** @param {number} at */
        const quad = at=>host.readU32(at) + (host.readU32(at + 4) | 0) * 0x1_0000_0000;
        await base.call(sample, SAMPLE.GetPointer, [scratch]);
        const data = host.readU32(scratch);
        const length = await base.call(sample, SAMPLE.GetActualDataLength) | 0;
        const timed = await base.call(sample, SAMPLE.GetTime, [scratch + 4, scratch + 12]);
        const mediaTimed = await base.call(sample, SAMPLE.GetMediaTime,
            [scratch + 20, scratch + 28]);
        // What is said of the sample passes on with it, as the base transform
        // copies it; a preroll sample's flag does not.
        const sync = await base.call(sample, SAMPLE.IsSyncPoint) === S_OK;
        const discontinuity = await base.call(sample, SAMPLE.IsDiscontinuity) === S_OK;
        const start = quad(scratch + 4);
        const stop = quad(scratch + 12);
        const media = mediaTimed === S_OK ? { start: quad(scratch + 20), stop: quad(scratch + 28) }
            : undefined;
        host.free(scratch);
        const frame = convertFrame(host.readMemory(data, Math.max(0, length)), from, to);
        // A sample with a start alone reads its stop as one past it (GetTime's
        // answer), and the output carries both.
        const times = timed === S_OK || timed === VFW_S_NO_STOP_TIME ? { start, stop } : {};
        return base.deliver(out, { data: frame, ...times, sync, discontinuity, media }, true);
    };

    const define = base.defineFilter({
        clsid: CLSID_COLOR_SPACE_CONVERTER,
        state: ()=>({ source: null, from: null, to: null }),
        pins: filter=>[
            {
                name: 'Input',
                id: 'In',
                direction: 'input',
                accepts: (_pin, type)=>layoutOf(type) !== null,
                connected: (pin, type)=>{
                    const layout = layoutOf(type);
                    if (!layout)
                    {
                        return VFW_E_TYPE_NOT_ACCEPTED;
                    }
                    Object.assign(stateOf(pin.filter), { source: type, from: layout });
                    return S_OK;
                },
                disconnected: pin=>{
                    Object.assign(stateOf(pin.filter), { source: null, from: null });
                },
                receive,
                endOfStream: pin=>{
                    const out = outputOf(pin.filter);
                    return out ? base.deliverEndOfStream(out, true) : S_OK;
                },
                flush: (pin, begin)=>{
                    const out = outputOf(pin.filter);
                    return out ? base.deliverFlush(out, begin, true) : S_OK;
                },
                newSegment: (pin, start, stop, rate)=>{
                    const out = outputOf(pin.filter);
                    return out ? base.deliverNewSegment(out, start, stop, rate, true) : S_OK;
                },
            },
            {
                name: 'XForm Out',
                id: 'Out',
                direction: 'output',
                types: pin=>offers(pin.filter),
                // A kind it can make, of the input's size; nothing before the
                // input is connected.
                accepts: (pin, type)=>{
                    const { from } = stateOf(pin.filter);
                    const layout = layoutOf(type);
                    return !!from && !!layout && layout.kind !== '8'
                        && layout.width === from.width && layout.height === from.height;
                },
                allocator: pin=>({ buffers: 1, size: Math.max(1, pin.type?.sampleSize ?? 1),
                    align: 1, prefix: 0 }),
                interfaces: passThru.seekingFaces(()=>inputOf(filter)?.peer ?? 0,
                    VFW_E_NOT_CONNECTED),
                connected: (pin, type)=>{
                    const state = stateOf(pin.filter);
                    const layout = layoutOf(type);
                    if (!state.from || !layout || layout.kind === '8')
                    {
                        return state.from ? VFW_E_TYPE_NOT_ACCEPTED : VFW_E_NOT_CONNECTED;
                    }
                    state.to = layout;
                    return S_OK;
                },
                disconnected: pin=>{
                    stateOf(pin.filter).to = null;
                },
            },
        ],
    });

    return new Map([[CLSID_COLOR_SPACE_CONVERTER, define]]);
}
