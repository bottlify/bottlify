/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The translation store's records written off the engine's thread (`openRecordsWriter` in
// translation-store.js): a handle of this worker's own on the records file, opened as the
// engine's own is, `readwrite-unsafe`, so the two stand together. A write through the
// synchronous handle waits for the disk, and on the engine's thread one held a game's frame
// for forty milliseconds; here it holds nothing but this worker.

/** @type {any} */
let access = null;

/**
 * @param {{ id: number, type: 'open' | 'write' | 'flush' | 'close', file?: any,
 *     writes?: [number, Uint8Array][] }} data
 */
const serve = async data=>{
    if (data.type === 'open')
    {
        access?.close();
        access = null;
        access = await data.file.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
    }
    else if (data.type === 'write')
    {
        for (const [offset, bytes] of data.writes ?? [])
        {
            access.write(bytes, { at: offset });
        }
    }
    else if (data.type === 'flush')
    {
        access?.flush();
    }
    else if (data.type === 'close')
    {
        access?.close();
        access = null;
    }
};

// One message at a time, in the order they came: a write is answered only once the ones
// before it are on the file, and a flush only once every write before it is.
/** @type {Promise<void>} */
let queue = Promise.resolve();
self.onmessage = (/** @type {{ data: any }} */ { data })=>{
    queue = queue.then(()=>serve(data)).then(()=>{
        self.postMessage({ id: data.id, ok: true });
    }, (/** @type {unknown} */ e)=>{
        self.postMessage({ id: data.id, ok: false, message: String(/** @type {any} */ (e)?.message ?? e) });
    });
};
