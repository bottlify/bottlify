/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The intrinsic functions, each made of the operations the builder offers.
 *
 * The functions the hardware has no instruction for are the usual identities:
 * a square root is a reciprocal of a reciprocal square root, a floor is a
 * value less its fraction, a smooth step a clamped ratio put through the cubic
 * `t * t * (3 - 2t)`. The inverse trigonometric functions are polynomials fitted
 * to the function on the interval where it is smooth, with the rest of the
 * range folded onto it by the identities `acos(-x) = pi - acos(x)` and
 * `atan(x) = pi/2 - atan(1/x)`; the fits are good to about 1e-7.
 */

/** @typedef {import('./hlsl-build.js').Vec} Vec */
/** @typedef {import('./hlsl-types.js').Type} Type */
/** @typedef {import('./hlsl-ir.js').Const} Const */
/** @typedef {import('./hlsl-ir.js').Profile} Profile */

/**
 * A value of the program: a vector (a scalar is one lane), a matrix held as
 * rows or as columns -- whichever the code that made it had -- a structure, an
 * array, or a sampler.
 *
 * @typedef {{ k: 'vec', v: Vec }
 *   | { k: 'mat', rows: number, cols: number, rowV: Vec[] | null, colV: Vec[] | null }
 *   | { k: 'struct', fields: Value[] }
 *   | { k: 'arr', elems: Value[], uniform?: UniformArray }
 *   | { k: 'sampler', cst: Const, dim: string }
 *   | { k: 'void' }} Value
 */

/**
 * An array whose elements are constant registers, which can be indexed by a
 * value that is not known: the address register picks the element.
 *
 * @typedef {Object} UniformArray
 * @property {Const} cst
 * @property {number} base      The register of element 0.
 * @property {number} stride    Registers an element takes.
 * @property {Type} elem
 */

/**
 * @typedef {Object} State
 * @property {Map<any, Value>} env      Variables by symbol; values are never changed in place.
 * @property {Vec | null} path          Under what condition this code runs, when it is not always.
 */

/**
 * What the library of intrinsic functions is given to build them from.
 *
 * @typedef {Object} LowerContext
 * @property {ReturnType<typeof import('./hlsl-build.js').createBuilder>} b
 * @property {Profile} profile
 * @property {(code: string, message: string, pos: any) => never} fail
 * @property {(v: Vec) => Value} vec
 * @property {(v: Value) => Vec} vecOf
 * @property {(value: Value, type: Type) => Vec[]} flatten
 * @property {(type: Type, scalars: Vec[]) => Value} build
 * @property {(value: Value, from: Type, to: Type) => Value} convert
 * @property {(type: Type) => Value} zero
 * @property {(m: any) => Vec[]} rowsOf
 * @property {(m: any) => Vec[]} colsOf
 * @property {(m: any, r: number, c: number) => Vec} matrixElement
 * @property {(values: Value[], f: (...v: Vec[]) => Vec) => Value} zip
 * @property {(ms: any[], f: (...v: Vec[]) => Vec) => Value} zipMatrix
 * @property {(c: Vec, a: Value, b: Value) => Value} choose
 * @property {(st: State, value: Vec, pos: any) => void} discard
 * @property {(v: Value) => Vec} truth
 * @property {(v: Vec) => number[] | null} known
 * @property {(target: any, value: Value, st: State) => void} store
 */


/** atan(x) / x as a polynomial in x*x, on [0, 1]. */
const ATAN = [0.999999437, -0.333301089, 0.199485333, -0.139159181, 0.0965653899,
    -0.0560668599, 0.0219490555, -0.00407395841];

/** acos(x) / sqrt(1 - x) as a polynomial in x, on [0, 1]. */
const ACOS = [1.5707963, -0.214598488, 0.0889740015, -0.0501444636, 0.0308067041,
    -0.0169632622, 0.00657931464, -0.00123656464];

const LOG2_E = Math.LOG2E;
const LN_2 = Math.LN2;
const LOG10_2 = Math.LOG10E * Math.LN2;

/**
 * @param {LowerContext} L
 * @param {string} name
 * @param {{ value: Value, type: Type, expr: any }[]} args
 * @param {Type} result
 * @param {any} e
 * @param {State} st
 * @returns {Value}
 */
export function lowerIntrinsic(L, name, args, result, e, st){
    const { b, vec, vecOf, zip } = L;
    const a = args.map(x=>x.value);
    const num = b.num;
    /** @param {number} i */
    const v = i=>vecOf(a[i]);
    /** @param {(x: Vec) => Vec} f */
    const each = f=>zip([a[0]], f);
    /** @param {(x: Vec, y: Vec) => Vec} f */
    const each2 = f=>zip([a[0], a[1]], f);

    /** @param {Vec} x @returns {Vec} */
    const half = x=>b.mul(x, num(0.5));
    /** Horner's rule; coefficients lowest power first. @param {number[]} c @param {Vec} x */
    const horner = (c, x)=>{
        let acc = num(c[c.length - 1], x.w);
        for (let i = c.length - 2; i >= 0; i--)
        {
            acc = b.mad(acc, x, num(c[i], x.w));
        }
        return acc;
    };
    /** atan of a value in [0, 1]. @param {Vec} x */
    const atanUnit = x=>b.mul(x, horner(ATAN, b.mul(x, x)));
    /** acos of a value in [0, 1]. @param {Vec} x */
    const acosUnit = x=>b.mul(b.sqrt(b.max(b.sub(num(1), x), num(0))), horner(ACOS, x));
    /** @param {Vec} x @returns {Vec} */
    const atan = x=>{
        const magnitude = b.abs(x);
        const high = b.max(magnitude, num(1));
        const low = b.min(magnitude, num(1));
        const r = atanUnit(b.mul(low, b.rcp(high)));
        const folded = b.select(b.gt(magnitude, num(1)), b.sub(num(Math.PI / 2), r), r);
        return b.select(b.lt(x, num(0)), b.neg(folded), folded);
    };
    /** @param {Vec} x @returns {Vec} */
    const acos = x=>{
        const r = acosUnit(b.abs(x));
        return b.select(b.lt(x, num(0)), b.sub(num(Math.PI), r), r);
    };
    /** @param {Vec} y @param {Vec} x @returns {Vec} */
    const atan2 = (y, x)=>{
        const ay = b.abs(y);
        const ax = b.abs(x);
        const big = b.max(ax, ay);
        const small = b.min(ax, ay);
        const r = atanUnit(b.mul(small, b.rcp(b.max(big, num(1e-30)))));
        const steep = b.select(b.gt(ay, ax), b.sub(num(Math.PI / 2), r), r);
        const left = b.select(b.lt(x, num(0)), b.sub(num(Math.PI), steep), steep);
        return b.select(b.lt(y, num(0)), b.neg(left), left);
    };
    /** @param {Vec} x @returns {Vec} */
    const exp = x=>b.exp2(b.mul(x, num(LOG2_E)));
    /** @param {Vec} x @returns {Vec} */
    const sign = x=>b.sub(b.gt(x, num(0)), b.lt(x, num(0)));
    /** @param {Vec} x @param {Vec} y */
    const dot = (x, y)=>b.dot(x, y);
    /** @param {Vec} x */
    const length = x=>(x.w === 1 ? b.abs(x) : b.sqrt(dot(x, x)));
    /** @param {Vec} x @returns {Vec} */
    const sat = x=>b.sat(x);

    /** The scalars of the argument as one lane each. @param {number} i */
    const scalars = i=>L.flatten(a[i], args[i].type);

    /**
     * A texture read of the dimension the function names.
     *
     * @param {number} dim   D3DSAMPLER_TEXTURE_TYPE: 2, 3 or 4.
     * @param {'plain' | 'project' | 'bias' | 'lod' | 'grad'} mode
     * @param {number} lanes   Coordinate lanes the plain form reads.
     */
    const texture = (dim, mode, lanes)=>{
        const sampler = /** @type {Extract<Value, {k: 'sampler'}>} */ (a[0]);
        if (sampler.cst.dim === 0 || sampler.cst.dim === undefined)
        {
            sampler.cst.dim = dim;
        }
        else if (sampler.cst.dim !== dim)
        {
            L.fail('X3000', `'${name}': the sampler '${sampler.cst.name}' is not of the `
                + 'dimension the function reads', e.pos);
        }
        if (b.profile.kind === 'vs' && mode !== 'lod')
        {
            L.fail('X3000', `'${name}' is not available in ${b.profile.name}`, e.pos);
        }
        if ((mode === 'lod' && !b.profile.texldl) || (mode === 'grad' && !b.profile.texldd)
            || (mode === 'bias' && !b.profile.texldb && b.profile.major < 3))
        {
            L.fail('X3000', `'${name}' is not available in ${b.profile.name}`, e.pos);
        }
        let coordinate = v(1);
        if (mode === 'plain' && name.startsWith('tex1D'))
        {
            coordinate = b.cat([b.lane(coordinate, 0), num(0)]);
        }
        else if (mode === 'plain')
        {
            coordinate = b.swizzle(coordinate, Array.from({ length: lanes }, (_, i)=>i));
        }
        const gradients = mode === 'grad' ? [v(2), v(3)] : [];
        return vec(b.sample(sampler.cst, coordinate, mode, gradients));
    };

    switch (name)
    {
        case 'abs': return each(b.abs);
        case 'saturate': return each(sat);
        case 'floor': return each(b.floor);
        case 'ceil': return each(b.ceil);
        case 'trunc': return each(b.trunc);
        case 'frac': return each(b.frc);
        case 'round': return each(x=>b.floor(b.add(x, num(0.5))));
        case 'sign': return each(sign);
        case 'sqrt': return each(b.sqrt);
        case 'rsqrt': return each(b.rsq);
        case 'exp2': return each(b.exp2);
        case 'exp': return each(exp);
        case 'log2': return each(b.log2);
        case 'log': return each(x=>b.mul(b.log2(x), num(LN_2)));
        case 'log10': return each(x=>b.mul(b.log2(x), num(LOG10_2)));
        case 'degrees': return each(x=>b.mul(x, num(180 / Math.PI)));
        case 'radians': return each(x=>b.mul(x, num(Math.PI / 180)));
        case 'sin': return each(x=>b.sincos(x).sin);
        case 'cos': return each(x=>b.sincos(x).cos);
        case 'tan': return each(x=>{
            const { sin, cos } = b.sincos(x);
            return b.div(sin, cos);
        });
        case 'sinh': return each(x=>{
            const up = exp(x);
            return half(b.sub(up, b.rcp(up)));
        });
        case 'cosh': return each(x=>{
            const up = exp(x);
            return half(b.add(up, b.rcp(up)));
        });
        case 'tanh': return each(x=>{
            const up = exp(b.min(b.max(x, num(-15)), num(15)));
            const down = b.rcp(up);
            return b.div(b.sub(up, down), b.add(up, down));
        });
        case 'atan': return each(atan);
        case 'acos': return each(acos);
        case 'asin': return each(x=>b.sub(num(Math.PI / 2), acos(x)));
        case 'atan2': return each2(atan2);
        case 'min': return each2(b.min);
        case 'max': return each2(b.max);
        case 'pow': return each2(b.pow);
        case 'step': return each2((edge, x)=>b.ge(x, edge));
        case 'fmod': return each2((x, y)=>b.mad(b.neg(y), b.trunc(b.div(x, y)), x));
        case 'clamp': return zip([a[0], a[1], a[2]], (x, lo, hi)=>b.min(b.max(x, lo), hi));
        case 'lerp': return zip([a[0], a[1], a[2]], (x, y, t)=>b.lrp(t, y, x));
        case 'smoothstep': return zip([a[0], a[1], a[2]], (lo, hi, x)=>{
            const t = sat(b.mul(b.sub(x, lo), b.rcp(b.sub(hi, lo))));
            return b.mul(b.mul(t, t), b.mad(t, num(-2), num(3)));
        });
        case 'dot': return vec(dot(v(0), v(1)));
        case 'length': return vec(length(v(0)));
        case 'distance': return vec(length(b.sub(v(0), v(1))));
        case 'normalize': return vec(b.mul(v(0), b.rsq(dot(v(0), v(0)))));
        case 'cross': {
            const x = v(0);
            const y = v(1);
            const first = b.mul(b.swizzle(x, [1, 2, 0]), b.swizzle(y, [2, 0, 1]));
            return vec(b.mad(b.swizzle(x, [2, 0, 1]), b.neg(b.swizzle(y, [1, 2, 0])), first));
        }
        case 'reflect': {
            const twice = b.mul(dot(v(1), v(0)), num(2));
            return vec(b.mad(b.neg(twice), v(1), v(0)));
        }
        case 'refract': {
            const incident = v(0);
            const normal = v(1);
            const eta = v(2);
            const d = dot(normal, incident);
            const k = b.sub(num(1), b.mul(b.mul(eta, eta), b.sub(num(1), b.mul(d, d))));
            const root = b.sqrt(b.max(k, num(0)));
            const bent = b.mad(b.neg(b.mad(eta, d, root)), normal, b.mul(eta, incident));
            return vec(b.select(b.ge(k, num(0)), bent, num(0, incident.w)));
        }
        case 'faceforward':
            return vec(b.mul(b.neg(v(0)), sign(dot(v(1), v(2)))));
        case 'lit': {
            // Diffuse and specular are zero for a light behind the surface.
            const light = v(0);
            const facing = v(1);
            const lit = b.and(b.ge(light, num(0)), b.ge(facing, num(0)));
            const specular = b.select(lit, b.pow(b.max(facing, num(0)), v(2)), num(0));
            return vec(b.cat([num(1), b.max(light, num(0)), specular, num(1)]));
        }
        case 'any':
        case 'all': {
            const lanes = scalars(0).map(x=>(baseIsBool(args[0].type) ? x : b.nonzero(x)));
            let acc = lanes[0];
            for (const l of lanes.slice(1))
            {
                acc = name === 'any' ? b.or(acc, l) : b.and(acc, l);
            }
            return vec(acc);
        }
        case 'clip': {
            const lanes = scalars(0);
            let least = lanes[0];
            for (const l of lanes.slice(1))
            {
                least = b.min(least, l);
            }
            L.discard(st, least, e.pos);
            return { k: 'void' };
        }
        case 'ddx': return each(x=>b.derivative('x', x));
        case 'ddy': return each(x=>b.derivative('y', x));
        case 'fwidth': return each(x=>b.add(b.abs(b.derivative('x', x)),
            b.abs(b.derivative('y', x))));
        case 'D3DCOLORtoUBYTE4': {
            const c = v(0);
            return vec(b.trunc(b.mul(b.swizzle(c, [2, 1, 0, 3]), num(255.001953))));
        }
        case 'sincos': {
            const { sin, cos } = b.sincos(v(0));
            L.store(args[1].expr, vec(sin), st);
            L.store(args[2].expr, vec(cos), st);
            return { k: 'void' };
        }
        case 'modf': {
            const whole = b.trunc(v(0));
            L.store(args[1].expr, vec(whole), st);
            return vec(b.sub(v(0), whole));
        }
        case 'mul': return multiply(L, a, args.map(x=>x.type));
        case 'transpose': {
            const m = /** @type {Extract<Value, {k: 'mat'}>} */ (a[0]);
            return { k: 'mat', rows: m.cols, cols: m.rows, rowV: m.colV, colV: m.rowV };
        }
        case 'determinant': return vec(determinant(L, a[0]));
        case 'tex1D': return texture(2, 'plain', 1);
        case 'tex2D': return texture(2, 'plain', 2);
        case 'tex3D': return texture(4, 'plain', 3);
        case 'texCUBE': return texture(3, 'plain', 3);
        case 'tex1Dproj': case 'tex2Dproj': return texture(2, 'project', 4);
        case 'tex3Dproj': return texture(4, 'project', 4);
        case 'texCUBEproj': return texture(3, 'project', 4);
        case 'tex1Dbias': case 'tex2Dbias': return texture(2, 'bias', 4);
        case 'tex3Dbias': return texture(4, 'bias', 4);
        case 'texCUBEbias': return texture(3, 'bias', 4);
        case 'tex1Dlod': case 'tex2Dlod': return texture(2, 'lod', 4);
        case 'tex3Dlod': return texture(4, 'lod', 4);
        case 'texCUBElod': return texture(3, 'lod', 4);
        case 'tex1Dgrad': case 'tex2Dgrad': return texture(2, 'grad', 2);
        case 'tex3Dgrad': return texture(4, 'grad', 3);
        case 'texCUBEgrad': return texture(3, 'grad', 3);
        default:
            return L.fail('X3004', `the intrinsic '${name}' is not available in ${
                b.profile.name}`, e.pos);
    }
}

/** @param {Type} type */
const baseIsBool = type=>(type.kind === 'scalar' || type.kind === 'vector'
    || type.kind === 'matrix') && type.base === 'bool';

/**
 * `mul`: a product of scalars, vectors and matrices, as the shapes say.
 *
 * @param {LowerContext} L @param {Value[]} a @param {Type[]} types
 * @returns {Value}
 */
function multiply(L, a, types){
    const { b, vec, vecOf } = L;
    const [left, right] = a;
    const one = (/** @type {Type} */ t)=>t.kind === 'scalar';
    if (one(types[0]) || one(types[1]))
    {
        const scalar = vecOf(one(types[0]) ? left : right);
        const other = one(types[0]) ? right : left;
        if (other.k === 'mat')
        {
            return L.zipMatrix([other], x=>b.mul(x, scalar));
        }
        return vec(b.mul(vecOf(other), scalar));
    }
    if (left.k === 'vec' && right.k === 'vec')
    {
        return vec(b.dot(left.v, right.v));
    }
    if (left.k === 'vec' && right.k === 'mat')
    {
        return vec(vectorTimesMatrix(L, left.v, right));
    }
    if (left.k === 'mat' && right.k === 'vec')
    {
        return vec(matrixTimesVector(L, left, right.v));
    }
    const lm = /** @type {Extract<Value, {k: 'mat'}>} */ (left);
    const rm = /** @type {Extract<Value, {k: 'mat'}>} */ (right);
    const rows = L.rowsOf(lm).map(row=>vectorTimesMatrix(L, row, rm));
    return { k: 'mat', rows: lm.rows, cols: rm.cols, rowV: rows, colV: null };
}

/**
 * A row vector times a matrix: each result lane is the vector's dot product
 * with a column, or the sum of the rows the vector weighs.
 *
 * @param {LowerContext} L @param {Vec} v @param {Extract<Value, {k: 'mat'}>} m
 * @returns {Vec}
 */
function vectorTimesMatrix(L, v, m){
    const { b } = L;
    if (m.colV)
    {
        return b.cat(m.colV.map(column=>b.dot(v, column)));
    }
    const rows = /** @type {Vec[]} */ (m.rowV);
    let acc = b.mul(b.lane(v, 0), rows[0]);
    for (let i = 1; i < rows.length; i++)
    {
        acc = b.mad(b.lane(v, i), rows[i], acc);
    }
    return acc;
}

/**
 * A matrix times a column vector.
 *
 * @param {LowerContext} L @param {Extract<Value, {k: 'mat'}>} m @param {Vec} v
 * @returns {Vec}
 */
function matrixTimesVector(L, m, v){
    const { b } = L;
    if (m.rowV)
    {
        return b.cat(m.rowV.map(row=>b.dot(row, v)));
    }
    const columns = /** @type {Vec[]} */ (m.colV);
    let acc = b.mul(b.lane(v, 0), columns[0]);
    for (let i = 1; i < columns.length; i++)
    {
        acc = b.mad(b.lane(v, i), columns[i], acc);
    }
    return acc;
}

/**
 * The determinant of a square matrix, by cofactors along the first row.
 *
 * @param {LowerContext} L @param {Value} value
 * @returns {Vec}
 */
function determinant(L, value){
    const { b } = L;
    const m = /** @type {Extract<Value, {k: 'mat'}>} */ (value);
    /** @type {Vec[][]} */
    const e = [];
    for (let r = 0; r < m.rows; r++)
    {
        e.push([]);
        for (let c = 0; c < m.cols; c++)
        {
            e[r].push(L.matrixElement(m, r, c));
        }
    }
    /** @param {Vec[][]} x @returns {Vec} */
    const det = x=>{
        if (x.length === 1)
        {
            return x[0][0];
        }
        if (x.length === 2)
        {
            return b.sub(b.mul(x[0][0], x[1][1]), b.mul(x[0][1], x[1][0]));
        }
        let acc = null;
        for (let c = 0; c < x.length; c++)
        {
            const minor = x.slice(1).map(row=>row.filter((_, i)=>i !== c));
            const term = b.mul(x[0][c], det(minor));
            acc = acc === null ? term : (c % 2 === 0 ? b.add(acc, term) : b.sub(acc, term));
        }
        return /** @type {Vec} */ (acc);
    };
    return det(e);
}
