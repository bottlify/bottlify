/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's own variables: `errno`, `_fmode`, `_commode` and the rest.
 *
 * They live in the runtime's data, where a program linked against the DLL
 * cannot name them, so it reaches each through an accessor -- `_errno`,
 * `__p__fmode` -- and reads and writes through the address it gets back. Each
 * is an int placed on the heap the first time anyone asks where it is, and
 * the same address every time after.
 *
 * The runtime's functions set and read them too, and one that fails sets
 * errno whether or not the program has asked for its address yet. The value
 * is kept here until then and is what the cell starts out holding; once the
 * cell exists, the cell is the variable, since the program may write it.
 */

/** errno values, at the numbers msvcrt's errno.h gives them. */
export const ENOENT = 2;
export const EBADF = 9;
export const EACCES = 13;
export const EEXIST = 17;
export const EINVAL = 22;
export const EMFILE = 24;
export const ENOSPC = 28;
export const ERANGE = 34;
export const ENOTEMPTY = 41;
export const EILSEQ = 42;

/**
 * @typedef {Object} GlobalsHost
 * @property {(bytes: number) => number} allocate
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @typedef {Object} Globals
 * @property {(name: string, initial?: number) => number} address
 *           Where the variable lives, placed on first ask holding what it has
 *           been set to, or `initial` when nothing has set it.
 * @property {(name: string) => number} get
 * @property {(name: string, value: number) => void} set
 */

/**
 * @param {GlobalsHost} host
 * @returns {Globals}
 */
export function createGlobals(host){
    /** @type {Map<string, number>} */
    const addresses = new Map();
    /** @type {Map<string, number>} */
    const values = new Map();

    /** @param {number} address @param {number} value */
    const store = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(address, bytes);
    };

    return {
        address(name, initial = 0){
            const held = addresses.get(name);
            if (held !== undefined)
            {
                return held;
            }
            const address = host.allocate(4);
            if (address !== 0)
            {
                store(address, values.get(name) ?? initial);
            }
            addresses.set(name, address);
            return address;
        },

        get(name){
            const address = addresses.get(name) ?? 0;
            if (address === 0)
            {
                return values.get(name) ?? 0;
            }
            const bytes = host.readMemory(address, 4);
            return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
        },

        set(name, value){
            values.set(name, value | 0);
            const address = addresses.get(name) ?? 0;
            if (address !== 0)
            {
                store(address, value);
            }
        },
    };
}
