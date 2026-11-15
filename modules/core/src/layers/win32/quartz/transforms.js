/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz's transform filters on the filter base: the AVI Decompressor, which
 * puts a compressed video stream through the installable compressor that
 * decompresses it (msvfw32's ICM: the system's Cinepak, Video 1 and RLE, or a
 * codec the program installed) and passes the frames on as RGB.
 *
 * A transform has an input pin that takes samples pushed into it and an
 * output pin that pushes what it makes of them, on the thread that pushed
 * them, inside the input pin's Receive - the end of the stream, a flush and a
 * new segment pass through the same way. The rules are the documentation's:
 * the input pin connects to what a codec can decompress, the output pin offers
 * what that codec can decompress it to, and a connection is decided by asking
 * the codec (ICM_DECOMPRESS_QUERY), never by guessing.
 */

import {
    FORMAT_VIDEO_INFO, MEDIATYPE_VIDEO, STATE_STOPPED,
} from './filter.js';
import { describe } from './describe.js';
import {
    IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING, IMEDIA_POSITION_SLOTS, IMEDIA_SEEKING_SLOTS,
} from './interfaces.js';
import { videoSubtype } from './splitters.js';

const S_OK = 0x00000000;
const E_FAIL = 0x80004005 | 0;
const VFW_E_TYPE_NOT_ACCEPTED = 0x8004022a | 0;
const VFW_E_NOT_CONNECTED = 0x80040209 | 0;
const VFW_S_NO_STOP_TIME = 0x00040270;
const E_NOTIMPL = 0x80004001 | 0;

export const CLSID_AVI_DECOMPRESSOR = '{CF49D4E0-1115-11CE-B03A-0020AF0BA770}';

/** 'vidc', the installable compressors' type for video. */
const ICTYPE_VIDEO = 0x63646976;
const ICMODE_DECOMPRESS = 2;
const ICERR_OK = 0;
/** ICM_USER's messages a decompression is made of. */
const ICM = { GET_FORMAT: 0x400a, QUERY: 0x400b, BEGIN: 0x400c, END: 0x400e };
/** ICDecompress's dwFlags: the frame is not a key frame. */
const ICDECOMPRESS_NOTKEYFRAME = 0x08000000;

/** VIDEOINFOHEADER's BITMAPINFOHEADER, at its end. */
const BITMAP_AT = 0x30;
const BITMAP_BYTES = 40;

/** IMediaSample's slots a transform reads. */
const SAMPLE = { GetPointer: 3, GetTime: 5, IsSyncPoint: 7, GetActualDataLength: 11 };

/** The depths the decompressor offers beside the codec's own, as RGB. */
const DEPTHS = [32, 24, 16, 8];

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

/**
 * A BITMAPINFOHEADER for an uncompressed frame of this size and depth.
 *
 * @param {number} width @param {number} height @param {number} bits
 */
export function rgbHeader(width, height, bits){
    const header = new Uint8Array(BITMAP_BYTES);
    const view = viewOf(header);
    const stride = (width * bits + 31 >>> 5) * 4;
    view.setUint32(0, BITMAP_BYTES, true);
    view.setInt32(4, width, true);
    view.setInt32(8, height, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, bits, true);
    view.setUint32(20, stride * Math.abs(height), true);
    return header;
}

/**
 * A video media type over a BITMAPINFOHEADER, the frame time and rectangles
 * of `like` kept.
 *
 * @param {Uint8Array} header @param {Uint8Array} like  A VIDEOINFOHEADER.
 * @returns {import('./filter.js').MediaType}
 */
export function videoInfo(header, like){
    const format = new Uint8Array(BITMAP_AT + header.length);
    format.set(like.subarray(0, BITMAP_AT));
    format.set(header, BITMAP_AT);
    const view = viewOf(header);
    const compression = view.getUint32(16, true);
    const size = view.getUint32(20, true);
    return {
        major: MEDIATYPE_VIDEO, sub: videoSubtype(compression, view.getUint16(14, true)),
        fixed: true, temporal: false, sampleSize: size, formatType: FORMAT_VIDEO_INFO, format,
    };
}

/**
 * The transforms' classes over the filter base, by CLSID.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 * @param {import('./filter.js').IcmHost} icm
 * @returns {Map<string, () => import('../ole32/objects.js').ComClassDefinition>}
 */
export function createTransforms(base, host, icm){
    /**
     * @typedef {Object} DecompressorState
     * @property {number} hic        The codec, open while the input is connected.
     * @property {number} input      The input's BITMAPINFOHEADER, in guest memory.
     * @property {number} output     The output's, in guest memory, while it is connected.
     * @property {import('./filter.js').MediaType | null} source  The input's type.
     * @property {boolean} begun
     */

    /** @param {import('./filter.js').Filter} filter @returns {DecompressorState} */
    const stateOf = filter=>filter.state2;

    /** A header in guest memory, the caller's to free. @param {Uint8Array} header */
    const lend = header=>{
        const at = host.allocate(header.length);
        host.writeMemory(at, header);
        return at;
    };

    /** The BITMAPINFOHEADER and what follows it in a VIDEOINFOHEADER type. @param {import('./filter.js').MediaType} type */
    const bitmapOf = type=>type.format.subarray(BITMAP_AT);

    /** @param {import('./filter.js').MediaType} type */
    const isVideo = type=>type.major === MEDIATYPE_VIDEO && type.formatType === FORMAT_VIDEO_INFO
        && type.format.length >= BITMAP_AT + BITMAP_BYTES;

    /**
     * Whether a codec decompresses frames of this input, to this output where
     * one is given; the codec found is closed.
     *
     * @param {Uint8Array} input @param {Uint8Array | null} output
     */
    const decompresses = async(input, output)=>{
        const into = lend(input);
        const out = output ? lend(output) : 0;
        const hic = await icm.locate(ICTYPE_VIDEO, 0, into, out, ICMODE_DECOMPRESS) >>> 0;
        if (hic !== 0)
        {
            await icm.close(hic);
        }
        host.free(into);
        if (out !== 0)
        {
            host.free(out);
        }
        return hic !== 0;
    };

    /**
     * What the output pin offers: the codec's own choice first, then RGB at
     * each depth the codec says it can make.
     *
     * @param {import('./filter.js').Filter} filter
     * @returns {Promise<import('./filter.js').MediaType[]>}
     */
    const offers = async filter=>{
        const state = stateOf(filter);
        const source = state.source;
        if (!source || state.hic === 0)
        {
            return [];
        }
        const view = viewOf(bitmapOf(source));
        const width = view.getInt32(4, true);
        const height = Math.abs(view.getInt32(8, true));
        /** @type {Uint8Array[]} */
        const headers = [];
        // The codec's own choice, ICM_DECOMPRESS_GET_FORMAT: the size it
        // needs asked first, then the header itself.
        const needed = await icm.send(state.hic, ICM.GET_FORMAT, state.input, 0) | 0;
        if (needed >= BITMAP_BYTES)
        {
            const out = host.allocate(needed);
            if (await icm.send(state.hic, ICM.GET_FORMAT, state.input, out) === ICERR_OK)
            {
                headers.push(host.readMemory(out, needed).slice());
            }
            host.free(out);
        }
        for (const bits of DEPTHS)
        {
            const header = rgbHeader(width, height, bits);
            const out = lend(header);
            const answer = await icm.send(state.hic, ICM.QUERY, state.input, out) | 0;
            host.free(out);
            const same = headers.some(each=>viewOf(each).getUint16(14, true) === bits
                && viewOf(each).getUint32(16, true) === 0);
            if (answer === ICERR_OK && !same)
            {
                headers.push(header);
            }
        }
        return headers.map(header=>videoInfo(header, source.format));
    };

    /** @type {Map<import('./filter.js').Filter, import('./filter.js').MediaType[]>} */
    const offered = new Map();

    /**
     * Whether the input's codec decompresses to this type (ICM_DECOMPRESS_QUERY).
     *
     * @param {import('./filter.js').Filter} filter @param {import('./filter.js').MediaType} type
     */
    const query = async(filter, type)=>{
        const state = stateOf(filter);
        if (state.hic === 0)
        {
            return false;
        }
        const out = lend(bitmapOf(type).slice());
        const answer = await icm.send(state.hic, ICM.QUERY, state.input, out) | 0;
        host.free(out);
        return answer === ICERR_OK;
    };

    /**
     * A seeking interface on the output pin that is the input's peer's: a
     * transform passes a seek upstream, to the filter that has the stream.
     *
     * @param {import('./filter.js').Filter} filter @param {string} iid
     * @param {[string, number][]} slots
     */
    const passThrough = (filter, iid, slots)=>Object.fromEntries(slots.map(([name], index)=>[
        name,
        /** @param {any} pin @param {number[]} args */
        async(pin, args)=>{
            const input = filter.pins.find(each=>each.spec.direction === 'input');
            if (!input || input.peer === 0)
            {
                return VFW_E_NOT_CONNECTED;
            }
            const upstream = await base.queryInterface(input.peer, iid);
            if (upstream === 0)
            {
                return E_NOTIMPL;
            }
            const answer = await base.call(upstream, 3 + index, args);
            await base.release(upstream);
            return answer;
        },
    ]));

    /**
     * Ends a decompression begun, and frees the output's header.
     *
     * @param {DecompressorState} state
     */
    const end = async state=>{
        if (state.begun)
        {
            state.begun = false;
            await icm.send(state.hic, ICM.END, 0, 0);
        }
    };

    /** @param {import('./filter.js').Filter} filter */
    const outputOf = filter=>filter.pins.find(pin=>pin.spec.direction === 'output');

    /**
     * Decompresses one sample and pushes the frame on, on the thread that
     * pushed the sample.
     *
     * @param {import('./filter.js').Pin} pin @param {number} sample
     */
    const receive = async(pin, sample)=>{
        const state = stateOf(pin.filter);
        const out = outputOf(pin.filter);
        if (!out || out.peer === 0 || state.output === 0 || !out.type)
        {
            return VFW_E_NOT_CONNECTED;
        }
        const scratch = host.allocate(20);
        await base.call(sample, SAMPLE.GetPointer, [scratch]);
        const data = host.readU32(scratch);
        const length = await base.call(sample, SAMPLE.GetActualDataLength) | 0;
        const timed = await base.call(sample, SAMPLE.GetTime, [scratch + 4, scratch + 12]);
        const sync = await base.call(sample, SAMPLE.IsSyncPoint) === S_OK;
        const start = host.readU32(scratch + 4) + (host.readU32(scratch + 8) | 0) * 0x1_0000_0000;
        const stop = host.readU32(scratch + 12) + (host.readU32(scratch + 16) | 0) * 0x1_0000_0000;
        host.free(scratch);
        // The input's header says how much this frame is.
        const input = new Uint8Array(host.readMemory(state.input, BITMAP_BYTES));
        viewOf(input).setUint32(20, length >>> 0, true);
        host.writeMemory(state.input, input);
        const size = out.type.sampleSize;
        const bits = host.allocate(Math.max(1, size));
        const answer = await icm.decompress(state.hic, sync ? 0 : ICDECOMPRESS_NOTKEYFRAME,
            state.input, data, state.output, bits) | 0;
        const frame = host.readMemory(bits, size).slice();
        host.free(bits);
        if (answer !== ICERR_OK)
        {
            // A frame the codec could not make is dropped, as Windows' does.
            return S_OK;
        }
        const times = timed === S_OK ? { start, stop }
            : timed === VFW_S_NO_STOP_TIME ? { start } : {};
        return base.deliver(out, { data: frame, ...times, sync: true }, true);
    };

    const define = base.defineFilter({
        clsid: CLSID_AVI_DECOMPRESSOR,
        state: ()=>({ hic: 0, input: 0, output: 0, source: null, begun: false }),
        pins: filter=>[
            {
                name: 'XForm In',
                id: 'In',
                direction: 'input',
                // A type a codec decompresses, which only the codecs can say.
                accepts: async(pin, type)=>isVideo(type)
                    && await decompresses(bitmapOf(type), null),
                connected: async(pin, type)=>{
                    const state = stateOf(pin.filter);
                    state.input = lend(bitmapOf(type).slice());
                    state.hic = await icm.locate(ICTYPE_VIDEO, 0, state.input, 0,
                        ICMODE_DECOMPRESS) >>> 0;
                    if (state.hic === 0)
                    {
                        host.free(state.input);
                        state.input = 0;
                        return VFW_E_TYPE_NOT_ACCEPTED;
                    }
                    state.source = type;
                    offered.set(pin.filter, await offers(pin.filter));
                    return S_OK;
                },
                disconnected: async pin=>{
                    const state = stateOf(pin.filter);
                    await end(state);
                    if (state.hic !== 0)
                    {
                        await icm.close(state.hic);
                        state.hic = 0;
                    }
                    if (state.input !== 0)
                    {
                        host.free(state.input);
                        state.input = 0;
                    }
                    state.source = null;
                    offered.delete(pin.filter);
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
                types: pin=>offered.get(pin.filter) ?? [],
                // A type the connected codec says it can decompress to.
                accepts: async(pin, type)=>isVideo(type) && await query(pin.filter, type),
                allocator: pin=>({ buffers: 1, size: Math.max(1, pin.type?.sampleSize ?? 1),
                    align: 1, prefix: 0 }),
                interfaces: [
                    describe(IID_IMEDIA_SEEKING, IMEDIA_SEEKING_SLOTS,
                        passThrough(filter, IID_IMEDIA_SEEKING, IMEDIA_SEEKING_SLOTS)),
                    describe(IID_IMEDIA_POSITION, IMEDIA_POSITION_SLOTS,
                        passThrough(filter, IID_IMEDIA_POSITION, IMEDIA_POSITION_SLOTS)),
                ],
                connected: async(pin, type)=>{
                    const state = stateOf(pin.filter);
                    if (state.source === null)
                    {
                        return VFW_E_NOT_CONNECTED;
                    }
                    if (!await query(pin.filter, type))
                    {
                        return VFW_E_TYPE_NOT_ACCEPTED;
                    }
                    state.output = lend(bitmapOf(type).slice());
                    return S_OK;
                },
                disconnected: async pin=>{
                    const state = stateOf(pin.filter);
                    await end(state);
                    if (state.output !== 0)
                    {
                        host.free(state.output);
                        state.output = 0;
                    }
                },
            },
        ],
        changed: async(filter, from, to)=>{
            const state = stateOf(filter);
            if (from === STATE_STOPPED && to !== STATE_STOPPED && state.hic !== 0
                && state.output !== 0 && !state.begun)
            {
                const answer = await icm.send(state.hic, ICM.BEGIN, state.input, state.output) | 0;
                if (answer !== ICERR_OK)
                {
                    return E_FAIL;
                }
                state.begun = true;
            }
            else if (to === STATE_STOPPED)
            {
                await end(state);
            }
            return S_OK;
        },
        destroy: filter=>{
            offered.delete(filter);
        },
    });

    return new Map([[CLSID_AVI_DECOMPRESSOR, define]]);
}

