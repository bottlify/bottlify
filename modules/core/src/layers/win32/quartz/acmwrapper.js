/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz's ACM Wrapper on the filter base: it puts a compressed audio stream
 * through the audio compression manager (msacm32's drivers: ADPCM, MP3, the
 * PCM converter) and passes it on as PCM - the audio counterpart of the AVI
 * Decompressor, as the documentation describes it.
 *
 * The input pin takes an audio type whose WAVEFORMATEX the manager can
 * suggest a PCM format for (acmFormatSuggest) and open a stream from; the
 * output pin offers that PCM format, and takes another PCM format only where
 * the manager would open a stream into it. The stream is opened once both
 * pins are connected and closed when either goes; each sample is converted
 * whole, in the thread that pushed it, the output carrying the input's times.
 */

import { FORMAT_WAVE_FORMAT_EX, MEDIATYPE_AUDIO } from './filter.js';
import { audioType } from './splitters.js';
import { describe } from './describe.js';
import { parseGuid } from '../../../system/guid.js';
import { wholeAddress } from '../common/pointers.js';

const S_OK = 0x00000000;
const E_POINTER = 0x80004003 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const VFW_E_TYPE_NOT_ACCEPTED = 0x8004022a | 0;
const VFW_E_NOT_CONNECTED = 0x80040209 | 0;
const VFW_S_NO_STOP_TIME = 0x00040270;

export const CLSID_ACM_WRAPPER = '{6A08CF80-0E18-11CF-A24D-0020AFD79767}';
const IID_IPERSIST_PROPERTY_BAG = '{37D84F60-42CB-11CE-8135-00AA004BB851}';
/** @type {[string, number][]} */
const IPERSIST_PROPERTY_BAG_SLOTS = [['GetClassID', 1], ['InitNew', 0], ['Load', 2], ['Save', 3]];

const WAVE_FORMAT_PCM = 1;
const MMSYSERR_NOERROR = 0;
/** acmFormatSuggest: the destination's format tag is fixed. */
const ACM_FORMATSUGGESTF_WFORMATTAG = 0x00010000;
/** acmStreamOpen: only ask whether the conversion is possible. */
const ACM_STREAMOPENF_QUERY = 0x00000001;
/** ACMSTREAMHEADER, as a 32-bit process lays it out. */
const HEADER = { cbStruct: 0, pbSrc: 12, cbSrcLength: 16, pbDst: 28, cbDstLength: 32,
    cbDstLengthUsed: 36, SIZE: 84 };
/** The room a suggested format is written into: WAVEFORMATEX and more than any PCM needs. */
const SUGGESTED_BYTES = 64;

/** IMediaSample's slots the wrapper reads. */
const SAMPLE = { GetPointer: 3, GetTime: 5, IsSyncPoint: 7, GetActualDataLength: 11,
    IsDiscontinuity: 15 };

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * The wrapper's class over the filter base, by CLSID.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 * @param {import('./filter.js').AcmHost} acm
 * @param {ReturnType<typeof import('./passthru.js').createPassThru>} passThru
 * @returns {Map<string, () => import('../ole32/objects.js').ComClassDefinition>}
 */
export function createAcmWrapper(base, host, acm, passThru){
    /**
     * @typedef {Object} WrapperState
     * @property {import('./filter.js').MediaType | null} source
     * @property {import('./filter.js').MediaType | null} suggested  The PCM the manager chose.
     * @property {import('./filter.js').MediaType | null} target  The output's type, once connected.
     * @property {number} stream  The open stream; 0 while either pin is unconnected.
     */

    /** @param {import('./filter.js').Filter} filter @returns {WrapperState} */
    const stateOf = filter=>filter.state2;
    /** @param {import('./filter.js').Filter} filter */
    const outputOf = filter=>filter.pins.find(pin=>pin.spec.direction === 'output');
    /** @param {import('./filter.js').Filter} filter */
    const inputOf = filter=>filter.pins.find(pin=>pin.spec.direction === 'input');

    /** A copy in guest memory, the caller's to free. @param {Uint8Array} bytes */
    const lend = bytes=>{
        const at = host.allocate(Math.max(4, bytes.length));
        host.writeMemory(at, bytes);
        return at;
    };

    /** @param {import('./filter.js').MediaType} type */
    const isWave = type=>type.major === MEDIATYPE_AUDIO && type.formatType === FORMAT_WAVE_FORMAT_EX
        && type.format.length >= 16;

    /** @param {import('./filter.js').MediaType} type */
    const isPcm = type=>isWave(type)
        && new DataView(type.format.buffer, type.format.byteOffset).getUint16(0, true)
            === WAVE_FORMAT_PCM;

    /**
     * The PCM format the manager suggests for a source, or null where none.
     *
     * @param {import('./filter.js').MediaType} type
     */
    const suggest = async type=>{
        const source = lend(type.format);
        const into = host.allocate(SUGGESTED_BYTES);
        host.writeMemory(into, new Uint8Array(SUGGESTED_BYTES));
        host.writeMemory(into, new Uint8Array([WAVE_FORMAT_PCM, 0]));
        const answer = await acm.call('acmFormatSuggest',
            [0, source, into, SUGGESTED_BYTES, ACM_FORMATSUGGESTF_WFORMATTAG]) >>> 0;
        const format = answer === MMSYSERR_NOERROR ? host.readMemory(into, 18).slice() : null;
        host.free(source);
        host.free(into);
        return format ? audioType(format) : null;
    };

    /**
     * Whether the manager converts from one type to another; with `open`, the
     * stream itself, 0 where it cannot.
     *
     * @param {import('./filter.js').MediaType} from @param {import('./filter.js').MediaType} to
     * @param {boolean} open
     */
    const streamOf = async(from, to, open)=>{
        const source = lend(from.format);
        const destination = lend(to.format);
        const out = host.allocate(4);
        host.writeMemory(out, dword(0));
        const answer = await acm.call('acmStreamOpen',
            [out, 0, source, destination, 0, 0, 0, open ? 0 : ACM_STREAMOPENF_QUERY]) >>> 0;
        const stream = answer === MMSYSERR_NOERROR ? (open ? host.readU32(out) : 1) : 0;
        host.free(source);
        host.free(destination);
        host.free(out);
        return stream;
    };

    /** @param {WrapperState} state */
    const close = async state=>{
        if (state.stream !== 0)
        {
            await acm.call('acmStreamClose', [state.stream, 0]);
            state.stream = 0;
        }
    };

    /** Opens the stream once both pins have their types. @param {WrapperState} state */
    const open = async state=>{
        await close(state);
        if (state.source && state.target)
        {
            state.stream = await streamOf(state.source, state.target, true);
        }
        return state.stream !== 0;
    };

    /**
     * Converts one sample and pushes the PCM on, on the thread that pushed it.
     *
     * @param {import('./filter.js').Pin} pin @param {number} sample
     */
    const receive = async(pin, sample)=>{
        const state = stateOf(pin.filter);
        const out = outputOf(pin.filter);
        if (!out || out.peer === 0 || state.stream === 0)
        {
            return VFW_E_NOT_CONNECTED;
        }
        const scratch = host.allocate(20);
        await base.call(sample, SAMPLE.GetPointer, [scratch]);
        const data = host.readU32(scratch);
        const length = await base.call(sample, SAMPLE.GetActualDataLength) | 0;
        const timed = await base.call(sample, SAMPLE.GetTime, [scratch + 4, scratch + 12]);
        const discontinuity = await base.call(sample, SAMPLE.IsDiscontinuity) === S_OK;
        /** @param {number} at */
        const quad = at=>host.readU32(at) + (host.readU32(at + 4) | 0) * 0x1_0000_0000;
        const start = quad(scratch + 4);
        const stop = quad(scratch + 12);
        // How much PCM this much input makes, asked of the stream.
        await acm.call('acmStreamSize', [state.stream, Math.max(0, length), scratch, 0]);
        const room = Math.max(1, host.readU32(scratch));
        host.free(scratch);
        const into = host.allocate(room);
        const header = host.allocate(HEADER.SIZE);
        const fields = new Uint8Array(HEADER.SIZE);
        const view = new DataView(fields.buffer);
        view.setUint32(HEADER.cbStruct, HEADER.SIZE, true);
        view.setUint32(HEADER.pbSrc, data, true);
        view.setUint32(HEADER.cbSrcLength, Math.max(0, length), true);
        view.setUint32(HEADER.pbDst, into, true);
        view.setUint32(HEADER.cbDstLength, room, true);
        host.writeMemory(header, fields);
        await acm.call('acmStreamPrepareHeader', [state.stream, header, 0]);
        const converted = await acm.call('acmStreamConvert', [state.stream, header, 0]) >>> 0;
        const made = converted === MMSYSERR_NOERROR
            ? Math.min(room, host.readU32(header + HEADER.cbDstLengthUsed)) : 0;
        await acm.call('acmStreamUnprepareHeader', [state.stream, header, 0]);
        const pcm = host.readMemory(into, made).slice();
        host.free(header);
        host.free(into);
        if (made === 0)
        {
            // Nothing came of it - too little for one block: the next sample brings the rest.
            return S_OK;
        }
        const times = timed === S_OK || timed === VFW_S_NO_STOP_TIME ? { start, stop } : {};
        return base.deliver(out, { data: pcm, ...times, sync: true, discontinuity }, true);
    };

    /**
     * IPersistPropertyBag, which the audio compressors' category makes the
     * wrapper through: a compressor's bag names the codec to compress with,
     * and compressing is not something these drivers do, so Load and Save say
     * so; the wrapper as a decompressor needs no bag.
     */
    const persistBag = describe(IID_IPERSIST_PROPERTY_BAG, IPERSIST_PROPERTY_BAG_SLOTS, {
        GetClassID: (_f, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(wholeAddress(out), /** @type {Uint8Array} */ (parseGuid(CLSID_ACM_WRAPPER)));
            return S_OK;
        },
        InitNew: ()=>S_OK,
        Load: ()=>E_NOTIMPL,
        Save: ()=>E_NOTIMPL,
    });

    const define = base.defineFilter({
        clsid: CLSID_ACM_WRAPPER,
        interfaces: ()=>[persistBag],
        state: ()=>({ source: null, suggested: null, target: null, stream: 0 }),
        pins: filter=>[
            {
                name: 'Input',
                id: 'In',
                direction: 'input',
                accepts: async(_pin, type)=>{
                    if (!isWave(type))
                    {
                        return false;
                    }
                    const pcm = await suggest(type);
                    return !!pcm && await streamOf(type, pcm, false) !== 0;
                },
                connected: async(pin, type)=>{
                    const state = stateOf(pin.filter);
                    const pcm = isWave(type) ? await suggest(type) : null;
                    if (!pcm)
                    {
                        return VFW_E_TYPE_NOT_ACCEPTED;
                    }
                    Object.assign(state, { source: type, suggested: pcm });
                    await open(state);
                    return S_OK;
                },
                disconnected: async pin=>{
                    const state = stateOf(pin.filter);
                    await close(state);
                    Object.assign(state, { source: null, suggested: null });
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
                name: 'Output',
                id: 'Out',
                direction: 'output',
                types: pin=>{
                    const { suggested } = stateOf(pin.filter);
                    return suggested ? [suggested] : [];
                },
                accepts: async(pin, type)=>{
                    const { source } = stateOf(pin.filter);
                    return !!source && isPcm(type) && await streamOf(source, type, false) !== 0;
                },
                // A buffer holds a second of the PCM, as Windows' wrapper allocates.
                allocator: pin=>{
                    const format = pin.type?.format;
                    const perSecond = format && format.length >= 12
                        ? new DataView(format.buffer, format.byteOffset).getUint32(8, true) : 0;
                    return { buffers: 4, size: Math.max(1, perSecond), align: 1, prefix: 0 };
                },
                interfaces: passThru.seekingFaces(()=>inputOf(filter)?.peer ?? 0,
                    VFW_E_NOT_CONNECTED),
                connected: async(pin, type)=>{
                    const state = stateOf(pin.filter);
                    if (!state.source)
                    {
                        return VFW_E_NOT_CONNECTED;
                    }
                    state.target = type;
                    if (await open(state))
                    {
                        return S_OK;
                    }
                    state.target = null;
                    return VFW_E_TYPE_NOT_ACCEPTED;
                },
                disconnected: async pin=>{
                    const state = stateOf(pin.filter);
                    await close(state);
                    state.target = null;
                },
            },
        ],
    });

    return new Map([[CLSID_ACM_WRAPPER, define]]);
}
