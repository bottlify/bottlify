/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A recorded device and its played twin in one thread, call for call: the
 * program talks to a device with no renderer behind it, and every call is
 * played at once on a device made with the caller's renderer, over a guest
 * memory of only the bytes the recording sent. What a renderer draws through
 * it is what the replay carries, so a scene that draws the same through this
 * as through a device of its own is one the replay misses nothing of -- the
 * test of the replay before a worker is put between the two.
 */

import { createMirror, createPlayer, createRecording } from './replay.js';

/** D3DUSAGE_RENDERTARGET, the same in Direct3D 8 and 9. */
const RENDERTARGET = 0x1;

/**
 * The calls whose answer only a renderer has: what it has done, when its
 * frames are finished, what an occlusion query counted, and the pixels it
 * drew, read back.
 */
const ANSWERED = new Set(['diagnostics', 'idle', 'GetData', 'GetRenderTargetData',
    'GetFrontBufferData', 'GetFrontBuffer']);

/** @param {any} surface */
function isRenderTarget(surface){
    if (typeof surface?.GetDesc !== 'function')
    {
        return false;
    }
    /** @type {{ desc?: { Usage?: number } }} */
    const out = {};
    surface.GetDesc(out);
    return ((out.desc?.Usage ?? 0) & RENDERTARGET) !== 0;
}

/**
 * Whether a call's answer is the played device's: one of `ANSWERED`, or a
 * lock, a context or a copy of a render target, whose pixels are read back
 * first.
 *
 * @param {any} target @param {string} name @param {any[]} args
 */
export function answeredByRenderer(target, name, args){
    if (ANSWERED.has(name))
    {
        return true;
    }
    if (name === 'LockRect' || name === 'GetDC')
    {
        return isRenderTarget(target);
    }
    return name === 'CopyRects' && isRenderTarget(args[0]);
}

/**
 * @param {(services: any) => any} factory  `createDirect3D9` or `createDirect3D8`
 * @param {any} [services]  what the factory would be given: its backend draws for the played device
 * @param {(services: any) => any} [playedFactory]  the same, as the played device's
 *     thread has it: of a module graph of its own, as another thread's would be
 * @returns {any} the root the program is given
 */
export function loopbackDirect3D(factory, services = {}, playedFactory = factory){
    const mirror = createMirror();
    // Real guest memory when the caller has some; addresses handed out here
    // otherwise, where and as the device itself would hand them out, so the
    // locked bytes' blocks are known either way.
    let fabricated = 0x40000000;
    /** @param {number} bytes */
    const guest = services.allocate
        ?? ((/** @type {number} */ bytes)=>{
            const address = fabricated;
            fabricated += Math.max(bytes, 1) + 0x1000;
            return address;
        });
    /** @type {ReturnType<typeof createRecording> | null} */
    let recording = null;
    const write = services.writeMemory;
    const recorded = factory({
        ...services,
        backend: undefined,
        createSampler: undefined,
        // What the played device has to say about the program is the whole
        // of it; this one would add what only lacking a renderer makes it say.
        divergence: undefined,
        allocate: (/** @type {number} */ bytes)=>{
            const address = guest(Math.max(bytes, 1));
            recording?.allocated(address, Math.max(bytes, 1));
            return address;
        },
        writeMemory: write && ((/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
            write(address, bytes);
            recording?.wrote(address, bytes);
        }),
        // The display is told which device owns the ramp: the one the
        // program holds.
        gamma: services.gamma && {
            applies: ()=>services.gamma.applies(),
            set: (/** @type {any} */ owner, /** @type {any} */ ramp)=>
                services.gamma.set(recording?.outward(owner) ?? owner, ramp),
        },
    });
    /** @type {ReturnType<typeof createPlayer> | null} */
    let player = null;
    /** Whether a call is being played: what it writes, the recorded one wrote too. */
    let playing = false;
    const played = playedFactory({
        ...services,
        // Without memory of the caller's, nor does this one have any: a
        // device that draws refuses to be made so.
        readMemory: services.readMemory && mirror.read,
        windowMemory: services.readMemory && mirror.read,
        // What the played device writes later -- a render target's pixels
        // read back -- is the guest's as well as its own.
        writeMemory: write && ((/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
            mirror.write(address, bytes);
            if (!playing)
            {
                write(address, bytes);
            }
        }),
        allocate: ()=>/** @type {ReturnType<typeof createPlayer>} */ (player).allocate(),
        free: ()=>{},
        // The ramp reaches the display through the recorded device, which
        // the program sets it on; this one only has to know whether it does.
        gamma: services.gamma && { applies: ()=>services.gamma.applies(), set: ()=>{} },
    });
    player = createPlayer({ root: played, ship: mirror.write, read: mirror.read });
    const live = player;
    recording = createRecording({
        root: recorded,
        readMemory: services.readMemory ?? ((/** @type {number} */ address,
            /** @type {number} */ length)=>new Uint8Array(length)),
        send: call=>{
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
        answered: answeredByRenderer,
    });
    return recording.root;
}
