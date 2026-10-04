/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two halves of a Direct3D 8 or 9 root whose rendering is somewhere
 * else: the recorded root the program is given, with no renderer behind it,
 * and the played root that draws, wherever its calls are carried to.
 */

import { createMirror, createPlayer, createRecording } from './replay.js';
import { WAIT, createWriter } from './wire.js';

/** D3DQUERYTYPE_EVENT. */
const D3DQUERYTYPE_EVENT = 8;

/** D3DUSAGE_RENDERTARGET, the same in Direct3D 8 and 9. */
const RENDERTARGET = 0x1;

/**
 * The calls whose answer only a renderer has: what it has done, when its
 * frames are finished, what an occlusion query counted, and the pixels it
 * drew, read back.
 */
const ANSWERED = new Set(['diagnostics', 'idle', 'GetData', 'GetRenderTargetData',
    'GetFrontBufferData', 'GetFrontBuffer']);

/** Every method `answeredByRenderer` may say yes to. */
const CANDIDATES = new Set([...ANSWERED, 'LockRect', 'GetDC', 'CopyRects']);

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
    if (name === 'GetData')
    {
        // An event query is signalled once its end is issued, by the
        // recording device as by any other: asking the renderer only made the
        // program wait for it to play everything before it, which pacing the
        // presents already bounds.
        return target?.type !== D3DQUERYTYPE_EVENT;
    }
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
 * The root the program is given: every call on it and on what it hands out
 * made on a device with no renderer, and sent.
 *
 * @param {(services: any) => any} factory  `createDirect3D9` or `createDirect3D8`
 * @param {any} services  what the factory would be given; its backend is not used
 * @param {import('./replay.js').Transport} transport
 * @returns {any}
 */
export function recordedDirect3D(factory, services, transport){
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
        renderedElsewhere: true,
        allocate: (/** @type {number} */ bytes)=>{
            const address = guest(Math.max(bytes, 1));
            recording?.allocated(address, Math.max(bytes, 1));
            return address;
        },
        free: (/** @type {number} */ address)=>{
            recording?.freed(address);
            services.free?.(address);
        },
        writeMemory: write && ((/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
            recording?.writing(address, bytes.length);
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
    recording = createRecording({
        root: recorded,
        readMemory: services.readMemory ?? ((/** @type {number} */ address,
            /** @type {number} */ length)=>new Uint8Array(length)),
        windowMemory: services.windowMemory,
        transport,
        answered: answeredByRenderer,
        answers: CANDIDATES,
    });
    return recording.root;
}

/**
 * The root that draws, over a guest memory of only the bytes it was sent.
 *
 * @param {(services: any) => any} factory
 * @param {any} services  what the factory is given, but for memory: `readMemory`
 *     says only whether the program has any, and `writeMemory` is where what
 *     the played device writes outside a call goes -- a render target's pixels
 *     read back, which the program waits for; `borrow`, where guest memory is
 *     shared, reads what the recording lent (`lending.js`)
 * @returns {{ root: any, play: (call: import('./wire.js').ReadCall) => any,
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => void }}
 *     `read` reads a batch of calls for `play`
 */
export function playedDirect3D(factory, services){
    const mirror = createMirror();
    /** @type {ReturnType<typeof createPlayer> | null} */
    let player = null;
    /** Whether a call is being played: what it writes, the recorded one wrote too. */
    let playing = false;
    const write = services.writeMemory;
    const root = factory({
        ...services,
        // Without memory of the caller's, nor does this one have any: a
        // device that draws refuses to be made so.
        readMemory: services.readMemory && mirror.read,
        windowMemory: services.readMemory
            && ((/** @type {number} */ address, /** @type {number} */ length)=>
                mirror.window(address, length)),
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
    player = createPlayer({ root, ship: mirror.write, read: mirror.read, borrow: services.borrow });
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

/**
 * A carrier that plays each call where it is made: the recorded and the
 * played root in one thread.
 *
 * @param {ReturnType<typeof playedDirect3D>} played
 * @returns {import('./replay.js').Transport}
 */
export function playedAtOnce(played){
    const writer = createWriter();
    /** @param {number} [wait] @returns {any} */
    const playAll = wait=>{
        if (wait !== undefined)
        {
            writer.u8(wait);
            if (wait === WAIT.ANSWER)
            {
                writer.u32(0);
            }
        }
        let answer;
        played.read(writer.take(), call=>{
            answer = played.play(call);
        });
        return answer;
    };
    return {
        writer,
        called: wait=>playAll(wait),
        recorded: ()=>{
            playAll();
        },
    };
}
