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

import { E_INVALIDARG, E_OUTOFMEMORY, E_POINTER, S_OK, createMfKit, drive } from './kit.js';
import { createMfObjects } from './objects.js';

export const MF_E_BAD_STARTUP_VERSION = 0xc00d36e3 | 0;
const E_ACCESSDENIED = 0x80070005 | 0;
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/** The SDK versions MFStartup takes in its version's high word: Vista's and 7's on. */
const SDK_VERSIONS = new Set([1, 2]);

/**
 * @typedef {import('./kit.js').MfHost & {
 *     propVariant?: { copy: (dest: number, src: number) => number | Promise<number>,
 *         clear: (at: number) => number | Promise<number> } }} MfplatHost
 */

/**
 * @param {MfplatHost} host
 */
export function createMfplatFunctions(host){
    const kit = createMfKit(host);
    const objects = createMfObjects(kit, host);
    const { guidAt } = kit;
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

        /**
         * HRESULT MFTRegister(CLSID clsid, GUID category, LPWSTR name, UINT32 flags,
         *     UINT32 inputs, MFT_REGISTER_TYPE_INFO *input, UINT32 outputs,
         *     MFT_REGISTER_TYPE_INFO *output, IMFAttributes *attributes)
         *
         * No transform this build could load is registered: refused as a
         * user who may not write the machine's registration is refused.
         */
        MFTRegister: { argBytes: 60, handler: ()=>{
            kit.sayOnce('MFTRegister',
                'a transform is not registered: refused with E_ACCESSDENIED');
            return E_ACCESSDENIED;
        } },
    };

    return { table, objects, kit,
        /** For a test: the platform's counts. */
        counts: ()=>({ started, locks }) };
}
