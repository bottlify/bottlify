/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a store's `readInto` hands, put together, and the buffers each part
 * came from: the tests of every store judge it against `read` and check the
 * parts are the store's own bytes, not copies.
 *
 * @param {import('./memory-store.js').SourceStore} store @param {string} path
 * @param {number} offset @param {number} length
 */
export function assembled(store, path, offset, length){
    if (!store.readInto)
    {
        throw new Error('this store has no readInto');
    }
    const out = new Uint8Array(Math.max(0, length));
    /** @type {ArrayBufferLike[]} */
    const buffers = [];
    const count = store.readInto(path, offset, length, (bytes, at)=>{
        buffers.push(bytes.buffer);
        out.set(bytes, at);
    });
    return { bytes: out.subarray(0, count), buffers };
}
