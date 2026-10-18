/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { D3DERR_INVALIDCALL } from './constants.js';

/** D3DUSAGE_DYNAMIC: a buffer the program may write while the GPU reads it. */
const DYNAMIC = 0x200;

/**
 * How many storages a dynamic buffer has at most: the one it is made with,
 * and the spares a DISCARD in the guest trades it for (`seam/shadow.js`,
 * `BUFFER.SPARES`).
 */
export const STORAGES = 3;

/**
 * A vertex or index buffer's storages in guest memory, and the two calls that
 * use more than one: what a driver does when a DISCARD meets a buffer the GPU
 * still reads -- it hands out other memory, and the draws made before read
 * what they were made with. Direct3D 8's and 9's alike.
 *
 * `AddStorage` gives a dynamic buffer one more of its length, once a DISCARD
 * of it has come to the host under draws the command ring held: memory only
 * for a buffer a program discards that way. `Rename` moves the buffer onto
 * one of them; the guest's lock routine writes it into the command ring, so
 * the device makes it after the draws before the DISCARD and before any
 * after. The renderer renames its own copy then, as for a DISCARD; the
 * recording claims what was lent of the storage left (`left`), and the
 * device's block is told it may hand that storage out again (`renamed`).
 *
 * @param {{ base: number, length: number, usage: number, renamed?: (left: number) => void }} buffer
 * @param {number[]} storages  the buffer's, its first one at its creation
 * @param {{ allocate: (bytes: number) => number,
 *     renderer?: { renameBuffer?: (buffer: any) => void } | null,
 *     left?: (address: number, length: number) => void }} use
 */
export function storageCalls(buffer, storages, use){
    return {
        storages,

        /** @returns {number} the storage's address, or 0 for none */
        AddStorage(){
            if ((buffer.usage & DYNAMIC) === 0 || storages.length >= STORAGES)
            {
                return 0;
            }
            const address = use.allocate(buffer.length);
            if (address !== 0)
            {
                storages.push(address);
            }
            return address;
        },

        /** @param {number} address  one of its storages */
        Rename(address){
            if (!storages.includes(address >>> 0))
            {
                return D3DERR_INVALIDCALL;
            }
            const left = buffer.base;
            if (left === address >>> 0)
            {
                return 0;
            }
            buffer.base = address >>> 0;
            use.renderer?.renameBuffer?.(buffer);
            use.left?.(left, buffer.length);
            buffer.renamed?.(left);
            return 0;
        },
    };
}
