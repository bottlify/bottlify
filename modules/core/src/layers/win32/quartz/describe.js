/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds an interface descriptor from `[name, dwords]` pairs.
 *
 * The count excludes the interface pointer, because that is how a header reads
 * and transcribing a header is what the slot lists are; `argBytes` adds it back
 * because that is how the bridge counts. A slot with no implementation keeps
 * its place and answers E_NOTIMPL.
 *
 * @template S
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (state: S, args: number[],
 *         object: import('../ole32/objects.js').ComObject) => number | Promise<number>>} [implemented]
 *        A method may answer with a promise: the bridge parks the calling
 *        thread until it settles, which is what building a graph over a file
 *        that has to be fetched needs. The object comes last, for a method
 *        that has to hand out a pointer to the object it belongs to.
 * @returns {import('../ole32/objects.js').ComInterfaceDescriptor}
 */
export function describe(id, slots, implemented = {}){
    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const methods = slots.map(([name, dwords])=>{
        const method = implemented[name];
        return {
            name,
            argBytes: 4 + dwords * 4,
            invoke: method ? (object, args)=>method(object.state, args, object) : undefined,
        };
    });
    return { id, methods };
}
