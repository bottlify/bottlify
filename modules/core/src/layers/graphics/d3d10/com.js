/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The reference counting and interface identity every DXGI and Direct3D 10
 * object shares.
 *
 * It is attached to an object that already exists rather than wrapping one,
 * for a reason that is the whole point of COM identity: `QueryInterface` and
 * `GetParent` have to hand back *the* object a program can compare against the
 * one it already holds. A wrapper around a counted core hands back the core
 * instead, and every `parent == adapter` test a program makes then fails.
 *
 * Two lifetimes are expressed here. An ordinary object arrives with one
 * reference, held by whoever asked for it. An **implicit** one -- an adapter
 * enumerated out of a factory, a back buffer obtained from a swap chain --
 * starts at zero, because it belongs to its owner rather than to the caller;
 * what its count actually drives is the *owner's* count, which is why the
 * first-reference and last-reference hooks exist.
 */

import {
    D3D11_TWIN, DXGI_ERROR_MORE_DATA, DXGI_ERROR_NOT_FOUND, E_INVALIDARG, E_NOINTERFACE, IID,
    S_FALSE, S_OK,
} from './constants.js';

/**
 * @typedef {Object} PrivateDataQuery
 * @property {number | null} size     What the caller has room for; null for no size pointer.
 * @property {boolean} wantsData      Whether the caller supplied somewhere to put it.
 */

/**
 * @typedef {Object} PrivateDataAnswer
 * @property {number} hr
 * @property {number} size            How big the entry is, which a too-small caller learns.
 * @property {Uint8Array | null} [data]
 * @property {any} [object]           An interface entry, with a reference taken for the caller.
 */

/**
 * The per-object store behind `SetPrivateData` and its two companions.
 *
 * A program keeps its own bookkeeping on Direct3D objects this way -- a debug
 * name, a back-pointer to its own wrapper -- and reads it back later, so the
 * store is part of every object rather than a nicety. The rules are the ones
 * the runtime observably follows: a null pointer with any size is a clear,
 * which answers `S_FALSE` when there was nothing to clear; a null *interface*
 * is not a clear but an entry whose value is null; an interface entry holds a
 * reference and reports the size of a pointer.
 */
export function createPrivateData(){
    /** @type {Map<string, { data: Uint8Array | null, object: any, isInterface: boolean }>} */
    const entries = new Map();

    /** @param {string} guid */
    const drop = guid=>{
        const held = entries.get(guid);
        if (held && held.isInterface && held.object)
        {
            held.object.release();
        }
        return entries.delete(guid);
    };

    return {
        /**
         * @param {string} guid
         * @param {number} size
         * @param {Uint8Array | null} data
         * @returns {number}
         */
        SetPrivateData(guid, size, data){
            if (!data)
            {
                return drop(guid) ? S_OK : S_FALSE;
            }
            drop(guid);
            entries.set(guid, {
                data: data.slice(0, size), object: null, isInterface: false,
            });
            return S_OK;
        },

        /**
         * @param {string} guid
         * @param {any} object  Null stores a null interface rather than clearing.
         * @returns {number}
         */
        SetPrivateDataInterface(guid, object){
            if (object)
            {
                object.addRef();
            }
            drop(guid);
            entries.set(guid, { data: null, object: object ?? null, isInterface: true });
            return S_OK;
        },

        /**
         * @param {string} guid
         * @param {PrivateDataQuery} query
         * @returns {PrivateDataAnswer}
         */
        GetPrivateData(guid, query){
            if (query.size === null)
            {
                return { hr: E_INVALIDARG, size: 0 };
            }
            const held = entries.get(guid);
            if (!held)
            {
                return { hr: DXGI_ERROR_NOT_FOUND, size: 0 };
            }
            const size = held.isInterface ? 4 : /** @type {Uint8Array} */ (held.data).length;
            if (!query.wantsData)
            {
                return { hr: S_OK, size };
            }
            if (query.size < size)
            {
                return { hr: DXGI_ERROR_MORE_DATA, size };
            }
            if (held.isInterface)
            {
                if (held.object)
                {
                    held.object.addRef();
                }
                return { hr: S_OK, size, object: held.object };
            }
            return { hr: S_OK, size, data: held.data };
        },
    };
}

/**
 * @typedef {Object} ComAttachOptions
 * @property {readonly string[]} interfaces  IUnknown is added; the rest are declared.
 * @property {any} [parent]                  What `GetParent` answers with.
 * @property {boolean} [implicit]            Start at zero references.
 * @property {() => void} [onFirstRef]
 * @property {() => void} [onLastRef]
 * @property {(iid: string) => boolean} [also]  Interfaces it has come to answer to since.
 */

/**
 * @template T
 * @param {T} target
 * @param {ComAttachOptions} options
 * @returns {T & { supports: (iid: string) => boolean, addRef: () => number,
 *          release: () => number, refCount: number,
 *          QueryInterface: (iid: string, out: any) => number,
 *          GetParent: (iid: string, out: any) => number }
 *          & ReturnType<typeof createPrivateData>}
 */
export function attachCom(target, options){
    const interfaces = new Set([IID.IUnknown, ...options.interfaces.flatMap(id=>
        (D3D11_TWIN[id] ? [id, D3D11_TWIN[id]] : [id]))]);
    const privateData = createPrivateData();
    let count = options.implicit ? 0 : 1;
    if (!options.implicit)
    {
        options.onFirstRef?.();
    }

    const methods = {
        /** @param {string} iid */
        supports(iid){
            return interfaces.has(iid) || options.also?.(iid) === true;
        },

        addRef(){
            if (count === 0)
            {
                options.onFirstRef?.();
            }
            count++;
            return count;
        },

        release(){
            if (count === 0)
            {
                return 0;
            }
            count--;
            if (count === 0)
            {
                options.onLastRef?.();
            }
            return count;
        },

        /**
         * @param {string} iid
         * @param {{ object?: any }} out
         * @returns {number}
         */
        QueryInterface(iid, out){
            if (!methods.supports(iid))
            {
                // Cleared on failure: callers read the out pointer back without
                // checking and would otherwise follow whatever it held before.
                out.object = null;
                return E_NOINTERFACE;
            }
            methods.addRef();
            out.object = target;
            return S_OK;
        },

        /**
         * @param {string} iid
         * @param {{ parent?: any }} out
         * @returns {number}
         */
        GetParent(iid, out){
            const parent = options.parent;
            if (!parent || !parent.supports(iid))
            {
                out.parent = null;
                return E_NOINTERFACE;
            }
            parent.addRef();
            out.parent = parent;
            return S_OK;
        },
    };

    // Configurable: a recording's proxy of the object answers its own wrapper
    // for each method (`remote/replay.js`), which a frozen property forbids.
    /** @param {Function} value */
    const method = value=>({ value, enumerable: true, writable: true, configurable: true });
    // Gone at no references, unless a context still keeps it bound (Direct3D
    // 11's), or the object says otherwise itself.
    if (!Object.hasOwn(/** @type {any} */ (target), 'destroyed'))
    {
        Object.defineProperty(target, 'destroyed', {
            get: ()=>count === 0 && !(/** @type {any} */ (target).bound > 0),
            enumerable: false, configurable: true,
        });
        // The bridge keeps an interface whose count went to zero published
        // while the object is still reachable: here, while it is bound.
        Object.defineProperty(target, 'reachable', {
            value: ()=>/** @type {any} */ (target).bound > 0,
            enumerable: false, configurable: true, writable: true,
        });
    }
    return Object.defineProperties(/** @type {any} */ (target), {
        SetPrivateData: method(privateData.SetPrivateData),
        SetPrivateDataInterface: method(privateData.SetPrivateDataInterface),
        GetPrivateData: method(privateData.GetPrivateData),
        supports: method(methods.supports),
        addRef: method(methods.addRef),
        release: method(methods.release),
        QueryInterface: method(methods.QueryInterface),
        GetParent: method(methods.GetParent),
        refCount: { get: ()=>count, enumerable: true, configurable: true },
    });
}
