/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s pens and the custom line caps a pen's ends may wear.
 *
 * A pen is a brush stroked at a width in a unit, with its dashes, its caps
 * and joins, its compound lines and its transform. It keeps a copy of the
 * brush it is given and hands back a copy of its own, as GDI+ does: a
 * program that changes the brush it got changes nothing the pen draws.
 *
 * A custom cap is a path, filled or stroked, at a line's end; an adjustable
 * arrow cap is one whose path is an arrowhead of a height and width, its
 * base inset the height over the width.
 */

import { Status, fn } from './kit.js';
import { IDENTITY, MatrixOrderAppend, combine, invert, rotation } from './matrix.js';
import { BrushTypeSolidColor } from './brush.js';
import { clonePath } from './path.js';

/** GpUnit: a pen's width is in any but Display. */
const UnitDisplay = 1;
const UnitMillimeter = 6;

/** DashStyle. */
const DashStyleSolid = 0;
const DashStyleCustom = 5;

/** LineCap: the base caps a custom cap may stand on. */
const LineCapFlat = 0;
const LineCapSquare = 1;
const LineCapRound = 2;
const LineCapTriangle = 3;
const LineCapCustom = 0xff;
const BASE_CAPS = new Set([LineCapFlat, LineCapSquare, LineCapRound, LineCapTriangle]);

/** LineJoin. */
const LineJoinMiter = 0;
const LineJoinMiterClipped = 3;

/** CustomLineCapType. */
const CustomLineCapTypeDefault = 0;
const CustomLineCapTypeAdjustableArrow = 1;

/**
 * @typedef {Object} Cap
 * @property {number} type  CustomLineCapType
 * @property {import('./path.js').Path | null} fill
 * @property {import('./path.js').Path | null} stroke
 * @property {number} base  LineCap
 * @property {number} inset
 * @property {number} startCap @property {number} endCap
 * @property {number} join
 * @property {number} scale
 * @property {number} [height] @property {number} [width] @property {number} [middle]
 * @property {boolean} [filled]
 */

/**
 * @typedef {Object} Pen
 * @property {number} width
 * @property {number} unit
 * @property {import('./brush.js').Brush} brush
 * @property {number} dashStyle @property {number[]} dashes @property {number} dashOffset
 * @property {number} dashCap
 * @property {number} startCap @property {number} endCap
 * @property {number} join @property {number} miterLimit
 * @property {number} alignment  PenAlignment
 * @property {number[]} compound
 * @property {import('./matrix.js').Elements} transform
 * @property {Cap | null} customStart @property {Cap | null} customEnd
 */

/** @param {Cap} cap @returns {Cap} */
const copyCap = cap=>({ ...cap, fill: cap.fill && clonePath(cap.fill),
    stroke: cap.stroke && clonePath(cap.stroke) });

/**
 * @param {import('./kit.js').Kit} kit
 * @param {Object} deps
 * @param {{ elements: (at: number) => (import('./matrix.js').Elements | undefined),
 *     set: (at: number, m: import('./matrix.js').Elements) => boolean }} deps.matrices
 * @param {{ get: (at: number) => (import('./path.js').Path | undefined) }} deps.paths
 * @param {{ copy: (at: number) => (import('./brush.js').Brush | undefined),
 *     add: (brush: import('./brush.js').Brush) => number }} deps.brushes
 */
export function createPenFunctions(kit, { matrices, paths, brushes }){
    const { InvalidParameter, Ok } = Status;
    /** @param {number} at @returns {Pen | undefined} */
    const get = at=>kit.get(at, 'pen');
    /** @param {number} at @returns {Cap | undefined} */
    const getCap = at=>kit.get(at, 'cap');
    /**
     * @param {(pen: Pen, args: number[]) => number} body
     * @returns {(args: number[]) => number}
     */
    const onPen = body=>([at, ...rest])=>{
        const pen = get(at);
        return pen ? body(pen, rest) : InvalidParameter;
    };
    /**
     * @param {(cap: Cap, args: number[]) => number} body @param {boolean} [arrow]
     * @returns {(args: number[]) => number}
     */
    const onCap = (body, arrow = false)=>([at, ...rest])=>{
        const cap = getCap(at);
        return cap && (!arrow || cap.type === CustomLineCapTypeAdjustableArrow)
            ? body(cap, rest) : InvalidParameter;
    };
    /** An out-parameter written by `write`, InvalidParameter when there is none. */
    const out = (/** @type {number} */ at, /** @type {() => void} */ write)=>{
        if ((at >>> 0) === 0)
        {
            return InvalidParameter;
        }
        write();
        return Ok;
    };

    /**
     * @param {import('./brush.js').Brush} brush @param {number} width @param {number} unit
     * @param {number} result
     */
    const makePen = (brush, width, unit, result)=>{
        if ((result >>> 0) === 0 || unit === UnitDisplay || unit > UnitMillimeter)
        {
            return InvalidParameter;
        }
        /** @type {Pen} */
        const pen = { width, unit, brush, dashStyle: DashStyleSolid, dashes: [], dashOffset: 0,
            dashCap: LineCapFlat, startCap: LineCapFlat, endCap: LineCapFlat,
            join: LineJoinMiter, miterLimit: 10, alignment: 0, compound: [],
            transform: [...IDENTITY], customStart: null, customEnd: null };
        kit.add('pen', pen, result);
        return Ok;
    };

    /** @param {Pen} pen @param {import('./matrix.js').Elements | number[]} m @param {number} order */
    const applyTransform = (pen, m, order)=>{
        if ((order >>> 0) > MatrixOrderAppend)
        {
            return InvalidParameter;
        }
        pen.transform = combine(pen.transform,
            /** @type {import('./matrix.js').Elements} */ (m), order >>> 0);
        return Ok;
    };

    /** An arrowhead of a height and width, its base inset by their ratio. @param {Cap} cap */
    const shapeArrow = cap=>{
        const height = /** @type {number} */ (cap.height);
        const width = /** @type {number} */ (cap.width);
        const middle = /** @type {number} */ (cap.middle);
        cap.inset = width === 0 ? 0 : height / width;
        /** @type {import('./path.js').Path} */
        const head = { points: [[-width / 2, -height], [0, 0], [width / 2, -height],
            [0, middle - height]], types: [0, 1, 1, 0x81], fill: 0, open: false };
        if (cap.filled)
        {
            cap.fill = head;
            cap.stroke = null;
        }
        else
        {
            cap.stroke = head;
            cap.fill = null;
        }
    };

    const functions = {
        /** Status GdipCreatePen1(ARGB color, REAL width, GpUnit unit, GpPen **pen) */
        GdipCreatePen1: fn(16, ([color, width, unit, result])=>
            makePen({ type: BrushTypeSolidColor, color: color >>> 0 }, kit.real(width), unit >>> 0,
                result)),
        /** Status GdipCreatePen2(GpBrush *brush, REAL width, GpUnit unit, GpPen **pen) */
        GdipCreatePen2: fn(16, ([brush, width, unit, result])=>{
            const copy = brushes.copy(brush);
            return copy ? makePen(copy, kit.real(width), unit >>> 0, result) : InvalidParameter;
        }),
        /** Status GdipClonePen(GpPen *pen, GpPen **clone) */
        GdipClonePen: fn(8, onPen((pen, [result])=>{
            if ((result >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('pen', { ...structuredClone(pen) }, result);
            return Ok;
        })),
        /** Status GdipDeletePen(GpPen *pen) */
        GdipDeletePen: fn(4, ([at])=>(kit.remove(at, 'pen') ? Ok : InvalidParameter)),
        /** Status GdipGetPenWidth(GpPen *pen, REAL *width) */
        GdipGetPenWidth: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putF32(at, pen.width)))),
        /** Status GdipSetPenWidth(GpPen *pen, REAL width) */
        GdipSetPenWidth: fn(8, onPen((pen, [width])=>{
            pen.width = kit.real(width);
            return Ok;
        })),
        /** Status GdipGetPenUnit(GpPen *pen, GpUnit *unit) */
        GdipGetPenUnit: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.unit)))),
        /** Status GdipGetPenColor(GpPen *pen, ARGB *color): a solid pen's alone. */
        GdipGetPenColor: fn(8, onPen((pen, [at])=>{
            if ((at >>> 0) === 0 || pen.brush.type !== BrushTypeSolidColor)
            {
                return InvalidParameter;
            }
            kit.putU32(at, /** @type {number} */ (pen.brush.color));
            return Ok;
        })),
        /** Status GdipSetPenColor(GpPen *pen, ARGB color): the pen becomes solid. */
        GdipSetPenColor: fn(8, onPen((pen, [color])=>{
            pen.brush = { type: BrushTypeSolidColor, color: color >>> 0 };
            return Ok;
        })),
        /** Status GdipGetPenBrushFill(GpPen *pen, GpBrush **brush): a copy of its brush. */
        GdipGetPenBrushFill: fn(8, onPen((pen, [at])=>out(at, ()=>
            kit.putPointer(at, brushes.add(structuredClone(pen.brush)))))),
        /** Status GdipSetPenBrushFill(GpPen *pen, GpBrush *brush): a copy of the brush. */
        GdipSetPenBrushFill: fn(8, onPen((pen, [brush])=>{
            const copy = brushes.copy(brush);
            if (!copy)
            {
                return InvalidParameter;
            }
            pen.brush = copy;
            return Ok;
        })),
        /** Status GdipGetPenFillType(GpPen *pen, GpPenType *type): its brush's type. */
        GdipGetPenFillType: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.brush.type)))),
        /** Status GdipGetPenDashStyle(GpPen *pen, GpDashStyle *style) */
        GdipGetPenDashStyle: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.dashStyle)))),
        /** Status GdipSetPenDashStyle(GpPen *pen, GpDashStyle style) */
        GdipSetPenDashStyle: fn(8, onPen((pen, [style])=>{
            if ((style >>> 0) > DashStyleCustom)
            {
                return InvalidParameter;
            }
            pen.dashStyle = style >>> 0;
            return Ok;
        })),
        /** Status GdipGetPenDashCount(GpPen *pen, INT *count) */
        GdipGetPenDashCount: fn(8, onPen((pen, [at])=>
            out(at, ()=>kit.putI32(at, pen.dashes.length)))),
        /**
         * Status GdipGetPenDashArray(GpPen *pen, REAL *dashes, INT count)
         *
         * A custom pen's dashes, as many as asked and no more than it has;
         * another pen has none to hand out but answers for nothing asked.
         */
        GdipGetPenDashArray: fn(12, onPen((pen, [at, count])=>{
            if ((at >>> 0) === 0 || (count | 0) < 0 || (count | 0) > pen.dashes.length)
            {
                return InvalidParameter;
            }
            if ((count | 0) === 0)
            {
                return Ok;
            }
            if (pen.dashStyle !== DashStyleCustom)
            {
                return InvalidParameter;
            }
            kit.putF32s(at, pen.dashes.slice(0, count | 0));
            return Ok;
        })),
        /** Status GdipSetPenDashArray(GpPen *pen, const REAL *dashes, INT count): all positive. */
        GdipSetPenDashArray: fn(12, onPen((pen, [at, count])=>{
            if ((at >>> 0) === 0 || (count | 0) <= 0)
            {
                return InvalidParameter;
            }
            const dashes = kit.f32s(at, count | 0);
            if (dashes.some(value=>!(value > 0)))
            {
                return InvalidParameter;
            }
            pen.dashes = dashes;
            pen.dashStyle = DashStyleCustom;
            return Ok;
        })),
        /** Status GdipGetPenDashOffset(GpPen *pen, REAL *offset) */
        GdipGetPenDashOffset: fn(8, onPen((pen, [at])=>
            out(at, ()=>kit.putF32(at, pen.dashOffset)))),
        /** Status GdipSetPenDashOffset(GpPen *pen, REAL offset) */
        GdipSetPenDashOffset: fn(8, onPen((pen, [offset])=>{
            pen.dashOffset = kit.real(offset);
            return Ok;
        })),
        /** Status GdipGetPenDashCap197819(GpPen *pen, GpDashCap *cap) */
        GdipGetPenDashCap197819: fn(8, onPen((pen, [at])=>
            out(at, ()=>kit.putU32(at, pen.dashCap)))),
        /** Status GdipSetPenDashCap197819(GpPen *pen, GpDashCap cap) */
        GdipSetPenDashCap197819: fn(8, onPen((pen, [cap])=>{
            pen.dashCap = cap >>> 0;
            return Ok;
        })),
        /** Status GdipGetPenStartCap(GpPen *pen, GpLineCap *cap) */
        GdipGetPenStartCap: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.startCap)))),
        /** Status GdipSetPenStartCap(GpPen *pen, GpLineCap cap) */
        GdipSetPenStartCap: fn(8, onPen((pen, [cap])=>{
            pen.startCap = cap >>> 0;
            pen.customStart = null;
            return Ok;
        })),
        /** Status GdipGetPenEndCap(GpPen *pen, GpLineCap *cap) */
        GdipGetPenEndCap: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.endCap)))),
        /** Status GdipSetPenEndCap(GpPen *pen, GpLineCap cap) */
        GdipSetPenEndCap: fn(8, onPen((pen, [cap])=>{
            pen.endCap = cap >>> 0;
            pen.customEnd = null;
            return Ok;
        })),
        /** Status GdipSetPenLineCap197819(GpPen *pen, GpLineCap start, GpLineCap end, GpDashCap dash) */
        GdipSetPenLineCap197819: fn(16, onPen((pen, [start, end, dash])=>{
            [pen.startCap, pen.endCap, pen.dashCap] = [start >>> 0, end >>> 0, dash >>> 0];
            pen.customStart = null;
            pen.customEnd = null;
            return Ok;
        })),
        /** Status GdipGetPenLineJoin(GpPen *pen, GpLineJoin *join) */
        GdipGetPenLineJoin: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.join)))),
        /** Status GdipSetPenLineJoin(GpPen *pen, GpLineJoin join) */
        GdipSetPenLineJoin: fn(8, onPen((pen, [join])=>{
            pen.join = join >>> 0;
            return Ok;
        })),
        /** Status GdipGetPenMiterLimit(GpPen *pen, REAL *limit) */
        GdipGetPenMiterLimit: fn(8, onPen((pen, [at])=>
            out(at, ()=>kit.putF32(at, pen.miterLimit)))),
        /** Status GdipSetPenMiterLimit(GpPen *pen, REAL limit) */
        GdipSetPenMiterLimit: fn(8, onPen((pen, [limit])=>{
            pen.miterLimit = kit.real(limit);
            return Ok;
        })),
        /** Status GdipGetPenMode(GpPen *pen, GpPenAlignment *mode) */
        GdipGetPenMode: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putU32(at, pen.alignment)))),
        /** Status GdipSetPenMode(GpPen *pen, GpPenAlignment mode) */
        GdipSetPenMode: fn(8, onPen((pen, [mode])=>{
            pen.alignment = mode >>> 0;
            return Ok;
        })),
        /** Status GdipGetPenCompoundCount(GpPen *pen, INT *count) */
        GdipGetPenCompoundCount: fn(8, onPen((pen, [at])=>
            out(at, ()=>kit.putI32(at, pen.compound.length)))),
        /** Status GdipGetPenCompoundArray(GpPen *pen, REAL *values, INT count) */
        GdipGetPenCompoundArray: fn(12, onPen((pen, [at, count])=>{
            if ((at >>> 0) === 0 || (count | 0) > pen.compound.length)
            {
                return InvalidParameter;
            }
            if ((count | 0) > 0)
            {
                kit.putF32s(at, pen.compound.slice(0, count | 0));
            }
            else if ((count | 0) < 0)
            {
                kit.putF32s(at, pen.compound);
            }
            return Ok;
        })),
        /**
         * Status GdipSetPenCompoundArray(GpPen *pen, const REAL *values, INT count)
         *
         * Pairs of edges across the pen's width, from 0 to 1, each no less
         * than the one before.
         */
        GdipSetPenCompoundArray: fn(12, onPen((pen, [at, count])=>{
            if ((at >>> 0) === 0 || (count | 0) < 2 || (count | 0) % 2 !== 0)
            {
                return InvalidParameter;
            }
            const values = kit.f32s(at, count | 0);
            if (values.some((value, i)=>value < 0 || value > 1 || (i > 0 && value < values[i - 1])))
            {
                return InvalidParameter;
            }
            pen.compound = values;
            return Ok;
        })),
        /** Status GdipGetPenTransform(GpPen *pen, GpMatrix *matrix) */
        GdipGetPenTransform: fn(8, onPen((pen, [matrix])=>
            (matrices.set(matrix, pen.transform) ? Ok : InvalidParameter))),
        /** Status GdipSetPenTransform(GpPen *pen, GpMatrix *matrix): one with an inverse. */
        GdipSetPenTransform: fn(8, onPen((pen, [matrix])=>{
            const m = matrices.elements(matrix);
            if (!m || !invert(m))
            {
                return InvalidParameter;
            }
            pen.transform = [...m];
            return Ok;
        })),
        /** Status GdipResetPenTransform(GpPen *pen) */
        GdipResetPenTransform: fn(4, onPen(pen=>{
            pen.transform = [...IDENTITY];
            return Ok;
        })),
        /** Status GdipMultiplyPenTransform(GpPen *pen, const GpMatrix *matrix, GpMatrixOrder order) */
        GdipMultiplyPenTransform: fn(12, onPen((pen, [matrix, order])=>{
            if ((matrix >>> 0) === 0)
            {
                return Ok;
            }
            const m = matrices.elements(matrix);
            return m ? applyTransform(pen, m, order) : InvalidParameter;
        })),
        /** Status GdipTranslatePenTransform(GpPen *pen, REAL dx, REAL dy, GpMatrixOrder order) */
        GdipTranslatePenTransform: fn(16, onPen((pen, [dx, dy, order])=>
            applyTransform(pen, [1, 0, 0, 1, kit.real(dx), kit.real(dy)], order))),
        /** Status GdipScalePenTransform(GpPen *pen, REAL sx, REAL sy, GpMatrixOrder order) */
        GdipScalePenTransform: fn(16, onPen((pen, [sx, sy, order])=>
            applyTransform(pen, [kit.real(sx), 0, 0, kit.real(sy), 0, 0], order))),
        /** Status GdipRotatePenTransform(GpPen *pen, REAL angle, GpMatrixOrder order) */
        GdipRotatePenTransform: fn(12, onPen((pen, [angle, order])=>
            applyTransform(pen, rotation(kit.real(angle)), order))),
        /** Status GdipGetPenCustomStartCap(GpPen *pen, GpCustomLineCap **cap): a copy, or none. */
        GdipGetPenCustomStartCap: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putPointer(at,
            pen.customStart ? kit.add('cap', copyCap(pen.customStart)) : 0)))),
        /** Status GdipGetPenCustomEndCap(GpPen *pen, GpCustomLineCap **cap) */
        GdipGetPenCustomEndCap: fn(8, onPen((pen, [at])=>out(at, ()=>kit.putPointer(at,
            pen.customEnd ? kit.add('cap', copyCap(pen.customEnd)) : 0)))),
        /** Status GdipSetPenCustomStartCap(GpPen *pen, GpCustomLineCap *cap) */
        GdipSetPenCustomStartCap: fn(8, onPen((pen, [at])=>{
            const cap = getCap(at);
            if (!cap)
            {
                return InvalidParameter;
            }
            pen.customStart = copyCap(cap);
            pen.startCap = LineCapCustom;
            return Ok;
        })),
        /** Status GdipSetPenCustomEndCap(GpPen *pen, GpCustomLineCap *cap) */
        GdipSetPenCustomEndCap: fn(8, onPen((pen, [at])=>{
            const cap = getCap(at);
            if (!cap)
            {
                return InvalidParameter;
            }
            pen.customEnd = copyCap(cap);
            pen.endCap = LineCapCustom;
            return Ok;
        })),

        /**
         * Status GdipCreateCustomLineCap(GpPath *fillPath, GpPath *strokePath, GpLineCap baseCap,
         *   REAL baseInset, GpCustomLineCap **cap)
         *
         * A stroke path, when there is one, is the cap and the fill path is
         * not used.
         */
        GdipCreateCustomLineCap: fn(20, ([fillAt, strokeAt, base, inset, result])=>{
            const fill = (fillAt >>> 0) === 0 ? null : paths.get(fillAt);
            const stroke = (strokeAt >>> 0) === 0 ? null : paths.get(strokeAt);
            if ((result >>> 0) === 0 || (!fill && !stroke) || fill === undefined
                || stroke === undefined)
            {
                return InvalidParameter;
            }
            kit.add('cap', /** @type {Cap} */ ({ type: CustomLineCapTypeDefault,
                fill: stroke ? null : fill && clonePath(fill), stroke: stroke && clonePath(stroke),
                base: BASE_CAPS.has(base >>> 0) ? base >>> 0 : LineCapFlat, inset: kit.real(inset),
                startCap: LineCapFlat, endCap: LineCapFlat, join: LineJoinMiter, scale: 1 }),
            result);
            return Ok;
        }),
        /** Status GdipCloneCustomLineCap(GpCustomLineCap *cap, GpCustomLineCap **clone) */
        GdipCloneCustomLineCap: fn(8, onCap((cap, [result])=>out(result, ()=>
            kit.add('cap', copyCap(cap), result)))),
        /** Status GdipDeleteCustomLineCap(GpCustomLineCap *cap) */
        GdipDeleteCustomLineCap: fn(4, ([at])=>(kit.remove(at, 'cap') ? Ok : InvalidParameter)),
        /** Status GdipGetCustomLineCapType(GpCustomLineCap *cap, CustomLineCapType *type) */
        GdipGetCustomLineCapType: fn(8, onCap((cap, [at])=>out(at, ()=>kit.putU32(at, cap.type)))),
        /** Status GdipGetCustomLineCapBaseCap(GpCustomLineCap *cap, GpLineCap *base) */
        GdipGetCustomLineCapBaseCap: fn(8, onCap((cap, [at])=>
            out(at, ()=>kit.putU32(at, cap.base)))),
        /** Status GdipSetCustomLineCapBaseCap(GpCustomLineCap *cap, GpLineCap base): a plain cap. */
        GdipSetCustomLineCapBaseCap: fn(8, onCap((cap, [base])=>{
            if (!BASE_CAPS.has(base >>> 0))
            {
                return InvalidParameter;
            }
            cap.base = base >>> 0;
            return Ok;
        })),
        /** Status GdipGetCustomLineCapBaseInset(GpCustomLineCap *cap, REAL *inset) */
        GdipGetCustomLineCapBaseInset: fn(8, onCap((cap, [at])=>
            out(at, ()=>kit.putF32(at, cap.inset)))),
        /** Status GdipSetCustomLineCapBaseInset(GpCustomLineCap *cap, REAL inset) */
        GdipSetCustomLineCapBaseInset: fn(8, onCap((cap, [inset])=>{
            cap.inset = kit.real(inset);
            return Ok;
        })),
        /** Status GdipGetCustomLineCapStrokeJoin(GpCustomLineCap *cap, GpLineJoin *join) */
        GdipGetCustomLineCapStrokeJoin: fn(8, onCap((cap, [at])=>
            out(at, ()=>kit.putU32(at, cap.join)))),
        /** Status GdipSetCustomLineCapStrokeJoin(GpCustomLineCap *cap, GpLineJoin join) */
        GdipSetCustomLineCapStrokeJoin: fn(8, onCap((cap, [join])=>{
            if ((join >>> 0) > LineJoinMiterClipped)
            {
                return InvalidParameter;
            }
            cap.join = join >>> 0;
            return Ok;
        })),
        /** Status GdipGetCustomLineCapStrokeCaps(GpCustomLineCap*, GpLineCap *start, GpLineCap *end) */
        GdipGetCustomLineCapStrokeCaps: fn(12, onCap((cap, [start, end])=>{
            if ((start >>> 0) === 0 || (end >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(start, cap.startCap);
            kit.putU32(end, cap.endCap);
            return Ok;
        })),
        /** Status GdipSetCustomLineCapStrokeCaps(GpCustomLineCap*, GpLineCap start, GpLineCap end) */
        GdipSetCustomLineCapStrokeCaps: fn(12, onCap((cap, [start, end])=>{
            if (!BASE_CAPS.has(start >>> 0) || !BASE_CAPS.has(end >>> 0))
            {
                return InvalidParameter;
            }
            [cap.startCap, cap.endCap] = [start >>> 0, end >>> 0];
            return Ok;
        })),
        /** Status GdipGetCustomLineCapWidthScale(GpCustomLineCap *cap, REAL *scale) */
        GdipGetCustomLineCapWidthScale: fn(8, onCap((cap, [at])=>
            out(at, ()=>kit.putF32(at, cap.scale)))),
        /** Status GdipSetCustomLineCapWidthScale(GpCustomLineCap *cap, REAL scale) */
        GdipSetCustomLineCapWidthScale: fn(8, onCap((cap, [scale])=>{
            cap.scale = kit.real(scale);
            return Ok;
        })),

        /** Status GdipCreateAdjustableArrowCap(REAL height, REAL width, BOOL isFilled, GpAdjustableArrowCap **cap) */
        GdipCreateAdjustableArrowCap: fn(16, ([height, width, filled, result])=>{
            if ((result >>> 0) === 0)
            {
                return InvalidParameter;
            }
            /** @type {Cap} */
            const cap = { type: CustomLineCapTypeAdjustableArrow, fill: null, stroke: null,
                base: LineCapTriangle, inset: 0, startCap: LineCapFlat, endCap: LineCapFlat,
                join: LineJoinMiter, scale: 1, height: kit.real(height), width: kit.real(width),
                middle: 0, filled: filled !== 0 };
            shapeArrow(cap);
            kit.add('cap', cap, result);
            return Ok;
        }),
        /** Status GdipGetAdjustableArrowCapHeight(GpAdjustableArrowCap *cap, REAL *height) */
        GdipGetAdjustableArrowCapHeight: fn(8, onCap((cap, [at])=>out(at, ()=>
            kit.putF32(at, /** @type {number} */ (cap.height))), true)),
        /** Status GdipSetAdjustableArrowCapHeight(GpAdjustableArrowCap *cap, REAL height) */
        GdipSetAdjustableArrowCapHeight: fn(8, onCap((cap, [height])=>{
            cap.height = kit.real(height);
            shapeArrow(cap);
            return Ok;
        }, true)),
        /** Status GdipGetAdjustableArrowCapWidth(GpAdjustableArrowCap *cap, REAL *width) */
        GdipGetAdjustableArrowCapWidth: fn(8, onCap((cap, [at])=>out(at, ()=>
            kit.putF32(at, /** @type {number} */ (cap.width))), true)),
        /** Status GdipSetAdjustableArrowCapWidth(GpAdjustableArrowCap *cap, REAL width) */
        GdipSetAdjustableArrowCapWidth: fn(8, onCap((cap, [width])=>{
            cap.width = kit.real(width);
            shapeArrow(cap);
            return Ok;
        }, true)),
        /** Status GdipGetAdjustableArrowCapMiddleInset(GpAdjustableArrowCap *cap, REAL *inset) */
        GdipGetAdjustableArrowCapMiddleInset: fn(8, onCap((cap, [at])=>out(at, ()=>
            kit.putF32(at, /** @type {number} */ (cap.middle))), true)),
        /** Status GdipSetAdjustableArrowCapMiddleInset(GpAdjustableArrowCap *cap, REAL inset) */
        GdipSetAdjustableArrowCapMiddleInset: fn(8, onCap((cap, [inset])=>{
            cap.middle = kit.real(inset);
            shapeArrow(cap);
            return Ok;
        }, true)),
        /** Status GdipGetAdjustableArrowCapFillState(GpAdjustableArrowCap *cap, BOOL *filled) */
        GdipGetAdjustableArrowCapFillState: fn(8, onCap((cap, [at])=>out(at, ()=>
            kit.putBool(at, cap.filled === true)), true)),
        /** Status GdipSetAdjustableArrowCapFillState(GpAdjustableArrowCap *cap, BOOL filled) */
        GdipSetAdjustableArrowCapFillState: fn(8, onCap((cap, [filled])=>{
            cap.filled = filled !== 0;
            shapeArrow(cap);
            return Ok;
        }, true)),
    };
    return { functions, get };
}
