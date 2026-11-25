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

/**
 * A pointer is four bytes in a 32-bit process, and so is every vtable slot;
 * eight in a 64-bit one, whose interface's first word, its table's slots and
 * the pointer QueryInterface writes are all eight bytes (the high half zero:
 * every address the engine hands out lies below 4 GiB).
 */
const WORD = 4;
const LONG_WORD = 8;

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
 * @property {((builder: GuestSlotBuilder) => number) & { wide?: boolean }} [guest]
 *           Guest code for the slot instead of a trap: given the method's own
 *           trap to fall back to, answers the address the slot should hold.
 *           i386 code unless the builder says it is `wide`: one that builds
 *           its code for the process's width, which a 64-bit process takes too.
 * @property {(call: number[]) => number | undefined} [inPlace]
 *           What a call the host makes to the slot from driven steps is
 *           answered with in place, with no entry into the guest
 *           (`answerInPlace`): the slot's own work done by the host -- a
 *           device's setter's record written into its command ring -- or
 *           undefined, for a call the slot's code is to make itself.
 * @property {string} [builtin]           IUnknown's three, which we implement here.
 * @property {number} [stranger]
 *           What a call through a pointer nobody published answers, where the
 *           runtime has its own word for it; E_POINTER otherwise.
 * @property {boolean} [checksTable]
 *           A Release that answers 0 and keeps the count when the word at the
 *           pointer is not this interface's table: DirectDraw's clipper takes
 *           every call through a pointer whose table was overwritten except
 *           that one (ddraw test_clipper_refcount).
 * @property {Record<number, 'f32' | 'f64'>} [floats]
 *           The float and double arguments, by their first dword counting the
 *           interface pointer, which a 64-bit caller passes among its first
 *           four in XMM registers (the bridge's `floats`).
 * @property {number[]} [quadwords]
 *           The arguments the 32-bit signature counts as two dwords -- a
 *           REFERENCE_TIME, a LARGE_INTEGER, a POINT by value -- by their first
 *           dword counting the interface pointer: a 64-bit caller passes each
 *           in one slot, and the method still reads the two dwords (the
 *           bridge's `quadwords`).
 * @property {Record<number, number>} [structs]
 *           The structures wider than eight bytes passed by value -- a GUID, a
 *           VARIANT -- by their first dword counting the interface pointer and
 *           their size in dwords: a 64-bit caller passes a pointer to a copy
 *           (the bridge's `structs`).
 * @property {string} [returns]  The answer is an address: zero-extended into a
 *           64-bit caller's RAX (`HostFunction.returns`).
 * @property {number[]} [addresses]  The dwords, counting the interface pointer,
 *           that carry an address the method takes whole from a 64-bit caller
 *           (`HostFunction.addresses`).
 */

/**
 * IUnknown's AddRef and Release in the guest, for an object whose count is
 * kept in a word of guest memory -- the third word of the interface's block,
 * zero for one whose count is the host's. A reference taken or given back
 * that is not a zero crossing changes only the word: the first reference and
 * the last are the object's own business (what it holds, what it gives back),
 * and those come to the host through the method's trap, as everything does
 * when there is no word -- unless the object names an owner, the fourth word
 * (`ownerCell`): a resource its device owns, whose crossings do nothing but
 * take a reference on the owner and give it back, which the routine does with
 * the owner's word. An owner at its last reference is the host's to let go.
 * Every word is changed with `lock cmpxchg`, and the owner's moved before the
 * count's and moved back if the count's move fails, so a slice that ends
 * inside the routine leaves nothing half-done for another thread, and a
 * crossing moves the owner once whoever made it (`ReferenceCount.owner`).
 *
 *     AddRef(this)                       Release(this)
 *     mov ecx, [esp+4]                   mov ecx, [esp+4]
 *     mov ecx, [ecx+8]                   mov ecx, [ecx+8]
 *     test ecx, ecx                      test ecx, ecx
 *     jz host                            jz host
 *   again:                             again:
 *     mov eax, [ecx]                     mov eax, [ecx]
 *     test eax, eax                      cmp eax, 2
 *     jz first                           jb low
 *     lea edx, [eax+1]                   lea edx, [eax-1]
 *     lock cmpxchg [ecx], edx            lock cmpxchg [ecx], edx
 *     jne again                          jne again
 *     mov eax, edx                       mov eax, edx
 *     ret 4                              ret 4
 *   first:                             low:
 *     mov edx, [esp+4]                   test eax, eax
 *     mov edx, [edx+12]  ; owner         jz host
 *     test edx, edx                      mov edx, [esp+4]
 *     jz host                            mov edx, [edx+12]   ; owner
 *     cmp dword [edx], 0                 test edx, edx
 *     je host                            jz host
 *     lock inc dword [edx]               push ebx
 *     lea edx, [eax+1]                 take:
 *     lock cmpxchg [ecx], edx            mov eax, [edx]
 *     je took                            cmp eax, 2
 *     mov edx, [esp+4]                   jb busy            ; its last
 *     mov edx, [edx+12]                  lea ebx, [eax-1]
 *     lock dec dword [edx]               lock cmpxchg [edx], ebx
 *     jmp again                          jne take
 *   took:                                mov eax, 1
 *     mov eax, 1                         xor ebx, ebx
 *     ret 4                              lock cmpxchg [ecx], ebx
 *   host:                                jne undo
 *     jmp trap                           pop ebx
 *                                        xor eax, eax
 *                                        ret 4
 *                                      undo:
 *                                        lock inc dword [edx]
 *                                        pop ebx
 *                                        jmp again
 *                                      busy:
 *                                        pop ebx
 *                                      host:
 *                                        jmp trap
 */
const COUNT_CODE = {
    addRef: [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x08, 0x85, 0xc9, 0x74, 0x44, 0x8b, 0x01,
        0x85, 0xc0, 0x74, 0x0e, 0x8d, 0x50, 0x01, 0xf0, 0x0f, 0xb1, 0x11, 0x75, 0xf1, 0x89,
        0xd0, 0xc2, 0x04, 0x00, 0x8b, 0x54, 0x24, 0x04, 0x8b, 0x52, 0x0c, 0x85, 0xd2, 0x74,
        0x25, 0x83, 0x3a, 0x00, 0x74, 0x20, 0xf0, 0xff, 0x02, 0x8d, 0x50, 0x01, 0xf0, 0x0f,
        0xb1, 0x11, 0x74, 0x0c, 0x8b, 0x54, 0x24, 0x04, 0x8b, 0x52, 0x0c, 0xf0, 0xff, 0x0a,
        0xeb, 0xc4, 0xb8, 0x01, 0x00, 0x00, 0x00, 0xc2, 0x04, 0x00],
    release: [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x08, 0x85, 0xc9, 0x74, 0x4f, 0x8b, 0x01,
        0x83, 0xf8, 0x02, 0x72, 0x0e, 0x8d, 0x50, 0xff, 0xf0, 0x0f, 0xb1, 0x11, 0x75, 0xf0,
        0x89, 0xd0, 0xc2, 0x04, 0x00, 0x85, 0xc0, 0x74, 0x36, 0x8b, 0x54, 0x24, 0x04, 0x8b,
        0x52, 0x0c, 0x85, 0xd2, 0x74, 0x2b, 0x53, 0x8b, 0x02, 0x83, 0xf8, 0x02, 0x72, 0x22,
        0x8d, 0x58, 0xff, 0xf0, 0x0f, 0xb1, 0x1a, 0x75, 0xf0, 0xb8, 0x01, 0x00, 0x00, 0x00,
        0x31, 0xdb, 0xf0, 0x0f, 0xb1, 0x19, 0x75, 0x06, 0x5b, 0x31, 0xc0, 0xc2, 0x04, 0x00,
        0xf0, 0xff, 0x02, 0x5b, 0xeb, 0xb2, 0x5b],
};

/**
 * The same in a 64-bit process, where `this` comes in RCX and the interface is
 * four quadwords, the count's word at [this+16] and the owner's at [this+24].
 * RCX and RSP are left as they came, so the slow way reaches the trap with the
 * call as it was made; the work is done in RAX, R8 to R11, which the
 * convention lets a callee change and the trap's stub does not read for a call
 * of one argument.
 *
 *     AddRef(this)                       Release(this)
 *     mov r10, [rcx+16]                  mov r10, [rcx+16]
 *     test r10, r10                      test r10, r10
 *     jz host                            jz host
 *   again:                             again:
 *     mov eax, [r10]                     mov eax, [r10]
 *     test eax, eax                      cmp eax, 2
 *     jz first                           jb low
 *     lea r11d, [rax+1]                  lea r11d, [rax-1]
 *     lock cmpxchg [r10], r11d           lock cmpxchg [r10], r11d
 *     jne again                          jne again
 *     mov eax, r11d                      mov eax, r11d
 *     ret                                ret
 *   first:                             low:
 *     mov r8, [rcx+24]                   test eax, eax
 *     test r8, r8                        jz host
 *     jz host                            mov r8, [rcx+24]
 *     cmp dword [r8], 0                  test r8, r8
 *     je host                            jz host
 *     lock inc dword [r8]              take:
 *     lea r11d, [rax+1]                  mov eax, [r8]
 *     lock cmpxchg [r10], r11d           cmp eax, 2
 *     je took                            jb host
 *     lock dec dword [r8]                lea r9d, [rax-1]
 *     jmp again                          lock cmpxchg [r8], r9d
 *   took:                                jne take
 *     mov eax, 1                         mov eax, 1
 *     ret                                xor r9d, r9d
 *   host:                                lock cmpxchg [r10], r9d
 *     jmp trap                           jne undo
 *                                        xor eax, eax
 *                                        ret
 *                                      undo:
 *                                        lock inc dword [r8]
 *                                        jmp again
 *                                      host:
 *                                        jmp trap
 */
const COUNT_CODE_64 = {
    addRef: [0x4c, 0x8b, 0x51, 0x10, 0x4d, 0x85, 0xd2, 0x74, 0x40, 0x41, 0x8b, 0x02, 0x85,
        0xc0, 0x74, 0x0f, 0x44, 0x8d, 0x58, 0x01, 0xf0, 0x45, 0x0f, 0xb1, 0x1a, 0x75, 0xee,
        0x44, 0x89, 0xd8, 0xc3, 0x4c, 0x8b, 0x41, 0x18, 0x4d, 0x85, 0xc0, 0x74, 0x21, 0x41,
        0x83, 0x38, 0x00, 0x74, 0x1b, 0xf0, 0x41, 0xff, 0x00, 0x44, 0x8d, 0x58, 0x01, 0xf0,
        0x45, 0x0f, 0xb1, 0x1a, 0x74, 0x06, 0xf0, 0x41, 0xff, 0x08, 0xeb, 0xc6, 0xb8, 0x01,
        0x00, 0x00, 0x00, 0xc3],
    release: [0x4c, 0x8b, 0x51, 0x10, 0x4d, 0x85, 0xd2, 0x74, 0x4f, 0x41, 0x8b, 0x02, 0x83,
        0xf8, 0x02, 0x72, 0x0f, 0x44, 0x8d, 0x58, 0xff, 0xf0, 0x45, 0x0f, 0xb1, 0x1a, 0x75,
        0xed, 0x44, 0x89, 0xd8, 0xc3, 0x85, 0xc0, 0x74, 0x34, 0x4c, 0x8b, 0x41, 0x18, 0x4d,
        0x85, 0xc0, 0x74, 0x2b, 0x41, 0x8b, 0x00, 0x83, 0xf8, 0x02, 0x72, 0x23, 0x44, 0x8d,
        0x48, 0xff, 0xf0, 0x45, 0x0f, 0xb1, 0x08, 0x75, 0xed, 0xb8, 0x01, 0x00, 0x00, 0x00,
        0x45, 0x31, 0xc9, 0xf0, 0x45, 0x0f, 0xb1, 0x0a, 0x75, 0x03, 0x31, 0xc0, 0xc3, 0xf0,
        0x41, 0xff, 0x00, 0xeb, 0xb1],
};

/** Each byte as two upper-case hex digits, as a GUID's text spells it. */
const BYTE_HEX = Array.from({ length: 256 }, (unused, byte)=>
    byte.toString(16).toUpperCase().padStart(2, '0'));

/**
 * @param {Object} deps
 * @param {any} deps.memory
 * @param {(name: string, fn: any) => number} deps.register  Bridge registration.
 * @param {{ allocate: (bytes: number) => number, free?: (address: number) => void,
 *           allocateCode?: (bytes: number) => number,
 *           allocateTable?: (bytes: number) => number }} deps.heap
 *        `allocateCode`, where it is given, places IUnknown's count routines;
 *        `allocateTable` the method tables, on pages of data rather than code.
 * @param {() => boolean} [deps.long]  Whether the process is a 64-bit one, asked
 *        when a table is laid out: its slots are eight bytes, its counts run
 *        in the guest as x86-64 (`COUNT_CODE_64`), and its methods that run in
 *        the guest are traps there unless built for its width (a `wide` guest
 *        builder).
 * @param {(label: string) => void} [deps.unimplemented]  told of a call to a method an
 *        interface has a slot for and no implementation of, which answers E_NOTIMPL
 */
export function createVtables({ memory, register, heap, long = ()=>false, unimplemented }){
    /** A pointer's width now, and a pointer written at it, whole (the memory layer's). */
    const wordSize = ()=>(long() ? LONG_WORD : WORD);
    /** @param {number} at @param {number} value */
    const writeWord = (at, value)=>memory.writePointer(at, value, wordSize());
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
     * stub is built from -- the arguments it pops, which are floats, and which
     * of IUnknown's three it is. Two lists of one shape can share stubs, because a stub
     * runs the method of the object it was called through (`owners`), not
     * the method of the list it was built for. A list with a method that
     * runs in the guest carries code of its own and has no shape.
     *
     * @type {Map<string, number>}
     */
    const byShape = new Map();

    /**
     * Whether a method's slot is guest code in this process: a 64-bit one
     * runs no i386, so only a builder that builds for its width.
     *
     * @param {InterfaceMethod} method
     */
    const runsInGuest = method=>Boolean(method.guest && (!long() || method.guest.wide));
    /**
     * @param {string} interfaceId @param {InterfaceMethod[]} table
     * @returns {string | null}
     */
    const shapeOf = (interfaceId, table)=>(table.some(method=>runsInGuest(method))
        ? null
        : `${interfaceId}|${table.map(method=>`${method.argBytes}:${method.builtin ?? ''}:${
            method.floats ? JSON.stringify(method.floats) : ''}:${
            method.quadwords ? method.quadwords.join('.') : ''}:${
            method.structs ? JSON.stringify(method.structs) : ''}:${
            method.returns ?? ''}:${
            method.addresses ? method.addresses.join('.') : ''}`).join(',')}`);
    /**
     * Which object an interface pointer belongs to, and that object's own
     * methods for it. A shared stub is called through many pointers, and the
     * pointer is the first argument of every COM method, so this is where the
     * call finds its object and what to run on it.
     *
     * @type {Map<number, { object: any, interfaceId: string, methods: InterfaceMethod[],
     *     vtable: number }>}
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
     * AddRef or Release in the guest (`COUNT_CODE`, `COUNT_CODE_64` in a 64-bit
     * process), falling back on `trap`; the trap itself where there is nowhere
     * to put code.
     *
     * @param {'addRef' | 'release'} which @param {number} trap
     */
    function countRoutine(which, trap){
        const code = (long() ? COUNT_CODE_64 : COUNT_CODE)[which];
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
                    ...method.floats ? { floats: method.floats } : {},
                    ...method.quadwords ? { quadwords: method.quadwords } : {},

                    ...method.structs ? { structs: method.structs } : {},
                    ...method.returns ? { returns: method.returns } : {},
                    ...method.addresses ? { addresses: method.addresses } : {},
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
                                : method.stranger ?? 0x80004003;
                        }
                        if (method.checksTable === true
                            && memory.readU32(args[0] >>> 0) !== owner.vtable)
                        {
                            return 0;
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
                if (method.guest && runsInGuest(method))
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
        const word = wordSize();
        const vtable = heap.allocateTable ? heap.allocateTable(slots.length * word)
            : heap.allocate(slots.length * word);
        if (vtable === 0)
        {
            refused++;
            refusedBecause = 'no room in the arena for a table';
            return 0;
        }
        slots.forEach((address, index)=>writeWord(vtable + index * word, address));
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
        const word = wordSize();
        const cell = (object.countCell?.() ?? 0) >>> 0;
        // An object whose documented layout goes on past the vtable pointer
        // (MFASYNCRESULT's fields after IMFAsyncResult's) asks for the bytes
        // it needs; they start zeroed and are the object's to write. One whose
        // count is the guest's has the owner's word too, which the count's
        // routines read at a crossing of zero.
        const words = Math.max(cell === 0 ? 3 : 4, Math.ceil((object.bodyBytes?.() ?? 0) / word));
        const block = heap.allocate(words * word);
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
        writeWord(block, vtable);
        writeWord(block + word, (object.guestState?.() ?? 0) >>> 0);
        writeWord(block + 2 * word, cell);
        for (let at = 3; at < words; at++)
        {
            writeWord(block + at * word, 0);
        }
        if (cell !== 0)
        {
            writeWord(block + 3 * word, (object.ownerCell?.() ?? 0) >>> 0);
        }
        owners.set(block, { object, interfaceId, methods: table, vtable });
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
                    // nothing is better than a hole a program jumps into, and
                    // the call is said, as a missing import is.
                    unimplemented?.(`${interfaceId}::${method.name}`);
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
        // What the objects that went owe the program -- their own calls into
        // it -- is made before it hears the answer.
        const owed = object.afterRelease?.();
        return typeof owed?.then === 'function' ? owed.then(()=>left) : left;
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
            writeWord(ppv >>> 0, 0);
            return 0x80070057; // E_INVALIDARG
        }

        const wanted = readGuid(riid >>> 0);
        // An object may answer QueryInterface for less than it is published
        // as (`queryFor`): an effect is handed out as ID3D10Effect and is
        // asked for it in vain.
        const record = object.queryFor ? object.queryFor(wanted) : object.interfaceFor(wanted);
        if (!record)
        {
            // Zeroed on failure: a program checks the pointer, not only the
            // result, and a stale value there is a pointer it will follow.
            // An object may refuse with a word of its own (DirectDraw's
            // older surfaces answer E_INVALIDARG: Wine's test_surface_qi).
            writeWord(ppv >>> 0, 0);
            return object.refusal?.(wanted) ?? E_NOINTERFACE;
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
        // the one it asked through: for an aggregated object's other faces that
        // is its controlling unknown's, a call into the program to wait for.
        writeWord(ppv >>> 0, pointer);
        const added = object.addRef(record.sharedWith ?? wanted);
        return typeof added?.then === 'function' ? added.then(()=>0) : 0; // S_OK
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
        /** @param {number} from @param {number} to  bytes, little-endian when `to < from` */
        const hex = (from, to)=>{
            let text = '';
            for (let at = from; at !== to; at += from < to ? 1 : -1)
            {
                text += BYTE_HEX[bytes[at]];
            }
            return text;
        };
        return `{${hex(3, -1)}-${hex(5, 3)}-${hex(7, 5)}-${hex(8, 10)}-${hex(10, 16)}}`;
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
