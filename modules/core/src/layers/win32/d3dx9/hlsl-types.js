/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The semantic types of the Direct3D 9 HLSL dialect, and the values that inhabit them.
 *
 * Only three element types exist here: `bool`, `int` and `float`. `half` and `double` are
 * `float` (every Shader Model 1-3 register is a 32-bit float), and `uint`/`dword` are `int`:
 * the dialect has no distinct unsigned arithmetic, so an unsigned operand is an int32 here.
 *
 * Values of the types, as the evaluator and the intrinsics hold them: a scalar is a number
 * (a bool is 0 or 1, an int is an int32, a float is rounded to float32), a vector is an array
 * of numbers, a matrix is an array of rows, an array is an array, a struct is an object keyed
 * by member name. A sampler is whatever opaque handle the host gave.
 */

/** @typedef {import('./hlsl-lexer.js').Position} Position */
/** @typedef {import('./hlsl-parser.js').Variable} Variable */
/** @typedef {import('./hlsl-parser.js').FunctionDecl} FunctionDecl */
/** @typedef {import('./hlsl-parser.js').TechniqueDecl} TechniqueDecl */
/** @typedef {import('./hlsl-parser.js').Register} Register */

/** @typedef {'bool' | 'int' | 'float'} Base */

/**
 * @typedef {{ kind: 'void' }
 *   | { kind: 'error' }
 *   | { kind: 'string' }
 *   | { kind: 'shader' }
 *   | { kind: 'scalar', base: Base }
 *   | { kind: 'vector', base: Base, n: number }
 *   | { kind: 'matrix', base: Base, rows: number, cols: number }
 *   | { kind: 'array', elem: Type, length: number }
 *   | { kind: 'struct', name: string, members: Member[] }
 *   | { kind: 'sampler', dim: Dim }
 *   | { kind: 'texture', dim: Dim }} Type
 */

/** @typedef {'any' | '1d' | '2d' | '3d' | 'cube'} Dim */

/**
 * @typedef {Object} Member
 * @property {string} name
 * @property {Type} type
 * @property {string | null} semantic
 */

/** @typedef {number | number[] | number[][] | Object | any[]} Value */

/**
 * The names of a checked program, as the checker builds them and the evaluator reads them.
 * They live here so that the two stay free of each other.
 */

/**
 * @typedef {Object} Symbol
 * @property {number} id
 * @property {'global' | 'local' | 'param'} kind
 * @property {string} name
 * @property {Type} type
 * @property {string[]} mods
 * @property {Variable} decl
 * @property {boolean} isUniform   A non-static global, or a `uniform` (or, for the entry point,
 *     semantic-less) parameter.
 * @property {boolean} isStatic
 * @property {boolean} isConst
 * @property {Register | null} register
 * @property {string | null} semantic
 * @property {Value | undefined} constValue   Of a constant with a constant initialiser.
 * @property {any} init   The checked initialiser, converted to the type, or null.
 * @property {any} [defaultValue]   A parameter's default, as written, for a call leaving it out.
 * @property {'in' | 'out' | 'inout'} [dir]   Of a parameter.
 * @property {{ name: string, valueText: string }[]} [samplerState]
 * @property {number} order   Declaration order of a global.
 */

/**
 * @typedef {Object} FunctionSymbol
 * @property {string} name
 * @property {FunctionDecl} decl
 * @property {Symbol[]} params
 * @property {Type} returnType
 * @property {string | null} semantic
 * @property {string} overloadKey
 * @property {FunctionSymbol[]} calls    The user functions it calls, in order of first call.
 * @property {Set<Symbol>} usedGlobals   The globals its own body names.
 * @property {boolean} checked
 * @property {number} order
 * @property {number} bodyLimit
 */

/**
 * @typedef {Object} Module
 * @property {Symbol[]} globals
 * @property {Map<string, FunctionSymbol[]>} functions
 * @property {Map<string, Type>} structs
 * @property {Map<string, Type>} typedefs
 * @property {TechniqueDecl[]} techniques
 * @property {{ text: string, pos: Position }[]} pragmas
 * @property {boolean} rowMajor
 * @property {(name: string) => FunctionSymbol | undefined} findFunction
 * @property {(fn: FunctionSymbol) => FunctionSymbol[]} reachable
 * @property {(fn: FunctionSymbol) => Symbol[]} reachableGlobals
 * @property {(expr: any) => Value | undefined} evaluateConstant
 */

export const VOID = Object.freeze(/** @type {Type} */ ({ kind: 'void' }));
/** The type of an expression that already produced a diagnostic; it silences the follow-ons. */
export const ERROR = Object.freeze(/** @type {Type} */ ({ kind: 'error' }));
export const STRING = Object.freeze(/** @type {Type} */ ({ kind: 'string' }));
export const SHADER = Object.freeze(/** @type {Type} */ ({ kind: 'shader' }));
export const BOOL = Object.freeze(/** @type {Type} */ ({ kind: 'scalar', base: 'bool' }));
export const INT = Object.freeze(/** @type {Type} */ ({ kind: 'scalar', base: 'int' }));
export const FLOAT = Object.freeze(/** @type {Type} */ ({ kind: 'scalar', base: 'float' }));

/** @type {Map<string, Type>} */
const interned = new Map();

/**
 * @param {string} key @param {() => Type} make
 * @returns {Type}
 */
function intern(key, make){
    let type = interned.get(key);
    if (!type)
    {
        type = Object.freeze(make());
        interned.set(key, type);
    }
    return type;
}

/** @param {Base} base @returns {Type} */
export function scalarOf(base){
    return base === 'bool' ? BOOL : base === 'int' ? INT : FLOAT;
}

/**
 * A vector of one component stays a vector, as in HLSL: `float1` is not `float`.
 *
 * @param {Base} base @param {number} n
 * @returns {Type}
 */
export function vectorOf(base, n){
    return intern(`v${base}${n}`, ()=>({ kind: 'vector', base, n }));
}

/** @param {Base} base @param {number} rows @param {number} cols @returns {Type} */
export function matrixOf(base, rows, cols){
    return intern(`m${base}${rows}x${cols}`, ()=>({ kind: 'matrix', base, rows, cols }));
}

/** @param {Type} elem @param {number} length @returns {Type} */
export function arrayOf(elem, length){
    return Object.freeze({ kind: 'array', elem, length });
}

/** @param {string} name @param {Member[]} members @returns {Type} */
export function structOf(name, members){
    return Object.freeze({ kind: 'struct', name, members });
}

/** @param {Dim} dim @returns {Type} */
export function samplerOf(dim){
    return intern(`s${dim}`, ()=>({ kind: 'sampler', dim }));
}

/** @param {Dim} dim @returns {Type} */
export function textureOf(dim){
    return intern(`t${dim}`, ()=>({ kind: 'texture', dim }));
}

/**
 * Whatever shape and base a numeric type has, rebuilt with a different base.
 *
 * @param {Type} t @param {Base} base
 * @returns {Type}
 */
export function withBase(t, base){
    switch (t.kind)
    {
        case 'scalar': return scalarOf(base);
        case 'vector': return vectorOf(base, t.n);
        case 'matrix': return matrixOf(base, t.rows, t.cols);
        default: return t;
    }
}

/**
 * The semantic type of a parsed type. A name is looked up through `resolveNamed`, which
 * returns null for one it does not know; so does this function then.
 *
 * @param {import('./hlsl-parser.js').TypeRef} ref
 * @param {(name: string) => Type | null | undefined} resolveNamed
 * @returns {Type | null}
 */
export function fromTypeRef(ref, resolveNamed){
    switch (ref.cls)
    {
        case 'void': return VOID;
        case 'string': return STRING;
        case 'shader': return SHADER;
        case 'sampler': return samplerOf(ref.dim ?? 'any');
        case 'texture': return textureOf(ref.dim ?? 'any');
        case 'named': return resolveNamed(/** @type {string} */ (ref.name)) ?? null;
        default: break;
    }
    const s = ref.scalar;
    /** @type {Base} */
    const base = s === 'bool' ? 'bool' : (s === 'int' || s === 'uint') ? 'int' : 'float';
    if (ref.cls === 'scalar')
    {
        return scalarOf(base);
    }
    if (ref.cls === 'vector')
    {
        return vectorOf(base, ref.cols ?? 1);
    }
    return matrixOf(base, ref.rows ?? 1, ref.cols ?? 1);
}

/** @param {Type} t @returns {string} */
export function typeToString(t){
    switch (t.kind)
    {
        case 'void': return 'void';
        case 'error': return '<error>';
        case 'string': return 'string';
        case 'shader': return 'shader';
        case 'scalar': return t.base;
        case 'vector': return `${t.base}${t.n}`;
        case 'matrix': return `${t.base}${t.rows}x${t.cols}`;
        case 'array': {
            // The outermost length comes first, as it is written: float[4][2] is four of float[2].
            let dims = '';
            let inner = /** @type {Type} */ (t);
            while (inner.kind === 'array')
            {
                dims += inner.length < 0 ? '[]' : `[${inner.length}]`;
                inner = inner.elem;
            }
            return `${typeToString(inner)}${dims}`;
        }
        case 'struct': return t.name;
        case 'sampler': return t.dim === 'any' ? 'sampler' : `sampler${t.dim === 'cube' ? 'CUBE'
            : t.dim.toUpperCase()}`;
        case 'texture': return t.dim === 'any' ? 'texture' : `texture${t.dim === 'cube' ? 'CUBE'
            : t.dim.toUpperCase()}`;
        default: return '?';
    }
}

/** @param {Type} a @param {Type} b @returns {boolean} */
export function sameType(a, b){
    if (a === b)
    {
        return true;
    }
    if (a.kind !== b.kind)
    {
        return false;
    }
    switch (a.kind)
    {
        case 'scalar': return a.base === /** @type {typeof a} */ (b).base;
        case 'vector': {
            const o = /** @type {typeof a} */ (b);
            return a.base === o.base && a.n === o.n;
        }
        case 'matrix': {
            const o = /** @type {typeof a} */ (b);
            return a.base === o.base && a.rows === o.rows && a.cols === o.cols;
        }
        case 'array': {
            const o = /** @type {typeof a} */ (b);
            return a.length === o.length && sameType(a.elem, o.elem);
        }
        case 'struct': return a.name === /** @type {typeof a} */ (b).name;
        case 'sampler':
        case 'texture': return a.dim === /** @type {typeof a} */ (b).dim;
        default: return true;
    }
}

/**
 * The scalar components a value of the type flattens to, structures and arrays included;
 * zero for a type that holds no numbers.
 *
 * @param {Type} t
 * @returns {number}
 */
export function scalarCount(t){
    switch (t.kind)
    {
        case 'scalar': return 1;
        case 'vector': return t.n;
        case 'matrix': return t.rows * t.cols;
        case 'array': return t.length * scalarCount(t.elem);
        case 'struct': return t.members.reduce((sum, m)=>sum + scalarCount(m.type), 0);
        default: return 0;
    }
}

/** @param {Type} t @returns {Base | null} */
export function baseOf(t){
    return t.kind === 'scalar' || t.kind === 'vector' || t.kind === 'matrix' ? t.base : null;
}

/** @param {Type} t */
export function isNumeric(t){
    return t.kind === 'scalar' || t.kind === 'vector' || t.kind === 'matrix';
}

/**
 * Rows and columns of a numeric type (a vector is one row); null for any other type.
 *
 * @param {Type} t
 * @returns {{ rows: number, cols: number } | null}
 */
export function shapeOf(t){
    switch (t.kind)
    {
        case 'scalar': return { rows: 1, cols: 1 };
        case 'vector': return { rows: 1, cols: t.n };
        case 'matrix': return { rows: t.rows, cols: t.cols };
        default: return null;
    }
}

/** Ranks of an implicit conversion, best first; `conversionRank` returns one. */
export const RANK = Object.freeze({ EXACT: 0, PROMOTION: 1, CONVERSION: 2, TRUNCATION: 3,
    IMPOSSIBLE: 4 });

/**
 * How good an implicit conversion is, for overload resolution.
 *
 * - exact: the same type;
 * - promotion: a scalar and a one-component vector standing for each other, or a widening of
 *   the element type (bool to int, bool or int to float);
 * - conversion: a narrowing of the element type (float to int, anything to bool), a scalar
 *   replicated into a vector or matrix, or a reshape between a vector and a matrix of the same
 *   component count;
 * - truncation: the target has fewer components than the source (the compiler warns);
 * - impossible: everything else, among them any widening of a vector or matrix.
 *
 * @param {Type} from @param {Type} to
 * @returns {number}
 */
export function conversionRank(from, to){
    if (sameType(from, to))
    {
        return RANK.EXACT;
    }
    const aggregate = (/** @type {Type} */ t)=>t.kind === 'struct' || t.kind === 'array';
    if (aggregate(from) && aggregate(to))
    {
        // Aggregates of the same components in the same order, objects among them, stand for
        // each other (fxc's componentwise-equal structures and arrays).
        const a = componentsOf(from);
        const b = componentsOf(to);
        return a.length === b.length && a.every((c, i)=>c === b[i]) ? RANK.CONVERSION
            : RANK.IMPOSSIBLE;
    }
    if (!isNumeric(from) || !isNumeric(to))
    {
        return RANK.IMPOSSIBLE;
    }
    const fb = /** @type {Base} */ (baseOf(from));
    const tb = /** @type {Base} */ (baseOf(to));
    const widening = fb === tb ? 0 : (tb === 'float' || fb === 'bool') ? RANK.PROMOTION
        : RANK.CONVERSION;
    const fc = scalarCount(from);
    const tc = scalarCount(to);
    if (fc === 1)
    {
        // Replication into a wider shape is dearer than any change of element type alone, so
        // an overload that takes the scalar as it is wins.
        return Math.max(tc === 1 ? RANK.PROMOTION : RANK.CONVERSION, widening);
    }
    if (from.kind === 'matrix' && to.kind === 'matrix')
    {
        if (from.rows === to.rows && from.cols === to.cols)
        {
            return widening;
        }
        return from.rows >= to.rows && from.cols >= to.cols ? RANK.TRUNCATION
            : RANK.IMPOSSIBLE;
    }
    if (from.kind === 'vector' && to.kind === 'vector')
    {
        return from.n === to.n ? widening : from.n > to.n ? RANK.TRUNCATION : RANK.IMPOSSIBLE;
    }
    if (fc === tc)
    {
        return Math.max(RANK.CONVERSION, widening);
    }
    // A matrix into a vector or a scalar, or a vector into a scalar, keeps a prefix.
    if (fc > tc && to.kind !== 'matrix')
    {
        return RANK.TRUNCATION;
    }
    return RANK.IMPOSSIBLE;
}

// ---- values ------------------------------------------------------------------------------

/**
 * One number as an element type.
 *
 * @param {number} x @param {Base} base
 * @returns {number}
 */
export function toBase(x, base){
    switch (base)
    {
        case 'bool': return x !== 0 ? 1 : 0;
        case 'int': {
            if (Number.isNaN(x))
            {
                return 0;
            }
            if (x >= 2147483647)
            {
                return 2147483647;
            }
            if (x <= -2147483648)
            {
                return -2147483648;
            }
            return Math.trunc(x) | 0;
        }
        default: return Math.fround(x);
    }
}

/**
 * The numbers of a value, row-major, structures and arrays flattened in member order.
 *
 * @param {Value} value @param {Type} type
 * @returns {number[]}
 */
export function flattenValue(value, type){
    switch (type.kind)
    {
        case 'scalar': return /** @type {number[]} */ ([value]);
        case 'vector': return /** @type {number[]} */ (value);
        case 'matrix': return /** @type {number[][]} */ (value).flat();
        case 'array': return /** @type {any[]} */ (value).flatMap(v=>flattenValue(v, type.elem));
        case 'struct': return type.members.flatMap(m=>flattenValue(
            /** @type {any} */ (value)[m.name], m.type));
        default: return [];
    }
}

/**
 * The element type of each scalar a flattened value of the type holds.
 *
 * @param {Type} type
 * @returns {Base[]}
 */
export function flatBases(type){
    switch (type.kind)
    {
        case 'scalar':
        case 'vector':
        case 'matrix': return new Array(scalarCount(type)).fill(type.base);
        case 'array': {
            const one = flatBases(type.elem);
            /** @type {Base[]} */
            const all = [];
            for (let i = 0; i < type.length; i++)
            {
                all.push(...one);
            }
            return all;
        }
        case 'struct': return type.members.flatMap(m=>flatBases(m.type));
        default: return [];
    }
}

/**
 * The components of a type in order, as a cast between aggregates matches them: a number by
 * its element type, an object by its kind.
 *
 * @param {Type} type
 * @returns {string[]}
 */
export function componentsOf(type){
    switch (type.kind)
    {
        case 'scalar':
        case 'vector':
        case 'matrix': return new Array(scalarCount(type)).fill(`n:${type.base}`);
        case 'array':
            return Array.from({ length: type.length }, ()=>componentsOf(type.elem)).flat();
        case 'struct': return type.members.flatMap(m=>componentsOf(m.type));
        default: return [type.kind];
    }
}

/**
 * Rebuilds a value of the type from its scalars, each converted to the element type of the
 * position it lands in. Missing scalars are zero.
 *
 * @param {Type} type @param {number[]} lanes
 * @param {{ at: number }} [cursor]   Where to start; advanced past what was used.
 * @returns {Value}
 */
export function buildValue(type, lanes, cursor = { at: 0 }){
    switch (type.kind)
    {
        case 'scalar': return toBase(lanes[cursor.at++] ?? 0, type.base);
        case 'vector': {
            const out = new Array(type.n);
            for (let i = 0; i < type.n; i++)
            {
                out[i] = toBase(lanes[cursor.at++] ?? 0, type.base);
            }
            return out;
        }
        case 'matrix': {
            const out = [];
            for (let r = 0; r < type.rows; r++)
            {
                const row = new Array(type.cols);
                for (let c = 0; c < type.cols; c++)
                {
                    row[c] = toBase(lanes[cursor.at++] ?? 0, type.base);
                }
                out.push(row);
            }
            return out;
        }
        case 'array': {
            const out = [];
            for (let i = 0; i < type.length; i++)
            {
                out.push(buildValue(type.elem, lanes, cursor));
            }
            return out;
        }
        case 'struct': {
            /** @type {Record<string, Value>} */
            const out = {};
            for (const m of type.members)
            {
                out[m.name] = buildValue(m.type, lanes, cursor);
            }
            return out;
        }
        default: return 0;
    }
}

/** The all-zero value of a type. @param {Type} type @returns {Value} */
export function zeroValue(type){
    return buildValue(type, []);
}

/** A deep copy: values have value semantics. @param {Value} v @returns {Value} */
export function cloneValue(v){
    if (typeof v !== 'object' || v === null)
    {
        return v;
    }
    if (Array.isArray(v))
    {
        return v.map(x=>cloneValue(x));
    }
    /** @type {Record<string, Value>} */
    const out = {};
    for (const key of Object.keys(v))
    {
        out[key] = cloneValue(/** @type {any} */ (v)[key]);
    }
    return out;
}

/**
 * Converts a value between the numeric types as an implicit or explicit cast does: a
 * one-component source replicates; a smaller target keeps the leading components (a matrix
 * keeps its upper-left block); a vector and a matrix of the same count reshape row-major;
 * the element type converts per component. A number into a structure or an array fills it;
 * an array or a structure into the same type only copies.
 *
 * @param {Value} value @param {Type} from @param {Type} to
 * @returns {Value}
 */
export function convertValue(value, from, to){
    if (isNumeric(from) && (to.kind === 'struct' || to.kind === 'array'))
    {
        const lanes = flattenValue(value, from);
        return buildValue(to, lanes.length === 1 ? new Array(scalarCount(to)).fill(lanes[0])
            : lanes);
    }
    if (!isNumeric(from) || !isNumeric(to))
    {
        return cloneValue(value);
    }
    if (from.kind === 'matrix' && to.kind === 'matrix'
        && (from.rows !== to.rows || from.cols !== to.cols))
    {
        const src = /** @type {number[][]} */ (value);
        const lanes = [];
        for (let r = 0; r < to.rows; r++)
        {
            for (let c = 0; c < to.cols; c++)
            {
                lanes.push(src[r][c]);
            }
        }
        return buildValue(to, lanes);
    }
    const lanes = flattenValue(value, from);
    if (lanes.length === 1 && scalarCount(to) > 1)
    {
        return buildValue(to, new Array(scalarCount(to)).fill(lanes[0]));
    }
    return buildValue(to, lanes);
}

/**
 * A value handed in from outside, made exact for the type: missing members and elements are
 * zero, every number is converted to the element type of its place.
 *
 * @param {any} value @param {Type} type
 * @returns {Value}
 */
export function normalizeValue(value, type){
    if (value === undefined || value === null)
    {
        return zeroValue(type);
    }
    switch (type.kind)
    {
        case 'scalar': return toBase(Number(value), type.base);
        case 'vector': return Array.from({ length: type.n }, (_, i)=>toBase(
            Number(value[i] ?? 0), type.base));
        case 'matrix': return Array.from({ length: type.rows }, (_, r)=>Array.from(
            { length: type.cols }, (__, c)=>toBase(Number(value[r]?.[c] ?? 0), type.base)));
        case 'array': return Array.from({ length: type.length }, (_, i)=>normalizeValue(
            value[i], type.elem));
        case 'struct': {
            /** @type {Record<string, Value>} */
            const out = {};
            for (const m of type.members)
            {
                out[m.name] = normalizeValue(value[m.name], m.type);
            }
            return out;
        }
        default: return value;
    }
}
