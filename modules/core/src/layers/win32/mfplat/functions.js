/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mfplat - Media Foundation's platform: starting it, and the plain objects
 * everything else in Media Foundation is made of (attributes, media types,
 * memory buffers, samples, events).
 *
 * This build has no media pipeline behind them: no source resolver, no
 * decoders, no work queues. A program that only describes media -- builds
 * media types, fills samples, passes events -- runs as on Windows; one that
 * asks for a transform to be registered is refused as a user without the
 * rights to is (E_ACCESSDENIED), with the refusal said.
 */

import { E_INVALIDARG, E_NOTIMPL, E_OUTOFMEMORY, E_POINTER, S_OK, createMfKit, drive }
    from './kit.js';
import { createMfObjects } from './objects.js';
import { frameRateToTime, imageSize, mulDiv, timeToFrameRate } from './formats.js';
import { deserialize, serialize } from './blob.js';
import { createByteStreams } from './bytestream.js';
import { createAsync } from './async.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';

export const MF_E_BAD_STARTUP_VERSION = 0xc00d36e3 | 0;
const MF_E_BUFFERTOOSMALL = 0xc00d36b1 | 0;
/** What a work queue answers before MFStartup and after the last MFShutdown. */
const MF_E_SHUTDOWN = 0xc00d3e85 | 0;
const E_ACCESSDENIED = 0x80070005 | 0;
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/** The platform timer's period, which periodic callbacks are called at. */
const TIMER_PERIOD_MS = 10;

/** The SDK versions MFStartup takes in its version's high word: Vista's and 7's on. */
const SDK_VERSIONS = new Set([1, 2]);

/**
 * @typedef {import('./kit.js').MfHost & {
 *     propVariant?: { copy: (dest: number, src: number) => number | Promise<number>,
 *         clear: (at: number) => number | Promise<number> },
 *     setRegisters?: (values: { edx?: number }) => void,
 *     now?: () => number,
 *     files?: import('./bytestream.js').FileCalls,
 *     notices?: import('./async.js').AsyncHost['notices'],
 *     tempPath?: () => Promise<string> }} MfplatHost
 *     `setRegisters` carries a LONGLONG's high half back in EDX; `now` is the
 *     machine's clock in milliseconds, which MFGetSystemTime reads.
 */

/**
 * @param {MfplatHost} host
 */
export function createMfplatFunctions(host){
    const kit = createMfKit(host);
    const objects = createMfObjects(kit, host);
    const { guidAt } = kit;
    const streams = createByteStreams(kit, host, objects.attributes, host.files);
    const async = createAsync(kit, host);
    /** MFStartup's count, which MFShutdown takes down to zero and no further. */
    let started = 0;
    let locks = 0;

    /**
     * An object's pointer written out, or the refusal for one there was no
     * room for.
     *
     * @param {number} out @param {any} object
     */
    const hand = (out, object)=>{
        if ((out >>> 0) === 0)
        {
            object?.release();
            return E_POINTER;
        }
        return object ? kit.give(out, object) : E_OUTOFMEMORY;
    };

    const { putU64 } = kit;
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>kit.putU32s(at, [value]);
    /** A LONGLONG answered in EDX:EAX. @param {bigint} value */
    const answer64 = value=>{
        const bits = BigInt.asUintN(64, value);
        host.setRegisters?.({ edx: Number(bits >> 32n) });
        return Number(bits & 0xffffffffn);
    };

    /** @param {Map<string, import('./attributes.js').Item>} items */
    const blobOf = items=>serialize(items,
        guid=>/** @type {Uint8Array} */ (parseGuid(guid)));

    const table = {
        /** HRESULT MFStartup(ULONG version, DWORD flags) */
        MFStartup: { argBytes: 8, handler: (/** @type {number[]} */ [version])=>{
            if (!SDK_VERSIONS.has(version >>> 16))
            {
                return MF_E_BAD_STARTUP_VERSION;
            }
            started++;
            return S_OK;
        } },
        /** HRESULT MFShutdown(void): a shutdown with nothing started has no effect. */
        MFShutdown: { argBytes: 0, handler: ()=>{
            started = Math.max(0, started - 1);
            return S_OK;
        } },
        /** HRESULT MFLockPlatform(void), MFUnlockPlatform(void) */
        MFLockPlatform: { argBytes: 0, handler: ()=>{
            locks++;
            return S_OK;
        } },
        MFUnlockPlatform: { argBytes: 0, handler: ()=>{
            locks--;
            return S_OK;
        } },

        /** HRESULT MFCreateAttributes(IMFAttributes **attributes, UINT32 size) */
        MFCreateAttributes: { argBytes: 8, handler: (/** @type {number[]} */ [out])=>
            hand(out, objects.createStore()) },
        /** HRESULT MFCreateMediaType(IMFMediaType **type) */
        MFCreateMediaType: { argBytes: 4, handler: (/** @type {number[]} */ [out])=>
            hand(out, objects.createMediaType()) },
        /** HRESULT MFCreateSample(IMFSample **sample) */
        MFCreateSample: { argBytes: 4, handler: (/** @type {number[]} */ [out])=>
            hand(out, objects.createSample()) },
        /** HRESULT MFCreateMemoryBuffer(DWORD max, IMFMediaBuffer **buffer) */
        MFCreateMemoryBuffer: { argBytes: 8, handler: (/** @type {number[]} */ [max, out])=>
            ((out >>> 0) === 0 ? E_INVALIDARG : hand(out, objects.createBuffer(max))) },
        /** HRESULT MFCreateAlignedMemoryBuffer(DWORD max, DWORD alignment, IMFMediaBuffer **buffer) */
        MFCreateAlignedMemoryBuffer: { argBytes: 12,
            handler: (/** @type {number[]} */ [max, mask, out])=>((out >>> 0) === 0 ? E_INVALIDARG
                : hand(out, objects.createBuffer(max, mask))) },

        /**
         * HRESULT MFCreateMediaEvent(MediaEventType type, REFGUID extended,
         *     HRESULT status, const PROPVARIANT *value, IMFMediaEvent **event)
         */
        MFCreateMediaEvent: { argBytes: 20,
            handler: (/** @type {number[]} */ [type, extended, status, value, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const made = objects.createEvent(type,
                    (extended >>> 0) === 0 ? GUID_NULL : guidAt(extended), status, value);
                if (!made)
                {
                    return E_OUTOFMEMORY;
                }
                return drive((function* (){
                    const copied = yield made.copied;
                    if (copied !== S_OK)
                    {
                        made.object.release();
                        return copied;
                    }
                    return kit.give(out, made.object);
                })());
            } },

        /** HRESULT MFFrameRateToAverageTimePerFrame(UINT32 numerator, UINT32 denominator, UINT64 *time) */
        MFFrameRateToAverageTimePerFrame: { argBytes: 12,
            handler: (/** @type {number[]} */ [numerator, denominator, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                putU64(out, frameRateToTime(numerator >>> 0, denominator >>> 0));
                return S_OK;
            } },
        /** HRESULT MFAverageTimePerFrameToFrameRate(UINT64 time, UINT32 *numerator, UINT32 *denominator) */
        MFAverageTimePerFrameToFrameRate: { argBytes: 16, quadwords: [0],
            handler: (/** @type {number[]} */ [low, high, numerator, denominator])=>{
                if ((numerator >>> 0) === 0 || (denominator >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const rate = timeToFrameRate(kit.wide(low, high));
                putU32(numerator, rate.numerator);
                putU32(denominator, rate.denominator);
                return S_OK;
            } },
        /** LONGLONG MFllMulDiv(LONGLONG a, LONGLONG b, LONGLONG c, LONGLONG d): (a * b + d) / c */
        MFllMulDiv: { argBytes: 32, quadwords: [0, 2, 4, 6], handler: (/** @type {number[]} */ args)=>{
            const [a, b, c, d] = [0, 2, 4, 6]
                .map(at=>BigInt.asIntN(64, kit.wide(args[at], args[at + 1])));
            return answer64(mulDiv(a, b, c, d));
        } },
        /**
         * HRESULT MFCalculateImageSize(REFGUID subtype, UINT32 width, UINT32 height, UINT32 *size)
         *
         * A subtype it does not lay out is E_INVALIDARG with the size zeroed.
         */
        MFCalculateImageSize: { argBytes: 16,
            handler: (/** @type {number[]} */ [subtype, width, height, out])=>{
                if ((out >>> 0) === 0 || (subtype >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const size = imageSize(guidAt(subtype), width >>> 0, height >>> 0);
                putU32(out, size ?? 0);
                return size === null ? E_INVALIDARG : S_OK;
            } },
        /**
         * void *MFHeapAlloc(size_t size, ULONG flags, char *file, int line, EAllocationType type)
         *
         * The process heap's: the file, line and type are a debugging aid.
         */
        MFHeapAlloc: { returns: 'pointer', argBytes: 20, sizes: [0],
            handler: (/** @type {number[]} */ [size])=>
                host.heap.allocate(Math.max(size >>> 0, 1)) >>> 0 },
        /** void MFHeapFree(void *block) */
        MFHeapFree: { argBytes: 4, handler: (/** @type {number[]} */ [block])=>{
            if ((block >>> 0) !== 0)
            {
                host.heap.free(block >>> 0);
            }
            return 0;
        } },
        /** HRESULT MFGetTimerPeriodicity(DWORD *period): 10 ms, the platform timer's. */
        MFGetTimerPeriodicity: { argBytes: 4, handler: (/** @type {number[]} */ [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32(out, TIMER_PERIOD_MS);
            return S_OK;
        } },
        /** MFTIME MFGetSystemTime(void): the clock in 100-nanosecond units. */
        MFGetSystemTime: { argBytes: 0, handler: ()=>
            answer64(BigInt(Math.floor((host.now?.() ?? 0) * 10_000))) },

        /** HRESULT MFGetAttributesAsBlobSize(IMFAttributes *attributes, UINT32 *size) */
        MFGetAttributesAsBlobSize: { argBytes: 8,
            handler: (/** @type {number[]} */ [attributes, out])=>{
                if ((attributes >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return drive((function* (){
                    const items = yield objects.attributes.itemsOf(attributes,
                        host.callerThread?.());
                    putU32(out, blobOf(items).length);
                    return S_OK;
                })());
            } },
        /**
         * HRESULT MFGetAttributesAsBlob(IMFAttributes *attributes, UINT8 *buffer, UINT size)
         *
         * A buffer short of the whole is MF_E_BUFFERTOOSMALL, nothing written.
         */
        MFGetAttributesAsBlob: { argBytes: 12,
            handler: (/** @type {number[]} */ [attributes, buffer, size])=>{
                if ((attributes >>> 0) === 0 || (buffer >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return drive((function* (){
                    const bytes = blobOf(yield objects.attributes.itemsOf(attributes,
                        host.callerThread?.()));
                    if (bytes.length > (size >>> 0))
                    {
                        return MF_E_BUFFERTOOSMALL;
                    }
                    host.writeMemory(buffer >>> 0, bytes);
                    return S_OK;
                })());
            } },
        /**
         * HRESULT MFInitAttributesFromBlob(IMFAttributes *attributes, const UINT8 *buffer,
         *     UINT size)
         *
         * Bytes that are not a whole blob are E_INVALIDARG, the store untouched;
         * a good one replaces everything the store held.
         */
        MFInitAttributesFromBlob: { argBytes: 12,
            handler: (/** @type {number[]} */ [attributes, buffer, size])=>{
                if ((attributes >>> 0) === 0 || (buffer >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const bytes = Uint8Array.from(host.readMemory(buffer >>> 0, size >>> 0));
                const items = deserialize(bytes, at=>formatGuid(at));
                if (!items)
                {
                    return E_INVALIDARG;
                }
                return objects.attributes.copyInto(attributes, items, host.callerThread?.());
            } },

        /**
         * HRESULT MFCreateFile(MF_FILE_ACCESSMODE access, MF_FILE_OPENMODE open,
         *     MF_FILE_FLAGS flags, LPCWSTR url, IMFByteStream **stream)
         */
        MFCreateFile: { argBytes: 20,
            handler: (/** @type {number[]} */ [access, open, flags, url, out])=>{
                if ((out >>> 0) === 0 || (url >>> 0) === 0)
                {
                    return E_POINTER;
                }
                kit.putU32s(out, [0]);
                return streams.createFile(access >>> 0, open >>> 0, flags >>> 0,
                    kit.wideString(url)).then(made=>(typeof made === 'number' ? made
                    : kit.give(out, made)));
            } },
        /**
         * HRESULT MFCreateTempFile(MF_FILE_ACCESSMODE access, MF_FILE_OPENMODE open,
         *     MF_FILE_FLAGS flags, IMFByteStream **stream)
         *
         * A file of a new name in the user's temporary folder, deleted when
         * the stream closes.
         */
        MFCreateTempFile: { argBytes: 16,
            handler: (/** @type {number[]} */ [access, open, flags, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                kit.putU32s(out, [0]);
                if (!host.tempPath)
                {
                    return E_NOTIMPL;
                }
                return host.tempPath().then(folder=>streams.createFile(access >>> 0, open >>> 0,
                    flags >>> 0, `${folder}${globalThis.crypto.randomUUID()}.tmp`, true))
                    .then(made=>(typeof made === 'number' ? made : kit.give(out, made)));
            } },

        /**
         * HRESULT MFCreateAsyncResult(IUnknown *object, IMFAsyncCallback *callback,
         *     IUnknown *state, IMFAsyncResult **result)
         */
        MFCreateAsyncResult: { argBytes: 16,
            handler: (/** @type {number[]} */ [object, callback, state, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const made = async.create(object, callback, state);
                if (!made)
                {
                    return E_OUTOFMEMORY;
                }
                return drive((function* (){
                    for (const ref of made.held)
                    {
                        yield ref;
                    }
                    return kit.give(out, made.made);
                })());
            } },
        /** HRESULT MFInvokeCallback(IMFAsyncResult *result) */
        MFInvokeCallback: { argBytes: 4, handler: (/** @type {number[]} */ [result])=>
            (started === 0 ? MF_E_SHUTDOWN : async.invoke(result)) },
        /**
         * HRESULT MFPutWorkItem(DWORD queue, IMFAsyncCallback *callback, IUnknown *state)
         *
         * A result made for the callback and invoked on the platform's thread;
         * the work holds it, the caller never sees it.
         */
        MFPutWorkItem: { argBytes: 12, handler: (/** @type {number[]} */ [queue, callback, state])=>{
            if (started === 0)
            {
                return MF_E_SHUTDOWN;
            }
            if ((callback >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const checked = async.lockQueue(queue, 0);
            if (checked !== S_OK)
            {
                return checked;
            }
            const made = async.create(0, callback, state);
            if (!made)
            {
                return E_OUTOFMEMORY;
            }
            return drive((function* (){
                for (const ref of made.held)
                {
                    yield ref;
                }
                const hr = async.invoke(made.pointer);
                made.made.release();
                return hr;
            })());
        } },
        /** HRESULT MFAllocateWorkQueue(DWORD *queue) */
        MFAllocateWorkQueue: { argBytes: 4, handler: (/** @type {number[]} */ [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (started === 0)
            {
                return MF_E_SHUTDOWN;
            }
            kit.putU32s(out, [async.allocateQueue()]);
            return S_OK;
        } },
        /** HRESULT MFLockWorkQueue(DWORD queue), MFUnlockWorkQueue(DWORD queue) */
        MFLockWorkQueue: { argBytes: 4, handler: (/** @type {number[]} */ [queue])=>
            async.lockQueue(queue, 1) },
        MFUnlockWorkQueue: { argBytes: 4, handler: (/** @type {number[]} */ [queue])=>
            async.lockQueue(queue, -1) },

        /**
         * HRESULT MFTRegister(CLSID clsid, GUID category, LPWSTR name, UINT32 flags,
         *     UINT32 inputs, MFT_REGISTER_TYPE_INFO *input, UINT32 outputs,
         *     MFT_REGISTER_TYPE_INFO *output, IMFAttributes *attributes)
         *
         * No transform this build could load is registered: refused as a
         * user who may not write the machine's registration is refused.
         */
        MFTRegister: { argBytes: 60, structs: { 0: 4, 4: 4 }, handler: ()=>{
            kit.sayOnce('MFTRegister',
                'a transform is not registered: refused with E_ACCESSDENIED');
            return E_ACCESSDENIED;
        } },
    };

    return { table, objects, kit,
        /** For a test: the platform's counts. */
        counts: ()=>({ started, locks }) };
}
