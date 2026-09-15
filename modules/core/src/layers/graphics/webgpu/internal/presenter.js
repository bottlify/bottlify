/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createPacer } from './pacer.js';

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
 */

/** The format every presented texture has; the same one the drawing APIs render to. */
const FORMAT = 'bgra8unorm';

/** `GPUTextureUsage` bits, as numbers: this file reads no global. */
const TEXTURE_USAGE = { COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 };

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
 */

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
 */
export function expandRow(row, width, bitCount, palette, out){
    if (bitCount === 32)
    {
        for (let x = 0; x < width; x++)
        {
            const at = x * 4;
            out[at] = row[at];
            out[at + 1] = row[at + 1];
            out[at + 2] = row[at + 2];
            out[at + 3] = 0xff;
        }
        return;
    }
    if (bitCount === 16)
    {
        for (let x = 0; x < width; x++)
        {
            const word = row[x * 2] | (row[x * 2 + 1] << 8);
            const at = x * 4;
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
            const entry = palette ? (palette[row[x]] ?? 0) : 0;
            const at = x * 4;
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
 */
export function createPresenter(options = {}){
    const gpu = options.device ?? null;
    const queue = options.queue ?? null;
    const screen = options.screen ?? null;
    const canvas = options.canvas ?? screen?.canvas ?? null;
    const onFrame = options.onFrame ?? (()=>{});
    const onPresented = options.onPresented ?? (()=>{});
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
    // The presenter still coalesces a burst of blits onto one flush; the pacer
    // only decides when that flush happens.
    const schedule = pacer
        ? (/** @type {() => void} */ flush)=>pacer.request(flush)
        : (options.schedule ?? (flush=>queueMicrotask(flush)));

    // What belongs to the process being drawn for. The graphics layer attaches
    // its own backend and memory reader on every lifetime, because a rebuilt
    // machine has a new address space and a new backend -- and the presenter
    // has neither: it is the same object across both.
    /** @type {(() => any) | null} */
    let backend = options.backend ?? null;
    /** @type {(address: number, length: number) => Uint8Array} */
    let readMemory = options.readMemory ?? (()=>new Uint8Array(0));

    /** @type {any} the backend surface, remade when the primary changes shape */
    let texture = null;
    /** @type {PresentableSurface | null} what to show at the next flush */
    let pending = null;
    /** @type {Uint8Array | null} */
    let converted = null;
    const counters = { presents: 0, uploads: 0, bytes: 0, shownByOwner: 0, shown: 0 };
    /** The address of the surface last handed over: which picture is on show. */
    let lastBuffer = 0;
    /** @type {string[]} */
    const failures = [];
    /** @type {Map<number, () => void>} buffer address -> who shows it */
    const claims = new Map();
    /** The format the canvas was configured in, so it is configured once. */
    let screenFormat = '';
    /** @type {any[]} every canvas copy, for the host's `presented()` */
    const history = [];
    let disposed = false;

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
        const surface = pending;
        pending = null;
        if (!surface)
        {
            return;
        }
        const owner = claims.get(surface.buffer);
        if (owner)
        {
            counters.shownByOwner++;
            owner();
            return;
        }
        let using;
        try
        {
            const accessor = backend;
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
            return;
        }
        const target = textureFor(using, surface);
        const rowBytes = surface.width * 4;
        const needed = rowBytes * surface.height;
        if (!converted || converted.byteLength !== needed)
        {
            converted = new Uint8Array(needed);
        }
        // Read a row at a time by the pitch, which may be wider than the
        // pixels: the padding is not part of the picture.
        for (let y = 0; y < surface.height; y++)
        {
            const row = readMemory(surface.buffer + y * surface.pitch,
                surface.width * (surface.bitCount >>> 3));
            expandRow(row, surface.width, surface.bitCount, surface.palette,
                converted.subarray(y * rowBytes, (y + 1) * rowBytes));
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
        const frame = using.beginFrame();
        frame.present(target);
        frame.end();
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
        const startedAt = now();
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
            encoder.copyTextureToTexture(
                { texture: surface.texture },
                { texture: screen.getCurrentTexture() },
                { width: surface.width, height: surface.height, depthOrArrayLayers: 1 });
            queue.submit([encoder.finish()]);
            counters.shown++;
            const record = {
                index: frame.frameIndex, at: startedAt, ms: now() - startedAt,
                w: surface.width, h: surface.height, failed: false,
            };
            history.push(record);
            if (history.length > 600)
            {
                history.shift();
            }
            onPresented(record);
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
            };
            history.push(record);
            if (history.length > 600)
            {
                history.shift();
            }
            onPresented(record);
            onPresentFailed({
                index: frame.frameIndex,
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    return {
        /**
         * This process's backend and memory. Called by the graphics layer when
         * it is assembled, once per machine: the presenter is the run's, the
         * address space and the GPU resources it draws into are not.
         *
         * @param {{ backend: () => any, readMemory: (address: number, length: number)
         *     => Uint8Array }} deps
         */
        attach({ backend: accessor, readMemory: reader }){
            backend = accessor;
            readMemory = reader;
        },

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
            pending = surface;
            if (first)
            {
                schedule(flush);
            }
        },

        /** Shows whatever is pending now, rather than after the burst. */
        flush,

        /** The canvas copy, used as the backend's `presentTo`. @param {any} frame */
        show,

        /**
         * A GPU owns the picture at this address. Presenting the address
         * calls `show` instead of reading guest memory, until released.
         *
         * @param {number} buffer @param {() => void} owner
         */
        claim(buffer, owner){
            claims.set(buffer >>> 0, owner);
        },

        /** @param {number} buffer */
        release(buffer){
            claims.delete(buffer >>> 0);
        },

        /** Whether a GPU owns the picture at this address. @param {number} buffer */
        isClaimed: buffer=>claims.has(buffer >>> 0),

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
                lastBuffer,
                pending: pending !== null,
                claimed: claims.size,
                failures: [...failures],
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
            claims.clear();
        },
    };
}
