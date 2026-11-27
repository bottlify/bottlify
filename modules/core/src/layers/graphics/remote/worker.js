/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics worker: Direct3D 7, 8 and 9 devices and OpenGL contexts played
 * on a GPU device of its own, off the thread the program runs on.
 *
 * The program's thread makes a root it records (`direct3d.js`) and sends
 * its twin here with two rings of its own (`ring.js`): its calls come in on
 * one (`channel.js`) and are played on a device that renders, and what the
 * played side says goes back on the other. What the renderer
 * presents comes back to the program's thread as a picture, for the run's
 * presenter to show as it shows every other: the canvas, the gamma ramp and
 * the cursor stay where they are.
 *
 * Messages to the worker:
 *   { type: 'shown', at, serial }    the program's thread has shown the frame `serial`;
 *                                    the next goes when the one sent last has. `at`
 *                                    when it said so, on the clock both read (`sharedNow`)
 *   { type: 'showing', word }        an Int32Array over shared memory where the program's
 *                                    thread writes the `serial` of each frame it shows,
 *                                    before it answers `shown`: read at each present
 *   { type: 'open', frames, capture } `frames` 'bitmap' sends each presented
 *                                    frame back as a picture, 'pixels' as its
 *                                    bytes read back, 'count' says only that
 *                                    one was presented; anything else keeps them.
 *                                    Answered every time it is asked. `capture`
 *                                    true writes down everything sent from then
 *                                    on (`capture.js`), for `tools/read/graphics-replay.mjs`
 *   { type: 'root', id, api, options, rings, memory, lending, source, frameLatency, cache }
 *                                    `id` the number the messages below name it by,
 *                                    `api` 'd3d7', 'd3d8', 'd3d9', 'd3d10' or 'opengl',
 *                                    `options` the plain part of what the root was
 *                                    made with; `rings` its calls' and its replies'
 *                                    (`RootRings`), a close of which ends it;
 *                                    `memory` the guest's RAM where it is shared, and
 *                                    `lending` the slots and stash a Direct3D 8 or 9
 *                                    root lends guest memory through (`lending.js`);
 *                                    `source` the process it draws for, which its
 *                                    frames carry back; `frameLatency` the frames its
 *                                    presents may leave the GPU drawing (`latency.js`;
 *                                    absent, Direct3D's three, 0 no bound); `cache` the
 *                                    run's, which an OpenGL, Direct3D 8 or 9 root keeps
 *                                    the texels it holds past a call in
 *   { type: 'memory', root, memory, number }  root `root`'s guest memory grew: the
 *                                    longer view, the `number`th, which the batches
 *                                    sent after its mark wait for (`KIND.MARK`)
 *   { type: 'cache', root, message } what the run's cache says to root `root`'s join
 *                                    to it: segments made and let go of; with no
 *                                    `root`, to the backend's
 *   { type: 'backend', cache }       the backend's own names in the run's cache, from
 *                                    the run's thread, once (`lendBackend` in
 *                                    connect.js): `{ shared, segments, channel, prefix }`,
 *                                    which its scratches are held under
 *   { type: 'client', port, client } a way in for a process on another thread: `root`,
 *                                    `memory` and `cache` on the port are taken as they
 *                                    are here, and `lost` is told there too; its frames
 *                                    come here, as every root's do, to the thread that
 *                                    shows them. `{ type: 'close' }` on the port ends it
 *   { type: 'forget', client }       the process on the other end of client `client`
 *                                    is gone, however it went: the port goes, and
 *                                    every root made through it, as each one's
 *                                    `close` would
 * Messages from it -- what a root's played side says goes back on its ring:
 *   { type: 'opened', adapter } | { type: 'failed', message }
 *   { type: 'frame', bitmap, frameIndex, format, dropped, source, serial, sentAt, waitedMs,
 *     back }
 *   { type: 'frame', pixels, bytesPerRow, width, height, frameIndex, format, dropped, source,
 *     serial, sentAt, waitedMs, back }  `pixels` a view of memory held in the run's cache,
 *                                    read in place there and let go of at its `shown`
 *   { type: 'unshown', message }     a frame read back found no room in the run's cache
 *   { type: 'frame', frameIndex, source }  under 'count', every frame presented
 *                                    one at a time, the newest presented of a process,
 *                                    the processes in turn; `serial` counts the frames
 *                                    sent, `dropped` those a newer one replaced unsent,
 *                                    `sentAt` when it went, `waitedMs` how long since it
 *                                    was presented, and `back` the `shown` answers so
 *                                    far, the milliseconds they took to come and the
 *                                    frames the shared word let go before them (`early`)
 *   { type: 'lost', reason }
 *   { type: 'captured', bytes, counts }  the capture, ended, as `{ type: 'debug',
 *                                    captured: true }` asked; `bytes` null without one
 *
 * Frames stay messages: a picture is an ImageBitmap, which only a message can
 * carry, and its bytes, where it goes as bytes, are moved with it; one is in
 * flight at a time.
 */

import { createDirect3D8 } from '../d3d8/device.js';
import { dumpDigits, srgbHonoured } from '../d3d8/render.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createOpenglRoot } from '../opengl/root.js';
import { createBackend } from '../webgpu/backend.js';
import { createFrameLatency } from '../webgpu/internal/latency.js';
import { trackDevice } from '../webgpu/ledger.js';
import { createCapture } from './capture.js';
import { SAID_STRINGS, createReceiver, sharedNow } from './channel.js';
import { KIND, openRingOut } from './ring.js';
import { createBorrower } from './lending.js';
import { playedDirect3D } from './direct3d.js';
import { storeCount as storeCountIn } from '../seam/block.js';
import { playedOpengl } from './opengl.js';
import { playedDirect3D7 } from './d3d7.js';
import { playedDirect3D10 } from './d3d10.js';
import { createDirect3D10 } from '../d3d10/root.js';
import { gpuFeaturesOf, gpuLimitsOf } from '../webgpu/features.js';
import { channelSpace } from '../../cache/module.js';
import { createScratches, plainHold } from '../../cache/scratch.js';

/** @type {Record<string, (services: any) => any>} */
const FACTORIES = { d3d8: createDirect3D8, d3d9: createDirect3D9 };

/** GPUTextureUsage.COPY_SRC and COPY_DST, here without the browser's global. */
const COPY_SRC = 0x01;
const COPY_DST = 0x02;
/** GPUBufferUsage.MAP_READ and COPY_DST, and GPUMapMode.READ. */
const BUFFER_MAP_READ = 0x01;
const BUFFER_COPY_DST = 0x08;
const MAP_READ = 0x01;

/**
 * @param {{ postMessage: (message: any, transfer?: Transferable[]) => void,
 *     onmessage: ((event: { data: any }) => void) | null }} scope
 * @param {{ gpu: any, canvas?: (width: number, height: number) => any, driven?: boolean,
 *     hold?: import('../../cache/scratch.js').Hold }} deps
 *     `canvas` makes the canvas a frame is copied into to become a picture;
 *     `driven`, the roots' batches are played when `take` is called rather than
 *     as their bells ring: for a tool that times each batch's play on its own
 *     thread (`tools/read/graphics-replay.mjs`); `hold`, where the roots and the
 *     backend hold their memory when served on a thread that holds a cache of
 *     its own rather than by the run's names (a tool's, a test's)
 */
export function serveGraphics(scope, deps){
    const { gpu, canvas = (width, height)=>new OffscreenCanvas(width, height),
        driven = false, hold = null } = deps;
    /** @type {Promise<{ device: any, backend: any, adapter: any }> | null} */
    let opened = null;
    /** Where frames go: back to the program's thread as pictures, or nowhere. */
    let frames = 'none';
    /** @type {any} */
    let screen = null;
    /** @type {string | null} */
    let configured = null;
    /** @type {Set<() => void>} */
    const losers = new Set();
    let lost = false;
    /** The ports of processes on other threads, told when the GPU goes away. @type {Set<MessagePort>} */
    const clients = new Set();
    /**
     * Each client's port and the ends of the roots made through it, by the
     * number the run named it with: what `forget` lets go of.
     *
     * @type {Map<number, { port: MessagePort, ends: Set<() => void> }>}
     */
    const byClient = new Map();
    /**
     * What a root is told by message rather than on its ring -- memory, which
     * a ring cannot carry -- by the way in it came through and its number.
     *
     * @typedef {{ memory: (memory: Uint8Array | null, number: number) => void,
     *     cache: (message: any) => void }} RootControl
     * @type {Map<number, RootControl>}
     */
    const ownRoots = new Map();
    /** The roots open, over every way in: what a gate counts down to none. */
    let rootsOpen = 0;
    /**
     * Their receivers, which `take` reads where the roots are `driven`, each
     * with what ends its root.
     *
     * @type {Map<ReturnType<typeof createReceiver>, () => void>}
     */
    const receivers = new Map();
    /**
     * What this worker is sent, written down when it was opened to (`capture`):
     * every root made after that and every batch played.
     *
     * @type {ReturnType<typeof createCapture> | null}
     */
    let capture = null;
    /** What told them, for a client that comes after. @type {{ type: 'lost', reason: string, message: string, recent: string[] } | null} */
    let lostWith = null;
    /** What the device holds, weighed (`ledger.js`). @type {ReturnType<typeof trackDevice> | null} */
    let ledger = null;
    /** What the backend's dynamic buffers hold (`dynamicHeld`). @type {(() => any) | null} */
    let heldBy = null;
    /**
     * The backend's names in the run's cache, once the run hands them
     * (`backend`): an owner of its own, numbered by the keeper, for as long
     * as the run lasts.
     *
     * @type {ReturnType<typeof channelSpace> | null}
     */
    let backendCache = null;
    /**
     * What the backend keeps between calls (the uniform ring's staging copy),
     * held under those names; refused before they come or where there is no
     * room. A room is taken at its first use, at the first draw, which comes
     * after the run handed them. The worker waits for that room on the
     * keeper's thread as a root does for its holds; it serves roots that lend
     * as well, whose thread waits on this one only while a lend is being
     * copied out of guest memory, which grows no scratch of the backend's.
     */
    const backendRooms = createScratches((key, length)=>(backendCache
        ? backendCache.space.hold(key, length) : hold?.(key, length) ?? null));
    /**
     * Asked of the page on a running program (`app.debug.dumpFrames`): every
     * Direct3D 8, 9, 10 and 11 device and OpenGL context here writes its next
     * frames down while this is above zero.
     */
    /** The frozen frame's timer (`freeze`), while one runs. @type {ReturnType<typeof setInterval> | undefined} */
    let frozen;
    const liveDump = {
        dumpFrames: 0,
        /** How buffer locks are taken (`app.debug.bufferLocks`): '' as asked, 'rename' always renaming. */
        bufferLocks: '',
        /** Textures whose draws are dropped (`app.debug.skipTexture`), `t12,t40`; '' none. */
        skipTexture: '',
        /** Shaders whose draws are dropped (`app.debug.skipShader`), `vs12,ps40`; '' none. */
        skipShader: '',
        /** Texture stages a fixed-function draw keeps (`app.debug.stageLimit`), -1 all. */
        stageLimit: -1,
        /** Textures whose top level a dump reads out (`app.debug.textureStats`), `t12,t40`. */
        textureStats: '',
        /** How occlusion counts are answered (`app.debug.occlusion`): '' as counted, 'visible' all passed. */
        occlusion: '',
        /** Draws kept a frame (`app.debug.maxDraws`), the rest dropped; -1 all. */
        maxDraws: -1,
        /** @type {((cut?: number) => boolean) | undefined} the device that showed last's */
        replayLast: undefined,
        /** @type {(() => { lines: string[], sceneDraws: number }) | undefined} */
        shownDraws: undefined,
        /** @type {((x?: number, y?: number, tolerance?: number, depth?: number) => Promise<any>) | undefined} */
        pick: undefined,
        /** @type {((id: string) => any) | undefined} a drawn shader's bytecode and translations */
        shaderText: undefined,
        /** A texture to read off the GPU at the next frame's end (`app.debug.snapshot`). */
        snapshot: '',
        /**
         * @param {string} id
         * @param {{ width: number, height: number, data: Uint8Array, format: string }} shot
         */
        snapped: (id, shot)=>{
            scope.postMessage({ type: 'snapped', id, ...shot }, [shot.data.buffer]);
        },
        /** @param {string[]} lines @param {number} frame */
        written: (lines, frame)=>{
            const dumped = { type: 'dumped', lines, frame };
            scope.postMessage(dumped);
            for (const client of clients)
            {
                client.postMessage(dumped);
            }
        },
    };

    /**
     * The newest frame each process presented and not yet sent, kept in a
     * texture of its own: the renderer draws its next frame into the surface
     * it presented. One slot a process, so the screen, composed of every
     * process's picture, gets each one's: one slot for all of them let a
     * process presenting often keep another's frames from ever being sent.
     *
     * @typedef {{ texture: any, width: number, height: number, format: string,
     *     frameIndex: number, fresh: boolean, waiting: number, presentedAt: number,
     *     source: number | undefined }} Slot
     * @type {Map<number | undefined, Slot>}
     */
    const newest = new Map();
    /** When each slot began to wait, in presents: the one waiting longest goes next. */
    let presents = 0;
    /** Each process's roots still open: its slot goes with its last. @type {Map<number, number>} */
    const rootsOf = new Map();
    /**
     * The process whose frame is ending: what is presented while it does is
     * that process's.
     *
     * @type {number | undefined}
     */
    let playing;

    /**
     * The backend as a root of one process draws through: the one backend,
     * whose frames, ending, say whose they were. A frame ends when its
     * replay does, which is after the calls that made it have been played,
     * so the process is known by the frame and not by the call.
     *
     * @param {any} backend @param {number | undefined} source
     */
    const drawingFor = (backend, source)=>Object.create(backend, {
        beginFrame: {
            value: (/** @type {any[]} */ ...args)=>{
                const frame = backend.beginFrame(...args);
                return Object.create(frame, {
                    end: {
                        value: ()=>{
                            const before = playing;
                            playing = source;
                            try
                            {
                                return frame.end();
                            }
                            finally
                            {
                                playing = before;
                            }
                        },
                    },
                });
            },
        },
    });
    /** Whether a frame sent has not yet been shown by the program's thread. */
    let sending = false;
    /** The frames sent so far: each goes with its number, which its showing answers with. */
    let sent = 0;
    /**
     * Where the thread that shows the frames writes the number of the last
     * one it showed, when it shares memory with this worker (`showing`).
     * Its answer is a message, which waits behind every batch that came
     * before it: a worker playing a heavy scene read it 5.5 ms late on
     * average and replaced a third of its frames meanwhile. A present reads
     * the word instead and sends at once when the frame before was shown.
     *
     * @type {Int32Array | null}
     */
    let shownWord = null;
    /** Frames presented that a newer one replaced before they were sent. */
    let dropped = 0;
    /**
     * The `shown` answers and how long each took to come back: one frame
     * goes at a time, so the way there, the showing and this way back
     * together bound the frames shown a second, however many are drawn.
     * `early` counts the frames the shared word let go before their answer.
     */
    const back = { count: 0, ms: 0, maxMs: 0, early: 0 };
    /** @param {Slot} surface @param {number} serial */
    const sentWith = (surface, serial)=>{
        const sentAt = sharedNow();
        return { serial, sentAt, waitedMs: Math.max(0, sentAt - surface.presentedAt),
            back: { count: back.count, ms: Math.round(back.ms * 100) / 100,
                maxMs: Math.round(back.maxMs * 100) / 100, early: back.early } };
    };
    /** Whether the frame sent last has been shown, as the shared word says. */
    const shownAlready = ()=>shownWord !== null && ((Atomics.load(shownWord, 0) - sent) | 0) >= 0;

    /**
     * A presented frame, kept to be sent back: at once when the frame before
     * it has been shown, after that otherwise -- and then the newest of what
     * came meanwhile. A program presents as often as it draws, and a picture
     * crossing to the program's thread and onto its device costs a
     * synchronisation of two devices' queues each time; one in flight keeps
     * that to the rate the program's thread shows them at, and off the
     * played device's way.
     *
     * @param {any} device
     * @param {{ surface: { texture: any, width: number, height: number, format: string },
     *     frameIndex: number }} frame
     */
    const present = (device, frame)=>{
        // A run measuring the engine on a device that draws nothing still
        // counts the program's frames: every one, without its picture.
        if (frames === 'count')
        {
            scope.postMessage({ type: 'frame', frameIndex: frame.frameIndex, source: playing });
            return;
        }
        if (frames !== 'pixels' && frames !== 'bitmap')
        {
            return;
        }
        const { surface } = frame;
        let slot = newest.get(playing);
        if (!slot || slot.width !== surface.width || slot.height !== surface.height
            || slot.format !== surface.format)
        {
            slot?.texture.destroy();
            slot = {
                texture: device.createTexture({ label: 'graphics-worker-newest',
                    size: [surface.width, surface.height], format: surface.format,
                    usage: COPY_SRC | COPY_DST }),
                width: surface.width, height: surface.height, format: surface.format,
                frameIndex: frame.frameIndex, fresh: false, waiting: 0, presentedAt: 0,
                source: playing,
            };
            newest.set(playing, slot);
        }
        if (slot.fresh)
        {
            dropped++;
        }
        else
        {
            slot.waiting = ++presents;
        }
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToTexture({ texture: surface.texture }, { texture: slot.texture },
            [surface.width, surface.height]);
        device.queue.submit([encoder.finish()]);
        slot.fresh = true;
        slot.frameIndex = frame.frameIndex;
        slot.presentedAt = sharedNow();
        if (sending && shownAlready())
        {
            sending = false;
            back.early++;
        }
        if (!sending)
        {
            send(device);
        }
    };

    /** @param {any} device */
    const send = device=>{
        /** @type {Slot | null} */
        let surface = null;
        for (const slot of newest.values())
        {
            if (slot.fresh && (!surface || slot.waiting < surface.waiting))
            {
                surface = slot;
            }
        }
        if (!surface)
        {
            return;
        }
        surface.fresh = false;
        sending = true;
        sent = (sent + 1) | 0;
        const serial = sent;
        if (frames === 'pixels')
        {
            readPixels(device, { surface, frameIndex: surface.frameIndex, serial });
            return;
        }
        if (!screen || screen.canvas.width !== surface.width
            || screen.canvas.height !== surface.height)
        {
            screen = canvas(surface.width, surface.height).getContext('webgpu');
            configured = null;
        }
        if (configured !== surface.format)
        {
            screen.configure({ device, format: surface.format, usage: COPY_DST,
                alphaMode: 'opaque' });
            configured = surface.format;
        }
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToTexture({ texture: surface.texture },
            { texture: screen.getCurrentTexture() }, [surface.width, surface.height]);
        device.queue.submit([encoder.finish()]);
        const bitmap = screen.canvas.transferToImageBitmap();
        scope.postMessage({ type: 'frame', bitmap, frameIndex: surface.frameIndex,
            format: surface.format, dropped, source: surface.source, ...sentWith(surface, serial) },
        [bitmap]);
    };

    /**
     * A presented frame's bytes, read back and sent: no canvas, at the
     * price of a copy each way. Some adapters lose `mapAsync` on every
     * device once a WebGPU canvas context exists anywhere -- headless
     * SwiftShader does -- and a frame sent this way keeps that from
     * happening.
     *
     * @param {any} device
     * @param {{ surface: Slot, frameIndex: number, serial: number }} frame
     */
    const readPixels = (device, { surface, frameIndex, serial })=>{
        const { width, height, format } = surface;
        const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
        const buffer = readBackFor(device, bytesPerRow * height);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: surface.texture }, { buffer, bytesPerRow },
            [width, height]);
        device.queue.submit([encoder.finish()]);
        buffer.mapAsync(MAP_READ).then(()=>{
            // The one copy: a mapped range is the buffer's until it is unmapped.
            // Into memory held in the run's cache, read in place by the
            // program's thread; the frame before, one in flight at a time, was
            // shown, and the room it let go of is the keeper's again at this hold.
            letGoHeld();
            const held = backendCache?.space.hold?.('frame', bytesPerRow * height) ?? null;
            if (held === null)
            {
                buffer.unmap();
                sending = false;
                if (unshown++ === 0)
                {
                    scope.postMessage({ type: 'unshown', message: `a frame of ${bytesPerRow
                        * height} bytes found no room in the run's cache, and is not shown` });
                }
                return;
            }
            held.bytes.set(new Uint8Array(buffer.getMappedRange()));
            buffer.unmap();
            heldFrame = held.release;
            scope.postMessage({ type: 'frame', pixels: held.bytes, bytesPerRow, width, height,
                frameIndex, format, dropped, source: surface.source,
                ...sentWith(surface, serial) });
        }, ()=>{
            readBack?.buffer.destroy();
            readBack = null;
            sending = false;
        });
    };
    /** What lets go of the frame read back last, until it is shown. @type {(() => void) | null} */
    let heldFrame = null;
    const letGoHeld = ()=>{
        heldFrame?.();
        heldFrame = null;
    };
    /** Frames read back that found no room. */
    let unshown = 0;
    /**
     * The buffer frames are read back through, kept while frames are the
     * same size on the same device: one frame is in flight at a time
     * (`sending`), so a buffer a frame was made and destroyed for nothing.
     *
     * @type {{ device: any, size: number, buffer: any } | null}
     */
    let readBack = null;
    /** @param {any} device @param {number} size */
    const readBackFor = (device, size)=>{
        if (readBack !== null && readBack.device === device && readBack.size === size)
        {
            return readBack.buffer;
        }
        readBack?.buffer.destroy();
        const buffer = device.createBuffer({ size, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        readBack = { device, size, buffer };
        return buffer;
    };

    /** @param {boolean} software  The browser's software adapter, as the engine's (AppOptions.gpuAdapter). */
    const open = async software=>{
        const adapter = await gpu.requestAdapter(software
            ? { forceFallbackAdapter: true } : undefined);
        if (!adapter)
        {
            throw new Error('no GPU adapter answered requestAdapter in the graphics worker');
        }
        const device = await adapter.requestDevice({ requiredFeatures: gpuFeaturesOf(adapter),
            requiredLimits: gpuLimitsOf(adapter) });
        ledger = trackDevice(device);
        device.lost?.then((/** @type {{ reason?: string, message?: string }} */ info)=>{
            if (info?.reason === 'destroyed')
            {
                return;
            }
            lost = true;
            for (const watcher of [...losers])
            {
                watcher();
            }
            losers.clear();
            lostWith = { type: 'lost', reason: info?.reason ?? 'unknown',
                message: String(info?.message ?? ''), recent: ledger?.recent() ?? [] };
            scope.postMessage(lostWith);
            for (const client of clients)
            {
                client.postMessage(lostWith);
            }
        });
        // A validation error drops the whole frame it was in and says so
        // only here, where a page's console does not reach: it goes to the
        // threads that show this worker's frames, the first time a message is
        // seen and then every 256th, as the device repeats it every frame.
        /** @type {Map<string, number>} */
        const refusals = new Map();
        device.addEventListener?.('uncapturederror', (/** @type {any} */ event)=>{
            const message = String(event.error?.message ?? event.error).replace(/\s+/g, ' ');
            // Counted by what it says, not by which frame it names: the
            // encoder's label carries the frame's number.
            const kind = message.replace(/\d+/g, '#');
            const seen = (refusals.get(kind) ?? 0) + 1;
            refusals.set(kind, seen);
            if (seen > 1 && seen % 256 !== 0)
            {
                return;
            }
            const refused = { type: 'refused', message, seen };
            scope.postMessage(refused);
            for (const client of clients)
            {
                client.postMessage(refused);
            }
        });
        const backend = createBackend({ device, queue: device.queue,
            presentTo: (/** @type {any} */ frame)=>present(device, frame),
            scratches: name=>backendRooms.scratch(name) });
        heldBy = ()=>backend.dynamicHeld();
        return { device, backend, adapter: {
            vendor: adapter.info?.vendor ?? '',
            architecture: adapter.info?.architecture ?? '',
            description: adapter.info?.description ?? '',
        } };
    };

    /**
     * @param {string} api @param {any} options
     * @param {import('./channel.js').RootRings} rings
     * @param {Uint8Array | null} given  the guest's RAM, where it is shared
     * @param {{ slots: SharedArrayBuffer, stash: SharedArrayBuffer } | null} lending
     *     the parts of a lending, where the engine lends guest memory rather than copying it
     * @param {number | undefined} source  the process it draws for
     * @param {number | undefined} frameLatency  the frames its presents may leave the GPU
     *     drawing; absent, Direct3D's default
     * @param {Set<() => void>} ends  where the way in it came through keeps its end
     * @param {(control: RootControl) => void} control  where it is told what a ring
     *     cannot carry
     */
    const root = async(api, options, rings, given, lending, source, frameLatency, ends,
        control)=>
    {
        // The guest's memory, taken again when it grows (a `memory` message).
        let memory = given;
        /** The views of it taken so far, and the mark the reading waits at for the next. */
        let memoryNumber = 0;
        let waitingFor = 0;
        const { device, backend: shared } = await /** @type {Promise<any>} */ (opened);
        // A bound of its own, as a Direct3D device has. It counts a frame done
        // when this thread hears so from the browser's GPU process, which a
        // driver's fence does not wait on: the run's `maxFrameLatency` decides
        // how many, as it does for a device drawn on the run's own thread.
        // DirectDraw's flips are held by nothing (none ever were), so a
        // Direct3D 7 root's frames are counted and timed under no bound.
        const latency = createFrameLatency({ queue: device.queue, lost: device.lost,
            limit: api === 'd3d7' ? 0 : frameLatency });
        const backend = source === undefined ? shared : drawingFor(shared, source);
        if (source !== undefined)
        {
            rootsOf.set(source, (rootsOf.get(source) ?? 0) + 1);
        }
        /** What the played side says, on the root's ring back. @param {any} message */
        const post = message=>receiver?.post(message);
        // The run's cache, where the root keeps the texels it holds past a
        // call (`internal/texel-store.js`: OpenGL's levels no draw needs yet,
        // Direct3D 8 and 9's uploads waiting for their frame), under names of
        // its own it lets go of when it ends.
        const texelCache = options.cacheLink
            ? channelSpace(options.cacheLink, options.cacheLink) : null;
        // What the root keeps between calls (its scratches) and for an
        // object's life (a Direct3D 10 resource's bytes), held under its
        // names: the worker waits for that room on the keeper's thread, so a
        // root that lends, whose program's thread may be that thread waiting
        // on this one for a lend being read, would wait on itself: it holds
        // plain memory until room is asked ahead for it.
        const rooms = createScratches(!texelCache ? hold
            : lending ? plainHold : texelCache.space.hold);
        const roomServices = {
            scratches: (/** @type {string} */ name)=>rooms.scratch(name),
            holds: (/** @type {string} */ name, /** @type {number} */ length)=>
                rooms.hold(name, length),
        };
        /**
         * What the played device wrote outside a call -- a read-back the
         * program waits on -- into guest memory: in place where it is shared,
         * the engine told only where; otherwise the bytes, for it to write.
         *
         * @param {number} address @param {Uint8Array} bytes
         */
        const wrote = (address, bytes)=>{
            if (memory && address + bytes.length <= memory.length)
            {
                memory.set(bytes, address);
                post({ type: 'wrote', writes: [{ address, length: bytes.length }] });
                return;
            }
            post({ type: 'wrote', writes: [{ address, bytes }] });
        };
        /**
         * An occlusion count straight into its query's block where guest memory is
         * shared (`storeCount` in seam/shadow.js): nothing crosses to the engine's thread.
         *
         * @param {number} block @param {number} measurement @param {number} count
         */
        let words = memory
            ? new Int32Array(memory.buffer, memory.byteOffset, Math.floor(memory.length / 4))
            : null;
        /**
         * Whether the count the renderer settled last landed in its block:
         * the renderer stores a count, then says it has come (`occlusionCounted`),
         * and one the program reads in its own memory needs no message to its
         * thread as well: the guest answers its polls from the block, and the
         * count rides with the next one sent if the host asks after all.
         */
        let landed = false;
        const storeCount = words
            ? (/** @type {number} */ block, /** @type {number} */ measurement,
                /** @type {number} */ count)=>(landed = storeCountIn(
                /** @type {Int32Array} */ (words), block, measurement, count))
            : undefined;
        const occlusionCounted = ()=>{
            if (landed)
            {
                landed = false;
                return;
            }
            receiver?.counted();
        };
        /** @param {any} submitted */
        const frameQueued = submitted=>latency.queued(submitted);
        /** @type {ReturnType<typeof createReceiver> | null} */
        let receiver = null;
        /** @type {any} */
        let played;
        if (api === 'd3d7')
        {
            played = playedDirect3D7({
                ...options,
                ...roomServices,
                liveDump,
                backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                writeMemory: wrote,
                frameQueued,
            });
        }
        else if (api === 'd3d10')
        {
            played = playedDirect3D10(createDirect3D10, {
                ...options,
                cacheLink: undefined,
                ...roomServices,
                liveDump,
                backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                createTexture: (/** @type {any} */ descriptor)=>device.createTexture(descriptor),
                // Blocks are kept as blocks only where this device samples them.
                compressedTextures: options.compressedTextures === true
                    && device.features?.has?.('texture-compression-bc') === true,
                depthClipControl: options.depthClipControl === true
                    && device.features?.has?.('depth-clip-control') === true,
                writeMemory: wrote,
                divergence: (/** @type {string} */ name, /** @type {string} */ detail,
                    /** @type {'loss' | undefined} */ severity)=>
                    post({ type: 'divergence', api: name, detail, severity }),
                frameQueued,
            });
        }
        else if (api === 'opengl')
        {
            played = playedOpengl(createOpenglRoot, {
                ...options,
                cacheLink: undefined,
                texelCache,
                // The RGBA its contexts on the processor sample, held as the rooms are.
                holds: roomServices.holds,
                liveDump,
                backend: ()=>backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                // Blocks are uploaded as blocks only where this device takes them.
                compressedTextures: options.compressedTextures === true
                    && device.features?.has?.('texture-compression-bc') === true,
                astcTextures: options.astcTextures === true
                    && device.features?.has?.('texture-compression-astc') === true,
                writeMemory: wrote,
                divergence: (/** @type {string} */ detail, /** @type {'loss' | undefined} */ severity)=>
                    post({ type: 'divergence', api: 'OpenGL', detail, severity }),
                frameQueued,
            });
        }
        else
        {
            played = playedDirect3D(FACTORIES[api], {
                ...options,
                cacheLink: undefined,
                texelCache,
                ...roomServices,
                liveDump,
                backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                // The program has memory; what of it this side reads is what it is sent.
                readMemory: true,
                borrow: memory && lending
                    ? createBorrower({ ...lending, memory: ()=>/** @type {Uint8Array} */ (memory) })
                    : undefined,
                writeMemory: wrote,
                storeCount,
                divergence: (/** @type {string} */ name, /** @type {string} */ detail,
                    /** @type {'loss' | undefined} */ severity)=>
                    post({ type: 'divergence', api: name, detail, severity }),
                onDeviceLost: (/** @type {() => void} */ watcher)=>{
                    if (lost)
                    {
                        watcher();
                        return ()=>{};
                    }
                    losers.add(watcher);
                    return ()=>losers.delete(watcher);
                },
                frameQueued,
                occlusionCounted,
                gamma: options.gamma ? { applies: ()=>true, set: ()=>{} } : undefined,
            });
        }
        // Written down as made, before any of its batches can come: the
        // capture's roots are made again in its order when it is played.
        const captured = capture?.root({ api, options, source, lending: lending !== null,
            memory: memory?.length ?? 0 }) ?? 0;
        receiver = createReceiver({ played, rings, serve: !driven,
            latency: ()=>latency.diagnostics(),
            gpuMemory: ()=>(ledger ? { ...ledger.diagnostics(),
                dynamic: heldBy?.() ?? null, scratch: backendRooms.figures() } : null),
            times: ()=>latency.times(),
            // A batch sent after the guest's memory grew may use what it gained:
            // it waits for the longer view, which comes by message.
            marked: number=>{
                if (number <= memoryNumber)
                {
                    return true;
                }
                waitingFor = number;
                return false;
            },
            seen: (buffer, start, length)=>{
                if (!capture)
                {
                    return;
                }
                try
                {
                    capture.calls(captured, buffer, length, start);
                }
                catch (e){
                    // What is written down never stands in the way of what is
                    // played: the capture stops, and says why.
                    capture.fail(e);
                    post({ type: 'divergence', api: 'capture', detail: 'the capture stopped: '
                        + String(/** @type {any} */ (e)?.stack ?? e) });
                }
            } });
        rootsOpen++;
        let ended = false;
        /** The root goes: by its rings' close, or with its client's process. */
        const end = ()=>{
            if (ended)
            {
                return;
            }
            ended = true;
            rootsOpen--;
            receivers.delete(receiver);
            ends.delete(end);
            receiver?.close();
            capture?.close(captured);
            // What it still held let go of here, then every name with it.
            rooms.releaseAll();
            texelCache?.close();
            const left = (rootsOf.get(/** @type {number} */ (source)) ?? 1) - 1;
            if (source !== undefined && left === 0)
            {
                rootsOf.delete(source);
                // A frame of it being sent was copied out of the slot by
                // work already submitted, which a destroy lets finish.
                newest.get(source)?.texture.destroy();
                newest.delete(source);
            }
            else if (source !== undefined)
            {
                rootsOf.set(source, left);
            }
        };
        ends.add(end);
        receivers.set(receiver, end);
        // Driven, a root's rings are read by `take`, its close found there.
        receiver.served().then(()=>(driven ? undefined : end()), end);
        control({
            // The guest's memory grew: the longer view, which the batches after
            // the mark the sender placed wait for.
            memory: (grown, number)=>{
                memory = grown ?? memory;
                memoryNumber = Math.max(memoryNumber, number);
                words = memory
                    ? new Int32Array(memory.buffer, memory.byteOffset,
                        Math.floor(memory.length / 4))
                    : null;
                if (waitingFor > 0 && waitingFor <= memoryNumber)
                {
                    waitingFor = 0;
                    receiver?.resume();
                }
            },
            cache: message=>texelCache?.adopt(message),
        });
    };

    /**
     * A root sent through a way in -- this worker's own, or a client's port --
     * whose roots it numbers.
     *
     * @param {any} data @param {Set<() => void>} ends @param {Map<number, RootControl>} roots
     */
    const takeRoot = (data, ends, roots)=>{
        const id = Number(data.id);
        root(data.api, data.cache ? { ...data.options, cacheLink: data.cache } : data.options ?? {},
            data.rings, data.memory ?? null, data.lending ?? null,
            typeof data.source === 'number' ? data.source : undefined,
            typeof data.frameLatency === 'number' ? data.frameLatency : undefined, ends,
            control=>{
                roots.set(id, control);
                ends.add(()=>roots.delete(id));
            }).catch(e=>{
            // Said on its ring back, which then closes: the root is no more.
            const said = openRingOut(data.rings.replies, { strings: SAID_STRINGS });
            said.writer.value({ type: 'failed', message: String(e?.message ?? e) }, ()=>undefined);
            said.publish(KIND.VALUE, sharedNow());
            said.close();
        });
    };
    /**
     * What a way in says of a root it made: its memory grown, its cache's word.
     *
     * @param {any} data @param {Map<number, RootControl>} roots
     */
    const toRoot = (data, roots)=>{
        const control = roots.get(Number(data.root));
        if (data.type === 'memory')
        {
            control?.memory(data.memory ?? null, Number(data.number) || 0);
        }
        else
        {
            control?.cache(data.message);
        }
    };
    /** The roots made through this worker's own messages; they end with their rings. */
    const ownEnds = new Set();

    scope.onmessage = ({ data })=>{
        switch (data?.type)
        {
            case 'open':
                frames = data.frames ?? 'none';
                if (data.capture === true && capture === null)
                {
                    capture = createCapture();
                    capture.open(frames);
                }
                opened ??= open(data.software === true);
                opened.then(({ adapter })=>{
                    // SwiftShader in Chrome makes no picture of a worker's
                    // WebGPU canvas where it has no Vulkan below it: the GPU
                    // process fails to back the canvas's texture and the page
                    // goes with it. Its frames go as bytes instead.
                    if (frames === 'bitmap' && /swiftshader/i.test(
                        `${adapter.architecture} ${adapter.description}`))
                    {
                        frames = 'pixels';
                    }
                    scope.postMessage({ type: 'opened', adapter });
                },
                e=>scope.postMessage({ type: 'failed', message: String(e?.message ?? e) }));
                break;
            case 'frames':
                // The program's thread could not take a picture: from here on
                // the frames go as bytes.
                frames = data.frames;
                break;
            case 'showing':
                shownWord = data.word instanceof Int32Array ? data.word : null;
                break;
            case 'shown':
                if (typeof data.at === 'number')
                {
                    const took = Math.max(0, sharedNow() - data.at);
                    back.count++;
                    back.ms += took;
                    back.maxMs = Math.max(back.maxMs, took);
                }
                // The answer for a frame before the one sent last: the shared
                // word let that one go already, and the one in flight is not
                // shown yet.
                if (typeof data.serial === 'number' && data.serial !== sent)
                {
                    break;
                }
                letGoHeld();
                sending = false;
                opened?.then(({ device })=>send(device), ()=>{});
                break;
            case 'root':
                takeRoot(data, ownEnds, ownRoots);
                break;
            case 'backend':
                // Handed by each run the worker draws for: an engine that starts
                // a program again keeps its graphics worker, and the run before
                // took its cache with it. What was held there is let go of, its
                // memory the backend's alone until a room grows into the new one.
                if (data.cache)
                {
                    backendRooms.releaseAll();
                    letGoHeld();
                    backendCache?.close();
                    backendCache = channelSpace(data.cache, data.cache);
                }
                break;
            case 'cache':
                if (data.root === undefined)
                {
                    backendCache?.adopt(data.message);
                    break;
                }
                toRoot(data, ownRoots);
                break;
            case 'memory':
                toRoot(data, ownRoots);
                break;
            case 'debug':
                if ('dumpFrames' in data)
                {
                    liveDump.dumpFrames = Math.max(0, Math.floor(Number(data.dumpFrames) || 0));
                }
                if ('captureFrames' in data)
                {
                    capture?.mark(Number(data.captureFrames) || 1);
                }
                if (data.captured === true)
                {
                    const counts = capture?.counts() ?? null;
                    (capture ? capture.finish() : Promise.resolve(null)).then(bytes=>
                        scope.postMessage({ type: 'captured', bytes, counts },
                            bytes ? [bytes.buffer] : []),
                    (/** @type {any} */ e)=>scope.postMessage({ type: 'captured', bytes: null,
                        counts, failed: String(e?.message ?? e) }));
                }
                if ('bufferLocks' in data)
                {
                    liveDump.bufferLocks = String(data.bufferLocks ?? '');
                }
                if ('skipTexture' in data)
                {
                    liveDump.skipTexture = String(data.skipTexture ?? '');
                }
                if ('textureStats' in data)
                {
                    liveDump.textureStats = String(data.textureStats ?? '');
                }
                if ('snapshot' in data)
                {
                    liveDump.snapshot = String(data.snapshot ?? '');
                }
                if ('stageLimit' in data)
                {
                    liveDump.stageLimit = Math.floor(Number(data.stageLimit ?? -1));
                }
                if ('dumpDigits' in data)
                {
                    dumpDigits.value = Math.min(9,
                        Math.max(1, Math.floor(Number(data.dumpDigits)) || 4));
                }
                if ('srgb' in data)
                {
                    srgbHonoured.value = data.srgb !== false;
                }
                if ('skipShader' in data)
                {
                    liveDump.skipShader = String(data.skipShader ?? '');
                }
                if ('occlusion' in data)
                {
                    liveDump.occlusion = String(data.occlusion ?? '');
                }
                if ('maxDraws' in data)
                {
                    const cut = Math.floor(Number(data.maxDraws));
                    liveDump.maxDraws = Number.isFinite(cut) && cut >= 0 ? cut : -1;
                }
                if (data.shader)
                {
                    scope.postMessage({ type: 'shaderText', id: data.shader,
                        result: liveDump.shaderText?.(String(data.shader)) ?? null });
                }
                if (data.pick)
                {
                    const { x, y, tolerance, depth } = data.pick;
                    Promise.resolve().then(()=>{
                        if (!liveDump.pick)
                        {
                            throw new Error('pick: no frame has been shown');
                        }
                        return liveDump.pick(x, y, tolerance, depth);
                    }).then(result=>scope.postMessage({ type: 'picked', result }),
                        (/** @type {any} */ e)=>scope.postMessage({ type: 'picked',
                            error: String(e?.message ?? e) }));
                }
                if ('freeze' in data)
                {
                    // With the program paused nothing new is drawn: the last
                    // frame is shown again, cut where `maxDraws` says, so a
                    // picture that holds still can be taken apart draw by draw.
                    clearInterval(frozen);
                    frozen = undefined;
                    if (data.freeze)
                    {
                        frozen = setInterval(()=>liveDump.replayLast?.(liveDump.maxDraws), 150);
                        // Lines and a count only: the device's answer also holds the
                        // scene's surface, a GPU texture no message can carry.
                        const { lines, sceneDraws } = liveDump.shownDraws?.()
                            ?? { lines: [], sceneDraws: 0 };
                        scope.postMessage({ type: 'frozen', lines, sceneDraws });
                    }
                }
                break;
            case 'client':
            {
                /** @type {MessagePort} */
                const port = data.port;
                clients.add(port);
                /** @type {Set<() => void>} */
                const ends = new Set();
                /** @type {Map<number, RootControl>} */
                const roots = new Map();
                if (typeof data.client === 'number')
                {
                    byClient.set(data.client, { port, ends });
                }
                port.onmessage = event=>{
                    if (event.data?.type === 'root')
                    {
                        takeRoot(event.data, ends, roots);
                    }
                    else if (event.data?.type === 'memory' || event.data?.type === 'cache')
                    {
                        toRoot(event.data, roots);
                    }
                    else if (event.data?.type === 'close')
                    {
                        clients.delete(port);
                        port.onmessage = null;
                        port.close();
                    }
                };
                if (lostWith)
                {
                    port.postMessage(lostWith);
                }
                break;
            }
            // A process gone however it went - one that failed or was lost
            // never closes its roots - takes them with it: each held its
            // memory's view and its device's objects for the run.
            case 'forget':
            {
                const client = byClient.get(data.client);
                byClient.delete(data.client);
                if (client)
                {
                    for (const end of [...client.ends])
                    {
                        end();
                    }
                    clients.delete(client.port);
                    client.port.onmessage = null;
                    client.port.close();
                }
                break;
            }
            default:
                break;
        }
    };
    return {
        /** The roots open now, over every way in. */
        roots: ()=>rootsOpen,
        /** What the backend's scratches hold in the run's cache. */
        scratch: ()=>backendRooms.figures(),
        /**
         * Where the roots are `driven`: plays every batch their rings hold
         * now, and ends the roots whose rings the other side closed.
         * Answers how many records were read.
         */
        take(){
            let read = 0;
            for (const [one, end] of [...receivers])
            {
                read += one.take();
                if (one.closed())
                {
                    end();
                }
            }
            return read;
        },
    };
}
