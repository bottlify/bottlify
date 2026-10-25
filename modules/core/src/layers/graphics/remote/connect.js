/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The program's thread's end of the graphics worker (`worker.js`): each
 * Direct3D 7, 8 or 9 root and each OpenGL root made here is a recorded one
 * whose twin the worker plays, over a port of its own, and each frame the worker presents comes
 * back as a picture that is copied into a texture of this thread's device
 * and presented as a frame drawn here would be.
 */

import { createSender, sharedNow } from './channel.js';
import { createLendingBuffers, mayWait } from './lending.js';
import { recordedDirect3D } from './direct3d.js';
import { recordedDirect3D7 } from './d3d7.js';
import { recordedOpengl } from './opengl.js';

/** GPUTextureUsage, here without the browser's global. */
/**
 * The least time between batches of calls no call waits on: a millisecond
 * keeps the played side fed many times a frame, at a fraction of the
 * messages a batch a turn made.
 */
const BATCH_GAP_MS = 1;

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
 * @property {(api: 'd3d7' | 'd3d8' | 'd3d9' | 'opengl', factory: (services: any) => any,
 *     services: any) => any} root
 *     a root the program is given, whose twin the worker plays
 * @property {() => { roots: number, frames: number, dropped: number,
 *     waits: Record<string, { count: number, ms: number, maxMs: number }>, behind: number[],
 *     readBack: { sent: number, shared: number }, lent: Record<string, number>,
 *     sent: { batches: number, bytes: number, ms: number }, shipped: Record<string, number>,
 *     occlusion: { counted: number, ms: number, maxMs: number, polls: number, asks: number,
 *         beside: number, sentAfterMs: number, tripMs: number, under: number[], trace: any[] },
 *     calls: string, answers: string,
 *     phases: import('./channel.js').WorkerPhases | null,
 *     latency: import('./channel.js').FrameLatencyState | null,
 *     handoff: { frames: number, waitedMs: number, worstWaitedMs: number, thereMs: number,
 *         worstThereMs: number, showMs: number, worstShowMs: number,
 *         back: { count: number, ms: number, maxMs: number } | null } | null }}
 *     diagnostics  `handoff`: the frames the worker sent here, how long they waited there
 *     for the one before to be shown, their way here, showing them, and the answers' way
 *     back (null before a frame has come with its times); `phases`: where the worker's
 *     thread spent its time on this process's
 *     batches, summed over the roots that have answered a diagnostics ask (null before
 *     any has, or in a build that times nothing); `latency`: each root's bound on the
 *     frames the worker's GPU may still be drawing, with the presents that waited for it
 *     (`held`, `heldMs`), summed over the roots that have said it (null before any has);
 *     `waits`: what the program's thread waited on the worker for, by call;
 *     `readBack`: the bytes the worker wrote into guest memory, sent here to be written or
 *     written in shared memory in place; `lent`: the unlocked bytes lent to the worker rather
 *     than copied, those taken into the stash first, and the claims that waited; `sent`: the
 *     batches of calls posted to the worker, their bytes, copied guest memory included, and
 *     the milliseconds taking and posting them cost this thread;
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
 * @typedef {Object} Connection
 * @property {() => boolean} drew   whether a root of its plays on the worker
 * @property {(data: any) => void} frame
 * @property {() => void} lost
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
 * given to it over memory this thread shares with it; none where this thread
 * shares none, and the worker waits for each answer.
 *
 * @param {{ postMessage: (message: any) => void }} worker
 * @returns {Int32Array | null}
 */
const shownWordFor = worker=>{
    if (typeof SharedArrayBuffer !== 'function'
        || /** @type {any} */ (globalThis).crossOriginIsolated === false)
    {
        return null;
    }
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
 * @param {{ postMessage: (message: any) => void,
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
                    worker.postMessage({ type: 'shown', at: sharedNow(), serial: data.serial });
                    break;
                case 'lost':
                    for (const each of [...connections])
                    {
                        each.lost();
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
 * @param {number} [options.source]  the process this connection's roots draw for: its
 *     frames say so, for the screen composed of every process's picture
 * @param {(address: number, bytes: Uint8Array) => void} [options.writeMemory]
 *     guest memory the worker wrote for a call the program waited on: pixels read back
 * @param {() => Uint8Array | null} [options.sharedMemory]  the guest's RAM over a
 *     SharedArrayBuffer, which the worker then writes such pixels into itself; asked
 *     when a root is made, once the machine has memory
 * @param {(address: number, length: number) => void} [options.adoptMemory]
 *     told where the worker wrote the shared RAM, which this thread takes as its own write
 * @param {boolean} [options.lendMemory]  where the RAM is shared, whether what a Direct3D 8
 *     or 9 program unlocks is lent to the worker to read in place (`lending.js`) rather
 *     than copied to it; on unless false
 * @param {number} [options.maxFrameLatency]  the frames a root's presents may leave the
 *     worker's GPU drawing (`graphics.maxFrameLatency`); absent, Direct3D's three, 0 no bound
 * @param {(api: string, detail: string) => void} [options.divergence]
 * @param {() => void} [options.lost]    the worker's GPU went away
 * @param {(message: string) => void} [options.failed]  a root's calls could not be played
 * @returns {GraphicsWorkerEnd}
 */
export function connectGraphicsWorker(options){
    const { worker, device, presentTo, writeMemory, sharedMemory, adoptMemory, divergence, lost,
        failed, lendMemory = true, source, maxFrameLatency } = options;
    /** Whether this thread may wait on the worker, which a lend's claim may have to. */
    let mayBlock = /** @type {boolean | null} */ (null);
    /** @type {{ texture: any, view: any, width: number, height: number, format: string } | null} */
    let surface = null;
    /** @type {MessagePort[]} */
    const ports = [];
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
    };
    /** @param {number} ms */
    const rounded = ms=>Math.round(ms * 100) / 100;

    /** @type {Connection} */
    const connection = {
        drew: ()=>ports.length > 0,
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
        lost: ()=>lost?.(),
        refused: (message, seen)=>divergence?.('graphics', `the GPU refused a frame: ${message}`
            + (seen > 1 ? ` (x${seen})` : '')),
    };
    const leave = join(worker, connection);

    return {
        root(api, factory, services){
            const { port1, port2 } = new MessageChannel();
            ports.push(port1);
            const memory = sharedMemory?.() ?? null;
            const lending = memory && lendMemory && (api === 'd3d8' || api === 'd3d9')
                && (mayBlock ??= mayWait()) ? createLendingBuffers() : null;
            // The RAM goes only to a root that lends from it. JavaScriptCore counts
            // every buffer a thread holds as part of that thread's heap and lets
            // garbage grow in proportion before it collects it whole: the
            // graphics worker of a run with 512 MB of guest memory held as
            // much garbage again, and a phone's page was killed for it. A root
            // that does not lend has its read-backs written here, as bytes.
            worker.postMessage({ type: 'root', api, options: plainOf(services), port: port2,
                memory: lending ? memory : null, lending, source, frameLatency: maxFrameLatency },
            [port2]);
            const sender = createSender({
                post: (message, transfer)=>port1.postMessage(message, transfer),
                on: {
                    wrote: (address, bytes)=>{
                        readBack.sent += bytes.length;
                        writeMemory?.(address, bytes);
                    },
                    adopted: (address, length)=>{
                        readBack.shared += length;
                        adoptMemory?.(address, length);
                    },
                    divergence, lost, failed,
                },
                gapMs: BATCH_GAP_MS,
                lending: lending && memory && { ...lending, memory },
            });
            port1.onmessage = event=>sender.receive(event.data);
            senders.push(sender);
            switch (api)
            {
                case 'opengl':
                    return recordedOpengl(factory, services, sender);
                case 'd3d7':
                    return recordedDirect3D7(services.ddraw, services, sender);
                default:
                    return recordedDirect3D(factory, services, sender);
            }
        },
        answered: ()=>Promise.all(senders.map(sender=>sender.answered())).then(()=>{}),
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
            return { roots: ports.length, frames, dropped, waits,
                handoff: handoff.frames === 0 ? null : {
                    frames: handoff.frames,
                    waitedMs: rounded(handoff.waitedMs),
                    worstWaitedMs: rounded(handoff.worstWaitedMs),
                    thereMs: rounded(handoff.thereMs),
                    worstThereMs: rounded(handoff.worstThereMs),
                    showMs: rounded(handoff.showMs),
                    worstShowMs: rounded(handoff.worstShowMs),
                    back,
                },
                behind: senders.map(sender=>sender.behind()), readBack: { ...readBack },
                phases: phasesOf(senders),
                latency: latencyOf(senders),
                // One device serves the worker's roots: the first that said.
                gpuMemory: senders.map(sender=>sender.gpuMemory()).find(held=>held) ?? null,
                answers: senders.map(sender=>sender.answers()).join(' '),
                occlusion: senders.reduce((sum, sender)=>{
                    const one = sender.occlusion();
                    return { counted: sum.counted + one.counted, ms: sum.ms + one.ms,
                        maxMs: Math.max(sum.maxMs, one.maxMs), polls: sum.polls + one.polls,
                        asks: sum.asks + one.asks, beside: sum.beside + one.beside,
                        sentAfterMs: sum.sentAfterMs + one.sentAfterMs,
                        tripMs: sum.tripMs + one.tripMs, trace: [...sum.trace, ...one.trace],
                        under: one.under.map((count, index)=>count + (sum.under[index] ?? 0)) };
                }, { counted: 0, ms: 0, maxMs: 0, polls: 0, asks: 0, beside: 0, sentAfterMs: 0,
                    tripMs: 0, trace: /** @type {any[]} */ ([]),
                    under: /** @type {number[]} */ ([]) }),
                sent: senders.reduce((sum, sender)=>{
                    const { batches, bytes, ms } = sender.sent();
                    return { batches: sum.batches + batches, bytes: sum.bytes + bytes,
                        ms: Math.round(sum.ms + ms) };
                }, { batches: 0, bytes: 0, ms: 0 }),
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
                lent: lentOf(senders) };
        },
        dispose(){
            leave();
            for (const port of ports.splice(0))
            {
                port.postMessage({ type: 'close' });
                port.close();
            }
            surface?.texture.destroy();
            surface = null;
        },
    };
}
