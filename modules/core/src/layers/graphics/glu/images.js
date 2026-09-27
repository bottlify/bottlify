/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU's image calls: gluScaleImage, and the mipmap builders, which scale an
 * image to powers of two that fit the implementation and hand GL each level
 * down to one texel.
 *
 * An image is read as GL reads one -- the format and type the program names,
 * under the unpack state of the current context -- into RGBA of 8 bits, and
 * resampled there: each texel of the result the average of the source it
 * covers, weighted by how much of each source texel it covers. That is a box
 * filter when it shrinks by two, which is how every level after the first is
 * made. gluScaleImage writes its result back in the format and type asked
 * for, under the pack state; the builders hand GL each level as RGBA bytes,
 * with the unpack state set to tight rows for the call and put back after,
 * so a program's own pixel store settings are what it left.
 */

import { GL } from '../opengl/constants.js';
import { imageBytes, rowLayout, unpackImage } from '../opengl/texture.js';
import { packImage } from '../opengl/context-pixels.js';
import { GLU } from './quadric.js';

/**
 * RGBA texels resampled from one size to another, each output texel the
 * coverage-weighted average of the input texels under it.
 *
 * @param {Uint8Array} texels @param {number} width @param {number} height
 * @param {number} toWidth @param {number} toHeight
 * @returns {Uint8Array}
 */
export function resample(texels, width, height, toWidth, toHeight){
    if (width === toWidth && height === toHeight)
    {
        return texels.slice();
    }
    const out = new Uint8Array(toWidth * toHeight * 4);
    const sx = width / toWidth;
    const sy = height / toHeight;
    const sum = [0, 0, 0, 0];
    for (let y = 0; y < toHeight; y++)
    {
        const y0 = y * sy;
        const y1 = y0 + sy;
        for (let x = 0; x < toWidth; x++)
        {
            const x0 = x * sx;
            const x1 = x0 + sx;
            sum.fill(0);
            let weight = 0;
            for (let iy = Math.floor(y0); iy < Math.min(height, Math.ceil(y1)); iy++)
            {
                const wy = Math.min(y1, iy + 1) - Math.max(y0, iy);
                for (let ix = Math.floor(x0); ix < Math.min(width, Math.ceil(x1)); ix++)
                {
                    const w = wy * (Math.min(x1, ix + 1) - Math.max(x0, ix));
                    const at = (iy * width + ix) * 4;
                    for (let c = 0; c < 4; c++)
                    {
                        sum[c] += texels[at + c] * w;
                    }
                    weight += w;
                }
            }
            const at = (y * toWidth + x) * 4;
            for (let c = 0; c < 4; c++)
            {
                out[at + c] = weight > 0 ? Math.round(sum[c] / weight) : 0;
            }
        }
    }
    return out;
}

/** The power of two nearest a size, a tie going up. @param {number} size */
export function nearestPower(size){
    let power = 1;
    while (power * 2 <= size)
    {
        power *= 2;
    }
    return size - power >= power * 2 - size ? power * 2 : power;
}

/**
 * @typedef {Object} ImageHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** The unpack state's fields, and what a tight layout sets them to. */
const UNPACK = /** @type {const} */ ([
    [GL.UNPACK_ALIGNMENT, 1], [GL.UNPACK_ROW_LENGTH, 0], [GL.UNPACK_SKIP_ROWS, 0],
    [GL.UNPACK_SKIP_PIXELS, 0], [GL.UNPACK_SWAP_BYTES, 0],
]);

/** A pixel store value of the context, or GL's default without one. @param {any} context @param {number} query @param {number} fallback */
const store = (context, query, fallback)=>(context?.glGetIntegerv(query)?.[0] ?? fallback);

/** @param {any} context */
const unpackOf = context=>({
    alignment: store(context, GL.UNPACK_ALIGNMENT, 4),
    rowLength: store(context, GL.UNPACK_ROW_LENGTH, 0),
    skipRows: store(context, GL.UNPACK_SKIP_ROWS, 0),
    skipPixels: store(context, GL.UNPACK_SKIP_PIXELS, 0),
    swapBytes: store(context, GL.UNPACK_SWAP_BYTES, 0) !== 0,
});

/** @param {any} context */
const packOf = context=>({
    alignment: store(context, GL.PACK_ALIGNMENT, 4),
    rowLength: store(context, GL.PACK_ROW_LENGTH, 0),
    skipRows: store(context, GL.PACK_SKIP_ROWS, 0),
    skipPixels: store(context, GL.PACK_SKIP_PIXELS, 0),
    swapBytes: false,
});

/**
 * @param {ImageHost} host
 */
export function createImages(host){
    /**
     * A guest image as RGBA texels, or the GLU error that refuses it.
     *
     * @param {any} context @param {number} address @param {number} width @param {number} height
     * @param {number} format @param {number} type
     * @returns {Uint8Array | number}
     */
    const read = (context, address, width, height, format, type)=>{
        const unpack = unpackOf(context);
        const needed = imageBytes(width, height, format, type, unpack);
        if (needed === 0)
        {
            return GLU.INVALID_ENUM;
        }
        const texels = unpackImage(host.readMemory(address >>> 0, needed), width, height, format,
            type, unpack);
        return texels ?? GLU.INVALID_ENUM;
    };

    /**
     * Each level from `level` down to one texel, the ones in [base, max]
     * handed to GL, with a tight unpack layout for the calls.
     *
     * @param {any} context
     * @param {(level: number, width: number, height: number, bytes: Uint8Array) => void} upload
     * @param {Uint8Array} texels @param {number} width @param {number} height
     * @param {number} level @param {number} base @param {number} max
     */
    const levels = (context, upload, texels, width, height, level, base, max)=>{
        const saved = UNPACK.map(([query])=>store(context, query, 0));
        for (const [query, value] of UNPACK)
        {
            context.glPixelStorei(query, value);
        }
        let image = texels;
        let w = width;
        let h = height;
        for (let at = level; at <= max; at++)
        {
            if (at >= base)
            {
                upload(at, w, h, image);
            }
            if (w === 1 && h === 1)
            {
                break;
            }
            const nw = Math.max(1, w >> 1);
            const nh = Math.max(1, h >> 1);
            image = resample(image, w, h, nw, nh);
            w = nw;
            h = nh;
        }
        UNPACK.forEach(([query], i)=>context.glPixelStorei(query, saved[i]));
    };

    /** How large a level zero this context takes. @param {any} context */
    const largest = context=>Math.max(1, store(context, GL.MAX_TEXTURE_SIZE, 1024));

    /**
     * gluBuild2DMipmaps, and gluBuild1DMipmaps as its one row.
     *
     * @param {any} context @param {number} target @param {number} internal
     * @param {number} width @param {number} height @param {number} format @param {number} type
     * @param {number} data @param {boolean} oneD
     */
    const build = (context, target, internal, width, height, format, type, data, oneD)=>{
        if (width < 1 || height < 1)
        {
            return GLU.INVALID_VALUE;
        }
        const texels = read(context, data, width, height, format, type);
        if (typeof texels === 'number')
        {
            return texels;
        }
        const limit = largest(context);
        let w = Math.min(nearestPower(width), limit);
        let h = oneD ? 1 : Math.min(nearestPower(height), limit);
        while (w > limit)
        {
            w >>= 1;
        }
        while (h > limit)
        {
            h >>= 1;
        }
        const top = resample(texels, width, height, w, h);
        levels(context, (level, lw, lh, bytes)=>(oneD
            ? context.glTexImage1D(target, level, internal, lw, 0, GL.RGBA, GL.UNSIGNED_BYTE,
                bytes)
            : context.glTexImage2D(target, level, internal, lw, lh, 0, GL.RGBA, GL.UNSIGNED_BYTE,
                bytes)), top, w, h, 0, 0, 1000);
        return 0;
    };

    /**
     * gluBuild2DMipmapLevels and gluBuild1DMipmapLevels: an image that is
     * already level `level`, a power of two on each side, its levels from
     * there down, of which [base, max] reach GL.
     *
     * @param {any} context @param {number} target @param {number} internal
     * @param {number} width @param {number} height @param {number} format @param {number} type
     * @param {number} level @param {number} base @param {number} max @param {number} data
     * @param {boolean} oneD
     */
    const buildLevels = (context, target, internal, width, height, format, type, level, base, max,
        data, oneD)=>
    {
        const power = (/** @type {number} */ n)=>n > 0 && (n & (n - 1)) === 0;
        if (width < 1 || height < 1 || !power(width) || !power(height) || level < 0
            || base < level || max < base)
        {
            return GLU.INVALID_VALUE;
        }
        const texels = read(context, data, width, height, format, type);
        if (typeof texels === 'number')
        {
            return texels;
        }
        levels(context, (at, lw, lh, bytes)=>(oneD
            ? context.glTexImage1D(target, at, internal, lw, 0, GL.RGBA, GL.UNSIGNED_BYTE, bytes)
            : context.glTexImage2D(target, at, internal, lw, lh, 0, GL.RGBA, GL.UNSIGNED_BYTE,
                bytes)), texels, width, height, level, base, max);
        return 0;
    };

    return {
        build,
        buildLevels,

        /**
         * gluScaleImage: read under the unpack state, resampled, written
         * under the pack state -- the rows only, so what the skips pass over
         * is left as it was.
         *
         * @param {any} context @param {number[]} args
         */
        scale(context, [format, widthIn, heightIn, typeIn, dataIn, widthOut, heightOut, typeOut,
            dataOut])
        {
            if ((widthIn | 0) < 0 || (heightIn | 0) < 0 || (widthOut | 0) < 0
                || (heightOut | 0) < 0)
            {
                return GLU.INVALID_VALUE;
            }
            if (widthIn === 0 || heightIn === 0 || widthOut === 0 || heightOut === 0)
            {
                return 0;
            }
            const texels = read(context, dataIn, widthIn, heightIn, format, typeIn);
            if (typeof texels === 'number')
            {
                return texels;
            }
            const scaled = resample(texels, widthIn, heightIn, widthOut, heightOut);
            const pack = packOf(context);
            const tight = { ...pack, skipRows: 0, skipPixels: 0 };
            const packed = packImage(scaled, widthOut, heightOut, format, typeOut, tight);
            const layout = rowLayout(widthOut, format, typeOut, pack);
            if (!packed || !layout)
            {
                return GLU.INVALID_ENUM;
            }
            const row = widthOut * layout.pixelBytes;
            for (let y = 0; y < heightOut; y++)
            {
                host.writeMemory((dataOut >>> 0) + (pack.skipRows + y) * layout.stride
                    + pack.skipPixels * layout.pixelBytes,
                packed.subarray(y * layout.stride, y * layout.stride + row));
            }
            return 0;
        },
    };
}
