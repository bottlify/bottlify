/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { Convention } from './conventions.js';

/**
 * Putting an interface into guest memory.
 *
 * A COM interface pointer is not a handle: it is a real pointer to a real
 * object whose first word points at a table of function addresses, and guest
 * code walks both. It calls through the table by index, sometimes copies the
 * pointer, and compares two pointers to decide whether they are the same
 * object. So there is nothing to fake -- the layout has to exist.
 *
 * That makes it the bridge's work rather than any library's: the addresses in
 * the table are stubs, the calls through them are thiscall with `this` in ECX,
 * and both of those are what this layer already knows how to build.
 *
 *     interface pointer ->  [ vtable pointer ]     one word, in guest memory
 *                              |
 *                              v
 *     vtable            ->  [ method 0 ][ method 1 ][ ... ]   one word each
 *
 * The same object and interface must always produce the same pointer. A second
 * address for one interface is a second identity, and a program comparing
 * pointers then concludes it is holding two different objects.
 */

/** A pointer is four bytes, and so is every vtable slot. */
const WORD = 4;

/**
 * @typedef {Object} InterfaceMethod
 * @property {string} name
 * @property {number} argBytes            Counting `this`, per the thiscall rules.
 * @property {Function} [invoke]          Called as (object, args) with `this` removed.
 * @property {string} [builtin]           IUnknown's three, which we implement here.
 */

/**
 * @param {Object} deps
 * @param {any} deps.memory
 * @param {(name: string, fn: any) => number} deps.register  Bridge registration.
 * @param {{ allocate: (bytes: number) => number }} deps.heap
 */
export function createVtables({ memory, register, heap }){
    /** One entry per object; inside it, one address per interface. */
    const published = new WeakMap();
    let interfaces = 0;
    let methods = 0;

    /**
     * @param {any} object     The object model's record; opaque here.
     * @param {string} interfaceId
     * @param {InterfaceMethod[]} table
     * @returns {number} the interface pointer
     */
    function publish(object, interfaceId, table){
        let byInterface = published.get(object);
        if (!byInterface)
        {
            byInterface = new Map();
            published.set(object, byInterface);
        }
        const already = byInterface.get(interfaceId);
        if (already !== undefined)
        {
            return already;
        }

        const slots = table.map((method, index)=>register(
            `${interfaceId}::${method.name}`,
            {
                convention: Convention.THISCALL,
                argBytes: method.argBytes,
                /** @param {number[]} args */
                handler: args=>{
                    // The first argument is `this` -- the interface pointer the
                    // guest called through, not the object. What it identifies
                    // is settled here so no implementation has to know how an
                    // interface is laid out.
                    const [, ...rest] = args;
                    return dispatch(object, interfaceId, index, method, rest);
                },
            }));
        methods += slots.length;

        // The vtable and the one word pointing at it, allocated together: they
        // have the same lifetime and nothing else may sit between them.
        const block = heap.allocate(WORD + slots.length * WORD);
        const vtable = block + WORD;
        memory.writeU32(block, vtable);
        slots.forEach((address, index)=>memory.writeU32(vtable + index * WORD, address));

        byInterface.set(interfaceId, block);
        interfaces++;
        return block;
    }

    /**
     * Runs one method: IUnknown's three are ours, everything else belongs to
     * whoever described the interface.
     *
     * @param {any} object
     * @param {string} interfaceId
     * @param {number} index
     * @param {InterfaceMethod} method
     * @param {number[]} args
     */
    function dispatch(object, interfaceId, index, method, args){
        void index;
        switch (method.builtin){
            case 'queryInterface':
                return queryInterface(object, args);
            case 'addRef':
                return object.addRef();
            case 'release':
                return object.release();
            default:
                if (!method.invoke)
                {
                    // E_NOTIMPL: a method that exists in the table and does
                    // nothing is better than a hole a program jumps into.
                    return 0x80004001;
                }
                return method.invoke(object, args) | 0;
        }
    }

    /**
     * QueryInterface, which is where identity is decided: the guest hands us a
     * GUID and a place to put a pointer, and both come back through memory.
     *
     * @param {any} object
     * @param {number[]} args  [riid, ppvObject]
     */
    function queryInterface(object, [riid, ppv]){
        const E_POINTER = 0x80004003;
        const E_NOINTERFACE = 0x80004002;
        if ((ppv >>> 0) === 0)
        {
            return E_POINTER;
        }

        const wanted = readGuid(riid >>> 0);
        const record = object.interfaceFor(wanted);
        if (!record)
        {
            // Zeroed on failure: a program checks the pointer, not only the
            // result, and a stale value there is a pointer it will follow.
            memory.writeU32(ppv >>> 0, 0);
            return E_NOINTERFACE;
        }

        const pointer = publish(object, wanted, record.methods);
        object.addRef();
        memory.writeU32(ppv >>> 0, pointer);
        return 0; // S_OK
    }

    /**
     * A GUID as the canonical braced string the object model is keyed by. The
     * byte order is not flat: three little-endian integers and then eight raw
     * bytes, which is the difference between finding an interface and reporting
     * that it does not exist.
     *
     * @param {number} address
     */
    function readGuid(address){
        const bytes = memory.readBytes(address, 16);
        const hex = (/** @type {number} */ value, /** @type {number} */ width)=>
            value.toString(16).toUpperCase().padStart(width, '0');
        const data1 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        const data2 = bytes[4] | (bytes[5] << 8);
        const data3 = bytes[6] | (bytes[7] << 8);
        const tail = [...bytes.slice(8)].map(byte=>hex(byte, 2)).join('');
        return `{${hex(data1, 8)}-${hex(data2, 4)}-${hex(data3, 4)}-`
            + `${tail.slice(0, 4)}-${tail.slice(4)}}`;
    }

    return {
        /**
         * @param {any} object
         * @param {string} interfaceId
         * @returns {number} the interface pointer, or 0 if the object has no such interface
         */
        publish(object, interfaceId){
            const record = object.interfaceFor(interfaceId);
            return record ? publish(object, interfaceId, record.methods) : 0;
        },

        diagnostics: ()=>({ comInterfaces: interfaces, comMethods: methods }),
    };
}
