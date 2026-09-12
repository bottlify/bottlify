/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pixel paths: the raster position, reading the framebuffer back, and
 * drawing pixels straight into it.
 *
 * A read goes out through the pack state the way an upload comes in through
 * the unpack state, and both count rows from the bottom, which is GL's way
 * and the opposite of the framebuffer's. A program that reads a screenshot
 * and finds it upside down has met exactly one missing flip.
 */

import { GL } from './constants.js';
import { transform } from './matrix.js';
import { readPixel, writeFragment } from './raster.js';
import { fogFactor } from './pipeline.js';

/** @type {Set<number>} */
const COLOUR_FORMATS = new Set([
    GL.RGBA, GL.RGB, GL.BGRA, GL.BGR, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.ALPHA, GL.RED,
    GL.GREEN, GL.BLUE,
]);

/** The types a read may ask for. */
const READ_TYPES = [GL.UNSIGNED_BYTE, GL.UNSIGNED_SHORT, GL.UNSIGNED_INT, GL.FLOAT];

/** The components of each readable format, as indices into r, g, b, a. */
const COMPONENTS = Object.freeze({
    [GL.RGBA]: [0, 1, 2, 3],
    [GL.RGB]: [0, 1, 2],
    [GL.BGRA]: [2, 1, 0, 3],
    [GL.BGR]: [2, 1, 0],
    [GL.LUMINANCE]: [0],
    [GL.LUMINANCE_ALPHA]: [0, 3],
    [GL.ALPHA]: [3],
    [GL.RED]: [0],
    [GL.GREEN]: [1],
    [GL.BLUE]: [2],
});

/**
 * @typedef {Object} PackState
 * @property {number} alignment
 * @property {number} rowLength
 * @property {number} skipRows
 * @property {number} skipPixels
 */

/**
 * Lays RGBA texels out as a program reads them: the format's components, in
 * the type asked for, rows padded to the pack alignment.
 *
 * @param {Uint8Array} texels  width * height RGBA, bottom row first
 * @param {number} width
 * @param {number} height
 * @param {number} format
 * @param {number} type
 * @param {PackState} pack
 * @returns {Uint8Array | null} null for a layout this does not write
 */
export function packImage(texels, width, height, format, type, pack){
    const components = /** @type {any} */ (COMPONENTS)[format];
    if (!components)
    {
        return null;
    }
    const componentBytes = type === GL.UNSIGNED_BYTE ? 1 : type === GL.UNSIGNED_SHORT ? 2
        : type === GL.UNSIGNED_INT || type === GL.FLOAT ? 4 : 0;
    if (componentBytes === 0)
    {
        return null;
    }
    const pixelBytes = components.length * componentBytes;
    const groups = pack.rowLength > 0 ? pack.rowLength : width;
    const alignment = Math.max(1, pack.alignment);
    const stride = componentBytes >= alignment
        ? groups * pixelBytes
        : Math.ceil(groups * pixelBytes / alignment) * alignment;
    const total = (pack.skipRows + height - 1) * stride + (pack.skipPixels + width) * pixelBytes;
    const out = new Uint8Array(Math.max(0, total));
    const view = new DataView(out.buffer);
    for (let y = 0; y < height; y++)
    {
        let at = (pack.skipRows + y) * stride + pack.skipPixels * pixelBytes;
        for (let x = 0; x < width; x++)
        {
            const from = (y * width + x) * 4;
            for (const component of components)
            {
                const byte = texels[from + component];
                if (componentBytes === 1)
                {
                    out[at] = byte;
                }
                else if (componentBytes === 2)
                {
                    view.setUint16(at, byte * 257, true);
                }
                else if (type === GL.FLOAT)
                {
                    view.setFloat32(at, byte / 255, true);
                }
                else
                {
                    view.setUint32(at, byte * 16843009, true);
                }
                at += componentBytes;
            }
        }
    }
    return out;
}

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installPixelCalls(context, kernel){
    const { enter, setError, record, setState, diverge } = kernel;

    /** @returns {PackState} */
    const packState = ()=>({
        alignment: record(GL.PACK_ALIGNMENT).values[0],
        rowLength: record(GL.PACK_ROW_LENGTH).values[0],
        skipRows: record(GL.PACK_SKIP_ROWS).values[0],
        skipPixels: record(GL.PACK_SKIP_PIXELS).values[0],
    });

    /**
     * Draws a block of RGBA texels at the raster position, through the
     * fragment operations, zoomed as GL_ZOOM_X and GL_ZOOM_Y say.
     *
     * @param {Uint8Array} texels  bottom row first
     * @param {number} width
     * @param {number} height
     */
    function drawTexels(texels, width, height){
        if (record(GL.CURRENT_RASTER_POSITION_VALID).values[0] === 0)
        {
            return;
        }
        const [rx, ry, rz] = record(GL.CURRENT_RASTER_POSITION).values;
        const zoomX = record(GL.ZOOM_X).values[0];
        const zoomY = record(GL.ZOOM_Y).values[0];
        const frame = kernel.framebuffer();
        const scene = kernel.side.scene();
        const box = kernel.scissorBox();
        const fog = scene.fog
            ? fogFactor(scene.fog, record(GL.CURRENT_RASTER_DISTANCE).values[0])
            : 1;
        for (let row = 0; row < height; row++)
        {
            for (let column = 0; column < width; column++)
            {
                const at = (row * width + column) * 4;
                const x0 = Math.floor(rx + column * zoomX);
                const x1 = Math.floor(rx + (column + 1) * zoomX);
                const y0 = Math.floor(ry + row * zoomY);
                const y1 = Math.floor(ry + (row + 1) * zoomY);
                let colour = [texels[at], texels[at + 1], texels[at + 2], texels[at + 3]];
                if (scene.fog)
                {
                    const fc = scene.fog.colour;
                    colour = [
                        fog * colour[0] + (1 - fog) * fc[0] * 255,
                        fog * colour[1] + (1 - fog) * fc[1] * 255,
                        fog * colour[2] + (1 - fog) * fc[2] * 255,
                        colour[3],
                    ];
                }
                if (scene.alphaTest && !context.compare(scene.alphaTest.func,
                    Math.round(colour[3]), Math.round(scene.alphaTest.reference * 255)))
                {
                    continue;
                }
                for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++)
                {
                    for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++)
                    {
                        const fy = frame.height - 1 - y;
                        if (x < box.x0 || x >= box.x1 || fy < box.y0 || fy >= box.y1
                            || x < 0 || x >= frame.width || fy < 0 || fy >= frame.height)
                        {
                            continue;
                        }
                        writeFragment(frame, x, fy, rz, colour, scene.operations);
                    }
                }
            }
        }
    }

    Object.assign(context, {
        /**
         * The raster position is a vertex that goes through the whole vertex
         * stage and stops: what it leaves behind is a window position, the
         * lit colour and a distance for fog.
         *
         * @param {number} x
         * @param {number} y
         * @param {number} z
         * @param {number} w
         */
        glRasterPos4f(x, y, z, w){
            if (!enter('glRasterPos4f', [x, y, z, w]))
            {
                return;
            }
            const eye = transform(kernel.stacks.modelview.current, [x, y, z, w]);
            const clip = transform(kernel.stacks.projection.current, eye);
            const cw = clip[3];
            const inside = cw > 0 && clip[2] >= -cw && clip[2] <= cw;
            setState(GL.CURRENT_RASTER_POSITION_VALID, [inside ? 1 : 0]);
            if (!inside)
            {
                return;
            }
            const [vx, vy, vw, vh] = record(GL.VIEWPORT).values;
            const [near, far] = record(GL.DEPTH_RANGE).values;
            setState(GL.CURRENT_RASTER_POSITION, [
                (clip[0] / cw * 0.5 + 0.5) * vw + vx,
                (clip[1] / cw * 0.5 + 0.5) * vh + vy,
                (far + near) / 2 + (far - near) / 2 * (clip[2] / cw),
                cw,
            ]);
            const vertex = kernel.currentVertex();
            const lit = kernel.side.scene().lit(vertex, eye);
            setState(GL.CURRENT_RASTER_COLOR, lit);
            setState(GL.CURRENT_RASTER_TEXTURE_COORDS, [...vertex.texCoord]);
            setState(GL.CURRENT_RASTER_DISTANCE, [Math.abs(eye[2] / (eye[3] === 0 ? 1 : eye[3]))]);
        },

        /** @param {number} x @param {number} y */
        glRasterPos2f(x, y){
            context.glRasterPos4f(x, y, 0, 1);
        },

        /** @param {number} x @param {number} y @param {number} z */
        glRasterPos3f(x, y, z){
            context.glRasterPos4f(x, y, z, 1);
        },

        /** @param {number} x @param {number} y */
        glPixelZoom(x, y){
            if (enter('glPixelZoom', [x, y]))
            {
                setState(GL.ZOOM_X, [x]);
                setState(GL.ZOOM_Y, [y]);
            }
        },

        /**
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} type
         * @returns {Uint8Array | null} the packed pixels, for the caller to
         *          write where the program asked
         */
        glReadPixels(x, y, width, height, format, type){
            if (!enter('glReadPixels', [x, y, width, height, format, type]))
            {
                return null;
            }
            if (width < 0 || height < 0)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const frame = kernel.framebuffer();
            if (format === GL.DEPTH_COMPONENT)
            {
                if (!frame.depth)
                {
                    setError(GL.INVALID_OPERATION);
                    return null;
                }
                if (!READ_TYPES.some(t=>t === type))
                {
                    setError(GL.INVALID_ENUM);
                    return null;
                }
                const texels = new Uint8Array(width * height * 4);
                for (let row = 0; row < height; row++)
                {
                    for (let column = 0; column < width; column++)
                    {
                        const fx = x + column;
                        const fy = frame.height - 1 - (y + row);
                        if (fx < 0 || fx >= frame.width || fy < 0 || fy >= frame.height)
                        {
                            continue;
                        }
                        texels[(row * width + column) * 4]
                            = Math.round(frame.depth[fy * frame.width + fx] * 255);
                    }
                }
                return packImage(texels, width, height, GL.RED, type, packState());
            }
            if (format === GL.STENCIL_INDEX || format === GL.COLOR_INDEX)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            if (!COLOUR_FORMATS.has(format))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (!READ_TYPES.some(t=>t === type))
            {
                diverge(`glReadPixels with type ${type} was refused: only the byte, short,`
                    + ' int and float types are written');
                setError(GL.INVALID_ENUM);
                return null;
            }
            const texels = new Uint8Array(width * height * 4);
            for (let row = 0; row < height; row++)
            {
                for (let column = 0; column < width; column++)
                {
                    const fx = x + column;
                    const fy = frame.height - 1 - (y + row);
                    if (fx < 0 || fx >= frame.width || fy < 0 || fy >= frame.height)
                    {
                        continue;
                    }
                    texels.set(readPixel(frame, fx, fy), (row * width + column) * 4);
                }
            }
            return packImage(texels, width, height, format, type, packState());
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} type
         * @param {Uint8Array | null} texels  already unpacked to RGBA, bottom row first
         */
        glDrawPixels(width, height, format, type, texels){
            if (!enter('glDrawPixels', [width, height, format, type, texels]))
            {
                return;
            }
            if (width < 0 || height < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (format === GL.DEPTH_COMPONENT || format === GL.STENCIL_INDEX
                || format === GL.COLOR_INDEX)
            {
                diverge(`glDrawPixels with format ${format} was accepted and drew nothing`);
                return;
            }
            if (texels)
            {
                drawTexels(texels, width, height);
            }
        },

        /**
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         * @param {number} type
         */
        glCopyPixels(x, y, width, height, type){
            if (!enter('glCopyPixels', [x, y, width, height, type]))
            {
                return;
            }
            if (width < 0 || height < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (type !== GL.COLOR)
            {
                if (type !== GL.DEPTH && type !== GL.STENCIL)
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                diverge('glCopyPixels of depth or stencil was accepted and copied nothing');
                return;
            }
            const frame = kernel.framebuffer();
            const texels = new Uint8Array(width * height * 4);
            for (let row = 0; row < height; row++)
            {
                for (let column = 0; column < width; column++)
                {
                    const fx = x + column;
                    const fy = frame.height - 1 - (y + row);
                    if (fx >= 0 && fx < frame.width && fy >= 0 && fy < frame.height)
                    {
                        texels.set(readPixel(frame, fx, fy), (row * width + column) * 4);
                    }
                }
            }
            drawTexels(texels, width, height);
        },

        /**
         * The glyph is not drawn; the raster position still advances, so
         * that text laid out by a program keeps its spacing for whatever
         * does draw.
         *
         * @param {number} width
         * @param {number} height
         * @param {number} xorig
         * @param {number} yorig
         * @param {number} xmove
         * @param {number} ymove
         */
        glBitmap(width, height, xorig, yorig, xmove, ymove){
            if (!enter('glBitmap', [width, height, xorig, yorig, xmove, ymove]))
            {
                return;
            }
            if (width < 0 || height < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (record(GL.CURRENT_RASTER_POSITION_VALID).values[0] === 0)
            {
                return;
            }
            if (width > 0 && height > 0)
            {
                diverge('glBitmap was accepted and drew nothing: bitmap glyphs are not'
                    + ' rasterised, so text drawn through them is missing');
            }
            const position = record(GL.CURRENT_RASTER_POSITION).values;
            setState(GL.CURRENT_RASTER_POSITION,
                [position[0] + xmove, position[1] + ymove, position[2], position[3]]);
        },

        /** @param {number} operation @param {number} value */
        glAccum(operation, value){
            if (!enter('glAccum', [operation, value]))
            {
                return;
            }
            diverge('the accumulation buffer is accepted and empty: glAccum has no effect');
        },
    });
}
