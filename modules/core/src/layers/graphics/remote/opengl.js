/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two halves of an OpenGL root whose contexts draw somewhere else: the
 * recorded root the program's contexts are made by, whose renderer only keeps
 * state, and the played root that draws.
 *
 * A context reads the program's memory at the call -- pixels, buffer data,
 * program text, indices, and the client arrays a draw reaches -- rather than
 * through locks, so what the recorded one reads is sent ahead of each call,
 * and the played one reads the same bytes at the same call.
 */

import { createMirror, createPlayer, createRecording } from './replay.js';

/** The one call whose answer only the renderer has: what it says of itself. */
const ANSWERED = new Set(['diagnostics']);

/**
 * The root the program's contexts are made by: every call on it and on the
 * contexts it makes made on contexts with no renderer behind them, and sent.
 *
 * @param {(services: import('../opengl/root.js').OpenglRootServices) => any} factory
 *     `createOpenglRoot`
 * @param {import('../opengl/root.js').OpenglRootServices} services
 * @param {import('./replay.js').Transport} transport
 * @returns {any}
 */
export function recordedOpengl(factory, services, transport){
    /** @type {ReturnType<typeof createRecording> | null} */
    let recording = null;
    const { readMemory, windowMemory, writeMemory, allocate } = services;
    /** @param {(address: number, length: number) => Uint8Array} read */
    const tapped = read=>(/** @type {number} */ address, /** @type {number} */ length)=>{
        const bytes = read(address, length);
        recording?.read(address, bytes);
        return bytes;
    };
    const root = factory({
        ...services,
        model: true,
        backend: undefined,
        createSampler: undefined,
        // The played side's renderer paces the frames, through the channel.
        frameQueued: undefined,
        // What the played contexts have to say about the program is the
        // whole of it; these would add what only lacking a renderer makes
        // them say.
        divergence: undefined,
        readMemory: readMemory && tapped(readMemory),
        windowMemory: windowMemory && tapped(windowMemory),
        writeMemory: writeMemory && ((/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
        {
            writeMemory(address, bytes);
            recording?.wrote(address, bytes);
        }),
        allocate: allocate && ((/** @type {number} */ bytes)=>{
            // A refusal too: the played context is given the same answer.
            const address = allocate(bytes);
            recording?.allocated(address, Math.max(bytes, 1));
            return address;
        }),
    });
    recording = createRecording({
        root,
        readMemory: readMemory ?? ((/** @type {number} */ address,
            /** @type {number} */ length)=>new Uint8Array(length)),
        transport,
        answered: (_, name)=>ANSWERED.has(name),
        answers: ANSWERED,
    });
    return recording.root;
}

/**
 * The root that draws, over a guest memory of only the bytes it was sent.
 *
 * @param {(services: import('../opengl/root.js').OpenglRootServices) => any} factory
 * @param {import('../opengl/root.js').OpenglRootServices} services  what the factory
 *     is given but for memory, which is the mirror's: `writeMemory` is where what the
 *     played contexts write outside a call goes, and nothing does today
 * @returns {{ root: any, play: (call: import('./wire.js').ReadCall) => any,
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => void }}
 */
export function playedOpengl(factory, services){
    const mirror = createMirror();
    /** @type {ReturnType<typeof createPlayer> | null} */
    let player = null;
    let playing = false;
    const write = services.writeMemory;
    const root = factory({
        ...services,
        model: false,
        readMemory: mirror.read,
        windowMemory: (address, length)=>mirror.window(address, length),
        writeMemory: (address, bytes)=>{
            mirror.write(address, bytes);
            if (!playing)
            {
                write?.(address, bytes);
            }
        },
        allocate: ()=>/** @type {ReturnType<typeof createPlayer>} */ (player).allocate(),
    });
    player = createPlayer({ root, ship: mirror.write, read: mirror.read });
    const live = player;
    return {
        root,
        play: call=>{
            playing = true;
            try
            {
                return live.play(call);
            }
            finally
            {
                playing = false;
            }
        },
        read: live.read,
    };
}
