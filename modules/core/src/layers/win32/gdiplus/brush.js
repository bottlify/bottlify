/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s brushes: a solid colour, a hatch of two colours, a texture of an
 * image, a linear gradient between two colours across a rectangle, and a
 * path gradient from a centre colour out to colours on a path's points.
 *
 * A linear gradient runs across its rectangle from left to right; the
 * direction and stretch it is asked for (two points, a mode, an angle) is
 * its transform, as GDI+ keeps it: the rectangle scaled about its centre so
 * the line still crosses all of it, then turned about the centre to the
 * direction. A gradient's blend (factors at positions) and preset blend
 * (colours at positions) are kept as given, checked as GDI+ checks them:
 * more than one entry runs from position 0 to position 1.
 */

import { Status, fn } from './kit.js';
import { IDENTITY, MatrixOrderAppend, combine, invert, rotation } from './matrix.js';
import { boundsOf, figures } from './path.js';

/** BrushType. */
export const BrushTypeSolidColor = 0;
const BrushTypeHatchFill = 1;
const BrushTypeTextureFill = 2;
const BrushTypePathGradient = 3;
const BrushTypeLinearGradient = 4;

/** WrapMode. */
const WrapModeTile = 0;
const WrapModeClamp = 4;

/** LinearGradientMode. */
const LinearGradientModeHorizontal = 0;
const LinearGradientModeBackwardDiagonal = 3;

/** The last HatchStyle (HatchStyleSolidDiamond). */
const HATCH_STYLE_LAST = 52;

/**
 * @typedef {Object} Brush
 * @property {number} type  BrushType
 * @property {number} [color]  a solid brush's
 * @property {number} [hatch] @property {number} [fore] @property {number} [back]
 * @property {number} [image]  a texture's image handle, its own copy
 * @property {number} [wrap]
 * @property {import('./matrix.js').Elements} [transform]
 * @property {number[]} [rect]  a gradient's, x y width height
 * @property {number[]} [colors]  a linear gradient's two
 * @property {number[]} [factors] @property {number[]} [positions]  the blend
 * @property {number[]} [presetColors] @property {number[]} [presetPositions]
 * @property {boolean} [gamma]
 * @property {[number, number][]} [points]  a path gradient's path, flattened
 * @property {[number, number]} [center] @property {number} [centerColor]
 * @property {number[]} [surround]  a path gradient's colour at each point
 * @property {[number, number]} [focus]  a path gradient's focus scales
 */

/**
 * The transform of a linear gradient across `rect` along `degrees`: scaled
 * about the centre so the turned rectangle still spans the line, then
 * turned to it.
 *
 * @param {number[]} rect @param {number} cos @param {number} sin
 * @returns {import('./matrix.js').Elements}
 */
const gradientTransform = ([x, y, width, height], cos, sin)=>{
    const cx = x + width / 2;
    const cy = y + height / 2;
    const widthRatio = (Math.abs(cos) * width + Math.abs(sin) * height) / width;
    const heightRatio = (Math.abs(sin) * width + Math.abs(cos) * height) / height;
    let m = /** @type {import('./matrix.js').Elements} */ ([1, 0, 0, 1, -cx, -cy]);
    m = combine(m, [widthRatio, 0, 0, heightRatio, 0, 0], MatrixOrderAppend);
    m = combine(m, [cos, sin, -sin, cos, 0, 0], MatrixOrderAppend);
    return combine(m, [1, 0, 0, 1, cx, cy], MatrixOrderAppend);
};

/**
 * @param {import('./kit.js').Kit} kit
 * @param {Object} deps
 * @param {{ elements: (at: number) => (import('./matrix.js').Elements | undefined),
 *     set: (at: number, m: import('./matrix.js').Elements) => boolean }} deps.matrices
 * @param {{ get: (at: number) => (import('./path.js').Path | undefined) }} deps.paths
 * @param {{ clone: (at: number) => number, size: (at: number) =>
 *     ({ width: number, height: number } | null) }} deps.images
 */
export function createBrushFunctions(kit, { matrices, paths, images }){
    const { InvalidParameter, Ok, OutOfMemory, InsufficientBuffer, GenericError,
        NotImplemented } = Status;
    /** @param {number} at @param {...number} types @returns {Brush | undefined} */
    const get = (at, ...types)=>{
        /** @type {Brush | undefined} */
        const brush = kit.get(at, 'brush');
        return brush && (types.length === 0 || types.includes(brush.type)) ? brush : undefined;
    };
    /** @param {Brush} brush @param {number} out */
    const make = (brush, out)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        kit.add('brush', brush, out);
        return Ok;
    };
    /**
     * A brush argument of one of `types` and the rest of a call.
     *
     * @param {number[]} types @param {(brush: Brush, args: number[]) => number} body
     * @returns {(args: number[]) => number}
     */
    const onBrush = (types, body)=>([at, ...rest])=>{
        const brush = get(at, ...types);
        return brush ? body(brush, rest) : InvalidParameter;
    };
    const LINE = [BrushTypeLinearGradient];
    const PATH = [BrushTypePathGradient];
    const TEXTURE = [BrushTypeTextureFill];

    /**
     * A linear gradient across `rect` along `cos`, `sin`.
     *
     * @param {number[]} rect @param {number} start @param {number} end @param {number} wrap
     * @param {number} cos @param {number} sin @param {number} out
     */
    const lineBrush = (rect, start, end, wrap, cos, sin, out)=>make({
        type: BrushTypeLinearGradient, rect, colors: [start >>> 0, end >>> 0], wrap,
        transform: cos === 1 && sin === 0 ? [...IDENTITY] : gradientTransform(rect, cos, sin),
        factors: [1], positions: [0], presetColors: [], presetPositions: [], gamma: false,
    }, out);

    /**
     * Factors or colours at positions, as a blend is set: one alone, or a run
     * from 0 to 1.
     *
     * @param {number} values @param {number} positions @param {number} count @param {number} least
     * @param {boolean} integers
     */
    const readBlend = (values, positions, count, least, integers)=>{
        if ((values >>> 0) === 0 || (positions >>> 0) === 0 || (count | 0) < least)
        {
            return null;
        }
        const at = kit.f32s(positions, count | 0);
        if ((count | 0) > 1 && (at[0] !== 0 || Math.abs(at[at.length - 1] - 1) > 1e-6))
        {
            return null;
        }
        const read = integers
            ? Array.from({ length: count | 0 }, (_, i)=>kit.u32(values + i * 4))
            : kit.f32s(values, count | 0);
        return { values: read, positions: at };
    };
    /**
     * @param {number[]} values @param {number[]} positions @param {number} out
     * @param {number} outPositions @param {number} count @param {boolean} integers
     * @param {boolean} [alone]  whether a single entry hands back its position too
     */
    const writeBlend = (values, positions, out, outPositions, count, integers, alone = true)=>{
        if (integers)
        {
            kit.write(out, new Uint8Array(Uint32Array.from(values).buffer));
        }
        else
        {
            kit.putF32s(out, values);
        }
        if (alone || values.length > 1)
        {
            kit.putF32s(outPositions, positions.slice(0, count));
        }
    };


    /**
     * A path gradient over points: its centre their mean, white at the
     * centre and at every point - what GDI+ starts one with.
     *
     * @param {[number, number][]} points @param {number} wrap @param {number} out
     */
    const pathGradient = (points, wrap, out)=>{
        const n = points.length;
        const center = /** @type {[number, number]} */ ([points.reduce((s, [x])=>s + x, 0) / n,
            points.reduce((s, [, y])=>s + y, 0) / n]);
        return make({ type: BrushTypePathGradient, points, center, centerColor: 0xffffffff,
            surround: points.map(()=>0xffffffff), wrap, transform: [...IDENTITY],
            rect: boundsOf(points), factors: [1], positions: [0], presetColors: [],
            presetPositions: [], gamma: false, focus: [0, 0] }, out);
    };

    /**
     * @param {number} image @param {number} wrap @param {number[] | null} part @param {number} out
     */
    const texture = (image, wrap, part, out)=>{
        const size = (image >>> 0) === 0 ? null : images.size(image);
        if (!size || (out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        if (part && (part[0] < 0 || part[1] < 0 || part[2] <= 0 || part[3] <= 0
            || part[0] + part[2] > size.width || part[1] + part[3] > size.height))
        {
            return OutOfMemory;
        }
        return make({ type: BrushTypeTextureFill, image: images.clone(image), wrap,
            transform: [...IDENTITY], rect: part ?? [0, 0, size.width, size.height] }, out);
    };

    /**
     * A bell rising to `scale` at `focus`: the normal curve's cumulative
     * share sampled either side of it, as a gradient's blend.
     *
     * @param {Brush} brush @param {number} focus @param {number} scale
     */
    const sigmaBlend = (brush, focus, scale)=>{
        const at = Math.max(0, Math.min(1, focus));
        const peak = scale;
        const steps = 16;
        /** The normal curve's cumulative share at x, by its error function. @param {number} x */
        const cumulative = x=>{
            const t = 1 / (1 + 0.3275911 * Math.abs(x));
            const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
            return 0.5 * (1 + Math.sign(x) * erf);
        };
        /** @type {number[]} */
        const positions = [];
        /** @type {number[]} */
        const factors = [];
        for (let i = 0; i <= steps; i++)
        {
            const position = i / steps;
            const side = position <= at ? (at === 0 ? 1 : position / at)
                : (at === 1 ? 1 : (1 - position) / (1 - at));
            positions.push(position);
            factors.push(peak * cumulative((side - 0.5) * 6));
        }
        brush.factors = factors;
        brush.positions = positions;
        return Ok;
    };

    const functions = {
        /** Status GdipCreateSolidFill(ARGB color, GpSolidFill **brush) */
        GdipCreateSolidFill: fn(8, ([color, out])=>
            make({ type: BrushTypeSolidColor, color: color >>> 0 }, out)),
        /** Status GdipGetSolidFillColor(GpSolidFill *brush, ARGB *color) */
        GdipGetSolidFillColor: fn(8, onBrush([BrushTypeSolidColor], (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.color));
            return Ok;
        })),
        /** Status GdipSetSolidFillColor(GpSolidFill *brush, ARGB color) */
        GdipSetSolidFillColor: fn(8, onBrush([BrushTypeSolidColor], (brush, [color])=>{
            brush.color = color >>> 0;
            return Ok;
        })),
        /**
         * Status GdipCreateHatchBrush(GpHatchStyle style, ARGB fore, ARGB back, GpHatch **brush)
         */
        GdipCreateHatchBrush: fn(16, ([style, fore, back, out])=>{
            if ((style >>> 0) > HATCH_STYLE_LAST)
            {
                return InvalidParameter;
            }
            return make({ type: BrushTypeHatchFill, hatch: style >>> 0, fore: fore >>> 0,
                back: back >>> 0 }, out);
        }),
        /** Status GdipGetHatchStyle(GpHatch *brush, GpHatchStyle *style) */
        GdipGetHatchStyle: fn(8, onBrush([BrushTypeHatchFill], (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.hatch));
            return Ok;
        })),
        /** Status GdipGetHatchForegroundColor(GpHatch *brush, ARGB *color) */
        GdipGetHatchForegroundColor: fn(8, onBrush([BrushTypeHatchFill], (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.fore));
            return Ok;
        })),
        /** Status GdipGetHatchBackgroundColor(GpHatch *brush, ARGB *color) */
        GdipGetHatchBackgroundColor: fn(8, onBrush([BrushTypeHatchFill], (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.back));
            return Ok;
        })),
        /** Status GdipGetBrushType(GpBrush *brush, GpBrushType *type) */
        GdipGetBrushType: fn(8, onBrush([], (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, brush.type);
            return Ok;
        })),
        /** Status GdipCloneBrush(GpBrush *brush, GpBrush **clone) */
        GdipCloneBrush: fn(8, onBrush([], (brush, [out])=>{
            const copy = structuredClone(brush);
            if (brush.image !== undefined)
            {
                copy.image = images.clone(brush.image);
            }
            return make(copy, out);
        })),
        /** Status GdipDeleteBrush(GpBrush *brush) */
        GdipDeleteBrush: fn(4, ([at])=>(kit.remove(at, 'brush') ? Ok : InvalidParameter)),

        /** Status GdipCreateTexture(GpImage *image, GpWrapMode wrap, GpTexture **texture) */
        GdipCreateTexture: fn(12, ([image, wrap, out])=>texture(image, wrap >>> 0, null, out)),
        /**
         * Status GdipCreateTexture2(GpImage*, GpWrapMode, REAL x, REAL y, REAL width, REAL height,
         *     GpTexture**)
         */
        GdipCreateTexture2: fn(28, ([image, wrap, ...rest])=>
            texture(image, wrap >>> 0, rest.slice(0, 4).map(kit.real), rest[4]),
        { floats: { 2: 'f32', 3: 'f32', 4: 'f32', 5: 'f32' } }),
        /**
         * Status GdipCreateTexture2I(GpImage*, GpWrapMode, INT x, INT y, INT width, INT height,
         *     GpTexture**)
         */
        GdipCreateTexture2I: fn(28, ([image, wrap, ...rest])=>
            texture(image, wrap >>> 0, rest.slice(0, 4).map(value=>value | 0), rest[4])),
        /**
         * Status GdipCreateTextureIA(GpImage*, GpImageAttributes*, REAL x, REAL y, REAL w, REAL h,
         *     GpTexture**)
         */
        GdipCreateTextureIA: fn(28, ([image, , ...rest])=>
            texture(image, WrapModeTile, rest.slice(0, 4).map(kit.real), rest[4]),
        { floats: { 2: 'f32', 3: 'f32', 4: 'f32', 5: 'f32' } }),
        /**
         * Status GdipCreateTextureIAI(GpImage*, GpImageAttributes*, INT x, INT y, INT w, INT h,
         *     GpTexture**)
         */
        GdipCreateTextureIAI: fn(28, ([image, , ...rest])=>
            texture(image, WrapModeTile, rest.slice(0, 4).map(value=>value | 0), rest[4])),
        /** Status GdipGetTextureImage(GpTexture *brush, GpImage **image): a copy of it. */
        GdipGetTextureImage: fn(8, onBrush(TEXTURE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putPointer(out, images.clone(/** @type {number} */ (brush.image)));
            return Ok;
        })),
        /** Status GdipGetTextureWrapMode(GpTexture *brush, GpWrapMode *wrap) */
        GdipGetTextureWrapMode: fn(8, onBrush(TEXTURE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.wrap));
            return Ok;
        })),
        /** Status GdipSetTextureWrapMode(GpTexture *brush, GpWrapMode wrap) */
        GdipSetTextureWrapMode: fn(8, onBrush(TEXTURE, (brush, [wrap])=>{
            brush.wrap = wrap >>> 0;
            return Ok;
        })),

        /**
         * Status GdipCreateLineBrush(const GpPointF *p1, const GpPointF *p2, ARGB c1, ARGB c2,
         *   GpWrapMode wrap, GpLineGradient **brush)
         *
         * The rectangle the two points bound - one of no width or height made
         * square about the line - with the line its direction. Two points the
         * same are OutOfMemory, as GDI+ answers.
         */
        GdipCreateLineBrush: fn(24, ([p1, p2, c1, c2, wrap, out])=>{
            if ((p1 >>> 0) === 0 || (p2 >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((wrap >>> 0) === WrapModeClamp)
            {
                return InvalidParameter;
            }
            const [[x1, y1]] = kit.points(p1, 1);
            const [[x2, y2]] = kit.points(p2, 1);
            if (x1 === x2 && y1 === y2)
            {
                return OutOfMemory;
            }
            let [x, y, width, height] = boundsOf([[x1, y1], [x2, y2]]);
            if (width === 0)
            {
                width = height;
                x -= width / 2;
            }
            if (height === 0)
            {
                height = width;
                y -= height / 2;
            }
            const length = Math.hypot(x2 - x1, y2 - y1);
            return lineBrush([x, y, width, height].map(Math.fround), c1, c2, wrap >>> 0,
                (x2 - x1) / length, (y2 - y1) / length, out);
        }),
        /**
         * Status GdipCreateLineBrushI(const GpPoint*, const GpPoint*, ARGB, ARG ARGB,
         *     ARG GpWrapMode, ...)
         */
        GdipCreateLineBrushI: fn(24, ([p1, p2, c1, c2, wrap, out])=>{
            if ((p1 >>> 0) === 0 || (p2 >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const scratch = new Float32Array([...kit.points(p1, 1, true)[0],
                ...kit.points(p2, 1, true)[0]]);
            const [x1, y1, x2, y2] = scratch;
            if ((out >>> 0) === 0 || (wrap >>> 0) === WrapModeClamp)
            {
                return InvalidParameter;
            }
            if (x1 === x2 && y1 === y2)
            {
                return OutOfMemory;
            }
            let [x, y, width, height] = boundsOf([[x1, y1], [x2, y2]]);
            if (width === 0)
            {
                width = height;
                x -= width / 2;
            }
            if (height === 0)
            {
                height = width;
                y -= height / 2;
            }
            const length = Math.hypot(x2 - x1, y2 - y1);
            return lineBrush([x, y, width, height], c1, c2, wrap >>> 0, (x2 - x1) / length,
                (y2 - y1) / length, out);
        }),
        /**
         * Status GdipCreateLineBrushFromRect(const GpRectF *rect, ARGB c1, ARGB c2,
         *   LinearGradientMode mode, GpWrapMode wrap, GpLineGradient **brush)
         */
        GdipCreateLineBrushFromRect: fn(24, ([rect, c1, c2, mode, wrap, out])=>
            fromRectMode(rect, false, c1, c2, mode, wrap, out)),
        /**
         * Status GdipCreateLineBrushFromRectI(const GpRect*, ARGB, ARG ARGB, ARG mode, ARG wrap,
         *     ...)
         */
        GdipCreateLineBrushFromRectI: fn(24, ([rect, c1, c2, mode, wrap, out])=>
            fromRectMode(rect, true, c1, c2, mode, wrap, out)),
        /**
         * Status GdipCreateLineBrushFromRectWithAngle(const GpRectF *rect, ARGB c1, ARGB c2,
         *   REAL angle, BOOL isAngleScalable, GpWrapMode wrap, GpLineGradient **brush)
         */
        GdipCreateLineBrushFromRectWithAngle: fn(28, ([rect, c1, c2, angle, scalable, wrap, out])=>
            fromRectAngle(rect, false, c1, c2, kit.real(angle), scalable !== 0, wrap, out),
        { floats: { 3: 'f32' } }),
        /** Status GdipCreateLineBrushFromRectWithAngleI(const GpRect*, ...) */
        GdipCreateLineBrushFromRectWithAngleI: fn(28, ([rect, c1, c2, angle, scalable, wrap, out])=>
            fromRectAngle(rect, true, c1, c2, kit.real(angle), scalable !== 0, wrap, out)),
        /** Status GdipGetLineRect(GpLineGradient *brush, GpRectF *rect) */
        GdipGetLineRect: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, /** @type {number[]} */ (brush.rect));
            return Ok;
        })),
        /** Status GdipGetLineRectI(GpLineGradient *brush, GpRect *rect) */
        GdipGetLineRectI: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32s(out, /** @type {number[]} */ (brush.rect).map(value=>Math.round(value)));
            return Ok;
        })),
        /** Status GdipGetLineColors(GpLineGradient *brush, ARGB *colors) */
        GdipGetLineColors: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.write(out, new Uint8Array(Uint32Array.from(
                /** @type {number[]} */ (brush.colors)).buffer));
            return Ok;
        })),
        /** Status GdipSetLineColors(GpLineGradient *brush, ARGB c1, ARGB c2) */
        GdipSetLineColors: fn(12, onBrush(LINE, (brush, [c1, c2])=>{
            brush.colors = [c1 >>> 0, c2 >>> 0];
            return Ok;
        })),
        /** Status GdipGetLineWrapMode(GpLineGradient *brush, GpWrapMode *wrap) */
        GdipGetLineWrapMode: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.wrap));
            return Ok;
        })),
        /** Status GdipSetLineWrapMode(GpLineGradient *brush, GpWrapMode wrap): never Clamp. */
        GdipSetLineWrapMode: fn(8, onBrush(LINE, (brush, [wrap])=>{
            if ((wrap >>> 0) !== WrapModeClamp)
            {
                brush.wrap = wrap >>> 0;
            }
            return Ok;
        })),
        /** Status GdipGetLineGammaCorrection(GpLineGradient *brush, BOOL *gamma) */
        GdipGetLineGammaCorrection: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, brush.gamma === true);
            return Ok;
        })),
        /** Status GdipSetLineGammaCorrection(GpLineGradient *brush, BOOL gamma) */
        GdipSetLineGammaCorrection: fn(8, onBrush(LINE, (brush, [gamma])=>{
            brush.gamma = gamma !== 0;
            return Ok;
        })),
        /** Status GdipGetLineBlendCount(GpLineGradient *brush, INT *count) */
        GdipGetLineBlendCount: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, /** @type {number[]} */ (brush.factors).length);
            return Ok;
        })),
        /**
         * Status GdipGetLineBlend(GpLineGradient *brush, REAL *factors, REAL *positions, INT count)
         */
        GdipGetLineBlend: fn(16, onBrush(LINE, (brush, [factors, positions, count])=>{
            const held = /** @type {number[]} */ (brush.factors);
            if ((factors >>> 0) === 0 || (positions >>> 0) === 0 || (count | 0) <= 0)
            {
                return InvalidParameter;
            }
            if ((count | 0) < held.length)
            {
                return InsufficientBuffer;
            }
            writeBlend(held, /** @type {number[]} */ (brush.positions), factors, positions,
                held.length, false);
            return Ok;
        })),
        /**
         * Status GdipSetLineBlend(GpLineGradient*, const REAL *factors, const REAL *positions, INT)
         */
        GdipSetLineBlend: fn(16, onBrush(LINE, (brush, [factors, positions, count])=>{
            const blend = readBlend(factors, positions, count, 1, false);
            if (!blend)
            {
                return InvalidParameter;
            }
            brush.factors = blend.values;
            brush.positions = blend.positions;
            return Ok;
        })),
        /**
         * Status GdipSetLineLinearBlend(GpLineGradient *brush, REAL focus, REAL scale)
         *
         * A triangle: nothing at the ends, `scale` at `focus` - or, with the
         * focus at an end, `scale` there and nothing at the other.
         */
        GdipSetLineLinearBlend: fn(12, onBrush(LINE, (brush, [focus, scale])=>{
            const at = kit.real(focus);
            const peak = kit.real(scale);
            if (at === 0)
            {
                [brush.factors, brush.positions] = [[peak, 0], [0, 1]];
            }
            else if (at === 1)
            {
                [brush.factors, brush.positions] = [[0, peak], [0, 1]];
            }
            else
            {
                [brush.factors, brush.positions] = [[0, peak, 0], [0, at, 1]];
            }
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32' } }),
        /**
         * Status GdipSetLineSigmaBlend(GpLineGradient *brush, REAL focus, REAL scale)
         *
         * A bell rising to `scale` at `focus`: the normal curve's cumulative
         * share sampled either side of it.
         */
        GdipSetLineSigmaBlend: fn(12, onBrush(LINE, (brush, [focus, scale])=>
            sigmaBlend(brush, kit.real(focus), kit.real(scale))),
        { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipGetLinePresetBlendCount(GpLineGradient *brush, INT *count) */
        GdipGetLinePresetBlendCount: fn(8, onBrush(LINE, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, /** @type {number[]} */ (brush.presetColors).length);
            return Ok;
        })),
        /**
         * Status GdipGetLinePresetBlend(GpLineGradient*, ARGB *colors, REAL *positions, INT count)
         */
        GdipGetLinePresetBlend: fn(16, onBrush(LINE, (brush, [colors, positions, count])=>
            getPreset(brush, colors, positions, count | 0, InvalidParameter))),
        /** Status GdipSetLinePresetBlend(GpLineGradient*, const ARGB*, const REAL*, INT count) */
        GdipSetLinePresetBlend: fn(16, onBrush(LINE, (brush, [colors, positions, count])=>
            setPreset(brush, colors, positions, count))),
        /** Status GdipGetLineTransform(GpLineGradient *brush, GpMatrix *matrix) */
        GdipGetLineTransform: fn(8, onBrush(LINE, (brush, [matrix])=>
            (matrices.set(matrix, /** @type {import('./matrix.js').Elements} */ (brush.transform))
                ? Ok : InvalidParameter))),
        /** Status GdipSetLineTransform(GpLineGradient *brush, const GpMatrix *matrix) */
        GdipSetLineTransform: fn(8, onBrush(LINE, (brush, [matrix])=>setTransform(brush, matrix))),
        /** Status GdipResetLineTransform(GpLineGradient *brush) */
        GdipResetLineTransform: fn(4, onBrush(LINE, brush=>{
            brush.transform = [...IDENTITY];
            return Ok;
        })),
        /** Status GdipMultiplyLineTransform(GpLineGradient*, const GpMatrix*, GpMatrixOrder) */
        GdipMultiplyLineTransform: fn(12, onBrush(LINE, (brush, [matrix, order])=>
            multiplyTransform(brush, matrix, order))),
        /**
         * Status GdipTranslateLineTransform(GpLineGradient*, REAL dx, REAL dy, REAL GpMatrixOrder)
         */
        GdipTranslateLineTransform: fn(16, onBrush(LINE, (brush, [dx, dy, order])=>
            applyTransform(brush, [1, 0, 0, 1, kit.real(dx), kit.real(dy)], order)),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipScaleLineTransform(GpLineGradient*, REAL sx, REAL sy, REAL GpMatrixOrder) */
        GdipScaleLineTransform: fn(16, onBrush(LINE, (brush, [sx, sy, order])=>
            applyTransform(brush, [kit.real(sx), 0, 0, kit.real(sy), 0, 0], order)),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipRotateLineTransform(GpLineGradient*, REAL angle, REAL GpMatrixOrder) */
        GdipRotateLineTransform: fn(12, onBrush(LINE, (brush, [angle, order])=>
            applyTransform(brush, rotation(kit.real(angle)), order)),
        { floats: { 1: 'f32', 2: 'f32' } }),

        /** Status GdipGetTextureTransform(GpTexture *brush, GpMatrix *matrix) */
        GdipGetTextureTransform: fn(8, onBrush(TEXTURE, (brush, [matrix])=>
            (matrices.set(matrix, /** @type {import('./matrix.js').Elements} */ (brush.transform))
                ? Ok : InvalidParameter))),
        /** Status GdipSetTextureTransform(GpTexture *brush, const GpMatrix *matrix) */
        GdipSetTextureTransform: fn(8, onBrush(TEXTURE, (brush, [matrix])=>
            setTransform(brush, matrix))),
        /** Status GdipResetTextureTransform(GpTexture *brush) */
        GdipResetTextureTransform: fn(4, onBrush(TEXTURE, brush=>{
            brush.transform = [...IDENTITY];
            return Ok;
        })),
        /** Status GdipMultiplyTextureTransform(GpTexture*, const GpMatrix*, GpMatrixOrder) */
        GdipMultiplyTextureTransform: fn(12, onBrush(TEXTURE, (brush, [matrix, order])=>
            multiplyTransform(brush, matrix, order))),
        /**
         * Status GdipTranslateTextureTransform(GpTexture*, REAL dx, REAL dy, REAL GpMatrixOrder)
         */
        GdipTranslateTextureTransform: fn(16, onBrush(TEXTURE, (brush, [dx, dy, order])=>
            applyTransform(brush, [1, 0, 0, 1, kit.real(dx), kit.real(dy)], order)),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipScaleTextureTransform(GpTexture*, REAL sx, REAL sy, REAL GpMatrixOrder) */
        GdipScaleTextureTransform: fn(16, onBrush(TEXTURE, (brush, [sx, sy, order])=>
            applyTransform(brush, [kit.real(sx), 0, 0, kit.real(sy), 0, 0], order)),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipRotateTextureTransform(GpTexture*, REAL angle, REAL GpMatrixOrder) */
        GdipRotateTextureTransform: fn(12, onBrush(TEXTURE, (brush, [angle, order])=>
            applyTransform(brush, rotation(kit.real(angle)), order)),
        { floats: { 1: 'f32', 2: 'f32' } }),

        /**
         * Status GdipCreatePathGradient(const GpPointF *points, INT count, INT GpWrapMode,
         *     GpPathGradient**)
         */
        GdipCreatePathGradient: fn(16, ([points, count, wrap, out])=>{
            if ((points >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((count | 0) < 2)
            {
                return OutOfMemory;
            }
            return pathGradient(kit.points(points, count | 0), wrap >>> 0, out);
        }),
        /** Status GdipCreatePathGradientI(const GpPoint *points, INT count, INT GpWrapMode, ...) */
        GdipCreatePathGradientI: fn(16, ([points, count, wrap, out])=>{
            if ((points >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((count | 0) < 2)
            {
                return OutOfMemory;
            }
            return pathGradient(kit.points(points, count | 0, true), wrap >>> 0, out);
        }),
        /** Status GdipCreatePathGradientFromPath(const GpPath *path, GpPathGradient **brush) */
        GdipCreatePathGradientFromPath: fn(8, ([at, out])=>{
            const path = paths.get(at);
            if (!path || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const points = figures(path).flat();
            if (points.length < 2)
            {
                return OutOfMemory;
            }
            return pathGradient(points, WrapModeClamp, out);
        }),
        /** Status GdipGetPathGradientPath(GpPathGradient*, GpPath*): GDI+ does not do it. */
        GdipGetPathGradientPath: fn(8, ()=>NotImplemented),
        /** Status GdipGetPathGradientCenterPoint(GpPathGradient *brush, GpPointF *point) */
        GdipGetPathGradientCenterPoint: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, /** @type {number[]} */ (brush.center));
            return Ok;
        })),
        /** Status GdipGetPathGradientCenterPointI(GpPathGradient *brush, GpPoint *point) */
        GdipGetPathGradientCenterPointI: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32s(out, /** @type {number[]} */ (brush.center).map(Math.round));
            return Ok;
        })),
        /** Status GdipSetPathGradientCenterPoint(GpPathGradient *brush, const GpPointF *point) */
        GdipSetPathGradientCenterPoint: fn(8, onBrush(PATH, (brush, [at])=>{
            if ((at >>> 0) === 0)
            {
                return InvalidParameter;
            }
            brush.center = kit.points(at, 1)[0];
            return Ok;
        })),
        /** Status GdipSetPathGradientCenterPointI(GpPathGradient *brush, const GpPoint *point) */
        GdipSetPathGradientCenterPointI: fn(8, onBrush(PATH, (brush, [at])=>{
            if ((at >>> 0) === 0)
            {
                return InvalidParameter;
            }
            brush.center = kit.points(at, 1, true)[0];
            return Ok;
        })),
        /** Status GdipGetPathGradientCenterColor(GpPathGradient *brush, ARGB *color) */
        GdipGetPathGradientCenterColor: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.centerColor));
            return Ok;
        })),
        /** Status GdipSetPathGradientCenterColor(GpPathGradient *brush, ARGB color) */
        GdipSetPathGradientCenterColor: fn(8, onBrush(PATH, (brush, [color])=>{
            brush.centerColor = color >>> 0;
            return Ok;
        })),
        /** Status GdipGetPathGradientPointCount(GpPathGradient *brush, INT *count) */
        GdipGetPathGradientPointCount: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, /** @type {[number, number][]} */ (brush.points).length);
            return Ok;
        })),
        /** Status GdipGetPathGradientSurroundColorCount(GpPathGradient *brush, INT *count) */
        GdipGetPathGradientSurroundColorCount: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, /** @type {number[]} */ (brush.surround).length);
            return Ok;
        })),
        /**
         * Status GdipGetPathGradientSurroundColorsWithCount(GpPathGradient*, ARGB *colors,
         *   INT *count)
         *
         * Every point's colour, room for each needed; the count handed back is
         * 1 when they are all one colour, as GDI+ reports a colour set once.
         */
        GdipGetPathGradientSurroundColorsWithCount: fn(12, onBrush(PATH, (brush, [colors, count])=>{
            const held = /** @type {number[]} */ (brush.surround);
            if ((colors >>> 0) === 0 || (count >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if (kit.i32(count) < held.length)
            {
                return InvalidParameter;
            }
            kit.write(colors, new Uint8Array(Uint32Array.from(held).buffer));
            kit.putI32(count, held.every(color=>color === held[0]) ? 1 : held.length);
            return Ok;
        })),
        /**
         * Status GdipSetPathGradientSurroundColorsWithCount(GpPathGradient*, const ARGB*, INT*)
         *
         * The first points take the colours given, the rest the last of them.
         */
        GdipSetPathGradientSurroundColorsWithCount: fn(12, onBrush(PATH, (brush, [colors, count])=>{
            const held = /** @type {number[]} */ (brush.surround);
            if ((colors >>> 0) === 0 || (count >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const n = kit.i32(count);
            if (n <= 0 || n > held.length)
            {
                return InvalidParameter;
            }
            const given = Array.from({ length: n }, (_, i)=>kit.u32(colors + i * 4));
            brush.surround = held.map((_, i)=>given[Math.min(i, n - 1)]);
            return Ok;
        })),
        /** Status GdipGetPathGradientRect(GpPathGradient *brush, GpRectF *rect) */
        GdipGetPathGradientRect: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, /** @type {number[]} */ (brush.rect));
            return Ok;
        })),
        /** Status GdipGetPathGradientRectI(GpPathGradient *brush, GpRect *rect) */
        GdipGetPathGradientRectI: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32s(out, /** @type {number[]} */ (brush.rect).map(Math.round));
            return Ok;
        })),
        /** Status GdipGetPathGradientWrapMode(GpPathGradient *brush, GpWrapMode *wrap) */
        GdipGetPathGradientWrapMode: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, /** @type {number} */ (brush.wrap));
            return Ok;
        })),
        /** Status GdipSetPathGradientWrapMode(GpPathGradient *brush, GpWrapMode wrap) */
        GdipSetPathGradientWrapMode: fn(8, onBrush(PATH, (brush, [wrap])=>{
            brush.wrap = wrap >>> 0;
            return Ok;
        })),
        /** Status GdipGetPathGradientGammaCorrection(GpPathGradient *brush, BOOL *gamma) */
        GdipGetPathGradientGammaCorrection: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, brush.gamma === true);
            return Ok;
        })),
        /** Status GdipSetPathGradientGammaCorrection(GpPathGradient *brush, BOOL gamma) */
        GdipSetPathGradientGammaCorrection: fn(8, onBrush(PATH, (brush, [gamma])=>{
            brush.gamma = gamma !== 0;
            return Ok;
        })),
        /** Status GdipGetPathGradientFocusScales(GpPathGradient *brush, REAL *x, REAL *y) */
        GdipGetPathGradientFocusScales: fn(12, onBrush(PATH, (brush, [x, y])=>{
            if ((x >>> 0) === 0 || (y >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const [sx, sy] = /** @type {[number, number]} */ (brush.focus);
            kit.putF32(x, sx);
            kit.putF32(y, sy);
            return Ok;
        })),
        /** Status GdipSetPathGradientFocusScales(GpPathGradient *brush, REAL x, REAL y) */
        GdipSetPathGradientFocusScales: fn(12, onBrush(PATH, (brush, [x, y])=>{
            brush.focus = [kit.real(x), kit.real(y)];
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipGetPathGradientBlendCount(GpPathGradient *brush, INT *count) */
        GdipGetPathGradientBlendCount: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, /** @type {number[]} */ (brush.factors).length);
            return Ok;
        })),
        /** Status GdipGetPathGradientBlend(GpPathGradient*, REAL *factors, REAL *positions, INT) */
        GdipGetPathGradientBlend: fn(16, onBrush(PATH, (brush, [factors, positions, count])=>{
            const held = /** @type {number[]} */ (brush.factors);
            if ((factors >>> 0) === 0 || (positions >>> 0) === 0 || (count | 0) <= 0)
            {
                return InvalidParameter;
            }
            if ((count | 0) < held.length)
            {
                return InsufficientBuffer;
            }
            writeBlend(held, /** @type {number[]} */ (brush.positions), factors, positions,
                held.length, false, false);
            return Ok;
        })),
        /** Status GdipSetPathGradientBlend(GpPathGradient*, const REAL*, const REAL*, INT) */
        GdipSetPathGradientBlend: fn(16, onBrush(PATH, (brush, [factors, positions, count])=>{
            const blend = readBlend(factors, positions, count, 1, false);
            if (!blend)
            {
                return InvalidParameter;
            }
            brush.factors = blend.values;
            brush.positions = blend.positions;
            return Ok;
        })),
        /** Status GdipSetPathGradientLinearBlend(GpPathGradient*, REAL focus, REAL scale) */
        GdipSetPathGradientLinearBlend: fn(12, onBrush(PATH, (brush, [focus, scale])=>{
            const at = kit.real(focus);
            const peak = kit.real(scale);
            [brush.factors, brush.positions] = at === 0 ? [[peak, 0], [0, 1]]
                : at === 1 ? [[0, peak], [0, 1]] : [[0, peak, 0], [0, at, 1]];
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipSetPathGradientSigmaBlend(GpPathGradient *brush, REAL focus, REAL scale) */
        GdipSetPathGradientSigmaBlend: fn(12, onBrush(PATH, (brush, [focus, scale])=>
            sigmaBlend(brush, kit.real(focus), kit.real(scale))),
        { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipGetPathGradientPresetBlendCount(GpPathGradient *brush, INT *count) */
        GdipGetPathGradientPresetBlendCount: fn(8, onBrush(PATH, (brush, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, /** @type {number[]} */ (brush.presetColors).length);
            return Ok;
        })),
        /** Status GdipGetPathGradientPresetBlend(GpPathGradient*, ARGB*, REAL*, INT count) */
        GdipGetPathGradientPresetBlend: fn(16, onBrush(PATH, (brush, [colors, positions, count])=>
            getPreset(brush, colors, positions, count | 0, OutOfMemory))),
        /** Status GdipSetPathGradientPresetBlend(GpPathGradient*, const ARGB*, const REAL*, INT) */
        GdipSetPathGradientPresetBlend: fn(16, onBrush(PATH, (brush, [colors, positions, count])=>
            setPreset(brush, colors, positions, count))),
        /** Status GdipGetPathGradientTransform(GpPathGradient *brush, GpMatrix *matrix) */
        GdipGetPathGradientTransform: fn(8, onBrush(PATH, (brush, [matrix])=>
            (matrices.set(matrix, /** @type {import('./matrix.js').Elements} */ (brush.transform))
                ? Ok : InvalidParameter))),
        /** Status GdipSetPathGradientTransform(GpPathGradient *brush, GpMatrix *matrix) */
        GdipSetPathGradientTransform: fn(8, onBrush(PATH, (brush, [matrix])=>
            setTransform(brush, matrix))),
        /** Status GdipResetPathGradientTransform(GpPathGradient *brush) */
        GdipResetPathGradientTransform: fn(4, onBrush(PATH, brush=>{
            brush.transform = [...IDENTITY];
            return Ok;
        })),
        /** Status GdipMultiplyPathGradientTransform(GpPathGradient*, const GpMatrix*, order) */
        GdipMultiplyPathGradientTransform: fn(12, onBrush(PATH, (brush, [matrix, order])=>
            multiplyTransform(brush, matrix, order))),
        /**
         * Status GdipTranslatePathGradientTransform(GpPathGradient*, REAL dx, REAL dy, REAL order)
         */
        GdipTranslatePathGradientTransform: fn(16, onBrush(PATH, (brush, [dx, dy, order])=>
            applyTransform(brush, [1, 0, 0, 1, kit.real(dx), kit.real(dy)], order)),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipScalePathGradientTransform(GpPathGradient*, REAL sx, REAL sy, REAL order) */
        GdipScalePathGradientTransform: fn(16, onBrush(PATH, (brush, [sx, sy, order])=>
            applyTransform(brush, [kit.real(sx), 0, 0, kit.real(sy), 0, 0], order)),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipRotatePathGradientTransform(GpPathGradient*, REAL angle, REAL order) */
        GdipRotatePathGradientTransform: fn(12, onBrush(PATH, (brush, [angle, order])=>
            applyTransform(brush, rotation(kit.real(angle)), order)),
        { floats: { 1: 'f32', 2: 'f32' } }),
    };

    /**
     * @param {number} rect @param {boolean} integers @param {number} c1 @param {number} c2
     * @param {number} mode @param {number} wrap @param {number} out
     */
    function fromRectMode(rect, integers, c1, c2, mode, wrap, out){
        if ((rect >>> 0) === 0 || (out >>> 0) === 0
            || (mode >>> 0) > LinearGradientModeBackwardDiagonal)
        {
            return InvalidParameter;
        }
        const box = integers ? kit.i32s(rect, 4) : kit.f32s(rect, 4);
        if (box[2] === 0 || box[3] === 0)
        {
            return OutOfMemory;
        }
        if ((mode >>> 0) === LinearGradientModeHorizontal)
        {
            return lineBrush(box, c1, c2, wrap >>> 0, 1, 0, out);
        }
        // Vertical runs down; the diagonals corner to corner of the rectangle.
        const angle = [0, 90, 45, 135][mode >>> 0];
        return fromAngle(box, c1, c2, angle, true, wrap >>> 0, out);
    }

    /**
     * @param {number} rect @param {boolean} integers @param {number} c1 @param {number} c2
     * @param {number} angle @param {boolean} scalable @param {number} wrap @param {number} out
     */
    function fromRectAngle(rect, integers, c1, c2, angle, scalable, wrap, out){
        if ((rect >>> 0) === 0 || (out >>> 0) === 0 || (wrap >>> 0) === WrapModeClamp)
        {
            return InvalidParameter;
        }
        const box = integers ? kit.i32s(rect, 4) : kit.f32s(rect, 4);
        if (box[2] === 0 || box[3] === 0)
        {
            return OutOfMemory;
        }
        return fromAngle(box, c1, c2, angle, scalable, wrap >>> 0, out);
    }

    /**
     * A gradient across the box at `angle` degrees; a scalable angle is the
     * one the box's own shape makes of it (45 runs corner to corner).
     *
     * @param {number[]} box @param {number} c1 @param {number} c2 @param {number} angle
     * @param {boolean} scalable @param {number} wrap @param {number} out
     */
    function fromAngle(box, c1, c2, angle, scalable, wrap, out){
        const degrees = ((angle % 360) + 360) % 360;
        if (degrees === 0)
        {
            return lineBrush(box, c1, c2, wrap, 1, 0, out);
        }
        let radians = degrees * Math.PI / 180;
        if (scalable && degrees % 90 !== 0)
        {
            radians = Math.atan2(Math.sin(radians) * Math.abs(box[3]),
                Math.cos(radians) * Math.abs(box[2]));
        }
        const cos = Math.abs(Math.cos(radians)) < 1e-7 ? 0 : Math.cos(radians);
        const sin = Math.abs(Math.sin(radians)) < 1e-7 ? 0 : Math.sin(radians);
        return lineBrush(box, c1, c2, wrap, cos, sin, out);
    }

    /**
     * @param {Brush} brush @param {number} colors @param {number} positions @param {number} count
     * @param {number} negative  the status a negative count is, which differs by brush
     */
    function getPreset(brush, colors, positions, count, negative){
        const held = /** @type {number[]} */ (brush.presetColors);
        if ((colors >>> 0) === 0 || (positions >>> 0) === 0 || count === 0)
        {
            return InvalidParameter;
        }
        if (count < 0)
        {
            return negative;
        }
        if (count < 2)
        {
            return InvalidParameter;
        }
        if (held.length === 0)
        {
            return GenericError;
        }
        if (count < held.length)
        {
            return InsufficientBuffer;
        }
        writeBlend(held, /** @type {number[]} */ (brush.presetPositions), colors, positions,
            held.length, true);
        return Ok;
    }

    /**
     * @param {Brush} brush @param {number} colors @param {number} positions @param {number} count
     */
    function setPreset(brush, colors, positions, count){
        const blend = readBlend(colors, positions, count, 2, true);
        if (!blend)
        {
            return InvalidParameter;
        }
        brush.presetColors = blend.values;
        brush.presetPositions = blend.positions;
        return Ok;
    }

    /**
     * A brush's new transform,
     *     which must have an inverse. @param {Brush} brush @param {number} matrix
     */
    function setTransform(brush, matrix){
        const m = matrices.elements(matrix);
        if (!m || !invert(m))
        {
            return InvalidParameter;
        }
        brush.transform = [...m];
        return Ok;
    }

    /** @param {Brush} brush @param {number} matrix @param {number} order */
    function multiplyTransform(brush, matrix, order){
        const m = matrices.elements(matrix);
        if (!m)
        {
            return InvalidParameter;
        }
        return applyTransform(brush, m, order);
    }

    /**
     * @param {Brush} brush @param {import('./matrix.js').Elements | number[]} m
     * @param {number} order
     */
    function applyTransform(brush, m, order){
        if ((order >>> 0) > MatrixOrderAppend)
        {
            return InvalidParameter;
        }
        brush.transform = combine(/** @type {import('./matrix.js').Elements} */ (brush.transform),
            /** @type {import('./matrix.js').Elements} */ (m), order >>> 0);
        return Ok;
    }

    return {
        functions,
        /** @param {number} at @returns {Brush | undefined} */
        get: at=>get(at),
        /**
         * A copy of a brush, as a pen takes and hands back one.
         *
         * @param {number} at @returns {Brush | undefined}
         */
        copy(at){
            const brush = get(at);
            if (!brush)
            {
                return undefined;
            }
            const copy = structuredClone(brush);
            if (brush.image !== undefined)
            {
                copy.image = images.clone(brush.image);
            }
            return copy;
        },
        /** A brush made, its handle. @param {Brush} brush */
        add: brush=>kit.add('brush', brush),
    };
}
