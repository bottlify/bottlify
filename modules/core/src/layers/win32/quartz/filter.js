/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one base every DirectShow filter here is built on: IBaseFilter with its
 * state, clock and graph, pins with IPin, IEnumPins and IEnumMediaTypes, a
 * connection made by media type negotiation, and IMemInputPin over the
 * memory allocator for the samples that cross it.
 *
 * What a filter is to a program is documented and is the same for every
 * filter, so it is written once: a class describes only what is its own -- its
 * pins, the media types each offers and accepts, what an input pin does with a
 * sample, the interfaces beside IBaseFilter -- and this file is the rest. The
 * rules kept are the DirectShow documentation's: a pin connects only while its
 * filter is stopped, an output pin proposes its own types and then the peer's
 * until the peer accepts one, a connection's type is what both ends hold, an
 * input pin refuses samples while its filter is stopped or flushing, and a
 * pin's name, id and direction never change.
 *
 * A media type travels as an AM_MEDIA_TYPE in the program's memory; here it is
 * a record with its format block as bytes, read from that memory when a pin is
 * offered one and written out, in task memory, when a pin hands one over.
 */

import { createComObject } from '../ole32/objects.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';
import { describe } from './describe.js';
import {
    IBASE_FILTER_SLOTS, IID_IBASE_FILTER, IID_IMEDIA_FILTER, IID_IMEM_ALLOCATOR,
    IID_IMEM_INPUT_PIN, IID_IPERSIST, IID_IPIN, IMEDIA_FILTER_SLOTS, IPIN_SLOTS, VTABLE,
} from './interfaces.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_INVALIDARG = 0x80070057 | 0;
const VFW_E_ALREADY_CONNECTED = 0x80040204 | 0;
const VFW_E_INVALID_DIRECTION = 0x80040208 | 0;
const VFW_E_NOT_CONNECTED = 0x80040209 | 0;
const VFW_E_NO_ALLOCATOR = 0x8004020a | 0;
const VFW_E_NOT_FOUND = 0x80040216 | 0;
const VFW_E_CANNOT_CONNECT = 0x80040217 | 0;
const VFW_E_TYPE_NOT_ACCEPTED = 0x8004022a | 0;
const VFW_E_NOT_STOPPED = 0x80040224 | 0;
const VFW_E_WRONG_STATE = 0x80040227 | 0;
const VFW_E_NO_TRANSPORT = 0x80040266 | 0;

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
export const IID_IENUM_PINS = '{56A86892-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IENUM_MEDIA_TYPES = '{89C31040-846B-11CE-97D3-00AA0055595A}';
export const IID_IQUALITY_CONTROL = '{56A868A5-0AD4-11CE-B03A-0020AF0BA770}';

/** IMemInputPin. @type {[string, number][]} */
export const IMEM_INPUT_PIN_SLOTS = [
    ['GetAllocator', 1],
    ['NotifyAllocator', 2],
    ['GetAllocatorRequirements', 1],
    ['Receive', 1],
    ['ReceiveMultiple', 3],
    ['ReceiveCanBlock', 0],
];
/** IEnumPins and IEnumMediaTypes share their shape. @type {[string, number][]} */
const IENUM_SLOTS = [['Next', 3], ['Skip', 1], ['Reset', 0], ['Clone', 1]];
/** IQualityControl. `Notify` takes a Quality by value: four words and a REFERENCE_TIME. */
const IQUALITY_CONTROL_SLOTS = /** @type {[string, number][]} */ ([['Notify', 7], ['SetSink', 1]]);

export const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';
export const MEDIATYPE_STREAM = '{E436EB83-524F-11CE-9F53-0020AF0BA770}';
export const MEDIATYPE_VIDEO = '{73646976-0000-0010-8000-00AA00389B71}';
export const MEDIATYPE_AUDIO = '{73647561-0000-0010-8000-00AA00389B71}';
export const FORMAT_VIDEO_INFO = '{05589F80-C356-11CE-BF01-00AA0055595A}';
export const FORMAT_WAVE_FORMAT_EX = '{05589F81-C356-11CE-BF01-00AA0055595A}';
export const FORMAT_NONE = '{0F6417D6-C318-11D0-A43F-00A0C9223196}';

/** OAFilterState / FILTER_STATE. */
export const STATE_STOPPED = 0;
export const STATE_PAUSED = 1;
export const STATE_RUNNING = 2;

const PINDIR_INPUT = 0;
const PINDIR_OUTPUT = 1;

/** FILTER_INFO and PIN_INFO hold their names inline, this many wide characters. */
const MAX_NAME = 128;
const NAME_BYTES = MAX_NAME * 2;
const FILTER_INFO_BYTES = NAME_BYTES + 4;
const PIN_INFO = { FILTER: 0, DIRECTION: 4, NAME: 8, BYTES: 8 + NAME_BYTES };

/** AM_MEDIA_TYPE as a 32-bit process lays it out. */
const MEDIA_TYPE = {
    MAJOR: 0x00, SUB: 0x10, FIXED: 0x20, TEMPORAL: 0x24, SAMPLE_SIZE: 0x28,
    FORMAT_TYPE: 0x2c, UNKNOWN: 0x3c, FORMAT_BYTES: 0x40, FORMAT: 0x44, BYTES: 0x48,
};
/** IPin's slots this calls on a peer, IUnknown's three counted. */
const PIN = { QueryDirection: 9, EnumMediaTypes: 12 };

/** ALLOCATOR_PROPERTIES: four LONGs. */
const PROPERTIES_BYTES = 16;

/** IMemAllocator's slots this calls, IUnknown's three counted. */
const ALLOCATOR = { Commit: 5, Decommit: 6, GetBuffer: 7 };
/** IMediaSample's. */
const SAMPLE = {
    GetPointer: 3, GetSize: 4, SetTime: 6, SetSyncPoint: 8, SetPreroll: 10,
    SetActualDataLength: 12, SetDiscontinuity: 16, SetMediaTime: 18,
};
/** IMemInputPin::Receive's, and IPin's that travel downstream. */
const RECEIVE = 6;
const PIN_STREAM = { EndOfStream: 14, BeginFlush: 15, EndFlush: 16, NewSegment: 17 };

/**
 * What a filter pushes downstream: a sample's bytes and what is said of them.
 *
 * @typedef {Object} Outgoing
 * @property {Uint8Array} data
 * @property {number} [start]   The stream time it starts at, in REFERENCE_TIME; none where absent.
 * @property {number} [stop]
 * @property {boolean} [sync]   A sync point: a key frame, or any sample of uncompressed data.
 * @property {boolean} [discontinuity]
 * @property {boolean} [preroll]
 * @property {{ start: number, stop: number }} [media]  Its media times (a frame
 *           number, a byte offset), as the sample it was made from carried them.
 */

/**
 * @typedef {Object} MediaType
 * @property {string} major
 * @property {string} sub
 * @property {boolean} fixed      bFixedSizeSamples
 * @property {boolean} temporal   bTemporalCompression
 * @property {number} sampleSize  lSampleSize
 * @property {string} formatType
 * @property {Uint8Array} format  The format block, empty for none.
 */

/**
 * @typedef {Object} FilterHost
 * @property {(address: number) => number} readU32
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate  Task memory, CoTaskMemFree's.
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: any) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 * @property {(clsid: string, iid: string) => number | Promise<number>} createInstance
 *           A class of this process made for an interface, one reference held; 0 refused.
 * @property {{ deliver: (entry: number, args: number[], done?: (answer: number) => void,
 *     tag?: any) => void }} [notices]
 *           The graph's streaming thread: a sample pushed downstream, an end of
 *           stream, is a call made from it, in order, never from the thread
 *           of the call that started the streaming.
 * @property {IcmHost} [icm]  The installable compressors, for the AVI Decompressor.
 */

/**
 * The installable compressors as the host lends them: msvfw32's own entries,
 * over guest memory.
 *
 * @typedef {Object} IcmHost
 * @property {(type: number, handler: number, input: number, output: number, mode: number)
 *     => number | Promise<number>} locate
 * @property {(hic: number, message: number, first: number, second: number)
 *     => number | Promise<number>} send
 * @property {(hic: number) => number | Promise<number>} close
 * @property {(hic: number, flags: number, format: number, data: number, output: number,
 *     bits: number) => number | Promise<number>} decompress
 */

/**
 * What a class tells the base about one of its pins.
 *
 * @typedef {Object} PinSpec
 * @property {string} name
 * @property {string} [id]         QueryId's answer; the name where absent.
 * @property {'input' | 'output'} direction
 * @property {(pin: Pin) => MediaType[]} [types]  What the pin offers, in its order.
 * @property {(pin: Pin, type: MediaType) => boolean | Promise<boolean>} [accepts]
 *           Whether a connection of this type would be taken; every type where
 *           absent. A filter that asks something else (a codec) answers later.
 * @property {(pin: Pin, type: MediaType, peer: number) => number | Promise<number>} [connected]
 *           Told once a connection is made, before Connect or ReceiveConnection
 *           returns; an error undoes it.
 * @property {(pin: Pin) => void | Promise<void>} [disconnected]
 * @property {(pin: Pin, sample: number) => number | Promise<number>} [receive]
 *           An input pin's sample, the program's IMediaSample, one reference lent.
 * @property {(pin: Pin) => number | Promise<number>} [endOfStream]
 * @property {(pin: Pin, begin: boolean) => number | Promise<number>} [flush]
 *           An input pin's BeginFlush or EndFlush, after the pin's own state is set.
 * @property {(pin: Pin, start: number, stop: number, rate: number) => number | Promise<number>}
 *     [newSegment]  An input pin's NewSegment.
 * @property {{ buffers: number, size: number, align: number, prefix: number }
 *     | ((pin: Pin) => { buffers: number, size: number, align: number, prefix: number })}
 *     [allocator]  An output pin's buffers, asked of the allocator it connects with;
 *     an output pin with no allocator hands none (a pull pin, as File Source's).
 * @property {boolean} [pull]     An input pin that pulls its data through the
 *           peer's IAsyncReader, as a parser's does: it has no IMemInputPin.
 * @property {import('../ole32/objects.js').ComInterfaceDescriptor[]} [interfaces]
 *           What the pin answers beside IPin (and IMemInputPin for an input pin).
 */

/**
 * @typedef {Object} Pin
 * @property {Filter} filter
 * @property {PinSpec} spec
 * @property {import('../ole32/objects.js').ComObject | null} object
 * @property {number} peer         The connected pin, one reference held; 0 unconnected.
 * @property {MediaType | null} type
 * @property {number} memInput     An output pin's peer's IMemInputPin, one reference held.
 * @property {number} allocator    The connection's allocator, one reference held.
 * @property {boolean} flushing
 * @property {boolean} ended
 * @property {any} state           The class's own.
 */

/**
 * @typedef {Object} Filter
 * @property {string} clsid
 * @property {number} state
 * @property {number} clock        The reference clock, one reference held; 0 none.
 * @property {number} graph        Not held: the graph holds its filters.
 * @property {string} name
 * @property {number} start        Run's tStart.
 * @property {Pin[]} pins
 * @property {import('../ole32/objects.js').ComObject | null} object
 * @property {any} state2          The class's own.
 */

/**
 * What a class tells the base about itself.
 *
 * @typedef {Object} FilterSpec
 * @property {string} clsid
 * @property {(filter: Filter) => PinSpec[]} pins  The pins it starts with.
 * @property {(filter: Filter) => import('../ole32/objects.js').ComInterfaceDescriptor[]} [interfaces]
 * @property {(filter: Filter, from: number, to: number) => number | Promise<number>} [changed]
 *           Told of a state change before it is answered.
 * @property {(filter: Filter) => any} [state]
 * @property {(filter: Filter, timeoutMs: number) => number | Promise<number>} [stateAnswer]
 *           GetState's answer: S_OK where the filter is in its state,
 *           VFW_S_STATE_INTERMEDIATE where it is still on its way after waiting
 *           up to the time given.
 * @property {(filter: Filter) => void} [destroy]
 * @property {boolean} [aggregatable]
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {string} text @param {number} units the buffer's, terminator included */
const wideInline = (text, units)=>{
    const bytes = new Uint8Array(units * 2);
    const view = new DataView(bytes.buffer);
    [...text.slice(0, units - 1)].forEach((ch, at)=>view.setUint16(at * 2, ch.charCodeAt(0), true));
    return bytes;
};

/** @param {string} text */
const wideString = text=>new Uint8Array(
    Uint16Array.from([...text, '\0'], char=>char.charCodeAt(0)).buffer);

/**
 * A media type with every field given, the rest defaulted.
 *
 * @param {Partial<MediaType> & { major: string, sub: string }} fields
 * @returns {MediaType}
 */
export function mediaType(fields){
    return { fixed: true, temporal: false, sampleSize: 1, formatType: GUID_NULL,
        format: new Uint8Array(0), ...fields };
}

/**
 * The base's classes and helpers over one host.
 *
 * @param {FilterHost} host
 */
export function createFilterBase(host){
    /** @param {number} address */
    const guidAt = address=>formatGuid(host.readMemory(address >>> 0, 16));

    /** @param {number} self @param {number} slot */
    const entryOf = (self, slot)=>host.readU32((host.readU32(self >>> 0) + slot * 4) >>> 0);

    /**
     * A method of one of the program's objects, on the thread the program is in.
     *
     * @param {number} self @param {number} slot @param {number[]} [args]
     */
    const call = async(self, slot, args = [])=>(await host.callGuest(entryOf(self, slot),
        [self >>> 0, ...args], host.currentThread())) >>> 0;

    /** @param {number} result */
    const failed = result=>(result | 0) < 0;

    /** @param {number} self @param {string} iid @returns {Promise<number>} */
    const queryInterface = async(self, iid)=>{
        const scratch = host.allocate(20);
        host.writeMemory(scratch, /** @type {Uint8Array} */ (parseGuid(iid)));
        host.writeMemory(scratch + 16, dword(0));
        const result = await call(self, VTABLE.QueryInterface, [scratch, scratch + 16]);
        const pointer = host.readU32(scratch + 16);
        host.free(scratch);
        return failed(result) ? 0 : pointer;
    };

    /** @param {number} pointer */
    const addRef = pointer=>call(pointer, VTABLE.AddRef);
    /** @param {number} pointer */
    const release = pointer=>call(pointer, VTABLE.Release);

    /**
     * A method of an object called from the streaming thread, in order with
     * every other call made from it; what it answers. With no streaming thread
     * (a host that gives none) it is called as any other.
     *
     * @param {number} self @param {number} slot @param {number[]} [args] @param {any} [tag]
     * @returns {Promise<number>}
     */
    const callStreaming = (self, slot, args = [], tag)=>{
        if (!host.notices)
        {
            return call(self, slot, args);
        }
        const notices = host.notices;
        return new Promise(resolve=>notices.deliver(entryOf(self, slot), [self >>> 0, ...args],
            answer=>resolve(answer >>> 0), tag));
    };

    /** @param {number} value @returns {[number, number]} a LONGLONG's two words */
    const quad = value=>{
        const whole = Math.trunc(value);
        return [whole % 0x1_0000_0000 >>> 0, Math.floor(whole / 0x1_0000_0000) >>> 0];
    };

    /**
     * How a delivery is called: from the streaming thread, for a filter that
     * streams on its own (a parser); on the calling thread, for one that
     * passes on what it is given inside its own Receive (a transform), whose
     * caller is the streaming thread already.
     *
     * @param {Pin} pin @param {boolean} direct
     * @returns {(self: number, slot: number, args?: number[]) => Promise<number>}
     */
    const caller = (pin, direct)=>(direct ? call
        : (self, slot, args = [])=>callStreaming(self, slot, args, pin.filter));

    /**
     * Pushes one sample out of an output pin, as the base classes' output pin
     * delivers one: a buffer from the connection's allocator, the bytes and
     * what is said of them written into it, IMemInputPin::Receive on the peer,
     * and the buffer let go. What Receive answered is the answer: S_FALSE or a
     * failure tells the filter to stop pushing.
     *
     * @param {Pin} pin @param {Outgoing} sample
     * @param {boolean} [direct]  On the calling thread rather than the streaming thread.
     * @returns {Promise<number>}
     */
    const deliver = async(pin, sample, direct = false)=>{
        if (pin.peer === 0 || pin.memInput === 0 || pin.allocator === 0)
        {
            return VFW_E_NOT_CONNECTED;
        }
        const invoke = caller(pin, direct);
        const scratch = host.allocate(24);
        host.writeMemory(scratch, dword(0));
        const got = await invoke(pin.allocator, ALLOCATOR.GetBuffer, [scratch, 0, 0, 0]);
        const media = host.readU32(scratch);
        if (failed(got) || media === 0)
        {
            host.free(scratch);
            return failed(got) ? got : E_UNEXPECTED;
        }
        await invoke(media, SAMPLE.GetPointer, [scratch + 4]);
        // GetSize answers the buffer's size itself, not an HRESULT; what does
        // not fit is not written, as a buffer's end is the allocator's.
        const capacity = await invoke(media, SAMPLE.GetSize, []) | 0;
        const buffer = host.readU32(scratch + 4);
        const size = buffer === 0 ? 0 : Math.max(0, Math.min(sample.data.length, capacity));
        host.writeMemory(buffer, sample.data.subarray(0, size));
        await invoke(media, SAMPLE.SetActualDataLength, [size]);
        if (sample.start !== undefined)
        {
            const times = new Uint8Array(16);
            const view = new DataView(times.buffer);
            const [startLow, startHigh] = quad(sample.start);
            const [stopLow, stopHigh] = quad(sample.stop ?? sample.start);
            view.setUint32(0, startLow, true);
            view.setUint32(4, startHigh, true);
            view.setUint32(8, stopLow, true);
            view.setUint32(12, stopHigh, true);
            host.writeMemory(scratch + 8, times);
            await invoke(media, SAMPLE.SetTime,
                [scratch + 8, sample.stop === undefined ? 0 : scratch + 16]);
        }
        if (sample.media)
        {
            const times = new Uint8Array(16);
            const view = new DataView(times.buffer);
            const [startLow, startHigh] = quad(sample.media.start);
            const [stopLow, stopHigh] = quad(sample.media.stop);
            view.setUint32(0, startLow, true);
            view.setUint32(4, startHigh, true);
            view.setUint32(8, stopLow, true);
            view.setUint32(12, stopHigh, true);
            host.writeMemory(scratch + 8, times);
            await invoke(media, SAMPLE.SetMediaTime, [scratch + 8, scratch + 16]);
        }
        await invoke(media, SAMPLE.SetSyncPoint, [sample.sync ? 1 : 0]);
        await invoke(media, SAMPLE.SetDiscontinuity, [sample.discontinuity ? 1 : 0]);
        if (sample.preroll)
        {
            await invoke(media, SAMPLE.SetPreroll, [1]);
        }
        const answer = await invoke(pin.memInput, RECEIVE, [media]);
        await invoke(media, VTABLE.Release, []);
        host.free(scratch);
        return answer;
    };

    /**
     * The end of an output pin's stream, told to its peer from the streaming
     * thread after every sample before it.
     *
     * @param {Pin} pin @param {boolean} [direct]
     */
    const deliverEndOfStream = (pin, direct = false)=>(pin.peer === 0 ? Promise.resolve(S_OK)
        : caller(pin, direct)(pin.peer, PIN_STREAM.EndOfStream));

    /**
     * A new segment told downstream: the stream times that follow start at
     * `start` of the media and run to `stop`, at `rate`.
     *
     * @param {Pin} pin @param {number} start @param {number} stop @param {number} [rate]
     * @param {boolean} [direct]
     */
    const deliverNewSegment = (pin, start, stop, rate = 1, direct = false)=>{
        if (pin.peer === 0)
        {
            return Promise.resolve(S_OK);
        }
        const double = new DataView(new ArrayBuffer(8));
        double.setFloat64(0, rate, true);
        return caller(pin, direct)(pin.peer, PIN_STREAM.NewSegment, [...quad(start),
            ...quad(stop), double.getUint32(0, true), double.getUint32(4, true)]);
    };

    /**
     * A flush told downstream, around the work a seek does while nothing flows.
     *
     * @param {Pin} pin @param {boolean} begin @param {boolean} [direct]
     */
    const deliverFlush = (pin, begin, direct = false)=>(pin.peer === 0 ? Promise.resolve(S_OK)
        : caller(pin, direct)(pin.peer, begin ? PIN_STREAM.BeginFlush : PIN_STREAM.EndFlush));

    /** @param {number} address @returns {MediaType} */
    const readMediaType = address=>{
        const bytes = host.readMemory(address >>> 0, MEDIA_TYPE.BYTES);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const formatBytes = view.getUint32(MEDIA_TYPE.FORMAT_BYTES, true);
        const format = view.getUint32(MEDIA_TYPE.FORMAT, true);
        return {
            major: formatGuid(bytes.subarray(MEDIA_TYPE.MAJOR, MEDIA_TYPE.MAJOR + 16)),
            sub: formatGuid(bytes.subarray(MEDIA_TYPE.SUB, MEDIA_TYPE.SUB + 16)),
            fixed: view.getUint32(MEDIA_TYPE.FIXED, true) !== 0,
            temporal: view.getUint32(MEDIA_TYPE.TEMPORAL, true) !== 0,
            sampleSize: view.getUint32(MEDIA_TYPE.SAMPLE_SIZE, true),
            formatType: formatGuid(bytes.subarray(MEDIA_TYPE.FORMAT_TYPE,
                MEDIA_TYPE.FORMAT_TYPE + 16)),
            format: formatBytes > 0 && format !== 0
                ? host.readMemory(format, formatBytes).slice() : new Uint8Array(0),
        };
    };

    /**
     * Writes a media type into an AM_MEDIA_TYPE the caller has, its format block
     * in task memory the caller frees, as CopyMediaType fills one.
     *
     * @param {number} address @param {MediaType} type
     */
    const writeMediaType = (address, type)=>{
        const bytes = new Uint8Array(MEDIA_TYPE.BYTES);
        const view = new DataView(bytes.buffer);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(type.major)), MEDIA_TYPE.MAJOR);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(type.sub)), MEDIA_TYPE.SUB);
        view.setUint32(MEDIA_TYPE.FIXED, type.fixed ? 1 : 0, true);
        view.setUint32(MEDIA_TYPE.TEMPORAL, type.temporal ? 1 : 0, true);
        view.setUint32(MEDIA_TYPE.SAMPLE_SIZE, type.sampleSize, true);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(type.formatType)), MEDIA_TYPE.FORMAT_TYPE);
        if (type.format.length > 0)
        {
            const block = host.allocate(type.format.length);
            host.writeMemory(block, type.format);
            view.setUint32(MEDIA_TYPE.FORMAT_BYTES, type.format.length, true);
            view.setUint32(MEDIA_TYPE.FORMAT, block, true);
        }
        host.writeMemory(address >>> 0, bytes);
    };

    /** A media type in a block of task memory of its own, as CreateMediaType makes one. @param {MediaType} type */
    const createMediaType = type=>{
        const at = host.allocate(MEDIA_TYPE.BYTES);
        writeMediaType(at, type);
        return at;
    };

    /** @param {number} address the AM_MEDIA_TYPE, freed with its block */
    const deleteMediaType = address=>{
        const format = host.readU32(address + MEDIA_TYPE.FORMAT);
        if (format !== 0)
        {
            host.free(format);
        }
        host.free(address);
    };

    /**
     * Whether a type a caller gave fits one the pin offers: GUID_NULL in the
     * caller's major, subtype or format type is any, as a partial type is.
     *
     * @param {MediaType} given @param {MediaType} offered
     */
    const fits = (given, offered)=>(given.major === GUID_NULL || given.major === offered.major)
        && (given.sub === GUID_NULL || given.sub === offered.sub)
        && (given.formatType === GUID_NULL || given.formatType === offered.formatType);

    /** @param {MediaType} type */
    const partial = type=>type.major === GUID_NULL || type.sub === GUID_NULL
        || type.formatType === GUID_NULL;

    /** @param {Pin} pin @param {MediaType} type */
    const pinAccepts = (pin, type)=>(pin.spec.accepts ? pin.spec.accepts(pin, type)
        : (pin.spec.types?.(pin) ?? []).some(offered=>fits(type, offered)));

    /**
     * IEnumPins or IEnumMediaTypes over a list taken when it is made, handing
     * out each item with `give`.
     *
     * @param {string} iid @param {() => any[]} source @param {(item: any) => number} give
     * @param {number} [position]
     * @param {Filter} [owner]  A filter whose pins are listed: the enumerator holds it.
     * @param {any[]} [items]  What it lists until it is reset; the source's now where absent.
     * @returns {number}
     */
    const enumerator = (iid, source, give, position = 0, owner, items = source())=>{
        const state = { position, items };
        if (owner)
        {
            void /** @type {any} */ (owner.object)?.addRef(IID_IBASE_FILTER);
        }
        /** @type {Record<string, (s: typeof state, args: number[]) => number>} */
        const methods = {
            Next: (s, [count, out, fetched])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                // More than one asked for needs a count to say how many came.
                if ((count >>> 0) > 1 && (fetched >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                let given = 0;
                while (given < (count >>> 0) && s.position < s.items.length)
                {
                    host.writeMemory((out >>> 0) + given * 4, dword(give(s.items[s.position++])));
                    given++;
                }
                if ((fetched >>> 0) !== 0)
                {
                    host.writeMemory(fetched >>> 0, dword(given));
                }
                return given === (count >>> 0) ? S_OK : S_FALSE;
            },
            Skip: (s, [count])=>{
                const left = s.items.length - s.position;
                s.position = Math.min(s.items.length, s.position + (count >>> 0));
                return (count >>> 0) <= left ? S_OK : S_FALSE;
            },
            Reset: s=>{
                s.position = 0;
                s.items = source();
                return S_OK;
            },
            Clone: (s, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writeMemory(out >>> 0,
                    dword(enumerator(iid, source, give, s.position, owner, [...s.items])));
                return S_OK;
            },
        };
        return host.publish(createComObject(iid, {
            state, interfaces: [describe(iid, IENUM_SLOTS, methods)],
            destroy: ()=>{
                /** @type {any} */ (owner?.object)?.release();
            },
        }), iid);
    };

    /** A pin's IPin, without a reference: what it hands itself to a peer as. @param {Pin} pin */
    const pinPointer = pin=>host.publish(/** @type {any} */ (pin.object), IID_IPIN);

    /**
     * A pin handed to a caller who owns what it is given: one reference more,
     * on the filter, as every pin's are.
     *
     * @param {Pin} pin
     */
    const handPin = pin=>{
        void /** @type {any} */ (pin.filter.object)?.addRef(IID_IBASE_FILTER);
        return pinPointer(pin);
    };

    /** The filter's IBaseFilter with a reference for its taker. @param {Filter} filter */
    const handFilter = filter=>{
        void /** @type {any} */ (filter.object)?.addRef(IID_IBASE_FILTER);
        return host.publish(/** @type {any} */ (filter.object), IID_IBASE_FILTER);
    };

    /**
     * An output pin's allocator for a connection: the input pin's where it has
     * one, else a memory allocator of this process; sized by what the output
     * pin asks, NotifyAllocator told the result.
     *
     * @param {Pin} pin @returns {Promise<number>}
     */
    const decideAllocator = async pin=>{
        const want = typeof pin.spec.allocator === 'function'
            ? pin.spec.allocator(pin) : /** @type {any} */ (pin.spec.allocator);
        const props = host.allocate(PROPERTIES_BYTES * 2);
        const request = new Uint8Array(PROPERTIES_BYTES);
        const view = new DataView(request.buffer);
        view.setInt32(0, want.buffers, true);
        view.setInt32(4, want.size, true);
        view.setInt32(8, want.align, true);
        view.setInt32(12, want.prefix, true);
        host.writeMemory(props, request);
        const slot = host.allocate(4);
        host.writeMemory(slot, dword(0));
        let allocator = 0;
        if (!failed(await call(pin.memInput, 3, [slot])))
        {
            allocator = host.readU32(slot);
        }
        if (allocator === 0)
        {
            allocator = await host.createInstance('{1E651CC0-B199-11D0-8212-00C04FC32C45}',
                IID_IMEM_ALLOCATOR);
        }
        host.free(slot);
        if (allocator === 0)
        {
            host.free(props);
            return VFW_E_NO_ALLOCATOR;
        }
        const set = await call(allocator, 3, [props, props + PROPERTIES_BYTES]);
        host.free(props);
        if (failed(set))
        {
            await release(allocator);
            return set;
        }
        const told = await call(pin.memInput, 4, [allocator, 0]);
        if (failed(told))
        {
            await release(allocator);
            return told;
        }
        pin.allocator = allocator;
        return S_OK;
    };

    /** @param {Pin} pin */
    const dropConnection = async pin=>{
        const { peer, memInput, allocator } = pin;
        pin.peer = 0;
        pin.memInput = 0;
        pin.allocator = 0;
        pin.type = null;
        for (const pointer of [allocator, memInput, peer])
        {
            if (pointer !== 0)
            {
                await release(pointer);
            }
        }
        await pin.spec.disconnected?.(pin);
    };

    /**
     * An output pin tries one type on the peer.
     *
     * @param {Pin} pin @param {number} peer @param {MediaType} type
     * @returns {Promise<boolean>}
     */
    const tryType = async(pin, peer, type)=>{
        if (!await pinAccepts(pin, type))
        {
            return false;
        }
        const at = createMediaType(type);
        const answer = await call(peer, VTABLE.PinReceiveConnection, [pinPointer(pin), at]);
        deleteMediaType(at);
        return !failed(answer);
    };

    /** @param {number} peer @returns {Promise<MediaType[]>} the peer's offered types */
    const peerTypes = async peer=>{
        const slot = host.allocate(8);
        host.writeMemory(slot, dword(0));
        /** @type {MediaType[]} */
        const types = [];
        if (!failed(await call(peer, PIN.EnumMediaTypes, [slot])) && host.readU32(slot) !== 0)
        {
            const enumTypes = host.readU32(slot);
            while (await call(enumTypes, 3, [1, slot + 4, 0]) === S_OK)
            {
                const at = host.readU32(slot + 4);
                types.push(readMediaType(at));
                deleteMediaType(at);
            }
            await release(enumTypes);
        }
        host.free(slot);
        return types;
    };

    /** @type {Record<string, (pin: Pin, args: number[]) => number | Promise<number>>} */
    const pinMethods = {
        /** HRESULT Connect(IPin *pReceivePin, const AM_MEDIA_TYPE *pmt) */
        Connect: async(pin, [peer, given])=>{
            if ((peer >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (pin.spec.direction !== 'output')
            {
                return E_UNEXPECTED;
            }
            if (pin.peer !== 0)
            {
                return VFW_E_ALREADY_CONNECTED;
            }
            if (pin.filter.state !== STATE_STOPPED)
            {
                return VFW_E_NOT_STOPPED;
            }
            const wanted = (given >>> 0) === 0 ? null : readMediaType(given >>> 0);
            /** @type {MediaType[]} */
            const candidates = wanted && !partial(wanted) ? [wanted]
                : [...pin.spec.types?.(pin) ?? [], ...await peerTypes(peer >>> 0)]
                    .filter(type=>!wanted || fits(wanted, type));
            for (const type of candidates)
            {
                if (!await tryType(pin, peer >>> 0, type))
                {
                    continue;
                }
                await addRef(peer >>> 0);
                pin.peer = peer >>> 0;
                pin.type = type;
                if (pin.spec.allocator)
                {
                    pin.memInput = await queryInterface(peer >>> 0, IID_IMEM_INPUT_PIN);
                    const decided = pin.memInput === 0 ? VFW_E_NO_TRANSPORT
                        : await decideAllocator(pin);
                    if (failed(decided))
                    {
                        await call(peer >>> 0, VTABLE.PinDisconnect);
                        await dropConnection(pin);
                        return decided;
                    }
                }
                const told = await pin.spec.connected?.(pin, type, peer >>> 0) ?? S_OK;
                if (failed(told))
                {
                    await call(peer >>> 0, VTABLE.PinDisconnect);
                    await dropConnection(pin);
                    return told;
                }
                return S_OK;
            }
            return wanted && !partial(wanted) ? VFW_E_TYPE_NOT_ACCEPTED : VFW_E_CANNOT_CONNECT;
        },
        /** HRESULT ReceiveConnection(IPin *pConnector, const AM_MEDIA_TYPE *pmt) */
        ReceiveConnection: async(pin, [peer, given])=>{
            if ((peer >>> 0) === 0 || (given >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (pin.spec.direction !== 'input')
            {
                return E_UNEXPECTED;
            }
            if (pin.peer !== 0)
            {
                return VFW_E_ALREADY_CONNECTED;
            }
            if (pin.filter.state !== STATE_STOPPED)
            {
                return VFW_E_NOT_STOPPED;
            }
            const type = readMediaType(given >>> 0);
            if (!await pinAccepts(pin, type))
            {
                return VFW_E_TYPE_NOT_ACCEPTED;
            }
            const slot = host.allocate(4);
            await call(peer >>> 0, PIN.QueryDirection, [slot]);
            const direction = host.readU32(slot);
            host.free(slot);
            if (direction !== PINDIR_OUTPUT)
            {
                return VFW_E_INVALID_DIRECTION;
            }
            await addRef(peer >>> 0);
            pin.peer = peer >>> 0;
            pin.type = type;
            const told = await pin.spec.connected?.(pin, type, peer >>> 0) ?? S_OK;
            if (failed(told))
            {
                await dropConnection(pin);
                return told;
            }
            return S_OK;
        },
        Disconnect: async pin=>{
            if (pin.filter.state !== STATE_STOPPED)
            {
                return VFW_E_NOT_STOPPED;
            }
            if (pin.peer === 0)
            {
                return S_FALSE;
            }
            await dropConnection(pin);
            return S_OK;
        },
        /** HRESULT ConnectedTo(IPin **pPin) */
        ConnectedTo: async(pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, dword(pin.peer));
            if (pin.peer === 0)
            {
                return VFW_E_NOT_CONNECTED;
            }
            await addRef(pin.peer);
            return S_OK;
        },
        /** HRESULT ConnectionMediaType(AM_MEDIA_TYPE *pmt) */
        ConnectionMediaType: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (!pin.type)
            {
                host.writeMemory(out >>> 0, new Uint8Array(MEDIA_TYPE.BYTES));
                return VFW_E_NOT_CONNECTED;
            }
            writeMediaType(out >>> 0, pin.type);
            return S_OK;
        },
        /** HRESULT QueryPinInfo(PIN_INFO *pInfo) */
        QueryPinInfo: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const info = new Uint8Array(PIN_INFO.BYTES);
            info.set(dword(handFilter(pin.filter)), PIN_INFO.FILTER);
            info.set(dword(pin.spec.direction === 'output' ? PINDIR_OUTPUT : PINDIR_INPUT),
                PIN_INFO.DIRECTION);
            info.set(wideInline(pin.spec.name, MAX_NAME), PIN_INFO.NAME);
            host.writeMemory(out >>> 0, info);
            return S_OK;
        },
        /** HRESULT QueryDirection(PIN_DIRECTION *pPinDir) */
        QueryDirection: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0,
                dword(pin.spec.direction === 'output' ? PINDIR_OUTPUT : PINDIR_INPUT));
            return S_OK;
        },
        /** HRESULT QueryId(LPWSTR *Id) */
        QueryId: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const text = wideString(pin.spec.id ?? pin.spec.name);
            const at = host.allocate(text.length);
            if (at === 0)
            {
                return E_OUTOFMEMORY;
            }
            host.writeMemory(at, text);
            host.writeMemory(out >>> 0, dword(at));
            return S_OK;
        },
        /** HRESULT QueryAccept(const AM_MEDIA_TYPE *pmt) */
        QueryAccept: async(pin, [given])=>{
            if ((given >>> 0) === 0)
            {
                return E_POINTER;
            }
            return await pinAccepts(pin, readMediaType(given >>> 0)) ? S_OK : S_FALSE;
        },
        /** HRESULT EnumMediaTypes(IEnumMediaTypes **ppEnum) */
        EnumMediaTypes: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, dword(enumerator(IID_IENUM_MEDIA_TYPES,
                ()=>pin.spec.types?.(pin) ?? [], createMediaType)));
            return S_OK;
        },
        QueryInternalConnections: ()=>E_NOTIMPL,
        EndOfStream: async pin=>{
            if (pin.spec.direction !== 'input')
            {
                return E_UNEXPECTED;
            }
            if (pin.flushing)
            {
                return S_FALSE;
            }
            pin.ended = true;
            return await pin.spec.endOfStream?.(pin) ?? S_OK;
        },
        BeginFlush: pin=>{
            if (pin.spec.direction !== 'input')
            {
                return E_UNEXPECTED;
            }
            pin.flushing = true;
            return pin.spec.flush?.(pin, true) ?? S_OK;
        },
        EndFlush: pin=>{
            if (pin.spec.direction !== 'input')
            {
                return E_UNEXPECTED;
            }
            pin.flushing = false;
            pin.ended = false;
            return pin.spec.flush?.(pin, false) ?? S_OK;
        },
        /**
         * HRESULT NewSegment(REFERENCE_TIME tStart, REFERENCE_TIME tStop, double dRate)
         */
        NewSegment: (pin, [startLow, startHigh, stopLow, stopHigh, rateLow, rateHigh])=>{
            if (pin.spec.direction !== 'input')
            {
                return E_UNEXPECTED;
            }
            const rate = new DataView(new ArrayBuffer(8));
            rate.setUint32(0, rateLow >>> 0, true);
            rate.setUint32(4, rateHigh >>> 0, true);
            return pin.spec.newSegment?.(pin,
                (startLow >>> 0) + (startHigh | 0) * 0x1_0000_0000,
                (stopLow >>> 0) + (stopHigh | 0) * 0x1_0000_0000, rate.getFloat64(0, true)) ?? S_OK;
        },
    };

    /** @type {Record<string, (pin: Pin, args: number[]) => number | Promise<number>>} */
    const memInputMethods = {
        /** HRESULT GetAllocator(IMemAllocator **ppAllocator) */
        GetAllocator: async(pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (pin.allocator === 0)
            {
                pin.allocator = await host.createInstance(
                    '{1E651CC0-B199-11D0-8212-00C04FC32C45}', IID_IMEM_ALLOCATOR);
            }
            host.writeMemory(out >>> 0, dword(pin.allocator));
            if (pin.allocator === 0)
            {
                return VFW_E_NO_ALLOCATOR;
            }
            await addRef(pin.allocator);
            return S_OK;
        },
        /** HRESULT NotifyAllocator(IMemAllocator *pAllocator, BOOL bReadOnly) */
        NotifyAllocator: async(pin, [allocator])=>{
            if ((allocator >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (pin.allocator !== (allocator >>> 0))
            {
                await addRef(allocator >>> 0);
                if (pin.allocator !== 0)
                {
                    await release(pin.allocator);
                }
                pin.allocator = allocator >>> 0;
            }
            return S_OK;
        },
        GetAllocatorRequirements: ()=>E_NOTIMPL,
        /** HRESULT Receive(IMediaSample *pSample) */
        Receive: async(pin, [sample])=>{
            if ((sample >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (pin.filter.state === STATE_STOPPED)
            {
                return VFW_E_WRONG_STATE;
            }
            if (pin.flushing)
            {
                return S_FALSE;
            }
            return await pin.spec.receive?.(pin, sample >>> 0) ?? S_OK;
        },
        /** HRESULT ReceiveMultiple(IMediaSample **pSamples, long nSamples, long *nSamplesProcessed) */
        ReceiveMultiple: async(pin, [samples, count, processed])=>{
            let done = 0;
            let answer = S_OK;
            for (; done < (count | 0); done++)
            {
                answer = await memInputMethods.Receive(pin,
                    [host.readU32((samples >>> 0) + done * 4)]);
                if (answer !== S_OK)
                {
                    break;
                }
            }
            if ((processed >>> 0) !== 0)
            {
                host.writeMemory(processed >>> 0, dword(done));
            }
            return answer;
        },
        ReceiveCanBlock: ()=>S_OK,
    };

    /** @type {Record<string, (filter: Filter, args: number[], object: any) => number | Promise<number>>} */
    const filterMethods = {
        /** HRESULT GetClassID(CLSID *pClassID) */
        GetClassID: (filter, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(filter.clsid)));
            return S_OK;
        },
        Stop: filter=>changeState(filter, STATE_STOPPED),
        Pause: filter=>changeState(filter, STATE_PAUSED),
        /** HRESULT Run(REFERENCE_TIME tStart) */
        Run: (filter, [low, high])=>{
            filter.start = (high | 0) * 0x1_0000_0000 + (low >>> 0);
            return changeState(filter, STATE_RUNNING);
        },
        /**
         * HRESULT GetState(DWORD dwMilliSecsTimeout, FILTER_STATE *State)
         *
         * The class answers whether it has reached the state (a renderer
         * paused with no sample has not: VFW_S_STATE_INTERMEDIATE).
         */
        GetState: async(filter, [timeout, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const answer = await filterClass.get(filter.clsid)?.stateAnswer?.(filter, timeout >>> 0)
                ?? S_OK;
            host.writeMemory(out >>> 0, dword(filter.state));
            return answer;
        },
        /** HRESULT SetSyncSource(IReferenceClock *pClock) */
        SetSyncSource: async(filter, [clock])=>{
            if ((clock >>> 0) !== 0)
            {
                await addRef(clock >>> 0);
            }
            const before = filter.clock;
            filter.clock = clock >>> 0;
            if (before !== 0)
            {
                await release(before);
            }
            return S_OK;
        },
        /** HRESULT GetSyncSource(IReferenceClock **pClock) */
        GetSyncSource: async(filter, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, dword(filter.clock));
            if (filter.clock !== 0)
            {
                await addRef(filter.clock);
            }
            return S_OK;
        },
        /** HRESULT EnumPins(IEnumPins **ppEnum) */
        EnumPins: (filter, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, dword(enumerator(IID_IENUM_PINS, ()=>[...filter.pins],
                handPin, 0, filter)));
            return S_OK;
        },
        /** HRESULT FindPin(LPCWSTR Id, IPin **ppPin) */
        FindPin: (filter, [id, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const wanted = host.readWideString(id >>> 0, NAME_BYTES * 4);
            const pin = filter.pins.find(each=>(each.spec.id ?? each.spec.name) === wanted);
            host.writeMemory(out >>> 0, dword(pin ? handPin(pin) : 0));
            return pin ? S_OK : VFW_E_NOT_FOUND;
        },
        /** HRESULT QueryFilterInfo(FILTER_INFO *pInfo) */
        QueryFilterInfo: async(filter, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const info = new Uint8Array(FILTER_INFO_BYTES);
            info.set(wideInline(filter.name, MAX_NAME), 0);
            info.set(dword(filter.graph), NAME_BYTES);
            host.writeMemory(out >>> 0, info);
            if (filter.graph !== 0)
            {
                await addRef(filter.graph);
            }
            return S_OK;
        },
        /** HRESULT JoinFilterGraph(IFilterGraph *pGraph, LPCWSTR pName) */
        JoinFilterGraph: (filter, [graph, name])=>{
            filter.graph = graph >>> 0;
            filter.name = (name >>> 0) === 0 ? '' : host.readWideString(name >>> 0, NAME_BYTES);
            return S_OK;
        },
        QueryVendorInfo: ()=>E_NOTIMPL,
    };

    /**
     * Moves a filter's state: the class is told first and can refuse; a pin's
     * end of stream and flushing are cleared on the way to stopped.
     *
     * @param {Filter} filter @param {number} to
     */
    async function changeState(filter, to){
        const from = filter.state;
        const answer = await filterClass.get(filter.clsid)?.changed?.(filter, from, to) ?? S_OK;
        if (failed(answer))
        {
            return answer;
        }
        // An output pin's allocator is committed while its filter streams, as
        // the base classes' pin does on its way out of stopped, and decommitted
        // on its way back: a sample asked of a stopped filter's pin is refused.
        if (from === STATE_STOPPED && to !== STATE_STOPPED)
        {
            for (const pin of filter.pins)
            {
                if (pin.spec.direction === 'output' && pin.allocator !== 0)
                {
                    await call(pin.allocator, ALLOCATOR.Commit);
                }
            }
        }
        filter.state = to;
        if (to === STATE_STOPPED)
        {
            for (const pin of filter.pins)
            {
                pin.ended = false;
                pin.flushing = false;
                if (from !== STATE_STOPPED && pin.spec.direction === 'output'
                    && pin.allocator !== 0)
                {
                    await call(pin.allocator, ALLOCATOR.Decommit);
                }
            }
        }
        return answer;
    }

    /** @type {Map<string, FilterSpec>} */
    const filterClass = new Map();

    /** IQualityControl, which a pin answers and does nothing with: no quality is kept. */
    const qualityControl = describe(IID_IQUALITY_CONTROL, IQUALITY_CONTROL_SLOTS,
        { Notify: ()=>S_OK, SetSink: ()=>S_OK });

    /**
     * A pin of a filter, its COM object made.
     *
     * @param {Filter} filter @param {PinSpec} spec
     * @returns {Pin}
     */
    const makePin = (filter, spec)=>{
        /** @type {Pin} */
        const pin = { filter, spec, object: null, peer: 0, type: null, memInput: 0, allocator: 0,
            flushing: false, ended: false, state: null };
        // A pin is part of its filter: its references are the filter's, as
        // DirectShow's pins count on their filter, and it lives as long as the
        // filter does. Its QueryInterface answers its own interfaces.
        /** @type {import('../ole32/objects.js').Aggregation} */
        const shared = {
            outer: 0,
            call: async(slot, args)=>{
                const owner = /** @type {any} */ (filter.object);
                if (slot === 1)
                {
                    return owner ? await owner.addRef(IID_IBASE_FILTER) : 1;
                }
                if (slot === 2)
                {
                    return owner ? owner.release() : 0;
                }
                const [riid, out] = args;
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                // The pin's identity is its IPin: an IUnknown of its own would
                // count apart from the filter, which a pin must not.
                const asked = guidAt(riid);
                const id = asked === IID_IUNKNOWN ? IID_IPIN : asked;
                const record = /** @type {any} */ (pin.object).interfaceFor(id);
                if (!record)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return E_NOINTERFACE;
                }
                host.writeMemory(out >>> 0, dword(host.publish(/** @type {any} */ (pin.object),
                    id)));
                if (owner)
                {
                    await owner.addRef(IID_IBASE_FILTER);
                }
                return S_OK;
            },
        };
        pin.object = createComObject(filter.clsid, {
            state: pin,
            owned: true,
            interfaces: [
                describe(IID_IPIN, IPIN_SLOTS, pinMethods),
                qualityControl,
                ...spec.direction === 'input' && !spec.pull
                    ? [describe(IID_IMEM_INPUT_PIN, IMEM_INPUT_PIN_SLOTS, memInputMethods)] : [],
                ...spec.interfaces ?? [],
            ],
        }, shared);
        return pin;
    };

    /**
     * A filter class, ready for a COM registry.
     *
     * @param {FilterSpec} spec
     * @returns {() => import('../ole32/objects.js').ComClassDefinition}
     */
    const defineFilter = spec=>{
        filterClass.set(spec.clsid, spec);
        return ()=>{
            /** @type {Filter} */
            const filter = { clsid: spec.clsid, state: STATE_STOPPED, clock: 0, graph: 0, name: '',
                start: 0, pins: [], object: null, state2: null };
            filter.state2 = spec.state?.(filter) ?? null;
            filter.pins = spec.pins(filter).map(each=>makePin(filter, each));
            return {
                state: filter,
                aggregatable: spec.aggregatable ?? true,
                interfaces: [
                    describe(IID_IBASE_FILTER, IBASE_FILTER_SLOTS, ownMethods),
                    describe(IID_IMEDIA_FILTER, IMEDIA_FILTER_SLOTS, ownMethods),
                    describe(IID_IPERSIST, IMEDIA_FILTER_SLOTS.slice(0, 1), ownMethods),
                    ...spec.interfaces?.(filter) ?? [],
                ],
                destroy: ()=>{
                    spec.destroy?.(filter);
                    for (const pin of filter.pins)
                    {
                        if (pin.peer !== 0 || pin.allocator !== 0)
                        {
                            void dropConnection(pin);
                        }
                    }
                    if (filter.clock !== 0)
                    {
                        void release(filter.clock);
                        filter.clock = 0;
                    }
                },
            };
        };
    };

    /**
     * The filter's methods, each keeping the object it was called on: a pin
     * hands out its filter, and a pin is reached only through a call on the
     * filter (EnumPins, FindPin), so the filter's object is known by then.
     *
     * @type {Record<string, (filter: Filter, args: number[], object: any) =>
     *     number | Promise<number>>}
     */
    const ownMethods = Object.fromEntries(Object.entries(filterMethods).map(([name, method])=>{
        /** @param {Filter} filter @param {number[]} args @param {any} object */
        const keeping = (filter, args, object)=>{
            filter.object ??= object;
            return method(filter, args, object);
        };
        return [name, keeping];
    }));

    return {
        defineFilter, makePin, mediaType, readMediaType, writeMediaType, createMediaType,
        deleteMediaType, call, queryInterface, addRef, release, guidAt, qualityControl,
        changeState, STATE_STOPPED, STATE_PAUSED, STATE_RUNNING, callStreaming, deliver,
        dropConnection,
        deliverEndOfStream, deliverNewSegment, deliverFlush,
    };
}
