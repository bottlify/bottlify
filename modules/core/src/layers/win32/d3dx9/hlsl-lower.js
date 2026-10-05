/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The front half of the compiler: the checked tree of one entry point to
 * straight-line code over virtual registers.
 *
 * The entry point is run symbolically. Every value is a handle on operands,
 * not a number: a local variable holds what was last assigned to it, a
 * function call runs its body in place, and a loop runs as many times as its
 * test (which must be known) says. What cannot be settled at compile time
 * becomes a select. `if (c) a = x; else a = y;` runs both branches on forks of
 * the variables and joins them with `select(c, x, y)`, which is what a target
 * without branching does and what a target with it may do as well.
 *
 * A `return` inside a branch splits the rest of the function into the two
 * branches: `if (c) return a; rest` is `if (c) return a; else { rest }`, and
 * the returned values are joined by the same select. A `break` or `continue`
 * must be reached by a branch whose test is known; a loop whose test is not
 * known is not unrolled, and is reported.
 */

import { createBuilder } from './hlsl-build.js';
import { PC, PT, USAGE, registersOf } from './hlsl-ir.js';
import { baseOf, isNumeric, sameType, scalarCount, typeToString } from './hlsl-types.js';
import { lowerIntrinsic } from './hlsl-lower-intrinsics.js';

/** @typedef {import('./hlsl-build.js').Vec} Vec */
/** @typedef {import('./hlsl-types.js').Type} Type */
/** @typedef {import('./hlsl-ir.js').Const} Const */
/** @typedef {import('./hlsl-ir.js').Profile} Profile */
/** @typedef {import('./hlsl-types.js').Symbol} Symbol */
/** @typedef {import('./hlsl-types.js').Module} Module */
/** @typedef {import('./hlsl-types.js').FunctionSymbol} FunctionSymbol */
/** @typedef {import('./hlsl-lower-intrinsics.js').Value} Value */
/** @typedef {import('./hlsl-lower-intrinsics.js').State} State */
/** @typedef {import('./hlsl-lower-intrinsics.js').LowerContext} LowerContext */
/** @typedef {import('./hlsl-lower-intrinsics.js').UniformArray} UniformArray */

/** A diagnostic the lowering found. */
export class LowerError extends Error {
    /**
     * @param {string} code @param {string} message @param {any} pos
     */
    constructor(code, message, pos){
        super(message);
        this.name = 'LowerError';
        this.code = code;
        this.pos = pos;
    }
}

/** The most iterations a loop is unrolled for, as fxc's limit. */
const MAX_UNROLL = 1024;
/** The most instructions a program may grow to before it is given up on. */
const MAX_INSTRUCTIONS = 60000;

/** Semantic names, to the usage a declaration gives them. @type {Record<string, number>} */
const SEMANTICS = {
    POSITION: USAGE.POSITION, SV_POSITION: USAGE.POSITION, POSITIONT: USAGE.POSITIONT,
    BLENDWEIGHT: USAGE.BLENDWEIGHT, BLENDINDICES: USAGE.BLENDINDICES, NORMAL: USAGE.NORMAL,
    PSIZE: USAGE.PSIZE, TEXCOORD: USAGE.TEXCOORD, TANGENT: USAGE.TANGENT,
    BINORMAL: USAGE.BINORMAL, TESSFACTOR: USAGE.TESSFACTOR, COLOR: USAGE.COLOR,
    SV_TARGET: USAGE.COLOR, FOG: USAGE.FOG, DEPTH: USAGE.DEPTH, SV_DEPTH: USAGE.DEPTH,
    SAMPLE: USAGE.SAMPLE,
};

/**
 * @param {string} semantic
 * @returns {{ usage: number, index: number } | { special: 'vpos' | 'vface' } | null}
 */
export function parseSemantic(semantic){
    const upper = semantic.toUpperCase();
    if (upper === 'VPOS')
    {
        return { special: 'vpos' };
    }
    if (upper === 'VFACE')
    {
        return { special: 'vface' };
    }
    const match = /^(.*?)(\d*)$/.exec(upper);
    const usage = match ? SEMANTICS[match[1]] : undefined;
    if (!match || usage === undefined)
    {
        return null;
    }
    return { usage, index: match[2] === '' ? 0 : Number(match[2]) };
}

/** @param {Value} v @returns {Vec} */
function vecOf(v){
    if (v.k !== 'vec')
    {
        throw new Error(`internal: a ${v.k} where a vector was expected`);
    }
    return v.v;
}

/**
 * Lowers the entry point of a checked module.
 *
 * @param {Module} module
 * @param {FunctionSymbol} entry
 * @param {Profile} profile
 * @returns {{ ir: import('./hlsl-ir.js').IrProgram }}
 * @throws {LowerError}
 */
export function lower(module, entry, profile){
    const b = createBuilder(profile);

    /**
     * @param {string} code @param {string} message @param {any} pos
     * @returns {never}
     */
    const fail = (code, message, pos)=>{
        throw new LowerError(code, message, pos);
    };

    // ---- values ------------------------------------------------------------------------

    /** @param {Vec} v @returns {Value} */
    const vec = v=>({ k: 'vec', v });

    /**
     * The scalars of a value, one operand each, in the order the type flattens.
     *
     * @param {Value} value @param {Type} type
     * @returns {Vec[]}
     */
    const flatten = (value, type)=>{
        switch (value.k)
        {
            case 'vec': return Array.from({ length: value.v.w }, (_, i)=>b.lane(value.v, i));
            case 'mat': {
                /** @type {Vec[]} */
                const out = [];
                for (let r = 0; r < value.rows; r++)
                {
                    for (let c = 0; c < value.cols; c++)
                    {
                        out.push(matrixElement(value, r, c));
                    }
                }
                return out;
            }
            case 'struct': {
                const members = /** @type {Extract<Type, { kind: 'struct' }>} */ (type).members;
                return value.fields.flatMap((f, i)=>flatten(f, members[i].type));
            }
            case 'arr': {
                const elem = /** @type {Extract<Type, { kind: 'array' }>} */ (type).elem;
                return value.elems.flatMap(e=>flatten(e, elem));
            }
            default: return [];
        }
    };

    /**
     * A value of the type from scalar operands.
     *
     * @param {Type} type @param {Vec[]} scalars @param {{ at: number }} [cursor]
     * @returns {Value}
     */
    const build = (type, scalars, cursor = { at: 0 })=>{
        const take = (/** @type {number} */ n)=>{
            const parts = scalars.slice(cursor.at, cursor.at + n);
            cursor.at += n;
            while (parts.length < n)
            {
                parts.push(b.num(0));
            }
            return b.cat(parts);
        };
        switch (type.kind)
        {
            case 'scalar': return vec(take(1));
            case 'vector': return vec(take(type.n));
            case 'matrix': {
                const rowV = [];
                for (let r = 0; r < type.rows; r++)
                {
                    rowV.push(take(type.cols));
                }
                return { k: 'mat', rows: type.rows, cols: type.cols, rowV, colV: null };
            }
            case 'struct': return { k: 'struct',
                fields: type.members.map(m=>build(m.type, scalars, cursor)) };
            case 'array': return { k: 'arr',
                elems: Array.from({ length: type.length }, ()=>build(type.elem, scalars, cursor)) };
            default: return { k: 'void' };
        }
    };

    /** @param {Type} type @returns {Value} */
    const zero = type=>build(type, new Array(scalarCount(type)).fill(b.num(0)));

    /**
     * What a variable holds before anything is assigned to it: zeros, marked,
     * so that an output the program never set is not written at all.
     *
     * @param {Value} value @returns {Value}
     */
    const unset = value=>{
        switch (value.k)
        {
            case 'vec': return { ...value, undef: true };
            case 'struct': return { k: 'struct', fields: value.fields.map(unset) };
            case 'arr': return { k: 'arr', elems: value.elems.map(unset) };
            default: return value;
        }
    };

    /**
     * A value of the type from the numbers of a constant, flattened.
     *
     * @param {Type} type @param {import('./hlsl-types.js').Value} constant
     */
    const fromConstant = (type, constant)=>{
        /** @type {number[]} */
        const numbers = [];
        const walk = (/** @type {Type} */ t, /** @type {any} */ v)=>{
            switch (t.kind)
            {
                case 'scalar': numbers.push(v); break;
                case 'vector': numbers.push(...v); break;
                case 'matrix': numbers.push(...v.flat()); break;
                case 'array': v.forEach((/** @type {any} */ e)=>walk(t.elem, e)); break;
                case 'struct': t.members.forEach(m=>walk(m.type, v[m.name])); break;
                default: break;
            }
        };
        walk(type, constant);
        return build(type, numbers.map(n=>b.num(n)));
    };

    /**
     * The element at a row and column of a matrix.
     *
     * @param {Extract<Value, {k: 'mat'}>} m @param {number} r @param {number} c
     */
    const matrixElement = (m, r, c)=>(m.rowV ? b.lane(m.rowV[r], c)
        : b.lane(/** @type {Vec[]} */ (m.colV)[c], r));

    /** @param {Extract<Value, {k: 'mat'}>} m @returns {Vec[]} */
    const rowsOf = m=>m.rowV ?? Array.from({ length: m.rows }, (_, r)=>
        b.cat(Array.from({ length: m.cols }, (__, c)=>matrixElement(m, r, c))));

    /** @param {Extract<Value, {k: 'mat'}>} m @returns {Vec[]} */
    const colsOf = m=>m.colV ?? Array.from({ length: m.cols }, (_, c)=>
        b.cat(Array.from({ length: m.rows }, (__, r)=>matrixElement(m, r, c))));

    /**
     * A new matrix from a function of the rows (or columns) of one or two.
     *
     * @param {Extract<Value, {k: 'mat'}>[]} ms
     * @param {(...v: Vec[]) => Vec} f
     * @returns {Value}
     */
    const zipMatrix = (ms, f)=>{
        const [first] = ms;
        if (ms.every(m=>m.rowV) || !ms.every(m=>m.colV))
        {
            const rows = ms.map(rowsOf);
            return { k: 'mat', rows: first.rows, cols: first.cols, colV: null,
                rowV: rows[0].map((_, r)=>f(...rows.map(m=>m[r]))) };
        }
        const cols = ms.map(colsOf);
        return { k: 'mat', rows: first.rows, cols: first.cols, rowV: null,
            colV: cols[0].map((_, c)=>f(...cols.map(m=>m[c]))) };
    };

    /**
     * A function of the lanes of values of one shape: vectors, or matrices
     * row by row.
     *
     * @param {Value[]} values @param {(...v: Vec[]) => Vec} f
     * @returns {Value}
     */
    const zip = (values, f)=>{
        if (values[0].k === 'mat')
        {
            return zipMatrix(/** @type {any} */ (values), f);
        }
        return vec(f(...values.map(vecOf)));
    };

    // ---- conversions --------------------------------------------------------------------

    /**
     * One operand from one element type to another.
     *
     * @param {Vec} v @param {string} from @param {string} to
     * @returns {Vec}
     */
    const convertBase = (v, from, to)=>{
        if (from === to)
        {
            return v;
        }
        if (to === 'bool')
        {
            return from === 'bool' ? v : b.nonzero(v);
        }
        if (to === 'int' && from === 'float')
        {
            return b.trunc(v);
        }
        return v;
    };

    /**
     * A value converted from one type to another, as an implicit or explicit
     * cast does: the element type changes, a scalar spreads, a vector or
     * matrix keeps what fits.
     *
     * @param {Value} value @param {Type} from @param {Type} to
     * @returns {Value}
     */
    const convert = (value, from, to)=>{
        if ((to.kind === 'struct' || to.kind === 'array') && isNumeric(from))
        {
            // `(S)0`: the scalars fill the structure in order, one spread over all of it.
            const filler = flatten(value, from);
            return build(to, filler.length === 1 ? new Array(scalarCount(to)).fill(filler[0])
                : filler);
        }
        if (sameType(from, to) || !isNumeric(from) || !isNumeric(to))
        {
            return value;
        }
        const fromBase = /** @type {string} */ (baseOf(from));
        const toBase = /** @type {string} */ (baseOf(to));
        if (from.kind === 'matrix' && to.kind === 'matrix'
            && (from.rows !== to.rows || from.cols !== to.cols))
        {
            const m = /** @type {Extract<Value, {k: 'mat'}>} */ (value);
            if (fromBase === toBase && to.rows <= from.rows && to.cols <= from.cols)
            {
                // The corner of a matrix is the corner of its registers: no copying.
                const lanes = (/** @type {number} */ n)=>Array.from({ length: n }, (_, i)=>i);
                return { k: 'mat', rows: to.rows, cols: to.cols,
                    rowV: m.rowV && m.rowV.slice(0, to.rows).map(r=>b.swizzle(r, lanes(to.cols))),
                    colV: m.colV && m.colV.slice(0, to.cols).map(c=>b.swizzle(c, lanes(to.rows))) };
            }
            const scalars = [];
            for (let r = 0; r < to.rows; r++)
            {
                for (let c = 0; c < to.cols; c++)
                {
                    scalars.push(convertBase(matrixElement(m, r, c), fromBase, toBase));
                }
            }
            return build(to, scalars);
        }
        let scalars = flatten(value, from).map(l=>convertBase(l, fromBase, toBase));
        const need = scalarCount(to);
        if (scalars.length === 1 && need > 1)
        {
            scalars = new Array(need).fill(scalars[0]);
        }
        return build(to, scalars.slice(0, need));
    };

    // ---- joining the branches of a conditional ---------------------------------------------

    /**
     * `c ? a : b`, for any value.
     *
     * @param {Vec} c @param {Value} a @param {Value} bb
     * @returns {Value}
     */
    const choose = (c, a, bb)=>{
        if (a === bb)
        {
            return a;
        }
        switch (a.k)
        {
            case 'vec': return vec(b.select(c, a.v, vecOf(bb)));
            case 'mat':
                return zipMatrix([a, /** @type {any} */ (bb)], (x, y)=>b.select(c, x, y));
            case 'struct':
                return { k: 'struct', fields: a.fields.map((f, i)=>choose(c, f,
                    /** @type {any} */ (bb).fields[i])) };
            case 'arr':
                return { k: 'arr', elems: a.elems.map((f, i)=>choose(c, f,
                    /** @type {any} */ (bb).elems[i])) };
            default: return a;
        }
    };

    /** @param {State} st @param {Vec} c @returns {State} */
    const fork = (st, c)=>({ env: new Map(st.env), path: st.path ? b.and(st.path, c) : c });

    /**
     * The variables after a conditional: what each branch left, chosen by the
     * condition.
     *
     * @param {State} st @param {Vec} c @param {State} yes @param {State} no
     */
    const join = (st, c, yes, no)=>{
        const env = new Map();
        for (const key of new Set([...yes.env.keys(), ...no.env.keys()]))
        {
            const x = yes.env.get(key);
            const y = no.env.get(key);
            env.set(key, x !== undefined && y !== undefined ? choose(c, x, y) : x ?? y);
        }
        st.env = env;
    };

    // ---- constants -------------------------------------------------------------------------

    /** @type {Map<Symbol, Value>} */
    const uniforms = new Map();
    /** @type {Map<Const, number>} */
    const order = new Map();

    /**
     * How the constant table describes a type.
     *
     * @param {Type} type @param {boolean} rowMajor
     * @returns {import('./hlsl-ir.js').CtabType}
     */
    const ctabType = (type, rowMajor)=>{
        const pt = (/** @type {string} */ base)=>(base === 'bool' ? PT.BOOL : base === 'int'
            ? PT.INT : PT.FLOAT);
        switch (type.kind)
        {
            case 'scalar': return { cls: PC.SCALAR, type: pt(type.base), rows: 1, cols: 1,
                elements: 1 };
            case 'vector': return { cls: PC.VECTOR, type: pt(type.base), rows: 1, cols: type.n,
                elements: 1 };
            case 'matrix': return { cls: rowMajor ? PC.MATRIX_ROWS : PC.MATRIX_COLUMNS,
                type: pt(type.base), rows: type.rows, cols: type.cols, elements: 1 };
            case 'array': {
                const inner = ctabType(type.elem, rowMajor);
                return { ...inner, elements: type.length * Math.max(inner.elements, 1) };
            }
            case 'struct': {
                const members = type.members.map(m=>({ name: m.name,
                    type: ctabType(m.type, rowMajor) }));
                return { cls: PC.STRUCT, type: PT.VOID, rows: 1,
                    cols: members.reduce((n, m)=>n + registersOf(m.type), 0), elements: 1,
                    members };
            }
            case 'sampler': return { cls: PC.OBJECT, type: type.dim === '1d' ? PT.SAMPLER1D
                : type.dim === '2d' ? PT.SAMPLER2D : type.dim === '3d' ? PT.SAMPLER3D
                    : type.dim === 'cube' ? PT.SAMPLERCUBE : PT.SAMPLER, rows: 1, cols: 1,
            elements: 1 };
            default: return { cls: PC.SCALAR, type: PT.FLOAT, rows: 1, cols: 1, elements: 1 };
        }
    };

    /**
     * The value of a type held in constant registers from `offset` on.
     *
     * @param {Type} type @param {Const} cst @param {number} offset
     * @param {boolean} relative @param {boolean} rowMajor
     * @returns {Value}
     */
    const constantValue = (type, cst, offset, relative, rowMajor)=>{
        /** @param {number} at @param {number} width @returns {Vec} */
        const register = (at, width)=>b.vec({ kind: 'const', cst, offset: at,
            swz: Array.from({ length: width }, (_, i)=>i),
            ...(relative ? { relative: true } : {}) });
        switch (type.kind)
        {
            case 'scalar': return vec(register(offset, 1));
            case 'vector': return vec(register(offset, type.n));
            case 'matrix':
                return rowMajor
                    ? { k: 'mat', rows: type.rows, cols: type.cols, colV: null,
                        rowV: Array.from({ length: type.rows }, (_, r)=>register(offset + r,
                            type.cols)) }
                    : { k: 'mat', rows: type.rows, cols: type.cols, rowV: null,
                        colV: Array.from({ length: type.cols }, (_, c)=>register(offset + c,
                            type.rows)) };
            case 'array': {
                const stride = registersOf(ctabType(type.elem, rowMajor));
                return { k: 'arr', elems: Array.from({ length: type.length }, (_, i)=>
                    constantValue(type.elem, cst, offset + i * stride, relative, rowMajor)),
                uniform: { cst, base: offset, stride, elem: type.elem } };
            }
            case 'struct': {
                let at = offset;
                return { k: 'struct', fields: type.members.map(m=>{
                    const field = constantValue(m.type, cst, at, relative, rowMajor);
                    at += registersOf(ctabType(m.type, rowMajor));
                    return field;
                }) };
            }
            default: return { k: 'void' };
        }
    };

    /**
     * Writes a constant's default into register data, four floats a register.
     *
     * @param {Type} type @param {any} value @param {number[]} data @param {number} at
     * @param {boolean} rowMajor
     * @returns {number}   Registers used.
     */
    const defaultData = (type, value, data, at, rowMajor)=>{
        /** @param {number} reg @param {number} lane @param {number} x */
        const put = (reg, lane, x)=>{
            data[reg * 4 + lane] = x;
        };
        switch (type.kind)
        {
            case 'scalar': put(at, 0, value); return 1;
            case 'vector': value.forEach((/** @type {number} */ x, /** @type {number} */ i)=>
                put(at, i, x)); return 1;
            case 'matrix':
                for (let r = 0; r < type.rows; r++)
                {
                    for (let c = 0; c < type.cols; c++)
                    {
                        if (rowMajor)
                        {
                            put(at + r, c, value[r][c]);
                        }
                        else
                        {
                            put(at + c, r, value[r][c]);
                        }
                    }
                }
                return rowMajor ? type.rows : type.cols;
            case 'array': {
                let used = 0;
                for (const e of value)
                {
                    used += defaultData(type.elem, e, data, at + used, rowMajor);
                }
                return used;
            }
            case 'struct': {
                let used = 0;
                for (const m of type.members)
                {
                    used += defaultData(m.type, value[m.name], data, at + used, rowMajor);
                }
                return used;
            }
            default: return 0;
        }
    };

    /**
     * The value of a uniform (or a texture-free sampler), made when first read.
     *
     * @param {Symbol} sym
     * @returns {Value}
     */
    const uniformValue = sym=>{
        const known = uniforms.get(sym);
        if (known)
        {
            return known;
        }
        const rowMajor = sym.mods.includes('row_major')
            || (module.rowMajor && !sym.mods.includes('column_major'));
        /** @type {Value} */
        let value;
        if (sym.type.kind === 'sampler')
        {
            const dim = sym.type.dim === '1d' ? 2 : sym.type.dim === '2d' ? 2
                : sym.type.dim === '3d' ? 4 : sym.type.dim === 'cube' ? 3 : 0;
            /** @type {Const} */
            const cst = { name: sym.name, set: 's', type: ctabType(sym.type, false), dim,
                ...(sym.register && /^s\d+$/.test(sym.register.name)
                    ? { explicit: Number(sym.register.name.slice(1)) } : {}) };
            b.constants.push(cst);
            order.set(cst, sym.order);
            value = { k: 'sampler', cst, dim: sym.type.dim };
        }
        else
        {
            const type = ctabType(sym.type, rowMajor);
            /** @type {Const} */
            const cst = { name: sym.name, set: 'f', type,
                ...(sym.register && /^c\d+$/.test(sym.register.name)
                    ? { explicit: Number(sym.register.name.slice(1)) } : {}) };
            const initial = sym.init ? module.evaluateConstant(sym.init) : undefined;
            if (initial !== undefined)
            {
                const data = new Array(registersOf(type) * 4).fill(0);
                defaultData(sym.type, initial, data, 0, rowMajor);
                cst.defaults = data;
            }
            b.constants.push(cst);
            order.set(cst, sym.order);
            value = constantValue(sym.type, cst, 0, false, rowMajor);
        }
        uniforms.set(sym, value);
        return value;
    };

    // ---- the expression evaluator ----------------------------------------------------------

    /** @type {Value} */
    const VOID = { k: 'void' };

    /**
     * The literal numbers of a scalar condition, or null.
     * @param {Vec} v
     */
    const known = v=>b.literal(v);

    /**
     * Reads a variable.
     *
     * @param {Symbol} sym @param {State} st
     * @returns {Value}
     */
    const read = (sym, st)=>{
        const local = st.env.get(sym);
        if (local)
        {
            return local;
        }
        if (sym.constValue !== undefined && (sym.isStatic || sym.kind === 'local'))
        {
            return fromConstant(sym.type, sym.constValue);
        }
        if (sym.kind === 'global' && !sym.isStatic)
        {
            return uniformValue(sym);
        }
        if (sym.kind === 'param' && sym.isUniform)
        {
            return uniformValue(sym);
        }
        if (sym.kind === 'global')
        {
            // A static the entry has not set up yet.
            const value = sym.init ? ev(sym.init, st) : zero(sym.type);
            st.env.set(sym, value);
            return value;
        }
        return zero(sym.type);
    };

    /**
     * Sets a part of a vector to values.
     *
     * @param {Vec} old @param {number[]} indices @param {Vec} value
     * @returns {Vec}
     */
    const withLanes = (old, indices, value)=>{
        const parts = [];
        for (let l = 0; l < old.w; l++)
        {
            const at = indices.lastIndexOf(l);
            parts.push(at >= 0 ? b.lane(value, at) : b.lane(old, l));
        }
        return b.cat(parts);
    };

    /**
     * A value copied into registers of its own, whatever it was read from.
     *
     * @param {Value} value
     * @returns {Value}
     */
    const materialize = value=>{
        switch (value.k)
        {
            case 'vec': return vec(b.copy(value.v));
            case 'mat': return { ...value, rowV: value.rowV && value.rowV.map(b.copy),
                colV: value.colV && value.colV.map(b.copy) };
            case 'struct': return { k: 'struct', fields: value.fields.map(materialize) };
            case 'arr': return { k: 'arr', elems: value.elems.map(materialize) };
            default: return value;
        }
    };

    /**
     * The element of an array, a vector, a matrix row, picked by an operand.
     *
     * @param {Value} object @param {Type} type @param {Vec} index
     * @returns {Value}
     */
    const pick = (object, type, index)=>{
        const at = known(index);
        const count = object.k === 'arr' ? object.elems.length : object.k === 'mat' ? object.rows
            : object.k === 'vec' ? object.v.w : 0;
        const element = (/** @type {number} */ i)=>{
            const clamped = Math.max(0, Math.min(count - 1, i));
            switch (object.k)
            {
                case 'arr': return object.elems[clamped];
                case 'vec': return vec(b.lane(object.v, clamped));
                case 'mat': return vec(rowsOf(object)[clamped]);
                default: return VOID;
            }
        };
        if (at)
        {
            return element(Math.trunc(at[0]));
        }
        if (object.k === 'arr' && object.uniform)
        {
            if (profile.kind !== 'vs')
            {
                fail('X3500', 'array reference cannot be used as an l-value; not natively '
                    + 'addressable', null);
            }
            const u = object.uniform;
            // The register the element lives at is picked by the address register.
            const whole = u.stride === 1 ? b.lane(index, 0) : b.mul(b.lane(index, 0),
                b.num(u.stride));
            const address = profile.major >= 2 ? whole : b.sub(whole, b.frc(whole));
            b.address(address);
            const rowMajor = u.cst.type.cls === PC.MATRIX_ROWS
                || (u.cst.type.members ?? []).length > 0 || u.cst.type.cls === PC.MATRIX_ROWS;
            return materialize(constantValue(u.elem, u.cst, u.base, true, rowMajor));
        }
        // Not known and not in registers: each element in turn, chosen by the index.
        let result = element(0);
        for (let i = 1; i < count; i++)
        {
            result = choose(b.eq(index, b.num(i)), element(i), result);
        }
        return result;
    };

    /**
     * Stores into the part of a variable an expression names.
     *
     * @param {any} target @param {Value} value @param {State} st
     */
    const store = (target, value, st)=>{
        switch (target.kind)
        {
            case 'ident':
                st.env.set(target.sym, value);
                return;
            case 'cast':
                store(target.operand, value, st);
                return;
            case 'member': {
                const object = ev(target.object, st);
                if (target.swizzle)
                {
                    const old = vecOf(object);
                    store(target.object, vec(withLanes(old, target.swizzle, vecOf(value))), st);
                }
                else if (target.matrixSwizzle)
                {
                    const m = /** @type {Extract<Value, {k: 'mat'}>} */ (object);
                    const rows = rowsOf(m).slice();
                    /** @type {[number, number][]} */
                    const picks = target.matrixSwizzle;
                    const incoming = vecOf(value);
                    picks.forEach(([r, c], i)=>{
                        const indices = [c];
                        rows[r] = withLanes(rows[r], indices, b.lane(incoming, i));
                    });
                    store(target.object, { k: 'mat', rows: m.rows, cols: m.cols, rowV: rows,
                        colV: null }, st);
                }
                else
                {
                    const s = /** @type {Extract<Value, {k: 'struct'}>} */ (object);
                    const fields = s.fields.slice();
                    fields[target.field] = value;
                    store(target.object, { k: 'struct', fields }, st);
                }
                return;
            }
            case 'index': {
                const object = ev(target.object, st);
                const at = known(vecOf(ev(target.index, st)));
                const count = object.k === 'arr' ? object.elems.length
                    : object.k === 'mat' ? object.rows : vecOf(object).w;
                if (!at && object.k !== 'arr' && object.k !== 'mat' && object.k !== 'vec')
                {
                    fail('X3500', 'invalid index', target.pos);
                }
                /** @param {number} i @param {Value} replacement @returns {Value} */
                const replaceAt = (i, replacement)=>{
                    if (object.k === 'arr')
                    {
                        const elems = object.elems.slice();
                        elems[i] = replacement;
                        return { k: 'arr', elems };
                    }
                    if (object.k === 'mat')
                    {
                        const rows = rowsOf(object).slice();
                        rows[i] = vecOf(replacement);
                        return { k: 'mat', rows: object.rows, cols: object.cols, rowV: rows,
                            colV: null };
                    }
                    return vec(withLanes(vecOf(object), [i], vecOf(replacement)));
                };
                if (at)
                {
                    store(target.object, replaceAt(Math.max(0, Math.min(count - 1,
                        Math.trunc(at[0]))), value), st);
                    return;
                }
                // An index that is not known: every element takes the new value where it matches.
                const index = vecOf(ev(target.index, st));
                let updated = object;
                for (let i = 0; i < count; i++)
                {
                    const current = pick(object, target.object.type, b.num(i));
                    updated = replaceAt(i, choose(b.eq(index, b.num(i)), value, current));
                    // Each element is compared against the original, not the updated array.
                    if (i + 1 < count)
                    {
                        const next = updated;
                        updated = next;
                    }
                }
                store(target.object, updated, st);
                return;
            }
            default:
                fail('X3025', 'l-value specifies const object', target.pos);
        }
    };

    /**
     * Operation on the lanes of values under an operator, in the type the
     * operands were converted to.
     *
     * @param {string} op @param {Value} left @param {Value} right @param {Type} opType
     * @returns {Value}
     */
    const arithmetic = (op, left, right, opType)=>{
        const base = baseOf(opType);
        /** @type {(x: Vec, y: Vec) => Vec} */
        let f;
        switch (op)
        {
            case '+': f = b.add; break;
            case '-': f = b.sub; break;
            case '*': f = b.mul; break;
            case '/':
                f = base === 'int' ? (x, y)=>b.trunc(b.div(x, y)) : b.div;
                break;
            case '%':
                f = (x, y)=>b.mad(b.neg(y), b.trunc(b.div(x, y)), x);
                break;
            case '<': f = b.lt; break;
            case '<=': f = b.le; break;
            case '>': f = b.gt; break;
            case '>=': f = b.ge; break;
            case '==': f = b.eq; break;
            case '!=': f = b.ne; break;
            case '&&': f = b.and; break;
            case '||': f = b.or; break;
            default:
                return fail('X3000', `the '${op}' operator is not available in ${profile.name}`,
                    null);
        }
        return zip([left, right], f);
    };

    /** The operand of a condition. @param {Value} v */
    const truth = v=>{
        const x = vecOf(v);
        return x.w === 1 ? x : b.lane(x, 0);
    };

    /** @param {any} e @param {State} st @returns {Value} */
    function ev(e, st){
        if (b.instrs.length > MAX_INSTRUCTIONS)
        {
            fail('X5608', 'the shader is too large to compile', e.pos);
        }
        switch (e.kind)
        {
            case 'num': return vec(b.num(e.value));
            case 'bool': return vec(b.num(e.value ? 1 : 0));
            case 'string': return VOID;
            case 'ident': return read(e.sym, st);
            case 'cast': return convert(ev(e.operand, st), e.operand.type, e.type);
            case 'construct': return construct(e, st);
            case 'unary': {
                const x = ev(e.operand, st);
                if (e.op === '+')
                {
                    return x;
                }
                if (e.op === '-')
                {
                    return zip([x], b.neg);
                }
                if (e.op === '!')
                {
                    return zip([x], b.not);
                }
                return fail('X3000', `the '${e.op}' operator is not available in ${profile.name}`,
                    e.pos);
            }
            case 'incdec': {
                const old = ev(e.operand, st);
                const one = vec(b.num(1));
                const next = zip([old, splatTo(one, e.operand.type)],
                    e.op === '++' ? b.add : b.sub);
                store(e.operand, next, st);
                return e.prefix ? next : old;
            }
            case 'binary': {
                const left = ev(e.left, st);
                const right = ev(e.right, st);
                return arithmetic(e.op, left, right, e.opType);
            }
            case 'assign': {
                let value = ev(e.value, st);
                if (e.op !== '=')
                {
                    const current = ev(e.target, st);
                    const target = e.target.type;
                    const combined = arithmetic(e.op.slice(0, -1),
                        convert(current, target, e.opType), value, e.opType);
                    value = convert(combined, e.opType, target);
                }
                store(e.target, value, st);
                return value;
            }
            case 'cond': {
                const c = truth(ev(e.test, st));
                const test = known(c);
                if (test)
                {
                    return test[0] !== 0 ? ev(e.then, st) : ev(e.else, st);
                }
                return choose(c, ev(e.then, st), ev(e.else, st));
            }
            case 'comma': {
                let last = VOID;
                for (const part of e.exprs)
                {
                    last = ev(part, st);
                }
                return last;
            }
            case 'call': return call(e, st);
            case 'index': {
                const object = ev(e.object, st);
                const index = vecOf(ev(e.index, st));
                return pick(object, e.object.type, b.lane(index, 0));
            }
            case 'member': {
                const object = ev(e.object, st);
                if (e.swizzle)
                {
                    return vec(b.swizzle(vecOf(object), e.swizzle));
                }
                if (e.matrixSwizzle)
                {
                    const m = /** @type {Extract<Value, {k: 'mat'}>} */ (object);
                    return vec(b.cat(e.matrixSwizzle.map((/** @type {[number, number]} */ [r, c])=>
                        matrixElement(m, r, c))));
                }
                return /** @type {Extract<Value, {k: 'struct'}>} */ (object).fields[e.field];
            }
            case 'initlist': return build(e.type, e.leaves.flatMap((/** @type {any} */ leaf)=>
                flatten(ev(leaf, st), leaf.type)));
            case 'compile':
                return fail('X3000', 'compile is not an expression of a shader', e.pos);
            default:
                return fail('X3000', `unsupported expression '${e.kind}'`, e.pos);
        }
    }

    /**
     * A value spread to a type's lanes.
     * @param {Value} scalar @param {Type} type
     */
    const splatTo = (scalar, type)=>build(type, new Array(scalarCount(type))
        .fill(vecOf(scalar)));

    /** @param {any} e @param {State} st @returns {Value} */
    function construct(e, st){
        const type = e.type;
        /** @type {Vec[]} */
        const scalars = [];
        const toBase = baseOf(type);
        for (const arg of e.args)
        {
            const value = ev(arg, st);
            const from = baseOf(arg.type);
            for (const l of flatten(value, arg.type))
            {
                scalars.push(convertBase(l, from ?? 'float', toBase ?? 'float'));
            }
        }
        if (scalars.length === 1 && scalarCount(type) > 1)
        {
            return build(type, new Array(scalarCount(type)).fill(scalars[0]));
        }
        return build(type, scalars);
    }

    // ---- calls ---------------------------------------------------------------------------

    /** @param {any} e @param {State} st @returns {Value} */
    function call(e, st){
        const target = e.target;
        if (target.kind === 'user')
        {
            return callUser(e, target.fn, st);
        }
        const args = e.args.map((/** @type {any} */ a, /** @type {number} */ i)=>({
            value: target.signature.outParams?.includes(i) ? VOID : ev(a, st), type: a.type,
            expr: a }));
        return intrinsic(target.name, args, e.type, e, st);
    }

    /**
     * @param {any} e @param {FunctionSymbol} fn @param {State} st
     * @returns {Value}
     */
    function callUser(e, fn, st){
        const values = e.args.map((/** @type {any} */ a, /** @type {number} */ i)=>{
            const mode = fn.params[i].dir ?? 'in';
            return mode === 'out' ? unset(zero(fn.params[i].type)) : ev(a, st);
        });
        fn.params.forEach((p, i)=>{
            st.env.set(p, values[i]);
        });
        const body = /** @type {any} */ (fn.decl.body);
        const result = execList([body], st);
        fn.params.forEach((p, i)=>{
            if ((p.dir ?? 'in') !== 'in')
            {
                store(e.args[i], st.env.get(p) ?? zero(p.type), st);
            }
        });
        return result.value ?? VOID;
    }

    // ---- statements -----------------------------------------------------------------------

    /**
     * Whether a statement can return from the function it is in.
     * @param {any} s @returns {boolean}
     */
    const returns = s=>{
        if (!s)
        {
            return false;
        }
        switch (s.kind)
        {
            case 'return': return true;
            case 'block': return s.stmts.some(returns);
            case 'if': return returns(s.then) || returns(s.else);
            case 'for':
            case 'while':
            case 'do': return returns(s.body);
            case 'switch': return s.cases.some((/** @type {any} */ c)=>c.body.some(returns));
            default: return false;
        }
    };

    /**
     * Whether a statement breaks or continues out of a loop around it.
     * @param {any} s @returns {boolean}
     */
    const jumps = s=>{
        if (!s)
        {
            return false;
        }
        switch (s.kind)
        {
            case 'break':
            case 'continue': return true;
            case 'block': return s.stmts.some(jumps);
            case 'if': return jumps(s.then) || jumps(s.else);
            default: return false;
        }
    };

    let loopId = 0;

    /**
     * Runs a list of statements to the end of the function or of the list.
     *
     * @param {any[]} items   Statements and the markers loops leave in them.
     * @param {State} st
     * @returns {{ value?: Value }}
     */
    function execList(items, st){
        const stack = items.slice().reverse();
        while (stack.length > 0)
        {
            const s = stack.pop();
            switch (s.kind)
            {
                case 'mark':
                    break;
                case 'empty':
                    break;
                case 'block':
                    for (let i = s.stmts.length - 1; i >= 0; i--)
                    {
                        stack.push(s.stmts[i]);
                    }
                    break;
                case 'decl':
                    for (const v of s.vars)
                    {
                        st.env.set(v.sym, v.init ? ev(v.init, st) : unset(zero(v.sym.type)));
                    }
                    break;
                case 'expr':
                    ev(s.expr, st);
                    break;
                case 'return':
                    return { value: s.value ? ev(s.value, st) : VOID };
                case 'discard':
                    discard(st, b.num(-1), s.pos);
                    break;
                case 'break':
                case 'continue': {
                    // To the end of the iteration or of the loop: the markers say where.
                    const want = s.kind === 'break' ? 'end' : 'cont';
                    while (stack.length > 0)
                    {
                        const top = stack.pop();
                        if (top.kind === 'mark' && top.what === want)
                        {
                            if (want === 'cont')
                            {
                                stack.push(top);
                            }
                            break;
                        }
                    }
                    break;
                }
                case 'if': {
                    const c = truth(ev(s.test, st));
                    const test = known(c);
                    if (test)
                    {
                        const chosen = test[0] !== 0 ? s.then : s.else;
                        if (chosen)
                        {
                            stack.push(chosen);
                        }
                        break;
                    }
                    if (jumps(s.then) || jumps(s.else))
                    {
                        fail('X3511', 'unable to unroll loop, a break or continue depends on a '
                            + 'value that is not known when the shader is compiled', s.pos);
                    }
                    const rest = stack.slice().reverse();
                    const yes = fork(st, c);
                    const no = fork(st, b.not(c));
                    if (returns(s.then) || returns(s.else))
                    {
                        const a = execList([s.then, ...rest], yes);
                        const o = execList([...(s.else ? [s.else] : []), ...rest], no);
                        join(st, c, yes, no);
                        return { value: a.value && o.value ? choose(c, a.value, o.value)
                            : a.value ?? o.value };
                    }
                    execList([s.then], yes);
                    if (s.else)
                    {
                        execList([s.else], no);
                    }
                    join(st, c, yes, no);
                    break;
                }
                case 'for':
                case 'while':
                case 'do': {
                    const id = ++loopId;
                    const loop = { kind: 'iterate', id, stmt: s, count: 0,
                        first: s.kind === 'do' };
                    stack.push({ kind: 'mark', what: 'end', id });
                    stack.push(loop);
                    if (s.kind === 'for' && s.init)
                    {
                        stack.push(s.init);
                    }
                    break;
                }
                case 'iterate': {
                    const loop = s.stmt;
                    if (s.count >= MAX_UNROLL)
                    {
                        fail('X3511', 'unable to unroll loop, loop does not appear to terminate '
                            + `in a timely manner (${MAX_UNROLL} iterations)`, loop.pos);
                    }
                    let go = true;
                    if (!s.first && loop.test)
                    {
                        const c = truth(ev(loop.test, st));
                        const value = known(c);
                        if (!value)
                        {
                            fail('X3511', 'unable to unroll loop, loop does not appear to '
                                + 'terminate in a timely manner', loop.pos);
                        }
                        go = value[0] !== 0;
                    }
                    if (go)
                    {
                        // The body, then the step, then the next iteration.
                        stack.push({ ...s, count: s.count + 1, first: false });
                        if (loop.kind === 'for' && loop.step)
                        {
                            stack.push({ kind: 'expr', expr: loop.step, pos: loop.pos });
                        }
                        stack.push({ kind: 'mark', what: 'cont', id: s.id });
                        stack.push(loop.body);
                    }
                    break;
                }
                case 'switch':
                    fail('X3000', 'switch is not supported', s.pos);
                    break;
                default:
                    fail('X3000', `unsupported statement '${s.kind}'`, s.pos);
            }
        }
        return {};
    }

    /**
     * Kills the pixel where the code runs and the value is negative.
     *
     * @param {State} st @param {Vec} value @param {any} pos
     */
    const discard = (st, value, pos)=>{
        if (profile.kind !== 'ps')
        {
            fail('X3000', 'discard is only available in a pixel shader', pos);
        }
        const x = st.path ? b.select(st.path, value, b.num(1)) : value;
        b.kill(x);
    };

    // ---- intrinsics ------------------------------------------------------------------------

    /**
     * What the intrinsic functions are made of: the builder and the helpers
     * on values, shared by the evaluator above and the library of functions.
     *
     * @type {LowerContext}
     */
    const ctx = { b, profile, fail, vec, vecOf, flatten, build, convert, zero, rowsOf, colsOf,
        matrixElement, zip, zipMatrix, choose, discard, truth, known, store };

    /**
     * @param {string} name
     * @param {{ value: Value, type: Type, expr: any }[]} args
     * @param {Type} result @param {any} e @param {State} st
     * @returns {Value}
     */
    function intrinsic(name, args, result, e, st){
        return lowerIntrinsic(ctx, name, args, result, e, st);
    }

    // ---- the entry point ---------------------------------------------------------------------

    /**
     * The value arriving under a semantic.
     *
     * @param {Type} type @param {string | null} semantic @param {string} name @param {any} pos
     * @returns {Value}
     */
    const inputOf = (type, semantic, name, pos)=>{
        if (type.kind === 'struct')
        {
            return { k: 'struct', fields: type.members.map(m=>inputOf(m.type,
                m.semantic ?? semantic, m.name, pos)) };
        }
        if (!semantic)
        {
            return fail('X3502', `'${name}': input parameter '${name}' is missing a semantic`,
                pos);
        }
        const parsed = parseSemantic(semantic);
        if (!parsed)
        {
            return fail('X3000', `unknown semantic '${semantic}'`, pos);
        }
        const width = type.kind === 'vector' ? type.n : type.kind === 'scalar' ? 1 : 0;
        if (width === 0)
        {
            return fail('X3000', `'${name}': a ${typeToString(type)} cannot be a shader input`,
                pos);
        }
        if ('special' in parsed)
        {
            if (profile.kind !== 'ps' || profile.major < 3)
            {
                return fail('X3000', `${semantic} is not available in ${profile.name}`, pos);
            }
            return vec(b.vec({ kind: 'misc', which: parsed.special,
                swz: Array.from({ length: parsed.special === 'vpos' ? Math.min(width, 2) : 1 },
                    (_, i)=>i) }));
        }
        const input = b.input(parsed.usage, parsed.index, width);
        return vec(b.vec({ kind: 'input', input, swz: Array.from({ length: width }, (_, i)=>i) }));
    };

    /**
     * Sends a value to the output its semantic names.
     *
     * @param {Value} value @param {Type} type @param {string | null} semantic
     * @param {string} name @param {any} pos
     */
    const outputOf = (value, type, semantic, name, pos)=>{
        if (type.kind === 'struct')
        {
            const fields = /** @type {Extract<Value, {k: 'struct'}>} */ (value).fields;
            type.members.forEach((m, i)=>outputOf(fields[i], m.type, m.semantic ?? semantic,
                m.name, pos));
            return;
        }
        if (type.kind === 'void')
        {
            return;
        }
        if (!semantic)
        {
            fail('X3502', `'${name}': output parameter '${name}' is missing a semantic`, pos);
            return;
        }
        const parsed = parseSemantic(semantic);
        if (!parsed || 'special' in parsed)
        {
            fail('X3000', `unknown output semantic '${semantic}'`, pos);
            return;
        }
        if (type.kind !== 'scalar' && type.kind !== 'vector')
        {
            fail('X3000', `'${name}': a ${typeToString(type)} cannot be a shader output`, pos);
            return;
        }
        if (value.k === 'vec' && value.undef)
        {
            return;
        }
        const x = vecOf(value);
        b.write(b.output(parsed.usage, parsed.index, x.w), x);
    };

    /** @type {State} */
    const st = { env: new Map(), path: null };
    // Statics are set up in the order they were declared, as the entry begins.
    for (const g of module.reachableGlobals(entry).filter(one=>one.isStatic)
        .sort((x, y)=>x.order - y.order))
    {
        st.env.set(g, g.init ? ev(g.init, st) : zero(g.type));
    }
    for (const p of entry.params)
    {
        const dir = p.dir ?? 'in';
        if (p.isUniform)
        {
            continue;
        }
        st.env.set(p, dir === 'out' ? unset(zero(p.type))
            : inputOf(p.type, p.semantic, p.name, p.decl.pos));
    }
    const body = /** @type {any} */ (entry.decl.body);
    const finished = execList([body], st);
    if (entry.returnType.kind !== 'void')
    {
        outputOf(finished.value ?? zero(entry.returnType), entry.returnType, entry.semantic,
            entry.name, entry.decl.pos);
    }
    for (const p of entry.params)
    {
        if ((p.dir ?? 'in') !== 'in' && !p.isUniform)
        {
            outputOf(st.env.get(p) ?? zero(p.type), p.type, p.semantic, p.name, p.decl.pos);
        }
    }
    b.constants.sort((x, y)=>(order.get(x) ?? 0) - (order.get(y) ?? 0));
    return { ir: { profile, instrs: b.instrs, inputs: b.inputs, outputs: b.outputs,
        constants: b.constants, vregCount: b.vregCount } };
}
