/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Guest-side call stubs: the only way host code gets called from the guest.
 *
 * An imported function's IAT slot points at one of these stubs. The stub raises
 * a trap on an I/O port carrying its id, the host handles it and leaves the
 * result in EAX, and the stub then returns like the real function would.
 *
 * What a stub *means* is not here: this layer emits x86 and reports which id
 * fired. The table of implementations belongs to the bridge, so a stub is
 * described by the only thing the machine needs to know about it -- how many
 * bytes it pops on return.
 */

/** Bytes each stub occupies; fixed so an id maps to an address arithmetically. */
export const STUB_SIZE = 16;

/**
 * Room for the table when nobody says otherwise. The module configures this
 * from the same number it reserves the guest region with; a table that believed
 * in more slots than the region holds would write stubs into whatever follows
 * it, which is the initial stack.
 */
export const DEFAULT_THUNK_CAPACITY = 16384 * STUB_SIZE;

/**
 * Emits one stub.
 *
 * EAX and EDX are clobbered on purpose: on stdcall and cdecl both are
 * caller-saved, and EAX is where the return value belongs anyway.
 *
 * @param {Object} options
 * @param {number} options.trapId
 * @param {number} options.port      I/O port the host listens on.
 * @param {number} options.popBytes  Stack bytes the callee pops; 0 when the caller cleans up.
 * @param {boolean} [options.preserveResult]  Keep whatever EAX held on entry, in ECX.
 * @param {number} [options.forwardTo]  Guest address to jump to instead of returning.
 * @param {number} [options.address]    Where this stub will live; needed to reach it.
 * @returns {Uint8Array}
 */
export function buildStub(
    { trapId, port, popBytes, preserveResult = false, forwardTo = 0, address = 0 })
{
    const u16 = (/** @type {number} */ v)=>[v & 0xff, v >>> 8 & 0xff];
    const u32 = (/** @type {number} */ v)=>[...u16(v), v >>> 16 & 0xff, v >>> 24 & 0xff];

    // A forwarding stub is a place to watch a call from, not a place to answer
    // it: it traps so the host can see the arguments and then jumps into the
    // real function, which returns straight to the original caller with the
    // stack exactly as that function expects it. Nothing else can see calls
    // between two guest modules, and by definition they are the calls a host
    // trace has no record of.
    const jump = forwardTo === 0
        ? []
        // The trap is 10 bytes and the jump 5, so the target is relative to the
        // byte after all fifteen.
        : [0xe9, ...u32(forwardTo - (address + (preserveResult ? 2 : 0) + 15))];

    const bytes = [
        // A stub reached by a `ret` is being handed a return value, and EAX is
        // both where that value is and where the trap id has to go. Moving it
        // aside first costs two bytes; ECX is caller-saved under every
        // convention here, so nothing was counting on it either.
        ...preserveResult ? [0x89, 0xc1] : [], // mov ecx, eax
        0x66, 0xba, ...u16(port), // mov dx, port
        0xb8, ...u32(trapId), //     mov eax, trapId
        0xef, //                     out dx, eax   -> host handles it, leaves the result in EAX
        ...jump.length > 0
            ? jump
            : popBytes > 0 ? [0xc2, ...u16(popBytes)] : [0xc3], // ret popBytes / ret
    ];
    if (bytes.length > STUB_SIZE)
    {
        throw new Error('stub does not fit its slot');
    }
    return new Uint8Array([...bytes, ...new Array(STUB_SIZE - bytes.length).fill(0xcc)]);
}

/**
 * A table of stubs laid out in guest memory.
 *
 * @param {Object} options
 * @param {number} options.base  Guest address of the first stub.
 * @param {number} options.port
 * @param {number} [options.capacity]  Bytes reserved for the table in the guest.
 */
export function createThunkTable({ base, port, capacity = DEFAULT_THUNK_CAPACITY }){
    const slots = Math.floor(capacity / STUB_SIZE);
    /**
     * @type {{
     *   id: number, name: string, popBytes: number,
     *   address: number, preserveResult?: boolean, forwardTo?: number,
     * }[]}
     */
    const entries = [];

    // Slot 0 is never dispatched: it holds the park loop. A handler that ends the
    // process cannot stop the emulator from inside its own trap callback — the
    // guest would still execute the stub's `ret` and return into whatever the
    // stack happened to hold. Instead the return address is redirected here, and
    // the machine is stopped from outside the callback. `hlt` rather than a tight
    // jump so a parked guest costs nothing while it waits.
    entries.push({ id: 0, name: '<park>', popBytes: 0, address: base });

    return {
        /** Address of the park loop: where a terminating call returns to. */
        get parkAddress(){
            return base;
        },

        /**
         * Takes a slot in the table and returns both ways of naming it: the id
         * the trap carries, and the address the guest calls.
         *
         * @param {string} name       For diagnostics: which import this is.
         * @param {number} popBytes   Stack bytes the callee pops.
         * @param {Object} [options]
         * @param {boolean} [options.preserveResult]
         * @param {number} [options.forwardTo]
         * @returns {{ id: number, address: number }}
         * @throws when the table is full: the slot after the last one is not in
         *         the region reserved for the table, and what follows it is the
         *         guest's initial stack. Handing back that address writes
         *         executable bytes over the stack and the machine corrupts
         *         itself with nothing to say why -- so this refuses instead.
         *         Every caller but one binds the address it gets into guest
         *         code and has nothing to check; the one that can act on a
         *         failure, the COM vtable publisher, catches this and answers
         *         the guest with an out-of-memory result.
         */
        register(name, popBytes, { preserveResult = false, forwardTo = 0 } = {}){
            const id = entries.length;
            if (id >= slots)
            {
                throw new Error(`cpu: the stub table is full at ${slots} slots`
                    + ` (${capacity} bytes from ${base.toString(16)}); no room to register`
                    + ` ${name}`);
            }
            const address = base + id * STUB_SIZE;
            entries.push({ id, name, popBytes, address, preserveResult, forwardTo });
            return { id, address };
        },

        /**
         * One slot's bytes, for a stub taken after the table was written.
         *
         * Registration goes on for the life of a process -- a COM interface
         * published when a program first asks for it takes a slot per method,
         * and so does a stub standing in for an import nothing claims. Written
         * once at assembly and never again, the table holds zeroes where those
         * later slots are, and a guest calling one of them runs the zeroes.
         *
         * @param {number} id
         * @returns {Uint8Array}
         */
        stub(id){
            const entry = entries[id];
            if (!entry || id === 0)
            {
                throw new Error(`cpu: trap ${id} has no stub`);
            }
            return buildStub({
                trapId: entry.id,
                port,
                popBytes: entry.popBytes,
                preserveResult: entry.preserveResult,
                forwardTo: entry.forwardTo,
                address: entry.address,
            });
        },

        /** How many slots have been taken, park loop included. */
        get count(){
            return entries.length;
        },

        /** @returns {Uint8Array} the whole table, ready to write at `base` */
        image(){
            const bytes = new Uint8Array(entries.length * STUB_SIZE);
            // hlt; jmp back to the hlt — the park loop in slot 0.
            bytes.set([0xf4, 0xeb, 0xfd], 0);
            for (const entry of entries.slice(1))
            {
                bytes.set(
                    buildStub({
                        trapId: entry.id,
                        port,
                        popBytes: entry.popBytes,
                        preserveResult: entry.preserveResult,
                        forwardTo: entry.forwardTo,
                        address: entry.address,
                    }),
                    entry.id * STUB_SIZE);
            }
            return bytes;
        },

        /** @param {number} id */
        lookup(id){
            return entries[id];
        },

        get size(){
            return entries.length;
        },
    };
}
