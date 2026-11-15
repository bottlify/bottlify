/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz.dll's memory allocator, CLSID_MemoryAllocator: the IMemAllocator two
 * pins agree on to pass samples, and the IMediaSample/IMediaSample2 each buffer
 * is handed out as.
 *
 * What a program can observe is documented and is what this keeps: properties
 * are set while decommitted and no sample is out; Commit makes the buffers in
 * the program's memory, GetBuffer hands one out (waiting for a release when all
 * are out, unless AM_GBF_NOWAIT), Decommit refuses further buffers and leaves
 * those out valid until they come back, when the memory goes. A sample comes
 * back to the pool on its last Release with its flags, times and media type
 * cleared - its actual length stays, as quartz's does - and a sample's own media
 * type is a copy the sample owns, handed out as another copy in task memory.
 *
 * Every sample handed out is an object of its own over a buffer of the pool:
 * the pool is the buffers, and an object is made each time one leaves it.
 */

import { describe } from './describe.js';
import {
    CLSID_MEMORY_ALLOCATOR, IID_IMEDIA_SAMPLE, IID_IMEDIA_SAMPLE2, IID_IMEM_ALLOCATOR,
    IMEDIA_SAMPLE_SLOTS,
    IMEDIA_SAMPLE2_SLOTS, IMEM_ALLOCATOR_SLOTS,
} from './interfaces.js';
import { createComObject } from '../ole32/objects.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const VFW_E_BADALIGN = 0x8004020e;
const VFW_E_ALREADY_COMMITTED = 0x8004020f;
const VFW_E_BUFFERS_OUTSTANDING = 0x80040210;
const VFW_E_NOT_COMMITTED = 0x80040211;
const VFW_E_SIZENOTSET = 0x80040212;
const VFW_E_TIMEOUT = 0x8004022e;
const VFW_E_SAMPLE_TIME_NOT_SET = 0x80040249;
const VFW_E_MEDIA_TIME_NOT_SET = 0x80040251;
const VFW_E_BUFFER_OVERFLOW = 0x8004020d;
const VFW_S_NO_STOP_TIME = 0x00040270;

/** IMemAllocator::GetBuffer's dwFlags: answer at once rather than wait for a buffer. */
const AM_GBF_NOWAIT = 0x4;

/** AM_SAMPLE2_PROPERTIES::dwSampleFlags. */
const AM_SAMPLE_SPLICEPOINT = 0x1;
const AM_SAMPLE_PREROLL = 0x2;
const AM_SAMPLE_DATADISCONTINUITY = 0x4;
const AM_SAMPLE_TYPECHANGED = 0x8;
const AM_SAMPLE_TIMEVALID = 0x10;
const AM_SAMPLE_STOPVALID = 0x100;

/** ALLOCATOR_PROPERTIES: four LONGs. */
const PROPERTIES = { BUFFERS: 0, SIZE: 4, ALIGN: 8, PREFIX: 12, BYTES: 16 };

/** AM_SAMPLE2_PROPERTIES as a 32-bit process lays it out. */
const SAMPLE2 = {
    DATA: 0, TYPE_FLAGS: 4, FLAGS: 8, ACTUAL: 12, START: 16, STOP: 24, STREAM: 32,
    MEDIA_TYPE: 36, BUFFER: 40, BUFFER_BYTES: 44, BYTES: 48,
};

/** AM_MEDIA_TYPE: the format block's length and pointer, and the whole. */
const MEDIA_TYPE = { FORMAT_BYTES: 0x40, FORMAT: 0x44, BYTES: 0x48 };

/**
 * @typedef {Object} AllocatorHost
 * @property {(address: number) => number} readU32
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  The task heap's, which CoTaskMemFree frees.
 * @property {(address: number) => void} free
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 */

/**
 * @typedef {Object} Buffer
 * @property {number} memory   The block's start, as allocated.
 * @property {number} data     Where the sample's bytes begin, past the prefix and aligned.
 * @property {number} actual   Kept from one use of the buffer to the next.
 */

/**
 * @typedef {Object} SampleState
 * @property {AllocatorState} pool
 * @property {Buffer} buffer
 * @property {number} flags
 * @property {number} typeFlags
 * @property {number} stream
 * @property {number} start
 * @property {number} stop
 * @property {number | null} mediaStart
 * @property {number | null} mediaStop
 * @property {number} mediaType  The sample's own AM_MEDIA_TYPE, or 0.
 */

/**
 * @typedef {Object} AllocatorState
 * @property {{ buffers: number, size: number, align: number, prefix: number }} properties
 * @property {boolean} committed
 * @property {Buffer[]} free
 * @property {number} out        Samples handed out and not yet back.
 * @property {(() => void)[]} waiting  GetBuffer calls waiting for a buffer.
 * @property {boolean} gone      The allocator's last reference went.
 */

/** @param {number} value @returns {Uint8Array} */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {number} value @returns {Uint8Array} */
const quad = value=>{
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(Math.trunc(value)), true);
    return bytes;
};

/**
 * The memory allocator's class.
 *
 * @param {AllocatorHost} host
 * @returns {() => import('../ole32/objects.js').ComClassDefinition}
 */
export function createMemoryAllocator(host){
    /** @param {number} address */
    const readQuad = address=>(host.readU32(address + 4) | 0) * 0x1_0000_0000
        + host.readU32(address);
    /** @param {number} address @param {number} bytes */
    const copyOut = (address, bytes)=>{
        const copy = new Uint8Array(bytes);
        for (let at = 0; at < bytes; at += 4)
        {
            copy.set(dword(host.readU32(address + at)).subarray(0, Math.min(4, bytes - at)), at);
        }
        return copy;
    };

    /**
     * A copy of an AM_MEDIA_TYPE in task memory, its format block copied too,
     * as CreateMediaType makes one.
     *
     * @param {number} source
     */
    const copyMediaType = source=>{
        const type = copyOut(source, MEDIA_TYPE.BYTES);
        const view = new DataView(type.buffer);
        const formatBytes = view.getUint32(MEDIA_TYPE.FORMAT_BYTES, true);
        const format = view.getUint32(MEDIA_TYPE.FORMAT, true);
        if (formatBytes > 0 && format !== 0)
        {
            const block = host.allocate(formatBytes);
            host.writeMemory(block, copyOut(format, formatBytes));
            view.setUint32(MEDIA_TYPE.FORMAT, block, true);
        }
        else
        {
            view.setUint32(MEDIA_TYPE.FORMAT_BYTES, 0, true);
            view.setUint32(MEDIA_TYPE.FORMAT, 0, true);
        }
        const copy = host.allocate(MEDIA_TYPE.BYTES);
        host.writeMemory(copy, type);
        return copy;
    };

    /** @param {number} type */
    const freeMediaType = type=>{
        if (type === 0)
        {
            return;
        }
        const format = host.readU32(type + MEDIA_TYPE.FORMAT);
        if (format !== 0)
        {
            host.free(format);
        }
        host.free(type);
    };

    /**
     * The buffers' memory goes once the pool is decommitted and every sample is back.
     *
     * @param {AllocatorState} pool
     */
    const settle = pool=>{
        if (!pool.committed && pool.out === 0)
        {
            for (const buffer of pool.free)
            {
                host.free(buffer.memory);
            }
            pool.free = [];
        }
    };

    /** @type {Record<string, (state: SampleState, args: number[]) => number>} */
    const sample = {
        /** HRESULT GetPointer(BYTE **ppBuffer) */
        GetPointer: (state, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, dword(state.buffer.data));
            return S_OK;
        },
        /** LONG GetSize(void) */
        GetSize: state=>state.pool.properties.size,
        /** HRESULT GetTime(REFERENCE_TIME *pTimeStart, REFERENCE_TIME *pTimeEnd) */
        GetTime: (state, [start, end])=>{
            if (!(state.flags & AM_SAMPLE_TIMEVALID))
            {
                return VFW_E_SAMPLE_TIME_NOT_SET;
            }
            if ((start >>> 0) === 0 || (end >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(start >>> 0, quad(state.start));
            // With no stop time the end answered is the start's next tick.
            const stopped = (state.flags & AM_SAMPLE_STOPVALID) !== 0;
            host.writeMemory(end >>> 0, quad(stopped ? state.stop : state.start + 1));
            return stopped ? S_OK : VFW_S_NO_STOP_TIME;
        },
        /** HRESULT SetTime(REFERENCE_TIME *pTimeStart, REFERENCE_TIME *pTimeEnd) */
        SetTime: (state, [start, end])=>{
            state.flags &= ~(AM_SAMPLE_TIMEVALID | AM_SAMPLE_STOPVALID);
            if ((start >>> 0) !== 0)
            {
                state.start = readQuad(start >>> 0);
                state.flags |= AM_SAMPLE_TIMEVALID;
                if ((end >>> 0) !== 0)
                {
                    state.stop = readQuad(end >>> 0);
                    state.flags |= AM_SAMPLE_STOPVALID;
                }
            }
            return S_OK;
        },
        IsSyncPoint: state=>(state.flags & AM_SAMPLE_SPLICEPOINT ? S_OK : S_FALSE),
        SetSyncPoint: (state, [on])=>setFlag(state, AM_SAMPLE_SPLICEPOINT, on),
        IsPreroll: state=>(state.flags & AM_SAMPLE_PREROLL ? S_OK : S_FALSE),
        SetPreroll: (state, [on])=>setFlag(state, AM_SAMPLE_PREROLL, on),
        /** LONG GetActualDataLength(void) */
        GetActualDataLength: state=>state.buffer.actual,
        /** HRESULT SetActualDataLength(LONG lLen) */
        SetActualDataLength: (state, [length])=>{
            if ((length | 0) < 0 || (length | 0) > state.pool.properties.size)
            {
                return VFW_E_BUFFER_OVERFLOW;
            }
            state.buffer.actual = length | 0;
            return S_OK;
        },
        /** HRESULT GetMediaType(AM_MEDIA_TYPE **ppMediaType) */
        GetMediaType: (state, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (!(state.flags & AM_SAMPLE_TYPECHANGED))
            {
                host.writeMemory(out >>> 0, dword(0));
                return S_FALSE;
            }
            host.writeMemory(out >>> 0, dword(copyMediaType(state.mediaType)));
            return S_OK;
        },
        /** HRESULT SetMediaType(AM_MEDIA_TYPE *pMediaType) */
        SetMediaType: (state, [type])=>{
            freeMediaType(state.mediaType);
            state.mediaType = 0;
            state.flags &= ~AM_SAMPLE_TYPECHANGED;
            if ((type >>> 0) !== 0)
            {
                state.mediaType = copyMediaType(type >>> 0);
                state.flags |= AM_SAMPLE_TYPECHANGED;
            }
            return S_OK;
        },
        IsDiscontinuity: state=>(state.flags & AM_SAMPLE_DATADISCONTINUITY ? S_OK : S_FALSE),
        SetDiscontinuity: (state, [on])=>setFlag(state, AM_SAMPLE_DATADISCONTINUITY, on),
        /** HRESULT GetMediaTime(LONGLONG *pTimeStart, LONGLONG *pTimeEnd) */
        GetMediaTime: (state, [start, end])=>{
            if (state.mediaStart === null || state.mediaStop === null)
            {
                return VFW_E_MEDIA_TIME_NOT_SET;
            }
            if ((start >>> 0) === 0 || (end >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(start >>> 0, quad(state.mediaStart));
            host.writeMemory(end >>> 0, quad(state.mediaStop));
            return S_OK;
        },
        /** HRESULT SetMediaTime(LONGLONG *pTimeStart, LONGLONG *pTimeEnd) */
        SetMediaTime: (state, [start, end])=>{
            // Both or neither: one alone leaves the media time unset.
            const both = (start >>> 0) !== 0 && (end >>> 0) !== 0;
            state.mediaStart = both ? readQuad(start >>> 0) : null;
            state.mediaStop = both ? readQuad(end >>> 0) : null;
            return S_OK;
        },
    };

    /** @param {SampleState} state @param {number} flag @param {number} on */
    function setFlag(state, flag, on){
        state.flags = on ? state.flags | flag : state.flags & ~flag;
        return S_OK;
    }

    /** @type {Record<string, (state: SampleState, args: number[]) => number>} */
    const sample2 = {
        /** HRESULT GetProperties(DWORD cbProperties, BYTE *pbProperties) */
        GetProperties: (state, [bytes, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const props = new Uint8Array(SAMPLE2.BYTES);
            const view = new DataView(props.buffer);
            view.setUint32(SAMPLE2.DATA, SAMPLE2.BYTES, true);
            view.setUint32(SAMPLE2.TYPE_FLAGS, state.typeFlags, true);
            view.setUint32(SAMPLE2.FLAGS, state.flags, true);
            view.setInt32(SAMPLE2.ACTUAL, state.buffer.actual, true);
            view.setBigInt64(SAMPLE2.START, BigInt(state.start), true);
            view.setBigInt64(SAMPLE2.STOP, BigInt(state.stop), true);
            view.setUint32(SAMPLE2.STREAM, state.stream, true);
            view.setUint32(SAMPLE2.MEDIA_TYPE, state.mediaType, true);
            view.setUint32(SAMPLE2.BUFFER, state.buffer.data, true);
            view.setInt32(SAMPLE2.BUFFER_BYTES, state.pool.properties.size, true);
            host.writeMemory(out >>> 0, props.subarray(0, Math.min(bytes >>> 0, SAMPLE2.BYTES)));
            return S_OK;
        },
        /** HRESULT SetProperties(DWORD cbProperties, const BYTE *pbProperties) */
        SetProperties: (state, [bytes, from])=>{
            if ((from >>> 0) === 0)
            {
                return E_POINTER;
            }
            if ((bytes >>> 0) < SAMPLE2.MEDIA_TYPE)
            {
                return E_INVALIDARG;
            }
            const at = from >>> 0;
            state.typeFlags = host.readU32(at + SAMPLE2.TYPE_FLAGS);
            // The type-changed flag is SetMediaType's to give or take.
            state.flags = host.readU32(at + SAMPLE2.FLAGS) & ~AM_SAMPLE_TYPECHANGED
                | state.flags & AM_SAMPLE_TYPECHANGED;
            state.buffer.actual = host.readU32(at + SAMPLE2.ACTUAL) | 0;
            state.start = readQuad(at + SAMPLE2.START);
            state.stop = readQuad(at + SAMPLE2.STOP);
            state.stream = host.readU32(at + SAMPLE2.STREAM);
            return S_OK;
        },
    };

    /**
     * Hands a buffer out as a sample with one reference.
     *
     * @param {AllocatorState} pool @param {Buffer} buffer @returns {number} the IMediaSample
     */
    const handOut = (pool, buffer)=>{
        /** @type {SampleState} */
        const state = {
            pool, buffer, flags: 0, typeFlags: 0, stream: 0, start: 0, stop: 0,
            mediaStart: null, mediaStop: null, mediaType: 0,
        };
        pool.out++;
        const object = createComObject(CLSID_MEMORY_ALLOCATOR, {
            state,
            interfaces: [
                describe(IID_IMEDIA_SAMPLE, IMEDIA_SAMPLE_SLOTS, sample),
                describe(IID_IMEDIA_SAMPLE2, IMEDIA_SAMPLE2_SLOTS,
                    { ...sample, ...sample2 }),
            ],
            // Back to the pool on the last Release: a waiting GetBuffer takes it first.
            destroy: ()=>{
                freeMediaType(state.mediaType);
                pool.out--;
                pool.free.push(buffer);
                const next = pool.waiting.shift();
                if (next)
                {
                    next();
                }
                settle(pool);
            },
        });
        return host.publish(object, IID_IMEDIA_SAMPLE);
    };

    /** @type {Record<string, (state: AllocatorState, args: number[]) => number | Promise<number>>} */
    const allocator = {
        /** HRESULT SetProperties(ALLOCATOR_PROPERTIES *pRequest, ALLOCATOR_PROPERTIES *pActual) */
        SetProperties: (pool, [request, actual])=>{
            if ((request >>> 0) === 0 || (actual >>> 0) === 0)
            {
                return E_POINTER;
            }
            const buffers = host.readU32(request + PROPERTIES.BUFFERS) | 0;
            const size = host.readU32(request + PROPERTIES.SIZE) | 0;
            const align = host.readU32(request + PROPERTIES.ALIGN) | 0;
            const prefix = host.readU32(request + PROPERTIES.PREFIX) | 0;
            if (align <= 0 || (align & align - 1) !== 0)
            {
                return VFW_E_BADALIGN;
            }
            if (pool.committed)
            {
                return VFW_E_ALREADY_COMMITTED;
            }
            if (pool.out > 0)
            {
                return VFW_E_BUFFERS_OUTSTANDING;
            }
            pool.properties = { buffers, size, align, prefix };
            const answer = new Uint8Array(PROPERTIES.BYTES);
            const view = new DataView(answer.buffer);
            view.setInt32(PROPERTIES.BUFFERS, buffers, true);
            view.setInt32(PROPERTIES.SIZE, size, true);
            view.setInt32(PROPERTIES.ALIGN, align, true);
            view.setInt32(PROPERTIES.PREFIX, prefix, true);
            host.writeMemory(actual >>> 0, answer);
            return S_OK;
        },
        /** HRESULT GetProperties(ALLOCATOR_PROPERTIES *pProps) */
        GetProperties: (pool, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const { buffers, size, align, prefix } = pool.properties;
            const answer = new Uint8Array(PROPERTIES.BYTES);
            const view = new DataView(answer.buffer);
            view.setInt32(PROPERTIES.BUFFERS, buffers, true);
            view.setInt32(PROPERTIES.SIZE, size, true);
            view.setInt32(PROPERTIES.ALIGN, align, true);
            view.setInt32(PROPERTIES.PREFIX, prefix, true);
            host.writeMemory(out >>> 0, answer);
            return S_OK;
        },
        /** HRESULT Commit(void) */
        Commit: pool=>{
            const { buffers, size, align, prefix } = pool.properties;
            if (size <= 0)
            {
                return VFW_E_SIZENOTSET;
            }
            if (pool.committed)
            {
                return S_OK;
            }
            // Buffers made for an earlier commit and back in the pool are kept.
            while (pool.free.length + pool.out < buffers)
            {
                const memory = host.allocate(prefix + size + align);
                const data = Math.ceil((memory + prefix) / align) * align;
                pool.free.push({ memory, data, actual: size });
            }
            pool.committed = true;
            return S_OK;
        },
        /** HRESULT Decommit(void) */
        Decommit: pool=>{
            pool.committed = false;
            // A GetBuffer waiting for a buffer is told the allocator is decommitted.
            for (const next of pool.waiting.splice(0))
            {
                next();
            }
            settle(pool);
            return S_OK;
        },
        /**
         * HRESULT GetBuffer(IMediaSample **ppBuffer, REFERENCE_TIME *pStartTime,
         *                   REFERENCE_TIME *pEndTime, DWORD dwFlags)
         */
        GetBuffer: (pool, [out, , , flags])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            /** @returns {number | null} */
            const take = ()=>{
                if (!pool.committed)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return VFW_E_NOT_COMMITTED;
                }
                const buffer = pool.free.shift();
                if (!buffer)
                {
                    return null;
                }
                host.writeMemory(out >>> 0, dword(handOut(pool, buffer)));
                return S_OK;
            };
            const now = take();
            if (now !== null)
            {
                return now;
            }
            if (flags & AM_GBF_NOWAIT)
            {
                host.writeMemory(out >>> 0, dword(0));
                return VFW_E_TIMEOUT;
            }
            // Every buffer is out: the caller waits for one to come back.
            return new Promise(resolve=>{
                const retry = ()=>{
                    const answer = take();
                    if (answer === null)
                    {
                        pool.waiting.push(retry);
                        return;
                    }
                    resolve(answer);
                };
                pool.waiting.push(retry);
            });
        },
        /** HRESULT ReleaseBuffer(IMediaSample *pBuffer) */
        ReleaseBuffer: ()=>S_OK,
    };

    return ()=>{
        /** @type {AllocatorState} */
        const pool = {
            properties: { buffers: 0, size: 0, align: 0, prefix: 0 },
            committed: false, free: [], out: 0, waiting: [], gone: false,
        };
        return {
            state: pool,
            aggregatable: true,
            // The allocator going decommits it: samples still out keep their
            // buffers, and the memory goes with the last of them.
            destroy: ()=>{
                pool.gone = true;
                pool.committed = false;
                settle(pool);
            },
            interfaces: [describe(IID_IMEM_ALLOCATOR, IMEM_ALLOCATOR_SLOTS, allocator)],
        };
    };
}
