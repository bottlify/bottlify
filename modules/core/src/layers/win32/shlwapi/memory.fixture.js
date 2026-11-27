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
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

/**
 * @param {Partial<import('./functions.js').ShlwapiHost>} [extra]
 */
export function shlwapiMachine(extra = {}){
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
    // As the memory layer reads: the limit is in bytes, and a string with no
    // terminator within it is refused, not cut.
    const unterminated = ()=>Object.assign(new Error('unterminated'), { code: 'UNTERMINATED' });
    const readCString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>{
        let end = address;
        while (memory[end] !== 0)
        {
            if (++end >= Math.min(address + maxLength, memory.length))
            {
                throw unterminated();
            }
        }
        return decodeAnsi(memory.subarray(address, end));
    };
    const readWideString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>{
        let text = '';
        for (let at = address; ; at += 2)
        {
            if (at + 2 > Math.min(address + maxLength, memory.length))
            {
                throw unterminated();
            }
            const unit = view.getUint16(at, true);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };
    const base = {
        readCString,
        readWideString,
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            memory.subarray(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, address),
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
    const read = (address, wide = false)=>(wide ? readWideString(address, 0x1000)
        : readCString(address, 0x1000));
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
