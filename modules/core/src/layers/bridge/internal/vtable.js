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
 * What a method that runs in the guest is built with: its own trap to fall
 * back to, and the means to register more.
 *
 * @typedef {Object} GuestSlotBuilder
 * @property {number} trap
 * @property {(name: string, fn: any) => number} register
 */

/**
 * @typedef {Object} InterfaceMethod
 * @property {string} name
 * @property {number} argBytes            Counting the interface pointer.
 * @property {Function} [invoke]          Called as (object, args) with `this` removed.
 * @property {(builder: GuestSlotBuilder) => number} [guest]
 *           Guest code for the slot instead of a trap: given the method's own
 *           trap to fall back to, answers the address the slot should hold.
 * @property {string} [builtin]           IUnknown's three, which we implement here.
 */

/**
 * @param {Object} deps
 * @param {any} deps.memory
 * @param {(name: string, fn: any) => number} deps.register  Bridge registration.
 * @param {{ allocate: (bytes: number) => number, free?: (address: number) => void }} deps.heap
 */
export function createVtables({ memory, register, heap }){
    /** One entry per object; inside it, one interface pointer per interface. */
    const published = new WeakMap();
    /**
     * One table of stubs per interface description, shared by every object
     * that exposes it -- as a compiled program shares one vtable among all
     * instances of a class. A table per object was a stub per method per
     * object, and the table stubs come out of holds sixteen thousand: a
     * program that made a thousand textures had used them all, every later
     * texture was refused as out of video memory, and the program made the
     * same texture again on every frame until the machine was out of memory
     * for real.
     *
     * Keyed by the method list's identity: two object models describing the
     * same interface id with different lists get two tables.
     *
     * @type {WeakMap<InterfaceMethod[], number>}
     */
    const tables = new WeakMap();
    /**
     * Which object an interface pointer belongs to. A shared stub is called
     * through many pointers, and the pointer is the first argument of every
     * COM method, so this is where the call finds its object.
     *
     * @type {Map<number, { object: any, interfaceId: string }>}
     */
    const owners = new Map();
    let interfaces = 0;
    let methods = 0;
    let refused = 0;
    /** @type {string | null} */
    let refusedBecause = null;

    /**
     * The shared table for one interface description, built on first use.
     *
     * @param {string} interfaceId
     * @param {InterfaceMethod[]} table
     * @returns {number} the table's address, or 0 if it could not be built
     */
    function sharedTable(interfaceId, table){
        const already = tables.get(table);
        if (already !== undefined)
        {
            return already;
        }
        /** @type {number[]} */
        let slots;
        try
        {
            slots = table.map((method, index)=>{
                // The arguments after the interface pointer, in an array the
                // method keeps between calls: made once, not per call. An
                // implementation that answers with a promise still holds it
                // when the next call comes, so that call gets a new one.
                /** @type {number[]} */
                let rest = new Array((method.argBytes >>> 2) - 1);
                const trap = register(`${interfaceId}::${method.name}`, {
                    convention: Convention.STDCALL,
                    argBytes: method.argBytes,
                    // An HRESULT is the whole answer; nothing here sets the
                    // thread's error, so the trace need not read it.
                    lastError: false,
                    /** @param {number[]} args */
                    handler: args=>{
                        // The first argument is the interface pointer the guest
                        // called through, not the object. What it identifies is
                        // settled here so no implementation has to know how an
                        // interface is laid out.
                        const owner = owners.get(args[0] >>> 0);
                        if (!owner)
                        {
                            // A pointer nobody published, or one whose object
                            // was released: E_POINTER, rather than a call on
                            // whatever the memory now holds.
                            return 0x80004003;
                        }
                        const given = rest;
                        for (let i = 1; i < args.length; i++)
                        {
                            given[i - 1] = args[i];
                        }
                        const answer = dispatch(
                            owner.object, owner.interfaceId, index, method, given);
                        if (typeof answer?.then === 'function')
                        {
                            rest = new Array(given.length);
                        }
                        return answer;
                    },
                });
                // A method that runs in the guest keeps its trap: that is
                // what its code falls back to for the cases it does not take.
                return method.guest ? method.guest({ trap, register }) : trap;
            });
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
        const vtable = heap.allocate(slots.length * WORD);
        if (vtable === 0)
        {
            refused++;
            refusedBecause = 'no room in the arena for a table';
            return 0;
        }
        slots.forEach((address, index)=>memory.writeU32(vtable + index * WORD, address));
        methods += slots.length;
        tables.set(table, vtable);
        return vtable;
    }

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
        const vtable = sharedTable(interfaceId, table);
        if (vtable === 0)
        {
            return 0;
        }

        // The word pointing at the table and the object's state word,
        // allocated together: they have the same lifetime and nothing else
        // may sit between them. The state word is where a method that runs
        // in the guest finds the memory it works on, one word past `this`;
        // a program sees only the vtable pointer and assumes nothing after it.
        const block = heap.allocate(2 * WORD);
        if (block === 0)
        {
            // Nothing left in the arena. Carrying on writes the pointer over
            // guest address zero, remembers the zero so every later publish of
            // this interface answers it without trying again, and hands the
            // program a null pointer with a success code -- three lies from one
            // unchecked allocation. Refusing is the answer a caller can act on.
            refused++;
            refusedBecause = 'no room in the arena for an interface';
            return 0;
        }
        memory.writeU32(block, vtable);
        memory.writeU32(block + WORD, (object.guestState?.() ?? 0) >>> 0);
        owners.set(block, { object, interfaceId });
        byInterface.set(interfaceId, block);
        interfaces++;
        return block;
    }

    /**
     * Forgets an interface pointer whose object let go of its last reference:
     * the pointer stops finding the object, and its two words go back. Kept
     * per interface rather than per object, because an object model that
     * counts references per interface generation can end one while another
     * is still held.
     *
     * @param {any} object
     * @param {string} interfaceId
     */
    function forget(object, interfaceId){
        const byInterface = published.get(object);
        const block = byInterface?.get(interfaceId);
        if (block === undefined)
        {
            return;
        }
        byInterface.delete(interfaceId);
        owners.delete(block);
        heap.free?.(block);
        interfaces--;
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
            case 'release': {
                const left = object.release(interfaceId);
                if (left === 0)
                {
                    forget(object, interfaceId);
                }
                return left;
            }
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
