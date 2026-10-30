/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The framework's objects as a program holds them: a structure in guest memory
 * whose first word is its own size, then cef_base_ref_counted_t's four calls,
 * then the type's own -- function pointers inline, not through a table -- each
 * stdcall with the structure as its first argument (CEF_CALLBACK). The calls
 * are this engine's handlers, placed once per type and method; the object's
 * state stays on the host, found by the structure's address. A reference the
 * program releases to zero frees the structure.
 */

/** cef_base_ref_counted_t: size_t size and four calls. */
export const BASE_SIZE = 20;

/**
 * @typedef {Object} CefMethod
 * @property {string} name
 * @property {number} argBytes  Counting the structure itself.
 * @property {(state: any, args: number[], self: number) => any} handler
 *           Its arguments after the structure; what it answers.
 */

/**
 * @typedef {Object} CefObjectsHost
 * @property {(name: string, fn: { argBytes: number, handler: (args: number[]) => any })
 *     => number} register  A stdcall handler placed in guest code; its address.
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} [free]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {CefObjectsHost} host
 */
export function createCefObjects(host){
    /** @type {Map<number, { state: any, refs: number, type: string }>} */
    const live = new Map();

    /** @param {number} address @param {number[]} words */
    const writeWords = (address, words)=>{
        const bytes = new Uint8Array(words.length * 4);
        const view = new DataView(bytes.buffer);
        words.forEach((word, i)=>view.setUint32(i * 4, word >>> 0, true));
        host.writeMemory(address, bytes);
    };

    /** The four reference calls every type shares. */
    let base = /** @type {number[] | null} */ (null);
    const baseCalls = ()=>{
        base ??= [
            host.register('cef_base.add_ref', { argBytes: 4, handler: ([self])=>{
                const entry = live.get(self >>> 0);
                if (entry)
                {
                    entry.refs++;
                }
                return 0;
            } }),
            host.register('cef_base.release', { argBytes: 4, handler: ([self])=>{
                const entry = live.get(self >>> 0);
                if (!entry || --entry.refs > 0)
                {
                    return 0;
                }
                live.delete(self >>> 0);
                host.free?.(self >>> 0);
                return 1;
            } }),
            host.register('cef_base.has_one_ref', { argBytes: 4,
                handler: ([self])=>(live.get(self >>> 0)?.refs === 1 ? 1 : 0) }),
            host.register('cef_base.has_at_least_one_ref', { argBytes: 4,
                handler: ([self])=>((live.get(self >>> 0)?.refs ?? 0) >= 1 ? 1 : 0) }),
        ];
        return base;
    };

    /** @type {Map<string, CefMethod[]>} each type's methods, in order */
    const types = new Map();
    /** @type {Map<string, number[]>} their addresses, placed when the first object is made */
    const placed = new Map();
    /** @param {string} type */
    const addressesOf = type=>{
        const methods = types.get(type);
        if (!methods)
        {
            throw new Error(`libcef: no type ${type}`);
        }
        if (!placed.has(type))
        {
            placed.set(type, methods.map(method=>host.register(`${type}.${method.name}`, {
                argBytes: method.argBytes,
                handler: args=>{
                    const self = args[0] >>> 0;
                    return method.handler(live.get(self)?.state, args.slice(1), self);
                },
            })));
        }
        return /** @type {number[]} */ (placed.get(type));
    };

    return {
        /**
         * A type: its methods in the order its C structure declares them.
         *
         * @param {string} type @param {CefMethod[]} methods
         */
        define(type, methods){
            types.set(type, methods);
        },

        /**
         * A new object of a type the program now holds one reference to.
         *
         * @param {string} type @param {any} state
         * @returns {number} the structure's address
         */
        make(type, state){
            const methods = addressesOf(type);
            const size = BASE_SIZE + methods.length * 4;
            const at = host.allocate(size) >>> 0;
            writeWords(at, [size, ...baseCalls(), ...methods]);
            live.set(at, { state, refs: 1, type });
            return at;
        },

        /** @param {number} address */
        stateOf: address=>live.get(address >>> 0)?.state,
    };
}
