/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics worker: Direct3D 8 and 9 devices played on a GPU device of
 * its own, off the thread the program runs on.
 *
 * The program's thread makes a root it records (`direct3d.js`) and sends
 * its twin here with a port of its own; the calls come in on that port
 * (`channel.js`) and are played on a device that renders. What the renderer
 * presents comes back to the program's thread as a picture, for the run's
 * presenter to show as it shows every other: the canvas, the gamma ramp and
 * the cursor stay where they are.
 *
 * Messages to the worker:
 *   { type: 'open', frames }         `frames` 'bitmap' sends each presented
 *                                    frame back as a picture, 'pixels' as its
 *                                    bytes read back; anything else keeps them.
 *                                    Answered every time it is asked.
 *   { type: 'root', api, options, port }
 *                                    `api` 'd3d8' or 'd3d9', `options` the
 *                                    plain part of what the root was made with;
 *                                    `{ type: 'close' }` on the port ends it
 * Messages from it:
 *   { type: 'opened', adapter } | { type: 'failed', message }
 *   { type: 'frame', bitmap, frameIndex, format }
 *   { type: 'frame', pixels, bytesPerRow, width, height, frameIndex, format }
 *   { type: 'lost', reason }
 */

import { createDirect3D8 } from '../d3d8/device.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFrameLatency } from '../webgpu/internal/latency.js';
import { createReceiver } from './channel.js';
import { playedDirect3D } from './direct3d.js';

/** @type {Record<string, (services: any) => any>} */
const FACTORIES = { d3d8: createDirect3D8, d3d9: createDirect3D9 };

/** GPUTextureUsage.COPY_DST, here without the browser's global. */
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
     * A presented frame as a picture, sent back.
     *
     * @param {any} device
     * @param {{ surface: { texture: any, width: number, height: number, format: string },
     *     frameIndex: number }} frame
     */
    const present = (device, frame)=>{
        const { surface } = frame;
        if (frames === 'pixels')
        {
            readPixels(device, frame);
            return;
        }
        if (frames !== 'bitmap')
        {
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
        scope.postMessage({ type: 'frame', bitmap, frameIndex: frame.frameIndex,
            format: surface.format }, [bitmap]);
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
                format }, [pixels.buffer]);
        }, ()=>buffer.destroy());
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
     */
    const root = async(api, options, port)=>{
        const { device, backend, latency } = await /** @type {Promise<any>} */ (opened);
        /** @type {(message: any, transfer?: Transferable[]) => void} */
        const post = (message, transfer)=>port.postMessage(message, transfer ?? []);
        const played = playedDirect3D(FACTORIES[api], {
            ...options,
            backend,
            createSampler: (/** @type {any} */ descriptor)=>device.createSampler(descriptor),
            // The program has memory; what of it this side reads is what it is sent.
            readMemory: true,
            writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
                post({ type: 'wrote', writes: [{ address, bytes: bytes.slice() }] }),
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
            frameQueued: (/** @type {any} */ submitted)=>latency.queued(submitted),
            gamma: options.gamma ? { applies: ()=>true, set: ()=>{} } : undefined,
        });
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
            case 'root':
                root(data.api, data.options ?? {}, data.port).catch(e=>
                    data.port.postMessage({ type: 'failed', message: String(e?.message ?? e) }));
                break;
            default:
                break;
        }
    };
}
