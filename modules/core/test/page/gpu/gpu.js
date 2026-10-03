/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page that runs a guest program against a real GPU.
 *
 * The core runs here rather than in a worker, and the device is made here too.
 * A GPUDevice cannot be handed to a worker -- it is not transferable and not
 * structured-cloneable -- so the side that owns the device is the side that has
 * to assemble the module graph, and the canvas the frame is shown on lives on
 * this side anyway. The worker in the sibling page exists to prove the core
 * comes up inside one; nothing here needs that, and putting the two together
 * would mean an OffscreenCanvas and a message protocol between them for no
 * measurement either would add.
 *
 * Everything this page decides is reported rather than asserted. What the
 * colours mean, and which of them is right, belongs to whoever is driving --
 * this file only says what the pixels are.
 */

import { createApp } from '../../../src/app.js';
import { openGraphicsWorker } from '../../../src/host/graphics-worker.js';

const out = document.querySelector('#out');
const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#frame'));

/** @type {any} */
const namespace = { errors: [] };
/** @type {any} */ (window).__bottlify__ = namespace;

window.addEventListener('error', event=>{
    namespace.errors.push(`page:${event.message}`);
});
window.addEventListener('unhandledrejection', event=>{
    const reason = /** @type {any} */ (event).reason;
    namespace.errors.push(
        `unhandled:${reason && reason.message ? reason.message : String(reason)}`);
});

/**
 * @typedef {Object} GpuHandle
 * @property {boolean} available
 * @property {string} [reason]
 * @property {any} [device]
 * @property {any} [adapter]
 */

/**
 * The device, or the reason there is none.
 *
 * A machine with no WebGPU is a real answer rather than a failure of this page,
 * so it is reported the same way a frame is: whoever is driving decides what to
 * make of it.
 *
 * @returns {Promise<GpuHandle>}
 */
async function openDevice(){
    if (!navigator.gpu)
    {
        return { available: false, reason: 'navigator.gpu is not defined' };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
    {
        return { available: false, reason: 'no adapter answered requestAdapter' };
    }
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (/** @type {any} */ event)=>{
        namespace.errors.push(`gpu:${event.error.message}`);
    });
    const info = adapter.info ?? {};
    return {
        available: true,
        device,
        adapter: {
            vendor: info.vendor ?? '',
            architecture: info.architecture ?? '',
            description: info.description ?? '',
            fallback: adapter.isFallbackAdapter === true,
        },
    };
}

const opened = openDevice();
namespace.gpu = opened.then(handle=>({
    available: handle.available,
    reason: handle.reason,
    adapter: handle.adapter,
}));

/** @param {string} text @returns {Uint8Array} */
function fromBase64(text){
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++)
    {
        bytes[at] = binary.charCodeAt(at);
    }
    return bytes;
}

/**
 * The presented texture, brought back as bytes.
 *
 * Copied out of exactly the surface the backend handed to `presentTo`: the one
 * the program actually presented, rather than a render target picked from the
 * side. Rows arrive padded to the copy alignment, so the padding is dropped
 * here and the caller sees a tight RGBA image.
 *
 * @param {any} device
 * @param {any} surface
 * @returns {Promise<{ width: number, height: number, pixels: Uint8Array }>}
 */
async function readBack(device, surface){
    const ALIGNMENT = 256;
    const bytesPerRow = Math.ceil(surface.width * 4 / ALIGNMENT) * ALIGNMENT;
    const staging = device.createBuffer({
        size: bytesPerRow * surface.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({ label: 'read-back' });
    encoder.copyTextureToBuffer(
        { texture: surface.texture },
        { buffer: staging, bytesPerRow },
        { width: surface.width, height: surface.height, depthOrArrayLayers: 1 });
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(staging.getMappedRange());
    const pixels = new Uint8Array(surface.width * surface.height * 4);
    for (let row = 0; row < surface.height; row++)
    {
        pixels.set(
            mapped.subarray(row * bytesPerRow, row * bytesPerRow + surface.width * 4),
            row * surface.width * 4);
    }
    staging.unmap();
    staging.destroy();

    // The back buffer is a BGRA texture, so what came back is in that order.
    // Turned into RGBA here, where the format is still known, rather than
    // leaving every reader to remember it.
    if (surface.format.startsWith('bgra'))
    {
        for (let at = 0; at < pixels.length; at += 4)
        {
            const blue = pixels[at];
            pixels[at] = pixels[at + 2];
            pixels[at + 2] = blue;
        }
    }
    return { width: surface.width, height: surface.height, pixels };
}

/**
 * @param {{ width: number, height: number, pixels: Uint8Array }} image
 * @param {{ name: string, x: number, y: number }[]} points
 */
function sample(image, points){
    return points.map(point=>{
        const at = (point.y * image.width + point.x) * 4;
        return {
            name: point.name,
            x: point.x,
            y: point.y,
            rgba: [image.pixels[at], image.pixels[at + 1],
                image.pixels[at + 2], image.pixels[at + 3]],
        };
    });
}

/**
 * The colours the frame is actually made of, most common first. A frame that
 * is one colour, or one that is empty, says so here without anyone having to
 * guess which pixel to look at.
 *
 * @param {{ pixels: Uint8Array }} image
 */
function census(image){
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (let at = 0; at < image.pixels.length; at += 4)
    {
        const colour = (image.pixels[at] << 16 | image.pixels[at + 1] << 8
            | image.pixels[at + 2]) >>> 0;
        counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    return [...counts]
        .sort((left, right)=>right[1] - left[1])
        .slice(0, 6)
        .map(([colour, count])=>({ rgb: colour, count }));
}

/** @param {{ width: number, height: number, pixels: Uint8Array }} image */
function show(image){
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.putImageData(
        new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
}

/**
 * Runs one guest program and reports what came out of it.
 *
 * @param {{ exe: string, samples: { name: string, x: number, y: number }[],
 *           words: number, maxTurns?: number, graphicsWorker?: boolean }} request
 * @returns {Promise<any>}
 */
async function run(request){
    const handle = await opened;
    if (!handle.available)
    {
        return { ok: false, reason: handle.reason, gpu: false };
    }

    // Asked for, the Direct3D devices draw in the graphics worker, on a
    // device of its own, and its frames come back to this one.
    const graphics = request.graphicsWorker
        ? await openGraphicsWorker({
            url: new URL('../../../src/host/graphics.worker.js', import.meta.url),
            frames: request.graphicsWorker === true ? 'bitmap' : request.graphicsWorker })
        : null;
    if (graphics && !graphics.worker)
    {
        return { ok: false, gpu: true, reason: `graphics worker: ${graphics.reason}` };
    }

    /** @type {any} */
    let presented = null;
    const app = await createApp({
        executable: fromBase64(request.exe),
        screen: { width: 320, height: 240, bitsPerPixel: 32 },
        device: {
            device: handle.device,
            queue: handle.device.queue,
            worker: graphics?.worker ?? undefined,
            /** @param {any} frame */
            presentTo: frame=>{
                presented = frame;
            },
        },
    });

    /** @type {number[]} */
    const bytes = [];
    app.attachLog((/** @type {number} */ unused, /** @type {string} */ text)=>{
        for (const character of text)
        {
            bytes.push(character.charCodeAt(0));
        }
    });

    /** @type {any} */
    const result = { ok: false, gpu: true, adapter: handle.adapter, errors: namespace.errors };
    try
    {
        result.exitCode = await app.run({ maxTurns: request.maxTurns ?? 200000 });
        result.ok = true;
    }
    catch (e){
        const failure = /** @type {any} */ (e);
        result.error = failure.message;
        result.reason = failure.reason;
        result.trace = failure.traceText;
    }

    // The program is answered before its frame reaches the queue -- Present
    // returns and the submission happens on the chain behind it -- so a
    // read-back taken the instant the program exits reads nothing.
    const deadline = performance.now() + 5000;
    for (;;)
    {
        if (presented || performance.now() > deadline)
        {
            break;
        }
        await new Promise(resolve=>setTimeout(resolve, 20));
    }

    result.report = [];
    for (let index = 0; index < request.words && index * 4 + 3 < bytes.length; index++)
    {
        const at = index * 4;
        result.report.push((bytes[at] | bytes[at + 1] << 8
            | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0);
    }

    if (presented)
    {
        const image = await readBack(handle.device, presented.surface);
        show(image);
        result.frame = {
            index: presented.frameIndex,
            width: image.width,
            height: image.height,
            format: presented.surface.format,
        };
        result.samples = sample(image, request.samples);
        result.colours = census(image);
    }

    const diagnostics = app.diagnostics();
    /** @param {string} name */
    const metrics = name=>diagnostics.find((/** @type {any} */ entry)=>entry.name === name)
        ?.metrics ?? null;
    result.graphics = metrics('graphics');
    result.bridge = {
        calls: metrics('bridge')?.calls,
        lastCall: metrics('bridge')?.lastCall,
        comInterfaces: metrics('bridge')?.comInterfaces,
        comMethods: metrics('bridge')?.comMethods,
        sequence: metrics('bridge')?.sequence,
    };

    await app.dispose();
    out.textContent = JSON.stringify(result, null, 2);
    return result;
}

/**
 * Starts a run and leaves the result here rather than returning it.
 *
 * The core runs on this thread, so nothing on this page is answered while a
 * program runs -- a driver that waited on a returned promise would be waiting
 * on a thread that cannot answer it. So it is polled for instead.
 *
 * @param {any} request
 */
namespace.start = request=>{
    namespace.result = null;
    run(request).then(
        result=>{
            namespace.result = result;
        },
        error=>{
            namespace.result = { ok: false, error: String(error && error.message) };
        });
};

opened.then(handle=>{
    out.textContent = handle.available
        ? 'ready: a device answered, waiting for a program'
        : `no device: ${handle.reason}`;
});
