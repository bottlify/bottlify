/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishBundle, placeFiles } from './bundle-in-place.js';

/** A container in memory whose writes take at most `most` bytes each. @param {number} most */
function shortWriter(most){
    let bytes = new Uint8Array(0);
    return {
        /** @param {Uint8Array} into @param {{ at: number }} where */
        read: (into, { at })=>{
            const part = bytes.subarray(at, at + into.length);
            into.set(part);
            return part.length;
        },
        /** @param {Uint8Array} from @param {{ at: number }} where */
        write: (from, { at })=>{
            const taken = from.subarray(0, Math.min(most, from.length));
            if (at + taken.length > bytes.length)
            {
                const grown = new Uint8Array(at + taken.length);
                grown.set(bytes);
                bytes = grown;
            }
            bytes.set(taken, at);
            return taken.length;
        },
        truncate: (/** @type {number} */ size)=>{
            const cut = new Uint8Array(size);
            cut.set(bytes.subarray(0, size));
            bytes = cut;
        },
        flush: ()=>{},
        getSize: ()=>bytes.length,
    };
}

test('a write the container takes in part fails the bundle, not a bundle with a hole', async()=>{
    // The launcher's handle wrote the index and the header unchecked: a disk
    // that took part of them left a bundle that opened as garbage.
    const placed = placeFiles([{ path: 'a.dat', size: 8 }]);
    const whole = shortWriter(Infinity);
    whole.write(new Uint8Array(8).fill(3), { at: placed.files[0].at });
    await finishBundle(whole, placed.files, [], { hashFiles: false });
    const short = shortWriter(16);
    short.write(new Uint8Array(8).fill(3), { at: placed.files[0].at });
    await assert.rejects(finishBundle(short, placed.files, [], { hashFiles: false }),
        /bytes written/);
});
