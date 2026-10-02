/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createPacer } from './pacer.js';
import { createFrameLatency } from './latency.js';

/**
 * A surface in guest memory, put on the screen -- and the canvas itself.
 *
 * DirectDraw draws into guest memory: a program locks its primary surface
 * and writes pixels, or gets a device context and lets GDI write them. The
 * backend presents textures. This is what stands between the two: it keeps
 * one texture the size of the primary, and when told the primary may have
 * changed it reads the surface's bytes, turns them into the texture's
 * storage format, uploads them through the backend's own uploader and
 * presents the texture inside a frame -- so a read-back of what was shown
 * goes through the same composition the viewer sees.
 *
 * It is a service of the run, not of the machine. A process is the program
 * being executed: its textures, its buffers and its pipelines are the
 * backend's and die with it. What is on the screen is not the process's: the
 * canvas, the format it was configured in, the pacer that decides when a
 * burst is delivered and the texture the primary is copied into outlive the
 * process that first needed them. So this object is made once, above the
 * machines, and handed to each machine's graphics layer, which attaches its
 * own backend to it -- see `attach`. A replacement then draws into the same
 * texture, and the last frame the parent presented stays on the canvas until
 * the child presents its first rather than being cleared.
 *
 * Two details decide whether the picture is right or merely plausible:
 *
 * - **The channel order is the storage format's, not the API's.** The
 *   texture is `bgra8unorm`, whose bytes lie in memory as B, G, R, A. A
 *   32-bit DirectDraw surface is X8R8G8B8, whose dword `0x00RRGGBB` lies in
 *   memory as B, G, R, X -- the same order, which is why it passes through
 *   with only the undefined byte replaced by an opaque alpha. The 8- and
 *   16-bit expansions are written in that byte order too, and a test pins
 *   every channel to a different value so a swap cannot hide.
 * - **One upload per burst, not per call.** A program tells this layer the
 *   screen changed once per blit, and a frame is dozens of blits. The
 *   uploads are coalesced onto a microtask: the first change in a burst
 *   schedules one flush, and the bytes travel once, after the burst.
 * - **A surface a GPU drew has no bytes worth reading.** A Direct3D render
 *   target is a DirectDraw surface by address, and its picture is in a
 *   texture, not in guest memory. Whoever drew it claims the address, and a
 *   present of that address is handed to the claimant to show its texture
 *   instead of uploading whatever the guest bytes happen to hold.
 *
 * The display's gamma ramp is applied here too, on the way to the canvas,
 * because this is the one place every frame passes: a DirectDraw primary's,
 * a Direct3D device's and a GL context's alike. A frame shown while a ramp
 * other than the identity is in effect is drawn onto the canvas through a
 * lookup instead of copied onto it.
 */

/** The format every presented texture has; the same one the drawing APIs render to. */
const FORMAT = 'bgra8unorm';

/** `GPUTextureUsage` bits, as numbers: this file reads no global. */
const TEXTURE_USAGE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/** `GPUBufferUsage` and `GPUShaderStage` bits the gamma pass needs. */
const BUFFER_USAGE = { COPY_DST: 0x08, UNIFORM: 0x40 };
const FRAGMENT_STAGE = 0x2;

/** Entries per channel of a gamma ramp, as DirectX and GDI both give one. */
export const GAMMA_ENTRIES = 256;

/**
 * @typedef {Object} GammaRamp  Sixteen-bit entries, 256 to a channel.
 * @property {ArrayLike<number>} red
 * @property {ArrayLike<number>} green
 * @property {ArrayLike<number>} blue
 */

/**
 * @typedef {Object} DisplayGamma
 *     The display's ramp as a drawing API reaches it: what an owner sets is
 *     shown through, and what it takes back with null no longer is.
 * @property {(owner: any, ramp: GammaRamp | null) => void} set
 * @property {() => boolean} applies  Whether a ramp set reaches the picture at all.
 */

/**
 * A ramp as the present pass reads it: 256 four-float rows of red, green,
 * blue and a spare, one per eight-bit input. An entry counts by its high
 * byte, which is as much of it as an eight-bit display shows: the ramps a
 * program calls the identity -- each index times 257, or shifted up by
 * eight -- then both hand every value back unchanged.
 *
 * @param {GammaRamp} ramp
 * @returns {Float32Array}
 */
export function gammaTable(ramp){
    const table = new Float32Array(GAMMA_ENTRIES * 4);
    for (let index = 0; index < GAMMA_ENTRIES; index++)
    {
        table[index * 4] = (ramp.red[index] >>> 8) / 255;
        table[index * 4 + 1] = (ramp.green[index] >>> 8) / 255;
        table[index * 4 + 2] = (ramp.blue[index] >>> 8) / 255;
    }
    return table;
}

/** @param {GammaRamp} ramp @returns {boolean} whether every value is shown as it is */
export function isIdentityRamp(ramp){
    for (let index = 0; index < GAMMA_ENTRIES; index++)
    {
        if ((ramp.red[index] >>> 8) !== index || (ramp.green[index] >>> 8) !== index
            || (ramp.blue[index] >>> 8) !== index)
        {
            return false;
        }
    }
    return true;
}

/**
 * The gamma pass: one triangle over the canvas, each pixel the frame's texel
 * looked up per channel in the ramp. A load rather than a sample, because the
 * frame and the canvas are the same size and a pixel is to be itself.
 */
export const GAMMA_WGSL = `
@group(0) @binding(0) var frame: texture_2d<f32>;
@group(0) @binding(1) var<uniform> ramp: array<vec4<f32>, ${GAMMA_ENTRIES}>;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    let texel = textureLoad(frame, vec2<i32>(at.xy), 0);
    let entry = vec3<u32>(round(saturate(texel.rgb) * 255.0));
    return vec4<f32>(ramp[entry.r].r, ramp[entry.g].g, ramp[entry.b].b, 1.0);
}
`;

/** @param {number} value five bits @returns {number} eight, top bits replicated */
const five = value=>(value << 3) | (value >>> 2);
/** @param {number} value six bits @returns {number} eight */
const six = value=>(value << 2) | (value >>> 4);

/**
 * @typedef {Object} PresentableSurface
 * @property {number} buffer    Guest address of row zero.
 * @property {number} width
 * @property {number} height
 * @property {number} pitch     Bytes per row, which may exceed the pixels' worth.
 * @property {number} bitCount  8, 16 or 32.
 * @property {number[] | null} palette  PALETTEENTRY dwords for an 8-bit surface.
 * @property {string} [label]   What the surface is, for the record of what was shown.
 */

/**
 * Whole-buffer views, kept while the buffer they view is the one asked of:
 * a surface is expanded a row at a time out of one memory into one target,
 * and a view made for every row would cost what it saves.
 */
const views = {
    /** @type {ArrayBufferLike | null} */ in16Of: null,
    /** @type {Uint16Array<ArrayBufferLike>} */ in16: new Uint16Array(0),
    /** @type {ArrayBufferLike | null} */ in32Of: null,
    /** @type {Uint32Array<ArrayBufferLike>} */ in32: new Uint32Array(0),
    /** @type {ArrayBufferLike | null} */ outOf: null,
    /** @type {Uint32Array<ArrayBufferLike>} */ out: new Uint32Array(0),
};

/** A 5-6-5 pixel as its B, G, R, A word, for every pixel there is; made when first needed. */
let wide565 = new Uint32Array(0);

/** An 8-bit row's palette as B, G, R, A words, and the entries it was made from. */
const palettes = { words: new Uint32Array(256), from: /** @type {number[]} */ ([]),
    /** @type {readonly number[] | null} */ of: null };

/** What a row with no palette shows: black. */
const NO_PALETTE = new Uint32Array(256).fill(0xff000000);

/** @param {readonly number[] | null} palette */
const paletteWords = palette=>{
    if (palette === null)
    {
        return NO_PALETTE;
    }
    let same = palettes.of === palette;
    for (let index = 0; same && index < 256; index++)
    {
        same = palettes.from[index] === (palette[index] ?? 0);
    }
    if (!same)
    {
        for (let index = 0; index < 256; index++)
        {
            const entry = palette[index] ?? 0;
            palettes.from[index] = entry;
            palettes.words[index] = (0xff000000 | ((entry & 0xff) << 16) | (entry & 0xff00)
                | ((entry >>> 16) & 0xff)) >>> 0;
        }
        palettes.of = palette;
    }
    return palettes.words;
};

/**
 * `expandRow` over words: four bytes of the target at a time, read from the
 * row by its own width. The platforms this runs on are little-endian, which
 * is what makes a B, G, R, A word and a guest pixel the same bytes.
 *
 * @param {Uint8Array} row @param {number} width @param {number} bitCount
 * @param {number[] | null} palette @param {Uint8Array} out
 * @param {number} inAt  the row's first byte, in its buffer
 * @param {number} toAt  the target's first word, in its buffer
 */
function expandWords(row, width, bitCount, palette, out, inAt, toAt){
    if (views.outOf !== out.buffer)
    {
        views.outOf = out.buffer;
        views.out = new Uint32Array(out.buffer, 0, out.buffer.byteLength >>> 2);
    }
    const target = views.out;
    if (bitCount === 32)
    {
        if (views.in32Of !== row.buffer)
        {
            views.in32Of = row.buffer;
            views.in32 = new Uint32Array(row.buffer, 0, row.buffer.byteLength >>> 2);
        }
        const source = views.in32;
        const from = inAt >>> 2;
        for (let x = 0; x < width; x++)
        {
            target[toAt + x] = (source[from + x] | 0xff000000) >>> 0;
        }
        return;
    }
    if (bitCount === 16)
    {
        if (wide565.length === 0)
        {
            wide565 = new Uint32Array(0x10000);
            for (let word = 0; word < 0x10000; word++)
            {
                wide565[word] = (0xff000000 | (five(word >>> 11) << 16)
                    | (six((word >>> 5) & 0x3f) << 8) | five(word & 0x1f)) >>> 0;
            }
        }
        if (views.in16Of !== row.buffer)
        {
            views.in16Of = row.buffer;
            views.in16 = new Uint16Array(row.buffer, 0, row.buffer.byteLength >>> 1);
        }
        const source = views.in16;
        const from = inAt >>> 1;
        for (let x = 0; x < width; x++)
        {
            target[toAt + x] = wide565[source[from + x]];
        }
        return;
    }
    const words = paletteWords(palette);
    const bytes = new Uint8Array(row.buffer, inAt, width);
    for (let x = 0; x < width; x++)
    {
        target[toAt + x] = words[bytes[x]];
    }
}

/**
 * One row of a surface, as B, G, R, A bytes.
 *
 * A PALETTEENTRY is the bytes red, green, blue, flags in that order, so a
 * little-endian dword of one has red in its low byte -- the opposite of a
 * pixel. A 16-bit pixel is 5-6-5, the format DirectDraw sets a 16-bit mode
 * as. Both are written out here rather than shared with the drawing APIs'
 * converters because the destination order is this file's own fact.
 *
 * @param {Uint8Array} row      The row's bytes from guest memory.
 * @param {number} width
 * @param {number} bitCount
 * @param {number[] | null} palette
 * @param {Uint8Array} out      `width * 4` bytes.
 * @param {number} [rowAt]      Where the row starts in `row`, and the pixels in
 * @param {number} [outAt]      `out`: a surface is read and written a row at a
 *     time without a view made for every row.
 */
export function expandRow(row, width, bitCount, palette, out, rowAt = 0, outAt = 0){
    const inAt = row.byteOffset + rowAt;
    const toAt = out.byteOffset + outAt;
    if (toAt % 4 === 0 && (bitCount === 8 || inAt % (bitCount >>> 3) === 0)
        && (bitCount === 8 || bitCount === 16 || bitCount === 32))
    {
        expandWords(row, width, bitCount, palette, out, inAt, toAt >>> 2);
        return;
    }
    if (bitCount === 32)
    {
        for (let x = 0; x < width; x++)
        {
            const from = rowAt + x * 4;
            const at = outAt + x * 4;
            out[at] = row[from];
            out[at + 1] = row[from + 1];
            out[at + 2] = row[from + 2];
            out[at + 3] = 0xff;
        }
        return;
    }
    if (bitCount === 16)
    {
        for (let x = 0; x < width; x++)
        {
            const word = row[rowAt + x * 2] | (row[rowAt + x * 2 + 1] << 8);
            const at = outAt + x * 4;
            out[at] = five(word & 0x1f);
            out[at + 1] = six((word >>> 5) & 0x3f);
            out[at + 2] = five(word >>> 11);
            out[at + 3] = 0xff;
        }
        return;
    }
    if (bitCount === 8)
    {
        for (let x = 0; x < width; x++)
        {
            const entry = palette ? (palette[row[rowAt + x]] ?? 0) : 0;
            const at = outAt + x * 4;
            out[at] = (entry >>> 16) & 0xff;
            out[at + 1] = (entry >>> 8) & 0xff;
            out[at + 2] = entry & 0xff;
            out[at + 3] = 0xff;
        }
        return;
    }
    throw new Error(`A ${bitCount}-bit surface cannot be presented`);
}

/**
 * @param {Object} options
 * @param {any} [options.device]   The GPU device, for the canvas copy.
 * @param {any} [options.queue]    Its queue, for the same.
 * @param {any} [options.screen]   The canvas's WebGPU context, configured once.
 * @param {any} [options.canvas]   The canvas itself, resized to the frame; the
 *     context's own canvas is used when this is absent.
 * @param {() => any} [options.backend]
 *        The process's backend, or `attach` supplies it later. Reached on the
 *        first present rather than at construction, so a build that never
 *        shows a DirectDraw surface never builds a GPU.
 * @param {(address: number, length: number) => Uint8Array} [options.readMemory]
 * @param {(address: number, length: number) => Uint8Array} [options.windowMemory]
 *        The bytes themselves rather than a copy, which a present reads the
 *        surface through at once where it is given.
 * @param {(flush: () => void) => void} [options.schedule]
 *        When to flush a burst. A microtask by default; a test passes its own.
 * @param {() => number} [options.now]  Monotonic milliseconds, for the pacer and
 *     for the record of each presented frame.
 * @param {number} [options.maxFps]     Frames a second the pacer may deliver.
 * @param {(payload: any) => void} [options.onFrame]
 *        A frame reached the canvas, the first or after a resize.
 * @param {(record: any) => void} [options.onPresented]
 *        Every canvas copy, for the host's own history of them.
 * @param {(payload: any) => void} [options.onPresentFailed]
 * @param {(frame: any) => void} [options.presentTo]
 *        Where a frame goes in a build with no canvas: the caller's own sink,
 *        for a test harness that reads a frame back.
 * @param {number} [options.maxFrameLatency]
 *        The frames the device may still be working on when a presenting call
 *        answers; three by default, zero for no bound (see `latency.js`). One
 *        count for the run, as there is one queue.
 */
export function createPresenter(options = {}){
    const gpu = options.device ?? null;
    const queue = options.queue ?? null;
    const screen = options.screen ?? null;
    const canvas = options.canvas ?? screen?.canvas ?? null;
    const onFrame = options.onFrame ?? (()=>{});
    const onPresented = options.onPresented ?? null;
    const onPresentFailed = options.onPresentFailed ?? (()=>{});
    const now = options.now ?? (()=>performance.now());
    // A caller that has no canvas to configure but does have somewhere to put a
    // frame -- a test harness reading back one surface -- is handed the frame
    // here instead. Without it a presenter made for a displayless build would
    // swallow every frame.
    const fallbackPresentTo = options.presentTo ?? null;

    // The cap belongs here rather than anywhere further in: this is the one
    // place that decides when a frame is delivered, and a frame delivered
    // faster than a display can show it is work nobody sees. A caller without
    // both a clock and a scheduler gets a microtask, which is what a headless
    // build and the unit tests use.
    const maxFps = options.maxFps ?? 60;
    const pacer = options.schedule && options.now
        ? createPacer({
            now,
            schedule: options.schedule,
            minIntervalMs: maxFps > 0 ? 1000 / maxFps : 0,
            targetFps: maxFps > 0 ? maxFps : undefined,
        })
        : null;
    // Every presenting call of every machine counts against one bound: the
    // frames are all on the one queue.
    const latency = createFrameLatency({
        queue, limit: options.maxFrameLatency, lost: gpu?.lost ?? null, now,
    });
    // The presenter still coalesces a burst of blits onto one flush; the pacer
    // only decides when that flush happens.
    const schedule = pacer
        ? (/** @type {() => void} */ flush)=>pacer.request(flush)
        : (options.schedule ?? (flush=>queueMicrotask(flush)));

    /**
     * What one machine brought: its backend, its address space, and the
     * addresses whose picture its GPU owns. The graphics layer attaches its
     * own on every lifetime, because a machine has an address space and a
     * backend of its own and the presenter has neither -- and a machine goes
     * while the presenter stays: a child started beside its parent ends and
     * the parent draws on, a process is replaced. So each attachment is kept
     * apart, a surface is read through the one that presented it, and one
     * that has gone is never reached again.
     *
     * @typedef {{ backend: (() => any) | null,
     *     readMemory: (address: number, length: number) => Uint8Array,
     *     windowMemory?: (address: number, length: number) => Uint8Array,
     *     claims: Map<number, () => unknown>, live: boolean }} Attachment
     */
    /** @type {Attachment[]} the construction's own first, the newest last */
    const attachments = [{
        backend: options.backend ?? null,
        readMemory: options.readMemory ?? (()=>new Uint8Array(0)),
        windowMemory: options.windowMemory,
        claims: new Map(),
        live: true,
    }];
    const newest = ()=>attachments[attachments.length - 1];

    /** @type {any} the backend surface, remade when the primary changes shape */
    let texture = null;
    /** What the texture holds: the label of the guest surface last uploaded into it. */
    let uploadedLabel = 'guest bytes';
    /** @type {{ surface: PresentableSurface, from: Attachment } | null} what to show at the next flush */
    let pending = null;
    /**
     * Settled when the pending burst's frame is on the queue, for a flip that
     * counts it as a frame queued; made only when one asks.
     *
     * @type {{ promise: Promise<unknown>, settle: (value: unknown) => void } | null}
     */
    let burst = null;
    /** @type {Uint8Array | null} */
    let converted = null;
    const counters = {
        presents: 0, uploads: 0, bytes: 0, shownByOwner: 0, shown: 0, gammaShown: 0,
        dropped: 0,
    };
    /**
     * Canvas copies by the label of the surface shown: a Direct3D target, a
     * GL swapchain, or the guest bytes of a primary or the desktop. A picture
     * that a device draws and something else paints over is two labels
     * rising together, and this is where that is seen.
     * @type {Record<string, number>}
     */
    const shownBy = {};
    /** The address of the surface last handed over: which picture is on show. */
    let lastBuffer = 0;
    /** @type {string[]} */
    const failures = [];
    /** The format the canvas was configured in, so it is configured once. */
    let screenFormat = '';
    /** @type {any[]} every canvas copy, for the host's `presented()` */
    const history = [];
    let disposed = false;

    /**
     * The ramps set, by who set them, oldest first: the latest is the one
     * shown, and taking it back shows the one before -- as a device that
     * goes gives the display back the ramp it had.
     *
     * @type {Map<any, { red: Uint16Array, green: Uint16Array, blue: Uint16Array }>}
     */
    const ramps = new Map();
    /** @type {Float32Array | null} the ramp in effect as the pass reads it; null is the identity */
    let gammaInEffect = null;
    let gammaVersion = 0;
    /**
     * What the gamma pass is built of, made on the first frame that needs
     * it. The table is written when the ramp changes, not every frame.
     *
     * @type {{ format: string, pipeline: any, layout: any, table: any, written: number }
     *     | null}
     */
    let gammaPass = null;
    /** @type {WeakMap<object, { layout: any, bindGroup: any }>} a frame texture's binding */
    const gammaGroups = new WeakMap();

    const recomputeGamma = ()=>{
        const latest = [...ramps.values()].at(-1) ?? null;
        gammaInEffect = latest && !isIdentityRamp(latest) ? gammaTable(latest) : null;
        gammaVersion++;
    };

    /**
     * Whether the gamma pass can read a frame's texture: bound as a texture,
     * one sample to a pixel. One it cannot is copied as it is.
     *
     * @param {any} frameTexture
     */
    const readable = frameTexture=>Boolean(frameTexture)
        && ((frameTexture.usage ?? 0) & TEXTURE_USAGE.TEXTURE_BINDING) !== 0
        && (frameTexture.sampleCount ?? 1) === 1;

    /**
     * The frame, drawn onto the canvas texture through the ramp.
     *
     * @param {any} encoder @param {any} surface @param {any} canvasTexture
     */
    const drawThroughRamp = (encoder, surface, canvasTexture)=>{
        if (!gammaPass || gammaPass.format !== surface.format)
        {
            const layout = gpu.createBindGroupLayout({
                label: 'present-gamma',
                entries: [
                    { binding: 0, visibility: FRAGMENT_STAGE, texture: { sampleType: 'float' } },
                    { binding: 1, visibility: FRAGMENT_STAGE, buffer: { type: 'uniform' } },
                ],
            });
            const module = gpu.createShaderModule({ label: 'present-gamma', code: GAMMA_WGSL });
            gammaPass = {
                format: surface.format,
                layout,
                pipeline: gpu.createRenderPipeline({
                    label: 'present-gamma',
                    layout: gpu.createPipelineLayout({ bindGroupLayouts: [layout] }),
                    vertex: { module, entryPoint: 'vs' },
                    fragment: { module, entryPoint: 'fs', targets: [{ format: surface.format }] },
                    primitive: { topology: 'triangle-list' },
                }),
                table: gpu.createBuffer({
                    label: 'present-gamma', size: GAMMA_ENTRIES * 16,
                    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
                }),
                written: -1,
            };
        }
        const pass = /** @type {NonNullable<typeof gammaPass>} */ (gammaPass);
        if (pass.written !== gammaVersion)
        {
            queue.writeBuffer(pass.table, 0, /** @type {Float32Array} */ (gammaInEffect));
            pass.written = gammaVersion;
        }
        let group = gammaGroups.get(surface.texture);
        if (!group || group.layout !== pass.layout)
        {
            group = {
                layout: pass.layout,
                bindGroup: gpu.createBindGroup({
                    label: 'present-gamma',
                    layout: pass.layout,
                    entries: [
                        { binding: 0, resource: surface.texture.createView() },
                        { binding: 1, resource: { buffer: pass.table } },
                    ],
                }),
            };
            gammaGroups.set(surface.texture, group);
        }
        const render = encoder.beginRenderPass({
            label: 'present-gamma',
            colorAttachments: [{
                view: canvasTexture.createView(),
                loadOp: 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: 'store',
            }],
        });
        render.setPipeline(pass.pipeline);
        render.setBindGroup(0, group.bindGroup);
        render.draw(3);
        render.end();
    };

    /** @param {any} using @param {PresentableSurface} surface */
    const textureFor = (using, surface)=>{
        if (!texture || texture.width !== surface.width || texture.height !== surface.height)
        {
            const usage = using.TextureUsage;
            texture = using.createSurface({
                width: surface.width,
                height: surface.height,
                format: FORMAT,
                label: 'ddraw-primary',
                usage: usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING | usage.COPY_SRC
                    | usage.COPY_DST,
            });
        }
        return texture;
    };

    const flush = ()=>{
        const shown = burst;
        burst = null;
        /** @type {unknown} */
        let submitted;
        try
        {
            submitted = flushPending();
        }
        finally
        {
            shown?.settle(submitted);
        }
    };

    /**
     * @returns {unknown} what settles once the frame is on the queue, when it
     *     is not yet: the promise an owner answers with
     */
    const flushPending = ()=>{
        const held = pending;
        pending = null;
        if (!held)
        {
            return undefined;
        }
        const { surface, from } = held;
        if (!from.live)
        {
            // Presented by a machine that has gone since: the address named a
            // place in its address space, which went with it.
            counters.dropped++;
            return undefined;
        }
        const owner = from.claims.get(surface.buffer);
        if (owner)
        {
            counters.shownByOwner++;
            return owner();
        }
        let using;
        try
        {
            const accessor = from.backend;
            if (!accessor)
            {
                throw new Error('graphics: no process backend was attached to the presenter');
            }
            using = accessor();
        }
        catch (e){
            // No GPU in this build: the change is noted and nothing is shown,
            // which is the degraded mode rather than a failed frame.
            if (failures.length < 16)
            {
                failures.push(e instanceof Error ? e.message : String(e));
            }
            return undefined;
        }
        const target = textureFor(using, surface);
        uploadedLabel = surface.label ?? 'guest bytes';
        const rowBytes = surface.width * 4;
        const needed = rowBytes * surface.height;
        if (!converted || converted.byteLength !== needed)
        {
            converted = new Uint8Array(needed);
        }
        // Read a row at a time by the pitch, which may be wider than the
        // pixels: the padding is not part of the picture. Through one window
        // over the rows where the machine offers one, which is read here and
        // not kept; a copy of each row otherwise.
        const guestRow = surface.width * (surface.bitCount >>> 3);
        if (from.windowMemory && surface.height > 0)
        {
            const rows = from.windowMemory(surface.buffer,
                (surface.height - 1) * surface.pitch + guestRow);
            for (let y = 0; y < surface.height; y++)
            {
                expandRow(rows, surface.width, surface.bitCount, surface.palette, converted,
                    y * surface.pitch, y * rowBytes);
            }
        }
        else
        {
            for (let y = 0; y < surface.height; y++)
            {
                const row = from.readMemory(surface.buffer + y * surface.pitch, guestRow);
                expandRow(row, surface.width, surface.bitCount, surface.palette, converted,
                    0, y * rowBytes);
            }
        }
        using.uploadTexture({
            texture: target.texture,
            format: FORMAT,
            width: surface.width,
            height: surface.height,
            data: converted,
        });
        counters.uploads++;
        counters.bytes += needed;
        // Nothing recorded rides on it: the cuts the renderers made are
        // counted by their own frames.
        const frame = using.beginFrame({ cut: null });
        frame.present(target);
        frame.end();
        return undefined;
    };

    /**
     * What settles once the frame the pending burst makes is on the queue,
     * or null when nothing is pending: every present of the burst is one
     * frame.
     *
     * @returns {Promise<unknown> | null}
     */
    const flushed = ()=>{
        if (pending === null)
        {
            return null;
        }
        if (!burst)
        {
            /** @type {(value: unknown) => void} */
            let settle = ()=>{};
            const promise = new Promise(resolve=>{
                settle = resolve;
            });
            burst = { promise, settle };
        }
        return burst.promise;
    };

    /**
     * The finished frame, onto the canvas.
     *
     * This is the backend's `presentTo`: every frame any API presents arrives
     * here, whether it came from guest bytes this presenter uploaded or from a
     * render target the GPU drew. The canvas is configured in the frame's own
     * format the first time and not again -- a reconfigure clears it, and the
     * whole point of the presenter outliving the process is that the last frame
     * of the old one stays visible until the new one has something to show.
     *
     * @param {any} frame
     */
    const show = frame=>{
        const surface = frame.surface;
        if (!gpu || !queue || !screen)
        {
            fallbackPresentTo?.(frame);
            return;
        }
        // A present's record -- when, how long, how big -- is kept for a report
        // and handed to whoever asked for it; a production bundle keeps none
        // and, with nobody asking, reads no clock for it either.
        const recorded = import.meta.BOTTLIFY_DIAGNOSTICS !== false || onPresented !== null;
        const startedAt = recorded ? now() : 0;
        try
        {
            const resized = canvas
                && (canvas.width !== surface.width || canvas.height !== surface.height);
            if (resized)
            {
                canvas.width = surface.width;
                canvas.height = surface.height;
            }
            if (screenFormat !== surface.format)
            {
                // Configured in the frame's own format, so the copy is a
                // copy and not a conversion.
                screen.configure({
                    device: gpu,
                    format: surface.format,
                    usage: TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT,
                    alphaMode: 'opaque',
                });
                screenFormat = surface.format;
            }
            const encoder = gpu.createCommandEncoder({ label: 'present' });
            const canvasTexture = screen.getCurrentTexture();
            if (gammaInEffect && readable(surface.texture))
            {
                drawThroughRamp(encoder, surface, canvasTexture);
                counters.gammaShown++;
            }
            else
            {
                encoder.copyTextureToTexture(
                    { texture: surface.texture },
                    { texture: canvasTexture },
                    { width: surface.width, height: surface.height, depthOrArrayLayers: 1 });
            }
            queue.submit([encoder.finish()]);
            counters.shown++;
            const label = surface === texture ? uploadedLabel : (surface.label ?? 'surface');
            shownBy[label] = (shownBy[label] ?? 0) + 1;
            if (recorded)
            {
                const record = {
                    index: frame.frameIndex, at: startedAt, ms: now() - startedAt,
                    w: surface.width, h: surface.height, failed: false, label,
                };
                if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                {
                    history.push(record);
                    if (history.length > 600)
                    {
                        history.shift();
                    }
                }
                onPresented?.(record);
            }
            if (resized || counters.shown === 1)
            {
                onFrame({
                    width: surface.width, height: surface.height,
                    presented: counters.shown, resized: Boolean(resized),
                });
            }
        }
        catch (e){
            const record = {
                index: frame.frameIndex, at: startedAt, ms: -1, w: 0, h: 0, failed: true,
                label: surface === texture ? uploadedLabel : (surface.label ?? 'surface'),
            };
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
            {
                history.push(record);
                if (history.length > 600)
                {
                    history.shift();
                }
            }
            onPresented?.(record);
            onPresentFailed({
                index: frame.frameIndex,
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    /**
     * What one machine does with the presenter: present a surface of its own
     * address space, and say which of its addresses its GPU owns.
     *
     * @param {Attachment} from
     */
    const machineView = from=>({
        /**
         * The primary surface may have changed. Nothing travels yet: the
         * burst this call is part of is flushed once, afterwards.
         *
         * @param {PresentableSurface} surface
         */
        present(surface){
            counters.presents++;
            lastBuffer = surface.buffer;
            const first = pending === null;
            pending = { surface, from };
            if (first)
            {
                schedule(flush);
            }
        },

        /** Shows whatever is pending now, rather than after the burst. */
        flush,

        flushed,

        /**
         * A presenting call of this machine queued a frame; see `latency.js`.
         * The bound is the run's, as the queue is.
         */
        queued: latency.queued,

        /**
         * A GPU owns the picture at this address. Presenting the address
         * calls `owner` instead of reading guest memory, until released; what
         * it answers, when a promise, settles once its frame is on the queue.
         *
         * @param {number} buffer @param {() => unknown} owner
         */
        claim(buffer, owner){
            from.claims.set(buffer >>> 0, owner);
        },

        /** @param {number} buffer */
        release(buffer){
            from.claims.delete(buffer >>> 0);
        },

        /** Whether a GPU owns the picture at this address. @param {number} buffer */
        isClaimed: (/** @type {number} */ buffer)=>from.claims.has(buffer >>> 0),
    });

    return {
        /**
         * This process's backend and memory. Called by the graphics layer when
         * it is assembled, once per machine: the presenter is the run's, the
         * address space and the GPU resources it draws into are not.
         *
         * Answers the machine's own view, through which it presents and
         * claims; `detach` ends it. A surface it presented and that was not
         * shown yet is dropped then rather than read, and the addresses it
         * claimed are no longer its GPU's.
         *
         * @param {{ backend: () => any, readMemory: (address: number, length: number)
         *     => Uint8Array, windowMemory?: (address: number, length: number) => Uint8Array }} deps
         *     `windowMemory`, where the machine has one, is the bytes themselves
         *     rather than a copy: a present reads the surface through it at once.
         */
        attach({ backend: accessor, readMemory: reader, windowMemory }){
            /** @type {Attachment} */
            const own = { backend: accessor, readMemory: reader, windowMemory, claims: new Map(),
                live: true };
            attachments.push(own);
            return {
                ...machineView(own),
                detach(){
                    own.live = false;
                    own.claims.clear();
                    const at = attachments.indexOf(own);
                    if (at >= 0)
                    {
                        attachments.splice(at, 1);
                    }
                },
            };
        },

        // The same, for whoever attached last: a build that made this
        // presenter for itself and holds nothing else.
        present: (/** @type {PresentableSurface} */ surface)=>machineView(newest()).present(surface),
        flush,
        flushed,
        queued: latency.queued,
        claim: (/** @type {number} */ buffer, /** @type {() => unknown} */ owner)=>
            machineView(newest()).claim(buffer, owner),
        release: (/** @type {number} */ buffer)=>machineView(newest()).release(buffer),
        isClaimed: (/** @type {number} */ buffer)=>machineView(newest()).isClaimed(buffer),

        /** The canvas copy, used as the backend's `presentTo`. @param {any} frame */
        show,

        /**
         * The gamma ramp frames are shown through, set by `owner`: the
         * display's own through GDI, a full-screen device's, a DirectDraw
         * primary's. The latest set is in effect; null takes an owner's ramp
         * back, and the one set before it is in effect again.
         *
         * @param {any} owner  Whoever sets it; setting again replaces its own.
         * @param {GammaRamp | null} ramp
         */
        setGammaRamp(owner, ramp){
            ramps.delete(owner);
            if (ramp)
            {
                ramps.set(owner, {
                    red: Uint16Array.from(ramp.red), green: Uint16Array.from(ramp.green),
                    blue: Uint16Array.from(ramp.blue),
                });
            }
            recomputeGamma();
        },

        /**
         * @returns {{ red: Uint16Array, green: Uint16Array, blue: Uint16Array } | null}
         *     the ramp in effect, or null when none was set
         */
        gammaRamp(){
            const latest = [...ramps.values()].at(-1);
            return latest
                ? { red: latest.red.slice(), green: latest.green.slice(),
                    blue: latest.blue.slice() }
                : null;
        },

        /**
         * Whether a ramp reaches the picture: it is applied on the way to the
         * canvas, so a presenter with none -- a headless build handing frames
         * to a caller's sink -- shows every frame as it was drawn.
         */
        appliesGamma: ()=>Boolean(gpu && queue && screen),

        /** The delivery rhythm, when the assembling caller gave a clock and a schedule. */
        pacing: ()=>pacer ? pacer.diagnostics() : null,

        /**
         * Every frame that reached the canvas in this run, whatever machine
         * drew it. Cumulative across a replacement, because the canvas is.
         */
        presented: ()=>({ count: counters.shown, history: history.slice() }),

        diagnostics(){
            return {
                ...counters,
                shownBy: { ...shownBy },
                lastBuffer,
                pending: pending !== null,
                claimed: attachments.reduce((sum, attached)=>sum + attached.claims.size, 0),
                gamma: gammaInEffect !== null,
                attached: attachments.length - 1,
                failures: [...failures],
                latency: latency.diagnostics(),
                disposed,
            };
        },

        /**
         * Releases what belongs to the run. Called when the whole run is over,
         * never per machine: the process that replaces this one draws into the
         * same texture.
         */
        dispose(){
            disposed = true;
            texture = null;
            converted = null;
            pending = null;
            burst?.settle(undefined);
            burst = null;
            latency.close();
            for (const attached of attachments)
            {
                attached.claims.clear();
            }
            ramps.clear();
            gammaInEffect = null;
            gammaPass = null;
        },
    };
}
