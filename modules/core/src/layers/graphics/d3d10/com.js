/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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

import { E_NOINTERFACE, IID, S_OK } from './constants.js';

/**
 * @typedef {Object} ComAttachOptions
 * @property {readonly string[]} interfaces  IUnknown is added; the rest are declared.
 * @property {any} [parent]                  What `GetParent` answers with.
 * @property {boolean} [implicit]            Start at zero references.
 * @property {() => void} [onFirstRef]
 * @property {() => void} [onLastRef]
 */

/**
 * @template T
 * @param {T} target
 * @param {ComAttachOptions} options
 * @returns {T & { supports: (iid: string) => boolean, addRef: () => number,
 *          release: () => number, refCount: number,
 *          QueryInterface: (iid: string, out: any) => number,
 *          GetParent: (iid: string, out: any) => number }}
 */
export function attachCom(target, options){
    const interfaces = new Set([IID.IUnknown, ...options.interfaces]);
    let count = options.implicit ? 0 : 1;
    if (!options.implicit)
    {
        options.onFirstRef?.();
    }

    const methods = {
        /** @param {string} iid */
        supports(iid){
            return interfaces.has(iid);
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
            if (!interfaces.has(iid))
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

    return Object.defineProperties(/** @type {any} */ (target), {
        supports: { value: methods.supports, enumerable: true },
        addRef: { value: methods.addRef, enumerable: true },
        release: { value: methods.release, enumerable: true },
        QueryInterface: { value: methods.QueryInterface, enumerable: true },
        GetParent: { value: methods.GetParent, enumerable: true },
        refCount: { get: ()=>count, enumerable: true },
    });
}
