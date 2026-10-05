/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The instruction builder: values of one to four lanes, and the operations
 * on them that the language needs, each made out of what the target has.
 *
 * A `Vec` is a source operand with a width. Swizzling, replicating a scalar,
 * negating and taking an absolute value make a different operand and no
 * instruction; anything else is an instruction into a fresh virtual register.
 * An operation on literals is done here, so what the program already knows
 * costs nothing at run time, and an instruction that was already built for the
 * same operands is reused rather than built again.
 *
 * The same operation is built from different instructions on different
 * targets: a select is one `cmp` in a pixel shader and a product and a
 * multiply-add in a vertex shader, which has no `cmp`; `sin` is a range
 * reduction and a `sincos` where there is one and a polynomial where there is
 * not. That is the only place the target is asked, so the rest of the
 * compiler writes `b.select(c, x, y)` and does not know.
 *
 * Truth is 1.0 and falsehood 0.0, as in the registers of a program.
 */

import { TargetError, USAGE } from './hlsl-ir.js';

/** @typedef {import('./hlsl-ir.js').Src} Src */
/** @typedef {import('./hlsl-ir.js').VReg} VReg */
/** @typedef {import('./hlsl-ir.js').Instr} Instr */
/** @typedef {import('./hlsl-ir.js').Profile} Profile */
/** @typedef {import('./hlsl-ir.js').Const} Const */
/** @typedef {import('./hlsl-ir.js').Input} Input */
/** @typedef {import('./hlsl-ir.js').Output} Output */

/**
 * @typedef {Object} Vec
 * @property {number} w      Lanes, 1 to 4.
 * @property {Src} src       An operand with `w` lanes (a sampler has none).
 */

const TWO_PI = 2 * Math.PI;

/** A source with some fields changed; the variants share the ones changed here. */
const patch = (/** @type {Src} */ src, /** @type {object} */ change)=>
    /** @type {Src} */ ({ ...src, ...change });

/** @param {Src} src @returns {number} */
function lanesOf(src){
    if (src.kind === 'imm')
    {
        return src.values.length;
    }
    return 'swz' in src ? src.swz.length : 0;
}

/**
 * Whether two lists of numbers hold the same bits, so that -0 and 0 differ.
 * @param {number[]} a @param {number[]} b
 */
const sameValues = (a, b)=>a.length === b.length && a.every((v, i)=>Object.is(v, b[i]));

/** The numbers every lane of a literal operand holds, or null for anything else. @param {Vec} v */
function literal(v){
    return v.src.kind === 'imm' ? v.src.values : null;
}

/** @param {number} x */
const f32 = x=>Math.fround(x);

/**
 * What a lane-wise operation does to literal operands, for the operations
 * that can be done at build time. Numbers are float32 throughout.
 *
 * @type {Record<string, (v: number[]) => number>}
 */
const FOLD = {
    mov: v=>v[0],
    add: v=>f32(v[0] + v[1]),
    sub: v=>f32(v[0] - v[1]),
    mul: v=>f32(v[0] * v[1]),
    mad: v=>f32(f32(v[0] * v[1]) + v[2]),
    min: v=>Math.min(v[0], v[1]),
    max: v=>Math.max(v[0], v[1]),
    slt: v=>(v[0] < v[1] ? 1 : 0),
    sge: v=>(v[0] >= v[1] ? 1 : 0),
    cmp: v=>(v[0] >= 0 ? v[1] : v[2]),
    frc: v=>f32(v[0] - Math.floor(v[0])),
    abs: v=>Math.abs(v[0]),
    lrp: v=>f32(f32(v[0] * f32(v[1] - v[2])) + v[2]),
    rcp: v=>(v[0] === 0 ? Infinity : f32(1 / v[0])),
    rsq: v=>(v[0] === 0 ? Infinity : f32(1 / Math.sqrt(Math.abs(v[0])))),
    exp: v=>f32(2 ** v[0]),
    pow: v=>f32(Math.abs(v[0]) ** v[1]),
    log: v=>(v[0] === 0 ? -Infinity : f32(Math.log2(Math.abs(v[0])))),
};

/**
 * @param {Profile} profile
 */
export function createBuilder(profile){
    /** @type {Instr[]} */
    const instrs = [];
    /** @type {Input[]} */
    const inputs = [];
    /** @type {Output[]} */
    const outputs = [];
    /** @type {Const[]} */
    const constants = [];
    let vregCount = 0;
    /** @type {Map<string, Vec>} */
    const known = new Map();

    /** @param {number} width @returns {VReg} */
    const newReg = width=>({ id: vregCount++, width });

    /** @param {Src} src @returns {Vec} */
    const vec = src=>({ w: lanesOf(src), src });

    /** @param {number[]} values @returns {Vec} */
    const imm = values=>vec({ kind: 'imm', values: values.map(f32) });

    /** @param {number} x @param {number} [w] @returns {Vec} */
    const num = (x, w = 1)=>imm(new Array(w).fill(x));

    /**
     * An operand's key, for telling whether two instructions are the same one.
     *
     * @param {Src} src
     */
    const keyOf = src=>{
        switch (src.kind)
        {
            case 'reg':
                return `r${src.reg.id}:${src.swz}${src.neg ? 'n' : ''}${src.abs ? 'a' : ''}`;
            case 'imm': return `i${src.values.map(v=>(Object.is(v, -0) ? '-0' : v))}`;
            case 'const': return `c${src.cst.name}+${src.offset}:${src.swz}${src.relative ? 'r' : ''
            }${src.neg ? 'n' : ''}${src.abs ? 'a' : ''}`;
            case 'input': return `v${inputs.indexOf(src.input)}:${src.swz}${src.neg ? 'n' : ''
            }${src.abs ? 'a' : ''}`;
            case 'misc': return `m${src.which}:${src.swz}`;
            case 'sampler': return `s${src.cst.name}`;
            default: return '?';
        }
    };

    /**
     * An operand narrowed or widened to `w` lanes: a scalar replicates, a
     * wider one loses its upper lanes.
     *
     * @param {Src} src @param {number} w @returns {Src}
     */
    const fit = (src, w)=>{
        const n = lanesOf(src);
        if (n === w)
        {
            return src;
        }
        if (n === 0)
        {
            return src;
        }
        if (n !== 1 && n < w)
        {
            throw new Error(`internal: a ${n}-lane operand where ${w} lanes are needed`);
        }
        if (src.kind === 'imm')
        {
            return patch(src, { values: n === 1 ? new Array(w).fill(src.values[0])
                : src.values.slice(0, w) });
        }
        if (!('swz' in src))
        {
            return src;
        }
        return patch(src, { swz: n === 1 ? new Array(w).fill(src.swz[0])
            : src.swz.slice(0, w) });
    };

    /**
     * A lane-wise instruction into a new register, or an earlier one's result.
     *
     * @param {string} op @param {number} w @param {Src[]} srcs
     * @param {Partial<Instr>} [extra]
     * @returns {Vec}
     */
    const emit = (op, w, srcs, extra = {})=>{
        if (profile.ops && !profile.ops.has(op))
        {
            const name = op === 'mova' ? 'indexing' : op;
            throw new TargetError(op === 'dp4' ? 'X4531' : 'X4532', `${name} `
                + `is not an operation ${profile.name} has`);
        }
        // An instruction that reads its lanes by position takes its operands as they are.
        const positional = op === 'dp2add' || op === 'dp3' || op === 'dp4' || op === 'texld'
            || op === 'texldl' || op === 'texldd';
        const fitted = positional ? srcs : srcs.map(s=>fit(s, w));
        const key = `${op}/${w}/${extra.sat ? 's' : ''}${extra.texMode ?? ''}/${
            fitted.map(keyOf).join('/')}`;
        // A relative read depends on what the address register holds when it runs.
        const addressed = fitted.some(src=>src.kind === 'const' && src.relative);
        const earlier = addressed ? undefined : known.get(key);
        if (earlier)
        {
            return earlier;
        }
        const reg = newReg(w);
        instrs.push({ op, dest: { kind: 'reg', reg, mask: (1 << w) - 1 }, srcs: fitted, ...extra });
        const result = vec({ kind: 'reg', reg, swz: Array.from({ length: w }, (_, i)=>i) });
        if (!addressed)
        {
            known.set(key, result);
        }
        return result;
    };

    /**
     * A lane-wise operation, done at build time when its operands are literals.
     *
     * @param {string} op @param {number} w @param {Vec[]} args
     * @returns {Vec}
     */
    const lanewise = (op, w, args)=>{
        const values = args.map(literal);
        const fold = FOLD[op];
        if (fold && values.every(v=>v !== null))
        {
            const lits = /** @type {number[][]} */ (values);
            return imm(Array.from({ length: w }, (_, i)=>fold(lits.map(v=>
                v[v.length === 1 ? 0 : i]))));
        }
        return emit(op, w, args.map(a=>a.src));
    };

    // ---- operands, free of cost ------------------------------------------------------

    /** Lane `i` of a value, as a scalar. @param {Vec} v @param {number} i @returns {Vec} */
    const lane = (v, i)=>swizzle(v, [i]);

    /**
     * The lanes `indices` of a value.
     *
     * @param {Vec} v @param {number[]} indices @returns {Vec}
     */
    function swizzle(v, indices){
        const { src } = v;
        if (src.kind === 'imm')
        {
            return imm(indices.map(i=>src.values[Math.min(i, src.values.length - 1)]));
        }
        if (!('swz' in src))
        {
            throw new Error('internal: swizzle of an operand with no lanes');
        }
        return vec(patch(src, { swz: indices.map(i=>src.swz[Math.min(i, src.swz.length - 1)]) }));
    }

    /** @param {Vec} v @param {number} w @returns {Vec} */
    const splat = (v, w)=>(v.w === w ? v : swizzle(v, new Array(w).fill(0)));

    /**
     * The value in a register of its own, which is what a read through the
     * address register must be before the address changes.
     *
     * @param {Vec} v @returns {Vec}
     */
    const copy = v=>(literal(v) ? v : emit('mov', v.w, [v.src]));

    /** @param {Vec} v @returns {Vec} */
    const neg = v=>{
        const { src } = v;
        if (src.kind === 'imm')
        {
            return imm(src.values.map(x=>-x));
        }
        if (!('swz' in src))
        {
            return v;
        }
        return vec(patch(src, { neg: !(/** @type {any} */ (src).neg) }));
    };

    /** @param {Vec} v @returns {Vec} */
    const abs = v=>{
        const { src } = v;
        if (src.kind === 'imm')
        {
            return imm(src.values.map(Math.abs));
        }
        if (!('swz' in src))
        {
            return v;
        }
        return vec(patch(src, { abs: true, neg: false }));
    };

    /**
     * Values side by side, as one value of their combined width. Parts that
     * read the same register come in one `mov`; a single register needs none.
     *
     * @param {Vec[]} parts
     * @returns {Vec}
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
        if (parts.every(p=>p.src.kind === 'imm'))
        {
            return imm(parts.flatMap(p=>/** @type {number[]} */ (literal(p))));
        }
        /** @type {Map<string, { src: Src, comps: number[], lanes: number[] }>} */
        const groups = new Map();
        let comp = 0;
        for (const part of parts)
        {
            for (let i = 0; i < part.w; i++, comp++)
            {
                const one = lane(part, i);
                // Literals and every register read through its own flags make one group each.
                const key = one.src.kind === 'imm' ? 'imm'
                    : keyOf(patch(one.src, { swz: [0] })).replace(/:[\d,]*/, '');
                let group = groups.get(key);
                if (!group)
                {
                    group = { src: one.src, comps: [], lanes: [] };
                    groups.set(key, group);
                }
                group.comps.push(comp);
                group.lanes.push(one.src.kind === 'imm' ? one.src.values[0]
                    : /** @type {{ swz: number[] }} */ (one.src).swz[0]);
            }
        }
        if (groups.size === 1)
        {
            const [group] = [...groups.values()];
            return vec(group.src.kind === 'imm' ? { kind: 'imm', values: group.lanes }
                : patch(group.src, { swz: group.lanes }));
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
                source = { kind: 'imm', values };
            }
            else
            {
                const swz = new Array(total).fill(first);
                group.comps.forEach((c, i)=>{
                    swz[c] = group.lanes[i];
                });
                source = patch(group.src, { swz });
            }
            instrs.push({ op: 'mov', dest: { kind: 'reg', reg, mask }, srcs: [source] });
        }
        return vec({ kind: 'reg', reg, swz: Array.from({ length: total }, (_, i)=>i) });
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

    /**
     * Brings operands of the same lane-wise operation to one width.
     *
     * @param {Vec[]} args
     * @returns {{ w: number, args: Vec[] }}
     */
    const unify = args=>{
        const w = Math.max(...args.map(a=>a.w));
        return { w, args: args.map(a=>(a.w === w ? a : splat(a, w))) };
    };

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const add = (a, b)=>{
        if (isZero(b) && a.w >= b.w)
        {
            return a;
        }
        if (isZero(a) && b.w >= a.w)
        {
            return b;
        }
        const { w, args } = unify([a, b]);
        return lanewise('add', w, args);
    };

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const sub = (a, b)=>{
        if (isZero(b) && a.w >= b.w)
        {
            return a;
        }
        const { w, args } = unify([a, b]);
        return lanewise('sub', w, args);
    };

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const mul = (a, b)=>{
        if (isOne(b) && a.w >= b.w)
        {
            return a;
        }
        if (isOne(a) && b.w >= a.w)
        {
            return b;
        }
        const { w, args } = unify([a, b]);
        return lanewise('mul', w, args);
    };

    /** @param {Vec} a @param {Vec} b @param {Vec} c @returns {Vec} */
    const mad = (a, b, c)=>{
        const { w, args } = unify([a, b, c]);
        return lanewise('mad', w, args);
    };

    /**
     * `t * (x - y) + y`: the blend that is `x` for 1 and `y` for 0.
     *
     * @param {Vec} t @param {Vec} x @param {Vec} y @returns {Vec}
     */
    const lrp = (t, x, y)=>{
        const { w, args } = unify([t, x, y]);
        if (profile.lrp)
        {
            return lanewise('lrp', w, args);
        }
        return mad(args[0], sub(args[1], args[2]), args[2]);
    };

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const min = (a, b)=>{
        const { w, args } = unify([a, b]);
        return lanewise('min', w, args);
    };

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const max = (a, b)=>{
        const { w, args } = unify([a, b]);
        return lanewise('max', w, args);
    };

    /** @param {Vec} a @returns {Vec} */
    const frc = a=>lanewise('frc', a.w, [a]);

    /**
     * A scalar instruction on each lane of a value.
     *
     * @param {string} op @param {Vec[]} args   Scalar operands are replicated.
     * @returns {Vec}
     */
    const perLane = (op, args)=>{
        const { w, args: same } = unify(args);
        if (same.every(a=>literal(a) !== null))
        {
            return lanewise(op, w, same);
        }
        if (w === 1)
        {
            return emit(op, 1, same.map(a=>a.src));
        }
        const parts = [];
        for (let i = 0; i < w; i++)
        {
            parts.push(emit(op, 1, same.map(a=>lane(a, i).src)));
        }
        return cat(parts);
    };

    const rcp = (/** @type {Vec} */ a)=>perLane('rcp', [a]);
    const rsq = (/** @type {Vec} */ a)=>perLane('rsq', [a]);
    const exp2 = (/** @type {Vec} */ a)=>perLane('exp', [a]);
    const log2 = (/** @type {Vec} */ a)=>perLane('log', [a]);

    /**
     * |x| to the power y, lane by lane.
     *
     * @param {Vec} x @param {Vec} y @returns {Vec}
     */
    const pow = (x, y)=>{
        if (profile.pow)
        {
            return perLane('pow', [x, y]);
        }
        return exp2(mul(y, log2(x)));
    };

    /** The change of a value from this pixel to the next across (ddx) or down (ddy). */
    const derivative = (/** @type {'x' | 'y'} */ axis, /** @type {Vec} */ a)=>{
        if (!profile.derivatives)
        {
            throw new Error(`${profile.name} has no derivative instruction`);
        }
        return emit(axis === 'x' ? 'dsx' : 'dsy', a.w, [a.src]);
    };

    /** a / b, as a times the reciprocal of b. @param {Vec} a @param {Vec} b @returns {Vec} */
    const div = (a, b)=>mul(a, rcp(b));

    /** @param {Vec} a @returns {Vec} */
    const sqrt = a=>rcp(rsq(a));

    /**
     * Dot product, as a scalar.
     *
     * @param {Vec} a @param {Vec} b @returns {Vec}
     */
    const dot = (a, b)=>{
        const { w, args } = unify([a, b]);
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
        if (w === 2 && profile.dp2add)
        {
            return emit('dp2add', 1, [args[0].src, args[1].src, num(0).src]);
        }
        if (w === 2)
        {
            const product = mul(args[0], args[1]);
            return add(lane(product, 0), lane(product, 1));
        }
        return emit(w === 3 ? 'dp3' : 'dp4', 1, [args[0].src, args[1].src]);
    };

    // ---- selecting and comparing -------------------------------------------------------

    /**
     * `x >= 0 ? a : b`, lane by lane.
     *
     * @param {Vec} x @param {Vec} a @param {Vec} b @returns {Vec}
     */
    const selectGE0 = (x, a, b)=>{
        const { w, args } = unify([x, a, b]);
        const test = literal(args[0]);
        if (test)
        {
            // Lane by lane when only the test is known.
            const la = literal(args[1]);
            const lb = literal(args[2]);
            if (test.every(t=>t >= 0))
            {
                return args[1];
            }
            if (test.every(t=>!(t >= 0)))
            {
                return args[2];
            }
            if (la && lb)
            {
                return imm(test.map((t, i)=>(t >= 0 ? la[i] : lb[i])));
            }
        }
        if (profile.cmp)
        {
            return lanewise('cmp', w, args);
        }
        // x >= 0 as a 1 or 0, then the choice as a sum with one side zero.
        const take = lanewise('sge', w, [args[0], num(0, w)]);
        return select(take, args[1], args[2]);
    };

    /**
     * The choice a truth value makes between two values.
     *
     * @param {Vec} c   1 or 0.
     * @param {Vec} a   Taken for 1.
     * @param {Vec} b   Taken for 0.
     * @returns {Vec}
     */
    function select(c, a, b){
        const { w, args } = unify([c, a, b]);
        const test = literal(args[0]);
        if (test)
        {
            if (test.every(t=>t !== 0))
            {
                return args[1];
            }
            if (test.every(t=>t === 0))
            {
                return args[2];
            }
        }
        if (sameValues(literal(args[1]) ?? [NaN], literal(args[2]) ?? [Infinity])
            || (args[1].src.kind !== 'imm' && keyOf(args[1].src) === keyOf(args[2].src)))
        {
            return args[1];
        }
        if (profile.cmp)
        {
            return lanewise('cmp', w, [neg(args[0]), args[2], args[1]]);
        }
        // c * a + (1 - c) * b: one side is exactly zero, so the sum is exact.
        const taken = mul(args[0], args[1]);
        return mad(sub(num(1), args[0]), args[2], taken);
    }

    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const lt = (a, b)=>{
        const { w, args } = unify([a, b]);
        if (profile.cmp)
        {
            return selectGE0(sub(args[0], args[1]), num(0, w), num(1, w));
        }
        return lanewise('slt', w, args);
    };
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const ge = (a, b)=>{
        const { w, args } = unify([a, b]);
        if (profile.cmp)
        {
            return selectGE0(sub(args[0], args[1]), num(1, w), num(0, w));
        }
        return lanewise('sge', w, args);
    };
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const gt = (a, b)=>lt(b, a);
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const le = (a, b)=>ge(b, a);
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const eq = (a, b)=>{
        const { w, args } = unify([a, b]);
        if (profile.cmp)
        {
            return selectGE0(neg(abs(sub(args[0], args[1]))), num(1, w), num(0, w));
        }
        return mul(lanewise('sge', w, args), lanewise('sge', w, [args[1], args[0]]));
    };
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const ne = (a, b)=>{
        const { w, args } = unify([a, b]);
        if (profile.cmp)
        {
            return selectGE0(neg(abs(sub(args[0], args[1]))), num(0, w), num(1, w));
        }
        return add(lanewise('slt', w, args), lanewise('slt', w, [args[1], args[0]]));
    };
    /** Nonzero as a truth value. @param {Vec} a @returns {Vec} */
    const nonzero = a=>ne(a, num(0));
    /** @param {Vec} a @returns {Vec} */
    const not = a=>sub(num(1), a);
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const and = (a, b)=>mul(a, b);
    /** @param {Vec} a @param {Vec} b @returns {Vec} */
    const or = (a, b)=>max(a, b);

    /**
     * One lane's worth from all of a value's lanes: `op` over them in turn.
     *
     * @param {Vec} v @param {(x: Vec, y: Vec) => Vec} op @returns {Vec}
     */
    const reduce = (v, op)=>{
        let acc = lane(v, 0);
        for (let i = 1; i < v.w; i++)
        {
            acc = op(acc, lane(v, i));
        }
        return acc;
    };

    // ---- rounding and ranges -------------------------------------------------------

    /** @param {Vec} a @returns {Vec} */
    const floor = a=>sub(a, frc(a));
    /** @param {Vec} a @returns {Vec} */
    const ceil = a=>add(a, frc(neg(a)));
    /** Towards zero. @param {Vec} a @returns {Vec} */
    const trunc = a=>{
        const magnitude = abs(a);
        const whole = sub(magnitude, frc(magnitude));
        return selectGE0(a, whole, neg(whole));
    };
    /** @param {Vec} a @returns {Vec} */
    const sat = a=>{
        if (profile.satDest)
        {
            const values = literal(a);
            if (values)
            {
                return imm(values.map(x=>Math.min(1, Math.max(0, x))));
            }
            return emit('mov', a.w, [a.src], { sat: true });
        }
        return min(max(a, num(0)), num(1));
    };

    // ---- transcendentals -----------------------------------------------------------

    /**
     * Both `cos` and `sin` of each lane of a value, as `{ cos, sin }`.
     *
     * The argument is brought into [-pi, pi) first: the instruction, and the
     * series where there is none, are exact only there.
     *
     * @param {Vec} a
     * @returns {{ cos: Vec, sin: Vec }}
     */
    const sincos = a=>{
        const values = literal(a);
        if (values)
        {
            return { cos: imm(values.map(x=>Math.cos(x))), sin: imm(values.map(x=>Math.sin(x))) };
        }
        const turns = mad(a, num(1 / TWO_PI, a.w), num(0.5, a.w));
        const reduced = mad(frc(turns), num(TWO_PI, a.w), num(-Math.PI, a.w));
        if (profile.sincos)
        {
            const cos = [];
            const sin = [];
            for (let i = 0; i < a.w; i++)
            {
                const pair = emit('sincos', 2, [lane(reduced, i).src]);
                // The result's two lanes are the cosine and the sine; the register
                // must be one whose x and y they land in.
                const home = /** @type {{ kind: 'reg', reg: VReg }} */ (pair.src).reg;
                home.fixed = 2;
                cos.push(lane(pair, 0));
                sin.push(lane(pair, 1));
            }
            return { cos: cat(cos), sin: cat(sin) };
        }
        // The Taylor series about zero, to the term whose size at pi is below a millionth.
        const square = mul(reduced, reduced);
        /** @param {number[]} coefficients highest power first @param {Vec} x */
        const horner = (coefficients, x)=>{
            let acc = num(coefficients[0], a.w);
            for (const c of coefficients.slice(1))
            {
                acc = mad(acc, x, num(c, a.w));
            }
            return acc;
        };
        const sinSeries = horner([1 / 355687428096000, -1 / 1307674368000, 1 / 6227020800,
            -1 / 39916800, 1 / 362880, -1 / 5040, 1 / 120, -1 / 6, 1], square);
        const cosSeries = horner([1 / 20922789888000, -1 / 87178291200, 1 / 479001600,
            -1 / 3628800, 1 / 40320, -1 / 720, 1 / 24, -1 / 2, 1], square);
        return { cos: cosSeries, sin: mul(reduced, sinSeries) };
    };

    // ---- inputs, outputs, constants, textures ----------------------------------------------

    /**
     * The input a semantic names, made once.
     *
     * @param {number} usage @param {number} index @param {number} width
     * @returns {Input}
     */
    const input = (usage, index, width)=>{
        let found = inputs.find(i=>i.usage === usage && i.index === index);
        if (!found)
        {
            found = { usage, index, width };
            inputs.push(found);
        }
        found.width = Math.max(found.width, width);
        return found;
    };

    /**
     * Sends a value to an output, lanes 0 to w-1 of it into those components.
     *
     * @param {Output} out @param {Vec} v
     */
    const write = (out, v)=>{
        const mask = (1 << v.w) - 1;
        out.width = Math.max(out.width, v.w);
        instrs.push({ op: 'mov', dest: { kind: 'out', out, mask }, srcs: [v.src] });
    };

    /**
     * @param {number} usage @param {number} index @param {number} width
     * @returns {Output}
     */
    const output = (usage, index, width)=>{
        let found = outputs.find(o=>o.usage === usage && o.index === index);
        if (!found)
        {
            found = { usage, index, width };
            outputs.push(found);
        }
        return found;
    };

    /**
     * A texture read.
     *
     * @param {Const} sampler @param {Vec} coord
     * @param {'plain' | 'project' | 'bias' | 'lod' | 'grad'} mode
     * @param {Vec[]} [gradients]
     * @returns {Vec}
     */
    const sample = (sampler, coord, mode, gradients = [])=>{
        if (profile.legacy)
        {
            return legacySample(sampler, coord, mode);
        }
        const op = mode === 'lod' ? 'texldl' : mode === 'grad' ? 'texldd' : 'texld';
        const reg = newReg(4);
        instrs.push({ op, dest: { kind: 'reg', reg, mask: 15 },
            srcs: [coord.src, { kind: 'sampler', cst: sampler }, ...gradients.map(g=>g.src)],
            ...(mode === 'project' || mode === 'bias' ? { texMode: mode } : {}) });
        return vec({ kind: 'reg', reg, swz: [0, 1, 2, 3] });
    };

    /**
     * A texture read of a model 1 pixel shader. Before 1.4 the stage reads the coordinate
     * set of the same number and leaves the texel in the texture register of that
     * number; from 1.4 the destination register picks the stage and the coordinate can be
     * any texture register or, after the phase marker, a temporary.
     *
     * @param {Const} sampler @param {Vec} coord @param {string} mode
     */
    const legacySample = (sampler, coord, mode)=>{
        if (mode !== 'plain')
        {
            throw new TargetError('X4532', `this texture read is not available in ${profile.name}`);
        }
        const src = coord.src;
        const direct = src.kind === 'input' && src.input.usage === USAGE.TEXCOORD
            && src.swz.every((c, i)=>c === i);
        const reg = newReg(4);
        if (profile.minor < 4)
        {
            if (!direct)
            {
                throw new TargetError(src.kind === 'reg' ? 'X4523' : 'X4515',
                    `${profile.name} reads a texture only at the `
                    + 'coordinates of its own stage: the sampler must be read at the TEXCOORD '
                    + 'of its number');
            }
            const stage = /** @type {import('./hlsl-ir.js').SrcInput} */ (src).input.index;
            if (sampler.explicit !== undefined && sampler.explicit !== stage)
            {
                throw new TargetError('X4515', `${profile.name}: sampler '${sampler.name}' is at `
                    + `s${sampler.explicit} but read at TEXCOORD${stage}`);
            }
            sampler.explicit = stage;
            reg.pin = { file: 't', index: stage };
            instrs.push({ op: 'tex', dest: { kind: 'reg', reg, mask: 15 }, srcs: [src] });
        }
        else
        {
            reg.pin = { file: 'r', sampler };
            instrs.push({ op: 'texld', dest: { kind: 'reg', reg, mask: 15 },
                srcs: [src, { kind: 'sampler', cst: sampler }] });
        }
        return vec({ kind: 'reg', reg, swz: [0, 1, 2, 3] });
    };

    /**
     * Kills the pixel if any of the first three lanes of a value is negative.
     *
     * @param {Vec} v
     */
    const kill = v=>{
        if (profile.legacy)
        {
            throw new TargetError('X4532', `discard and clip are not available in ${profile.name}`);
        }
        const reg = newReg(3);
        reg.fixed = 3;
        const three = splat(lane(v, 0), 3);
        instrs.push({ op: 'mov', dest: { kind: 'reg', reg, mask: 7 }, srcs: [three.src] });
        instrs.push({ op: 'texkill', dest: { kind: 'none' },
            srcs: [{ kind: 'reg', reg, swz: [0, 1, 2] }] });
    };

    /**
     * Loads the address register with the (integral) value in lane 0.
     * @param {Vec} v
     */
    const address = v=>{
        instrs.push({ op: 'mova', dest: { kind: 'addr' }, srcs: [lane(v, 0).src] });
    };

    return {
        profile, instrs, inputs, outputs, constants, newReg, get vregCount(){
            return vregCount;
        },
        vec, imm, num, literal, copy, lane, swizzle, splat, neg, abs, cat, unify,
        add, sub, mul, mad, lrp, min, max, frc, rcp, rsq, exp2, log2, pow, derivative, div,
        sqrt, dot,
        select, selectGE0, lt, le, gt, ge, eq, ne, nonzero, not, and, or, reduce,
        floor, ceil, trunc, sat, sincos, input, output, write, sample, kill, address,
        isZero, isOne, USAGE,
    };
}
