/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two halves of a Direct3D 10 root whose devices draw somewhere else:
 * the recorded root the program's factories and devices come from, whose
 * renderer keeps state and draws nothing, and the played root that draws.
 *
 * The bytes a program maps live in its own memory (`d3d10/render.js`,
 * `GuestStorage`): a map hands out their address, and what the recorded
 * device reads of them -- the pages the program wrote, at an unmap or a run
 * of the command ring -- is sent ahead of the call that read them, so the
 * played device reads the same. Every other byte a call carries -- initial
 * data, an update, a shader -- is an argument of the call, and goes with it.
 *
 * What only the renderer can answer is asked of the played device: what an
 * occlusion query counted, what a read map of a staging resource holds when
 * the GPU copied into it, the pixels a DC is opened over, and what the
 * renderer itself says it did.
 */

import { createMirror, createPlayer, createRecording } from './replay.js';

/** D3D10_QUERY_OCCLUSION and _OCCLUSION_PREDICATE: the GPU's counts. */
const QUERY_OCCLUSION = 1;
const QUERY_OCCLUSION_PREDICATE = 5;
/** D3D10_USAGE_STAGING, and D3D10_MAP_READ and _READ_WRITE. */
const USAGE_STAGING = 3;
const MAP_READ = 1;
const MAP_READ_WRITE = 3;

/** Every method `answered` may say yes to. */
const ANSWERS = new Set(['diagnostics', 'idle', 'GetData', 'Map', 'OpenDC']);

/**
 * Whether a call's answer is the played device's.
 *
 * @param {any} target @param {string} name @param {any[]} args
 */
export function answeredByRenderer10(target, name, args){
    switch (name)
    {
        case 'diagnostics':
        case 'idle':
            return true;
        case 'GetData': {
            /** @type {{ desc?: { Query?: number } }} */
            const out = {};
            target?.GetDesc?.(out);
            const query = out.desc?.Query;
            return query === QUERY_OCCLUSION || query === QUERY_OCCLUSION_PREDICATE;
        }
        case 'Map':
            // A staging resource read back: what the GPU copied into it is
            // the played device's to say.
            return target?.desc?.Usage === USAGE_STAGING
                && (args[1] === MAP_READ || args[1] === MAP_READ_WRITE);
        case 'OpenDC':
            // Unless the program discards them, the pixels are what the GPU drew.
            return args[0] !== true;
        default:
            return false;
    }
}

/**
 * The root the program is given: every call on it and on what it hands out
 * made with no renderer behind it, and sent.
 *
 * @param {(options: import('../d3d10/device.js').DeviceOptions) => any} factory
 *     `createDirect3D10`
 * @param {import('../d3d10/device.js').DeviceOptions} options  what the factory would be
 *     given; its backend is not used
 * @param {import('./replay.js').Transport} transport
 * @returns {any}
 */
export function recordedDirect3D10(factory, options, transport){
    /** @type {ReturnType<typeof createRecording> | null} */
    let recording = null;
    const guest = options.guest;
    const root = factory({
        ...options,
        backend: undefined,
        createSampler: undefined,
        createTexture: undefined,
        // The played side's renderer paces the frames, through the channel.
        frameQueued: undefined,
        // What the played device has to say about the program is the whole
        // of it; this one would add what only lacking a renderer makes it say.
        divergence: undefined,
        guest: guest && {
            ...guest,
            allocate: (/** @type {number} */ bytes)=>{
                // A refusal too: the played device is given the same answer.
                const address = guest.allocate(bytes);
                if (address)
                {
                    recording?.allocated(address, Math.max(bytes, 1));
                }
                return address;
            },
            free: (/** @type {number} */ address)=>{
                recording?.freed(address);
                guest.free?.(address);
            },
            writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
                recording?.writing(address, bytes.length);
                guest.writeMemory(address, bytes);
                recording?.wrote(address, bytes);
            },
            readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>{
                const bytes = guest.readMemory(address, length);
                recording?.read(address, bytes);
                return bytes;
            },
        },
    });
    recording = createRecording({
        root,
        readMemory: guest?.readMemory ?? ((/** @type {number} */ address,
            /** @type {number} */ length)=>new Uint8Array(length)),
        watchWrites: guest?.watchWrites,
        transport,
        answered: answeredByRenderer10,
        answers: ANSWERS,
    });
    return recording.root;
}

/**
 * The root that draws, over a guest memory of only the bytes it was sent.
 *
 * @param {(options: import('../d3d10/device.js').DeviceOptions) => any} factory
 * @param {import('../d3d10/device.js').DeviceOptions & { writeMemory?: (address: number,
 *     bytes: Uint8Array) => void }} options  what the factory is given but for guest memory,
 *     which is the mirror's: `writeMemory` is where what the played device writes outside a
 *     call goes -- a staging resource read back, which the program waits for
 * @returns {{ root: any, play: (call: import('./wire.js').ReadCall) => any,
 *     counts: () => import('./replay.js').OcclusionCount[],
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => number | undefined }}
 */
export function playedDirect3D10(factory, options){
    const mirror = createMirror();
    /** @type {ReturnType<typeof createPlayer> | null} */
    let player = null;
    /** Whether a call is being played: what it writes, the recorded one wrote too. */
    let playing = false;
    const write = options.writeMemory;
    const root = factory({
        ...options,
        guest: {
            // The address the recorded device got; none where it got none, and
            // the resource keeps its bytes on the host on both sides.
            allocate: ()=>{
                try
                {
                    return /** @type {ReturnType<typeof createPlayer>} */ (player).allocate();
                }
                catch {
                    return 0;
                }
            },
            free: ()=>{},
            readMemory: (address, length)=>mirror.read(address, length),
            writeMemory: (address, bytes)=>{
                mirror.write(address, bytes);
                if (!playing)
                {
                    write?.(address, bytes);
                }
            },
            // Only what is sent writes the mirror, so it says what was written.
            watchWrites: (address, length)=>mirror.watch(address, length),
        },
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
        counts: live.counts,
    };
}
