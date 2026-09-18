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
import {
    SLOTS, GLOBAL_HEADER_INT32, SLOT_HEADER_INT32, SLOT_BYTES,
    slotHeaderOffset, slotPcmOffset, createSeam, mixBlock,
} from '../../../src/layers/audio/output/mix.js';

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
 * The emulator's own account of where the guest ran, when one was kept:
 * the hottest blocks by instructions, and the same by page.
 *
 * @param {any} app  The running application, or nothing yet.
 * @param {string[]} layout  As the memory layer reports it.
 */
function exactProfile(app, layout){
    const account = app?.guestProfile?.read();
    if (!account || account.entries.length === 0)
    {
        return null;
    }
    const where = symboliser(layout);
    let retired = 0;
    /** @type {Map<string, number>} */
    const pages = new Map();
    for (const entry of account.entries)
    {
        retired += entry.instructions;
        const page = where(entry.address, ~0xfff);
        pages.set(page, (pages.get(page) ?? 0) + entry.instructions);
    }
    const share = (/** @type {number} */ count)=>count / Math.max(1, retired);
    return {
        blocks: account.entries.length,
        retired,
        dropped: account.dropped,
        // The window's own modules, whole rather than top-of, so a share of the
        // guest's time is a share of every instruction it retired.
        modules: byModule(account.entries.map(entry=>(
            { address: entry.address, weight: entry.instructions })), layout),
        pages: [...pages].sort((left, right)=>right[1] - left[1]).slice(0, 16)
            .map(([at, count])=>({ at, count, share: share(count) })),
        hot: [...account.entries].sort((left, right)=>right.instructions - left.instructions)
            .slice(0, 8192)
            .map(entry=>({
                at: where(entry.address),
                instructions: entry.instructions,
                hits: entry.hits,
                share: share(entry.instructions),
                // The bytes at the entry, for a reader with a disassembler:
                // an address alone says where, not what. Fifteen bytes holds
                // any x86 instruction in full.
                bytes: Array.from(app.debug.read(entry.address, 16))
                    .map((/** @type {number} */ byte)=>byte.toString(16).padStart(2, '0')).join(' '),
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
    const features = adapter.features.has('texture-compression-bc')
        ? ['texture-compression-bc']
        : [];
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
 * The DirectX runtime this checkout has fetched, as the engine's own volume.
 *
 * The lock names every DLL; each is optional, because a checkout that never ran
 * `npm run fetch:directx-runtime` has none. Absent, `createApp` gets no system
 * layer and a `d3dx9_*` a title links against is answered by the engine's own
 * table -- a valid machine, just not the one that lets the title's shipped
 * runtime drive the effect.
 *
 * @returns {Promise<{ files: { path: string, bytes: Uint8Array }[] } | undefined>}
 */
async function loadRuntime(){
    const lock = await fetch(new URL('../../../directx-runtime-lock.json', import.meta.url))
        .then(response=>response.ok ? response.json() : null)
        .catch(()=>null);
    if (!lock?.artifacts)
    {
        return undefined;
    }
    const files = (await Promise.all(Object.keys(lock.artifacts).map(async name=>{
        const bytes = await fetch(
            new URL(`../../../vendor/prebuilt/directx/${name}`, import.meta.url))
            .then(response=>response.ok ? response.arrayBuffer() : null)
            .catch(()=>null);
        return bytes ? { path: name, bytes: new Uint8Array(bytes) } : null;
    }))).filter(Boolean);
    return files.length > 0 ? { files: /** @type {any} */ (files) } : undefined;
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
 */
function drainSound(app){
    const table = app.audio.table?.();
    if (table)
    {
        drainTable(app, table);
        return;
    }
    const ring = app.audio.ring?.();
    if (!ring)
    {
        return;
    }
    const { sampleRate, channels } = app.audio.format();
    const block = new Float32Array(ring.capacity * channels);
    let readAt = performance.now();
    setInterval(()=>{
        // By elapsed time rather than a fixed count per turn: this page's main
        // thread is inside the emulator most of the time, so the reads are late
        // and bursty, and only the clock keeps the total honest.
        const owed = Math.floor((performance.now() - readAt) * sampleRate / 1000);
        const frames = Math.min(ring.capacity, owed);
        if (frames <= 0)
        {
            return;
        }
        // The clock moves on by what was really taken, not by what was asked
        // for. A device reading on its own thread never misses its turn; this
        // one is on the thread the emulator is holding, and a read that gave up
        // whatever it was late for would model a device running slow -- which
        // is indistinguishable, in a report, from an engine that cannot feed
        // one.
        readAt += ring.read(block.subarray(0, frames * channels)) * 1000 / sampleRate;
    }, 20);
}

/**
 * Stands in for the worklet this harness never creates, over the shared
 * track table: the same `mixBlock` a real `worklet.js` runs, called on a
 * timer on the page's own thread instead of the audio-rendering thread. See
 * {@link drainSound}.
 *
 * @param {any} app @param {ArrayBufferLike} table
 */
function drainTable(app, table){
    const { sampleRate } = app.audio.format();
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
    const block = new Float32Array(DRAIN_CAP_FRAMES * 2);
    let readAt = performance.now();
    setInterval(()=>{
        const owed = Math.floor((performance.now() - readAt) * sampleRate / 1000);
        const blockFrames = Math.min(DRAIN_CAP_FRAMES, owed);
        if (blockFrames <= 0)
        {
            return;
        }
        mixBlock({ global, slots, seams, block, blockFrames, outputRate: sampleRate });
        readAt += blockFrames * 1000 / sampleRate;
    }, 20);
}

/**
 * Everything the engine will say about itself while it runs, kept bounded.
 *
 * @param {any} app
 * @param {any} collected
 */
export function listen(app, collected){
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
        'hooks-bound', 'hook-error'])
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
 * Types a key at a wall-clock moment, not a presented frame: a screen that
 * stops presenting while it waits for a key cannot be reached by a frame
 * number, because the frame it would be sent on never comes.
 *
 * @param {any} app
 * @param {{ keyTimes?: { code: string, atMs: number, holdMs?: number }[] }} request
 */
export function scheduleKeyTimes(app, request){
    for (const key of request.keyTimes ?? [])
    {
        setTimeout(()=>app.input.send({ kind: 'key', code: key.code, down: true }),
            key.atMs);
        setTimeout(()=>app.input.send({ kind: 'key', code: key.code, down: false }),
            key.atMs + (key.holdMs ?? 120));
    }
}

/**
 * @typedef {Object} PresentState
 * @property {any} presented          The last frame this run presented.
 * @property {boolean} pointerDown    Whether the held pointer's button is down.
 * @property {{ x: number, y: number }} pointerAt  Where the last click left it.
 * @property {number[]} gaps          Milliseconds between one present and the next.
 * @property {number} lastPresent     `performance.now()` at the previous present, or 0.
 * @property {number} presents        How many frames this harness has presented, ever.
 */

/**
 * One presented frame: counts it, records the gap since the last one, and
 * forwards whatever the request asked to happen at this frame number -- a
 * held pointer, a click a frame long, a key held the same way. The counter is
 * on the harness rather than the run, so it keeps counting across a
 * `process-replace`: the frame after a handover is one more, not the first.
 *
 * @param {any} app
 * @param {{ pointer?: { x: number, y: number, dx?: number, dy?: number, down?: boolean },
 *           clicks?: { x: number, y: number, after: number }[],
 *           keys?: { code: string, after: number }[] }} request
 * @param {PresentState} state
 * @param {any} frame
 */
export function presentFrame(app, request, state, frame){
    state.presented = frame;
    state.presents++;
    const now = performance.now();
    if (state.lastPresent > 0 && state.gaps.length < LIMITS.samples)
    {
        state.gaps.push(now - state.lastPresent);
    }
    state.lastPresent = now;
    // A pointer the run asked to hold somewhere, put there every frame: a
    // program that hit-tests the cursor against its own controls draws a
    // different cursor over one than over none, and this page has no mouse
    // of its own to hold still.
    if (request.pointer)
    {
        app.input.send({ kind: 'pointerMove',
            x: request.pointer.x, y: request.pointer.y,
            dx: request.pointer.dx ?? 0, dy: request.pointer.dy ?? 0 });
        if (request.pointer.down && !state.pointerDown)
        {
            state.pointerDown = true;
            app.input.send({ kind: 'pointerButton', button: 'left', down: true });
        }
    }
    // A click, a frame long, once the program has drawn a number of frames:
    // pressed on one presented frame and released on the next, which is how a
    // person's click reaches a program that reads the button once a frame.
    for (const click of request.clicks ?? [])
    {
        if (state.presents === click.after)
        {
            // With the motion that would have brought a pointer there from
            // where it was: a program that reads the mouse as relative motion
            // moves its own cursor by it.
            app.input.send({ kind: 'pointerMove',
                x: click.x, y: click.y,
                dx: click.x - state.pointerAt.x, dy: click.y - state.pointerAt.y });
            state.pointerAt = { x: click.x, y: click.y };
            app.input.send({ kind: 'pointerButton', button: 'left', down: true });
        }
        if (state.presents === click.after + 1)
        {
            app.input.send({ kind: 'pointerButton', button: 'left', down: false });
        }
    }
    // A key press, held for one presented frame and released on the next, the
    // same shape a person's tap has and the only shape a program that reads
    // the transition can see. A scenario with no way to type can drive a
    // program's menus and nothing that answers the keyboard.
    for (const key of request.keys ?? [])
    {
        if (state.presents === key.after)
        {
            app.input.send({ kind: 'key', code: key.code, down: true });
        }
        if (state.presents === key.after + 1)
        {
            app.input.send({ kind: 'key', code: key.code, down: false });
        }
    }
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
 *     Where a frame's time goes, asked while the run is still going. A report
 *     at the end of a run answers what a whole run cost; this answers what one
 *     frame costs, which is the question a frame rate is.
 * @property {() => boolean} exactRestart
 *     Begins the emulator's own account afresh, so a window measures itself
 *     and not the loading before it.
 * @property {string[]} errors
 * @property {{ count: number, gaps: number[] }} presents
 *     When each frame was presented, as the gaps between them in
 *     milliseconds: the shape a picture that stutters has.
 */

/**
 * @param {any} canvas   Where the last frame is shown: the page's, or an
 *     OffscreenCanvas of it inside a worker.
 * @param {{ pacing?: import('../../../src/app.js').RunPacing }} [how]
 *     How the run loop waits: a worker hands in the event-driven pacing a
 *     thread of its own allows, a page leaves the default.
 * @returns {Harness}
 */
export function createHarness(canvas, how = {}){
    /** @type {string[]} */
    const errors = [];
    const opened = openDevice(errors);
    /** @type {(() => string) | null} */
    let frameReport = null;
    /** @type {any} */
    let running = null;
    /** @type {PresentState} */
    const presentState = {
        presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], lastPresent: 0, presents: 0,
    };

    /**
     * Runs one title and reports what came out of it.
     *
     * @param {{ exe: string, bundleUrl: string, imagePath: string,
     *           commandLine?: string,
     *           sidecarHooks?: { spec: any, source: string },
     *           maxTurns?: number, maxMs?: number | null, trace?: boolean,
     *           screen?: { width: number, height: number, bitsPerPixel: number } | null,
     *           clicks?: { x: number, y: number, after: number }[],
     *           keys?: { code: string, after: number }[],
     *           keyTimes?: { code: string, atMs: number, holdMs?: number }[] }} request
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

        // The engine's own volume, when this checkout fetched the runtime. A
        // run can turn it off to compare against the engine's own d3dx table.
        const system = request.runtime === false ? undefined : await loadRuntime();

        // Reset per run: the frame this run presents is its own, but the
        // counter and the gaps it feeds keep counting across a run -- see
        // `presentFrame`.
        presentState.presented = null;
        presentState.pointerDown = false;
        presentState.pointerAt = { x: 0, y: 0 };
        /** @type {any} */
        const collected = { failures: [], missing: [], output: [], events: [] };

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
                exact: exactProfile(running, layers.memory?.layout ?? []),
                // Whether the emulator honoured the slice it was given. A quantum
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
                media: layers.media ?? null,
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
                trapCapacity: layers.cpu?.trapCapacity ?? 0,
                jit: layers.cpu?.jit ?? null,
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

        const app = await createApp({
            pacing: how.pacing,
            executable: fromBase64(request.exe),
            // What the program believes it was started with, so a run can set
            // a command-line-only cvar without touching the bundle.
            commandLine: request.commandLine,
            // A bundle's own hooks.json/hooks.mjs, read by the tool that
            // started this run from beside the bundle -- never from the
            // bundle itself.
            sidecarHooks: request.sidecarHooks,
            v86: {
                moduleUrl: new URL('../../../vendor/prebuilt/libv86.mjs', import.meta.url).href,
                wasmBytes: wasm,
            },
            media: decoder ? { wasmBytes: decoder } : undefined,
            system,
            imagePath: request.imagePath,
            screen: request.screen ?? undefined,
            // The graphics layer's own configuration, whatever fields the run
            // names: a switch the layer defaults off is turned on per run here.
            graphics: request.graphics ?? undefined,
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
                        callLog.push(formatCall(call));
                    }
                }
                : undefined,
            // Sampled guest execution, when asked for. A program that decides
            // something inside its own code makes no host call to record, and the
            // instruction pointer is then the only account of what it was doing --
            // which is exactly the situation once a game reaches its own main loop.
            jit: request.jit || undefined,
            quantum: request.quantum || undefined,
            sample: request.profile || request.quantum ? recordSample : undefined,
            device: {
                device: handle.device,
                queue: handle.device.queue,
                // Who made the hardware, for the program that asks before deciding
                // how much to ask of it.
                adapter: handle.adapter,
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
                // Fog off is the other half of a pair of runs: a wash that goes
                // with it was fog, and one that stays was not.
                probeTexture: request.probeTexture ?? null,
                fog: request.fog !== false,
                mips: request.mips !== false,
                /** @param {any} frame */
                presentTo: frame=>presentFrame(app, request, presentState, frame),
            },
            bundle: {
                fetch: rangeFetcher(request.bundleUrl),
                // Nothing durable: the page is thrown away with the browser, and a
                // cache here would only measure how fast this machine writes.
                store: null,
                prefetch: false,
            },
            storage: null,
            // This page has a device, in the only sense the engine cares about:
            // something reads the other end of the ring at the rate a device would.
            audio: { drained: true },
        });

        drainSound(app);

        listen(app, collected);
        scheduleKeyTimes(app, request);

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
        if (request.exact)
        {
            // Kept by the emulator itself rather than sampled, so it costs the
            // guest a call per block; asked for, never on by default.
            app.guestProfile.start();
        }

        const started = performance.now();
        try
        {
            result.exitCode = await app.run({
                maxTurns: request.maxTurns ?? 200000,
                timeoutMs: request.maxMs ?? null,
            });
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

        if (presentState.presented)
        {
            const image = await readBack(handle.device, presentState.presented.surface);
            show(canvas, image);
            result.frame = {
                index: presentState.presented.frameIndex,
                width: image.width,
                height: image.height,
                format: presentState.presented.surface.format,
            };
            result.colours = census(image);
            result.opacity = opacity(image);
        }
        result.presents = presentState.presents;

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
        result.exact = exactProfile(running, layout);

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
        }));

        result.failures = collected.failures;
        result.missing = [...new Set(collected.missing)];
        result.output = collected.output;
        result.events = collected.events;
        result.errors = errors;
        result.presentGaps = presentState.gaps.slice();

        await app.dispose();
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
        exactRestart: ()=>{
            // The sampled account is cleared with the emulator's own, so a
            // window that begins here is measured by itself and not by the
            // loading and the view before it.
            resetSamples();
            return Boolean(running?.guestProfile.start());
        },
        // A window is measured while it is held, so the account can be turned
        // off again for the turn to the next one -- which otherwise pays a
        // per-instruction tax while the camera moves.
        exactStop: ()=>{
            running?.guestProfile.stop();
            return Boolean(running);
        },
        errors,
        get presents(){
            return { count: presentState.presents, gaps: presentState.gaps.slice() };
        },
    };
}
