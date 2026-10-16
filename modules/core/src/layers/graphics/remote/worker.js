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
 * its twin here with a port of its own; the calls come in on that port
 * (`channel.js`) and are played on a device that renders. What the renderer
 * presents comes back to the program's thread as a picture, for the run's
 * presenter to show as it shows every other: the canvas, the gamma ramp and
 * the cursor stay where they are.
 *
 * Messages to the worker:
 *   { type: 'shown' }                the program's thread has shown the frame sent
 *                                    last; the next goes when it has
 *   { type: 'open', frames }         `frames` 'bitmap' sends each presented
 *                                    frame back as a picture, 'pixels' as its
 *                                    bytes read back, 'count' says only that
 *                                    one was presented; anything else keeps them.
 *                                    Answered every time it is asked.
 *   { type: 'root', api, options, port, memory, lending, source }
 *                                    `api` 'd3d7', 'd3d8', 'd3d9' or 'opengl', `options` the
 *                                    plain part of what the root was made with;
 *                                    `memory` the guest's RAM where it is shared, and
 *                                    `lending` the slots and stash a Direct3D 8 or 9
 *                                    root lends guest memory through (`lending.js`);
 *                                    `source` the process it draws for, which its
 *                                    frames carry back; `{ type: 'close' }` on the
 *                                    port ends it
 *   { type: 'client', port }         a way in for a process on another thread: `root`
 *                                    on the port is taken as it is here, and `lost`
 *                                    is told there too; its frames come here, as every
 *                                    root's do, to the thread that shows them.
 *                                    `{ type: 'close' }` on the port ends it
 * Messages from it:
 *   { type: 'opened', adapter } | { type: 'failed', message }
 *   { type: 'frame', bitmap, frameIndex, format, dropped, source }
 *   { type: 'frame', pixels, bytesPerRow, width, height, frameIndex, format, dropped, source }
 *   { type: 'frame', frameIndex, source }  under 'count', every frame presented
 *                                    one at a time, the newest presented of a process,
 *                                    the processes in turn; `dropped` counts those a
 *                                    newer one replaced unsent
 *   { type: 'lost', reason }
 */

import { createDirect3D8 } from '../d3d8/device.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createOpenglRoot } from '../opengl/root.js';
import { createBackend } from '../webgpu/backend.js';
import { createFrameLatency } from '../webgpu/internal/latency.js';
import { createReceiver } from './channel.js';
import { createBorrower } from './lending.js';
import { playedDirect3D } from './direct3d.js';
import { playedOpengl } from './opengl.js';
import { playedDirect3D7 } from './d3d7.js';
import { gpuFeaturesOf } from '../webgpu/features.js';

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
 * @param {{ gpu: any, canvas?: (width: number, height: number) => any }} deps
 *     `canvas` makes the canvas a frame is copied into to become a picture
 */
export function serveGraphics(scope, deps){
    const { gpu, canvas = (width, height)=>new OffscreenCanvas(width, height) } = deps;
    /** @type {Promise<{ device: any, backend: any, latency: any, adapter: any }> | null} */
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
    /** What told them, for a client that comes after. @type {{ type: 'lost', reason: string } | null} */
    let lostWith = null;
    /**
     * Asked of the page on a running program (`app.debug.dumpFrames`): every
     * Direct3D 8 and 9 device here writes its next frames down while this is
     * above zero.
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
     *     frameIndex: number, fresh: boolean, waiting: number,
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
    /** Frames presented that a newer one replaced before they were sent. */
    let dropped = 0;

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
                frameIndex: frame.frameIndex, fresh: false, waiting: 0, source: playing,
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
        if (frames === 'pixels')
        {
            readPixels(device, { surface, frameIndex: surface.frameIndex });
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
            format: surface.format, dropped, source: surface.source }, [bitmap]);
    };

    /**
     * A presented frame's bytes, read back and sent: no canvas, at the
     * price of a copy each way. Some adapters lose `mapAsync` on every
     * device once a WebGPU canvas context exists anywhere -- headless
     * SwiftShader does -- and a frame sent this way keeps that from
     * happening.
     *
     * @param {any} device
     * @param {{ surface: { texture: any, width: number, height: number, format: string,
     *     source?: number }, frameIndex: number }} frame
     */
    const readPixels = (device, { surface, frameIndex })=>{
        const { width, height, format } = surface;
        const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * height,
            usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: surface.texture }, { buffer, bytesPerRow },
            [width, height]);
        device.queue.submit([encoder.finish()]);
        buffer.mapAsync(MAP_READ).then(()=>{
            const pixels = new Uint8Array(buffer.getMappedRange()).slice();
            buffer.destroy();
            scope.postMessage({ type: 'frame', pixels, bytesPerRow, width, height, frameIndex,
                format, dropped, source: surface.source }, [pixels.buffer]);
        }, ()=>{
            buffer.destroy();
            sending = false;
        });
    };

    const open = async()=>{
        const adapter = await gpu.requestAdapter();
        if (!adapter)
        {
            throw new Error('no GPU adapter answered requestAdapter in the graphics worker');
        }
        const device = await adapter.requestDevice({ requiredFeatures: gpuFeaturesOf(adapter) });
        device.lost?.then((/** @type {{ reason?: string }} */ info)=>{
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
            lostWith = { type: 'lost', reason: info?.reason ?? 'unknown' };
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
            presentTo: (/** @type {any} */ frame)=>present(device, frame) });
        const latency = createFrameLatency({ queue: device.queue, lost: device.lost });
        return { device, backend, latency, adapter: {
            vendor: adapter.info?.vendor ?? '',
            architecture: adapter.info?.architecture ?? '',
            description: adapter.info?.description ?? '',
        } };
    };

    /**
     * @param {string} api @param {any} options @param {MessagePort} port
     * @param {Uint8Array | null} memory  the guest's RAM, where it is shared
     * @param {{ slots: SharedArrayBuffer, stash: SharedArrayBuffer } | null} lending
     *     the parts of a lending, where the engine lends guest memory rather than copying it
     * @param {number | undefined} source  the process it draws for
     */
    const root = async(api, options, port, memory, lending, source)=>{
        const { device, backend: shared, latency } = await /** @type {Promise<any>} */ (opened);
        const backend = source === undefined ? shared : drawingFor(shared, source);
        if (source !== undefined)
        {
            rootsOf.set(source, (rootsOf.get(source) ?? 0) + 1);
        }
        /** @type {(message: any, transfer?: Transferable[]) => void} */
        const post = (message, transfer)=>port.postMessage(message, transfer ?? []);
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
            post({ type: 'wrote', writes: [{ address, bytes: bytes.slice() }] });
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
                liveDump,
                backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                writeMemory: wrote,
            });
        }
        else if (api === 'opengl')
        {
            played = playedOpengl(createOpenglRoot, {
                ...options,
                backend: ()=>backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                // Blocks are uploaded as blocks only where this device takes them.
                compressedTextures: options.compressedTextures === true
                    && device.features?.has?.('texture-compression-bc') === true,
                writeMemory: wrote,
                divergence: (/** @type {string} */ detail)=>
                    post({ type: 'divergence', api: 'OpenGL', detail }),
                frameQueued,
            });
        }
        else
        {
            played = playedDirect3D(FACTORIES[api], {
                ...options,
                liveDump,
                backend,
                createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
                // The program has memory; what of it this side reads is what it is sent.
                readMemory: true,
                borrow: memory && lending ? createBorrower({ ...lending, memory }) : undefined,
                writeMemory: wrote,
                divergence: (/** @type {string} */ name, /** @type {string} */ detail)=>
                    post({ type: 'divergence', api: name, detail }),
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
                occlusionCounted: ()=>receiver?.counted(),
                gamma: options.gamma ? { applies: ()=>true, set: ()=>{} } : undefined,
            });
        }
        receiver = createReceiver({ played, post });
        port.onmessage = event=>{
            if (event.data?.type === 'close')
            {
                port.onmessage = null;
                port.close();
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
                return;
            }
            receiver.receive(event.data);
        };
    };

    /** @param {any} data */
    const takeRoot = data=>root(data.api, data.options ?? {}, data.port, data.memory ?? null,
        data.lending ?? null, typeof data.source === 'number' ? data.source : undefined).catch(e=>
        data.port.postMessage({ type: 'failed', message: String(e?.message ?? e) }));

    scope.onmessage = ({ data })=>{
        switch (data?.type)
        {
            case 'open':
                frames = data.frames ?? 'none';
                opened ??= open();
                opened.then(({ adapter })=>scope.postMessage({ type: 'opened', adapter }),
                    e=>scope.postMessage({ type: 'failed', message: String(e?.message ?? e) }));
                break;
            case 'frames':
                // The program's thread could not take a picture: from here on
                // the frames go as bytes.
                frames = data.frames;
                break;
            case 'shown':
                sending = false;
                opened?.then(({ device })=>send(device), ()=>{});
                break;
            case 'root':
                takeRoot(data);
                break;
            case 'debug':
                if ('dumpFrames' in data)
                {
                    liveDump.dumpFrames = Math.max(0, Math.floor(Number(data.dumpFrames) || 0));
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
                if ('stageLimit' in data)
                {
                    liveDump.stageLimit = Math.floor(Number(data.stageLimit ?? -1));
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
                        scope.postMessage({ type: 'frozen',
                            ...(liveDump.shownDraws?.() ?? { lines: [], sceneDraws: 0 }) });
                    }
                }
                break;
            case 'client':
            {
                /** @type {MessagePort} */
                const port = data.port;
                clients.add(port);
                port.onmessage = event=>{
                    if (event.data?.type === 'root')
                    {
                        takeRoot(event.data);
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
            default:
                break;
        }
    };
}
