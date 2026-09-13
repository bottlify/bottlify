/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A surface in guest memory, put on the screen.
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
 * @param {() => any} options.backend
 *        Reached on the first present rather than at construction, so a
 *        build that never shows a DirectDraw surface never builds a GPU.
 * @param {(address: number, length: number) => Uint8Array} options.readMemory
 * @param {(flush: () => void) => void} [options.schedule]
 *        When to flush a burst. A microtask by default; a test passes its own.
 */
export function createPresenter(options){
    const schedule = options.schedule ?? (flush=>queueMicrotask(flush));
    /** @type {any} the backend surface, remade when the primary changes shape */
    let texture = null;
    /** @type {PresentableSurface | null} what to show at the next flush */
    let pending = null;
    /** @type {Uint8Array | null} */
    let converted = null;
    const counters = { presents: 0, uploads: 0, bytes: 0, shownByOwner: 0 };
    /** The address of the surface last handed over: which picture is on show. */
    let lastBuffer = 0;
    /** @type {string[]} */
    const failures = [];
    /** @type {Map<number, () => void>} buffer address -> who shows it */
    const claims = new Map();

    /** @param {any} backend @param {PresentableSurface} surface */
    const textureFor = (backend, surface)=>{
        if (!texture || texture.width !== surface.width || texture.height !== surface.height)
        {
            const usage = backend.TextureUsage;
            texture = backend.createSurface({
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
        let backend;
        try
        {
            backend = options.backend();
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
        const target = textureFor(backend, surface);
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
            const row = options.readMemory(surface.buffer + y * surface.pitch,
                surface.width * (surface.bitCount >>> 3));
            expandRow(row, surface.width, surface.bitCount, surface.palette,
                converted.subarray(y * rowBytes, (y + 1) * rowBytes));
        }
        backend.uploadTexture({
            texture: target.texture,
            format: FORMAT,
            width: surface.width,
            height: surface.height,
            data: converted,
        });
        counters.uploads++;
        counters.bytes += needed;
        const frame = backend.beginFrame();
        frame.present(target);
        frame.end();
    };

    return {
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

        /**
         * A GPU owns the picture at this address. Presenting the address
         * calls `show` instead of reading guest memory, until released.
         *
         * @param {number} buffer @param {() => void} show
         */
        claim(buffer, show){
            claims.set(buffer >>> 0, show);
        },

        /** @param {number} buffer */
        release(buffer){
            claims.delete(buffer >>> 0);
        },

        /** Whether a GPU owns the picture at this address. @param {number} buffer */
        isClaimed: buffer=>claims.has(buffer >>> 0),

        diagnostics(){
            return {
                ...counters,
                lastBuffer,
                pending: pending !== null,
                claimed: claims.size,
                failures: [...failures],
            };
        },
    };
}
