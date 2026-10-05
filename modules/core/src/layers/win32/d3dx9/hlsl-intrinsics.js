/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The intrinsic functions of Direct3D 9 HLSL: how a call is typed, and what it computes.
 *
 * `resolveIntrinsic` answers the typing question the way the language reference states it:
 * the componentwise functions take scalars, vectors or matrices and promote a scalar beside a
 * vector; vectors of different lengths are cut to the shorter (the checker warns when it
 * converts the longer one); an int argument becomes float except for the functions that are
 * defined on ints. `evaluateIntrinsic` is the reference arithmetic: every float result is
 * rounded to float32 after each operation, every int is an int32.
 *
 * Choices the reference leaves open, made here:
 * - `round` rounds halfway cases up, as the add-half-and-take-the-floor sequence a shader
 *   compiles it to does;
 * - `min`, `max` and `clamp` return the other operand when one is NaN, and `saturate(NaN)` is 0;
 * - `lerp(a, b, t)` is evaluated as `a + t * (b - a)`;
 * - `fmod(a, b)` is `a - b * trunc(a / b)`;
 * - `faceforward(n, i, ng)` is `-n * sign(dot(i, ng))`, so a zero dot product gives zero;
 * - `pow` is the mathematical power, so a negative base with an integral exponent is defined.
 */

import {
    BOOL, FLOAT, VOID, RANK, baseOf, buildValue, conversionRank, flattenValue, isNumeric,
    matrixOf, toBase, vectorOf, withBase, scalarCount,
} from './hlsl-types.js';

/** @typedef {import('./hlsl-types.js').Type} Type */
/** @typedef {import('./hlsl-types.js').Value} Value */

/**
 * @typedef {Object} Signature
 * @property {string} name
 * @property {Type[]} paramTypes   What each argument is converted to.
 * @property {Type} resultType
 * @property {number[]} [outParams]   Indices of the `out` arguments, which are not converted.
 * @property {boolean} [unsupported]  The call types but has no implementation.
 */

/**
 * What the evaluation of an intrinsic needs from outside the arithmetic.
 *
 * @typedef {Object} IntrinsicHooks
 * @property {(sampler: any, op: string, mode: 'plain' | 'bias' | 'lod' | 'grad',
 *     coords: number[], extra: { value?: number, ddx?: number[], ddy?: number[] })
 *     => number[]} [sample]
 * @property {(axis: 'x' | 'y', value: Value) => Value} [derivative]
 * @property {() => void} [discard]
 */

const f32 = Math.fround;

/** @type {Map<string, (name: string, args: Type[]) => Signature | null>} */
const SPECS = new Map();

/** Intrinsics whose value is a pure function of the arguments, so a constant may fold them. */
const IMPURE = new Set(['clip', 'ddx', 'ddy', 'fwidth', 'noise']);

/**
 * The shape two or more numeric types share, as a float type. Scalars take the shape of the
 * others; vectors of different lengths shrink to the shortest; matrices shrink to the smallest
 * rows and columns; a vector beside a matrix has no common shape.
 *
 * @param {Type[]} types
 * @returns {Type | null}
 */
function unify(types){
    let vec = 0;
    let one = false;
    /** @type {{ rows: number, cols: number } | null} */
    let mat = null;
    for (const t of types)
    {
        if (t.kind === 'vector')
        {
            if (t.n === 1)
            {
                one = true;
            }
            else
            {
                vec = vec === 0 ? t.n : Math.min(vec, t.n);
            }
        }
        else if (t.kind === 'matrix')
        {
            mat = mat ? { rows: Math.min(mat.rows, t.rows), cols: Math.min(mat.cols, t.cols) }
                : { rows: t.rows, cols: t.cols };
        }
        else if (t.kind !== 'scalar')
        {
            return null;
        }
    }
    if (mat)
    {
        return vec > 0 ? null : matrixOf('float', mat.rows, mat.cols);
    }
    if (vec > 0)
    {
        return vectorOf('float', vec);
    }
    return one ? vectorOf('float', 1) : FLOAT;
}

/**
 * Accepts a signature only if every argument can reach its parameter by an implicit
 * conversion; the `out` arguments are the checker's to match.
 *
 * @param {Signature} sig @param {Type[]} args
 * @returns {Signature | null}
 */
function accept(sig, args){
    for (let i = 0; i < args.length; i++)
    {
        if (sig.outParams?.includes(i))
        {
            if (!isNumeric(args[i]))
            {
                return null;
            }
            continue;
        }
        if (conversionRank(args[i], sig.paramTypes[i]) === RANK.IMPOSSIBLE)
        {
            return null;
        }
    }
    return sig;
}

/**
 * @param {string} name @param {number} arity
 * @param {{ ints?: boolean, result?: 'same' | 'bool' }} [opts]
 */
function componentwise(name, arity, opts = {}){
    SPECS.set(name, (n, args)=>{
        if (args.length !== arity || !args.every(isNumeric))
        {
            return null;
        }
        const shape = unify(args);
        if (!shape)
        {
            return null;
        }
        const base = opts.ints && args.every(a=>baseOf(a) === 'int') ? 'int' : 'float';
        const param = withBase(shape, base);
        const result = opts.result === 'bool' ? withBase(shape, 'bool') : param;
        return accept({ name: n, paramTypes: args.map(()=>param), resultType: result }, args);
    });
}

for (const n of ['acos', 'asin', 'atan', 'ceil', 'cos', 'cosh', 'ddx', 'ddy', 'degrees', 'exp',
    'exp2', 'floor', 'frac', 'fwidth', 'log', 'log10', 'log2', 'radians', 'round', 'rsqrt',
    'saturate', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'])
{
    componentwise(n, 1);
}
componentwise('abs', 1, { ints: true });
componentwise('sign', 1, { ints: true });
for (const n of ['atan2', 'fmod', 'ldexp', 'pow', 'step'])
{
    componentwise(n, 2);
}
componentwise('max', 2, { ints: true });
componentwise('min', 2, { ints: true });
componentwise('lerp', 3);
componentwise('smoothstep', 3);
componentwise('clamp', 3, { ints: true });
for (const n of ['isfinite', 'isinf', 'isnan'])
{
    componentwise(n, 1, { result: 'bool' });
}

SPECS.set('all', (n, args)=>args.length === 1 && isNumeric(args[0])
    ? { name: n, paramTypes: [args[0]], resultType: BOOL } : null);
SPECS.set('any', SPECS.get('all') ?? (()=>null));

SPECS.set('clip', (n, args)=>{
    if (args.length !== 1 || !isNumeric(args[0]))
    {
        return null;
    }
    return { name: n, paramTypes: [withBase(args[0], 'float')], resultType: VOID };
});

SPECS.set('noise', (n, args)=>args.length === 1 && isNumeric(args[0])
    ? { name: n, paramTypes: [withBase(args[0], 'float')], resultType: FLOAT, unsupported: true }
    : null);

/**
 * @param {string} name @param {number} arity
 * @param {(shape: Type, args: Type[]) => Type | null} resultOf   Null: no such call.
 * @param {(args: Type[]) => Type | null} [paramOf]   The common vector type of the arguments.
 */
function vectorFunction(name, arity, resultOf, paramOf){
    SPECS.set(name, (n, args)=>{
        if (args.length !== arity || !args.every(isNumeric))
        {
            return null;
        }
        const shape = paramOf ? paramOf(args) : unify(args);
        if (!shape || shape.kind === 'matrix')
        {
            return null;
        }
        const result = resultOf(shape, args);
        if (!result)
        {
            return null;
        }
        return accept({ name: n, paramTypes: args.map(()=>shape), resultType: result }, args);
    });
}

vectorFunction('dot', 2, ()=>FLOAT);
vectorFunction('length', 1, ()=>FLOAT);
vectorFunction('distance', 2, ()=>FLOAT);
vectorFunction('normalize', 1, shape=>shape);
vectorFunction('reflect', 2, shape=>shape);
vectorFunction('faceforward', 3, shape=>shape);

SPECS.set('refract', (n, args)=>{
    if (args.length !== 3 || !args.every(isNumeric))
    {
        return null;
    }
    const shape = unify([args[0], args[1]]);
    if (!shape || shape.kind === 'matrix')
    {
        return null;
    }
    return accept({ name: n, paramTypes: [shape, shape, FLOAT], resultType: shape }, args);
});

SPECS.set('cross', (n, args)=>{
    if (args.length !== 2 || !args.every(a=>isNumeric(a) && a.kind !== 'matrix'
        && scalarCount(a) >= 3))
    {
        return null;
    }
    const v3 = vectorOf('float', 3);
    return accept({ name: n, paramTypes: [v3, v3], resultType: v3 }, args);
});

SPECS.set('lit', (n, args)=>args.length === 3 && args.every(a=>a.kind === 'scalar')
    ? accept({ name: n, paramTypes: [FLOAT, FLOAT, FLOAT], resultType: vectorOf('float', 4) },
        args) : null);

SPECS.set('D3DCOLORtoUBYTE4', (n, args)=>{
    const v4 = vectorOf('float', 4);
    return args.length === 1 && isNumeric(args[0])
        ? accept({ name: n, paramTypes: [v4], resultType: vectorOf('int', 4) }, args) : null;
});

SPECS.set('determinant', (n, args)=>{
    const m = args[0];
    return args.length === 1 && m.kind === 'matrix' && m.rows === m.cols
        ? { name: n, paramTypes: [withBase(m, 'float')], resultType: FLOAT } : null;
});

SPECS.set('transpose', (n, args)=>{
    const m = args[0];
    return args.length === 1 && m.kind === 'matrix'
        ? { name: n, paramTypes: [withBase(m, 'float')],
            resultType: matrixOf('float', m.cols, m.rows) } : null;
});

/** A function of one value with an `out` second argument of the same shape. */
SPECS.set('modf', (n, args)=>{
    if (args.length !== 2 || !isNumeric(args[0]) || !isNumeric(args[1]))
    {
        return null;
    }
    const t = withBase(args[0], 'float');
    return { name: n, paramTypes: [t, t], resultType: t, outParams: [1] };
});
SPECS.set('frexp', SPECS.get('modf') ?? (()=>null));
SPECS.set('sincos', (n, args)=>{
    if (args.length !== 3 || !args.every(isNumeric))
    {
        return null;
    }
    const t = withBase(args[0], 'float');
    return { name: n, paramTypes: [t, t, t], resultType: VOID, outParams: [1, 2] };
});

SPECS.set('mul', (n, args)=>{
    if (args.length !== 2 || !args.every(isNumeric))
    {
        return null;
    }
    const [a, b] = args;
    /** @param {Type} left @param {Type} right @param {Type} result */
    const sig = (left, right, result)=>accept({ name: n, paramTypes: [left, right],
        resultType: result }, args);
    if (a.kind === 'scalar' || b.kind === 'scalar')
    {
        const other = withBase(a.kind === 'scalar' ? b : a, 'float');
        return sig(a.kind === 'scalar' ? FLOAT : other, b.kind === 'scalar' ? FLOAT : other,
            other);
    }
    if (a.kind === 'vector' && b.kind === 'vector')
    {
        const k = Math.min(a.n, b.n);
        return sig(vectorOf('float', k), vectorOf('float', k), FLOAT);
    }
    if (a.kind === 'vector' && b.kind === 'matrix')
    {
        // The row vector is cut to the matrix's rows; a shorter one has nothing to multiply.
        if (a.n < b.rows)
        {
            return null;
        }
        return sig(vectorOf('float', b.rows), withBase(b, 'float'), vectorOf('float', b.cols));
    }
    if (a.kind === 'matrix' && b.kind === 'vector')
    {
        if (b.n < a.cols)
        {
            return null;
        }
        return sig(withBase(a, 'float'), vectorOf('float', a.cols), vectorOf('float', a.rows));
    }
    if (a.kind === 'matrix' && b.kind === 'matrix' && a.cols === b.rows)
    {
        return sig(withBase(a, 'float'), withBase(b, 'float'), matrixOf('float', a.rows, b.cols));
    }
    return null;
});

const TEX_DIMS = /** @type {const} */ ({ '1D': ['1d', 1], '2D': ['2d', 2], '3D': ['3d', 3],
    CUBE: ['cube', 3] });

for (const suffix of Object.keys(TEX_DIMS))
{
    for (const variant of ['', 'bias', 'grad', 'lod', 'proj'])
    {
        const [dim, count] = TEX_DIMS[/** @type {keyof typeof TEX_DIMS} */ (suffix)];
        SPECS.set(`tex${suffix}${variant}`, (n, args)=>{
            const sampler = args[0];
            if (args.length !== (variant === 'grad' ? 4 : 2) || sampler.kind !== 'sampler'
                || (sampler.dim !== 'any' && sampler.dim !== dim)
                || !args.slice(1).every(isNumeric))
            {
                return null;
            }
            const wide = vectorOf('float', 4);
            const narrow = vectorOf('float', count);
            const coords = variant === 'grad' ? [narrow, narrow, narrow] : [
                variant === '' ? narrow : wide];
            return accept({ name: n, paramTypes: [sampler, ...coords], resultType: wide }, args);
        });
    }
}

/** Every intrinsic name. */
export const INTRINSIC_NAMES = Object.freeze([...SPECS.keys()]);

/** @param {string} name */
export function isIntrinsic(name){
    return SPECS.has(name);
}

/** Whether a call with constant arguments has a value a constant expression may use. */
export function isPureIntrinsic(/** @type {string} */ name){
    return SPECS.has(name) && !IMPURE.has(name) && !name.startsWith('tex');
}

/**
 * Types a call of an intrinsic, or returns null when no overload takes these arguments (fxc
 * reports "no matching N parameter intrinsic function").
 *
 * @param {string} name @param {Type[]} argTypes
 * @returns {Signature | null}
 */
export function resolveIntrinsic(name, argTypes){
    const spec = SPECS.get(name);
    return spec ? spec(name, argTypes) : null;
}

// ---- arithmetic --------------------------------------------------------------------------

/** @param {number} x */
const sat = x=>Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;
/** @param {number} a @param {number} b */
const fmax = (a, b)=>Number.isNaN(a) ? b : Number.isNaN(b) ? a : a > b ? a : b;
/** @param {number} a @param {number} b */
const fmin = (a, b)=>Number.isNaN(a) ? b : Number.isNaN(b) ? a : a < b ? a : b;
/** @param {number} x */
const sgn = x=>x > 0 ? 1 : x < 0 ? -1 : 0;

/** @param {number} x */
function roundEven(x){
    return Number.isFinite(x) ? Math.floor(f32(x + 0.5)) : x;
}

/** The float remainder `a - b * trunc(a / b)`, rounded after each step. */
export function fmodFloat(/** @type {number} */ a, /** @type {number} */ b){
    return f32(a - f32(b * Math.trunc(f32(a / b))));
}

/** @param {number} x */
function frexpParts(x){
    if (x === 0 || !Number.isFinite(x))
    {
        return { mant: x, exp: 0 };
    }
    let exp = Math.floor(Math.log2(Math.abs(x))) + 1;
    let mant = x / Math.pow(2, exp);
    if (Math.abs(mant) >= 1)
    {
        mant /= 2;
        exp++;
    }
    else if (Math.abs(mant) < 0.5)
    {
        mant *= 2;
        exp--;
    }
    return { mant, exp };
}

/**
 * @typedef {Object} Lane
 * @property {(...x: number[]) => number} f
 * @property {(...x: number[]) => number} [i]
 */

/**
 * Per-component functions: `f` for floats, `i` where the function is also defined on ints.
 */
const LANE = new Map(/** @type {[string, Lane][]} */ ([
    ['abs', { f: Math.abs, i: x=>Math.abs(x) | 0 }],
    ['acos', { f: Math.acos }], ['asin', { f: Math.asin }], ['atan', { f: Math.atan }],
    ['atan2', { f: Math.atan2 }],
    ['ceil', { f: Math.ceil }], ['cos', { f: Math.cos }], ['cosh', { f: Math.cosh }],
    ['degrees', { f: x=>x * (180 / Math.PI) }], ['exp', { f: Math.exp }],
    ['exp2', { f: x=>Math.pow(2, x) }], ['floor', { f: Math.floor }],
    ['frac', { f: x=>x - Math.floor(x) }],
    ['ldexp', { f: (x, e)=>x * Math.pow(2, e) }],
    ['log', { f: Math.log }], ['log10', { f: Math.log10 }], ['log2', { f: Math.log2 }],
    ['pow', { f: Math.pow }], ['radians', { f: x=>x * (Math.PI / 180) }],
    ['round', { f: roundEven }], ['rsqrt', { f: x=>1 / f32(Math.sqrt(x)) }],
    ['saturate', { f: sat }], ['sign', { f: sgn, i: sgn }],
    ['sin', { f: Math.sin }], ['sinh', { f: Math.sinh }], ['sqrt', { f: Math.sqrt }],
    ['step', { f: (a, x)=>x >= a ? 1 : 0 }],
    ['tan', { f: Math.tan }], ['tanh', { f: Math.tanh }], ['trunc', { f: Math.trunc }],
    ['fmod', { f: fmodFloat }],
    ['max', { f: fmax, i: Math.max }], ['min', { f: fmin, i: Math.min }],
    ['lerp', { f: (a, b, t)=>f32(a + f32(t * f32(b - a))) }],
    ['smoothstep', { f: (a, b, x)=>{
        const t = f32(sat(f32(f32(x - a) / f32(b - a))));
        return f32(f32(t * t) * f32(3 - f32(2 * t)));
    } }],
    ['clamp', { f: (x, lo, hi)=>fmin(fmax(x, lo), hi),
        i: (x, lo, hi)=>Math.min(Math.max(x, lo), hi) }],
    ['isfinite', { f: x=>Number.isFinite(x) ? 1 : 0 }],
    ['isinf', { f: x=>x === Infinity || x === -Infinity ? 1 : 0 }],
    ['isnan', { f: x=>Number.isNaN(x) ? 1 : 0 }],
]));

/** @param {number[]} a @param {number[]} b */
function dotLanes(a, b){
    let acc = 0;
    for (let i = 0; i < a.length; i++)
    {
        acc = f32(acc + f32(a[i] * b[i]));
    }
    return acc;
}

/** @param {number[][]} m @returns {number} */
function det(m){
    const n = m.length;
    if (n === 1)
    {
        return m[0][0];
    }
    if (n === 2)
    {
        return f32(f32(m[0][0] * m[1][1]) - f32(m[0][1] * m[1][0]));
    }
    let acc = 0;
    for (let j = 0; j < n; j++)
    {
        const minor = m.slice(1).map(row=>row.filter((_, c)=>c !== j));
        const term = f32(m[0][j] * det(minor));
        acc = j % 2 === 0 ? f32(acc + term) : f32(acc - term);
    }
    return acc;
}

/**
 * @param {Value} a @param {Value} b @param {Type} at @param {Type} bt @param {Type} rt
 * @returns {Value}
 */
function mulValues(a, b, at, bt, rt){
    if (at.kind === 'scalar' || bt.kind === 'scalar')
    {
        const x = flattenValue(a, at);
        const y = flattenValue(b, bt);
        const n = Math.max(x.length, y.length);
        const out = [];
        for (let i = 0; i < n; i++)
        {
            out.push(f32(x[x.length === 1 ? 0 : i] * y[y.length === 1 ? 0 : i]));
        }
        return buildValue(rt, out);
    }
    if (at.kind === 'vector' && bt.kind === 'vector')
    {
        return dotLanes(/** @type {number[]} */ (a), /** @type {number[]} */ (b));
    }
    if (at.kind === 'vector' && bt.kind === 'matrix')
    {
        const v = /** @type {number[]} */ (a);
        const m = /** @type {number[][]} */ (b);
        return buildValue(rt, Array.from({ length: bt.cols }, (_, c)=>dotLanes(v,
            m.map(row=>row[c]))));
    }
    if (at.kind === 'matrix' && bt.kind === 'vector')
    {
        const m = /** @type {number[][]} */ (a);
        const v = /** @type {number[]} */ (b);
        return buildValue(rt, m.map(row=>dotLanes(row, v)));
    }
    const m = /** @type {number[][]} */ (a);
    const n = /** @type {number[][]} */ (b);
    const out = [];
    for (const row of m)
    {
        for (let c = 0; c < n[0].length; c++)
        {
            out.push(dotLanes(row, n.map(r=>r[c])));
        }
    }
    return buildValue(rt, out);
}

/**
 * Evaluates a call. `args` are values already converted to the signature's parameter types,
 * `argTypes` those types; an `out` argument's value is ignored and its result is put in
 * `outs` under its argument index.
 *
 * @param {string} name
 * @param {Value[]} args
 * @param {Type[]} argTypes
 * @param {Type} resultType
 * @param {IntrinsicHooks} [hooks]
 * @param {Map<number, Value>} [outs]
 * @returns {Value}
 */
export function evaluateIntrinsic(name, args, argTypes, resultType, hooks = {}, outs = new Map()){
    const lane = LANE.get(name);
    if (lane)
    {
        const lanes = args.map((a, i)=>flattenValue(a, argTypes[i]));
        const count = scalarCount(resultType);
        const isInt = baseOf(argTypes[0]) === 'int' && lane.i !== undefined;
        const fn = isInt ? /** @type {Function} */ (lane.i) : lane.f;
        const out = [];
        for (let k = 0; k < count; k++)
        {
            const v = fn(...lanes.map(l=>l[l.length === 1 ? 0 : k]));
            out.push(isInt ? v : f32(v));
        }
        return buildValue(resultType, out);
    }
    const lanes = args.map((a, i)=>argTypes[i].kind === 'sampler' ? []
        : flattenValue(a, argTypes[i]));
    switch (name)
    {
        case 'all': return lanes[0].every(x=>x !== 0) ? 1 : 0;
        case 'any': return lanes[0].some(x=>x !== 0) ? 1 : 0;
        case 'clip':
            if (lanes[0].some(x=>x < 0))
            {
                hooks.discard?.();
            }
            return 0;
        case 'noise': throw new Error('noise is not supported');
        case 'dot': return dotLanes(lanes[0], lanes[1]);
        case 'length': return f32(Math.sqrt(dotLanes(lanes[0], lanes[0])));
        case 'distance': {
            const d = lanes[0].map((x, i)=>f32(x - lanes[1][i]));
            return f32(Math.sqrt(dotLanes(d, d)));
        }
        case 'normalize': {
            const inv = f32(1 / f32(Math.sqrt(dotLanes(lanes[0], lanes[0]))));
            return buildValue(resultType, lanes[0].map(x=>f32(x * inv)));
        }
        case 'reflect': {
            const k = f32(2 * dotLanes(lanes[0], lanes[1]));
            return buildValue(resultType, lanes[0].map((x, i)=>f32(x - f32(k * lanes[1][i]))));
        }
        case 'refract': {
            const [i, n] = lanes;
            const eta = lanes[2][0];
            const ni = dotLanes(n, i);
            const k = f32(1 - f32(f32(eta * eta) * f32(1 - f32(ni * ni))));
            if (k < 0)
            {
                return buildValue(resultType, i.map(()=>0));
            }
            const s = f32(f32(eta * ni) + f32(Math.sqrt(k)));
            return buildValue(resultType, i.map((x, j)=>f32(f32(eta * x) - f32(s * n[j]))));
        }
        case 'cross': {
            const [a, b] = lanes;
            return [f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
                f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
                f32(f32(a[0] * b[1]) - f32(a[1] * b[0]))];
        }
        case 'faceforward': {
            const s = sgn(dotLanes(lanes[1], lanes[2]));
            return buildValue(resultType, lanes[0].map(x=>f32(-x * s)));
        }
        case 'lit': {
            const [ndl, ndh, m] = [lanes[0][0], lanes[1][0], lanes[2][0]];
            return [1, fmax(0, ndl), ndl < 0 || ndh < 0 ? 0 : f32(Math.pow(ndh, m)), 1];
        }
        case 'D3DCOLORtoUBYTE4': {
            const c = lanes[0];
            return [2, 1, 0, 3].map(j=>{
                const v = f32(c[j] * f32(255.001953));
                return toBase(v, 'int');
            });
        }
        case 'determinant': return det(/** @type {number[][]} */ (args[0]));
        case 'transpose': {
            const m = /** @type {number[][]} */ (args[0]);
            return m[0].map((_, c)=>m.map(row=>row[c]));
        }
        case 'modf': {
            const ip = lanes[0].map(Math.trunc);
            outs.set(1, buildValue(resultType, ip));
            return buildValue(resultType, lanes[0].map((x, i)=>Number.isFinite(x) ? x - ip[i]
                : Number.isNaN(x) ? x : 0));
        }
        case 'frexp': {
            const parts = lanes[0].map(frexpParts);
            outs.set(1, buildValue(resultType, parts.map(p=>p.exp)));
            return buildValue(resultType, parts.map(p=>p.mant));
        }
        case 'sincos':
            outs.set(1, buildValue(argTypes[1], lanes[0].map(Math.sin)));
            outs.set(2, buildValue(argTypes[2], lanes[0].map(Math.cos)));
            return 0;
        case 'mul': return mulValues(args[0], args[1], argTypes[0], argTypes[1], resultType);
        case 'ddx':
        case 'ddy':
        case 'fwidth': return evaluateDerivative(name, args[0], argTypes[0], hooks);
        default: break;
    }
    return evaluateTexture(name, args, argTypes, hooks);
}

/**
 * Texture sampling, which takes the host's answer.
 *
 * @param {string} name @param {Value[]} args @param {Type[]} argTypes
 * @param {IntrinsicHooks} hooks @returns {Value}
 */
function evaluateTexture(name, args, argTypes, hooks){
    const match = /^tex(1D|2D|3D|CUBE)(bias|grad|lod|proj)?$/.exec(name);
    if (!match)
    {
        throw new Error(`unknown intrinsic ${name}`);
    }
    if (!hooks.sample)
    {
        throw new Error('no texture sampling is available');
    }
    const count = TEX_DIMS[/** @type {keyof typeof TEX_DIMS} */ (match[1])][1];
    const mode = match[2];
    const coords = flattenValue(args[1], argTypes[1]);
    /** @type {number[]} */
    let out;
    const op = `tex${match[1]}`;
    switch (mode)
    {
        case 'bias':
        case 'lod':
            out = hooks.sample(args[0], op, mode, coords.slice(0, count), { value: coords[3] });
            break;
        case 'grad':
            out = hooks.sample(args[0], op, 'grad', coords, {
                ddx: flattenValue(args[2], argTypes[2]), ddy: flattenValue(args[3], argTypes[3]) });
            break;
        case 'proj': {
            const w = coords[3];
            out = hooks.sample(args[0], op, 'plain', coords.slice(0, count)
                .map(x=>f32(x / w)), {});
            break;
        }
        default:
            out = hooks.sample(args[0], op, 'plain', coords, {});
            break;
    }
    return out.map(x=>f32(x));
}

/**
 * The derivative functions, evaluated through the host.
 *
 * @param {'ddx' | 'ddy' | 'fwidth'} name
 * @param {Value} value @param {Type} type @param {IntrinsicHooks} hooks
 * @returns {Value}
 */
export function evaluateDerivative(name, value, type, hooks){
    if (!hooks.derivative)
    {
        throw new Error('no derivatives are available');
    }
    const lanesOf = (/** @type {Value} */ v)=>flattenValue(v, type);
    if (name === 'fwidth')
    {
        const x = lanesOf(hooks.derivative('x', value));
        const y = lanesOf(hooks.derivative('y', value));
        return buildValue(type, x.map((v, i)=>f32(f32(Math.abs(v)) + f32(Math.abs(y[i])))));
    }
    return buildValue(type, lanesOf(hooks.derivative(name === 'ddx' ? 'x' : 'y', value)));
}
