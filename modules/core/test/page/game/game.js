/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page that points the engine at a real title, on a real GPU.
 *
 * The engine runs on this thread rather than in a worker for the same reason
 * the graphics page does: a GPUDevice is neither transferable nor cloneable, so
 * whoever owns the device has to be whoever assembles the module graph.
 *
 * The bundle is never copied in. It stays on the server and arrives one byte
 * range at a time, because a title's bundle is larger than anything a page
 * should hold and the guest only ever reads a small part of it. That makes the
 * range request the transport, and a server that answers 200 to a range is a
 * failure rather than a slow path -- it would mean pulling the whole file.
 *
 * Nothing here decides whether the run went well. The page collects what the
 * engine says about itself and leaves the judgement to whoever is driving.
 */

import { createApp } from '../../../src/app.js';

const out = document.querySelector('#out');
const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#frame'));

/** How much of each unbounded collection survives the trip back out. */
const LIMITS = {
    events: 400, output: 400, calls: 200,
    // Whole files, not a tail. A game of this age writes its own crash report,
    // and it names the exception, the address and the module -- all of which
    // are at the top of the file, which is exactly what a tail throws away.
    file: 1 << 20,
};

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
 * A machine with no WebGPU is an answer rather than a failure of this page, so
 * it travels back the same way a run does.
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
 * One byte range of the bundle.
 *
 * A 206 is the only acceptable answer: a 200 means the server ignored the range
 * and is about to send the whole bundle, which is exactly what this transport
 * exists to avoid.
 *
 * @param {string} url
 * @returns {(offset: number, length: number) => Promise<Uint8Array>}
 */
function rangeFetcher(url){
    return async(offset, length)=>{
        const response = await fetch(url, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        });
        if (response.status !== 206)
        {
            throw new Error(
                `range ${offset}+${length} answered ${response.status}, not 206`);
        }
        return new Uint8Array(await response.arrayBuffer());
    };
}

/**
 * The presented texture, brought back as bytes.
 *
 * Rows arrive padded to the copy alignment, so the padding is dropped here and
 * the caller sees a tight RGBA image.
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
 * The colours the frame is made of, most common first. A frame that is one
 * colour says so here without anyone having to guess which pixel to look at.
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
 * Everything the engine will say about itself while it runs, kept bounded.
 *
 * @param {any} app
 * @param {any} collected
 */
function listen(app, collected){
    app.on('error', (/** @type {any} */ payload)=>{
        collected.failures.push({
            reason: payload.reason ?? payload.error?.reason,
            message: payload.error?.message ?? payload.message,
            stack: String(payload.error?.stack ?? payload.stack ?? '').split('\n')
                .slice(0, 8).join('\n'),
            trace: payload.traceText ?? payload.text ?? payload.error?.traceText,
        });
    });
    app.on('resolved', (/** @type {any} */ asked)=>{
        if (asked.found === 0)
        {
            collected.missing.push(`${asked.module}!${asked.name}`);
        }
    });
    app.attachLog((/** @type {number} */ stream, /** @type {string} */ text)=>{
        if (collected.output.length < LIMITS.output)
        {
            collected.output.push(`[${stream}] ${text}`);
        }
    });
    for (const name of ['libraries', 'libraries-missing', 'libraries-attached',
        'library-loaded', 'library-missing', 'unimplemented', 'warning', 'debug',
        'bundle', 'bundle-unavailable'])
    {
        app.on(name, (/** @type {any} */ payload)=>{
            if (collected.events.length < LIMITS.events)
            {
                collected.events.push(`[${name}] ${JSON.stringify(payload).slice(0, 300)}`);
            }
        });
    }
}

/**
 * The diagnostics table, reduced to what survives JSON without carrying a ring
 * buffer per layer along with it.
 *
 * @param {any[]} layers
 */
function scalars(layers){
    return layers.map(layer=>{
        /** @type {Record<string, string | number>} */
        const metrics = {};
        for (const [name, value] of Object.entries(layer.metrics ?? {}))
        {
            if (typeof value === 'number' || typeof value === 'string')
            {
                metrics[name] = value;
            }
        }
        return { name: layer.name, status: layer.status, metrics };
    });
}

/**
 * Runs one title and reports what came out of it.
 *
 * @param {{ exe: string, bundleUrl: string, imagePath: string,
 *           maxTurns?: number }} request
 * @returns {Promise<any>}
 */
async function run(request){
    const handle = await opened;
    if (!handle.available)
    {
        return { ok: false, gpu: false, reason: handle.reason };
    }

    const wasm = await fetch(new URL('../../../vendor/prebuilt/v86.wasm', import.meta.url))
        .then(response=>response.arrayBuffer());

    /** @type {any} */
    let presented = null;
    let presents = 0;
    /** @type {any} */
    const collected = { failures: [], missing: [], output: [], events: [] };

    const app = await createApp({
        executable: fromBase64(request.exe),
        v86: {
            moduleUrl: new URL('../../../vendor/prebuilt/libv86.mjs', import.meta.url).href,
            wasmBytes: wasm,
        },
        imagePath: request.imagePath,
        // A run is read afterwards, which is exactly when a stack string is gone.
        traceStrings: true,
        device: {
            device: handle.device,
            queue: handle.device.queue,
            /** @param {any} frame */
            presentTo: frame=>{
                presented = frame;
                presents++;
            },
        },
        bundle: {
            fetch: rangeFetcher(request.bundleUrl),
            // Nothing durable: the page is thrown away with the browser, and a
            // cache here would only measure how fast this machine writes.
            store: null,
            prefetch: false,
        },
        storage: null,
    });

    listen(app, collected);

    /** @type {any} */
    const result = { ok: false, gpu: true, adapter: handle.adapter };
    const loaded = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'loader');
    result.unresolved = loaded?.metrics?.unresolved ?? app.image?.unresolved ?? [];

    const started = performance.now();
    try
    {
        result.exitCode = await app.run({ maxTurns: request.maxTurns ?? 200000 });
        result.stopped = `exited with ${result.exitCode}`;
        result.ok = true;
    }
    catch (e){
        const failure = /** @type {any} */ (e);
        result.stopped = failure.message;
        result.error = failure.message;
        result.reason = failure.reason;
        result.trace = failure.traceText;
    }
    result.elapsedMs = Math.round(performance.now() - started);

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
        result.colours = census(image);
    }
    result.presents = presents;

    const layers = app.diagnostics();
    /** @param {string} name */
    const metrics = name=>layers.find((/** @type {any} */ entry)=>entry.name === name)
        ?.metrics ?? {};
    result.layers = scalars(layers);
    result.instructions = metrics('cpu').instructions ?? null;
    result.threads = {
        byState: metrics('kernel').byState ?? {},
        waiting: metrics('kernel').waiting ?? [],
    };
    result.bridge = {
        sequence: metrics('bridge').sequence ?? [],
        hot: metrics('bridge').hot ?? [],
        recent: (metrics('bridge').recentDetailed ?? []).slice(-LIMITS.calls),
    };

    // What the program wrote. A game of this age keeps its own log, and it says
    // in plain words what it thought went wrong.
    result.files = app.session.export().map((/** @type {any} */ file)=>({
        path: file.path,
        bytes: file.bytes.length,
        truncated: file.bytes.length > LIMITS.file,
        text: new TextDecoder('latin1')
            .decode(file.bytes.subarray(0, LIMITS.file)),
    }));

    result.failures = collected.failures;
    result.missing = [...new Set(collected.missing)];
    result.output = collected.output;
    result.events = collected.events;
    result.errors = namespace.errors;

    await app.dispose();
    out.textContent = `${result.stopped}\n${result.instructions} instructions`;
    return result;
}

/**
 * Starts a run and leaves the result here rather than returning it.
 *
 * The engine runs on this thread, so for long stretches nothing on this page is
 * answered -- a driver waiting on a returned promise would be waiting on a
 * thread that cannot answer it. So it is polled for instead.
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
            namespace.result = {
                ok: false,
                error: String(error && error.message),
                stack: String(error && error.stack).split('\n').slice(0, 8).join('\n'),
            };
        });
};

opened.then(handle=>{
    out.textContent = handle.available
        ? 'ready: a device answered, waiting for a title'
        : `no device: ${handle.reason}`;
});
