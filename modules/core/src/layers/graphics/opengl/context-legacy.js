/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compatibility profile's oldest state: the polygon stipple, the pixel
 * maps and pixel transfer, and the evaluators, with 4.5's getters of them
 * bounded by the caller's size (`glGetn*`).
 *
 * - **The stipple is a discard by window position.** Its 32 rows are kept
 *   as words, bit x the pattern's column x, row 0 the bottom one; a draw of
 *   filled primitives under it carries the words in its key and its fragment
 *   stage discards what the pattern leaves out (`wgsl.js` `stippled`), and
 *   the processor's rasteriser skips the same fragments.
 * - **Pixel transfer maps 8-bit colour.** Scale, bias and GL_MAP_COLOR are
 *   applied where an image is RGBA bytes: what glDrawPixels and a texture
 *   upload unpack, what glCopyPixels and a copy into a texture read from the
 *   processor's framebuffer, and what glReadPixels and glGetTexImage read
 *   before it is packed; a sized format's own bytes and a copy the device
 *   makes skip it and say so (`transferSkipped`, decision A215). The
 *   stencil and index maps and shifts and the depth scale and bias are kept
 *   and answered and reach nothing: no transfer here carries indices,
 *   stencil or depth through them, and setting one says so.
 * - **Evaluators run here, on the processor,** into the immediate mode's
 *   calls, as a driver's software path runs them: an evaluated vertex is a
 *   glVertex with the evaluated colour, index, normal and coordinates as the
 *   current values for that vertex alone (the current values themselves are
 *   left as they were, OpenGL 2.1 section 5.1).
 * - **The imaging subset is not here** (GL_ARB_imaging is not reported):
 *   its getters refuse their target as a context without the subset does.
 */

import { GL } from './constants.js';
import {
    INDEX_MAPS, INDEX_VALUED, LEGACY, MAP_TARGETS, PIXEL_MAPS, TRANSFER_STATE, mapComponents,
} from './legacy-state.js';

/** The getters of this file, which a display list does not record. */
export const LEGACY_CALLS_NOT_COMPILED = Object.freeze([
    'glGetMapfv', 'glGetMapdv', 'glGetMapiv', 'glGetnMapfv', 'glGetnMapdv', 'glGetnMapiv',
    'glGetPixelMapfv', 'glGetPixelMapuiv', 'glGetPixelMapusv', 'glGetnPixelMapfv',
    'glGetnPixelMapuiv', 'glGetnPixelMapusv', 'glGetPolygonStipple', 'glGetnPolygonStipple',
    'glGetImagingTable',
]);

/** The calls of this file a glBegin leaves allowed (OpenGL 2.1 section 2.6.3). */
export const LEGACY_CALLS_IN_BEGIN = Object.freeze([
    'glEvalCoord1f', 'glEvalCoord2f', 'glEvalPoint1', 'glEvalPoint2',
]);

/**
 * A bitmap's layout under a pixel store state: bytes a row and in all, as
 * glBitmap and glPolygonStipple read one (OpenGL 2.1 section 3.6.4).
 *
 * @typedef {{ alignment: number, rowLength: number, skipRows: number, skipPixels: number,
 *     lsbFirst: boolean }} BitmapStore
 */

/**
 * @param {number} width @param {number} height @param {BitmapStore} store
 * @returns {{ stride: number, bytes: number }}
 */
export function bitmapLayout(width, height, store){
    const groups = store.rowLength > 0 ? store.rowLength : width;
    const alignment = Math.max(1, store.alignment);
    const stride = Math.ceil(Math.ceil(groups / 8) / alignment) * alignment;
    return { stride, bytes: width <= 0 || height <= 0 ? 0
        : (store.skipRows + height - 1) * stride + Math.ceil((store.skipPixels + width) / 8) };
}

/**
 * Where a bitmap's pixel lies: its byte and the bit in it.
 *
 * @param {number} x @param {number} y @param {number} stride @param {BitmapStore} store
 * @returns {[number, number]}
 */
function bitAt(x, y, stride, store){
    const index = store.skipPixels + x;
    return [(store.skipRows + y) * stride + (index >> 3),
        store.lsbFirst ? 1 << (index & 7) : 0x80 >> (index & 7)];
}

/**
 * A 32 by 32 pattern read as a bitmap: a word a row from the bottom one,
 * bit x its column x.
 *
 * @param {Uint8Array} bytes @param {BitmapStore} store
 * @returns {Uint32Array}
 */
export function readPattern(bytes, store){
    const { stride } = bitmapLayout(32, 32, store);
    const words = new Uint32Array(32);
    for (let y = 0; y < 32; y++)
    {
        let word = 0;
        for (let x = 0; x < 32; x++)
        {
            const [at, mask] = bitAt(x, y, stride, store);
            if ((bytes[at] & mask) !== 0)
            {
                word |= 1 << x;
            }
        }
        words[y] = word >>> 0;
    }
    return words;
}

/**
 * The pattern written over `bytes` as a bitmap, leaving the bits outside it
 * as they were.
 *
 * @param {Uint32Array} words @param {Uint8Array} bytes @param {BitmapStore} store
 */
export function writePattern(words, bytes, store){
    const { stride } = bitmapLayout(32, 32, store);
    for (let y = 0; y < 32; y++)
    {
        for (let x = 0; x < 32; x++)
        {
            const [at, mask] = bitAt(x, y, stride, store);
            bytes[at] = ((words[y] >>> x) & 1) !== 0 ? bytes[at] | mask : bytes[at] & ~mask;
        }
    }
}

/**
 * The stipple pattern's key: its words in hex, the bottom row first. Made
 * once a pattern, not once a draw.
 *
 * @param {Uint32Array} words
 * @returns {string}
 */
export function patternKey(words){
    let key = '';
    for (const word of words)
    {
        key += word.toString(16).padStart(8, '0');
    }
    return key;
}

/** The stipple every context starts with: every fragment drawn. */
const SOLID = Object.freeze({ words: new Uint32Array(32).fill(0xffffffff),
    key: 'f'.repeat(256) });


/**
 * The Bernstein weights of degree `n` at `t`, and their derivatives in t.
 *
 * @param {number} n @param {number} t
 * @returns {{ weights: number[], slopes: number[] }}
 */
export function bernstein(n, t){
    /** @param {number} degree @param {number} i */
    const basis = (degree, i)=>{
        if (i < 0 || i > degree)
        {
            return 0;
        }
        let binomial = 1;
        for (let k = 1; k <= i; k++)
        {
            binomial = binomial * (degree - i + k) / k;
        }
        return binomial * t ** i * (1 - t) ** (degree - i);
    };
    const weights = [];
    const slopes = [];
    for (let i = 0; i <= n; i++)
    {
        weights.push(basis(n, i));
        slopes.push(n === 0 ? 0 : n * (basis(n - 1, i - 1) - basis(n - 1, i)));
    }
    return { weights, slopes };
}

/**
 * @typedef {Object} EvaluatorMap
 * @property {number[]} order  one order, or the u and v ones
 * @property {number[]} domain  u1, u2, and v1, v2 for a surface
 * @property {number[]} points  the control points packed, u the outer index
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installLegacyCalls(context, kernel){
    const { enter, setError, record, setState, diverge } = kernel;
    const on = (/** @type {number} */ cap)=>record(cap).values[0] !== 0;

    // --- what the context keeps ---

    /** @type {{ words: Uint32Array, key: string }} */
    let stipple = SOLID;
    /** @type {Map<number, number[]>} */
    const pixelMaps = new Map(PIXEL_MAPS.map(map=>[map, [0]]));
    /** @type {Map<number, EvaluatorMap>} */
    const maps = new Map(MAP_TARGETS.flatMap(([target, , point])=>[
        [target, { order: [1], domain: [0, 1], points: [...point] }],
        [target + LEGACY.MAP2, { order: [1, 1], domain: [0, 1, 0, 1], points: [...point] }],
    ]));

    // The stipple is GL_POLYGON_STIPPLE_BIT's; the rest of that group, the
    // enable, is a record.
    (kernel.side.attribSavers ??= []).push({
        /** @param {number} mask */
        save: mask=>((mask & GL.POLYGON_STIPPLE_BIT) !== 0 ? stipple : null),
        /** @param {{ words: Uint32Array, key: string } | null} kept */
        restore: kept=>{
            if (kept)
            {
                stipple = kept;
            }
        },
    });

    Object.assign(kernel.side, {
        /** The stipple a draw of filled primitives is cut by, or null when it is off. */
        polygonStipple: ()=>(on(GL.POLYGON_STIPPLE) ? stipple : null),
        pixelTransfer,
        /**
         * Says that `what` passed by the pixel transfer set: a path whose
         * pixels are never RGBA bytes here (a sized format's own, or a copy
         * the device makes). Nothing while the transfer changes nothing.
         *
         * @param {string} what
         */
        transferSkipped: what=>{
            if (pixelTransfer())
            {
                diverge(`${what} was made without the pixel transfer set (scale, bias,`
                    + ' GL_MAP_COLOR): it is applied only where pixels are 8-bit RGBA here');
            }
        },
    });

    // --- guest memory and the pixel buffers ---

    /** @param {boolean} pack @returns {BitmapStore} */
    const bitmapStore = pack=>(pack ? {
        alignment: record(GL.PACK_ALIGNMENT).values[0],
        rowLength: record(GL.PACK_ROW_LENGTH).values[0],
        skipRows: record(GL.PACK_SKIP_ROWS).values[0],
        skipPixels: record(GL.PACK_SKIP_PIXELS).values[0],
        lsbFirst: record(GL.PACK_LSB_FIRST).values[0] !== 0,
    } : {
        alignment: record(GL.UNPACK_ALIGNMENT).values[0],
        rowLength: record(GL.UNPACK_ROW_LENGTH).values[0],
        skipRows: record(GL.UNPACK_SKIP_ROWS).values[0],
        skipPixels: record(GL.UNPACK_SKIP_PIXELS).values[0],
        lsbFirst: record(GL.UNPACK_LSB_FIRST).values[0] !== 0,
    });

    /**
     * The buffer bound for packing or unpacking, when one is: the program's
     * pointer is then an offset into it, and a range past its end or a store
     * mapped apart from GL is refused (OpenGL 2.1 section 4.3.5).
     *
     * @param {boolean} pack @param {number} offset @param {number} length
     * @returns {import('./objects.js').BufferObject | null | false} false when refused
     */
    const pixelBuffer = (pack, offset, length)=>{
        const name = record(pack ? GL.PIXEL_PACK_BUFFER_BINDING : GL.PIXEL_UNPACK_BUFFER_BINDING)
            .values[0];
        if (name === 0)
        {
            return null;
        }
        const buffer = kernel.shareGroup().buffers.objects.get(name);
        if (!buffer || offset < 0 || offset + length > buffer.size
            || (buffer.mapped !== 0 && (buffer.accessFlags & GL.MAP_PERSISTENT_BIT) === 0))
        {
            setError(GL.INVALID_OPERATION);
            return false;
        }
        return buffer;
    };

    /**
     * What a call unpacks from: the bound buffer's bytes or the guest's.
     *
     * @param {number} address @param {number} length
     * @returns {Uint8Array | null} null when refused or there is nothing to read
     */
    const unpackSource = (address, length)=>{
        const buffer = pixelBuffer(false, address, length);
        if (buffer === false)
        {
            return null;
        }
        if (buffer)
        {
            return buffer.data.slice(address, address + length);
        }
        const memory = kernel.memory();
        return memory && address !== 0 ? memory.read(address, length) : null;
    };

    /**
     * Where a call packs to: the checks first, so that a refusal writes
     * nothing; `fill` is handed what lies there now and writes over it.
     *
     * @param {number} address @param {number} length
     * @param {(bytes: Uint8Array) => void} fill
     */
    const packInto = (address, length, fill)=>{
        const buffer = pixelBuffer(true, address, length);
        if (buffer === false || length === 0)
        {
            return;
        }
        if (buffer)
        {
            const bytes = buffer.data.slice(address, address + length);
            fill(bytes);
            kernel.side.storeIntoBuffer(buffer, address, bytes);
            return;
        }
        const memory = kernel.memory();
        if (!memory || address === 0)
        {
            return;
        }
        const bytes = memory.read(address, length);
        fill(bytes);
        memory.write(address, bytes);
    };

    /**
     * Writes typed values to guest memory, as a getter of maps answers.
     *
     * @param {number} address @param {readonly number[]} values
     * @param {'f' | 'd' | 'i' | 'ui' | 'us'} type
     */
    const writeValues = (address, values, type)=>{
        const size = type === 'd' ? 8 : type === 'us' ? 2 : 4;
        packInto(address, values.length * size, bytes=>{
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            values.forEach((value, k)=>{
                if (type === 'f')
                {
                    view.setFloat32(k * size, value, true);
                }
                else if (type === 'd')
                {
                    view.setFloat64(k * size, value, true);
                }
                else if (type === 'us')
                {
                    view.setUint16(k * size, value, true);
                }
                else
                {
                    view.setUint32(k * size, value >>> 0, true);
                }
            });
        });
    };

    // --- pixel transfer ---

    /**
     * The colour transfer as an 8-bit table a channel, or null while it
     * changes nothing: scale and bias, then the R_TO_R..A_TO_A maps under
     * GL_MAP_COLOR, each looked up at the rounded index (2.1 section 3.6.5).
     *
     * @returns {((texels: Uint8Array) => void) | null}
     */
    function pixelTransfer(){
        const mapping = on(LEGACY.MAP_COLOR);
        const scales = [LEGACY.RED_SCALE, LEGACY.GREEN_SCALE, LEGACY.BLUE_SCALE,
            LEGACY.ALPHA_SCALE].map(query=>record(query).values[0]);
        const biases = [LEGACY.RED_BIAS, LEGACY.GREEN_BIAS, LEGACY.BLUE_BIAS,
            LEGACY.ALPHA_BIAS].map(query=>record(query).values[0]);
        if (!mapping && scales.every(scale=>scale === 1) && biases.every(bias=>bias === 0))
        {
            return null;
        }
        const tables = [0, 1, 2, 3].map(channel=>{
            const table = new Uint8Array(256);
            const map = pixelMaps.get(LEGACY.PIXEL_MAP_R_TO_R + channel) ?? [0];
            for (let byte = 0; byte < 256; byte++)
            {
                let value = Math.min(1, Math.max(0,
                    byte / 255 * scales[channel] + biases[channel]));
                if (mapping)
                {
                    value = Math.min(1, Math.max(0, map[Math.round(value * (map.length - 1))]));
                }
                table[byte] = Math.round(value * 255);
            }
            return table;
        });
        return texels=>{
            for (let at = 0; at < texels.length; at += 4)
            {
                texels[at] = tables[0][texels[at]];
                texels[at + 1] = tables[1][texels[at + 1]];
                texels[at + 2] = tables[2][texels[at + 2]];
                texels[at + 3] = tables[3][texels[at + 3]];
            }
        };
    }

    /** What glPixelTransfer takes, and how a value of it is kept. */
    const TRANSFER_KINDS = new Map(TRANSFER_STATE.map(entry=>[entry.query, entry.kind]));

    // --- evaluation ---

    /**
     * A map's value at a domain point, and its derivatives in u and v (of
     * the unit domain), packed by component.
     *
     * @param {EvaluatorMap} map @param {number} k @param {number} u @param {number} v
     * @returns {{ value: number[], du: number[], dv: number[] }}
     */
    const evaluate = (map, k, u, v)=>{
        const surface = map.order.length === 2;
        const bu = bernstein(map.order[0] - 1,
            (u - map.domain[0]) / (map.domain[1] - map.domain[0]));
        const bv = surface
            ? bernstein(map.order[1] - 1, (v - map.domain[2]) / (map.domain[3] - map.domain[2]))
            : { weights: [1], slopes: [0] };
        const value = new Array(k).fill(0);
        const du = new Array(k).fill(0);
        const dv = new Array(k).fill(0);
        const vOrder = surface ? map.order[1] : 1;
        for (let i = 0; i < map.order[0]; i++)
        {
            for (let j = 0; j < vOrder; j++)
            {
                const at = (i * vOrder + j) * k;
                for (let c = 0; c < k; c++)
                {
                    const point = map.points[at + c];
                    value[c] += bu.weights[i] * bv.weights[j] * point;
                    du[c] += bu.slopes[i] * bv.weights[j] * point;
                    dv[c] += bu.weights[i] * bv.slopes[j] * point;
                }
            }
        }
        return { value, du, dv };
    };

    /**
     * One evaluated vertex: the enabled maps of one dimension at (u, v), as
     * the immediate mode's calls, the current values put back after (2.1
     * section 5.1). Nothing is made without a vertex map.
     *
     * @param {boolean} surface @param {number} u @param {number} v
     */
    const evaluateVertex = (surface, u, v)=>{
        const offset = surface ? LEGACY.MAP2 : 0;
        const vertexTarget = on(LEGACY.MAP1_VERTEX_4 + offset) ? LEGACY.MAP1_VERTEX_4 + offset
            : on(LEGACY.MAP1_VERTEX_3 + offset) ? LEGACY.MAP1_VERTEX_3 + offset : 0;
        if (vertexTarget === 0)
        {
            return;
        }
        /** @param {number} target */
        const at = target=>evaluate(/** @type {EvaluatorMap} */ (maps.get(target)),
            mapComponents(target), u, v);
        const saved = {
            colour: [...record(GL.CURRENT_COLOR).values],
            index: [...record(GL.CURRENT_INDEX).values],
            normal: [...record(GL.CURRENT_NORMAL).values],
            texCoord: kernel.side.texCoords[0],
        };
        kernel.executed(()=>{
            if (on(LEGACY.MAP1_INDEX + offset))
            {
                setState(GL.CURRENT_INDEX, [at(LEGACY.MAP1_INDEX + offset).value[0]]);
            }
            if (on(LEGACY.MAP1_COLOR_4 + offset))
            {
                const [r, g, b, a] = at(LEGACY.MAP1_COLOR_4 + offset).value;
                context.glColor4f(r, g, b, a);
            }
            const position = at(vertexTarget);
            if (surface && on(GL.AUTO_NORMAL))
            {
                context.glNormal3f(...analyticNormal(position, vertexTarget === LEGACY.MAP2
                    + LEGACY.MAP1_VERTEX_4));
            }
            else if (on(LEGACY.MAP1_NORMAL + offset))
            {
                const [x, y, z] = at(LEGACY.MAP1_NORMAL + offset).value;
                context.glNormal3f(x, y, z);
            }
            // The map of the most coordinates, where several are on.
            for (let size = 4; size >= 1; size--)
            {
                const target = LEGACY.MAP1_TEXTURE_COORD_1 + size - 1 + offset;
                if (on(target))
                {
                    const value = at(target).value;
                    context.glTexCoord4f(value[0], value[1] ?? 0, value[2] ?? 0,
                        value[3] ?? 1);
                    break;
                }
            }
            const [x, y, z, w] = position.value;
            context.glVertex4f(x, y, z, w ?? 1);
        });
        setState(GL.CURRENT_COLOR, saved.colour);
        setState(GL.CURRENT_INDEX, saved.index);
        setState(GL.CURRENT_NORMAL, saved.normal);
        kernel.side.texCoords[0] = saved.texCoord;
    };

    /**
     * GL_AUTO_NORMAL's normal: the cross product of the position's partial
     * derivatives, of the projected position for a four-component one, made
     * unit length.
     *
     * @param {{ value: number[], du: number[], dv: number[] }} position
     * @param {boolean} homogeneous
     * @returns {[number, number, number]}
     */
    const analyticNormal = (position, homogeneous)=>{
        let { du, dv } = position;
        if (homogeneous)
        {
            const [x, y, z, w] = position.value;
            // d(p/w) is (dp w - p dw) / w^2; the scale goes with the normalising.
            du = [du[0] * w - x * du[3], du[1] * w - y * du[3], du[2] * w - z * du[3]];
            dv = [dv[0] * w - x * dv[3], dv[1] * w - y * dv[3], dv[2] * w - z * dv[3]];
        }
        const n = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2],
            du[0] * dv[1] - du[1] * dv[0]];
        const length = Math.hypot(n[0], n[1], n[2]);
        return length === 0 ? [n[0], n[1], n[2]]
            : [n[0] / length, n[1] / length, n[2] / length];
    };

    /**
     * A grid's domain point: exactly an end at the grid's ends (2.1 section
     * 5.1).
     *
     * @param {number} i @param {number} n @param {number} from @param {number} to
     */
    const gridPoint = (i, n, from, to)=>(i === 0 ? from
        : i === n ? to : from + i * (to - from) / n);

    /** @param {number} i @returns {number} */
    const gridU1 = i=>{
        const [from, to] = record(LEGACY.MAP1_GRID_DOMAIN).values;
        return gridPoint(i, record(LEGACY.MAP1_GRID_SEGMENTS).values[0], from, to);
    };

    /** @param {number} i @param {number} j @returns {[number, number]} */
    const gridUV = (i, j)=>{
        const [u1, u2, v1, v2] = record(LEGACY.MAP2_GRID_DOMAIN).values;
        const [nu, nv] = record(LEGACY.MAP2_GRID_SEGMENTS).values;
        return [gridPoint(i, nu, u1, u2), gridPoint(j, nv, v1, v2)];
    };

    /**
     * A map's checks and its control points kept: glMap1 and glMap2.
     *
     * @param {number} target @param {number[]} order @param {number[]} domain
     * @param {number[]} strides @param {readonly number[] | null} points  packed, u outer
     */
    const defineMap = (target, order, domain, strides, points)=>{
        const surface = order.length === 2;
        const limit = record(GL.MAX_EVAL_ORDER).values[0];
        if (domain[0] === domain[1] || (surface && domain[2] === domain[3])
            || order.some(n=>n < 1 || n > limit) || !points)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const k = mapComponents(target);
        if (k === 0 || (target >= LEGACY.MAP1_COLOR_4 + LEGACY.MAP2) !== surface)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (strides.some(stride=>stride < k))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (record(GL.ACTIVE_TEXTURE).values[0] !== GL.TEXTURE0)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const count = order.reduce((a, b)=>a * b, 1) * k;
        maps.set(target, { order: [...order], domain: [...domain],
            points: Array.from({ length: count }, (_, at)=>points[at] ?? 0) });
    };

    /**
     * glGetMap's answer, or null when refused.
     *
     * @param {number} target @param {number} query
     * @returns {number[] | null}
     */
    const mapAnswer = (target, query)=>{
        const map = maps.get(target);
        if (!map)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        switch (query)
        {
            case LEGACY.COEFF:
                return [...map.points];
            case LEGACY.ORDER:
                return [...map.order];
            case LEGACY.DOMAIN:
                return [...map.domain];
            default:
                setError(GL.INVALID_ENUM);
                return null;
        }
    };

    /**
     * A pixel map's entries as the getter of `type` answers them: colour
     * components scaled to the integer's range, indices as they are.
     *
     * @param {number} map @param {number} value @param {'f' | 'ui' | 'us'} type
     */
    const mapEntryAs = (map, value, type)=>{
        if (type === 'f')
        {
            return value;
        }
        if (INDEX_VALUED.has(map))
        {
            return type === 'us' ? Math.min(0xffff, Math.max(0, Math.trunc(value)))
                : Math.trunc(value);
        }
        return Math.round(value * (type === 'us' ? 0xffff : 0xffffffff));
    };

    Object.assign(context, {
        // --- the polygon stipple ---

        /**
         * glPolygonStipple: a 32 by 32 bitmap through the unpack state, or
         * the words a display list kept of one.
         *
         * @param {number | Uint32Array} source  an address or offset, or the words
         */
        glPolygonStipple(source){
            let words = source instanceof Uint32Array ? source : null;
            if (words === null)
            {
                const store = bitmapStore(false);
                const bytes = unpackSource(/** @type {number} */ (source),
                    bitmapLayout(32, 32, store).bytes);
                if (!bytes)
                {
                    // A refused buffer range says so itself; a null pointer reads nothing.
                    return;
                }
                words = readPattern(bytes, store);
            }
            if (enter('glPolygonStipple', [words]))
            {
                stipple = { words: words.slice(), key: patternKey(words) };
            }
        },

        /**
         * glGetPolygonStipple, and glGetnPolygonStipple (4.5) when `size` is
         * a number: refused when the bitmap would not fit it.
         *
         * @param {number} address @param {number | null} size
         */
        glGetPolygonStipple(address, size){
            if (!enter(size === null ? 'glGetPolygonStipple' : 'glGetnPolygonStipple',
                [address, size]))
            {
                return;
            }
            const store = bitmapStore(true);
            const { bytes } = bitmapLayout(32, 32, store);
            if (size !== null && bytes > size)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            packInto(address, bytes, into=>writePattern(stipple.words, into, store));
        },

        // --- pixel transfer and the pixel maps ---

        /**
         * glPixelTransferf and glPixelTransferi.
         *
         * @param {number} pname @param {number} value
         */
        glPixelTransferf(pname, value){
            if (!enter('glPixelTransferf', [pname, value]))
            {
                return;
            }
            const kind = TRANSFER_KINDS.get(pname);
            if (!kind)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const kept = kind === 'bool' ? (value !== 0 ? 1 : 0)
                : kind === 'int' ? Math.trunc(value) : value;
            setState(pname, [kept]);
            if ((pname === LEGACY.MAP_STENCIL && kept !== 0)
                || ((pname === LEGACY.INDEX_SHIFT || pname === LEGACY.INDEX_OFFSET) && kept !== 0)
                || (pname === LEGACY.DEPTH_SCALE && kept !== 1)
                || (pname === LEGACY.DEPTH_BIAS && kept !== 0))
            {
                diverge('a pixel transfer of indices, stencil or depth was set and is applied'
                    + ' to nothing: only colour is transferred through scale, bias and maps');
            }
        },

        /**
         * glPixelMapfv, glPixelMapuiv and glPixelMapusv: `size` entries of
         * `type` from the address (or the unpack buffer), kept as floats.
         * A display list keeps them converted, as glPixelMapfv's.
         *
         * @param {number} map @param {number} size
         * @param {number | readonly number[]} source  an address or offset, or the entries
         * @param {'f' | 'ui' | 'us'} type
         */
        glPixelMapfv(map, size, source, type = 'f'){
            const valid = PIXEL_MAPS.includes(map) && size >= 1
                && size <= record(GL.MAX_PIXEL_MAP_TABLE).values[0];
            /** @type {readonly number[] | null} */
            let entries = typeof source === 'number' ? null : source;
            if (entries === null && valid)
            {
                const width = type === 'us' ? 2 : 4;
                const bytes = unpackSource(/** @type {number} */ (source), size * width);
                if (!bytes)
                {
                    return;
                }
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const colour = !INDEX_VALUED.has(map);
                entries = Array.from({ length: size }, (_, k)=>(type === 'f'
                    ? view.getFloat32(k * 4, true)
                    : type === 'ui'
                        ? view.getUint32(k * 4, true) / (colour ? 0xffffffff : 1)
                        : view.getUint16(k * 2, true) / (colour ? 0xffff : 1)));
            }
            if (!enter('glPixelMapfv', [map, size, entries ?? []]))
            {
                return;
            }
            if (!PIXEL_MAPS.includes(map))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!valid || (INDEX_MAPS.has(map) && (size & (size - 1)) !== 0))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const kept = (entries ?? []).slice(0, size);
            pixelMaps.set(map, INDEX_VALUED.has(map) ? kept
                : kept.map(value=>Math.min(1, Math.max(0, value))));
            setState(map + LEGACY.PIXEL_MAP_SIZE, [size]);
        },

        /**
         * glGetPixelMapfv, uiv and usv, and their 4.5 forms bounded by `size`.
         *
         * @param {number} map @param {number} address  an address, or an offset
         *     into the pack buffer
         * @param {'f' | 'ui' | 'us'} type @param {number | null} size
         */
        glGetPixelMapfv(map, address, type, size){
            const name = `glGet${size === null ? '' : 'n'}PixelMap${type}v`;
            if (!enter(name, [map, address, type, size]))
            {
                return;
            }
            const entries = pixelMaps.get(map);
            if (!entries)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const bytes = entries.length * (type === 'us' ? 2 : 4);
            if (size !== null && bytes > size)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            writeValues(address, entries.map(value=>mapEntryAs(map, value, type)), type);
        },

        // --- the evaluators ---

        /**
         * glMap1f and glMap1d: the control points packed, `order` of them
         * with the target's components each, read by the caller at
         * `stride`.
         *
         * @param {number} target @param {number} u1 @param {number} u2 @param {number} stride
         * @param {number} order @param {readonly number[] | null} points
         */
        glMap1f(target, u1, u2, stride, order, points){
            // A list keeps the points as they were given, not the caller's array.
            const kept = points && [...points];
            if (enter('glMap1f', [target, u1, u2, stride, order, kept]))
            {
                defineMap(target, [order], [u1, u2], [stride], kept);
            }
        },

        /**
         * glMap2f and glMap2d: the control points packed u by u, each row of
         * `vorder` points with the target's components each.
         *
         * @param {number} target @param {number} u1 @param {number} u2 @param {number} ustride
         * @param {number} uorder @param {number} v1 @param {number} v2 @param {number} vstride
         * @param {number} vorder @param {readonly number[] | null} points
         */
        glMap2f(target, u1, u2, ustride, uorder, v1, v2, vstride, vorder, points){
            const kept = points && [...points];
            if (enter('glMap2f',
                [target, u1, u2, ustride, uorder, v1, v2, vstride, vorder, kept]))
            {
                defineMap(target, [uorder, vorder], [u1, u2, v1, v2], [ustride, vstride],
                    kept);
            }
        },

        /**
         * glGetMapfv, dv and iv, and their 4.5 forms bounded by `size`; an
         * integer answer is rounded.
         *
         * @param {number} target @param {number} query @param {'f' | 'd' | 'i'} type
         * @param {number} address @param {number | null} size
         */
        glGetMapfv(target, query, type, address, size){
            const name = `glGet${size === null ? '' : 'n'}Map${type}v`;
            if (!enter(name, [target, query, type, address, size]))
            {
                return;
            }
            const answer = mapAnswer(target, query);
            if (!answer)
            {
                return;
            }
            if (size !== null && answer.length * (type === 'd' ? 8 : 4) > size)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const memory = kernel.memory();
            if (!memory || address === 0)
            {
                return;
            }
            // Never through a pack buffer: the maps are not pixels.
            const bytes = new Uint8Array(answer.length * (type === 'd' ? 8 : 4));
            const view = new DataView(bytes.buffer);
            answer.forEach((value, k)=>{
                if (type === 'd')
                {
                    view.setFloat64(k * 8, value, true);
                }
                else if (type === 'f')
                {
                    view.setFloat32(k * 4, value, true);
                }
                else
                {
                    view.setInt32(k * 4, Math.round(value), true);
                }
            });
            memory.write(address, bytes);
        },

        /** @param {number} n @param {number} u1 @param {number} u2 */
        glMapGrid1f(n, u1, u2){
            if (!enter('glMapGrid1f', [n, u1, u2]))
            {
                return;
            }
            if (n < 1)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            setState(LEGACY.MAP1_GRID_DOMAIN, [u1, u2]);
            setState(LEGACY.MAP1_GRID_SEGMENTS, [n]);
        },

        /**
         * @param {number} nu @param {number} u1 @param {number} u2
         * @param {number} nv @param {number} v1 @param {number} v2
         */
        glMapGrid2f(nu, u1, u2, nv, v1, v2){
            if (!enter('glMapGrid2f', [nu, u1, u2, nv, v1, v2]))
            {
                return;
            }
            if (nu < 1 || nv < 1)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            setState(LEGACY.MAP2_GRID_DOMAIN, [u1, u2, v1, v2]);
            setState(LEGACY.MAP2_GRID_SEGMENTS, [nu, nv]);
        },

        /** glEvalCoord1f and its d and v forms. @param {number} u */
        glEvalCoord1f(u){
            if (enter('glEvalCoord1f', [u]))
            {
                evaluateVertex(false, u, 0);
            }
        },

        /** glEvalCoord2f and its d and v forms. @param {number} u @param {number} v */
        glEvalCoord2f(u, v){
            if (enter('glEvalCoord2f', [u, v]))
            {
                evaluateVertex(true, u, v);
            }
        },

        /** @param {number} i */
        glEvalPoint1(i){
            if (enter('glEvalPoint1', [i]))
            {
                evaluateVertex(false, gridU1(i), 0);
            }
        },

        /** @param {number} i @param {number} j */
        glEvalPoint2(i, j){
            if (enter('glEvalPoint2', [i, j]))
            {
                evaluateVertex(true, ...gridUV(i, j));
            }
        },

        /**
         * glEvalMesh1: points or a line strip along the grid from i1 to i2.
         *
         * @param {number} mode @param {number} i1 @param {number} i2
         */
        glEvalMesh1(mode, i1, i2){
            if (!enter('glEvalMesh1', [mode, i1, i2]))
            {
                return;
            }
            if (mode !== GL.POINT && mode !== GL.LINE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            kernel.executed(()=>{
                context.glBegin(mode === GL.POINT ? GL.POINTS : GL.LINE_STRIP);
                for (let i = i1; i <= i2; i++)
                {
                    evaluateVertex(false, gridU1(i), 0);
                }
                context.glEnd();
            });
        },

        /**
         * glEvalMesh2: points, a line strip along each row and column, or a
         * quad strip a row (2.1 section 5.1).
         *
         * @param {number} mode @param {number} i1 @param {number} i2
         * @param {number} j1 @param {number} j2
         */
        glEvalMesh2(mode, i1, i2, j1, j2){
            if (!enter('glEvalMesh2', [mode, i1, i2, j1, j2]))
            {
                return;
            }
            if (mode !== GL.POINT && mode !== GL.LINE && mode !== GL.FILL)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            /** @param {number} i @param {number} j */
            const point = (i, j)=>evaluateVertex(true, ...gridUV(i, j));
            kernel.executed(()=>{
                if (mode === GL.POINT)
                {
                    context.glBegin(GL.POINTS);
                    for (let j = j1; j <= j2; j++)
                    {
                        for (let i = i1; i <= i2; i++)
                        {
                            point(i, j);
                        }
                    }
                    context.glEnd();
                }
                else if (mode === GL.LINE)
                {
                    for (let j = j1; j <= j2; j++)
                    {
                        context.glBegin(GL.LINE_STRIP);
                        for (let i = i1; i <= i2; i++)
                        {
                            point(i, j);
                        }
                        context.glEnd();
                    }
                    for (let i = i1; i <= i2; i++)
                    {
                        context.glBegin(GL.LINE_STRIP);
                        for (let j = j1; j <= j2; j++)
                        {
                            point(i, j);
                        }
                        context.glEnd();
                    }
                }
                else
                {
                    for (let j = j1; j < j2; j++)
                    {
                        context.glBegin(GL.QUAD_STRIP);
                        for (let i = i1; i <= i2; i++)
                        {
                            point(i, j);
                            point(i, j + 1);
                        }
                        context.glEnd();
                    }
                }
            });
        },

        // --- the imaging subset ---

        /**
         * glGetColorTable, glGetConvolutionFilter, glGetSeparableFilter,
         * glGetHistogram, glGetMinmax and their 4.5 forms: every target is
         * the imaging subset's, which this context does not have.
         */
        glGetImagingTable(){
            if (enter('glGetImagingTable', []))
            {
                setError(GL.INVALID_ENUM);
            }
        },
    });
}
