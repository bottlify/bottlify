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
 *                                    bytes read back; anything else keeps them.
 *                                    Answered every time it is asked.
 *   { type: 'root', api, options, port, memory, lending }
 *                                    `api` 'd3d7', 'd3d8', 'd3d9' or 'opengl', `options` the
 *                                    plain part of what the root was made with;
 *                                    `memory` the guest's RAM where it is shared, and
 *                                    `lending` the slots and stash a Direct3D 8 or 9
 *                                    root lends guest memory through (`lending.js`);
 *                                    `{ type: 'close' }` on the port ends it
 * Messages from it:
 *   { type: 'opened', adapter } | { type: 'failed', message }
 *   { type: 'frame', bitmap, frameIndex, format, dropped }
 *   { type: 'frame', pixels, bytesPerRow, width, height, frameIndex, format, dropped }
 *                                    one at a time, the newest presented; `dropped`
 *                                    counts those a newer one replaced unsent
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

    /**
     * The newest frame presented and not yet sent, kept in a texture of its
     * own: the renderer draws its next frame into the surface it presented.
     *
     * @type {{ texture: any, width: number, height: number, format: string,
     *     frameIndex: number, fresh: boolean } | null}
     */
    let newest = null;
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
        if (frames !== 'pixels' && frames !== 'bitmap')
        {
            return;
        }
        const { surface } = frame;
        if (!newest || newest.width !== surface.width || newest.height !== surface.height
            || newest.format !== surface.format)
        {
            newest?.texture.destroy();
            newest = {
                texture: device.createTexture({ label: 'graphics-worker-newest',
                    size: [surface.width, surface.height], format: surface.format,
                    usage: COPY_SRC | COPY_DST }),
                width: surface.width, height: surface.height, format: surface.format,
                frameIndex: frame.frameIndex, fresh: false,
            };
        }
        if (newest.fresh)
        {
            dropped++;
        }
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToTexture({ texture: surface.texture }, { texture: newest.texture },
            [surface.width, surface.height]);
        device.queue.submit([encoder.finish()]);
        newest.fresh = true;
        newest.frameIndex = frame.frameIndex;
        if (!sending)
        {
            send(device);
        }
    };

    /** @param {any} device */
    const send = device=>{
        if (!newest?.fresh)
        {
            return;
        }
        newest.fresh = false;
        sending = true;
        if (frames === 'pixels')
        {
            readPixels(device, { surface: newest, frameIndex: newest.frameIndex });
            return;
        }
        const surface = newest;
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
            format: surface.format, dropped }, [bitmap]);
    };

    /**
     * A presented frame's bytes, read back and sent: no canvas, at the
     * price of a copy each way. Some adapters lose `mapAsync` on every
     * device once a WebGPU canvas context exists anywhere -- headless
     * SwiftShader does -- and a frame sent this way keeps that from
     * happening.
     *
     * @param {any} device
     * @param {{ surface: { texture: any, width: number, height: number, format: string },
     *     frameIndex: number }} frame
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
                format, dropped }, [pixels.buffer]);
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
        const features = ['texture-compression-bc', 'depth-clip-control']
            .filter(feature=>adapter.features.has(feature));
        const device = await adapter.requestDevice({ requiredFeatures: features });
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
            scope.postMessage({ type: 'lost', reason: info?.reason ?? 'unknown' });
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
     */
    const root = async(api, options, port, memory, lending)=>{
        const { device, backend, latency } = await /** @type {Promise<any>} */ (opened);
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
        /** @type {any} */
        let played;
        if (api === 'd3d7')
        {
            played = playedDirect3D7({
                ...options,
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
                gamma: options.gamma ? { applies: ()=>true, set: ()=>{} } : undefined,
            });
        }
        const receiver = createReceiver({ played, post });
        port.onmessage = event=>{
            if (event.data?.type === 'close')
            {
                port.onmessage = null;
                port.close();
                return;
            }
            receiver.receive(event.data);
        };
    };

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
                root(data.api, data.options ?? {}, data.port, data.memory ?? null,
                    data.lending ?? null).catch(e=>
                    data.port.postMessage({ type: 'failed', message: String(e?.message ?? e) }));
                break;
            default:
                break;
        }
    };
}
