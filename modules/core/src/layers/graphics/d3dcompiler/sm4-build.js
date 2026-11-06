/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The instruction builder for Shader Model 4 and 5: the operations the lowering of
 * `win32/d3dx9/hlsl-lower.js` asks for, made of the instructions those models have.
 *
 * It answers the same calls as the Direct3D 9 builder (`hlsl-build.js`), so the one lowering
 * serves both, and adds what a model 4 register can hold that a model 3 one cannot: every
 * value carries what its bits are (`t`):
 *
 * - `f`, a float;
 * - `i` and `u`, a signed and an unsigned 32-bit integer;
 * - `b`, a truth value as the comparisons leave it: all ones or zero.
 *
 * An operation takes its operands in the type it is defined over and converts the others
 * (`ftoi`, `itof`, a truth value to 1.0 by `and` with its bits, a number to a truth by a
 * comparison with zero). The lowering converts between the types of the language itself, so
 * what is converted here is mostly a literal or a truth value used as a number. A literal
 * written as a float that is a whole number takes the type of an integer it meets: the
 * lowering's own constants (`i == 2` of an unrolled loop, a step of one) are numbers, not
 * floats.
 *
 * Literals are folded, and an instruction built twice for the same operands is built once,
 * as in the Direct3D 9 builder.
 */

import * as hm from '../../win32/d3dx9/hlsl-math.js';

/** @typedef {'f' | 'i' | 'u' | 'b'} Kind */

/**
 * A constant buffer the shader reads, and where in it.
 *
 * @typedef {Object} CbRead
 * @property {import('./sm4-ir.js').ConstantBuffer} buffer
 * @property {number} row           The 16-byte register.
 */

/** @typedef {import('./sm4-ir.js').Src} Src */
/** @typedef {import('./sm4-ir.js').VReg} VReg */
/** @typedef {import('./sm4-ir.js').Instr} Instr */
/** @typedef {import('./sm4-ir.js').Input} Input */
/** @typedef {import('./sm4-ir.js').Output} Output */
/** @typedef {import('./sm4-ir.js').Profile4} Profile4 */

/**
 * @typedef {Object} Vec
 * @property {number} w      Lanes, 1 to 4.
 * @property {Src} src
 * @property {Kind} t
 */

/** What the Direct3D 9 builder's callers know of a target, made up for a model 4 one. */
export class TargetError4 extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message){
        super(message);
        this.name = 'TargetError';
        this.code = code;
    }
}

const f32 = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));

/** The bits of a float, as a uint32. @param {number} x */
export function floatBits(x){
    scratch.setFloat32(0, x, true);
    return scratch.getUint32(0, true);
}

/** The float a uint32 is the bits of. @param {number} bits */
export function bitsFloat(bits){
    scratch.setUint32(0, bits >>> 0, true);
    return scratch.getFloat32(0, true);
}

/** The bits a lane of a literal is, by its kind. @param {number} x @param {Kind} t */
export function laneBits(x, t){
    switch (t)
    {
        case 'f': return floatBits(x);
        case 'b': return x !== 0 ? 0xffffffff : 0;
        default: return x >>> 0;
    }
}

/** A literal's lanes as another kind, as the conversion instructions convert them. */
const CONVERT = {
    /** @param {number} x @param {Kind} from @param {Kind} to */
    lane(x, from, to){
        if (from === to)
        {
            return x;
        }
        if (to === 'b')
        {
            return x !== 0 ? 1 : 0;
        }
        if (from === 'b')
        {
            return x;
        }
        if (to === 'f')
        {
            return f32(x);
        }
        if (from === 'f')
        {
            // ftoi and ftou: toward zero, NaN to zero, saturating at the ends.
            if (Number.isNaN(x))
            {
                return 0;
            }
            if (to === 'i')
            {
                return x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648
                    : Math.trunc(x) | 0;
            }
            return x >= 4294967295 ? 4294967295 : x <= 0 ? 0 : Math.trunc(x) >>> 0;
        }
        return to === 'u' ? x >>> 0 : x | 0;
    },
};

/**
 * The lane-wise operations that can be done on literals, by opcode, over the lanes as their
 * kind holds them. The result is in the kind the instruction gives.
 *
 * @type {Record<string, (v: number[]) => number>}
 */
const FOLD = {
    mov: v=>v[0],
    add: v=>f32(v[0] + v[1]),
    mul: v=>f32(v[0] * v[1]),
    mad: v=>f32(f32(v[0] * v[1]) + v[2]),
    div: v=>f32(v[0] / v[1]),
    min: v=>(Number.isNaN(v[0]) ? v[1] : Number.isNaN(v[1]) ? v[0] : Math.min(v[0], v[1])),
    max: v=>(Number.isNaN(v[0]) ? v[1] : Number.isNaN(v[1]) ? v[0] : Math.max(v[0], v[1])),
    frc: v=>f32(v[0] - Math.floor(v[0])),
    round_ni: v=>Math.floor(v[0]),
    round_pi: v=>Math.ceil(v[0]),
    round_z: v=>Math.trunc(v[0]),
    sqrt: v=>f32(Math.sqrt(v[0])),
    rsq: v=>f32(1 / Math.sqrt(v[0])),
    lt: v=>(v[0] < v[1] ? 1 : 0),
    ge: v=>(v[0] >= v[1] ? 1 : 0),
    eq: v=>(v[0] === v[1] ? 1 : 0),
    ne: v=>(v[0] !== v[1] ? 1 : 0),
    iadd: v=>(v[0] + v[1]) | 0,
    imul: v=>Math.imul(v[0], v[1]),
    imad: v=>(Math.imul(v[0], v[1]) + v[2]) | 0,
    imin: v=>Math.min(v[0], v[1]),
    imax: v=>Math.max(v[0], v[1]),
    umin: v=>Math.min(v[0], v[1]),
    umax: v=>Math.max(v[0], v[1]),
    ilt: v=>(v[0] < v[1] ? 1 : 0),
    ige: v=>(v[0] >= v[1] ? 1 : 0),
    ult: v=>(v[0] < v[1] ? 1 : 0),
    uge: v=>(v[0] >= v[1] ? 1 : 0),
    ieq: v=>(v[0] === v[1] ? 1 : 0),
    ine: v=>(v[0] !== v[1] ? 1 : 0),
    ineg: v=>(-v[0]) | 0,
    ishl: v=>v[0] << (v[1] & 31),
    ishr: v=>v[0] >> (v[1] & 31),
    ushr: v=>v[0] >>> (v[1] & 31),
    and: v=>v[0] & v[1],
    or: v=>v[0] | v[1],
    xor: v=>v[0] ^ v[1],
    not: v=>~v[0],
};

/** The kind each opcode gives. @type {Record<string, Kind>} */
const GIVES = {
    lt: 'b', ge: 'b', eq: 'b', ne: 'b', ilt: 'b', ige: 'b', ult: 'b', uge: 'b', ieq: 'b',
    ine: 'b', iadd: 'i', imul: 'i', imad: 'i', imin: 'i', imax: 'i', ineg: 'i', ishl: 'i',
    ishr: 'i', ftoi: 'i', umin: 'u', umax: 'u', umad: 'u', ushr: 'u', udiv: 'u', ftou: 'u',
};

/**
 * @param {Profile4} profile
 */
export function createSm4Builder(profile){
    /** @type {Instr[]} */
    const instrs = [];
    /** @type {Input[]} */
    const inputs = [];
    /** @type {Output[]} */
    const outputs = [];
    /** What the Direct3D 9 lowering pushes its constants into; nothing reads it here. */
    /** @type {any[]} */
    const constants = [];
    let vregCount = 0;
    /** @type {Map<string, Vec>} */
    const known = new Map();

    /** @param {number} width @returns {VReg} */
    const newReg = width=>({ id: vregCount++, width });

    /** @param {Src} src @returns {number} */
    const lanesOf = src=>(src.kind === 'imm' ? src.values.length : 'swz' in src
        ? src.swz.length : 0);

    /** @param {Src} src @param {Kind} [t] @returns {Vec} */
    const vec = (src, t = /** @type {Kind} */ (/** @type {any} */ (src).t ?? 'f'))=>
        ({ w: lanesOf(src), src, t });

    /** @param {number[]} values @param {Kind} [t] @returns {Vec} */
    const imm = (values, t = 'f')=>vec({ kind: 'imm', values: values.map(x=>(t === 'f' ? f32(x)
        : t === 'i' ? x | 0 : t === 'u' ? x >>> 0 : x ? 1 : 0)), t }, t);

    /**
     * A literal: a float unless the kind is named.
     * @param {number} x @param {number} [w] @param {Kind | 'int' | 'uint' | 'float' | 'bool'} [t]
     * @returns {Vec}
     */
    const num = (x, w = 1, t = 'f')=>{
        /** @type {Kind} */
        const kind = t === 'int' ? 'i' : t === 'uint' ? 'u' : t === 'float' ? 'f'
            : t === 'bool' ? 'b' : /** @type {Kind} */ (t);
        return imm(new Array(w).fill(kind === 'i' ? x | 0 : kind === 'u' ? x >>> 0
            : kind === 'b' ? (x ? 1 : 0) : x), kind);
    };

    /** @param {Vec} v */
    const literal = v=>(v.src.kind === 'imm' ? v.src.values : null);

    /** @param {Src} src @returns {string} */
    const keyOf = src=>{
        const flags = `${/** @type {any} */ (src).neg ? 'n' : ''}${
            /** @type {any} */ (src).abs ? 'a' : ''}`;
        switch (src.kind)
        {
            case 'reg': return `r${src.reg.id}:${src.swz}${flags}`;
            case 'imm': return `i${src.t}${src.values.map(v=>(Object.is(v, -0) ? '-0' : v))}`;
            case 'cb': return `c${src.buffer.slot}:${src.row}:${src.rel ? keyOf(src.rel) : ''}:${
                src.swz}${flags}`;
            case 'input': return `v${inputs.indexOf(src.input)}:${src.swz}${flags}`;
            case 'resource': return `t${src.resource.name}:${src.element}`;
            case 'sampler': return `s${src.sampler.name}:${src.element}`;
            default: return '?';
        }
    };

    /** @param {Src} src @param {number} w @returns {Src} */
    const fit = (src, w)=>{
        const n = lanesOf(src);
        if (n === w || n === 0)
        {
            return src;
        }
        if (n !== 1 && n < w)
        {
            throw new Error(`internal: a ${n}-lane operand where ${w} lanes are needed`);
        }
        if (src.kind === 'imm')
        {
            return { ...src, values: n === 1 ? new Array(w).fill(src.values[0])
                : src.values.slice(0, w) };
        }
        if (!('swz' in src))
        {
            return src;
        }
        return /** @type {Src} */ ({ ...src, swz: n === 1 ? new Array(w).fill(src.swz[0])
            : src.swz.slice(0, w) });
    };

    /**
     * An instruction into a new register of `w` components, or an earlier one's.
     *
     * @param {string} op @param {number} w @param {Src[]} srcs @param {Kind} t
     * @param {{ sat?: boolean, positional?: boolean, extra?: object }} [opts]
     * @returns {Vec}
     */
    const emit = (op, w, srcs, t, opts = {})=>{
        const fitted = opts.positional ? srcs : srcs.map(s=>fit(s, w));
        const key = `${op}/${w}/${opts.sat ? 's' : ''}${opts.extra ? JSON.stringify(opts.extra)
            : ''}/${fitted.map(keyOf).join('/')}`;
        const earlier = known.get(key);
        if (earlier)
        {
            return earlier;
        }
        const reg = newReg(w);
        instrs.push({ op, dests: [{ kind: 'reg', reg, mask: (1 << w) - 1 }], srcs: fitted,
            ...(opts.sat ? { sat: true } : {}), ...(opts.extra ?? {}) });
        const result = vec({ kind: 'reg', reg, swz: Array.from({ length: w }, (_, i)=>i) }, t);
        known.set(key, result);
        return result;
    };

    // ---- operands, free of cost ------------------------------------------------------

    /** @param {Vec} v @param {number[]} indices @returns {Vec} */
    function swizzle(v, indices){
        const { src } = v;
        if (src.kind === 'imm')
        {
            return { w: indices.length, t: v.t, src: { ...src,
                values: indices.map(i=>src.values[Math.min(i, src.values.length - 1)]) } };
        }
        if (!('swz' in src))
        {
            throw new Error('internal: swizzle of an operand with no lanes');
        }
        return { w: indices.length, t: v.t, src: /** @type {Src} */ ({ ...src,
            swz: indices.map(i=>src.swz[Math.min(i, src.swz.length - 1)]) }) };
    }
    /** @param {Vec} v @param {number} i */
    const lane = (v, i)=>swizzle(v, [i]);
    /** @param {Vec} v @param {number} w */
    const splat = (v, w)=>(v.w === w ? v : swizzle(v, new Array(w).fill(0)));

    /** @param {Vec} v @param {Kind} t @returns {Vec} */
    const retag = (v, t)=>(v.t === t ? v : v.src.kind === 'imm'
        ? { ...v, t, src: { ...v.src, t, values: v.src.values.map(x=>CONVERT.lane(x, v.t, t)) } }
        : { ...v, t });

    /**
     * The same bits read as another kind: asuint and its kin. A literal is reinterpreted; an
     * operand with a modifier is moved first, since a modifier means something else to an
     * integer instruction.
     *
     * @param {Vec} v @param {Kind} t @returns {Vec}
     */
    const bitcast = (v, t)=>{
        if (v.t === t)
        {
            return v;
        }
        if (v.src.kind === 'imm')
        {
            const from = v.t;
            const bits = v.src.values.map(x=>laneBits(x, from));
            return imm(t === 'f' ? bits.map(bitsFloat) : bits, t);
        }
        const plain = /** @type {any} */ (v.src).neg || /** @type {any} */ (v.src).abs
            ? emit('mov', v.w, [v.src], v.t) : v;
        return { ...plain, t };
    };

    /**
     * A value as another kind of bits.
     *
     * @param {Vec} v @param {Kind} t @returns {Vec}
     */
    function as(v, t){
        if (v.t === t)
        {
            return v;
        }
        if (v.src.kind === 'imm')
        {
            const values = v.src.values.map(x=>CONVERT.lane(x, v.t, t));
            return imm(values, t);
        }
        if ((v.t === 'i' && t === 'u') || (v.t === 'u' && t === 'i'))
        {
            return { ...v, t };
        }
        if (t === 'b')
        {
            return v.t === 'f' ? compare('ne', v, num(0, v.w, 'f'))
                : compare(v.t === 'u' ? 'ine' : 'ine', retag(v, 'i'), num(0, v.w, 'i'));
        }
        if (v.t === 'b')
        {
            // A truth is all ones or zero: its bits and those of 1.0 (or 1) are the number.
            return emit('and', v.w, [v.src, imm([t === 'f' ? 1 : 1], t).src], t);
        }
        if (t === 'f')
        {
            return emit(v.t === 'u' ? 'utof' : 'itof', v.w, [v.src], 'f');
        }
        return emit(t === 'u' ? 'ftou' : 'ftoi', v.w, [v.src], t);
    }

    /**
     * The kind an operation on these operands is done in: a float when any is, an
     * unsigned integer before a signed one; a literal whole number takes an integer's kind.
     *
     * @param {Vec[]} args @returns {Kind}
     */
    const joined = args=>{
        const integral = (/** @type {Vec} */ a)=>a.src.kind === 'imm' && a.t === 'f'
            && a.src.values.every(x=>Number.isInteger(x) && Math.abs(x) < 2147483648);
        const kinds = args.filter(a=>!integral(a)).map(a=>a.t);
        const all = kinds.length > 0 ? kinds : args.map(a=>a.t);
        if (all.includes('f'))
        {
            return 'f';
        }
        if (all.includes('u'))
        {
            return 'u';
        }
        if (all.includes('i'))
        {
            return 'i';
        }
        // Truths alone added, multiplied: as numbers they are ones and zeros.
        return kinds.length > 0 ? 'f' : 'i';
    };

    /** @param {Vec[]} args @returns {{ w: number, args: Vec[] }} */
    const unify = args=>{
        const w = Math.max(...args.map(a=>a.w));
        return { w, args: args.map(a=>(a.w === w ? a : splat(a, w))) };
    };

    /**
     * An operation lane by lane, folded when its operands are literals.
     *
     * @param {string} op @param {Vec[]} args @param {Kind} operands @param {Kind} [gives]
     * @param {boolean} [sat]
     * @returns {Vec}
     */
    const lanewise = (op, args, operands, gives = GIVES[op] ?? operands, sat = false)=>{
        const { w, args: same } = unify(args.map(a=>as(a, operands)));
        const values = same.map(literal);
        const fold = FOLD[op];
        if (fold && !sat && values.every(v=>v !== null))
        {
            const lits = /** @type {number[][]} */ (values);
            // A truth is held as 1 or 0 here and is all ones in a register: `not` of it is the
            // other truth, not the complement of the number.
            const folded = Array.from({ length: w }, (_, i)=>(op === 'not' && operands === 'b'
                ? (lits[0][lits[0].length === 1 ? 0 : i] ? 0 : 1)
                : fold(lits.map(v=>v[v.length === 1 ? 0 : i]))));
            return imm(gives === 'u' ? folded.map(x=>x >>> 0) : gives === 'i'
                ? folded.map(x=>x | 0) : folded, gives);
        }
        return emit(op, w, same.map(a=>a.src), gives, sat ? { sat } : {});
    };

    /** @param {Vec} v @returns {Vec} */
    const copy = v=>(literal(v) ? v : emit('mov', v.w, [v.src], v.t));

    /** @param {Vec} v @returns {Vec} */
    const neg = v=>{
        const x = v.t === 'b' ? as(v, 'f') : v;
        const { src } = x;
        if (src.kind === 'imm')
        {
            return imm(src.values.map(n=>(x.t === 'f' ? -n : x.t === 'u' ? (-n) >>> 0
                : (-n) | 0)), x.t);
        }
        if (src.kind === 'resource' || src.kind === 'sampler')
        {
            return x;
        }
        if (x.t !== 'f')
        {
            // An integer's negation is an instruction: a `-` on an operand means a two's
            // complement to an integer instruction and a sign to a move, and a value may
            // reach either.
            return lanewise('ineg', [x], 'i', x.t);
        }
        return { ...x, src: /** @type {Src} */ ({ ...src, neg: !(/** @type {any} */ (src).neg) }) };
    };

    /** @param {Vec} v @returns {Vec} */
    const abs = v=>{
        if (v.t === 'b')
        {
            return as(v, 'f');
        }
        const { src } = v;
        if (src.kind === 'imm')
        {
            return imm(src.values.map(n=>(v.t === 'i' ? Math.abs(n) | 0 : v.t === 'u' ? n
                : Math.abs(n))), v.t);
        }
        if (v.t === 'u')
        {
            return v;
        }
        if (v.t === 'i')
        {
            return lanewise('imax', [v, neg(v)], 'i');
        }
        return { ...v, src: /** @type {Src} */ ({ ...src, abs: true, neg: false }) };
    };

    /**
     * Values side by side, as one value of their combined width, in one kind: parts reading
     * the same register come in one `mov`.
     *
     * @param {Vec[]} parts @returns {Vec}
     */
    const cat = parts=>{
        const total = parts.reduce((n, p)=>n + p.w, 0);
        if (total > 4)
        {
            throw new Error('internal: a value of more than four lanes');
        }
        if (parts.length === 1)
        {
            return parts[0];
        }
        const kinds = new Set(parts.map(p=>p.t));
        // Truths and numbers together: the truths as the numbers' kind.
        const t = kinds.size === 1 ? parts[0].t : joined(parts.filter(p=>p.t !== 'b').length
            > 0 ? parts.filter(p=>p.t !== 'b') : parts);
        const same = parts.map(p=>as(p, t));
        if (same.every(p=>p.src.kind === 'imm'))
        {
            return imm(same.flatMap(p=>/** @type {number[]} */ (literal(p))), t);
        }
        /** @type {Map<string, { src: Src, comps: number[], lanes: number[] }>} */
        const groups = new Map();
        let comp = 0;
        for (const part of same)
        {
            for (let i = 0; i < part.w; i++, comp++)
            {
                const one = lane(part, i);
                const key = one.src.kind === 'imm' ? 'imm'
                    : keyOf(/** @type {Src} */ ({ ...one.src, swz: [0] })).replace(/:[\d,]*(?=[na]*$)/, '');
                let group = groups.get(key);
                if (!group)
                {
                    group = { src: one.src, comps: [], lanes: [] };
                    groups.set(key, group);
                }
                group.comps.push(comp);
                group.lanes.push(one.src.kind === 'imm' ? one.src.values[0]
                    : /** @type {{ swz: number[] }} */ (/** @type {unknown} */ (one.src)).swz[0]);
            }
        }
        if (groups.size === 1)
        {
            const [group] = [...groups.values()];
            return vec(group.src.kind === 'imm' ? { kind: 'imm', values: group.lanes, t }
                : /** @type {Src} */ ({ ...group.src, swz: group.lanes }), t);
        }
        const reg = newReg(total);
        for (const group of groups.values())
        {
            let mask = 0;
            for (const c of group.comps)
            {
                mask |= 1 << c;
            }
            const first = group.lanes[0];
            /** @type {Src} */
            let source;
            if (group.src.kind === 'imm')
            {
                const values = new Array(total).fill(first);
                group.comps.forEach((c, i)=>{
                    values[c] = group.lanes[i];
                });
                source = { kind: 'imm', values, t };
            }
            else
            {
                const swz = new Array(total).fill(first);
                group.comps.forEach((c, i)=>{
                    swz[c] = group.lanes[i];
                });
                source = /** @type {Src} */ ({ ...group.src, swz });
            }
            instrs.push({ op: 'mov', dests: [{ kind: 'reg', reg, mask }], srcs: [source] });
        }
        return vec({ kind: 'reg', reg, swz: Array.from({ length: total }, (_, i)=>i) }, t);
    };

    // ---- arithmetic -----------------------------------------------------------------

    /** @param {Vec} v */
    const isOne = v=>{
        const values = literal(v);
        return values !== null && values.every(x=>x === 1);
    };
    /** @param {Vec} v */
    const isZero = v=>{
        const values = literal(v);
        return values !== null && values.every(x=>x === 0 && !Object.is(x, -0));
    };

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const add = (a, b)=>{
        const t = joined([a, b]);
        if (isZero(b) && a.w >= b.w && a.t === t)
        {
            return a;
        }
        if (isZero(a) && b.w >= a.w && b.t === t)
        {
            return b;
        }
        return t === 'f' ? lanewise('add', [a, b], 'f') : lanewise('iadd', [a, b], t, t);
    };
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const sub = (a, b)=>add(a, neg(as(b, joined([a, b]))));
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const mul = (a, b)=>{
        const t = joined([a, b]);
        if (isOne(b) && a.w >= b.w && a.t === t)
        {
            return a;
        }
        if (isOne(a) && b.w >= a.w && b.t === t)
        {
            return b;
        }
        return t === 'f' ? lanewise('mul', [a, b], 'f') : lanewise('imul', [a, b], t, t);
    };
    /** @param {Vec} a @param {Vec} b @param {Vec} c @returns {Vec} */
    const mad = (a, b, c)=>{
        const t = joined([a, b, c]);
        return t === 'f' ? lanewise('mad', [a, b, c], 'f')
            : lanewise(t === 'u' ? 'umad' : 'imad', [a, b, c], t, t);
    };
    /** t * (x - y) + y. @param {Vec} t @param {Vec} x @param {Vec} y */
    const lrp = (t, x, y)=>mad(as(t, 'f'), sub(as(x, 'f'), as(y, 'f')), as(y, 'f'));
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const min = (a, b)=>{
        const t = joined([a, b]);
        return lanewise(t === 'f' ? 'min' : t === 'u' ? 'umin' : 'imin', [a, b], t, t);
    };
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const max = (a, b)=>{
        const t = joined([a, b]);
        return lanewise(t === 'f' ? 'max' : t === 'u' ? 'umax' : 'imax', [a, b], t, t);
    };
    /** @param {Vec} a */
    const frc = a=>lanewise('frc', [a], 'f');
    /** @param {Vec} a */
    const rcp = a=>div(num(1, a.w), a);
    /** @param {Vec} a */
    const rsq = a=>lanewise('rsq', [a], 'f');
    /** @param {Vec} a */
    const sqrt = a=>lanewise('sqrt', [a], 'f');
    /** @param {Vec} a */
    const exp2 = a=>{
        const values = literal(as(a, 'f'));
        return values ? imm(values.map(x=>f32(hm.exp2(x)))) : lanewise('exp', [a], 'f');
    };
    /** @param {Vec} a */
    const log2 = a=>{
        const values = literal(as(a, 'f'));
        return values ? imm(values.map(x=>(x === 0 ? -Infinity : f32(hm.log2(x)))))
            : lanewise('log', [a], 'f');
    };
    /** |x| to the y, as fxc makes it: exp(y * log(|x|)). @param {Vec} x @param {Vec} y */
    const pow = (x, y)=>exp2(mul(as(y, 'f'), log2(abs(as(x, 'f')))));
    /** @param {'x' | 'y'} axis @param {Vec} a */
    const derivative = (axis, a)=>{
        if (profile.kind !== 'ps')
        {
            throw new TargetError4('X4532', `ddx and ddy are only available in a pixel shader`);
        }
        return lanewise(axis === 'x' ? 'deriv_rtx' : 'deriv_rty', [a], 'f');
    };
    /** @param {Vec} a @param {Vec} b */
    const div = (a, b)=>lanewise('div', [a, b], 'f');
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const dot = (a, b)=>{
        const { w, args } = unify([as(a, 'f'), as(b, 'f')]);
        if (w === 1)
        {
            return mul(args[0], args[1]);
        }
        const x = literal(args[0]);
        const y = literal(args[1]);
        if (x && y)
        {
            return num(f32(x.reduce((sum, v, i)=>f32(sum + f32(v * y[i])), 0)));
        }
        return emit(`dp${w}`, 1, [args[0].src, args[1].src], 'f', { positional: true });
    };

    // ---- truth, choice and comparison -------------------------------------------------

    /**
     * A comparison into a truth, in the operands' kind.
     *
     * @param {string} op @param {Vec} a @param {Vec} b @returns {Vec}
     */
    function compare(op, a, b){
        return lanewise(op, [a, b], op.startsWith('u') ? 'u' : op.startsWith('i') ? 'i' : 'f',
            'b');
    }
    /**
     * @param {'lt' | 'ge' | 'eq' | 'ne'} op @param {Vec} a @param {Vec} b
     */
    const comparison = (op, a, b)=>{
        const t = joined([a.t === 'b' ? as(a, 'i') : a, b.t === 'b' ? as(b, 'i') : b]);
        if (t === 'f')
        {
            return compare(op, a, b);
        }
        if (op === 'eq' || op === 'ne')
        {
            return compare(`i${op}`, as(a, t), as(b, t));
        }
        return compare(`${t === 'u' ? 'u' : 'i'}${op}`, as(a, t), as(b, t));
    };
    /** @param {Vec} a @param {Vec} b */
    const lt = (a, b)=>comparison('lt', a, b);
    /** @param {Vec} a @param {Vec} b */
    const ge = (a, b)=>comparison('ge', a, b);
    /** @param {Vec} a @param {Vec} b */
    const gt = (a, b)=>comparison('lt', b, a);
    /** @param {Vec} a @param {Vec} b */
    const le = (a, b)=>comparison('ge', b, a);
    /** @param {Vec} a @param {Vec} b */
    const eq = (a, b)=>comparison('eq', a, b);
    /** @param {Vec} a @param {Vec} b */
    const ne = (a, b)=>comparison('ne', a, b);
    /** @param {Vec} a */
    const nonzero = a=>as(a, 'b');
    /** @param {Vec} a */
    const not = a=>lanewise('not', [as(a, 'b')], 'b', 'b');
    /** @param {Vec} a @param {Vec} b */
    const and = (a, b)=>lanewise('and', [as(a, 'b'), as(b, 'b')], 'b', 'b');
    /** @param {Vec} a @param {Vec} b */
    const or = (a, b)=>lanewise('or', [as(a, 'b'), as(b, 'b')], 'b', 'b');

    /**
     * The choice a truth makes between two values.
     *
     * @param {Vec} c @param {Vec} a @param {Vec} b @returns {Vec}
     */
    function select(c, a, b){
        const t = a.t === b.t ? a.t : joined([a, b]);
        const { w, args } = unify([as(c, 'b'), as(a, t), as(b, t)]);
        const test = literal(args[0]);
        if (test)
        {
            if (test.every(x=>x !== 0))
            {
                return args[1];
            }
            if (test.every(x=>x === 0))
            {
                return args[2];
            }
            const la = literal(args[1]);
            const lb = literal(args[2]);
            if (la && lb)
            {
                return imm(test.map((x, i)=>(x !== 0 ? la[i] : lb[i])), t);
            }
        }
        if (keyOf(args[1].src) === keyOf(args[2].src))
        {
            return args[1];
        }
        // movc moves bits: a modifier on what it moves is applied by a move first.
        const plain = args.map((x, i)=>(i > 0 && (/** @type {any} */ (x.src).neg
            || /** @type {any} */ (x.src).abs) ? emit('mov', w, [x.src], x.t) : x));
        return emit('movc', w, plain.map(x=>x.src), t);
    }
    /** `x >= 0 ? a : b`. @param {Vec} x @param {Vec} a @param {Vec} b */
    const selectGE0 = (x, a, b)=>select(ge(x, num(0)), a, b);

    /**
     * One lane from all of a value's: `op` over them in turn.
     * @param {Vec} v @param {(x: Vec, y: Vec) => Vec} op
     */
    const reduce = (v, op)=>{
        let acc = lane(v, 0);
        for (let i = 1; i < v.w; i++)
        {
            acc = op(acc, lane(v, i));
        }
        return acc;
    };

    // ---- rounding --------------------------------------------------------------------

    /** @param {Vec} a */
    const floor = a=>(a.t === 'f' ? lanewise('round_ni', [a], 'f') : a);
    /** @param {Vec} a */
    const ceil = a=>(a.t === 'f' ? lanewise('round_pi', [a], 'f') : a);
    /** @param {Vec} a */
    const trunc = a=>(a.t === 'f' ? lanewise('round_z', [a], 'f') : a);
    /** @param {Vec} a */
    const sat = a=>{
        const values = literal(as(a, 'f'));
        if (values)
        {
            return imm(values.map(x=>(Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x)))));
        }
        return lanewise('mov', [a], 'f', 'f', true);
    };
    /** Both `cos` and `sin` of each lane, in one sincos. @param {Vec} a */
    const sincos = a=>{
        const x = as(a, 'f');
        const values = literal(x);
        if (values)
        {
            return { cos: imm(values.map(v=>f32(hm.cos(v)))),
                sin: imm(values.map(v=>f32(hm.sin(v)))) };
        }
        const key = `sincos/${keyOf(x.src)}`;
        const had = known.get(key);
        if (had)
        {
            const pair = /** @type {any} */ (had);
            return { cos: pair.cos, sin: pair.sin };
        }
        const sin = newReg(x.w);
        const cos = newReg(x.w);
        const mask = (1 << x.w) - 1;
        instrs.push({ op: 'sincos', dests: [{ kind: 'reg', reg: sin, mask },
            { kind: 'reg', reg: cos, mask }], srcs: [x.src] });
        const lanes = Array.from({ length: x.w }, (_, i)=>i);
        const result = { sin: vec({ kind: 'reg', reg: sin, swz: lanes }, 'f'),
            cos: vec({ kind: 'reg', reg: cos, swz: lanes }, 'f') };
        known.set(key, /** @type {any} */ (result));
        return result;
    };

    // ---- integers --------------------------------------------------------------------

    /**
     * An integer division or remainder, `x / y` or `x % y` toward zero. The hardware divides
     * unsigned numbers only: a signed one divides the magnitudes and gives the quotient the
     * sign of the product, the remainder the sign of the dividend.
     *
     * @param {Vec} x @param {Vec} y @param {'quotient' | 'remainder'} part @param {Kind} t
     * @returns {Vec}
     */
    const integerDivide = (x, y, part, t)=>{
        const { w, args } = unify([as(x, t), as(y, t)]);
        const [a, b] = args;
        const la = literal(a);
        const lb = literal(b);
        if (la && lb)
        {
            return imm(la.map((n, i)=>{
                const d = lb[lb.length === 1 ? 0 : i];
                if (d === 0)
                {
                    return t === 'u' ? 0xffffffff : -1;
                }
                if (t === 'u')
                {
                    return part === 'quotient' ? Math.floor(n / d) >>> 0 : (n % d) >>> 0;
                }
                return part === 'quotient' ? Math.trunc(n / d) | 0 : (n % d) | 0;
            }), t);
        }
        /** @param {Vec} n @param {Vec} d */
        const udiv = (n, d)=>{
            const key = `udiv/${part}/${keyOf(n.src)}/${keyOf(d.src)}`;
            const had = known.get(key);
            if (had)
            {
                return had;
            }
            const reg = newReg(w);
            const mask = (1 << w) - 1;
            const dests = part === 'quotient' ? [{ kind: 'reg', reg, mask }, { kind: 'null' }]
                : [{ kind: 'null' }, { kind: 'reg', reg, mask }];
            instrs.push({ op: 'udiv', dests: /** @type {any} */ (dests), srcs: [fit(n.src, w),
                fit(d.src, w)] });
            const result = vec({ kind: 'reg', reg, swz: Array.from({ length: w }, (_, i)=>i) },
                'u');
            known.set(key, result);
            return result;
        };
        if (t === 'u')
        {
            return udiv(a, b);
        }
        const magnitude = udiv(retag(abs(a), 'u'), retag(abs(b), 'u'));
        // The sign: of the dividend for a remainder, of the product for a quotient.
        const negative = part === 'quotient'
            ? lt(lanewise('xor', [a, b], 'i', 'i'), num(0, w, 'i'))
            : lt(a, num(0, w, 'i'));
        return select(negative, neg(retag(magnitude, 'i')), retag(magnitude, 'i'));
    };

    /**
     * A bitwise operator or a shift, in the integer kind of the operation.
     *
     * @param {string} op @param {Vec} x @param {Vec} y @param {Kind} t
     */
    const bitwise = (op, x, y, t)=>{
        switch (op)
        {
            case '&': return lanewise('and', [x, y], t, t);
            case '|': return lanewise('or', [x, y], t, t);
            case '^': return lanewise('xor', [x, y], t, t);
            case '<<': return lanewise('ishl', [x, retag(as(y, t), t)], t, t);
            default: return lanewise(t === 'u' ? 'ushr' : 'ishr', [x, as(y, t)], t, t);
        }
    };
    /** @param {Vec} x @param {Kind} t */
    const bitnot = (x, t)=>lanewise('not', [x], t, t);

    /**
     * Between the types of the language, as a cast converts: what the bits of the result
     * are, made from what they were.
     *
     * @param {Vec} v @param {string} from @param {string} to
     */
    const convert = (v, from, to)=>{
        /** @type {Record<string, Kind>} */
        const kinds = { float: 'f', int: 'i', uint: 'u', bool: 'b' };
        // A float to an integer is cut toward zero, as ftoi and ftou do; between the integers
        // the bits stay.
        return as(v, kinds[to] ?? 'f');
    };

    // ---- inputs, outputs, flow ---------------------------------------------------------

    /**
     * Sends a value to an output, lanes 0 to w-1 of it into the components from `first`.
     *
     * @param {Output} out @param {Vec} v
     */
    const write = (out, v)=>{
        const x = as(v, out.kind);
        const mask = ((1 << x.w) - 1) << out.first;
        const src = out.first === 0 ? x.src : /** @type {Src} */ (x.src.kind === 'imm'
            ? { ...x.src, values: [...new Array(out.first).fill(0), ...x.src.values] }
            : { ...x.src, swz: [...new Array(out.first).fill(0),
                .../** @type {{ swz: number[] }} */ (/** @type {unknown} */ (x.src)).swz] });
        instrs.push({ op: 'mov', dests: [{ kind: 'out', out, mask }], srcs: [src] });
    };

    /** Kills the pixel if lane 0 of a value is negative. @param {Vec} v */
    const kill = v=>{
        if (profile.kind !== 'ps')
        {
            throw new TargetError4('X3000', 'discard is only available in a pixel shader');
        }
        const test = lt(lane(v, 0), num(0));
        const values = literal(test);
        if (values && values[0] === 0)
        {
            return;
        }
        instrs.push({ op: 'discard_nz', dests: [], srcs: [test.src] });
    };

    /**
     * A flow control instruction, as the lowering asks for the Direct3D 9 ones: `rep` and
     * `endrep` are `loop` and `endloop`; `breakc` and `ifc` compare their two operands and
     * branch on the truth. What was built before it is forgotten, as there.
     *
     * @param {string} op @param {Vec[]} [args] @param {{ cmp?: string }} [extra]
     */
    const control = (op, args = [], extra = {})=>{
        if (op === 'rep')
        {
            instrs.push({ op: 'loop', dests: [], srcs: [] });
            return;
        }
        if (op === 'breakc' || op === 'ifc')
        {
            const [a, b] = args.map(x=>lane(x, 0));
            const which = /** @type {string} */ (extra.cmp);
            const onTruth = a.t === 'b' && isZero(b) && (which === 'ne' || which === 'eq');
            /** @type {Record<string, () => Vec>} */
            const tests = { gt: ()=>gt(a, b), lt: ()=>lt(a, b), ge: ()=>ge(a, b),
                le: ()=>le(a, b), eq: ()=>eq(a, b), ne: ()=>ne(a, b) };
            const truth = onTruth ? (which === 'ne' ? a : not(a)) : tests[which]();
            instrs.push({ op: op === 'breakc' ? 'breakc_nz' : 'if_nz', dests: [],
                srcs: [truth.src] });
        }
        else
        {
            instrs.push({ op: op === 'endrep' ? 'endloop' : op, dests: [], srcs: [] });
        }
        known.clear();
    };

    /** A register a loop's variable lives in, holding `v` as the loop begins. @param {Vec} v */
    const carry = v=>{
        const reg = newReg(v.w);
        reg.carried = true;
        // A truth a float variable holds is carried as the number: the variable is written
        // again with numbers, and a truth's consumers take a number for one.
        const t = v.t === 'b' ? 'f' : v.t;
        const into = vec({ kind: 'reg', reg, swz: Array.from({ length: v.w }, (_, i)=>i) }, t);
        assign(into, v);
        return into;
    };

    /** @param {Vec} into @param {Vec} v */
    const assign = (into, v)=>{
        const { src } = into;
        const from = as(v, into.t).src;
        if (src.kind !== 'reg' || (from.kind === 'reg' && from.reg === src.reg && !from.neg
            && !from.abs && from.swz.every((c, i)=>c === src.swz[i])))
        {
            return;
        }
        instrs.push({ op: 'mov', dests: [{ kind: 'reg', reg: src.reg, mask: (1 << into.w) - 1 }],
            srcs: [fit(from, into.w)] });
    };

    /**
     * @template T
     * @param {string} tag @param {Vec[]} operands @param {() => T} make
     * @returns {T}
     */
    const remember = (tag, operands, make)=>{
        const key = `@${tag}/${operands.map(v=>keyOf(v.src)).join('/')}`;
        const had = /** @type {T | undefined} */ (/** @type {unknown} */ (known.get(key)));
        if (had !== undefined)
        {
            return had;
        }
        const made = make();
        known.set(key, /** @type {Vec} */ (/** @type {unknown} */ (made)));
        return made;
    };

    const checkpoint = ()=>({ count: instrs.length, known: new Map(known) });
    /** @param {ReturnType<typeof checkpoint>} mark */
    const rollback = mark=>{
        instrs.length = mark.count;
        known.clear();
        for (const [key, value] of mark.known)
        {
            known.set(key, value);
        }
    };

    /** The Direct3D 9 texture functions read a sampler as one object: not here. */
    const sample = ()=>{
        throw new TargetError4('X3500', 'the tex1D, tex2D, tex3D and texCUBE functions are not '
            + `available in ${profile.name}: read a texture through its methods (tex.Sample)`);
    };
    const address = ()=>{
        throw new Error('internal: the address register of model 2 and 3 in a model 4 build');
    };
    /** Shader Model 3's inputs by usage: a model 4 lowering makes its own (`hlsl4.js`). */
    const input = ()=>{
        throw new Error('internal: an input of model 3 in a model 4 build');
    };
    const output = input;

    return {
        typed: true,
        control, carry, assign, checkpoint, rollback, remember,
        profile, instrs, inputs, outputs, constants, newReg, get vregCount(){
            return vregCount;
        },
        vec, imm, num, literal, copy, lane, swizzle, splat, neg, abs, cat, unify, as, retag,
        bitcast,
        add, sub, mul, mad, lrp, min, max, frc, rcp, rsq, exp2, log2, pow, derivative, div,
        sqrt, dot, emit, lanewise,
        select, selectGE0, lt, le, gt, ge, eq, ne, nonzero, not, and, or, reduce,
        floor, ceil, trunc, sat, sincos, input, output, write, sample, kill, address,
        integerDivide, bitwise, bitnot, convert,
        isZero, isOne,
    };
}
