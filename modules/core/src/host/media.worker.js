/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The film decoder's own thread: the engine starts it the first time a program
 * opens a cinematic and hands it the decoder binary, and from then on it only
 * decodes (see `layers/media/internal/clip-worker.js`).
 */

import { createDecoder } from '../layers/media/internal/decoder.js';
import { serveClips } from '../layers/media/internal/clip-worker.js';

/** @type {((message: any) => void) | null} */
let serve = null;

self.onmessage = event=>{
    const message = event.data;
    if (message?.type === 'init')
    {
        serve = serveClips({
            post: (reply, transfer)=>self.postMessage(reply, { transfer: transfer ?? [] }),
        }, createDecoder(message.wasm));
        return;
    }
    serve?.(message);
};
