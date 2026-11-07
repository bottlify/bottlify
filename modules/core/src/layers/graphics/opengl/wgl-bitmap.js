/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A context on a memory DC, as OPENGL32's generic renderer keeps it: the
 * context draws into a colour buffer of its own, the size of the bitmap
 * selected when it was made, and that buffer meets the bitmap selected now
 * at three moments (Wine's opengl32 test_bitmap_rendering,
 * test_16bit_bitmap_rendering and test_d3dkmt_rendering):
 *
 * - **made current**, the first time: the buffer starts as the bitmap's
 *   pixels, so a read before any drawing reads what the bitmap holds;
 * - **glFlush, glFinish and glReadPixels**: what was drawn since the buffer
 *   last met a bitmap is copied into the bitmap selected now -- not the one
 *   selected when the context was made current -- and a read then reads it;
 * - and at those same calls, when nothing was drawn but another bitmap was
 *   selected since, the buffer is that bitmap's pixels again.
 *
 * A bitmap is met as Windows meets it, whatever its own depth: a pixel is a
 * word as wide as the pixel format's colour depth says, the rows as many and
 * as long as the bitmap's, and the value in a word is a pixel of the depth
 * of the bitmap selected when the context was made -- five bits a channel
 * for sixteen, the bytes of a 32-bit DIB otherwise. A 32-bit context over a
 * sixteen-bit DIB writes 32-bit pixels into it; what Windows writes past the
 * end of the bitmap's bits that way is not written here.
 *
 * Whether anything was drawn is the buffer against the copy taken when it
 * last met a bitmap: a draw reaches the buffer through the entry points and
 * through the command ring alike, so the buffer is what can tell. The
 * buffer's row zero is its top, as a top-down DIB's is; a bitmap of another
 * size is met over the rectangle the two share, from the top left.
 */

/**
 * The selected bitmap's pixels as `graphics/gdi/surface.js` makes them: its
 * size, depth, orientation and its own bytes, from `offset` on, `pitch` a row.
 *
 * @typedef {Object} BitmapSurface
 * @property {number} bitmap  The bitmap selected, by handle.
 * @property {{ width: number, height: number, bitCount: number, pitch: number,
 *     topDown: boolean, bytes: Uint8Array, offset: number }} surface
 */

/**
 * A 32-bit pixel's channels as five bits each.
 *
 * @param {number} b @param {number} g @param {number} r
 */
const to555 = (b, g, r)=>((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3);
/** A five-bit channel widened so that full scale stays full. @param {number} c */
const widen5 = c=>(c << 3) | (c >>> 2);

/**
 * @param {{ bitmapSurface: (hdc: number) => BitmapSurface | null }} gdi
 */
export function createBitmapDrawables(gdi){
    /**
     * Each context on a memory DC: the DC it was last made current on, the
     * bytes a pixel takes (`word`) and the depth of its values (`depth`), the
     * bitmap its buffer last met, and the buffer as it was then.
     *
     * @type {WeakMap<any, { hdc: number, word: number, depth: number, bitmap: number,
     *     synced: Uint8Array, seen: Uint8Array }>}
     */
    const bound = new WeakMap();

    /**
     * Each pixel the buffer and a bitmap share: the buffer's byte offset and
     * the bitmap's, the word wholly inside the bitmap's bytes.
     *
     * @param {{ width: number, height: number }} frame
     * @param {BitmapSurface['surface']} surface @param {number} word
     * @param {(at: number, into: number) => void} each
     */
    const shared = (frame, surface, word, each)=>{
        const pitch = ((surface.width * word * 8 + 31) >>> 5) * 4;
        const end = surface.offset + surface.pitch * surface.height;
        const width = Math.min(frame.width, surface.width);
        const height = Math.min(frame.height, surface.height);
        for (let y = 0; y < height; y++)
        {
            const row = surface.offset + (surface.topDown ? y : surface.height - 1 - y) * pitch;
            for (let x = 0; x < width; x++)
            {
                const into = row + x * word;
                if (into + word <= end)
                {
                    each((y * frame.width + x) * 4, into);
                }
            }
        }
    };

    /**
     * @param {{ width: number, height: number, bytes: Uint8Array }} frame
     * @param {BitmapSurface['surface']} surface
     * @param {{ word: number, depth: number }} record
     */
    const load = (frame, surface, { word, depth })=>{
        const bytes = surface.bytes;
        const out = frame.bytes;
        shared(frame, surface, word, (at, from)=>{
            if (depth === 16)
            {
                const value = bytes[from] | (bytes[from + 1] << 8);
                out[at] = widen5(value & 0x1f);
                out[at + 1] = widen5((value >>> 5) & 0x1f);
                out[at + 2] = widen5((value >>> 10) & 0x1f);
                out[at + 3] = 0xff;
                return;
            }
            for (let k = 0; k < 4; k++)
            {
                out[at + k] = k < word ? bytes[from + k] : 0;
            }
        });
    };

    /**
     * @param {{ width: number, height: number, bytes: Uint8Array }} frame
     * @param {BitmapSurface['surface']} surface
     * @param {{ word: number, depth: number }} record
     */
    const store = (frame, surface, { word, depth })=>{
        const bytes = surface.bytes;
        const from = frame.bytes;
        shared(frame, surface, word, (at, into)=>{
            const packed = depth === 16 ? to555(from[at], from[at + 1], from[at + 2]) : 0;
            const value = depth === 16 ? [packed & 0xff, packed >>> 8, 0, 0]
                : [from[at], from[at + 1], from[at + 2], from[at + 3]];
            for (let k = 0; k < word; k++)
            {
                bytes[into + k] = value[k];
            }
        });
    };

    /** @param {Uint8Array} a @param {Uint8Array} b */
    const same = (a, b)=>{
        if (a.length !== b.length)
        {
            return false;
        }
        for (let i = 0; i < a.length; i++)
        {
            if (a[i] !== b[i])
            {
                return false;
            }
        }
        return true;
    };

    return {
        /**
         * The depth a context made now on a memory DC draws in: the selected
         * bitmap's, sixteen bits or 32.
         *
         * @param {number} hdc @returns {number}
         */
        depthAt(hdc){
            return gdi.bitmapSurface(hdc)?.surface.bitCount === 16 ? 16 : 32;
        },

        /**
         * A context made current on a memory DC: the first time, its buffer
         * becomes the selected bitmap's pixels.
         *
         * @param {any} context @param {number} hdc
         * @param {{ colorBits: number, depth: number }} made
         *     The pixel format's colour bits and the depth it was made in.
         */
        made(context, hdc, made){
            const record = bound.get(context);
            if (record)
            {
                record.hdc = hdc;
                return;
            }
            const created = { hdc, word: made.colorBits === 16 ? 2 : 4, depth: made.depth,
                bitmap: 0, synced: new Uint8Array(0), seen: new Uint8Array(0) };
            const selected = gdi.bitmapSurface(hdc);
            const frame = context.framebuffer;
            if (selected && frame?.bytes?.length > 0)
            {
                load(frame, selected.surface, created);
            }
            created.bitmap = selected?.bitmap ?? 0;
            created.synced = frame?.bytes ? frame.bytes.slice() : new Uint8Array(0);
            created.seen = selected ? selected.surface.bytes.slice() : new Uint8Array(0);
            bound.set(context, created);
        },

        /**
         * glFlush, glFinish, glReadPixels: what was drawn goes to the bitmap
         * selected now, or, with nothing drawn, another bitmap selected since
         * is read in.
         *
         * @param {any} context
         */
        meet(context){
            const record = bound.get(context);
            if (!record)
            {
                return;
            }
            const frame = context.framebuffer;
            const selected = gdi.bitmapSurface(record.hdc);
            if (!selected || !frame?.bytes || frame.bytes.length === 0)
            {
                return;
            }
            if (!same(frame.bytes, record.synced))
            {
                store(frame, selected.surface, record);
            }
            else if (selected.bitmap !== record.bitmap
                || !same(selected.surface.bytes, record.seen))
            {
                // Another bitmap selected, or the program wrote the pixels
                // itself: the bitmap is the colour buffer, read in.
                load(frame, selected.surface, record);
            }
            else
            {
                return;
            }
            record.bitmap = selected.bitmap;
            record.synced = frame.bytes.slice();
            record.seen = selected.surface.bytes.slice();
        },

        /** @param {any} context @returns {boolean} whether it is on a memory DC */
        has: context=>bound.has(context),
    };
}
