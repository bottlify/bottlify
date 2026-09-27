/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine's end of a film decoded on another thread (`clip-worker.js`).
 *
 * A clip here answers the calls a filter graph makes of the decoder itself --
 * `decode`, `frame`, `readAudio`, `close`, and the clip's shape -- from what
 * the decoding thread has already sent. When nothing has arrived yet, `decode`
 * says `pending`: the frame is late, as a renderer's sample is when its decoder
 * falls behind, and the graph shows the one it has until the next tick.
 */

import { AHEAD } from './clip-worker.js';

/**
 * @typedef {Object} RemotePort
 * @property {(message: any, transfer?: Transferable[]) => void} post
 * @property {(handler: (message: any) => void) => void} listen
 * @property {() => void} [close]  Ends the thread.
 */

/**
 * @param {RemotePort} port
 */
export function createRemoteClips(port){
    let next = 1;
    /** @type {Map<number, { resolve: (clip: any) => void, reject: (e: Error) => void }>} */
    const opening = new Map();
    /** @type {Map<number, { events: any[] }>} */
    const clips = new Map();
    const counters = { opened: 0, frames: 0, late: 0 };

    port.listen(message=>{
        switch (message?.type)
        {
            case 'opened':
                opening.get(message.id)?.resolve(message.info);
                opening.delete(message.id);
                break;
            case 'failed':
                opening.get(message.id)?.reject(new Error(`media: ${message.message}`));
                opening.delete(message.id);
                break;
            case 'event':
                clips.get(message.id)?.events.push(message);
                break;
            default:
                break;
        }
    });

    return {
        /**
         * Opens a container on the decoding thread. The bytes are handed over,
         * not copied: the caller's array is empty afterwards.
         *
         * @param {Uint8Array} bytes
         * @returns {Promise<any>} the clip
         */
        async open(bytes){
            const id = next++;
            const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                && bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();
            const info = await new Promise((resolve, reject)=>{
                opening.set(id, { resolve, reject });
                port.post({ type: 'open', id, bytes: owned }, [owned.buffer]);
            });
            counters.opened++;
            const state = { events: /** @type {any[]} */ ([]) };
            clips.set(id, state);
            /** @type {Uint8Array | null} */
            let current = null;
            /** @type {string | null} */
            let fitted = null;
            /** @type {Int16Array[]} */
            let audio = [];
            let closed = false;
            const clip = {
                ...info,

                /** @returns {"frame" | "audio" | "end" | "pending"} */
                decode(){
                    if (closed)
                    {
                        throw new Error('media: decode on a closed clip');
                    }
                    const event = state.events.shift();
                    if (!event)
                    {
                        counters.late++;
                        return 'pending';
                    }
                    if (event.kind === 'frame')
                    {
                        counters.frames++;
                        current = event.bgra;
                        fitted = event.fitted ?? null;
                        clip.width = event.width;
                        clip.height = event.height;
                        port.post({ type: 'credit', id, frames: 1 });
                        return 'frame';
                    }
                    if (event.kind === 'audio')
                    {
                        audio.push(event.pcm);
                        return 'audio';
                    }
                    if (event.error)
                    {
                        throw new Error(`media: decode failed (${event.error})`);
                    }
                    return 'end';
                },

                /**
                 * The current frame: the film's own pixels, or -- when `fitted`
                 * names a shape -- already laid out on that screen.
                 *
                 * @returns {Uint8Array | null}
                 */
                frame: ()=>current,

                /** The key of the shape the current frame was laid out for, if any. */
                fitted: ()=>fitted,

                /** Bytes of sound taken from the thread and not read yet. */
                audioPending: ()=>audio.reduce((sum, block)=>sum + block.byteLength, 0),

                /** @returns {Int16Array | null} */
                readAudio(){
                    if (audio.length === 0)
                    {
                        return null;
                    }
                    if (audio.length === 1)
                    {
                        const [only] = audio;
                        audio = [];
                        return only;
                    }
                    const joined = new Int16Array(
                        audio.reduce((sum, block)=>sum + block.length, 0));
                    let at = 0;
                    for (const block of audio)
                    {
                        joined.set(block, at);
                        at += block.length;
                    }
                    audio = [];
                    return joined;
                },

                close(){
                    if (closed)
                    {
                        return;
                    }
                    closed = true;
                    clips.delete(id);
                    port.post({ type: 'close', id });
                },
            };
            return clip;
        },

        /**
         * Tells the decoding thread the screen and placement to lay frames
         * out for, from the next frame it decodes.
         *
         * @param {{ key: string, width: number, height: number }} shape
         */
        fitTo(shape){
            port.post({ type: 'fit', shape });
        },

        /** Closes every clip still open. */
        closeAll(){
            for (const id of [...clips.keys()])
            {
                clips.delete(id);
                port.post({ type: 'close', id });
            }
        },

        diagnostics: ()=>({ ...counters, clips: clips.size, ahead: AHEAD }),
    };
}
