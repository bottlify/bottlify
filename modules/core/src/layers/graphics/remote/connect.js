/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The program's thread's end of the graphics worker (`worker.js`): each
 * Direct3D 7, 8, 9 and 10 root and each OpenGL root made here is a recorded
 * one whose twin the worker plays, over two rings of its own (`ring.js`), and
 * each frame the worker presents comes back as a picture that is copied into
 * a texture of this thread's device and presented as a frame drawn here would
 * be.
 */

import { createSender, sharedNow } from './channel.js';
import { CALLS_BYTES, REPLIES_BYTES, createRingMemory } from './ring.js';
import { mayWait } from '../../../system/may-wait.js';
import { createLendingBuffers } from './lending.js';
import { recordedDirect3D } from './direct3d.js';
import { recordedDirect3D7 } from './d3d7.js';
import { recordedOpengl } from './opengl.js';
import { recordedDirect3D10 } from './d3d10.js';

/** GPUTextureUsage, here without the browser's global. */
/**
 * The least time between batches of calls no call waits on: a millisecond
 * keeps the played side fed many times a frame, at a fraction of the
 * messages a batch a turn made.
 */
const BATCH_GAP_MS = 1;

/**
 * The roots whose worker side keeps something in the run's cache, each under
 * names of its own, by the kind of names: the texels it holds past a call
 * (`internal/texel-store.js`), or a Direct3D 10 device's resource bytes, held
 * for each resource's life (`d3d10/render.js`). Every one of them holds its
 * scratches there too.
 *
 * @type {Readonly<Record<string, string>>}
 */
const OWNS_NAMES = Object.freeze({ opengl: 'texels', d3d8: 'texels', d3d9: 'texels',
    d3d10: 'resources' });

const USAGE = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/**
 * What of a root's services crosses to its twin: the plain values -- the
 * capabilities and the knobs -- and whether a full-screen gamma ramp reaches
 * the display. What draws, what reads memory and what is told of the
 * program's state are the worker's own.
 *
 * @param {Record<string, any>} services
 */
function plainOf(services){
    /** @type {Record<string, any>} */
    const options = {};
    for (const [key, value] of Object.entries(services))
    {
        if (typeof value === 'function' || key === 'backend' || key === 'gamma')
        {
            continue;
        }
        if (value !== null && typeof value === 'object'
            && Object.values(value).some(member=>typeof member === 'function'))
        {
            continue;
        }
        options[key] = value;
    }
    options.gamma = services.gamma?.applies?.() === true;
    return options;
}

/**
 * @typedef {Object} GraphicsWorkerEnd
 * @property {(api: 'd3d7' | 'd3d8' | 'd3d9' | 'd3d10' | 'opengl', factory: (services: any) => any,
 *     services: any, cache?: { join: (post: (message: any) => void) => any,
 *     serve: import('../../cache/module.js').Serve } | null) => any} root
 *     a root the program is given, whose twin the worker plays; `cache`, the run's,
 *     which the worker side keeps what no draw needs in
 * @property {() => import('./channel.js').WorkerFrameTimes | null} frameTimes
 *     the worker's frames over every root, summed, as of each one's last present
 * @property {() => import('../figures.js').FrameFigures | null} figures
 *     the played device's figures (`figures.js`) as of its last present
 * @property {() => import('./channel.js').WorkerPhases | null} phases
 *     where the worker's thread spent its time on this process's batches, summed
 *     over the roots, as each said it with its last present
 * @property {() => { roots: number, frames: number, dropped: number,
 *     waits: Record<string, { count: number, ms: number, maxMs: number }>, behind: number[],
 *     readBack: { sent: number, shared: number }, lent: Record<string, number>,
 *     sent: { batches: number, bytes: number, ms: number, made: number, grown: number,
 *         copied: number, spilled: number, inPlace: number, copiedIn: number, parts: number,
 *         waited: number, waiting: number },
 *     received: Record<string, number>, shipped: Record<string, number>,
 *     occlusion: { counted: number, ms: number, maxMs: number, polls: number, asks: number,
 *         beside: number, sentAfterMs: number, tripMs: number, under: number[], trace: any[] },
 *     calls: string, answers: string,
 *     phases: import('./channel.js').WorkerPhases | null,
 *     latency: import('./channel.js').FrameLatencyState | null,
 *     mirrored: number | null,
 *     handoff: { frames: number, waitedMs: number, worstWaitedMs: number, thereMs: number,
 *         worstThereMs: number, showMs: number, worstShowMs: number,
 *         back: { count: number, ms: number, maxMs: number } | null,
 *         buffers: ReturnType<import('./frame-rotation.js').FrameRotation['figures']>
 *             | null } | null }}
 *     diagnostics  `handoff`: the frames the worker sent here, how long they waited there
 *     for the one before to be shown, their way here, showing them, and the answers' way
 *     back, and the buffers frames sent as bytes crossed in, made and handed back (null
 *     while none came as bytes); null before a frame has come with its times;
 *     `phases`: where the worker's thread spent its time on this process's batches, summed
 *     over the roots that have presented or answered a diagnostics ask (null before any
 *     has, or in a build that times nothing); `latency`: each root's bound on the
 *     frames the worker's GPU may still be drawing, with the presents that waited for it
 *     (`held`, `heldMs`), summed over the roots that have said it (null before any has);
 *     `waits`: what the program's thread waited on the worker for, by call;
 *     `readBack`: the bytes the worker wrote into guest memory, sent here to be written or
 *     written in shared memory in place; `lent`: the unlocked bytes lent to the worker rather
 *     than copied, those taken into the stash first, and the claims that waited; `sent`: the
 *     batches of calls sent to the worker, their bytes, copied guest memory included, the
 *     milliseconds publishing them cost this thread, and the paths their records took
 *     through the ring (built in place, spilled, copied in, as parts, waiting for room);
 *     `shipped`: that guest memory by what copied it -- buffers' unlocks, surfaces' (lent ones
 *     aside), what calls read out of guest memory and what they wrote into it, and the bytes
 *     of dynamic buffers draws compared to find what to send (`compared`); `calls`: the
 *     methods whose records fill the batches, the heaviest first
 * @property {() => Promise<void>} answered
 *     settles once every root's played device has answered the diagnostics asked of it so
 *     far, or stopped
 * @property {() => void} dispose
 */

/**
 * What every root's lender lent, summed.
 *
 * @param {{ lender: import('./lending.js').Lender | null }[]} senders
 * @returns {Record<string, number>}
 */
const lentOf = senders=>{
    /** @type {Record<string, number>} */
    const sum = {};
    for (const { lender } of senders)
    {
        for (const [key, value] of Object.entries(lender?.diagnostics() ?? {}))
        {
            sum[key] = (sum[key] ?? 0) + value;
        }
    }
    return sum;
};

/**
 * The worker's phase totals summed over every root that has reported them.
 *
 * @param {{ phases: () => import('./channel.js').WorkerPhases | null }[]} senders
 * @returns {import('./channel.js').WorkerPhases | null}
 */
const phasesOf = senders=>{
    /** @type {import('./channel.js').WorkerPhases | null} */
    let sum = null;
    for (const sender of senders)
    {
        const phases = sender.phases();
        if (phases === null)
        {
            continue;
        }
        sum ??= { 'batch-read': { count: 0, ms: 0, selfMs: 0 },
            'batch-sweep': { count: 0, ms: 0 } };
        sum['batch-read'].count += phases['batch-read'].count;
        sum['batch-read'].ms += phases['batch-read'].ms;
        sum['batch-read'].selfMs += phases['batch-read'].selfMs;
        sum['batch-sweep'].count += phases['batch-sweep'].count;
        sum['batch-sweep'].ms += phases['batch-sweep'].ms;
    }
    return sum;
};

/**
 * Every root's GPU bound, as each said it last: its frames and the presents
 * it held summed, the most frames any was behind, and the bound they were
 * held to. Null before any root has said one.
 *
 * @param {{ latency: () => import('./channel.js').FrameLatencyState | null }[]} senders
 * @returns {import('./channel.js').FrameLatencyState | null}
 */
const latencyOf = senders=>{
    /** @type {import('./channel.js').FrameLatencyState | null} */
    let sum = null;
    for (const sender of senders)
    {
        const one = sender.latency();
        if (one === null)
        {
            continue;
        }
        sum = sum === null ? { ...one } : {
            limit: Math.max(sum.limit, one.limit),
            counting: sum.counting || one.counting,
            inFlight: Math.max(sum.inFlight, one.inFlight),
            peak: Math.max(sum.peak, one.peak),
            frames: sum.frames + one.frames,
            held: sum.held + one.held,
            heldMs: sum.heldMs + one.heldMs,
            waiting: sum.waiting + one.waiting,
            timed: (sum.timed ?? 0) + (one.timed ?? 0),
            toQueueMs: (sum.toQueueMs ?? 0) + (one.toQueueMs ?? 0),
            gpuMs: (sum.gpuMs ?? 0) + (one.gpuMs ?? 0),
        };
    }
    return sum;
};

/**
 * A message port as `connectGraphicsWorker` takes a worker: a process's way
 * in to the graphics worker, or the way its own pictures come in.
 *
 * @param {MessagePort} port
 */
export function portEnd(port){
    // A port listened to through `addEventListener` delivers nothing until started.
    port.start();
    return {
        /** @param {any} message @param {Transferable[]} [transfer] */
        postMessage: (message, transfer)=>port.postMessage(message, transfer ?? []),
        /** @param {'message'} type @param {(event: { data: any }) => void} listener */
        addEventListener: (type, listener)=>port.addEventListener(type, listener),
        /** @param {'message'} type @param {(event: { data: any }) => void} listener */
        removeEventListener: (type, listener)=>port.removeEventListener(type, listener),
    };
}

/**
 * Hands the run's graphics worker its backend's own names in the run's cache,
 * which its scratches are held under (`worker.js`): an owner of the run's,
 * numbered by the keeper, and the segments made and let go of after, told to
 * it until `leave`. By the thread that holds the keeper, once a run: what it
 * holds goes with the run, or with the worker's end of the channel. Nothing
 * where the run has no cache to serve.
 *
 * @param {{ postMessage: (message: any) => void }} worker
 * @param {{ join: import('../../cache/module.js').Join,
 *     serve: import('../../cache/module.js').Serve }} cache
 * @returns {{ prefix: string, leave: () => void } | null}
 */
export function lendBackend(worker, cache){
    const served = cache.serve('scratch');
    const joined = served && cache.join(message=>worker.postMessage({ type: 'cache', message }));
    if (!served || !joined)
    {
        return null;
    }
    worker.postMessage({ type: 'backend',
        cache: { shared: joined.shared, segments: joined.segments, ...served } });
    return { prefix: served.prefix, leave: joined.leave };
}

/**
 * @typedef {Object} Connection
 * @property {() => boolean} drew   whether a root of its plays on the worker
 * @property {(data: any) => void} frame
 * @property {(reason?: string, message?: string, recent?: string[]) => void} lost
 *     the device gone, with the last things it was asked to make
 * @property {(message: string, seen: number) => void} refused  the worker's GPU
 *     refused a command buffer, and with it a frame
 */

/**
 * The connections onto each graphics worker. Every process the run starts on
 * this thread connects to the one worker, and the worker keeps one picture
 * for all of them: so each frame is shown once, by one connection, and the
 * worker told once that it was, or the next would be sent twice over and a
 * transferred picture copied after it was given back.
 *
 * @type {WeakMap<object, { connections: Connection[], listener: (event: { data: any }) => void }>}
 */
const onWorker = new WeakMap();

/** The roots made on this thread, over every connection: the number each is named by. */
let rootsMade = 0;

/**
 * Who shows a frame: the newest connection that draws there -- a child that
 * draws beside its parent is the one on top -- or the newest of all.
 *
 * @param {Connection[]} connections
 */
const showing = connections=>{
    for (let at = connections.length - 1; at >= 0; at--)
    {
        if (connections[at].drew())
        {
            return connections[at];
        }
    }
    return connections.at(-1);
};

/**
 * The word a graphics worker reads to know that a frame it sent was shown,
 * given to it over memory this thread shares with it; none where the worker
 * cannot be told (it then waits for each answer).
 *
 * @param {{ postMessage: (message: any) => void }} worker
 * @returns {Int32Array | null}
 */
const shownWordFor = worker=>{
    const word = new Int32Array(new SharedArrayBuffer(4));
    try
    {
        worker.postMessage({ type: 'showing', word });
    }
    catch {
        return null;
    }
    return word;
};

/**
 * Tells the worker a frame is on this thread's queue. A frame sent as bytes
 * was copied onto the device as it was shown, so its buffer goes back with
 * the answer for a later frame to be written into (`frame-rotation.js`).
 *
 * @param {{ postMessage: (message: any, transfer?: Transferable[]) => void }} worker
 * @param {any} data  the frame's message
 */
const answerShown = (worker, data)=>{
    const answer = { type: 'shown', at: sharedNow(), serial: data.serial };
    const buffer = data.pixels?.buffer;
    if (buffer instanceof ArrayBuffer && buffer.byteLength > 0)
    {
        worker.postMessage({ ...answer, pixels: buffer }, [buffer]);
        return;
    }
    worker.postMessage(answer);
};

/**
 * @param {{ postMessage: (message: any, transfer?: Transferable[]) => void,
 *     addEventListener: (type: 'message', listener: (event: { data: any }) => void) => void,
 *     removeEventListener: (type: 'message', listener: (event: { data: any }) => void) => void }}
 *     worker
 * @param {Connection} connection
 * @returns {() => void}  leaves
 */
function join(worker, connection){
    let shared = onWorker.get(worker);
    if (!shared)
    {
        /** @type {Connection[]} */
        const connections = [];
        const word = shownWordFor(worker);
        /** @param {{ data: any }} event */
        const listener = ({ data })=>{
            switch (data?.type)
            {
                case 'frame':
                    showing(connections)?.frame(data);
                    // Read at the worker's next present: the answer may wait
                    // there behind every batch it has yet to play.
                    if (word && typeof data.serial === 'number')
                    {
                        Atomics.store(word, 0, data.serial);
                    }
                    // The worker sends the next once this one is on this thread's queue.
                    answerShown(worker, data);
                    break;
                case 'lost':
                    for (const each of [...connections])
                    {
                        each.lost(data.reason, data.message, data.recent);
                    }
                    break;
                case 'refused':
                    // One GPU, told once, by whichever connection shows it.
                    showing(connections)?.refused(data.message, data.seen);
                    break;

                default:
                    break;
            }
        };
        shared = { connections, listener };
        onWorker.set(worker, shared);
        worker.addEventListener('message', listener);
    }
    const { connections, listener } = shared;
    connections.push(connection);
    return ()=>{
        const at = connections.indexOf(connection);
        if (at < 0)
        {
            return;
        }
        connections.splice(at, 1);
        if (connections.length === 0)
        {
            worker.removeEventListener('message', listener);
            onWorker.delete(worker);
        }
    };
}

/**
 * @param {Object} options
 * @param {{ postMessage: (message: any, transfer?: Transferable[]) => void,
 *     addEventListener: (type: 'message', listener: (event: { data: any }) => void) => void,
 *     removeEventListener: (type: 'message', listener: (event: { data: any }) => void) => void }}
 *     options.worker  a graphics worker that has answered `open`
 * @param {any} [options.device]  this thread's GPU device, which a frame is copied onto
 * @param {(frame: { surface: any, frameIndex: number, source?: number }) => void}
 *     [options.presentTo]  where a frame goes, as the backend of this thread hands its
 *     own on, with the process that drew it where the worker was told
 * @param {() => void} [options.framePlayed]  where this thread shows no frames (no
 *     `presentTo`): told each time the worker has played one of its presents, where
 *     its frame ends for the journal
 * @param {number} [options.source]  the process this connection's roots draw for: its
 *     frames say so, for the screen composed of every process's picture
 * @param {(address: number, bytes: Uint8Array) => void} [options.writeMemory]
 *     guest memory the worker wrote for a call the program waited on: pixels read back
 * @param {() => Uint8Array | null} [options.sharedMemory]  the guest's RAM over a
 *     SharedArrayBuffer, which the worker then writes such pixels into itself; asked
 *     when a root is made, once the machine has memory
 * @param {(listener: () => void) => void} [options.memoryGrown]  told each time the
 *     guest's memory grows (the memory layer's `onGrow`): a root that lends from it is
 *     sent the longer view, ahead of any batch that may lend from what it gained
 * @param {(address: number, length: number) => void} [options.adoptMemory]
 *     told where the worker wrote the shared RAM, which this thread takes as its own write
 * @param {number} [options.maxFrameLatency]  the frames a root's presents may leave the
 *     worker's GPU drawing (`graphics.maxFrameLatency`); absent, Direct3D's three, 0 no bound
 * @param {(api: string, detail: string, severity?: 'loss') => void} [options.divergence]
 * @param {() => void} [options.lost]    the worker's GPU went away
 * @param {(message: string) => void} [options.failed]  a root's calls could not be played
 * @returns {GraphicsWorkerEnd}
 */
export function connectGraphicsWorker(options){
    const { worker, device, presentTo, framePlayed, writeMemory, sharedMemory, memoryGrown,
        adoptMemory, divergence, lost,
        failed, source, maxFrameLatency } = options;
    /** Whether this thread may wait on the worker, which a lend's claim may have to. */
    let mayBlock = /** @type {boolean | null} */ (null);
    /** @type {{ texture: any, view: any, width: number, height: number, format: string } | null} */
    let surface = null;
    /** The roots made, numbered as the worker is told of them. */
    let roots = 0;
    /** Each root's join to the run's cache, let go of with the process. @type {(() => void)[]} */
    const leaves = [];
    /** @type {ReturnType<typeof createSender>[]} */
    const senders = [];
    let frames = 0;
    const readBack = { sent: 0, shared: 0 };

    /**
     * @param {{ bitmap?: any, pixels?: Uint8Array, bytesPerRow?: number, width?: number,
     *     height?: number, frameIndex: number, format: string, source?: number }} frame
     */
    const present = ({ bitmap, pixels, bytesPerRow, frameIndex, format, source: drewFor,
        ...size })=>{
        if (!device || !presentTo)
        {
            bitmap?.close?.();
            return;
        }
        // A frame counted, not sent: presented with no picture to show.
        if (!bitmap && !pixels)
        {
            frames++;
            presentTo(drewFor === undefined ? { surface: null, frameIndex }
                : { surface: null, frameIndex, source: drewFor });
            return;
        }
        const width = bitmap ? bitmap.width : /** @type {number} */ (size.width);
        const height = bitmap ? bitmap.height : /** @type {number} */ (size.height);
        if (!surface || surface.width !== width || surface.height !== height
            || surface.format !== format)
        {
            surface?.texture.destroy();
            const texture = device.createTexture({
                label: 'graphics-worker-frame',
                size: [width, height],
                format,
                usage: USAGE.COPY_SRC | USAGE.COPY_DST | USAGE.TEXTURE_BINDING
                    | USAGE.RENDER_ATTACHMENT,
            });
            surface = { texture, view: texture.createView(), width, height, format };
        }
        // The queue keeps the copy behind the presenter's use of the last
        // frame, so one texture serves every frame.
        if (bitmap)
        {
            try
            {
                device.queue.copyExternalImageToTexture({ source: bitmap },
                    { texture: surface.texture }, [width, height]);
            }
            catch (e){
                // Safari refuses a picture taken from the worker's WebGPU
                // canvas as an external image (InvalidStateError). The worker
                // sends the frames as bytes from the next on; this one is not
                // shown.
                bitmap.close?.();
                if (/** @type {any} */ (e)?.name !== 'InvalidStateError')
                {
                    throw e;
                }
                worker.postMessage({ type: 'frames', frames: 'pixels' });
                return;
            }
            bitmap.close?.();
        }
        else
        {
            device.queue.writeTexture({ texture: surface.texture }, pixels, { bytesPerRow },
                [width, height]);
        }
        frames++;
        presentTo(drewFor === undefined ? { surface, frameIndex }
            : { surface, frameIndex, source: drewFor });
    };

    /** Frames the worker presented and replaced before they were sent. */
    let dropped = 0;
    /**
     * The way of the frames the worker sent: how long each waited there,
     * once presented, for the one before it to be shown (`waited`), its
     * way here (`there`), taking it onto this thread's device and the
     * presenter (`show`), and, as the worker timed it, the answer's way
     * back (`back`). The worker sends one at a time, so these bound the
     * frames shown a second whatever it draws: a frame is dropped there
     * when a newer one comes before the answer.
     */
    const handoff = { frames: 0, waitedMs: 0, worstWaitedMs: 0, thereMs: 0, worstThereMs: 0,
        showMs: 0, worstShowMs: 0 };
    /** The answers' way back, as the worker said with its last frame. @type {any} */
    let back = null;
    /** The buffers frames come in as bytes, as the worker said with its last such frame. @type {any} */
    let buffers = null;
    /** @param {any} data @param {number} arrived @param {number} took */
    const handed = (data, arrived, took)=>{
        const waited = Math.max(0, Number(data.waitedMs) || 0);
        const there = Math.max(0, arrived - data.sentAt);
        handoff.frames++;
        handoff.waitedMs += waited;
        handoff.worstWaitedMs = Math.max(handoff.worstWaitedMs, waited);
        handoff.thereMs += there;
        handoff.worstThereMs = Math.max(handoff.worstThereMs, there);
        handoff.showMs += took;
        handoff.worstShowMs = Math.max(handoff.worstShowMs, took);
        back = data.back ?? back;
        buffers = data.buffers ?? buffers;
    };
    /** @param {number} ms */
    const rounded = ms=>Math.round(ms * 100) / 100;

    /** @type {Connection} */
    const connection = {
        drew: ()=>roots > 0,
        /** @param {any} data */
        frame: data=>{
            const arrived = sharedNow();
            dropped = data.dropped ?? dropped;
            present(data);
            if (typeof data.sentAt === 'number')
            {
                handed(data, arrived, sharedNow() - arrived);
            }
        },
        // Said with WebGPU's reason and message: a device lost is every frame
        // after it lost, and why is the whole question.
        lost: (reason, message, recent)=>{
            divergence?.('graphics', `the GPU device was lost (${reason ?? 'unknown'})`
                + (message ? `: ${message}` : '')
                + (recent?.length ? `; last made: ${recent.join('; ')}` : ''), 'loss');
            lost?.();
        },
        refused: (message, seen)=>divergence?.('graphics', `the GPU refused a frame: ${message}`
            + (seen > 1 ? ` (x${seen})` : ''), 'loss'),
    };
    const leave = join(worker, connection);

    return {
        /**
         * @param {string} api @param {any} factory @param {any} services
         * @param {{ join: (post: (message: any) => void) => any,
         *     serve: import('../../cache/module.js').Serve } | null} [cache]  the run's cache,
         *     which the worker side of a root keeps its texels (OpenGL's idle levels,
         *     Direct3D 8 and 9's uploads waiting for their frame), its resources' bytes
         *     (Direct3D 10) and its scratches in, names of its own (`OWNS_NAMES`)
         */
        root(api, factory, services, cache = null){
            // Numbered across every connection on this thread's worker, as
            // its messages name the root.
            const id = ++rootsMade;
            roots++;
            const rings = { calls: createRingMemory(CALLS_BYTES),
                replies: createRingMemory(REPLIES_BYTES) };
            // Joined to the run's cache: the segments made and let go after
            // reach the worker's side of the root by message, which carries
            // memory as a ring cannot. The root is the owner of its names,
            // let go of when it goes.
            const served = api in OWNS_NAMES ? cache?.serve(OWNS_NAMES[api]) ?? null : null;
            const joined = served === null ? null
                : cache?.join((/** @type {any} */ message)=>worker.postMessage({ type: 'cache',
                    root: id, message })) ?? null;
            if (joined)
            {
                leaves.push(joined.leave);
            }
            const memory = sharedMemory?.() ?? null;
            const lending = memory && (api === 'd3d8' || api === 'd3d9')
                && (mayBlock ??= mayWait()) ? createLendingBuffers() : null;
            // The RAM goes only to a root that lends from it. JavaScriptCore counts
            // every buffer a thread holds as part of that thread's heap and lets
            // garbage grow in proportion before it collects it whole: the
            // graphics worker of a run with 512 MB of guest memory held as
            // much garbage again, and a phone's page was killed for it. A root
            // that does not lend has its read-backs written here, as bytes.
            worker.postMessage({ type: 'root', id, api, options: plainOf(services), rings,
                memory: lending ? memory : null, lending, source, frameLatency: maxFrameLatency,
                cache: joined && served
                    ? { shared: joined.shared, segments: joined.segments, ...served } : null });
            const sender = createSender({
                rings,
                on: {
                    wrote: (address, bytes)=>{
                        readBack.sent += bytes.length;
                        writeMemory?.(address, bytes);
                    },
                    adopted: (address, length)=>{
                        readBack.shared += length;
                        adoptMemory?.(address, length);
                    },
                    // Where this thread shows none of its frames (a process in
                    // a worker of its own), a frame ends where it was played.
                    presented: ()=>{
                        if (!presentTo)
                        {
                            framePlayed?.();
                        }
                    },
                    divergence, lost, failed,
                },
                gapMs: BATCH_GAP_MS,
                lending: lending && memory && { ...lending, memory },
            });
            if (lending)
            {
                let grown = 0;
                memoryGrown?.(()=>{
                    const now = sharedMemory?.() ?? null;
                    if (now !== null && !sender.closed())
                    {
                        grown++;
                        worker.postMessage({ type: 'memory', root: id, memory: now,
                            number: grown });
                        sender.grew(grown);
                    }
                });
            }
            senders.push(sender);
            switch (api)
            {
                case 'opengl':
                    return recordedOpengl(factory, services, sender);
                case 'd3d7':
                    return recordedDirect3D7(services.ddraw, services, sender);
                case 'd3d10':
                    return recordedDirect3D10(factory, services, sender);
                default:
                    // Where the worker shares the guest's memory it writes the
                    // occlusion counts into the query blocks itself.
                    return recordedDirect3D(factory,
                        { ...services, countsInGuest: Boolean(lending) }, sender);
            }
        },
        answered: ()=>Promise.all(senders.map(sender=>sender.answered())).then(()=>{}),
        /**
         * The worker's frames over every root, as of each one's last present
         * (`WorkerFrameTimes`), or null before any root has presented.
         *
         * @returns {import('./channel.js').WorkerFrameTimes | null}
         */
        frameTimes: ()=>senders.reduce((/** @type {any} */ sum, sender)=>{
            const one = sender.frameTimes();
            return one === null ? sum : { frames: (sum?.frames ?? 0) + one.frames,
                toQueueMs: (sum?.toQueueMs ?? 0) + one.toQueueMs,
                gpuMs: (sum?.gpuMs ?? 0) + one.gpuMs,
                replayMs: (sum?.replayMs ?? 0) + one.replayMs };
        }, null),
        /**
         * The played device's figures (`figures.js`) as of the last present of
         * the first root that has presented, or null before any has. One
         * device draws a program's frames; a root made only to ask what the
         * hardware does never presents.
         *
         * @returns {import('../figures.js').FrameFigures | null}
         */
        figures: ()=>senders.map(sender=>sender.figures()).find(one=>one !== null) ?? null,
        /** The worker's phase totals over every root, as each said them last; null before. */
        phases: ()=>phasesOf(senders),
        diagnostics: ()=>{
            /** @type {Record<string, { count: number, ms: number, maxMs: number, queuedMs: number,
             *     heldMs: number, backMs: number }>} */
            const waits = {};
            for (const sender of senders)
            {
                for (const [name, held] of Object.entries(sender.waits()))
                {
                    const sum = waits[name] ??= { count: 0, ms: 0, maxMs: 0, queuedMs: 0, heldMs: 0,
                        backMs: 0 };
                    sum.count += held.count;
                    sum.ms += held.ms;
                    sum.maxMs = Math.max(sum.maxMs, held.maxMs);
                    sum.queuedMs += held.queuedMs ?? 0;
                    sum.heldMs += held.heldMs ?? 0;
                    sum.backMs += held.backMs ?? 0;
                }
            }
            return { roots, frames, dropped, waits,
                handoff: handoff.frames === 0 ? null : {
                    frames: handoff.frames,
                    waitedMs: rounded(handoff.waitedMs),
                    worstWaitedMs: rounded(handoff.worstWaitedMs),
                    thereMs: rounded(handoff.thereMs),
                    worstThereMs: rounded(handoff.worstThereMs),
                    showMs: rounded(handoff.showMs),
                    worstShowMs: rounded(handoff.worstShowMs),
                    back,
                    buffers,
                },
                behind: senders.map(sender=>sender.behind()), readBack: { ...readBack },
                phases: phasesOf(senders),
                latency: latencyOf(senders),
                // One device serves the worker's roots: the first that said.
                gpuMemory: senders.map(sender=>sender.gpuMemory()).find(held=>held) ?? null,
                // Each root's mirror of the program's memory, as each said it
                // last; null while one has not said.
                mirrored: senders.reduce((/** @type {number | null} */ sum, sender)=>{
                    const held = sender.mirrored();
                    return sum === null || held === null ? null : sum + held;
                }, 0),
                answers: senders.map(sender=>sender.answers()).join(' '),
                occlusion: senders.reduce((sum, sender)=>{
                    const one = sender.occlusion();
                    return { counted: sum.counted + one.counted, ms: sum.ms + one.ms,
                        maxMs: Math.max(sum.maxMs, one.maxMs), polls: sum.polls + one.polls,
                        asks: sum.asks + one.asks, beside: sum.beside + one.beside,
                        sentAfterMs: sum.sentAfterMs + one.sentAfterMs,
                        tripMs: sum.tripMs + one.tripMs, trace: [...sum.trace, ...one.trace],
                        under: one.under.map((count, index)=>count + (sum.under[index] ?? 0)),
                        abandoned: one.abandoned ? {
                            count: sum.abandoned.count + one.abandoned.count,
                            ms: sum.abandoned.ms + one.abandoned.ms,
                            maxMs: Math.max(sum.abandoned.maxMs, one.abandoned.maxMs),
                            polls: sum.abandoned.polls + one.abandoned.polls,
                            asks: sum.abandoned.asks + one.abandoned.asks,
                            trace: [...sum.abandoned.trace, ...one.abandoned.trace],
                        } : sum.abandoned };
                }, { counted: 0, ms: 0, maxMs: 0, polls: 0, asks: 0, beside: 0, sentAfterMs: 0,
                    tripMs: 0, trace: /** @type {any[]} */ ([]),
                    under: /** @type {number[]} */ ([]),
                    abandoned: { count: 0, ms: 0, maxMs: 0, polls: 0, asks: 0,
                        trace: /** @type {any[]} */ ([]) } }),
                // Everything the worker's side of a root said back, by type:
                // with `sent.batches`, the records a frame costs both ways.
                received: senders.reduce((sum, sender)=>{
                    for (const [type, count] of Object.entries(sender.received()))
                    {
                        sum[type] = (sum[type] ?? 0) + count;
                    }
                    return sum;
                }, /** @type {Record<string, number>} */ ({})),
                sent: senders.reduce((sum, sender)=>{
                    /** @type {Record<string, number>} */
                    const one = sender.sent();
                    /** @type {Record<string, number>} */
                    const out = {};
                    for (const [key, value] of Object.entries(sum))
                    {
                        out[key] = value + (one[key] ?? 0);
                    }
                    out.ms = Math.round(out.ms);
                    return /** @type {typeof sum} */ (out);
                }, { batches: 0, bytes: 0, ms: 0, made: 0, grown: 0, copied: 0, spilled: 0,
                    inPlace: 0, copiedIn: 0, parts: 0, waited: 0, waiting: 0 }),
                // The guest bytes copied into those batches, by what copied
                // them: what lending buffers would have left in place.
                // A diagnostic's (`checkDraws`): draws whose bytes the played
                // side had otherwise, with the first of them.
                ...(senders.some(sender=>(sender.drawChecks?.() ?? []).length > 0)
                    ? { drawChecks: senders.flatMap(sender=>sender.drawChecks?.() ?? []) }
                    : {}),
                shipped: senders.reduce((sum, sender)=>{
                    for (const [kind, bytes] of Object.entries(sender.shippedBytes()))
                    {
                        sum[kind] = (sum[kind] ?? 0) + bytes;
                    }
                    return sum;
                }, /** @type {Record<string, number>} */ ({})),
                // The methods whose records fill the batches, the heaviest
                // first, as "name calls bytes".
                calls: (()=>{
                    /** @type {Map<string, { count: number, bytes: number }>} */
                    const sum = new Map();
                    for (const sender of senders)
                    {
                        for (const { name, count, bytes } of sender.methodBytes())
                        {
                            const entry = sum.get(name) ?? { count: 0, bytes: 0 };
                            entry.count += count;
                            entry.bytes += bytes;
                            sum.set(name, entry);
                        }
                    }
                    return [...sum].sort(([, a], [, b])=>b.bytes - a.bytes).slice(0, 24)
                        .map(([name, { count, bytes }])=>`${name} ${count} ${bytes}`).join(' | ');
                })(),
                lent: lentOf(senders),
                // Every process's connection onto this worker that has not
                // left it: one a process that ended still counts here holds
                // that process's memory through its frames' handlers.
                joined: onWorker.get(worker)?.connections.length ?? 0 };
        },
        dispose(){
            leave();
            for (const leaveCache of leaves.splice(0))
            {
                leaveCache();
            }
            // Their rings closed, the worker's side of each root ends.
            for (const sender of senders)
            {
                sender.close();
            }
            surface?.texture.destroy();
            surface = null;
        },
    };
}
