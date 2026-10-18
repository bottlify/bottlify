/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The harness that points the engine at a real title, on a real GPU.
 *
 * Runs wherever it is created: on the page's own thread, or inside a worker
 * the page hands an OffscreenCanvas to. Whoever owns the GPU device has to be
 * whoever assembles the module graph, so the device is opened here, and the
 * frame is read back here -- both are the same code on either thread, and
 * `game.js` and `worker.js` are only the two ways of reaching it.
 *
 * The bundle is never copied in. It stays on the server and arrives one byte
 * range at a time, because a title's bundle is larger than anything a page
 * should hold and the guest only ever reads a small part of it. That makes the
 * range request the transport, and a server that answers 200 to a range is a
 * failure rather than a slow path -- it would mean pulling the whole file.
 *
 * Nothing here decides whether the run went well. The harness collects what
 * the engine says about itself and leaves the judgement to whoever is driving.
 */

import { createApp } from '../../../src/app.js';
import { placeHooks, watchFrom } from '../../../src/host/serve.js';
import { openGraphicsWorker } from '../../../src/host/graphics-worker.js';
import { createFakeDevice } from '../../../src/layers/graphics/webgpu/internal/fake-device.js';
import { createInputRoute } from '../../../src/layers/input/route.js';
import {
    SLOTS, GLOBAL_HEADER_INT32, SLOT_HEADER_INT32, SLOT_BYTES, ARENA_OFFSET, ARENA_BYTES,
    slotHeaderOffset, slotPcmOffset, createSeam, mixBlock,
} from '../../../src/layers/audio/output/mix.js';

/** How much of each unbounded collection survives the trip back out. */
const LIMITS = {
    // Output whole: a conformance test prints three pieces per failed check,
    // and 400 ended Wine's d3d8 visual at its 130th.
    events: 400, output: 20000, calls: 200, shaders: 2000, divergences: 2000,
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

/**
 * Where the guest was, and how much it retired while it was there.
 *
 * Weighted, because a sample per scheduler turn counts a parked thread that
 * retired two instructions the same as a working one that retired a hundred
 * thousand -- and an unweighted profile of this machine therefore reads as
 * though it spends a seventh of its life in the park loop.
 *
 * Folded in as the samples arrive rather than kept as a list. A title at a low
 * quantum samples hundreds of thousands of times a second, so a list is capped
 * within a second or two and stops measuring the window at all; the addresses
 * the guest runs are bounded by the code that exists, which is the right thing
 * to keep.
 *
 * @type {Map<number, { retired: number, count: number }>}
 */
const samples = new Map();

/**
 * One retirement at one address, folded into the running account by module
 * and offset rather than kept as a list -- a title at a low quantum samples
 * hundreds of thousands of times a second, and a list stops measuring the
 * window at all once it is capped.
 *
 * @param {number} eip
 * @param {number} retired
 */
export function recordSample(eip, retired){
    const at = samples.get(eip);
    if (at)
    {
        at.retired += retired;
        at.count++;
    }
    else
    {
        samples.set(eip, { retired, count: 1 });
    }
}

/** Begins the sampled account afresh, the way a new window of it should. */
export function resetSamples(){
    samples.clear();
}

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
export function formatCall(call){
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
 * The guest's regions, lowest first, as the memory layer reports them.
 *
 * @param {string[]} layout
 */
export function regionsOf(layout){
    return layout.map(entry=>{
        const [name, extent] = entry.split(' ');
        const [base, size] = extent.split('+').map(Number);
        return { name, base, end: base + size };
    }).sort((left, right)=>left.base - right.base);
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
export function symboliser(layout){
    const regions = regionsOf(layout);

    return (address, mask = 0xffffffff)=>{
        const region = regions.find(entry=>address >= entry.base && address < entry.end);
        return region
            ? `${region.name}+0x${((address - region.base) & mask).toString(16)}`
            : '<unmapped>';
    };
}

/**
 * Instructions credited to each module, heaviest first.
 *
 * The same walk the histograms make, kept at module granularity: a title's own
 * code is one region and the CRT it links another, so this is the number that
 * says whether the guest's time is the game or the library under it.
 *
 * @param {{ address: number, weight: number }[]} entries
 * @param {string[]} layout
 */
export function byModule(entries, layout){
    const regions = regionsOf(layout);
    /** @type {Map<string, number>} */
    const counts = new Map();
    let total = 0;
    for (const { address, weight } of entries)
    {
        const region = regions.find(entry=>address >= entry.base && address < entry.end);
        const name = region ? region.name : '<unmapped>';
        counts.set(name, (counts.get(name) ?? 0) + weight);
        total += weight;
    }
    return [...counts].sort((left, right)=>right[1] - left[1])
        .map(([at, count])=>({ at, count, share: count / Math.max(1, total) }));
}

/**
 * @param {string[]} layout  As the memory layer reports it.
 */
export function profile(layout){
    if (samples.size === 0)
    {
        return null;
    }
    const where = symboliser(layout);
    let turns = 0;
    let retired = 0;
    for (const one of samples.values())
    {
        turns += one.count;
        retired += one.retired;
    }
    /** @param {number} mask @param {number} keep */
    const histogram = (mask, keep)=>{
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const [eip, one] of samples)
        {
            const key = where(eip, mask);
            counts.set(key, (counts.get(key) ?? 0) + one.retired);
        }
        return [...counts].sort((left, right)=>right[1] - left[1]).slice(0, keep)
            .map(([at, count])=>({ at, count, share: count / Math.max(1, retired) }));
    };

    return {
        samples: turns,
        retired,
        // The window's own modules, from the same samples the pages are.
        modules: byModule([...samples].map(([address, one])=>(
            { address, weight: one.retired })), layout),
        pages: histogram(~0xfff, 16),
        exact: histogram(~0, 32),
    };
}

/**
 * The `cpu` layer's always-on sampler, named against the memory layer's
 * module layout the same way a bridge call's own `from` address is
 * (`result.bridge.recent`'s `fromName`). The engine reports raw address
 * buckets on purpose and leaves this
 * resolving step to whoever reads them.
 *
 * @param {{ slices: number, overflow: number, top: { address: number,
 *     instructions: number, ms: number, samples: number }[] } | undefined} sampler
 * @param {string[]} layout  As the memory layer reports it.
 */
export function guestSamples(sampler, layout){
    if (!sampler)
    {
        return null;
    }
    const where = symboliser(layout);
    return {
        slices: sampler.slices,
        overflow: sampler.overflow,
        top: sampler.top.map(bucket=>({
            at: where(bucket.address),
            instructions: bucket.instructions,
            samples: bucket.samples,
        })),
    };
}

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
 * @param {string[]} errors
 * @returns {Promise<GpuHandle>}
 */
async function openDevice(errors){
    if (!navigator.gpu)
    {
        return { available: false, reason: 'navigator.gpu is not defined' };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
    {
        return { available: false, reason: 'no adapter answered requestAdapter' };
    }
    const features = ['texture-compression-bc', 'depth-clip-control']
        .filter(feature=>adapter.features.has(feature));
    const device = await adapter.requestDevice({ requiredFeatures: features });
    device.addEventListener('uncapturederror', (/** @type {any} */ event)=>{
        errors.push(`gpu:${event.error.message}`);
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

/**
 * A device that takes every call and draws nothing (`fakeGpu`), for a run that
 * measures the engine alone: a software rasteriser shares the machine's cores
 * with it and holds it waiting for frames, which a person's GPU does not.
 *
 * @returns {GpuHandle}
 */
function fakeDevice(){
    const gpu = createFakeDevice();
    // The fake keeps every call it was given for a test to look at; a run
    // minutes long would hold gigabytes of it. Nothing reads the log here.
    setInterval(()=>{
        gpu.calls.length = 0;
    }, 1000);
    Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
    return { available: true, device: gpu.device,
        adapter: { vendor: 'fake', architecture: '', description: 'draws nothing',
            fallback: false } };
}

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
 * Files a run puts on the volume before the program's first instruction, in
 * the shape `createApp`'s `storage` loader answers with: what an earlier run
 * wrote (a recorded demo, a saved profile) handed to the next one, so a title
 * can be started on something only it knows how to produce.
 *
 * @param {{ path: string, base64: string }[]} files
 * @returns {{ path: string, bytes: Uint8Array }[]}
 */
export function seedFiles(files){
    return files.map(file=>({ path: file.path, bytes: fromBase64(file.base64) }));
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

/**
 * @param {any} canvas   A canvas or an OffscreenCanvas; a 2D context either way.
 * @param {{ width: number, height: number, pixels: Uint8Array }} image
 */
function show(canvas, image){
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.putImageData(
        new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
}

/** Frames of slack a drain may fall behind by before it starts dropping the
 * backlog rather than trying to catch up in one giant block -- the same 200
 * ms depth the ring's own default capacity was. */
const DRAIN_CAP_FRAMES = 16384;

/**
 * Reads the other end of the sound output, at the rate a device would.
 *
 * A real page on shared memory hands the far end to an audio worklet running
 * on the browser's own audio-rendering thread; this harness has no `<audio>`
 * a person is meant to hear, so rather than create a real one it stands in
 * for it here instead -- which is deliberately not a no-op: `READ` only ever
 * moves inside `resampleInto`, so with nothing ever calling it a track's
 * backlog policy (`DROP_TO`) would mark where to skip to but `playedBytes()`
 * would stay at zero forever, and a program waiting on a buffer position
 * would wait forever with it. Unlike a real worklet it is not audible, and
 * unlike a real worklet it is not what a shipped page does -- the launcher's
 * own page creates the real one, on its own thread. This one is not: in the
 * harness's own worker mode this file runs *inside* the engine worker, the
 * same thread a profile of the engine measures, so a run through this stand-
 * in still carries `resampleInto`/`mixBlock`'s cost in that profile, just
 * moved off the per-turn `pump()` call into this timer instead of gone --
 * see `dbg/opengl/report-next-2.md` for what that costs in practice.
 *
 * Without shared memory there is no worklet this engine could ever hand a
 * ring to, so the ring is read here and dropped instead: what matters for a
 * measurement is that it is read on the clock, because a play cursor is what
 * the device consumed and a film that paces itself by its own sound has no
 * clock at all without one.
 *
 * @param {any} app
 * @param {{ fromMs: number, toMs: number, blocks: Int16Array[] } | null} [capture]
 *     what was mixed between two moments of the run, kept to be written out
 * @param {((table: ArrayBufferLike, sampleRate: number) => void) | undefined} [elsewhere]
 *     who reads the table instead, on a thread of its own: the page, when the
 *     engine runs in a worker, as a launcher's worklet reads it off the engine's
 * @returns {string} how the sound is read
 */
function drainSound(app, capture = null, elsewhere = undefined){
    const table = app.audio.table?.();
    if (table && elsewhere)
    {
        elsewhere(table, app.audio.format().sampleRate);
        return 'table, on the page';
    }
    if (table)
    {
        drainTable(table, app.audio.format().sampleRate, capture);
        return 'table';
    }
    const ring = app.audio.ring?.();
    if (!ring)
    {
        return 'none';
    }
    const { sampleRate, channels } = app.audio.format();
    const block = new Float32Array(ring.capacity * channels);
    let readAt = performance.now();
    setInterval(()=>{
        // By elapsed time rather than a fixed count per turn: this page's main
        // thread is inside the engine most of the time, so the reads are late
        // and bursty, and only the clock keeps the total honest.
        const owed = Math.floor((performance.now() - readAt) * sampleRate / 1000);
        const frames = Math.min(ring.capacity, owed);
        if (frames <= 0)
        {
            return;
        }
        // The clock moves on by what was really taken, not by what was asked
        // for. A device reading on its own thread never misses its turn; this
        // one is on the thread the engine is holding, and a read that gave up
        // whatever it was late for would model a device running slow -- which
        // is indistinguishable, in a report, from an engine that cannot feed
        // one.
        readAt += ring.read(block.subarray(0, frames * channels)) * 1000 / sampleRate;
    }, 20);
    return 'ring';
}

/**
 * Stands in for the worklet this harness never creates, over the shared
 * track table: the same `mixBlock` a real `worklet.js` runs, called on a
 * timer on the page's own thread instead of the audio-rendering thread. See
 * {@link drainSound}.
 *
 * @param {ArrayBufferLike} table @param {number} sampleRate
 * @param {{ fromMs: number, toMs: number, blocks: Int16Array[] } | null} capture
 */
export function drainTable(table, sampleRate, capture){
    const global = new Int32Array(table, 0, GLOBAL_HEADER_INT32);
    /** @type {{ header: Int32Array, pcm: Uint8Array }[]} */
    const slots = [];
    /** @type {ReturnType<typeof createSeam>[]} */
    const seams = [];
    for (let slot = 0; slot < SLOTS; slot++)
    {
        slots.push({
            header: new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
            pcm: new Uint8Array(table, slotPcmOffset(slot), SLOT_BYTES),
        });
        seams.push(createSeam());
    }
    // The voices' mirrors, which a playing buffer is read from as a device
    // reads its DMA region.
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(DRAIN_CAP_FRAMES * 2);
    const started = performance.now();
    let readAt = started;
    setInterval(()=>{
        const owed = Math.floor((performance.now() - readAt) * sampleRate / 1000);
        const blockFrames = Math.min(DRAIN_CAP_FRAMES, owed);
        if (blockFrames <= 0)
        {
            return;
        }
        mixBlock({ global, slots, seams, block, blockFrames, outputRate: sampleRate, arena });
        const at = readAt - started;
        if (capture && at >= capture.fromMs && at < capture.toMs)
        {
            capture.blocks.push(Int16Array.from(block.subarray(0, blockFrames * 2),
                value=>Math.max(-32768, Math.min(32767, Math.round(value * 32767)))));
        }
        readAt += blockFrames * 1000 / sampleRate;
    }, 20);
}

/**
 * What a capture holds, as a result carries it: the blocks in one run of
 * 16-bit stereo, base64.
 *
 * @param {{ blocks: Int16Array[] }} capture @param {number} sampleRate
 */
export function packCapture(capture, sampleRate){
    const length = capture.blocks.reduce((sum, one)=>sum + one.length, 0);
    const all = new Int16Array(length);
    let offset = 0;
    for (const one of capture.blocks)
    {
        all.set(one, offset);
        offset += one.length;
    }
    return { sampleRate, pcm: toBase64(new Uint8Array(all.buffer)) };
}

/**
 * How a request's warm-store fields become the bundle option `createApp`
 * reads. Nothing durable by default: the page is thrown away with the
 * browser, and a cache here would only measure how fast this machine writes.
 * A run measuring a warm store asks for `store: 'local'` itself, in a browser
 * profile that survives the shutdown that would otherwise throw the cache
 * away with everything else.
 *
 * @param {{ store?: string, prefetch?: boolean, bundleId?: string }} request
 */
export function bundleStoreOptions(request){
    return {
        store: request.store ?? null,
        prefetch: request.prefetch === true,
        id: request.bundleId ?? undefined,
    };
}

/**
 * Everything the engine will say about itself while it runs, kept bounded.
 *
 * @param {any} app
 * @param {any} collected
 */
export function listen(app, collected){
    // Each shader the program compiled, source and bytecode, for the driver
    // to write out beside the report.
    // Every divergence, in a list of its own: the events' cap is spent on the
    // libraries a program loads first, and what it was refused later was lost.
    for (const name of ['divergence', 'unimplemented', 'warning'])
    {
        app.on(name, (/** @type {any} */ payload)=>{
            if (collected.divergences.length < LIMITS.divergences)
            {
                collected.divergences.push({ kind: name, payload });
            }
        });
    }
    app.on('shader-compiled', (/** @type {any} */ record)=>{
        if (collected.shaders.length < LIMITS.shaders)
        {
            collected.shaders.push({ api: record.api, profile: record.profile,
                entry: record.entry, defines: record.defines, flags: record.flags,
                source: record.source, included: record.included, messages: record.messages,
                tokens: record.tokens ? toBase64(new Uint8Array(record.tokens.buffer,
                    record.tokens.byteOffset, record.tokens.byteLength)) : null });
        }
    });
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
    // A run that hands its process to a child -- an installer's redistributable
    // finishing as the title, a launcher's bootstrapper stepping aside -- keeps
    // going under a different image. Without this a report from such a run
    // looks like one process throughout, which is the one thing it was not.
    for (const name of ['libraries', 'libraries-missing', 'libraries-attached',
        'library-loaded', 'library-missing', 'unimplemented', 'warning', 'debug',
        'bundle', 'bundle-unavailable', 'divergence', 'process-started', 'process-replace',
        'hooks-bound', 'hook-error', 'process-create', 'process-resumed', 'process-server',
        'process-server-exit', 'exit', 'error'])
    {
        app.on(name, (/** @type {any} */ payload)=>{
            if (collected.events.length < LIMITS.events)
            {
                collected.events.push(`[${name}] ${JSON.stringify(payload).slice(0, 300)}`);
            }
        });
    }
    // A message box parks the guest thread until somebody presses a button,
    // and nothing on this page ever will. The box's own default is pressed for
    // it, which is the answer the engine gave before a box waited at all, so a
    // run that ends on one still ends.
    app.on('message-box', (/** @type {any} */ payload)=>{
        if (collected.events.length < LIMITS.events)
        {
            collected.events.push(`[message-box] ${JSON.stringify({
                caption: payload.caption, text: payload.text, type: payload.type,
            }).slice(0, 300)}`);
        }
        app.answerMessageBox?.(payload.id, payload.defaultButton ?? 1);
    });
}

/**
 * Types a key or clicks at a wall-clock moment, not a presented frame: a
 * screen that stops presenting while it waits for a key or a click -- a
 * dialog box, a film waiting on its first frame -- cannot be reached by a
 * frame number, because the frame it would be sent on never comes.
 *
 * @param {any} app
 * @param {{ keyTimes?: { code: string, atMs: number, holdMs?: number }[],
 *     clickTimes?: { x: number, y: number, atMs: number, holdMs?: number }[] }} request
 */
export function scheduleKeyTimes(app, request){
    for (const click of request.clickTimes ?? [])
    {
        setTimeout(()=>{
            app.input.send({ kind: 'pointerMove', x: click.x, y: click.y, dx: 0, dy: 0 });
            app.input.send({ kind: 'pointerButton', button: 'left', down: true });
        }, click.atMs);
        setTimeout(()=>app.input.send({ kind: 'pointerButton', button: 'left', down: false }),
            click.atMs + (click.holdMs ?? 120));
    }
    for (const key of request.keyTimes ?? [])
    {
        setTimeout(()=>app.input.send({ kind: 'key', code: key.code, down: true }),
            key.atMs);
        setTimeout(()=>app.input.send({ kind: 'key', code: key.code, down: false }),
            key.atMs + (key.holdMs ?? 120));
    }
}

/**
 * Presses the buttons a wizard shows, by their labels, as a person reading
 * the screen would: whenever the windows shown change, once they have had
 * `settleMs` to paint, the first label of the list that an enabled button on
 * the screen carries is clicked at the button's centre. An installer's pages
 * come at moments no wall clock or frame count foretells -- a copy takes as
 * long as it takes -- and a page names its way on.
 *
 * Labels compare without their mnemonic `&` and without regard to case. A
 * check box or a radio button is pressed once, as it toggles. Returns the
 * function that stops it.
 *
 * @param {any} app
 * @param {{ presses?: string[], pressSettleMs?: number, pressEveryMs?: number }} request
 * @param {(line: string) => void} [say]  each press, as it is made
 */
export function schedulePresses(app, request, say = ()=>{}){
    const labels = (request.presses ?? []).map(label=>label.replace(/&/g, '').toLowerCase());
    if (labels.length === 0)
    {
        return ()=>{};
    }
    /** @param {any} window */
    const labelOf = window=>String(window.title ?? '').replace(/&/g, '').trim().toLowerCase();
    /** The windows on the screen, and a key that changes when they do. */
    const current = ()=>{
        /** @type {any[]} */
        let windows;
        try
        {
            windows = app.debug?.windows?.() ?? [];
        }
        catch {
            windows = [];
        }
        const byHwnd = new Map(windows.map(window=>[window.hwnd, window]));
        /** @param {any} window @returns {boolean} */
        const shown = window=>window.visible && (!window.child
            || (byHwnd.has(window.parent) && shown(byHwnd.get(window.parent))));
        const showing = windows.filter(shown);
        // A button takes a click only while every window it is inside does:
        // a modal box disables its owner, and the owner's buttons with it.
        /** @param {any} window @returns {boolean} */
        const usable = window=>window.enabled !== false && (!window.child
            || (byHwnd.has(window.parent) && usable(byHwnd.get(window.parent))));
        return { showing: showing.map(window=>({ ...window, enabled: usable(window) })),
            key: showing.map(window=>`${window.hwnd}:${window.title}:${usable(window)}`)
                .join('|') };
    };
    const toggled = new Set();
    let seenKey = '';
    let settling = false;
    let stopped = false;
    const look = ()=>{
        if (settling || stopped)
        {
            return;
        }
        const { key } = current();
        if (key === seenKey)
        {
            return;
        }
        seenKey = key;
        settling = true;
        setTimeout(()=>{
            settling = false;
            const now = current();
            // A screen that changed while it settled settles again first.
            if (stopped || now.key !== key)
            {
                return;
            }
            const buttons = now.showing.filter(window=>/button$/i.test(String(window.className))
                && window.enabled !== false && window.rect && !toggled.has(window.hwnd));
            for (const label of labels)
            {
                const button = buttons.find(window=>labelOf(window) === label);
                if (!button)
                {
                    continue;
                }
                const style = parseInt(String(button.style ?? '0'), 16) & 0xf;
                // BS_CHECKBOX through BS_AUTORADIOBUTTON toggle; a push
                // button is pressed again whenever it shows again.
                if (style >= 2 && style <= 9)
                {
                    toggled.add(button.hwnd);
                }
                const x = (button.rect.left + button.rect.right) >> 1;
                const y = (button.rect.top + button.rect.bottom) >> 1;
                say(`press "${button.title}" at ${x},${y}`);
                app.input.send({ kind: 'pointerMove', x, y, dx: 0, dy: 0 });
                app.input.send({ kind: 'pointerButton', button: 'left', down: true });
                setTimeout(()=>app.input.send(
                    { kind: 'pointerButton', button: 'left', down: false }), 100);
                // Looked at afresh: a press the program did not take is made
                // again once the screen has settled.
                seenKey = '';
                return;
            }
        }, request.pressSettleMs ?? 1500);
    };
    const timer = setInterval(look, request.pressEveryMs ?? 250);
    return ()=>{
        stopped = true;
        clearInterval(timer);
    };
}

/**
 * @typedef {Object} PresentState
 * @property {any} presented          The last frame this run presented.
 * @property {boolean} pointerDown    Whether the held pointer's button is down.
 * @property {{ x: number, y: number }} pointerAt  Where the last click left it.
 * @property {any[]} [inputs]          The pointer and key messages sent, each with its present.
 * @property {ReturnType<typeof createInputRoute>} [route]  The clicks and keys still to send.
 * @property {number[]} gaps          Milliseconds between one present and the next.
 * @property {number[]} times         Each present's wall-clock time (ms since the epoch), so a
 *                                    driver can count the frames inside a window of its own.
 * @property {number} lastPresent     `performance.now()` at the previous present, or 0.
 * @property {number} firstPresent    `performance.now()` at the first present, or 0.
 * @property {number} presents        How many frames this harness has presented, ever.
 * @property {number} [sinceStall]    Frames presented since the last gap of 1.5 s or more.
 * @property {any} [steady]            The log's frame averages, taken once `sinceStall` first
 *                                    reached the request's `steadyFrames`, and the
 *                                    translator's counters a frame over the same frames.
 * @property {any} [steadyFrom]        The translator's counters 240 frames before that.
 * @property {any[]} [series]           A row every `series` presents (see `seriesRow`).
 */

/**
 * One row of the run's frame series: the log's frame split averaged over the
 * frames since the last row, and the counters a reader turns into rates per
 * frame by subtracting the row before -- the draws the backend encoded, the
 * host calls the bridge dispatched. A long run's totals hide how the cost of a
 * frame moves with what the frame draws; this is what shows it.
 *
 * @param {any} app
 * @param {number} count  frames since the last row
 * @param {number} at     milliseconds since the first present
 */
export function seriesRow(app, count, at){
    const frames = app.log.profile(0).recentFrames.slice(-count);
    let ms = 0;
    let host = 0;
    let guest = 0;
    for (const frame of frames)
    {
        ms += frame.ms;
        host += frame.byKind.host + frame.sampled.host;
        guest += frame.byKind.guest + frame.sampled.guest;
    }
    const layers = Object.fromEntries(app.diagnostics()
        .map((/** @type {any} */ layer)=>[layer.name, layer.metrics ?? {}]));
    const counters = layers.graphics?.backend?.counters ?? {};
    const per = frames.length > 0 ? 1 / frames.length : 0;
    return {
        at, frames: frames.length,
        frameMs: ms * per, hostMs: host * per, guestMs: guest * per,
        draws: counters.draws ?? 0, submits: counters.submits ?? 0,
        uploadBytes: (counters.bufferUploadBytes ?? 0) + (counters.textureUploadBytes ?? 0),
        calls: layers.bridge?.calls ?? 0,
        heapMb: (/** @type {any} */ (globalThis).performance?.memory?.usedJSHeapSize ?? 0) / 1048576,
    };
}

/**
 * One presented frame: counts it, records the gap since the last one, and
 * forwards whatever the request asked to happen at this frame number -- a
 * held pointer, a click a frame long, a key held the same way. The counter is
 * on the harness rather than the run, so it keeps counting across a
 * `process-replace`: the frame after a handover is one more, not the first.
 *
 * An action's `after` is a frame number, or -- given as `afterSeconds` --
 * a time since the first presented frame, resolved to the first frame
 * presented at or past it: a frame count drifts with the frame rate, so a
 * route timed by frames stops reaching its screens when the program's
 * frames come faster, while the screens themselves arrive on the clock.
 *
 * @param {any} app
 * @param {{ pointer?: { x: number, y: number, dx?: number, dy?: number, down?: boolean },
 *           clicks?: { x: number, y: number, after: number, afterSeconds?: number }[],
 *           keys?: { code: string, after: number, afterSeconds?: number, frames?: number }[],
 *           looks?: { dx: number, dy: number, after: number, afterSeconds?: number,
 *               frames: number }[],
 *           typed?: { text: string, after: number, afterSeconds?: number }[],
 *           pasted?: { text: string, after: number, afterSeconds?: number }[],
 *           steadyFrames?: number, series?: number, snapFrame?: number, snapEvery?: number,
 *           snapCount?: number, snapFromStart?: boolean }} request
 * @param {PresentState} state
 * @param {any} frame
 */
export function presentFrame(app, request, state, frame){
    state.presented = frame;
    state.presents++;
    const now = performance.now();
    if (request.steadyFrames || request.snapFrame)
    {
        // A load stalls for seconds at a time and play does not: the count
        // starts over at every such stall, so the averages taken at it cover
        // the same frames of play in every run of a program that advances one
        // step a frame.
        const stalled = state.lastPresent > 0 && now - state.lastPresent >= 1500;
        state.sinceStall = stalled ? 0 : (state.sinceStall ?? 0) + 1;
        if (stalled)
        {
            // A load's own screens can draw that many frames before the map
            // loads: whatever was taken before the last stall is taken again.
            state.steady = undefined;
            state.steadyFrom = undefined;
        }
        // The translator's counters at both ends of the same 240 frames the
        // log's averages cover: what those frames retired, left for the host
        // by and transferred through, a frame.
        const counters = ()=>{
            const cpu = app.diagnostics().find((/** @type {any} */ one)=>one.name === 'cpu');
            const cork = cpu?.metrics?.cork;
            return cork ? { retired: cork.retired, transfers: cork.transfers, exits: cork.exits }
                : null;
        };
        if (!state.steady && state.sinceStall === request.steadyFrames - 240)
        {
            state.steadyFrom = counters();
        }
        if (!state.steady && state.sinceStall === request.steadyFrames)
        {
            const diagnostics = app.diagnostics();
            const log = diagnostics.find((/** @type {any} */ one)=>one.name === 'log');
            const { averageFrameMs, averageGuestMs, averageHostMs } = log?.metrics ?? {};
            state.steady = { frames: request.steadyFrames, averageFrameMs, averageGuestMs,
                averageHostMs };
            const from = state.steadyFrom;
            const to = counters();
            if (from && to)
            {
                /** @param {number} a @param {number} b */
                const per = (a, b)=>(a - b) / 240;
                state.steady.cork = {
                    retired: per(to.retired, from.retired),
                    transfers: per(to.transfers ?? 0, from.transfers ?? 0),
                    exits: Object.fromEntries(Object.keys(to.exits ?? {}).map(kind=>[kind,
                        per(to.exits[kind], from.exits?.[kind] ?? 0)])),
                };
            }
        }
    }
    if (request.series && state.presents % request.series === 0)
    {
        state.series ??= [];
        if (state.series.length < LIMITS.samples)
        {
            state.series.push(seriesRow(app, request.series, now - state.firstPresent));
        }
    }
    if (state.lastPresent > 0 && state.gaps.length < LIMITS.samples)
    {
        state.gaps.push(now - state.lastPresent);
    }
    if (state.times.length < LIMITS.samples)
    {
        state.times.push(performance.timeOrigin + now);
    }
    if (state.firstPresent === 0)
    {
        state.firstPresent = now;
    }
    state.lastPresent = now;
    for (const timed of [request.clicks, request.keys, request.typed, request.pasted,
        request.looks])
    {
        // In their order, each on a present after the one before it has
        // finished: a load that holds the screen for longer than the gap
        // between two of them would otherwise have them all come due on the
        // same present -- two presses and then two releases, one click.
        let free = 0;
        for (const action of timed ?? [])
        {
            if (action.afterSeconds !== undefined && action.after < 0
                && now - state.firstPresent >= action.afterSeconds * 1000
                && state.presents >= free)
            {
                action.after = state.presents;
            }
            if (action.after < 0)
            {
                break;
            }
            // A click takes four presents (`clicks` below), a key its frames
            // and one to let go, anything else one.
            const span = timed === request.clicks ? 4
                : 'frames' in action ? (action.frames ?? 1) + 1 : 2;
            free = Math.max(free, action.after + span);
        }
    }
    // Every pointer and key message this harness sends, with the present it
    // went on: a route that did not do what it should says here whether the
    // press, the release or the motion never left.
    const send = (/** @type {any} */ message)=>{
        state.inputs ??= [];
        if (state.inputs.length < LIMITS.samples)
        {
            state.inputs.push({ present: state.presents, ...message });
        }
        app.input.send(message);
    };
    // A pointer the run asked to hold somewhere, put there every frame: a
    // program that hit-tests the cursor against its own controls draws a
    // different cursor over one than over none, and this page has no mouse
    // of its own to hold still.
    if (request.pointer)
    {
        send({ kind: 'pointerMove',
            x: request.pointer.x, y: request.pointer.y,
            dx: request.pointer.dx ?? 0, dy: request.pointer.dy ?? 0 });
        if (request.pointer.down && !state.pointerDown)
        {
            state.pointerDown = true;
            send({ kind: 'pointerButton', button: 'left', down: true });
        }
    }
    // A click, a frame long, once the program has drawn a number of frames:
    // pressed on one presented frame and released on the next, which is how a
    // person's click reaches a program that reads the button once a frame.
    // Clicks and key taps, each queued on the present it comes due and sent a
    // step a present (`createInputRoute`): a click pushes a cursor a program
    // keeps by relative motion into the corner before it moves to its point,
    // and a key is held for its frames. What comes due together goes in turn.
    state.route ??= createInputRoute(send);
    for (const click of request.clicks ?? [])
    {
        if (state.presents === click.after)
        {
            state.route.click(click.x, click.y);
            state.pointerAt = { x: click.x, y: click.y };
        }
    }
    for (const key of request.keys ?? [])
    {
        if (state.presents === key.after)
        {
            state.route.key(key.code, key.frames ?? 1);
        }
    }
    state.route.tick();
    // Mouse motion without a button, the same every frame for a stretch: how
    // a program that turns its view by relative motion is turned.
    for (const turn of request.looks ?? [])
    {
        if (turn.after >= 0 && state.presents >= turn.after
            && state.presents < turn.after + turn.frames)
        {
            send({ kind: 'pointerMove', x: state.pointerAt.x, y: state.pointerAt.y,
                dx: turn.dx, dy: turn.dy });
        }
    }
    // Typed text: one character a frame, each a key press with its character
    // as the page's keyboard delivers one, released the frame after.
    for (const typed of request.typed ?? [])
    {
        if (typed.after < 0)
        {
            continue;
        }
        const index = state.presents - typed.after;
        if (index >= 0 && index < typed.text.length)
        {
            const character = typed.text[index];
            send({ kind: 'key', code: codeOf(character), down: true });
            send({ kind: 'text', text: character });
        }
        if (index >= 1 && index <= typed.text.length)
        {
            send({ kind: 'key', code: codeOf(typed.text[index - 1]), down: false });
        }
    }
    // Pasted text: on the clipboard first, then the Control-V a program
    // pastes on, released the frame after -- the order the page's own paste
    // gesture arrives in.
    for (const pasted of request.pasted ?? [])
    {
        if (state.presents === pasted.after)
        {
            send({ kind: 'paste', text: pasted.text });
            send({ kind: 'key', code: 'ControlLeft', down: true });
            send({ kind: 'key', code: 'KeyV', down: true });
        }
        else if (state.presents === pasted.after + 1)
        {
            send({ kind: 'key', code: 'KeyV', down: false });
            send({ kind: 'key', code: 'ControlLeft', down: false });
        }
    }
}

/**
 * The KeyboardEvent.code a character is typed with, for the letters, digits
 * and the few punctuation marks a name or a password carries.
 *
 * @param {string} character
 */
function codeOf(character){
    if (/^[a-z]$/i.test(character))
    {
        return `Key${character.toUpperCase()}`;
    }
    if (/^[0-9]$/.test(character))
    {
        return `Digit${character}`;
    }
    return { ' ': 'Space', '.': 'Period', '-': 'Minus', '_': 'Minus', '@': 'Digit2', '/': 'Slash',
        ',': 'Comma', ':': 'Semicolon' }[character] ?? 'KeyA';
}

/**
 * The diagnostics table, reduced to what survives JSON without carrying a ring
 * buffer per layer along with it.
 *
 * @param {any[]} layers
 */
export function scalars(layers){
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
            // A short list of names or numbers is a measurement too: which
            // phases were unbalanced, which stacks were escaped. What is still
            // refused is a list long enough to be a log.
            if (Array.isArray(value) && value.length <= 16
                && value.every(held=>typeof held === 'number' || typeof held === 'string'))
            {
                metrics[name] = /** @type {any} */ (value);
                continue;
            }
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
 * What `standing` reports of each process: the few metrics a stopped run is
 * read from, small enough to cross from a worker every few seconds.
 *
 * @param {any} app
 */
async function standingOf(app){
    return (await app.standing()).map((/** @type {any} */ { image, diagnostics })=>{
        /** @param {string} layer */
        // A process in a worker of its own that ended while asked answers
        // nothing.
        const metrics = layer=>(diagnostics ?? []).find((/** @type {any} */ entry)=>
            entry.name === layer)?.metrics ?? {};
        const kernel = metrics('kernel');
        const bridge = metrics('bridge');
        const win32 = metrics('win32');
        const cpu = metrics('cpu');
        const log = metrics('log');
        return {
            image,
            phases: (log.topPhases ?? []).slice(0, 8),
            threads: kernel.byState, waiting: kernel.waiting, turns: kernel.turns,
            calls: bridge.calls, lastCall: bridge.lastCall, suspended: bridge.suspendedCalls,
            messages: win32.messages,
            windows: (win32.windows ?? []).filter((/** @type {any} */ window)=>window.visible)
                .map((/** @type {any} */ window)=>({ hwnd: window.hwnd, parent: window.parent,
                    className: window.className, title: String(window.title ?? '').slice(0, 60),
                    x: window.x, y: window.y, width: window.width, height: window.height })),
            cpu: { recent: (cpu.recent ?? []).slice(-4), top: (cpu.samples?.top ?? []).slice(0, 8),
                traps: cpu.traps, trapCapacity: cpu.trapCapacity },
        };
    });
}

/**
 * The desktop the facade's process paints into, as the 32-bit pixels and the
 * size: what a person would see of a program that draws with GDI, which the
 * presented frames do not carry.
 *
 * @param {any} app
 * @returns {{ width: number, height: number, pitch: number, pixels: string } | null}
 */
function desktopOf(app){
    const desktop = app.debug?.desktop?.();
    if (!desktop)
    {
        return null;
    }
    return { width: desktop.width, height: desktop.height, pitch: desktop.pitch,
        pixels: toBase64(new Uint8Array(desktop.bytes.buffer, desktop.bytes.byteOffset,
            desktop.bytes.byteLength)) };
}

/**
 * Every file under a directory of the volume, as the program sees it: what an
 * install has laid down so far.
 *
 * @param {any} app @param {string} directory
 * @returns {{ path: string, size: number }[]}
 */
function filesUnder(app, directory){
    /** @type {{ path: string, size: number }[]} */
    const out = [];
    /** @param {string} at */
    const walk = at=>{
        for (const entry of app.files.list(at))
        {
            if (entry.directory)
            {
                walk(entry.path);
            }
            else
            {
                out.push({ path: entry.path, size: entry.size });
            }
        }
    };
    try
    {
        walk(directory);
    }
    catch {
        // Not there yet: nothing laid down.
    }
    return out;
}

/**
 * @typedef {Object} Harness
 * @property {Promise<{ available: boolean, reason?: string, adapter?: any }>} gpu
 * @property {(request: any) => Promise<any>} run   One title, and what came out of it.
 * @property {(from: number, count: number) => string} drainLog
 *     The call log in pieces: a quarter of a million lines is twenty
 *     megabytes, more than one evaluation carries back, so the driver asks
 *     repeatedly until it is told there is no more.
 * @property {() => number} logLines
 * @property {() => boolean} clearLog
 *     Drops what the call log holds, so a window measured after it is the
 *     window's own calls rather than whatever filled the cap getting there.
 * @property {() => string} frameReport
 * @property {() => Promise<{ width: number, height: number, format: string,
 *     pixels: string, frameIndex: number, presents: number } | null>} frameShot
 *     Where a frame's time goes, asked while the run is still going. A report
 *     at the end of a run answers what a whole run cost; this answers what one
 *     frame costs, which is the question a frame rate is.
 * @property {(list?: string) => Promise<{ processes: any[], events: string[], desktop: any,
 *     files: { path: string, size: number }[] }>} standing
 *     Every process standing, read while the run goes on: its threads and
 *     what they wait on, its parked calls, its windows, and where its
 *     processor last ran -- what an installer several processes deep that
 *     has stopped is diagnosed from, which the frames it presents do not say.
 * @property {string[]} errors
 * @property {{ count: number, gaps: number[] }} presents
 *     When each frame was presented, as the gaps between them in
 *     milliseconds: the shape a picture that stutters has.
 */

/**
 * @param {any} canvas   Where the last frame is shown: the page's, or an
 *     OffscreenCanvas of it inside a worker.
 * @param {{ pacing?: import('../../../src/app.js').RunPacing,
 *     drainElsewhere?: (table: ArrayBufferLike, sampleRate: number) => void }} [how]
 *     How the run loop waits: a worker hands in the event-driven pacing a
 *     thread of its own allows, a page leaves the default.
 * @returns {Harness}
 */
export function createHarness(canvas, how = {}){
    /** @type {any} */
    let liveContext = null;
    let liveFormat = '';
    /**
     * A presented frame onto the page's canvas as it comes, for a run a person watches
     * (`--headed`): a copy on the GPU, the canvas in the frame's own format and size.
     *
     * @param {any} device @param {any} frame
     */
    const showLive = (device, frame)=>{
        const surface = frame?.surface;
        if (!surface?.texture
            || (surface.format !== 'bgra8unorm' && surface.format !== 'rgba8unorm'))
        {
            return;
        }
        liveContext ??= canvas.getContext('webgpu');
        if (canvas.width !== surface.width || canvas.height !== surface.height
            || liveFormat !== surface.format)
        {
            canvas.width = surface.width;
            canvas.height = surface.height;
            liveContext.configure({ device, format: surface.format, alphaMode: 'opaque',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
            liveFormat = surface.format;
        }
        const encoder = device.createCommandEncoder({ label: 'live view' });
        encoder.copyTextureToTexture({ texture: surface.texture },
            { texture: liveContext.getCurrentTexture() },
            { width: surface.width, height: surface.height, depthOrArrayLayers: 1 });
        device.queue.submit([encoder.finish()]);
    };
    /** @type {string[]} */
    const errors = [];
    const opened = openDevice(errors);
    /** @type {(() => string) | null} */
    let frameReport = null;
    /** @type {any} */
    let running = null;
    /** Ends the run being made now, as though its time were up. @type {(() => void) | null} */
    let endRun = null;
    /** What the run in progress has said so far, for `standing`. @type {string[]} */
    let runningEvents = [];
    /** The frames `snapFrame` asked for, being read back, by frame. @type {Map<number, Promise<any>>} */
    const snaps = new Map();
    /** @type {PresentState} */
    const presentState = {
        presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], times: [], lastPresent: 0, firstPresent: 0, presents: 0,
    };

    /**
     * Runs one title and reports what came out of it.
     *
     * @param {{ exe?: string, exeUrl?: string, bundleUrl: string, discUrl?: string,
     *           bundlePrefix?: string,
     *           imagePath: string,
     *           commandLine?: string,
     *           concurrency?: import('../../../src/mode.js').Concurrency,
     *           windows?: 'win2000' | 'winxp' | 'win7' | 'win10',
     *           gpuProfile?: 'sm1' | 'sm2' | 'sm3' | 'sm4' | 'host',
     *           sidecarHooks?: { spec: any, source: string },
     *           logCategories?: Record<string, string>,
     *           logCapacity?: number, logBytes?: number,
     *           maxTurns?: number, maxMs?: number | null, trace?: boolean,
     *           screen?: { width: number, height: number, bitsPerPixel: number } | null,
     *           clicks?: { x: number, y: number, after: number }[],
     *           keys?: { code: string, after: number }[],
     *           typed?: { text: string, after: number }[],
     *           pasted?: { text: string, after: number }[],
     *           logMatch?: string,
     *           network?: { module: string, url: string, room: string },
     *           keyTimes?: { code: string, atMs: number, holdMs?: number }[],
     *           clickTimes?: { x: number, y: number, atMs: number, holdMs?: number }[],
     *           files?: { path: string, base64: string }[],
     *           wholeFiles?: boolean,
     *           sampling?: boolean,
     *           store?: string, prefetch?: boolean, bundleId?: string, fakeGpu?: boolean,
     *           watch?: { libraries: Record<string, number[] | null>,
     *               strings: number[] }, record?: number, memorySize?: number }} request
     * @returns {Promise<any>}
     */
    async function run(request){
        const handle = request.fakeGpu ? fakeDevice() : await opened;
        if (!handle.available)
        {
            return { ok: false, gpu: false, reason: handle.reason };
        }
        // The player draws in a graphics worker of its own and keeps only the
        // devices' state on the program's thread; a run asked to measure what
        // a player's machine does takes the same split.
        // With the fake device the devices are played in a worker of their own
        // over another fake, as the player's split has them.
        const graphicsWorker = request.fakeGpu
            ? await openGraphicsWorker({ frames: 'count',
                url: new URL('./fake-graphics.worker.js', import.meta.url) })
            : request.graphicsWorker ? await openGraphicsWorker({ frames: 'pixels' }) : null;
        if (graphicsWorker && !graphicsWorker.worker)
        {
            const why = 'reason' in graphicsWorker ? graphicsWorker.reason : '';
            return { ok: false, gpu: false, reason: `graphics worker: ${why}` };
        }

        // Optional, and asked for anyway: without it a program's cinematic is a
        // graph with nothing in it, which is a real state of a machine and not the
        // one worth measuring. A build that has no decoder to fetch runs as before.
        const decoder = request.video === false ? null : await fetch(
            new URL('../../../vendor/prebuilt/video-decoder.wasm', import.meta.url))
            .then(response=>response.ok ? response.arrayBuffer() : null)
            .catch(()=>null);

        // Reset per run: the frame this run presents is its own, but the
        // counter and the gaps it feeds keep counting across a run -- see
        // `presentFrame`.
        presentState.presented = null;
        presentState.pointerDown = false;
        presentState.pointerAt = { x: 0, y: 0 };
        presentState.inputs = [];
        presentState.route = undefined;
        /** @type {any} */
        const collected = { failures: [], missing: [], output: [], events: [], shaders: [],
            divergences: [] };

        frameReport = ()=>{
            if (!running)
            {
                return JSON.stringify({ ready: false });
            }
            const seen = running.log.profile(8);
            const layers = Object.fromEntries(running.diagnostics()
                .map((/** @type {any} */ layer)=>[layer.name, layer.metrics ?? {}]));
            return JSON.stringify({
                ready: true,
                // What has already gone wrong, if anything. Asked for while the run
                // is still going: a tool driving the page needs to know at the step
                // that caused a failure, not when the whole run finally answers.
                failure: collected.failures.at(-1) ?? null,
                // A hook's own bugs are a fall-through, not a failure, so they
                // do not belong in `failure` above; a run watching one still
                // wants to see them as they happen.
                recentEvents: collected.events.slice(-5),
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
                    longest: frame.longest, longestGuest: frame.longestGuest,
                    waits: frame.waits, compiles: frame.compiles, notes: frame.notes,
                })),
                recentFrames: seen.recentFrames.map((/** @type {any} */ frame)=>({
                    ms: frame.ms, byKind: frame.byKind,
                })),
                messages: layers.win32?.messages ?? null,
                // Where the guest itself is spending its turns. The only account
                // there is of a program's own code, which makes no host call to
                // record what it decided.
                profile: profile(layers.memory?.layout ?? []),
                // Whether the engine honoured the slice it was given. A quantum
                // that is not kept is time one thread holds the machine while a
                // frame waits, and it is invisible in every other number here.
                slices: {
                    quantum: layers.kernel?.quantum ?? 0,
                    turns: layers.kernel?.turns ?? 0,
                    overruns: layers.kernel?.overruns ?? 0,
                    worst: layers.kernel?.worstSlice ?? 0,
                },
                // What reached the screen, and what was refused on the way. A film
                // that decodes and is never seen is the difference between these
                // two and nothing else.
                presenter: layers.graphics?.presenter ?? null,
                // Every layer's own metrics, for a run that never answers: what
                // it waits on is in the kernel's and the bridge's.
                layers,
                media: layers.media ?? null,
                // The translator's account, when the engine has one.
                cork: layers.cpu?.cork ?? null,
                // The whole path a sound takes, stage by stage. A silent run and a
                // working one used to produce the same report.
                audio: layers.audio ?? null,
                // The other way a program makes a sound. A title of this era plays
                // its music through a middleware library that writes wave buffers,
                // not through DirectSound, so a report that shows only the second
                // one can say "silent" about a machine that is playing.
                wave: layers.win32?.waveDevices ?? null,
                film: layers.app?.film ?? null,
                instructions: layers.cpu?.instructions ?? 0,

                traps: layers.cpu?.traps ?? 0,
                // Host calls so far: a per-call cost is only per call if a run
                // can count them, and a sampling profile cannot.
                calls: layers.bridge?.calls ?? 0,
                // A slot hook's own counters, when a sidecar bound one: how
                // often it ran, how often it answered the call itself versus
                // the guest's own code, and -- in oracle mode -- how often the
                // two disagreed.
                hooks: layers.bridge?.hooks ?? [],
                // Calls a site kernel issued through `frame.gl`: never a bridge
                // crossing, so not one of the rows above -- read next to them.
                kernelGlCalls: layers.app?.kernelGlCalls ?? 0,
                trapCapacity: layers.cpu?.trapCapacity ?? 0,
                // The always-on sampler's own raw buckets, cumulative since
                // boot -- a caller wanting one window's own top list takes two
                // readings a window apart and deltas them by bucket key, the
                // overlay's own pattern.
                samples: layers.cpu?.samples ?? null,
                // Which guest address belongs to which module, so a driver
                // can name the sampler's addresses without waiting for the
                // final result (`result.bridge.recent` already does this
                // resolution itself, but only after the run ends).
                memoryLayout: layers.memory?.layout ?? [],
                presents: presentState.presents,
                // What we send to the card against what the program actually
                // wrote. A buffer uploaded whole for a lock of a few hundred bytes
                // is traffic nobody asked for, and it scales with the buffer rather
                // than with the change.
                uploads: layers.graphics?.backend ?? null,
                graphics: layers.graphics?.seam?.device
                    ? {
                        frames: layers.graphics.seam.device.frames,
                        draws: layers.graphics.seam.device.draws,
                        pipelines: layers.graphics.seam.device.pipelines,
                        prepared: layers.graphics.seam.device.prepared,
                        preparedReused: layers.graphics.seam.device.preparedReused,
                        refused: layers.graphics.seam.device.refused,
                        skipped: layers.graphics.seam.device.skipped,
                    }
                    : null,
            });
        };

        // The relay Winsock reaches the world through, opened here the way
        // the launcher's worker opens its own: by the client module's URL.
        const network = request.network
            ? await (await import(/* @vite-ignore */ request.network.module))
                .connectRelay({ url: request.network.url, room: request.network.room })
            : null;
        const logMatch = request.logMatch ? new RegExp(request.logMatch) : null;
        const app = await createApp({
            pacing: how.pacing,
            win32: network || request.win32 ? { ...request.win32, ...network ? { network } : {} }
                : undefined,
            executable: request.exe ? fromBase64(request.exe)
                : new Uint8Array(await (await fetch(request.exeUrl)).arrayBuffer()),
            // What the program believes it was started with, so a run can set
            // a command-line-only cvar without touching the bundle.
            commandLine: request.commandLine,
            // The Windows the bottle runs under, from its manifest; absent is
            // the engine's default, and a name it does not know fails the run.
            windows: request.windows,
            // The card the adapter is shown as, from the bottle's shader profile.
            gpuProfile: request.gpuProfile,
            // A bundle's own hooks.json/hooks.mjs, read by the tool that
            // started this run from beside the bundle -- never from the
            // bundle itself.
            sidecarHooks: request.sidecarHooks,
            // Imports from the libraries `--watch-import` named, each call and
            // its answer in the log, as the launcher's `?watch=` puts them.
            watchImport: request.watch ? watchFrom(request.watch) : undefined,
            record: request.record || 0,
            ...(request.memorySize ? { memorySize: request.memorySize } : {}),
            // Journal categories on from the first instruction -- a call area
            // a run wants to read back afterwards through `journalRecent`.
            // `logCapacity`/`logBytes` raise the ring above its default when
            // the category asked for is one a frame makes thousands of calls
            // under (`call.gpu`, `call.cpu`): the default (4096 records, 1 MiB)
            // is sized for occasional diagnostics, not a dense capture.
            log: request.logCategories
                ? { categories: request.logCategories, capacity: request.logCapacity,
                    bytes: request.logBytes }
                : undefined,
            media: decoder ? { wasmBytes: decoder } : undefined,
            imagePath: request.imagePath,
            discs: request.discUrl
                ? [{ image: await (await fetch(request.discUrl)).blob() }] : undefined,
            concurrency: request.concurrency ?? undefined,
            screen: request.screen ?? undefined,
            // The graphics layer's own configuration, whatever fields the run
            // names: a switch the layer defaults off is turned on per run here.
            graphics: request.graphics ?? undefined,
            // The bottle's graphics choice, as the launcher passes it.
            graphicsApi: request.graphicsApi ?? undefined,
            // Peeks every pointer argument on every call, which the launcher
            // never pays for. A run that wants the strings (read afterwards,
            // which is exactly when a stack one is gone) asks for them; a
            // measurement run should not pay for them unasked.
            traceStrings: request.trace === true,
            profileCalls: request.profileCalls === true,
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
                        const line = request.logTimes
                            ? `${performance.now().toFixed(1)} ${formatCall(call)}`
                            : formatCall(call);
                        // Only the calls a run asked about, when it named
                        // them: a question about one family of calls should
                        // not fill the log with the frame loop's.
                        if (!logMatch || logMatch.test(line))
                        {
                            callLog.push(line);
                        }
                    }
                }
                : undefined,
            // The translator's own settings for the run.
            cork: request.cork || undefined,
            // Sampled guest execution, when asked for. A program that decides
            // something inside its own code makes no host call to record, and the
            // instruction pointer is then the only account of what it was doing --
            // which is exactly the situation once a game reaches its own main loop.
            sampling: request.sampling,
            quantum: request.quantum || undefined,
            // Executors of the program's process: past one, its threads run at once.
            executors: request.executors || undefined,
            // Where they run, when a run names it (the kernel's `placement`), and
            // the rest of createApp's `cpu` a run passes (`playPinned`, `freeHost`).
            ...request.placement || request.cpu
                ? { cpu: { ...request.placement ? { placement: request.placement } : {},
                    ...request.cpu } }
                : {},
            sample: request.profile || request.quantum ? recordSample : undefined,
            device: {
                device: handle.device,
                queue: handle.device.queue,
                ...graphicsWorker?.worker ? { worker: graphicsWorker.worker } : {},
                // Who made the hardware, for the program that asks before deciding
                // how much to ask of it.
                adapter: handle.adapter,
                // Where every draw of the last frame landed, when the run asked
                // for it. A frame is the only thing that says which draw painted a
                // given patch of the picture, and working that out costs a
                // transform of every vertex -- so it is off unless asked for.
                dumpDraws: Boolean(request.dumpDraws),
                dumpEvery: request.dumpEvery ?? 0,
                // Cutting a frame short is what turns "one of these draws painted
                // this" into "this one did": the region is either there or not.
                maxDraws: request.maxDraws ?? -1,
                // A draw's index in a frame moves between runs; the texture it
                // binds does not, so this is what removes the same draw twice.
                skipTexture: request.skipTexture ?? null,
                // Fog off is the other half of a pair of runs: a wash that goes
                // with it was fog, and one that stays was not.
                probeTexture: request.probeTexture ?? null,
                keepImages: request.keepImages ?? [],
                fog: request.fog !== false,
                mips: request.mips !== false,
                /** @param {any} frame */
                presentTo: frame=>{
                    presentFrame(app, request, presentState, frame);
                    if (request.live)
                    {
                        showLive(handle.device, frame);
                    }
                    // The frame `snapFrame` frames after the last long stall, read
                    // back as it was presented; a later stall takes it again, so a
                    // demo's frame N is the same frame in every run.
                    // Counted from the first present instead, when a program whose
                    // clock steps once per frame is to be caught at the same game
                    // moment by two runs whose stalls fall in different places.
                    const counted = request.snapFromStart
                        ? presentState.presents : presentState.sinceStall ?? 0;
                    if (request.snapFrame && !request.snapFromStart && counted === 0)
                    {
                        snaps.clear();
                    }
                    // `snapCount` frames from it, `snapEvery` apart: a series
                    // tells a scene that changes by itself from one drawn wrong.
                    const since = counted - (request.snapFrame ?? 0);
                    const every = request.snapEvery ?? 1;
                    if (request.snapFrame && since >= 0 && since % every === 0
                        && since / every < (request.snapCount ?? 1))
                    {
                        snaps.set(counted,
                            readBack(handle.device, frame.surface));
                    }
                },
            },
            bundle: {
                fetch: rangeFetcher(request.bundleUrl),
                prefix: request.bundlePrefix,
                ...bundleStoreOptions(request),
            },
            // Seeded from the request when it carries files; nothing goes
            // back out either way, the result carries what was written.
            storage: request.files?.length ? ()=>seedFiles(request.files) : null,
            // This page has a device, in the only sense the engine cares about:
            // something reads the other end of the ring at the rate a device would.
            audio: { drained: true, ...request.audio ?? {} },
        });
        // Watches in front of routines inside a program's own modules, as
        // `--hook` named them, put in place where the launcher's `?hook=`
        // puts them: in each module as it is mapped, in this process and in
        // one that replaces it.
        // What a watched routine was handed and what it answered, in the log
        // beside the calls around it.
        if (((request.hooks ?? []).length > 0 || request.watch) && request.log)
        {
            app.on('guest-return', (/** @type {any} */ back)=>{
                const line = `${back.name} -> ${JSON.stringify(back.result)} `
                    + (back.strings ?? []).join(' ');
                if (callLog.length < (request.logLines || LIMITS.log)
                    && (!logMatch || logMatch.test(line)))
                {
                    callLog.push(line);
                }
            });
        }
        if ((request.hooks ?? []).length > 0)
        {
            placeHooks(app, request.hooks, (type, line)=>{
                if (collected.events.length < LIMITS.events)
                {
                    collected.events.push(`[${type}] ${JSON.stringify(line).slice(0, 300)}`);
                }
            });
        }

        // What the device mixed, between two moments of the run, when asked.
        const capture = request.captureAudio
            ? { fromMs: request.captureAudio.fromMs, toMs: request.captureAudio.toMs,
                blocks: /** @type {Int16Array[]} */ ([]) }
            : null;
        const drain = drainSound(app, capture, how.drainElsewhere);

        listen(app, collected);
        runningEvents = collected.events;
        scheduleKeyTimes(app, request);
        const stopPresses = schedulePresses(app, request, line=>{
            if (collected.events.length < LIMITS.events)
            {
                collected.events.push(`[press] ${line}`);
            }
        });

        /** @type {any} */
        const result = { ok: false, gpu: true, adapter: handle.adapter };
        const loaded = app.diagnostics()
            .find((/** @type {any} */ layer)=>layer.name === 'loader');
        result.unresolved = loaded?.metrics?.unresolved ?? app.image?.unresolved ?? [];

        // Published before the run, not after: the whole point of the frame report
        // is to be asked while the frames are still happening.
        running = app;
        // The pointer spec, reachable from outside so a driver can change the
        // intended turn mid-run rather than holding one velocity for the whole
        // run. Null when no pointer was asked for.
        /** @type {any} */ (globalThis).__bottlifyPointer__ = request.pointer ?? null;

        const started = performance.now();
        try
        {
            // A driver's stop ends the run here, as its time running out
            // would, whatever the machine does with being stopped.
            const stopped = new Promise(done=>{
                endRun = ()=>done(-1);
            });
            result.exitCode = await Promise.race([app.run({
                maxTurns: request.maxTurns ?? 200000,
                timeoutMs: request.maxMs ?? null,
            }), stopped]);
            result.stopped = `exited with ${result.exitCode}`;
            result.ok = true;
        }
        catch (e){
            const failure = /** @type {any} */ (e);
            result.stopped = failure.message;
            result.error = failure.message;
            result.reason = failure.reason;
            // A failure of the host's own, a DOMException among them, carries no guest
            // trace: its stack says where it was thrown.
            result.trace = failure.traceText ?? failure.stack;
        }
        result.elapsedMs = Math.round(performance.now() - started);
        if (request.exportTranslations)
        {
            // The run's translations as the seed a bundle carries, for the
            // driver to write out (`--export-translations`).
            const seed = await app.exportTranslations().catch(()=>null);
            result.translations = seed === null ? null : toBase64(seed);
        }

        result.snaps = [];
        for (const [frameAfter, pending] of snaps)
        {
            const image = await pending;
            result.snaps.push({ frame: frameAfter, width: image.width, height: image.height,
                rgba: toBase64(image.pixels) });
        }
        // A frame counted without its picture (the fake GPU's) has none to read back.
        if (presentState.presented?.surface)
        {
            const image = await readBack(handle.device, presentState.presented.surface);
            // A live canvas is WebGPU's already and has the frame; a 2D context cannot be had.
            if (!request.live)
            {
                show(canvas, image);
            }
            result.frame = {
                index: presentState.presented.frameIndex,
                width: image.width,
                height: image.height,
                format: presentState.presented.surface.format,
            };
            result.colours = census(image);
            result.opacity = opacity(image);
            // The frame itself, for the driver to write out as an image: a
            // census says whether there is a picture, not what it is.
            result.frameRgba = toBase64(image.pixels);
        }
        result.presents = presentState.presents;
        result.drain = drain;
        if (capture && capture.blocks.length > 0)
        {
            result.audioCapture = packCapture(capture, app.audio.format().sampleRate);
        }

        const layers = app.diagnostics();
        /** @param {string} name */
        const metrics = name=>layers.find((/** @type {any} */ entry)=>entry.name === name)
            ?.metrics ?? {};
        result.layers = scalars(layers);
        // When the sound played a lap it had played before, host times: a
        // list longer than the table keeps, read beside the translator's stalls.
        result.staleAt = layers.find((/** @type {any} */ one)=>one.name === 'audio')
            ?.metrics?.staleAt ?? [];
        result.staleTrail = layers.find((/** @type {any} */ one)=>one.name === 'audio')
            ?.metrics?.staleTrail ?? [];
        result.instructions = metrics('cpu').instructions ?? null;
        // Whether the run had the executors it was given: how many slices ran
        // on the others, the most threads at once, and why none ran if they did not.
        result.executors = {
            refused: metrics('cpu').executorsRefused ?? null,
            others: (metrics('cpu').executors ?? []).length,
            slices: metrics('kernel').executorSlices ?? null,
            mostAtOnce: metrics('kernel').mostAtOnce ?? null,
            // Where each executor's time went: the process's own from the
            // scheduler's account, the others' as each last answered.
            placement: typeof metrics('kernel').placement === 'string'
                ? JSON.parse(metrics('kernel').placement) : null,
            own: typeof metrics('kernel').sharedTime === 'string'
                ? JSON.parse(metrics('kernel').sharedTime) : metrics('kernel').sharedTime ?? null,
            remotes: (metrics('cpu').executors ?? []).map((/** @type {any} */ one)=>({
                index: one.index, retired: one.retired ?? null, spent: one.spent ?? null })),
        };
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
            // Every host function by the time its calls took since the start, with
            // how many: the ring above is the last few thousand calls, which a
            // thread waiting in a loop fills by itself.
            byFunction: metrics('bridge').byFunction ?? [],
            recent: (metrics('bridge').recentDetailed ?? []).slice(-LIMITS.calls)
                .map((/** @type {any} */ call)=>({ ...call, fromName: where(call.from >>> 0) })),
            // Named rather than left to `scalars`, which keeps only numbers and
            // strings and drops an array of objects whole: a sidecar hook's own
            // counters (calls, handled, fellThrough, mismatches) are exactly
            // that shape, and without this a bound hook's report says only that
            // it bound, never whether it did anything once it was running.
            hooks: metrics('bridge').hooks ?? [],
            // Calls a site kernel issued through `frame.gl`: these never cross
            // the bridge, so they are not one of the rows above -- read next
            // to them, from the app layer's own diagnostics.
            kernelGlCalls: metrics('app').kernelGlCalls ?? 0,
        };
        result.profile = profile(layout);
        result.samples = guestSamples(metrics('cpu').samples, layout);
        // Named rather than left to `scalars`: the translator's report is an
        // object of objects (`exitsByTarget`, `refused`, `refusedWhy`), so the
        // `[ready]` table drops it whole and a cork run would say nothing about
        // why its loops stayed interpreted.
        result.cork = metrics('cpu').cork ?? null;

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
            // count:bytes:hash of every compressed block handed to OpenGL.
            compressedTextures: graphics.seam?.compressedTextures ?? null,
            // Of OpenGL's host time, what playing each call's ring took and
            // what the calls themselves did; and what posting the batches took.
            openglMs: graphics.seam ? { ring: graphics.seam.openglRingMs,
                calls: graphics.seam.openglCallMs } : null,
            sentToWorker: graphics.worker?.sent ?? null,
            // Of those bytes, the guest memory copied in by what copied it, and
            // the calls whose records the batches hold, heaviest first.
            shippedToWorker: graphics.worker?.shipped ?? null,
            callsToWorker: graphics.worker?.calls ?? null,
            // A diagnostic's (`checkDraws`): draws whose bytes the worker had otherwise.
            drawChecks: graphics.worker?.drawChecks ?? null,
            imageDigests: graphics.seam?.imageDigests ?? [],
            keptImages: graphics.seam?.keptImages ?? [],
            imageTimes: graphics.seam?.imageTimes ?? [],
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
            // How the textures travelled: a staged upload is a block-compressed
            // one or a render-target-ordered one on the Direct3D path, so this
            // count alone does not say the BC path was taken -- read it beside
            // `compressedTextures` in the run's own configuration.
            uploads: graphics.backend?.counters
                ? {
                    textures: graphics.backend.counters.textureUploads ?? 0,
                    staged: graphics.backend.counters.stagedTextureUploads ?? 0,
                    bytes: graphics.backend.counters.textureUploadBytes ?? 0,
                }
                : null,
        };

        // What the program wrote. A game of this age keeps its own log, and it says
        // in plain words what it thought went wrong.
        result.files = app.session.export().map((/** @type {any} */ file)=>({
            path: file.path,
            bytes: file.bytes.length,
            truncated: file.bytes.length > LIMITS.file,
            text: new TextDecoder('latin1')
                .decode(file.bytes.subarray(0, LIMITS.file)),
            // The bytes themselves, whole, for a run that will feed a file
            // back in: the text above is a reading of it, not the file.
            base64: request.wholeFiles ? toBase64(file.bytes) : undefined,
        }));

        result.failures = collected.failures;
        // The journal's tail, taken before the layer is disposed with the
        // rest of the machine: a category a run switched on has its last
        // records here and nowhere else once the run is over.
        result.journal = app.log.recent(200);
        result.missing = [...new Set(collected.missing)];
        result.output = collected.output;
        result.events = collected.events;
        result.shaders = collected.shaders;
        result.recorded = request.record ? app.recordedSession?.().events ?? [] : [];
        result.divergences = collected.divergences;
        result.errors = errors;
        result.inputs = presentState.inputs ?? [];
        result.presentGaps = presentState.gaps.slice();
        result.presentTimes = presentState.times.slice();
        result.steady = presentState.steady ?? null;
        result.series = presentState.series ?? [];
        // Guest memory as the run left it, where `--peek` asked: a flag or a
        // counter a program decides on without calling anything is otherwise
        // invisible from outside it.
        // One that reaches past what is mapped says so in its own line
        // rather than costing the run its report.
        result.peeks = (request.peeks ?? []).map((/** @type {any} */ peek)=>{
            try
            {
                return {
                    address: peek.address,
                    bytes: [...app.debug.read(peek.address, peek.length)]
                        .map(byte=>byte.toString(16).padStart(2, '0')).join(' '),
                };
            }
            catch (e){
                return { address: peek.address, bytes: `unreadable: ${/** @type {any} */ (e).message}` };
            }
        });

        stopPresses();
        await app.dispose();
        // Nothing is running any more, and a report asked for now must say
        // so: left set, `frameReport` reaches into a disposed machine and
        // throws, which a driver polling it reads as a page that hangs.
        running = null;
        return result;
    }

    return {
        gpu: opened.then(handle=>({
            available: handle.available,
            reason: handle.reason,
            adapter: handle.adapter,
        })),
        run,
        drainLog: (from, count)=>callLog.slice(from, from + count).join(NEWLINE),
        logLines: ()=>callLog.length,
        // A window measured by holding a view still wants the calls that view
        // made, not the calls that got there -- the cap is a count of lines,
        // not of time, and a loading screen alone can spend it.
        clearLog: ()=>{
            callLog.length = 0;
            return true;
        },
        frameReport: ()=>frameReport ? frameReport() : JSON.stringify({ ready: false }),
        // What a driver sends while the run goes on (`game.mjs --control`):
        // a pointer move, a button or a key, as the page's own input sends it.
        /** @param {any} event */
        input: event=>{
            running?.input.send(event);
            return running !== null;
        },
        // The run ended now, as though its time were up: the report follows.
        stop: ()=>{
            endRun?.();
            return running !== null;
        },
        // The frame presented last, read back from the device while the run
        // goes on: what a person sees at this present, so two runs can be
        // compared at the same one. The pixels are the surface's own bytes,
        // in its format, as base64.
        frameShot: async()=>{
            if (!running || !presentState.presented?.surface)
            {
                return null;
            }
            const surface = presentState.presented.surface;
            const image = await readBack((await opened).device, surface);
            // Which frame it is, and how many the page has been handed: a
            // picture that stays the same while the count goes on is a
            // program drawing the same thing, one whose index stays too is
            // frames that stopped reaching the page.
            return { width: image.width, height: image.height, format: surface.format,
                pixels: toBase64(image.pixels), frameIndex: presentState.presented.frameIndex,
                presents: presentState.presents };
        },
        // The next frames with draws written down by the running devices
        // (`app.debug.dumpFrames`): a frame of a level, where a dump from the
        // start of the run catches only the loading screen. `lastDumped` is
        // the last of them once the graphics worker has sent it.
        /** @param {number} frames */
        dumpFrames: frames=>(running ? running.debug.dumpFrames(frames) : 0),
        lastDumped: ()=>(running ? running.debug.dumped() : null),
        // The tail of the engine's journal, formatted: what a category a run
        // switched on has recorded, read while the run is still going.
        /** @param {number} [count] */
        journalRecent: count=>running ? running.log.recent(count) : [],
        standing: async list=>(running
            ? { processes: await standingOf(running), events: runningEvents,
                desktop: desktopOf(running), files: list ? filesUnder(running, list) : [] }
            : { processes: [], events: runningEvents, desktop: null, files: [] }),
        errors,
        get presents(){
            return { count: presentState.presents, gaps: presentState.gaps.slice() };
        },
    };
}
