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
    samples: 200000,
    // The head of a run, because what a program decides it decides early. A
    // caller after something that happens later says how much more to keep:
    // the cap is what stops a long run turning into hundreds of megabytes of
    // text, not a judgement about which end matters.
    log: 400000,
};

/** Every instruction pointer the sampler saw, in order. @type {number[]} */
const samples = [];

/** Written out rather than escaped, so no tooling can mangle it. */
const NEWLINE = String.fromCharCode(10);

/** Every host call, formatted, when one was asked for. @type {string[]} */
const callLog = [];

/**
 * One host call as a line, the same shape the command-line probe prints.
 *
 * @param {any} call
 * @returns {string}
 */
function formatCall(call){
    const args = (call.args ?? []).map((/** @type {number} */ value,
        /** @type {number} */ index)=>(
        call.strings?.[index]
            ? `${JSON.stringify(call.strings[index])}@0x${(value >>> 0).toString(16)}`
            : `0x${(value >>> 0).toString(16)}`)).join(', ');
    const from = `0x${(call.from >>> 0).toString(16).padStart(8, '0')}`;
    const left = call.error ? `  [err ${call.error}]` : '';
    return `${from}  ${call.name}(${args}) = ${call.result}${left}`;
}

/**
 * Where the guest spent its instructions, by module and offset.
 *
 * Counted here rather than sent out raw: a couple of hundred thousand addresses
 * is megabytes over the wire, and the only thing anyone reads is the top of the
 * histogram. A page says which function; an exact address says which loop, and
 * a program that has stopped making progress is sitting in one.
 *
 * @param {string[]} layout  As the memory layer reports it.
 * @returns {(address: number, mask?: number) => string}
 */
function symboliser(layout){
    const regions = layout.map(entry=>{
        const [name, extent] = entry.split(' ');
        const [base, size] = extent.split('+').map(Number);
        return { name, base, end: base + size };
    }).sort((left, right)=>left.base - right.base);

    return (address, mask = 0xffffffff)=>{
        const region = regions.find(entry=>address >= entry.base && address < entry.end);
        return region
            ? `${region.name}+0x${((address - region.base) & mask).toString(16)}`
            : '<unmapped>';
    };
}

/**
 * @param {string[]} layout  As the memory layer reports it.
 */
function profile(layout){
    if (samples.length === 0)
    {
        return null;
    }
    const where = symboliser(layout);
    /** @param {number} mask @param {number} keep */
    const histogram = (mask, keep)=>{
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const eip of samples)
        {
            const key = where(eip, mask);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts].sort((left, right)=>right[1] - left[1]).slice(0, keep)
            .map(([at, count])=>({ at, count, share: count / samples.length }));
    };

    return { samples: samples.length, pages: histogram(~0xfff, 16), exact: histogram(~0, 16) };
}

/** @type {any} */
const namespace = { errors: [] };

/**
 * Hands the call log out in pieces.
 *
 * A quarter of a million lines is twenty megabytes, which is more than one
 * evaluation can carry back, so the driver asks repeatedly until it is told
 * there is no more.
 *
 * @param {number} from @param {number} count
 */
namespace.drainLog = (from, count)=>callLog.slice(from, from + count).join(NEWLINE);
namespace.logLines = ()=>callLog.length;

/**
 * Where a frame's time goes, asked while the run is still going.
 *
 * A report at the end of a run answers what a whole run cost; this answers what
 * one frame costs, which is the question a frame rate is. Filled in by `start`
 * once the engine exists.
 *
 * @type {(() => string) | null}
 */
namespace.frameReport = null;
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

/**
 * The same pixels with the first and third byte of each exchanged.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function swapRedAndBlue(bytes){
    const swapped = new Uint8Array(bytes);
    for (let at = 0; at < swapped.length; at += 4)
    {
        const first = swapped[at];
        swapped[at] = swapped[at + 2];
        swapped[at + 2] = first;
    }
    return swapped;
}

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes){
    let binary = '';
    // In chunks: `apply` on a whole texture's worth of arguments overflows the
    // call stack, and does so only for the large textures.
    for (let at = 0; at < bytes.length; at += 0x8000)
    {
        binary += String.fromCharCode.apply(null, [...bytes.subarray(at, at + 0x8000)]);
    }
    return btoa(binary);
}

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

/**
 * How opaque the presented frame is.
 *
 * A back buffer whose Direct3D format carries no alpha still has one in the
 * texture it is rendered into, and whatever the draws left there decides how
 * much of the page shows through when the frame is painted. A frame that is
 * not fully opaque is being composited against something the program never
 * knew about, and nothing in the colours says so.
 *
 * @param {{ pixels: Uint8Array }} image
 */
function opacity(image){
    let low = 255;
    let high = 0;
    let belowFull = 0;
    for (let at = 3; at < image.pixels.length; at += 4)
    {
        const alpha = image.pixels[at];
        low = Math.min(low, alpha);
        high = Math.max(high, alpha);
        if (alpha < 255)
        {
            belowFull++;
        }
    }
    return { low, high, belowFull, of: image.pixels.length / 4 };
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
                continue;
            }
            // A small flat structure of numbers is a measurement too, and
            // dropping it is how a counter added to a layer never appears in
            // any report. What this refuses is the thing it was written to
            // refuse: a ring buffer, a table, anything with a shape.
            if (value !== null && typeof value === 'object' && !Array.isArray(value))
            {
                const entries = Object.entries(value);
                if (entries.length <= 12
                    && entries.every(([, held])=>typeof held === 'number'
                        || typeof held === 'string'))
                {
                    metrics[name] = /** @type {any} */ (value);
                }
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

    // Optional, and asked for anyway: without it a program's cinematic is a
    // graph with nothing in it, which is a real state of a machine and not the
    // one worth measuring. A build that has no decoder to fetch runs as before.
    const decoder = request.video === false ? null : await fetch(
        new URL('../../../vendor/prebuilt/video-decoder.wasm', import.meta.url))
        .then(response=>response.ok ? response.arrayBuffer() : null)
        .catch(()=>null);

    /** @type {any} */
    let presented = null;
    let presents = 0;
    /** @type {any} */
    const collected = { failures: [], missing: [], output: [], events: [] };

    /** @type {any} */
    let running = null;
    namespace.frameReport = ()=>{
        if (!running)
        {
            return JSON.stringify({ ready: false });
        }
        const seen = running.log.profile(8);
        const layers = Object.fromEntries(running.diagnostics()
            .map((/** @type {any} */ layer)=>[layer.name, layer.metrics ?? {}]));
        return JSON.stringify({
            ready: true,
            frames: seen.frames,
            averageFrameMs: seen.averageFrameMs,
            hostShare: seen.hostShare,
            // Every phase that took part in a frame, by the time that was its
            // own rather than its children's.
            phases: seen.phases.slice(0, 24).map((/** @type {any} */ row)=>({
                name: row.name, kind: row.kind, count: row.count,
                selfMs: row.selfMs, worstMs: row.worstMs,
            })),
            worstFrames: seen.worstFrames.map((/** @type {any} */ frame)=>({
                index: frame.index, ms: frame.ms, byKind: frame.byKind,
            })),
            recentFrames: seen.recentFrames.map((/** @type {any} */ frame)=>({
                ms: frame.ms, byKind: frame.byKind,
            })),
            messages: layers.win32?.messages ?? null,
            // What reached the screen, and what was refused on the way. A film
            // that decodes and is never seen is the difference between these
            // two and nothing else.
            presenter: layers.graphics?.presenter ?? null,
            media: layers.media ?? null,
            instructions: layers.cpu?.instructions ?? 0,
            presents: presents,
            graphics: layers.graphics?.seam?.device
                ? {
                    frames: layers.graphics.seam.device.frames,
                    draws: layers.graphics.seam.device.draws,
                }
                : null,
        });
    };

    const app = await createApp({
        executable: fromBase64(request.exe),
        v86: {
            moduleUrl: new URL('../../../vendor/prebuilt/libv86.mjs', import.meta.url).href,
            wasmBytes: wasm,
        },
        media: decoder ? { wasmBytes: decoder } : undefined,
        imagePath: request.imagePath,
        // A run is read afterwards, which is exactly when a stack string is gone.
        traceStrings: true,
        // Every call, not the last two hundred. What a program decided is
        // decided early, and by the time it stops the ring that would have
        // shown it has been overwritten many times over. Kept as formatted
        // lines rather than objects: the only thing anyone does with them is
        // read them, and a quarter of a million objects is memory this page
        // has better uses for.
        onCall: request.log
            ? (/** @type {any} */ call)=>{
                if (callLog.length < (request.logLines || LIMITS.log))
                {
                    callLog.push(formatCall(call));
                }
            }
            : undefined,
        // Sampled guest execution, when asked for. A program that decides
        // something inside its own code makes no host call to record, and the
        // instruction pointer is then the only account of what it was doing --
        // which is exactly the situation once a game reaches its own main loop.
        quantum: request.quantum || undefined,
        sample: request.quantum
            ? (/** @type {number} */ eip)=>{
                if (samples.length < LIMITS.samples)
                {
                    samples.push(eip);
                }
            }
            : undefined,
        device: {
            device: handle.device,
            queue: handle.device.queue,
            // Where every draw of the last frame landed, when the run asked
            // for it. A frame is the only thing that says which draw painted a
            // given patch of the picture, and working that out costs a
            // transform of every vertex -- so it is off unless asked for.
            dumpDraws: Boolean(request.dumpDraws),
            // Cutting a frame short is what turns "one of these draws painted
            // this" into "this one did": the region is either there or not.
            maxDraws: request.maxDraws ?? -1,
            // A draw's index in a frame moves between runs; the texture it
            // binds does not, so this is what removes the same draw twice.
            skipTexture: request.skipTexture ?? null,
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

    // Published before the run, not after: the whole point of the frame report
    // is to be asked while the frames are still happening.
    running = app;

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
        result.opacity = opacity(image);
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
    // Resolved here rather than in the engine, because the module map lives in
    // the memory layer and the bridge is below it. A bare address says a call
    // came from somewhere; `Game.dll+0x63075a` says which code wanted it, which
    // is the difference between a trace and a list of numbers.
    const layout = metrics('memory').layout ?? [];
    const where = symboliser(layout);
    result.bridge = {
        sequence: metrics('bridge').sequence ?? [],
        hot: metrics('bridge').hot ?? [],
        recent: (metrics('bridge').recentDetailed ?? []).slice(-LIMITS.calls)
            .map((/** @type {any} */ call)=>({ ...call, fromName: where(call.from >>> 0) })),
    };
    result.profile = profile(layout);

    // Named rather than left to `scalars`, which keeps only numbers and strings
    // -- every metric this layer reports is an object, so all of them were
    // dropped and a run said nothing whatever about what it drew.
    // Named rather than left to `scalars`, for the same reason the graphics
    // metrics are: the phase totals are an array, and an array is what a
    // question about where a frame went is answered with.
    const timing = metrics('log');
    result.phases = {
        hostShare: timing.hostShare ?? null,
        frames: timing.frames ?? null,
        top: timing.topPhases ?? [],
    };

    const graphics = metrics('graphics');
    result.graphics = {
        created: graphics.created ?? [],
        libraries: graphics.libraries ?? [],
        // `lastFrame` is dropped: it is the recorded commands, kept for a test
        // that replays them here, and it holds backend objects and a uniform
        // block per draw. Neither survives the trip out and both are megabytes.
        device: graphics.seam?.device
            ? {
                ...graphics.seam.device,
                lastFrame: undefined,
                // Bytes do not survive JSON, so they leave as base64 and are
                // written out as images by whoever is driving.
                textures: await Promise.all(
                    (graphics.seam.device.textures ?? []).map(
                        async(/** @type {any} */ texture)=>({
                            ...texture,
                            texels: undefined,
                            gpu: undefined,
                            bgra: toBase64(texture.texels),
                            // What the device holds, against what it was
                            // given. `readBack` hands back RGBA whatever the
                            // storage order was, so it is put back into the
                            // engine's own BGRA before it travels -- one order
                            // in the report, or a red/blue swap reads as a
                            // difference that is not there.
                            deviceBgra: toBase64(
                                swapRedAndBlue((await readBack(handle.device, texture.gpu))
                                    .pixels)),
                        }))),
            }
            : null,
        presenter: graphics.presenter ?? null,
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
