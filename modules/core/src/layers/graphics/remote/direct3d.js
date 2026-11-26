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

import { createRecording, playedOverMirror } from './replay.js';
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
        // The recording's diagnostic, not the device's: an option the device
        // does not take lands in its caps, and a function there makes the caps
        // an object to number, which the played side's never are.
        checkDraws: undefined,
        renderedElsewhere: true,
        allocate: (/** @type {number} */ bytes)=>{
            const address = guest(Math.max(bytes, 1));
            recording?.allocated(address, Math.max(bytes, 1));
            return address;
        },
        free: (/** @type {number} */ address)=>{
            recording?.freed(address);
            // A read-back the played side has not answered yet is written
            // where the program's surface was: given back now, the heap could
            // hand the span to someone else before those pixels land on it.
            const settled = recording?.settled();
            if (settled)
            {
                settled.then(()=>services.free?.(address));
                return;
            }
            services.free?.(address);
        },
        // A draw from a dynamic buffer sends what the program wrote there
        // after the unlock: the played side's copy of guest memory has only
        // what was sent.
        drawsFrom: (/** @type {any} */ buffer, /** @type {number} */ from, /** @type {number} */ to)=>
            recording?.drawsFrom(buffer, from, to),
        // A buffer moved off a storage (`d3d8/storages.js`): the program may
        // write there again once what was lent of it is claimed.
        leftStorage: (/** @type {number} */ address, /** @type {number} */ length)=>
            recording?.claim(address, length),
        whileStill: (/** @type {() => any} */ work)=>(recording ? recording.still(work) : work()),
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
        watchWrites: services.watchWrites,
        checkDraws: services.checkDraws,
        transport,
        answered: targets.answered,
        answers: CANDIDATES,
        observe: targets.observe,
        // Written here only: the played side made the same copies in its own
        // memory when it answered.
        // Each row is read where it lies and written at once, before the
        // guest runs again: no copy of it is kept.
        applyMoves: write && services.readMemory
            ? (/** @type {any[]} */ moves)=>{
                const rowAt = services.windowMemory ?? services.readMemory;
                for (const move of moves)
                {
                    for (let row = 0; row < move.rows; row++)
                    {
                        write(move.to + row * move.toPitch,
                            rowAt(move.from + row * move.fromPitch, move.rowBytes));
                    }
                }
            }
            : undefined,
    });
    return recording.root;
}

/** D3DLOCK_READONLY. */
const LOCK_READONLY = 0x10;

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
 * for an answer it already had. Until the device says something has drawn,
 * cleared or copied into the target (its `drawnInto`), and nothing has written
 * it through a lock, its memory is still the GPU's picture, and the copy is made
 * from it here, byte for byte what the renderer would have answered.
 *
 * Kept for one recorded root: a Reset forgets every target.
 */
export function createTargetReads(){
    /** What each target's `drawnInto` was when it was last read back. @type {WeakMap<object, number>} */
    let readAt = new WeakMap();
    /** @param {any} surface */
    const touched = surface=>{
        if (surface && typeof surface === 'object')
        {
            readAt.delete(surface);
        }
    };
    /** @param {any} device @param {any} surface */
    const drawn = (device, surface)=>(typeof device?.drawnInto === 'function'
        ? device.drawnInto(surface) : null);
    return {
        /**
         * What a call the recorded device made changed that the device does not
         * count itself: writes through a lock or a context, a Reset.
         *
         * @param {any} target @param {string} name @param {any[]} args
         */
        observe(target, name, args){
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
            if (name === 'Reset')
            {
                readAt = new WeakMap();
            }
        },

        /**
         * `answeredByRenderer`, except for a copy out of a target whose memory
         * already holds the renderer's answer.
         *
         * @param {any} target @param {string} name @param {any[]} args
         */
        answered(target, name, args){
            if (name !== 'CopyRects')
            {
                return answeredByRenderer(target, name, args);
            }
            const source = args[0];
            const now = drawn(target, source);
            if (now !== null && readAt.get(source) === now)
            {
                return false;
            }

            const asked = answeredByRenderer(target, name, args);
            if (asked && now !== null)
            {
                readAt.set(args[0], now);
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
 *     counts: () => import('./replay.js').OcclusionCount[],
 *     read: (buffer: ArrayBufferLike, each: (call: import('./wire.js').ReadCall) => boolean | void,
 *         length?: number, start?: number)
 *         => number | undefined,
 *     spent: (buffer: ArrayBufferLike, give: () => void) => void,
 *     figures: () => import('../figures.js').FrameFigures | null }}
 *     `read` reads a batch of calls for `play`, and answers how long the look
 *     at its objects at a count of zero took when the batch made one; `figures`
 *     is the device made last's (`figures.js`), sent with every present
 */
export function playedDirect3D(factory, services){
    const played = playedOverMirror(memory=>factory({
        ...services,
        // Without memory of the caller's, nor does this one have any: a
        // device that draws refuses to be made so.
        readMemory: services.readMemory && memory.read,
        windowMemory: services.readMemory && memory.window,
        watchWrites: services.readMemory && memory.watch,
        writeMemory: services.writeMemory && memory.write,
        allocate: memory.allocate,
        free: memory.free,
        // The ramp reaches the display through the recorded device, which
        // the program sets it on; this one only has to know whether it does.
        gamma: services.gamma && { applies: ()=>services.gamma.applies(), set: ()=>{} },
    }), { write: services.writeMemory, borrow: services.borrow });
    const { root } = played;
    return {
        ...played,
        /** The device made last's figures (`figures.js`), sent with every present. */
        figures: ()=>root.figures?.() ?? null,
    };
}

/**
 * A carrier that plays each call where it is made: the recorded and the
 * played root in one thread.
 *
 * @param {Pick<ReturnType<typeof playedDirect3D>, 'read' | 'play' | 'spent'>} played
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
        // The batch is read off the writer's own buffer, which comes back to
        // be written on once nothing played from it keeps a view of it, as
        // the worker's batches do: a copy of each batch was a fresh buffer
        // for every call a program waits on.
        const { buffer, length } = writer.give();
        played.read(buffer, call=>{
            answer = played.play(call);
        }, length);
        played.spent(buffer, ()=>writer.reuse(buffer));
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
