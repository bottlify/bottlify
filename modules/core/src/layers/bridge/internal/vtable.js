/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { isDriven } from './drive.js';
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
 * @property {(call: number[]) => number | undefined} [inPlace]
 *           What a call the host makes to the slot from driven steps is
 *           answered with in place, with no entry into the guest
 *           (`answerInPlace`): the slot's own work done by the host -- a
 *           device's setter's record written into its command ring -- or
 *           undefined, for a call the slot's code is to make itself.
 * @property {string} [builtin]           IUnknown's three, which we implement here.
 */

/**
 * IUnknown's AddRef and Release in the guest, for an object whose count is
 * kept in a word of guest memory -- the third word of the interface's block,
 * zero for one whose count is the host's. A reference taken or given back
 * that is not a zero crossing changes only the word: the first reference and
 * the last are the object's own business (what it holds, what it gives back),
 * and those come to the host through the method's trap, as everything does
 * when there is no word. The word is changed with `lock cmpxchg`, so a slice
 * that ends inside the routine leaves nothing half-done for another thread.
 *
 *     AddRef(this)                       Release(this)
 *     mov ecx, [esp+4]                   mov ecx, [esp+4]
 *     mov ecx, [ecx+8]                   mov ecx, [ecx+8]
 *     test ecx, ecx                      test ecx, ecx
 *     jz host                            jz host
 *   again:                             again:
 *     mov eax, [ecx]                     mov eax, [ecx]
 *     test eax, eax                      cmp eax, 2
 *     jz host                            jb host
 *     lea edx, [eax+1]                   lea edx, [eax-1]
 *     lock cmpxchg [ecx], edx            lock cmpxchg [ecx], edx
 *     jne again                          jne again
 *     mov eax, edx                       mov eax, edx
 *     ret 4                              ret 4
 *   host:                              host:
 *     jmp trap                           jmp trap
 */
const COUNT_CODE = {
    addRef: [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x08, 0x85, 0xc9, 0x74, 0x14,
        0x8b, 0x01, 0x85, 0xc0, 0x74, 0x0e, 0x8d, 0x50, 0x01, 0xf0, 0x0f, 0xb1, 0x11, 0x75, 0xf1,
        0x89, 0xd0, 0xc2, 0x04, 0x00],
    release: [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x08, 0x85, 0xc9, 0x74, 0x15,
        0x8b, 0x01, 0x83, 0xf8, 0x02, 0x72, 0x0e, 0x8d, 0x50, 0xff, 0xf0, 0x0f, 0xb1, 0x11,
        0x75, 0xf0, 0x89, 0xd0, 0xc2, 0x04, 0x00],
};

/**
 * @param {Object} deps
 * @param {any} deps.memory
 * @param {(name: string, fn: any) => number} deps.register  Bridge registration.
 * @param {{ allocate: (bytes: number) => number, free?: (address: number) => void,
 *           allocateCode?: (bytes: number) => number }} deps.heap
 *        `allocateCode`, where it is given, places IUnknown's count routines.
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
     * Keyed by the method list's identity, and then by its shape: an object
     * model that builds a fresh list for every object -- ole32 does, for
     * every stream an installer writes its log through -- would otherwise
     * take a table per object, and the stubs are never given back.
     *
     * @type {WeakMap<InterfaceMethod[], number>}
     */
    const tables = new WeakMap();
    /**
     * The same tables by shape: the interface and, slot by slot, what its
     * stub is built from -- the arguments it pops and which of IUnknown's
     * three it is. Two lists of one shape can share stubs, because a stub
     * runs the method of the object it was called through (`owners`), not
     * the method of the list it was built for. A list with a method that
     * runs in the guest carries code of its own and has no shape.
     *
     * @type {Map<string, number>}
     */
    const byShape = new Map();

    /**
     * @param {string} interfaceId @param {InterfaceMethod[]} table
     * @returns {string | null}
     */
    const shapeOf = (interfaceId, table)=>(table.some(method=>method.guest)
        ? null
        : `${interfaceId}|${table.map(method=>`${method.argBytes}:${method.builtin ?? ''}`)
            .join(',')}`);
    /**
     * Which object an interface pointer belongs to, and that object's own
     * methods for it. A shared stub is called through many pointers, and the
     * pointer is the first argument of every COM method, so this is where the
     * call finds its object and what to run on it.
     *
     * @type {Map<number, { object: any, interfaceId: string, methods: InterfaceMethod[] }>}
     */
    const owners = new Map();
    /**
     * Interfaces whose object's count reached zero while it could still be
     * reached: something besides the program keeps it, as a DirectSound
     * device keeps its primary buffer, and a program may call it again
     * through the same pointer. An object model says so with an optional
     * `reachable(interfaceId)`, which answers yes while its count is above
     * zero too. Asked again after every release, whoever's, and forgotten once
     * the answer is no.
     *
     * @type {Map<any, Set<string>>}
     */
    const heldAtZero = new Map();
    /**
     * The slots whose calls can be answered in place (`inPlace`), by the
     * slot's address: its code's, or its trap's.
     *
     * @type {Map<number, (call: number[]) => number | undefined>}
     */
    const inPlace = new Map();
    let interfaces = 0;
    let methods = 0;
    let refused = 0;
    /** @type {string | null} */
    let refusedBecause = null;

    /**
     * AddRef or Release in the guest (`COUNT_CODE`), falling back on `trap`;
     * the trap itself where there is nowhere to put code.
     *
     * @param {'addRef' | 'release'} which @param {number} trap
     */
    function countRoutine(which, trap){
        const code = COUNT_CODE[which];
        const at = heap.allocateCode?.(code.length + 5) ?? 0;
        if (at === 0)
        {
            return trap;
        }
        const end = at + code.length + 5;
        memory.writeBytes(at, Uint8Array.of(...code, 0xe9, 0, 0, 0, 0));
        memory.writeU32(end - 4, (trap - end) >>> 0);
        return at;
    }

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
        const shape = shapeOf(interfaceId, table);
        const shared = shape === null ? undefined : byShape.get(shape);
        if (shared !== undefined)
        {
            tables.set(table, shared);
            return shared;
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
                const fn = {
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
                            // whatever the memory now holds -- except from
                            // AddRef and Release, whose answer is a count: no
                            // references, as DirectDraw's clipper answers
                            // through a released pointer or 0xdeadbeef.
                            return method.builtin === 'addRef' || method.builtin === 'release'
                                ? 0
                                : 0x80004003;
                        }
                        const given = rest;
                        for (let i = 1; i < args.length; i++)
                        {
                            given[i - 1] = args[i];
                        }
                        const answer = dispatch(owner.object, owner.interfaceId, index,
                            owner.methods[index] ?? method, given);
                        if (typeof answer?.then === 'function')
                        {
                            rest = new Array(given.length);
                        }
                        return answer;
                    },
                };
                const trap = register(`${interfaceId}::${method.name}`, fn);
                // A method that runs in the guest keeps its trap: that is
                // what its code falls back to for the cases it does not take.
                if (method.guest)
                {
                    const at = method.guest({ trap, register });
                    if (method.inPlace)
                    {
                        inPlace.set(at, method.inPlace);
                    }
                    return at;
                }
                if (method.inPlace)
                {
                    inPlace.set(trap, method.inPlace);
                }
                return method.builtin === 'addRef' || method.builtin === 'release'
                    ? countRoutine(method.builtin, trap)
                    : trap;
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
        if (shape !== null)
        {
            byShape.set(shape, vtable);
        }
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

        // The word pointing at the table, the object's state word and where
        // its count is kept, allocated together: they have the same lifetime
        // and nothing else may sit between them. The state word is where a
        // method that runs in the guest finds the memory it works on, one
        // word past `this`, and the count's the guest's AddRef and Release
        // (`COUNT_CODE`); a program sees only the vtable pointer and assumes
        // nothing after it.
        const block = heap.allocate(3 * WORD);
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
        memory.writeU32(block + 2 * WORD, (object.countCell?.() ?? 0) >>> 0);
        owners.set(block, { object, interfaceId, methods: table });
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
     * The object is told, through an optional `forgotten(pointer,
     * interfaceId)`, so that a map it keeps from pointers back to objects
     * drops the entry now: the words may hold another object's interface by
     * the next call that hands the pointer in.
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
        heldAtZero.get(object)?.delete(interfaceId);
        object.forgotten?.(block, interfaceId);
    }

    /**
     * The last reference to an interface went. Forgotten, unless its object
     * says it can still be reached; and every interface kept that way before
     * is asked again, because whatever kept it may be what was released.
     *
     * An object model that knows the object itself is over says so with
     * `destroyed`, and then every interface it was published as goes the
     * same way: a pointer from an earlier QueryInterface would otherwise
     * keep finding the released object, and its words would never go back.
     * Without that word a zero ends only the interface it came through,
     * which is true of every way of counting -- DirectDraw counts each
     * generation apart, and one reaching zero leaves the others held.
     *
     * @param {any} object @param {string} interfaceId
     */
    function releasedToZero(object, interfaceId){
        const ended = object.destroyed === true
            ? [...published.get(object)?.keys() ?? []]
            : [interfaceId];
        for (const id of ended)
        {
            if (object.reachable?.(id))
            {
                const ids = heldAtZero.get(object) ?? new Set();
                ids.add(id);
                heldAtZero.set(object, ids);
            }
            else
            {
                forget(object, id);
            }
        }
    }

    function sweepHeld(){
        for (const [object, ids] of heldAtZero)
        {
            for (const id of ids)
            {
                if (!object.reachable(id))
                {
                    forget(object, id);
                }
            }
            if (ids.size === 0)
            {
                heldAtZero.delete(object);
            }
        }
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
                // The last reference of an object that owes the program calls as
                // it goes: those are made, and waited for, before it goes.
                const owed = object.refCount === 1 && object.lastRelease
                    ? object.lastRelease()
                    : undefined;
                return typeof owed?.then === 'function'
                    ? owed.then(()=>release(object, interfaceId))
                    : release(object, interfaceId);
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
                // settles, or with steps the bridge runs. Coercing either here
                // would hand the guest a zero -- which is S_OK -- while the
                // work it was waiting for had not started.
                return thenableOrDword(method.invoke(object, args));
        }
    }

    /** @param {any} object @param {string} interfaceId */
    function release(object, interfaceId){
        const left = object.release(interfaceId);
        if (left === 0)
        {
            releasedToZero(object, interfaceId);
        }
        if (heldAtZero.size > 0)
        {
            sweepHeld();
        }
        return left;
    }

    /**
     * A result on its way to the guest: a dword, or a promise the dispatcher
     * will park the caller on until it settles.
     *
     * @param {any} answer
     */
    const thenableOrDword = answer=>(
        typeof answer?.then === 'function' || isDriven(answer) ? answer : answer | 0);

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
        // No interface named at all: refused as DirectDraw refuses it (Wine's
        // ddraw test_surface_qi), rather than a GUID read out of address zero.
        // A runtime that answers E_POINTER and leaves the pointer alone says
        // so (DirectInput: Wine's dinput test_QueryInterface).
        if ((riid >>> 0) === 0)
        {
            if (object.nullInterface === 'pointer')
            {
                return E_POINTER;
            }
            memory.writeU32(ppv >>> 0, 0);
            return 0x80070057; // E_INVALIDARG
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

        const pointer = publish(object, record.sharedWith ?? wanted, record.methods);
        if (pointer === 0)
        {
            // There is nowhere to put the interface, so there is no interface.
            // Writing the zero and answering S_OK is how a program comes to
            // call a method through a pointer it was told was good.
            return 0x8007000e; // E_OUTOFMEMORY
        }
        // The reference belongs to the interface the caller asked for, not to
        // the one it asked through.
        object.addRef(record.sharedWith ?? wanted);
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
         * A call to a slot answered in place (`inPlace`): its number, or
         * undefined for a call that is not answered so -- which then goes
         * into the guest as it is.
         *
         * @param {number} entry  the slot's address @param {number[]} args  `this` first
         * @returns {number | undefined}
         */
        answerInPlace(entry, args){
            return inPlace.get(entry >>> 0)?.(args);
        },

        /**
         * @param {any} object
         * @param {string} interfaceId
         * @returns {number} the interface pointer, or 0 if the object has no such interface
         */
        publish(object, interfaceId){
            const record = object.interfaceFor(interfaceId);
            // An interface answered with another's pointer -- a table that
            // holds the other's and more, as IDirectInput7A holds
            // IDirectInputA's -- is that pointer, so COM identity sees one.
            return record
                ? publish(object, record.sharedWith ?? interfaceId, record.methods)
                : 0;
        },

        /**
         * Gives back an interface the program cannot release: one whose table
         * has no IUnknown, which ends when the object that handed it out
         * ends. Forgotten as a release to zero forgets it -- the pointer then
         * finds nothing, its words go back and its object is told.
         *
         * @param {any} object
         * @param {string} interfaceId
         * @returns {boolean} whether it was published
         */
        unpublish(object, interfaceId){
            if (published.get(object)?.get(interfaceId) === undefined)
            {
                return false;
            }
            forget(object, interfaceId);
            return true;
        },

        /**
         * The object behind an interface pointer this engine published.
         *
         * A layer that has to act on a pointer a program passes back -- a
         * performance asked to play the segment whose pointer a class factory
         * handed out -- has no other way to find it, because the words at the
         * pointer are only the vtable and the owner is the bridge's own
         * bookkeeping.
         *
         * @param {number} pointer
         * @returns {any} the object, or null for a pointer not published here
         */
        objectAt(pointer){
            const owner = owners.get(pointer >>> 0);
            return owner ? owner.object : null;
        },

        diagnostics: ()=>({
            comInterfaces: interfaces,
            comMethods: methods,
            comInterfacesRefused: refused,
            comRefusedBecause: refusedBecause,
        }),
    };
}
