/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A flat guest memory for shlwapi's tests: strings of either spelling put
 * in and read back, counts by pointer, and a bump allocator, wired to
 * createShlwapiFunctions as the win32 module wires it.
 */

import { createShlwapiFunctions } from './functions.js';
import { guestOver } from '../common/guest.fixture.js';
import { encodeAnsi } from '../kernel32/locale.js';

/**
 * @param {Partial<import('./functions.js').ShlwapiHost> & { pointerSize?: 4 | 8 }} [given]
 *     what the test's host does, and the process's width (4 when not given)
 */
export function shlwapiMachine({ pointerSize = 4, ...extra } = {}){
    const memory = new Uint8Array(0x80000);
    const view = new DataView(memory.buffer);
    // Above the low 64 KiB, which a call may refuse as never mapped.
    let next = 0x10000;
    let heap = 0x50000;
    /** @type {number[]} */
    const freed = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const divergences = [];
    const base = {
        guest: guestOver(memory, pointerSize),
        allocate: (/** @type {number} */ bytes)=>{
            const at = heap;
            heap += (bytes + 15) & ~15;
            return at;
        },
        free: (/** @type {number} */ address)=>{
            freed.push(address);
        },
        setLastError: (/** @type {number} */ code)=>{
            errors.push(code);
        },
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>{
            divergences.push(`${api}: ${detail}`);
        },
    };
    const made = /** @type {unknown} */ (createShlwapiFunctions({ ...base, ...extra }));
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (made);
    /**
     * A string put in memory with room after it.
     *
     * @param {string} text @param {boolean} [wide] @param {number} [room]  bytes
     */
    const put = (text, wide = false, room = 0x400)=>{
        const at = next;
        next += Math.max(room, (text.length + 1) * 2 + 16);
        if (wide)
        {
            [...text, '\0'].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        }
        else
        {
            memory.set(encodeAnsi(`${text}\0`), at);
        }
        return at;
    };
    /** @param {number} address @param {boolean} [wide] */
    const read = (address, wide = false)=>base.guest.text(address, wide, 0x1000);
    /** A DWORD put in memory. @param {number} value */
    const count = value=>{
        const at = next;
        next += 16;
        view.setUint32(at, value >>> 0, true);
        return at;
    };
    /** @param {number} address */
    const dwordAt = address=>view.getUint32(address, true);
    return { fns, memory, view, base, put, read, count, dwordAt, freed, errors, divergences };
}
