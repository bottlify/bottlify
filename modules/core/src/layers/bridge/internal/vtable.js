/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * the table are stubs and the calls through them are stdcall, both of which
 * this layer already knows how to build.
 *
 * **Not thiscall.** A COM method is declared STDMETHODCALLTYPE, which is
 * `__stdcall`, and the interface pointer arrives as the first argument on the
 * stack rather than in ECX -- which is exactly what makes the C bindings,
 * `p->lpVtbl->Method(p, ...)`, binary-compatible with the C++ call. The name
 * "this" invites the other reading and the other reading is wrong: it would
 * take a register the caller never set, shift every argument by one position,
 * and pop four bytes too few on return, corrupting the caller's stack on every
 * COM call in the engine. Read against real compiled binaries: the compiler
 * pushes the interface pointer even when it already has it in ECX.
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
 * @property {number} argBytes            Counting the interface pointer.
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
    let refused = 0;
    /** @type {string | null} */
    let refusedBecause = null;

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

        /** @type {number[]} */
        let slots;
        try
        {
            slots = table.map((method, index)=>register(
                `${interfaceId}::${method.name}`,
                {
                    convention: Convention.STDCALL,
                    argBytes: method.argBytes,
                    /** @param {number[]} args */
                    handler: args=>{
                        // The first argument is the interface pointer the guest
                        // called through, not the object. What it identifies is
                        // settled here so no implementation has to know how an
                        // interface is laid out.
                        const [, ...rest] = args;
                        return dispatch(object, interfaceId, index, method, rest);
                    },
                }));
        }
        catch (e){
            // A method needs a stub the guest can call, and the table stubs
            // come out of is finite. There is nowhere else to put one, so this
            // is the heap case again: no interface, and a refusal the caller
            // reports. Raising instead would end the process at a call the
            // program is entitled to see fail. Counted rather than swallowed --
            // a build that starts refusing interfaces has to say so somewhere.
            refused++;
            refusedBecause = e instanceof Error ? e.message : String(e);
            return 0;
        }
        methods += slots.length;

        // The vtable and the one word pointing at it, allocated together: they
        // have the same lifetime and nothing else may sit between them.
        const block = heap.allocate(WORD + slots.length * WORD);
        if (block === 0)
        {
            // Nothing left in the arena. Carrying on writes the table over
            // guest address zero, remembers the zero so every later publish of
            // this interface answers it without trying again, and hands the
            // program a null pointer with a success code -- three lies from one
            // unchecked allocation. Refusing is the answer a caller can act on.
            return 0;
        }
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
            // Which interface the call came through is passed on, because not
            // every object model counts references per object. DirectDraw
            // counts them per interface generation -- four QueryInterface calls
            // leave four counts of one -- and an object told only "somebody
            // added a reference" cannot honour that. An implementation that
            // counts per object ignores the argument and is unaffected.
            case 'addRef':
                return object.addRef(interfaceId);
            case 'release':
                return object.release(interfaceId);
            default:
                if (!method.invoke)
                {
                    // E_NOTIMPL: a method that exists in the table and does
                    // nothing is better than a hole a program jumps into.
                    return 0x80004001;
                }
                // A method that has to call back into guest code answers with a
                // promise, and the dispatcher parks the caller until it
                // settles. Coercing it here would hand the guest a zero --
                // which is S_OK -- while the work it was waiting for had not
                // started.
                return thenableOrDword(method.invoke(object, args));
        }
    }

    /**
     * A result on its way to the guest: a dword, or a promise the dispatcher
     * will park the caller on until it settles.
     *
     * @param {any} answer
     */
    const thenableOrDword = answer=>(
        typeof answer?.then === 'function' ? answer : answer | 0);

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
        if (pointer === 0)
        {
            // There is nowhere to put the interface, so there is no interface.
            // Writing the zero and answering S_OK is how a program comes to
            // call a method through a pointer it was told was good.
            return 0x8007000e; // E_OUTOFMEMORY
        }
        // The reference belongs to the interface the caller asked for, not to
        // the one it asked through.
        object.addRef(wanted);
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

        diagnostics: ()=>({
            comInterfaces: interfaces,
            comMethods: methods,
            comInterfacesRefused: refused,
            comRefusedBecause: refusedBecause,
        }),
    };
}
