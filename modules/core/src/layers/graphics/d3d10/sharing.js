/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Resources one device makes and another opens: a texture made shared is
 * named by a handle, and a device that opens the handle has an object of its
 * own over the same storage (the renderer's backing, `render.js`). Every
 * device a root makes shares one GPU, so the storage is one texture and the
 * devices see each other's writes in the order their work reaches it.
 *
 * A legacy (KMT) handle is a number in the system's range for them
 * (0xc0000000 and up), not a handle of the process: it is never closed or
 * duplicated. An NT handle is a kernel object of the process (`DxgkSharedResource`),
 * made by IDXGIResource1::CreateSharedHandle, which names the same share.
 *
 * A keyed mutex is the share's: one key, and the device whose object holds
 * it. It is acquired with the key it was last released with (zero at first),
 * held by one device at a time, and abandoned when the object that held it
 * goes: from then on it answers WAIT_ABANDONED (test_keyed_mutex).
 */

import { DXGI_ERROR_INVALID_CALL, S_OK } from './constants.js';

export const WAIT_ABANDONED = 0x80;
export const WAIT_TIMEOUT = 0x102;
const INFINITE = 0xffffffff;

/** Where the legacy handles start: is_kmt_handle in Windows' tests is `h & 0xc0000000`. */
const FIRST_KMT = 0xc0000100;

/**
 * @typedef {Object} Share
 * @property {number} key  The legacy handle; also what an NT handle names.
 * @property {boolean} nt  Made with SHARED_NTHANDLE: opened only by an NT handle.
 * @property {any} resource  The object it was made as.
 * @property {any} backing  The renderer's storage every object of it shares.
 * @property {readonly string[]} interfaces  What every object of it answers to.
 * @property {number} holders  Objects over it that are alive.
 * @property {{ key: number, owner: any, abandoned: boolean,
 *     waiters: Set<() => void> } | null} mutex
 */

export function createSharing(){
    let next = 0;
    /** @type {Map<number, Share>} */
    const shares = new Map();

    return {
        /**
         * @param {any} resource @param {any} backing
         * @param {{ nt: boolean, keyed: boolean, interfaces: readonly string[] }} kind
         * @returns {Share}
         */
        share(resource, backing, kind){
            const key = (FIRST_KMT + 4 * next++) >>> 0;
            /** @type {Share} */
            const made = { key, nt: kind.nt, resource, backing, interfaces: kind.interfaces,
                holders: 1,
                mutex: kind.keyed ? { key: 0, owner: null, abandoned: false, waiters: new Set() }
                    : null };
            shares.set(key, made);
            return made;
        },

        /** @param {number} key @returns {Share | null} */
        find(key){
            return shares.get(key >>> 0) ?? null;
        },

        /** @param {Share} share */
        hold(share){
            share.holders++;
        },

        /**
         * An object over a share is gone: a mutex it held is abandoned, and the
         * share with its last object.
         *
         * @param {Share} share @param {any} device  the device the object was of
         * @returns {boolean} whether it was the last
         */
        letGo(share, device){
            const mutex = share.mutex;
            if (mutex && mutex.owner === device)
            {
                mutex.owner = null;
                mutex.abandoned = true;
                wake(mutex);
            }
            share.holders--;
            if (share.holders > 0)
            {
                return false;
            }
            shares.delete(share.key);
            return true;
        },
    };
}

/** @param {NonNullable<Share['mutex']>} mutex */
function wake(mutex){
    for (const waiter of [...mutex.waiters])
    {
        waiter();
    }
}

/**
 * IDXGIKeyedMutex::AcquireSync for a device's object.
 *
 * @param {Share} share @param {any} device @param {number} key @param {number} milliseconds
 * @param {(ms: number, then: () => void) => void} [later]  a timer: setTimeout by default
 * @returns {number | Promise<number>}
 */
export function acquireSync(share, device, key, milliseconds, later = defaultLater){
    const mutex = /** @type {NonNullable<Share['mutex']>} */ (share.mutex);
    const now = ()=>{
        if (mutex.abandoned)
        {
            return WAIT_ABANDONED;
        }
        if (mutex.owner === device)
        {
            return DXGI_ERROR_INVALID_CALL;
        }
        if (mutex.owner === null && mutex.key === key)
        {
            mutex.owner = device;
            return S_OK;
        }
        return null;
    };
    const answer = now();
    if (answer !== null || milliseconds === 0)
    {
        return answer ?? WAIT_TIMEOUT;
    }
    return new Promise(resolve=>{
        let done = false;
        const settle = (/** @type {number} */ hr)=>{
            if (!done)
            {
                done = true;
                mutex.waiters.delete(check);
                resolve(hr);
            }
        };
        const check = ()=>{
            const hr = now();
            if (hr !== null)
            {
                settle(hr);
            }
        };
        mutex.waiters.add(check);
        if ((milliseconds >>> 0) !== INFINITE)
        {
            later(milliseconds >>> 0, ()=>settle(WAIT_TIMEOUT));
        }
    });
}

/**
 * IDXGIKeyedMutex::ReleaseSync: only the device that holds it lets it go,
 * with any key.
 *
 * @param {Share} share @param {any} device @param {number} key
 * @returns {number}
 */
export function releaseSync(share, device, key){
    const mutex = /** @type {NonNullable<Share['mutex']>} */ (share.mutex);
    if (mutex.abandoned || mutex.owner !== device)
    {
        return DXGI_ERROR_INVALID_CALL;
    }
    mutex.owner = null;
    mutex.key = key;
    wake(mutex);
    return S_OK;
}

/** @param {number} ms @param {() => void} then */
function defaultLater(ms, then){
    setTimeout(then, ms);
}
