/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 * @returns {Uint8Array}
 */
export function buildStub({ trapId, port, popBytes, preserveResult = false }){
    const u16 = (/** @type {number} */ v)=>[v & 0xff, v >>> 8 & 0xff];
    const u32 = (/** @type {number} */ v)=>[...u16(v), v >>> 16 & 0xff, v >>> 24 & 0xff];

    const bytes = [
        // A stub reached by a `ret` is being handed a return value, and EAX is
        // both where that value is and where the trap id has to go. Moving it
        // aside first costs two bytes; ECX is caller-saved under every
        // convention here, so nothing was counting on it either.
        ...preserveResult ? [0x89, 0xc1] : [], // mov ecx, eax
        0x66, 0xba, ...u16(port), // mov dx, port
        0xb8, ...u32(trapId), //     mov eax, trapId
        0xef, //                     out dx, eax   -> host handles it, leaves the result in EAX
        ...popBytes > 0 ? [0xc2, ...u16(popBytes)] : [0xc3], // ret popBytes / ret
    ];
    if (bytes.length > STUB_SIZE) throw new Error('stub does not fit its slot');
    return new Uint8Array([...bytes, ...new Array(STUB_SIZE - bytes.length).fill(0xcc)]);
}

/**
 * A table of stubs laid out in guest memory.
 *
 * @param {Object} options
 * @param {number} options.base  Guest address of the first stub.
 * @param {number} options.port
 */
export function createThunkTable({ base, port }){
    /**
     * @type {{
     *   id: number, name: string, popBytes: number,
     *   address: number, preserveResult?: boolean,
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
         * @returns {{ id: number, address: number }}
         */
        register(name, popBytes, { preserveResult = false } = {}){
            const id = entries.length;
            const address = base + id * STUB_SIZE;
            entries.push({ id, name, popBytes, address, preserveResult });
            return { id, address };
        },

        /** @returns {Uint8Array} the whole table, ready to write at `base` */
        image(){
            const bytes = new Uint8Array(entries.length * STUB_SIZE);
            // hlt; jmp back to the hlt — the park loop in slot 0.
            bytes.set([0xf4, 0xeb, 0xfd], 0);
            for (const entry of entries.slice(1)){
                bytes.set(
                    buildStub({
                        trapId: entry.id,
                        port,
                        popBytes: entry.popBytes,
                        preserveResult: entry.preserveResult,
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
