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
    const targets = createTargetReads();
    recording = createRecording({
        root: recorded,
        readMemory: services.readMemory ?? ((/** @type {number} */ address,
            /** @type {number} */ length)=>new Uint8Array(length)),
        windowMemory: services.windowMemory,
        transport,
        answered: targets.answered,
        answers: CANDIDATES,
        observe: targets.observe,
    });
    return recording.root;
}

/** D3DLOCK_READONLY. */
const LOCK_READONLY = 0x10;

/** What may draw into the render targets bound: a run of the command ring among them. */
const DRAWING = new Set(['commands', 'DrawPrimitive', 'DrawIndexedPrimitive', 'DrawPrimitiveUP',
    'DrawIndexedPrimitiveUP', 'DrawRectPatch', 'DrawTriPatch', 'Clear']);

/** Copies into a surface, by the argument that is the destination. */
const COPIES_INTO = /** @type {Record<string, number>} */ ({
    CopyRects: 3, UpdateSurface: 2, StretchRect: 2, ColorFill: 0,
});

/**
 * Which render targets' own memory holds what the GPU has in them.
 *
 * A copy out of a render target is answered by the renderer, which reads the
 * target back into the target's memory before the copy is made from there; the
 * program waits for it. A program that copies the same target every frame
 * without drawing into it in between -- a small target read back to keep the
 * GPU from running frames ahead, which is what it is for -- waited each time
 * for an answer it already had. Until something may have drawn into the target,
 * copied into it or written it through a lock, its memory is still the GPU's
 * picture, and the copy is made from it here, byte for byte what the renderer
 * would have answered.
 *
 * Kept for one recorded root: the targets bound are its, and a Reset forgets
 * every target.
 */
export function createTargetReads(){
    /** Targets read back and not touched since. @type {WeakSet<object>} */
    let fresh = new WeakSet();
    /** The render target at each index, as SetRenderTarget left it. @type {any[]} */
    const bound = [];
    /** Back buffers the program has been given: Present may leave them anything. */
    const backBuffers = new Set();
    /** @param {any} surface */
    const touched = surface=>{
        if (surface && typeof surface === 'object')
        {
            fresh.delete(surface);
        }
    };
    return {
        /**
         * What a call the recorded device made changed.
         *
         * @param {any} target @param {string} name @param {any[]} args
         */
        observe(target, name, args){
            if (name === 'SetRenderTarget')
            {
                // Direct3D 9 names an index first; Direct3D 8's one target is
                // kept when it is given none.
                if (typeof args[0] === 'number')
                {
                    bound[args[0]] = args[1] ?? null;
                }
                else if (args[0])
                {
                    bound[0] = args[0];
                }
                return;
            }
            if (DRAWING.has(name))
            {
                if (bound.length === 0)
                {
                    // Drawing before any target was named draws into the back
                    // buffer, which this does not know by sight.
                    fresh = new WeakSet();
                }
                bound.forEach(touched);
                return;
            }
            const into = COPIES_INTO[name];
            if (into !== undefined)
            {
                touched(args[into]);
                return;
            }
            if ((name === 'LockRect' && ((args[2] ?? 0) & LOCK_READONLY) === 0) || name === 'GetDC')
            {
                touched(target);
                return;
            }
            if (name === 'GetBackBuffer')
            {
                const surface = args[args.length - 1]?.surface ?? args[args.length - 1]?.backBuffer;
                if (surface)
                {
                    backBuffers.add(surface);
                }
                return;
            }
            if (name === 'Present')
            {
                backBuffers.forEach(touched);
                return;
            }
            if (name === 'Reset' || name === 'UpdateTexture')
            {
                fresh = new WeakSet();
            }
        },

        /**
         * `answeredByRenderer`, except for a copy out of a target whose memory
         * already holds the renderer's answer.
         *
         * @param {any} target @param {string} name @param {any[]} args
         */
        answered(target, name, args){
            if (name === 'CopyRects' && fresh.has(args[0]))
            {
                return false;
            }
            const asked = answeredByRenderer(target, name, args);
            if (asked && name === 'CopyRects')
            {
                fresh.add(args[0]);
            }
            return asked;
        },
    };
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
