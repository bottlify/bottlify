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
import { fitFrame, stretchFrame } from '../letterbox.js';

/**
 * Lays a frame out on the screen the engine described, opaque throughout --
 * margins included -- so the presenter uploads it as it is.
 *
 * @param {{ width: number, height: number, bgra: Uint8Array }} picture
 * @param {Uint8Array} out
 * @param {{ width: number, height: number, placement: any }} shape
 */
const fit = (picture, out, shape)=>{
    if (shape.placement)
    {
        stretchFrame(picture, out, shape.width, shape.height, shape.placement);
    }
    else
    {
        fitFrame(picture, out, shape.width, shape.height);
    }
    for (let at = 3; at < out.length; at += 4)
    {
        out[at] = 0xff;
    }
};

/** @type {((message: any) => void) | null} */
let serve = null;

self.onmessage = event=>{
    const message = event.data;
    if (message?.type === 'init')
    {
        serve = serveClips({
            post: (reply, transfer)=>self.postMessage(reply, { transfer: transfer ?? [] }),
        }, createDecoder(message.wasm), fit);
        return;
    }
    serve?.(message);
};
