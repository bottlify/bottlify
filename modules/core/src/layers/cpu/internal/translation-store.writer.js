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
 * @param {{ id: number, type: 'open' | 'write' | 'flush' | 'close' | 'append', file?: any,
 *     writes?: [number, Uint8Array][], at?: number, bytes?: Uint8Array }} data
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
    else if (data.type === 'append')
    {
        // The index's lines, at its end: a handle of its own for the one write,
        // flushed and closed here, where the disk holds this worker alone.
        const index = await data.file.createSyncAccessHandle();
        try
        {
            index.write(data.bytes, { at: data.at });
            index.flush();
        }
        finally
        {
            index.close();
        }
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
