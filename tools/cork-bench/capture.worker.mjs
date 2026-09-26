/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translation worker with a recorder in front of it, for `translate.mjs`:
 * every message the runtime posts -- a batch or a relink, its jobs, the copy
 * of their pages, the layout, the features and the emitting options -- is
 * appended to `CORK_CAPTURE_OUT` (a length and `v8.serialize`'s bytes) before
 * the real worker (`CORK_CAPTURE_WORKER`, a file URL) handles it, so the
 * worker's whole load can be run again, alone, on any tree's emitter.
 */

import { appendFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { parentPort } from 'node:worker_threads';

const out = process.env.CORK_CAPTURE_OUT;
const real = process.env.CORK_CAPTURE_WORKER;
if (out === undefined || real === undefined)
{
    throw new Error('capture.worker: CORK_CAPTURE_OUT and CORK_CAPTURE_WORKER are required');
}
// Registered before the real worker's listener, so each message is kept before it is used.
parentPort?.on('message', (/** @type {any} */ data)=>{
    const bytes = serialize(data);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(bytes.length);
    appendFileSync(out, Buffer.concat([head, bytes]));
});
await import(real);
