/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An interpreter for the checked HLSL tree: the reference semantics a compiled program is
 * compared against. It knows nothing of registers, instructions or hardware limits.
 *
 * Values are the ones of `hlsl-types.js`. Float arithmetic is rounded to float32 after every
 * operation, ints are int32, a bool is 0 or 1.
 *
 * Decisions where the language leaves room:
 * - Shader Model 3 evaluates both sides of `&&`, `||` and `?:`, so does this interpreter:
 *   a side effect of the side that is not taken still happens.
 * - Integer division by zero yields 0 and `%` by zero yields 0; neither throws. Division
 *   truncates toward zero and `%` takes the sign of the dividend.
 * - `discard` and `clip` only record that the pixel is killed; execution goes on as it does on
 *   the hardware, so the outputs of a killed run are whatever was computed.
 * - A `static` global starts as its initialiser, evaluated on first use in each top-level
 *   run; a `static` local is initialised once per run and keeps its value across calls.
 * - An array index outside the array throws a RangeError.
 */

import {
    buildValue, cloneValue, convertValue, flattenValue, normalizeValue, zeroValue,
} from './hlsl-types.js';
import { evaluateIntrinsic, fmodFloat, isPureIntrinsic } from './hlsl-intrinsics.js';

/** @typedef {import('./hlsl-types.js').Type} Type */
/** @typedef {import('./hlsl-types.js').Value} Value */
/** @typedef {import('./hlsl-types.js').Symbol} Symbol */
/** @typedef {import('./hlsl-types.js').FunctionSymbol} FunctionSymbol */
/** @typedef {import('./hlsl-types.js').Module} Module */

/**
 * @typedef {Object} Environment
 * @property {(sym: Symbol) => Value} [uniform]   Called lazily for each uniform that is read;
 *     without it, reading one throws.
 * @property {(sampler: Symbol, op: string, mode: 'plain' | 'bias' | 'lod' | 'grad',
 *     coords: number[], extra: { value?: number, ddx?: number[], ddy?: number[] })
 *     => number[]} [sample]
 * @property {(axis: 'x' | 'y', value: Value) => Value} [derivative]
 * @property {number} [maxIterations]
 */

/**
 * @typedef {Object} CallResult
 * @property {Value | undefined} result   Undefined for a void function.
 * @property {Map<number, Value>} outs    Final values of the out and inout parameters, by index.
 * @property {boolean} killed
 */

const f32 = Math.fround;

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

/** Thrown inside `evaluateConstant` when the expression has no constant value. */
const NOT_CONSTANT = { notConstant: true };

/** @typedef {{ value: Value }} Cell */
/** @typedef {{ cells: Map<Symbol, Cell>, ret: Value | undefined }} Frame */
/** @typedef {{ get: () => Value, set: (v: Value) => void }} Ref */

/**
 * @typedef {Object} Run
 * @property {boolean} killed
 * @property {Map<Symbol, Cell>} uniforms
 * @property {Map<Symbol, Cell>} statics
 */

/**
 * The lanes of an operator applied to the lanes of its operands.
 *
 * @param {string} op @param {number[]} a @param {number[]} b
 * @param {'bool' | 'int' | 'float'} base   The element type the operands are in.
 * @returns {number[]}
 */
function binaryLanes(op, a, b, base){
    const n = Math.max(a.length, b.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++)
    {
        const x = a[a.length === 1 ? 0 : i];
        const y = b[b.length === 1 ? 0 : i];
        out[i] = binaryLane(op, x, y, base);
    }
    return out;
}

/**
 * @param {string} op @param {number} x @param {number} y @param {'bool' | 'int' | 'float'} base
 * @returns {number}
 */
function binaryLane(op, x, y, base){
    switch (op)
    {
        case '<': return x < y ? 1 : 0;
        case '>': return x > y ? 1 : 0;
        case '<=': return x <= y ? 1 : 0;
        case '>=': return x >= y ? 1 : 0;
        case '==': return x === y ? 1 : 0;
        case '!=': return x !== y ? 1 : 0;
        case '&&': return x !== 0 && y !== 0 ? 1 : 0;
        case '||': return x !== 0 || y !== 0 ? 1 : 0;
        case '&': return x & y;
        case '|': return x | y;
        case '^': return x ^ y;
        case '<<': return x << (y & 31);
        case '>>': return x >> (y & 31);
        default: break;
    }
    if (base === 'float')
    {
        switch (op)
        {
            case '+': return f32(x + y);
            case '-': return f32(x - y);
            case '*': return f32(x * y);
            case '/': return f32(x / y);
            case '%': return fmodFloat(x, y);
            default: break;
        }
    }
    else
    {
        switch (op)
        {
            case '+': return (x + y) | 0;
            case '-': return (x - y) | 0;
            case '*': return Math.imul(x, y);
            case '/': return y === 0 ? 0 : Math.trunc(x / y) | 0;
            case '%': return y === 0 ? 0 : (x % y) | 0;
            default: break;
        }
    }
    throw new Error(`unknown operator ${op}`);
}

/**
 * @param {Module} module
 * @param {Environment} [env]
 */
export function createEvaluator(module, env = /** @type {Environment} */ ({})){
    const maxIterations = env.maxIterations ?? 100000;
    /** @type {Run | null} */
    let run = null;
    let constMode = false;

    /** @param {Symbol} sym @returns {Value} */
    const uniformOf = sym=>{
        if (!env.uniform)
        {
            throw new Error(`no value for ${sym.name}`);
        }
        return env.uniform(sym);
    };

    const current = ()=>{
        if (!run)
        {
            run = { killed: false, uniforms: new Map(), statics: new Map() };
        }
        return run;
    };

    /** @type {import('./hlsl-intrinsics.js').IntrinsicHooks} */
    const hooks = {
        sample: (s, op, mode, coords, extra)=>{
            if (!env.sample)
            {
                throw new Error('the environment has no sample function');
            }
            return env.sample(s, op, mode, coords, extra);
        },
        derivative: (axis, value)=>{
            if (!env.derivative)
            {
                throw new Error('the environment has no derivative function');
            }
            return env.derivative(axis, value);
        },
        discard: ()=>{
            current().killed = true;
        },
    };

    /** @param {Symbol} sym @returns {Cell} */
    function globalCell(sym){
        const r = current();
        if (sym.isStatic)
        {
            let cell = r.statics.get(sym);
            if (!cell)
            {
                cell = { value: zeroValue(sym.type) };
                r.statics.set(sym, cell);
                if (sym.init)
                {
                    cell.value = cloneValue(ev(sym.init, newFrame()));
                }
            }
            return cell;
        }
        let cell = r.uniforms.get(sym);
        if (!cell)
        {
            if (sym.type.kind === 'sampler' || sym.type.kind === 'texture')
            {
                cell = { value: /** @type {any} */ (sym) };
            }
            else
            {
                cell = { value: normalizeValue(uniformOf(sym), sym.type) };
            }
            r.uniforms.set(sym, cell);
        }
        return cell;
    }

    /** @returns {Frame} */
    function newFrame(){
        return { cells: new Map(), ret: undefined };
    }

    /** @param {Symbol} sym @param {Frame} frame @returns {Cell} */
    function cellOf(sym, frame){
        if (sym.kind === 'global')
        {
            return globalCell(sym);
        }
        let cell = frame.cells.get(sym);
        if (!cell)
        {
            cell = { value: zeroValue(sym.type) };
            frame.cells.set(sym, cell);
        }
        return cell;
    }

    /**
     * Where an l-value lives, with its index expressions evaluated once.
     *
     * @param {any} e @param {Frame} frame
     * @returns {Ref}
     */
    function lref(e, frame){
        switch (e.kind)
        {
            case 'ident': {
                if (constMode)
                {
                    throw NOT_CONSTANT;
                }
                const cell = cellOf(e.sym, frame);
                return { get: ()=>cell.value, set: v=>{
                    cell.value = cloneValue(v);
                } };
            }
            case 'member': {
                const base = lref(e.object, frame);
                if (e.field !== undefined)
                {
                    const name = e.fieldName;
                    return { get: ()=>/** @type {any} */ (base.get())[name], set: v=>{
                        /** @type {any} */ (base.get())[name] = cloneValue(v);
                    } };
                }
                if (e.matrixSwizzle)
                {
                    /** @type {[number, number][]} */
                    const picks = e.matrixSwizzle;
                    return {
                        get: ()=>{
                            const m = /** @type {number[][]} */ (base.get());
                            const out = picks.map(([r, c])=>m[r][c]);
                            return out.length === 1 ? out[0] : out;
                        },
                        set: v=>{
                            const m = /** @type {number[][]} */ (base.get());
                            const lanes = Array.isArray(v) ? v : [v];
                            picks.forEach(([r, c], i)=>{
                                m[r][c] = lanes[i];
                            });
                        },
                    };
                }
                /** @type {number[]} */
                const idx = e.swizzle;
                const scalar = e.object.type.kind === 'scalar';
                return {
                    get: ()=>{
                        const cur = base.get();
                        const lanes = scalar ? [(cur)]
                            : /** @type {number[]} */ (cur);
                        const out = idx.map(i=>lanes[i]);
                        return out.length === 1 ? out[0] : out;
                    },
                    set: v=>{
                        const lanes = Array.isArray(v) ? v : [v];
                        if (scalar)
                        {
                            base.set(lanes[0]);
                            return;
                        }
                        const cur = /** @type {number[]} */ (base.get());
                        idx.forEach((i, k)=>{
                            cur[i] = lanes[k];
                        });
                    },
                };
            }
            case 'index': {
                const base = lref(e.object, frame);
                const i = Number(ev(e.index, frame));
                const kind = e.object.type.kind;
                return {
                    get: ()=>element(/** @type {any} */ (base.get()), i, e.object.type),
                    set: v=>{
                        const cur = /** @type {any} */ (base.get());
                        element(cur, i, e.object.type);
                        if (kind === 'matrix')
                        {
                            /** @type {number[]} */ (v).forEach((x, j)=>{
                                cur[i][j] = x;
                            });
                        }
                        else
                        {
                            cur[i] = cloneValue(v);
                        }
                    },
                };
            }
            default: {
                // Not an l-value in the language; evaluated once and held.
                const value = ev(e, frame);
                return { get: ()=>value, set: ()=>{} };
            }
        }
    }

    /**
     * @param {any[]} container @param {number} i @param {Type} type
     * @returns {Value}
     */
    function element(container, i, type){
        const length = type.kind === 'array' ? type.length : type.kind === 'vector' ? type.n
            : type.kind === 'matrix' ? type.rows : 1;
        if (!Number.isInteger(i) || i < 0 || i >= length)
        {
            throw new RangeError(`index ${i} is outside 0..${length - 1}`);
        }
        return container[i];
    }

    /**
     * @param {FunctionSymbol} fn
     * @param {(Value | undefined)[]} given   Values for the in and inout parameters.
     * @returns {{ frame: Frame, result: Value | undefined }}
     */
    function invoke(fn, given){
        const body = fn.decl.body;
        if (!body)
        {
            throw new Error(`function ${fn.name} has no body`);
        }
        const frame = newFrame();
        fn.params.forEach((p, i)=>{
            const value = given[i];
            const opaque = p.type.kind === 'sampler' || p.type.kind === 'texture';
            frame.cells.set(p, { value: value === undefined ? zeroValue(p.type)
                : opaque ? value : cloneValue(value) });
        });
        exec(body, frame);
        return { frame, result: frame.ret };
    }

    /** @param {Value} v @returns {boolean} */
    const truth = v=>v !== 0;

    /**
     * @param {any} e @param {Frame} frame
     * @returns {Value}
     */
    function ev(e, frame){
        switch (e.kind)
        {
            case 'num': return e.type.kind === 'scalar' && e.type.base === 'int'
                ? e.value | 0 : f32(e.value);
            case 'bool': return e.value ? 1 : 0;
            case 'string': return e.value;
            case 'ident': {
                const sym = e.sym;
                if (constMode)
                {
                    if (sym.constValue === undefined)
                    {
                        throw NOT_CONSTANT;
                    }
                    return cloneValue(sym.constValue);
                }
                return cellOf(sym, frame).value;
            }
            case 'unary': return evalUnary(e, frame);
            case 'incdec': {
                if (constMode)
                {
                    throw NOT_CONSTANT;
                }
                const ref = lref(e.operand, frame);
                const old = cloneValue(ref.get());
                const isInt = e.operand.type.base === 'int';
                const step = e.op === '++' ? 1 : -1;
                const lanes = flattenValue(old, e.operand.type)
                    .map(x=>isInt ? (x + step) | 0 : f32(x + step));
                const updated = buildValue(e.operand.type, lanes);
                ref.set(updated);
                return e.prefix ? updated : old;
            }
            case 'binary': {
                const type = e.opType;
                const a = flattenValue(ev(e.left, frame), type);
                const b = flattenValue(ev(e.right, frame), type);
                return buildValue(e.type, binaryLanes(e.op, a, b, type.base));
            }
            case 'assign': return evalAssign(e, frame);
            case 'cond': {
                const test = ev(e.test, frame);
                const yes = ev(e.then, frame);
                const no = ev(e.else, frame);
                return truth(test) ? yes : no;
            }
            case 'comma': {
                let last = 0;
                for (const x of e.exprs)
                {
                    last = /** @type {any} */ (ev(x, frame));
                }
                return last;
            }
            case 'call': return evalCall(e, frame);
            case 'construct': {
                const lanes = e.args.flatMap((/** @type {any} */ a)=>flattenValue(ev(a, frame),
                    a.type));
                const count = flattenValue(zeroValue(e.type), e.type).length;
                return buildValue(e.type, lanes.length === 1 && count > 1
                    ? new Array(count).fill(lanes[0]) : lanes);
            }
            case 'cast': return convertValue(ev(e.operand, frame), e.operand.type, e.type);
            case 'member': {
                const obj = ev(e.object, frame);
                if (e.field !== undefined)
                {
                    return /** @type {any} */ (obj)[e.fieldName];
                }
                if (e.matrixSwizzle)
                {
                    const m = /** @type {number[][]} */ (obj);
                    const out = e.matrixSwizzle.map((/** @type {number[]} */ p)=>m[p[0]][p[1]]);
                    return out.length === 1 ? out[0] : out;
                }
                const lanes = e.object.type.kind === 'scalar' ? [(obj)]
                    : /** @type {number[]} */ (obj);
                const out = e.swizzle.map((/** @type {number} */ i)=>lanes[i]);
                return out.length === 1 ? out[0] : out;
            }
            case 'index': {
                const obj = /** @type {any} */ (ev(e.object, frame));
                const i = Number(ev(e.index, frame));
                return element(obj, i, e.object.type);
            }
            case 'initlist': {
                const lanes = e.leaves.flatMap((/** @type {any} */ l)=>flattenValue(
                    ev(l, frame), l.type));
                return buildValue(e.type, lanes);
            }
            default:
                throw new Error(`cannot evaluate a ${e.kind} expression`);
        }
    }

    /** @param {any} e @param {Frame} frame @returns {Value} */
    function evalUnary(e, frame){
        const type = e.opType;
        const lanes = flattenValue(ev(e.operand, frame), type);
        const isInt = type.base !== 'float';
        switch (e.op)
        {
            case '-': return buildValue(e.type, lanes.map(x=>isInt ? (-x) | 0 : f32(-x)));
            case '+': return buildValue(e.type, lanes);
            case '!': return buildValue(e.type, lanes.map(x=>x === 0 ? 1 : 0));
            case '~': return buildValue(e.type, lanes.map(x=>~x));
            default: throw new Error(`unknown unary operator ${e.op}`);
        }
    }

    /** @param {any} e @param {Frame} frame @returns {Value} */
    function evalAssign(e, frame){
        if (constMode)
        {
            throw NOT_CONSTANT;
        }
        const ref = lref(e.target, frame);
        const value = ev(e.value, frame);
        if (e.op === '=')
        {
            ref.set(value);
            return ref.get();
        }
        const type = e.opType;
        const cur = flattenValue(convertValue(ref.get(), e.target.type, type), type);
        const rhs = flattenValue(value, type);
        const lanes = binaryLanes(e.op.slice(0, -1), cur, rhs, type.base);
        ref.set(convertValue(buildValue(type, lanes), type, e.target.type));
        return ref.get();
    }

    /** @param {any} e @param {Frame} frame @returns {Value} */
    function evalCall(e, frame){
        const target = e.target;
        if (target.kind === 'intrinsic')
        {
            const sig = target.signature;
            const outIdx = sig.outParams ?? [];
            if (constMode && !isPureIntrinsic(sig.name))
            {
                throw NOT_CONSTANT;
            }
            /** @type {Ref[]} */
            const refs = [];
            const values = e.args.map((/** @type {any} */ a, /** @type {number} */ i)=>{
                if (outIdx.includes(i))
                {
                    if (constMode)
                    {
                        throw NOT_CONSTANT;
                    }
                    refs[i] = lref(a, frame);
                    return zeroValue(sig.paramTypes[i]);
                }
                return ev(a, frame);
            });
            /** @type {Map<number, Value>} */
            const outs = new Map();
            const result = evaluateIntrinsic(sig.name, values, sig.paramTypes, sig.resultType,
                hooks, outs);
            for (const i of outIdx)
            {
                refs[i].set(convertValue(/** @type {Value} */ (outs.get(i)), sig.paramTypes[i],
                    e.args[i].type));
            }
            return result;
        }
        if (constMode)
        {
            throw NOT_CONSTANT;
        }
        const fn = target.fn;
        /** @type {Ref[]} */
        const refs = [];
        const given = e.args.map((/** @type {any} */ a, /** @type {number} */ i)=>{
            const mode = e.argModes[i];
            const p = fn.params[i];
            if (mode === 'in')
            {
                return ev(a, frame);
            }
            refs[i] = lref(a, frame);
            return mode === 'inout' ? convertValue(refs[i].get(), a.type, p.type) : undefined;
        });
        const { frame: callee, result } = invoke(fn, given);
        e.args.forEach((/** @type {any} */ a, /** @type {number} */ i)=>{
            if (e.argModes[i] !== 'in')
            {
                const p = fn.params[i];
                refs[i].set(convertValue(/** @type {Cell} */ (callee.cells.get(p)).value, p.type,
                    a.type));
            }
        });
        return result === undefined ? 0 : result;
    }

    /**
     * @param {any} s @param {Frame} frame
     * @returns {number} how the statement ended
     */
    function exec(s, frame){
        switch (s.kind)
        {
            case 'block':
                for (const x of s.stmts)
                {
                    const sig = exec(x, frame);
                    if (sig !== NORMAL)
                    {
                        return sig;
                    }
                }
                return NORMAL;
            case 'decl':
                for (const v of s.vars)
                {
                    declare(v, frame);
                }
                return NORMAL;
            case 'expr':
                ev(s.expr, frame);
                return NORMAL;
            case 'if':
                if (truth(ev(s.test, frame)))
                {
                    return exec(s.then, frame);
                }
                return s.else ? exec(s.else, frame) : NORMAL;
            case 'for':
            case 'while':
            case 'do':
                return loop(s, frame);
            case 'switch': return runSwitch(s, frame);
            case 'break': return BREAK;
            case 'continue': return CONTINUE;
            case 'discard':
                current().killed = true;
                return NORMAL;
            case 'return':
                frame.ret = s.value ? cloneValue(ev(s.value, frame)) : undefined;
                return RETURN;
            case 'empty': return NORMAL;
            default: throw new Error(`cannot execute a ${s.kind} statement`);
        }
    }

    /** @param {any} v @param {Frame} frame */
    function declare(v, frame){
        const sym = v.sym;
        if (sym.isStatic)
        {
            const r = current();
            let cell = r.statics.get(sym);
            if (!cell)
            {
                cell = { value: v.init ? cloneValue(ev(v.init, frame)) : zeroValue(sym.type) };
                r.statics.set(sym, cell);
            }
            frame.cells.set(sym, cell);
            return;
        }
        frame.cells.set(sym, { value: v.init ? cloneValue(ev(v.init, frame))
            : zeroValue(sym.type) });
    }

    /** @param {any} s @param {Frame} frame @returns {number} */
    function loop(s, frame){
        let count = 0;
        if (s.kind === 'for' && s.init)
        {
            exec(s.init, frame);
        }
        for (;;)
        {
            if (s.kind !== 'do' && s.test && !truth(ev(s.test, frame)))
            {
                return NORMAL;
            }
            if (++count > maxIterations)
            {
                throw new Error(`iteration limit of ${maxIterations} exceeded`);
            }
            const sig = exec(s.body, frame);
            if (sig === BREAK)
            {
                return NORMAL;
            }
            if (sig === RETURN)
            {
                return RETURN;
            }
            if (s.kind === 'for' && s.step)
            {
                ev(s.step, frame);
            }
            if (s.kind === 'do' && !truth(ev(s.test, frame)))
            {
                return NORMAL;
            }
        }
    }

    /** @param {any} s @param {Frame} frame @returns {number} */
    function runSwitch(s, frame){
        const value = ev(s.test, frame);
        let start = s.cases.findIndex((/** @type {any} */ c)=>c.value
            && ev(c.value, frame) === value);
        if (start < 0)
        {
            start = s.cases.findIndex((/** @type {any} */ c)=>!c.value);
        }
        if (start < 0)
        {
            return NORMAL;
        }
        for (let i = start; i < s.cases.length; i++)
        {
            for (const x of s.cases[i].body)
            {
                const sig = exec(x, frame);
                if (sig === BREAK)
                {
                    return NORMAL;
                }
                if (sig !== NORMAL)
                {
                    return sig;
                }
            }
        }
        return NORMAL;
    }

    /**
     * Calls a function as a top-level run: statics start afresh.
     *
     * @param {FunctionSymbol} fn
     * @param {(Value | undefined)[] | Record<string, Value>} args
     *     Values by parameter position, or by parameter name. A missing uniform parameter is
     *     read from the environment; a missing out parameter starts as zero.
     * @returns {CallResult}
     */
    function call(fn, args){
        const nested = run !== null;
        if (!nested)
        {
            current();
        }
        try
        {
            const given = fn.params.map((p, i)=>{
                const v = Array.isArray(args) ? args[i] : args[p.name];
                if (v !== undefined)
                {
                    return p.dir === 'out' ? undefined : normalizeValue(v, p.type);
                }
                if (p.dir === 'out')
                {
                    return undefined;
                }
                if (p.isUniform)
                {
                    return normalizeValue(uniformOf(p), p.type);
                }
                throw new Error(`no value for parameter ${p.name} of ${fn.name}`);
            });
            const { frame, result } = invoke(fn, given);
            /** @type {Map<number, Value>} */
            const outs = new Map();
            fn.params.forEach((p, i)=>{
                if (p.dir === 'out' || p.dir === 'inout')
                {
                    outs.set(i, cloneValue(/** @type {Cell} */ (frame.cells.get(p)).value));
                }
            });
            return { result: result === undefined ? undefined : cloneValue(result), outs,
                killed: /** @type {Run} */ (run).killed };
        }
        finally
        {
            if (!nested)
            {
                run = null;
            }
        }
    }

    /**
     * The value of an expression made only of literals, constants and pure intrinsics; undefined
     * for any other.
     *
     * @param {any} expr
     * @returns {Value | undefined}
     */
    function evaluateConstant(expr){
        if (!expr || !expr.type)
        {
            return undefined;
        }
        const saved = constMode;
        constMode = true;
        try
        {
            return cloneValue(ev(expr, newFrame()));
        }
        catch (e){
            if (e === NOT_CONSTANT)
            {
                return undefined;
            }
            throw e;
        }
        finally
        {
            constMode = saved;
        }
    }

    return { call, runEntry: call, evaluateConstant };
}
