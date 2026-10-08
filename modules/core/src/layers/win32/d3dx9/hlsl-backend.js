/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The back half of the compiler: straight-line code over virtual registers
 * (`hlsl-ir.js`) to a Direct3D 9 shader.
 *
 * In order: instructions whose result nobody reads are dropped; `sincos` gets
 * the two constant operands models below 3 demand; the constants are given
 * their registers (those a program asked for first, the rest in declaration
 * order); the literals are packed into `def` registers, several to a register
 * so that a program of scalars does not spend one each; operands the target
 * cannot read (an absolute value where there is no such modifier, a second
 * constant register in one instruction of a vertex shader) are copied to a
 * temporary; the virtual registers are given components of physical ones by
 * a scan over their lifetimes -- a straight line, so a lifetime is an
 * interval -- and the stream is written.
 *
 * A temporary may start where another ends, in the same instruction: an
 * instruction reads before it writes, so `add r0, r0, r1` is one register.
 */

import { USAGE, registersOf } from './hlsl-ir.js';
import { OPCODES, REG, MOD, encodeProgram } from './hlsl-encode.js';
import { constantTableComment } from './hlsl-ctab.js';

/** @typedef {import('./hlsl-ir.js').IrProgram} IrProgram */
/** @typedef {import('./hlsl-ir.js').Instr} Instr */
/** @typedef {import('./hlsl-ir.js').Src} Src */
/** @typedef {import('./hlsl-ir.js').SrcCreg} SrcCreg */
/** @typedef {import('./hlsl-ir.js').VReg} VReg */
/** @typedef {import('./hlsl-ir.js').Const} Const */
/** @typedef {import('./hlsl-ir.js').Input} Input */
/** @typedef {import('./hlsl-ir.js').Output} Output */
/** @typedef {import('./hlsl-ir.js').Profile} Profile */
/** @typedef {import('./hlsl-encode.js').PhysOperand} PhysOperand */
/** @typedef {import('./hlsl-encode.js').PhysInstr} PhysInstr */

/**
 * @typedef {Object} Diagnostic
 * @property {string} code
 * @property {string} message
 * @property {'error' | 'warning'} [severity]  An error unless it says otherwise.
 */

/**
 * @typedef {Object} AssembleResult
 * @property {Uint32Array | null} tokens   Null when an error was found.
 * @property {Diagnostic[]} diagnostics
 * @property {{ arith: number, texture: number, slots: number, temps: number,
 *     constants: number, defs: number }} stats
 */

/** The Taylor-series constants the model-2 `sincos` takes as its extra operands. */
const SINCOS_TAYLOR = [
    [-1.5500992e-6, -2.1701389e-5, 2.6041667e-3, 2.6041668e-4],
    [-0.020833334, -0.125, 1.0, 0.5],
];

/** Instruction slots an instruction takes when it is not one. @type {Record<string, number>} */
const SLOT_COST = { sincos: 8, lrp: 2, pow: 3, dsx: 2, dsy: 2 };

const TEXTURE_OPS = new Set(['texld', 'texldl', 'texldd', 'texkill']);

/** @param {Src} src */
export const laneCount = src=>('values' in src ? src.values.length
    : 'swz' in src ? src.swz.length : 0);

/**
 * The lanes of source `k` an instruction reads, which is what decides the
 * components of an input it needs.
 *
 * @param {Instr} instr @param {number} k
 * @returns {number[]}
 */
export function lanesRead(instr, k){
    const src = instr.srcs[k];
    const cls = /** @type {Record<string, { cls: string }>} */ (OPCODES)[instr.op].cls;
    const count = laneCount(src);
    if (cls === 'scalar')
    {
        return [0];
    }
    if (cls === 'lanes' || cls === 'texture' || cls === 'kill')
    {
        if (instr.op === 'dp2add' && k === 2)
        {
            return [0];
        }
        return Array.from({ length: count }, (_, i)=>i);
    }
    const mask = instr.dest.kind === 'reg' || instr.dest.kind === 'out' ? instr.dest.mask : 1;
    return [0, 1, 2, 3].filter(c=>(mask & 1 << c) !== 0);
}

/**
 * Drops the instructions whose results are never read. `mova` stays while a
 * later instruction addresses relatively.
 *
 * @param {Instr[]} instrs
 * @returns {Instr[]}
 */
export function prune(instrs){
    /** @type {Set<number>} */
    const live = new Set();
    let addressNeeded = false;
    /** @type {Instr[]} */
    const kept = [];
    for (let i = instrs.length - 1; i >= 0; i--)
    {
        const instr = instrs[i];
        if (instr.dest.kind === 'reg')
        {
            if (!live.has(instr.dest.reg.id))
            {
                continue;
            }
        }
        else if (instr.dest.kind === 'addr')
        {
            if (!addressNeeded)
            {
                continue;
            }
            addressNeeded = false;
        }
        for (const src of instr.srcs)
        {
            if (src.kind === 'reg')
            {
                live.add(src.reg.id);
            }
            else if (src.kind === 'const' && src.relative)
            {
                addressNeeded = true;
            }
        }
        kept.push(instr);
    }
    return kept.reverse();
}

/**
 * How a register is written and read: the instructions that write it and the
 * number of operands that read it.
 *
 * @param {Instr[]} instrs
 * @returns {{ writers: Map<VReg, number[]>, reads: Map<VReg, number> }}
 */
export function usage(instrs){
    /** @type {Map<VReg, number[]>} */
    const writers = new Map();
    /** @type {Map<VReg, number>} */
    const reads = new Map();
    instrs.forEach((instr, i)=>{
        for (const src of instr.srcs)
        {
            if (src.kind === 'reg')
            {
                reads.set(src.reg, (reads.get(src.reg) ?? 0) + 1);
            }
        }
        if (instr.dest.kind === 'reg')
        {
            writers.set(instr.dest.reg, [...(writers.get(instr.dest.reg) ?? []), i]);
        }
    });
    return { writers, reads };
}

/**
 * An operand with its lanes picked from another's: lane `c` of the result is
 * lane `lanes[c]` of `src`.
 *
 * @param {Src} src @param {number[]} lanes @param {boolean} negate
 * @returns {Src}
 */
export function reselect(src, lanes, negate){
    if (src.kind === 'imm')
    {
        const values = lanes.map(l=>src.values[Math.min(l, src.values.length - 1)]);
        return { kind: 'imm', values: negate ? values.map(v=>-v) : values };
    }
    if (!('swz' in src))
    {
        return src;
    }
    const flipped = negate ? !(/** @type {{ neg?: boolean }} */ (src).neg) : undefined;
    return /** @type {Src} */ ({ ...src,
        swz: lanes.map(l=>src.swz[Math.min(l, src.swz.length - 1)]),
        ...(flipped === undefined ? {} : { neg: flipped }) });
}

/**
 * A product that is added to something becomes a multiply-add, when nobody else
 * wants the product.
 *
 * @param {Instr[]} instrs @param {Profile} profile
 * @returns {Instr[]}
 */
export function fuseMultiplyAdd(instrs, profile){
    const { writers, reads } = usage(instrs);
    /** @type {Set<number>} */
    const removed = new Set();
    const result = instrs.map(instr=>({ ...instr, srcs: instr.srcs.slice() }));
    /** @param {Src[]} srcs */
    const constReads = srcs=>new Set(srcs.map(src=>(src.kind === 'imm'
        ? `imm${src.values.join()}` : constKey(src))).filter(key=>key !== null));
    // The constant registers one instruction may read: one in a vertex shader, two in a
    // model 1 pixel shader (its read ports), any from ps_2_0.
    const constLimit = profile.legacy ? 2 : profile.oneConstPerInstr ? 1 : Infinity;
    result.forEach((instr, j)=>{
        if ((instr.op !== 'add' && instr.op !== 'sub') || instr.dest.kind === 'none'
            || instr.dest.kind === 'addr')
        {
            return;
        }
        for (let p = 0; p < 2; p++)
        {
            const product = instr.srcs[p];
            if (product.kind !== 'reg' || product.abs || reads.get(product.reg) !== 1)
            {
                continue;
            }
            const made = writers.get(product.reg);
            if (!made || made.length !== 1 || removed.has(made[0]))
            {
                continue;
            }
            const maker = result[made[0]];
            if (maker.op !== 'mul' || maker.dest.kind !== 'reg'
                || maker.dest.mask !== (1 << product.reg.width) - 1)
            {
                continue;
            }
            // The lanes of the product the sum reads, for each of its own.
            const lanes = [0, 1, 2, 3].map(c=>product.swz[Math.min(c, product.swz.length - 1)]);
            const other = instr.srcs[1 - p];
            // a*b + c, a*b - c, and c - a*b = (-a)*b + c; the product's own sign rides on a.
            const flipFirst = Boolean(product.neg) !== (instr.op === 'sub' && p === 1);
            const srcs = [reselect(maker.srcs[0], lanes, flipFirst),
                reselect(maker.srcs[1], lanes, false),
                instr.op === 'sub' && p === 0 ? negated(other) : other];
            if (constReads(srcs).size > constLimit)
            {
                continue;
            }
            result[j] = { ...instr, op: 'mad', srcs };
            removed.add(made[0]);
            return;
        }
    });
    return result.filter((_, i)=>!removed.has(i));
}

/** @param {Src} src @returns {Src} */
export function negated(src){
    if (src.kind === 'imm')
    {
        return { kind: 'imm', values: src.values.map(v=>-v) };
    }
    if (!('swz' in src))
    {
        return src;
    }
    return /** @type {Src} */ ({ ...src, neg: !(/** @type {{ neg?: boolean }} */ (src).neg) });
}

/**
 * Every value is computed once. The front half inlines each call where it stands,
 * so a function a shader calls twice -- a texel fetched by two of its terms, a
 * light vector each lighting term works out again -- is the same instructions
 * twice; fxc computes it once, and a model 1 target, eight instructions long,
 * fits only what fxc fits.
 *
 * Straight-line code, so value numbering: each component of each register holds
 * a value, named by what computed it from which values. An instruction whose
 * results are all held somewhere already becomes a move from there, and every
 * read goes to where its value was first computed while that still holds it --
 * which leaves the moves unread, for `prune` to take away.
 *
 * @param {Instr[]} instrs @param {Profile} profile
 * @returns {Instr[]}
 */
export function numberValues(instrs, profile){
    /** @type {Map<string, number>} */
    const ids = new Map();
    /** @param {string} key */
    const idOf = key=>{
        let id = ids.get(key);
        if (id === undefined)
        {
            id = ids.size;
            ids.set(key, id);
        }
        return id;
    };
    /** What each component of each register holds: `${reg.id}:${component}` to a value. */
    /** @type {Map<string, number>} */
    const held = new Map();
    /** Where each value was first put, while it is still there. */
    /** @type {Map<number, { reg: VReg, comp: number }>} */
    const home = new Map();
    /** @type {Map<object, number>} */
    const objects = new Map();
    /** @param {object} o */
    const objectId = o=>{
        if (!objects.has(o))
        {
            objects.set(o, objects.size);
        }
        return /** @type {number} */ (objects.get(o));
    };
    let fresh = 0;
    let addressWrites = 0;
    /** @param {VReg} reg @param {number} comp */
    const valueAt = (reg, comp)=>{
        const key = `${reg.id}:${comp}`;
        let id = held.get(key);
        if (id === undefined)
        {
            // Read before any write: a value of its own, equal to nothing else.
            id = idOf(`?${fresh++}`);
            held.set(key, id);
        }
        return id;
    };
    /** The value lane `lane` of an operand reads, with its modifiers. @param {Src} src @param {number} lane */
    const laneValue = (src, lane)=>{
        /** @type {string} */
        let base;
        const comp = 'swz' in src ? src.swz[Math.min(lane, src.swz.length - 1)] : 0;
        const at = /** @type {{ relative?: boolean }} */ (src).relative ? `@${addressWrites}` : '';
        switch (src.kind)
        {
            case 'reg': base = `#${valueAt(src.reg, comp)}`; break;
            case 'imm': base = `=${Object.is(src.values[Math.min(lane, src.values.length - 1)], -0)
                ? '-0' : src.values[Math.min(lane, src.values.length - 1)]}`; break;
            case 'const': base = `c${objectId(src.cst)}+${src.offset}.${comp}${at}`; break;
            case 'creg': base = `k${src.file}${src.index}.${comp}${at}`; break;
            case 'input': base = `i${objectId(src.input)}.${comp}`; break;
            case 'misc': base = `m${src.which}.${comp}`; break;
            case 'sampler': base = `s${objectId(src.cst)}`; break;
            default: base = `?${fresh++}`;
        }
        const one = /** @type {{ neg?: boolean, abs?: boolean, mod?: string }} */ (src);
        if (one.abs)
        {
            base = `|${base}|`;
        }
        if (one.mod)
        {
            base = `${one.mod}(${base})`;
        }
        return one.neg ? `-${base}` : base;
    };
    /** @param {VReg} reg @param {number} comp @param {number} id */
    const put = (reg, comp, id)=>{
        held.set(`${reg.id}:${comp}`, id);
        const first = home.get(id);
        if (!first || held.get(`${first.reg.id}:${first.comp}`) !== id)
        {
            home.set(id, { reg, comp });
        }
    };
    /** The register and components holding these values, when one register holds them all. */
    /** @param {number[]} values */
    const holderOf = values=>{
        /** @type {VReg | null} */
        let reg = null;
        const comps = [];
        for (const id of values)
        {
            const at = home.get(id);
            if (!at || held.get(`${at.reg.id}:${at.comp}`) !== id || (reg && at.reg !== reg))
            {
                return null;
            }
            reg = at.reg;
            comps.push(at.comp);
        }
        return reg ? { reg, comps } : null;
    };
    // A model 1 texture instruction names its own registers; nothing is moved into it.
    const fixedSources = (/** @type {Instr} */ instr)=>profile.legacy
        && /** @type {Record<string, { cls: string }>} */ (OPCODES)[instr.op]?.cls === 'texture';

    /**
     * Registers pinned to the same physical one as a register holding the same texel: the
     * same storage, so the one stands for the other everywhere after.
     *
     * @type {Map<VReg, VReg>}
     */
    const alias = new Map();
    /** @param {VReg} reg */
    const real = reg=>alias.get(reg) ?? reg;

    /** @type {Instr[]} */
    const out = [];
    for (const original of instrs)
    {
        let instr = alias.size === 0 ? original : {
            ...original,
            srcs: original.srcs.map(src=>(src.kind === 'reg' && alias.has(src.reg)
                ? { ...src, reg: real(src.reg) } : src)),
            dest: original.dest.kind === 'reg' && alias.has(original.dest.reg)
                ? { ...original.dest, reg: real(original.dest.reg) } : original.dest,
        };
        const cls = /** @type {Record<string, { cls: string }>} */ (OPCODES)[instr.op]?.cls;
        // Reads go to where their values were first computed.
        if (!fixedSources(instr))
        {
            const srcs = instr.srcs.map((src, k)=>{
                if (src.kind !== 'reg' || src.reg.pin || src.reg.fixed)
                {
                    return src;
                }
                const lanes = lanesRead(instr, k);
                const found = holderOf(lanes.map(lane=>valueAt(src.reg,
                    src.swz[Math.min(lane, src.swz.length - 1)])));
                if (!found || found.reg === src.reg
                    || Boolean(found.reg.uniform) !== Boolean(src.reg.uniform))
                {
                    return src;
                }
                const swz = src.swz.slice();
                while (swz.length < 4 && lanes.some(lane=>lane >= swz.length))
                {
                    swz.push(swz[swz.length - 1]);
                }
                lanes.forEach((lane, i)=>{
                    swz[lane] = found.comps[i];
                });
                for (let lane = 0; lane < swz.length; lane++)
                {
                    if (!lanes.includes(lane))
                    {
                        swz[lane] = found.comps[0];
                    }
                }
                return /** @type {Src} */ ({ ...src, reg: found.reg, swz });
            });
            instr = { ...instr, srcs };
        }
        if (instr.dest.kind === 'addr')
        {
            addressWrites++;
        }
        if (instr.dest.kind !== 'reg' && instr.dest.kind !== 'out')
        {
            out.push(instr);
            continue;
        }
        const mask = instr.dest.mask;
        const comps = [0, 1, 2, 3].filter(c=>(mask & 1 << c) !== 0);
        const plain = instr.op === 'mov' && !instr.sat && !instr.shift;
        const head = `${instr.op}|${instr.sat ? 's' : ''}|${instr.shift ?? 0}|${
            instr.texMode ?? ''}|${instr.pp ? 'p' : ''}`;
        /** @type {number[]} */
        let values;
        if (plain)
        {
            // A copy holds what it copies.
            values = comps.map(c=>{
                const lane = laneValue(instr.srcs[0], c);
                return lane.startsWith('#') && /^#\d+$/.test(lane) ? Number(lane.slice(1))
                    : idOf(lane);
            });
        }
        else if (cls === 'comp')
        {
            values = comps.map(c=>idOf(`${head}(${instr.srcs.map(src=>laneValue(src, c))})`));
        }
        else if ((cls === 'scalar' || cls === 'lanes' || cls === 'texture') && instr.srcs.length > 0
            && instr.op !== 'mova')
        {
            // A sampler has no lanes and is read whole.
            const whole = `${head}(${instr.srcs.map((src, k)=>(laneCount(src) === 0
                ? laneValue(src, 0)
                : lanesRead(instr, k).map(lane=>laneValue(src, lane)).join(' '))).join(',')})`;
            // A texel and a sine-cosine pair differ by component; the rest are replicated.
            const perComponent = cls === 'texture' || instr.op === 'sincos';
            values = comps.map(c=>idOf(perComponent ? `${whole}#${c}` : whole));
        }
        else
        {
            values = comps.map(()=>idOf(`?${fresh++}`));
        }
        const pinned = instr.dest.kind === 'reg'
            && (instr.dest.reg.pin || instr.dest.reg.fixed || instr.dest.reg.uniform);
        const found = plain ? null : holderOf(values);
        if (found && instr.dest.kind === 'reg' && found.reg === instr.dest.reg
            && found.comps.every((comp, i)=>comp === comps[i]))
        {
            // Already there: nothing to do -- a texel fetched again into the register a
            // model 1 texture read fills.
            continue;
        }
        const pin = instr.dest.kind === 'reg' ? instr.dest.reg.pin : undefined;
        const samePin = found?.reg.pin && pin && found.reg.pin.file === pin.file
            && found.reg.pin.index === pin.index && found.reg.pin.sampler === pin.sampler
            && found.comps.every((comp, i)=>comp === comps[i]);
        if (samePin && instr.dest.kind === 'reg' && found)
        {
            alias.set(instr.dest.reg, found.reg);
            continue;
        }
        if (found && !pinned)
        {
            const swz = [0, 1, 2, 3].map(c=>found.comps[Math.max(0, comps.indexOf(c))]);
            instr = { op: 'mov', dest: instr.dest,
                srcs: [{ kind: 'reg', reg: found.reg, swz }] };
        }
        if (instr.dest.kind === 'reg')
        {
            const reg = instr.dest.reg;
            comps.forEach((c, i)=>put(reg, c, values[i]));
        }
        out.push(instr);
    }
    return out;
}

/**
 * A value built by moving scalars into the lanes of a register is built by the
 * instructions that made the scalars, writing those lanes themselves -- and a
 * value only saturated on its way is saturated by what made it (mad_sat for a
 * mad and a mov_sat).
 *
 * @param {Instr[]} instrs
 * @returns {Instr[]}
 */
export function coalesceMoves(instrs){
    const { writers, reads } = usage(instrs);
    /** @type {Map<number, Instr>} */
    const replaced = new Map();
    /** @type {Set<number>} */
    const dropped = new Set();
    instrs.forEach((move, j)=>{
        if (move.op !== 'mov' || move.dest.kind !== 'reg' || move.shift !== undefined
            || move.dest.reg.pin || move.dest.reg.fixed)
        {
            return;
        }
        const src = move.srcs[0];
        if (src.kind !== 'reg' || src.neg || src.abs || reads.get(src.reg) !== 1)
        {
            return;
        }
        const made = writers.get(src.reg);
        // A maker already merged into the move after it is gone: a chain of moves is
        // merged one link at a time.
        if (!made || made.length !== 1 || replaced.has(made[0]) || dropped.has(made[0]))
        {
            return;
        }
        const maker = instrs[made[0]];
        const cls = /** @type {Record<string, { cls: string }>} */ (OPCODES)[maker.op]?.cls;
        if (maker.dest.kind !== 'reg' || !(cls === 'comp' || cls === 'scalar' || cls === 'lanes')
            || maker.op === 'sincos' || (move.sat && (maker.sat || maker.shift !== undefined)))
        {
            return;
        }
        const mask = move.dest.mask;
        /** The component of the scalar's register each destination component reads. */
        const from = [0, 1, 2, 3].map(c=>src.swz[Math.min(c, src.swz.length - 1)]);
        let covered = true;
        let first = -1;
        for (let c = 0; c < 4; c++)
        {
            if ((mask & 1 << c) !== 0)
            {
                covered = covered && (maker.dest.mask & 1 << from[c]) !== 0;
                first = first < 0 ? from[c] : first;
            }
        }
        if (!covered)
        {
            return;
        }
        const lanes = from.map((l, c)=>((mask & 1 << c) !== 0 ? l : first));
        const srcs = cls === 'comp' ? maker.srcs.map(one=>reselect(one, lanes, false))
            : maker.srcs;
        replaced.set(made[0], { ...maker, srcs, dest: { kind: 'reg', reg: move.dest.reg, mask },
            ...(move.sat ? { sat: true } : {}) });
        dropped.add(j);
    });
    return instrs.map((instr, i)=>replaced.get(i) ?? instr).filter((_, i)=>!dropped.has(i));
}

/**
 * A result that is only moved to an output is written there in the first place --
 * by each of its writers, when it was made in parts.
 *
 * @param {Instr[]} instrs
 * @returns {Instr[]}
 */
export function forwardOutputs(instrs){
    const { writers, reads } = usage(instrs);
    /** @type {Map<number, Instr>} */
    const replaced = new Map();
    /** @type {Set<number>} */
    const dropped = new Set();
    instrs.forEach((instr, j)=>{
        if (instr.op !== 'mov' || instr.dest.kind !== 'out' || instr.sat)
        {
            return;
        }
        const src = instr.srcs[0];
        if (src.kind !== 'reg' || src.neg || src.abs || reads.get(src.reg) !== 1)
        {
            return;
        }
        const made = writers.get(src.reg);
        if (!made || made.some(i=>i > j || replaced.has(i)))
        {
            return;
        }
        // The writers, in parts if there are several, make exactly what the output takes.
        let covered = 0;
        for (const i of made)
        {
            const maker = instrs[i];
            const cls = /** @type {Record<string, { cls: string }>} */ (OPCODES)[maker.op]?.cls;
            if (maker.dest.kind !== 'reg'
                || !(cls === 'comp' || cls === 'scalar' || cls === 'lanes')
                || maker.op === 'sincos' || (maker.dest.mask & ~instr.dest.mask) !== 0
                || (maker.dest.mask & covered) !== 0)
            {
                return;
            }
            covered |= maker.dest.mask;
        }
        if (covered !== instr.dest.mask)
        {
            return;
        }
        // Each output component must come from the same component of the result.
        for (let c = 0; c < 4; c++)
        {
            if ((instr.dest.mask & 1 << c) !== 0 && src.swz[c] !== c)
            {
                return;
            }
        }
        for (const i of made)
        {
            const maker = instrs[i];
            replaced.set(i, { ...maker, dest: { kind: 'out', out: instr.dest.out,
                mask: /** @type {{ mask: number }} */ (maker.dest).mask } });
        }
        dropped.add(j);
    });
    return instrs.map((instr, i)=>replaced.get(i) ?? instr).filter((_, i)=>!dropped.has(i));
}

/**
 * Gives every constant its register. A register the program named is taken
 * first and nothing else lands on it; the rest follow in declaration order.
 *
 * @param {Const[]} constants @param {Diagnostic[]} diagnostics
 * @returns {Set<number>}   The float registers in use.
 */
export function assignConstants(constants, diagnostics){
    /** @type {Record<string, Set<number>>} */
    const taken = { f: new Set(), i: new Set(), b: new Set(), s: new Set() };
    /** @param {Const} c */
    const size = c=>(c.set === 's' ? 1 : registersOf(c.type));
    for (const c of constants)
    {
        if (c.explicit === undefined)
        {
            continue;
        }
        c.index = c.explicit;
        for (let r = 0; r < size(c); r++)
        {
            if (taken[c.set].has(c.explicit + r))
            {
                diagnostics.push({ code: 'X3115', message: `'${c.name}': register ${
                    c.set}${c.explicit + r} is already in use` });
            }
            taken[c.set].add(c.explicit + r);
        }
    }
    for (const c of constants)
    {
        if (c.explicit !== undefined)
        {
            continue;
        }
        let at = 0;
        const need = size(c);
        for (;;)
        {
            let fits = true;
            for (let r = 0; r < need; r++)
            {
                if (taken[c.set].has(at + r))
                {
                    fits = false;
                    at += r + 1;
                    break;
                }
            }
            if (fits)
            {
                break;
            }
        }
        c.index = at;
        for (let r = 0; r < need; r++)
        {
            taken[c.set].add(at + r);
        }
    }
    return taken.f;
}

/**
 * Replaces the literals with reads of `def` registers, packing the values of
 * every literal into as few registers as they fit: a literal is found in a
 * register that already holds all its values, or placed in one with room, or
 * given a register of its own.
 *
 * @param {Instr[]} instrs @param {Set<number>} reserved   Float registers already taken.
 * @returns {{ index: number, values: number[] }[]}
 */
function packLiterals(instrs, reserved){
    /** @type {{ index: number, values: number[] }[]} */
    const defs = [];
    /** @type {Map<string, number[]>} */
    const tuples = new Map();
    /** @param {number[]} values */
    const keyOf = values=>values.map(v=>(Object.is(Math.fround(v), -0) ? '-0'
        : String(Math.fround(v)))).join(',');
    for (const instr of instrs)
    {
        for (const src of instr.srcs)
        {
            if (src.kind === 'imm')
            {
                tuples.set(keyOf(src.values), src.values.map(v=>Math.fround(v)));
            }
        }
    }
    /** @param {number[]} values @param {number} v */
    const find = (values, v)=>values.findIndex(x=>Object.is(x, v));
    /** @type {Map<string, { home: { index: number, values: number[] }, lanes: number[] }>} */
    const placed = new Map();
    for (const [key, tuple] of [...tuples].sort((a, b)=>b[1].length - a[1].length))
    {
        const distinct = tuple.filter((v, i)=>find(tuple, v) === i);
        // A register already holding every value, else one with room for the
        // missing ones, else a register of its own.
        let home = defs.find(d=>distinct.every(v=>find(d.values, v) >= 0))
            ?? defs.find(d=>d.values.length + distinct.filter(v=>find(d.values, v) < 0)
                .length <= 4);
        if (!home)
        {
            home = { index: -1, values: [] };
            defs.push(home);
        }
        for (const v of distinct)
        {
            if (find(home.values, v) < 0)
            {
                home.values.push(v);
            }
        }
        placed.set(key, { home, lanes: tuple.map(v=>find(/** @type {any} */ (home).values, v)) });
    }
    let next = 0;
    for (const d of defs)
    {
        while (reserved.has(next))
        {
            next++;
        }
        d.index = next++;
    }
    for (const instr of instrs)
    {
        instr.srcs = instr.srcs.map(src=>{
            if (src.kind !== 'imm')
            {
                return src;
            }
            const { home, lanes } = /** @type {NonNullable<ReturnType<typeof placed.get>>} */ (
                placed.get(keyOf(src.values)));
            /** @type {SrcCreg} */
            const creg = { kind: 'creg', file: 'f', index: home.index, swz: lanes,
                ...(src.neg ? { neg: true } : {}), ...(src.abs ? { abs: true } : {}) };
            return /** @type {any} */ (creg);
        });
    }
    for (const d of defs)
    {
        while (d.values.length < 4)
        {
            d.values.push(0);
        }
        reserved.add(d.index);
    }
    return defs;
}

/**
 * The register a source reads in the constant file, as a comparable key, or null.
 *
 * @param {Src} src
 * @returns {string | null}
 */
export function constKey(src){
    if (src.kind === 'creg')
    {
        return `${src.file}${src.index}${src.relative ? 'r' : ''}`;
    }
    if (src.kind === 'const')
    {
        return `${src.cst.set}${(src.cst.index ?? 0) + src.offset}${src.relative ? 'r' : ''}`;
    }
    return null;
}

/**
 * Copies the operands the target cannot read in place to temporaries.
 *
 * @param {Instr[]} instrs @param {Profile} profile
 * @param {() => VReg} newReg
 * @returns {Instr[]}
 */
function legalize(instrs, profile, newReg){
    /** @type {Instr[]} */
    const out = [];
    /**
     * A temporary holding `src`, as lanes 0 to n-1.
     *
     * @param {Src} src
     * @returns {Src}
     */
    const copy = src=>{
        const width = Math.max(laneCount(src), 1);
        const reg = newReg();
        reg.width = width;
        out.push({ op: 'mov', dest: { kind: 'reg', reg, mask: (1 << width) - 1 },
            srcs: [src] });
        return { kind: 'reg', reg, swz: Array.from({ length: width }, (_, i)=>i) };
    };
    for (const instr of instrs)
    {
        const srcs = instr.srcs.slice();
        const sampler = instr.op === 'texld' || instr.op === 'texldd' || instr.op === 'texldl';
        srcs.forEach((src, k)=>{
            if (sampler && k === 1)
            {
                return;
            }
            if ((src.kind === 'creg' || src.kind === 'const' || src.kind === 'input'
                || src.kind === 'reg' || src.kind === 'misc') && 'abs' in src && src.abs
                && !profile.absModifier)
            {
                // |x| as an instruction; max(x, -x) where there is none.
                const reg = newReg();
                const width = Math.max(laneCount(src), 1);
                reg.width = width;
                const mask = (1 << width) - 1;
                /** @type {Src} */
                const plain = { ...src };
                delete /** @type {any} */ (plain).abs;
                delete /** @type {any} */ (plain).neg;
                if (profile.absOp)
                {
                    out.push({ op: 'abs', dest: { kind: 'reg', reg, mask },
                        srcs: [plain] });
                }
                else
                {
                    out.push({ op: 'max', dest: { kind: 'reg', reg, mask },
                        srcs: [plain, { ...plain, neg: true }] });
                }
                srcs[k] = { kind: 'reg', reg, swz: Array.from({ length: width }, (_, i)=>i),
                    ...(src.neg ? { neg: true } : {}) };
            }
        });
        // Texture coordinates come from a temporary or a texture coordinate register.
        if (instr.op === 'texld' || instr.op === 'texldd' || instr.op === 'texldl')
        {
            const coord = srcs[0];
            const colour = coord.kind === 'input' && coord.input.usage === USAGE.COLOR
                && profile.major < 3;
            if (coord.kind === 'creg' || coord.kind === 'const' || coord.kind === 'misc'
                || colour || (profile.kind === 'ps' && profile.major < 3
                    && coord.kind === 'reg' && (coord.neg || coord.abs)))
            {
                srcs[0] = /** @type {Src} */ (copy(coord));
            }
        }
        if (profile.oneConstPerInstr && instr.op !== 'sincos')
        {
            const seen = new Set();
            srcs.forEach((src, k)=>{
                const key = constKey(src);
                if (key === null)
                {
                    return;
                }
                if (seen.size > 0 && !seen.has(key))
                {
                    srcs[k] = /** @type {Src} */ (copy(src));
                    return;
                }
                seen.add(key);
            });
        }
        if (profile.oneInputPerInstr)
        {
            const seen = new Set();
            srcs.forEach((src, k)=>{
                if (src.kind !== 'input')
                {
                    return;
                }
                if (seen.size > 0 && !seen.has(src.input))
                {
                    srcs[k] = /** @type {Src} */ (copy(src));
                    return;
                }
                seen.add(src.input);
            });
        }
        out.push({ ...instr, srcs });
    }
    return out;
}

/** Where a virtual register lives: a temporary and the components it takes, lane order. */
/** @typedef {{ reg: number, comps: number[] }} Home */

/**
 * Gives the virtual registers homes.
 *
 * @param {Instr[]} instrs
 * @returns {{ homes: Map<VReg, Home>, temps: number }}
 */
function allocate(instrs){
    /** @type {Map<VReg, { start: number, end: number }>} */
    const ranges = new Map();
    instrs.forEach((instr, i)=>{
        for (const src of instr.srcs)
        {
            if (src.kind === 'reg')
            {
                const range = ranges.get(src.reg);
                if (!range)
                {
                    throw new Error(`internal: v${src.reg.id} is read at instruction ${i} `
                        + 'before any write');
                }
                range.end = Math.max(range.end, i);
            }
        }
        if (instr.dest.kind === 'reg')
        {
            const range = ranges.get(instr.dest.reg);
            if (!range)
            {
                ranges.set(instr.dest.reg, { start: i, end: i });
            }
            else
            {
                range.end = Math.max(range.end, i);
            }
        }
    });
    const order = [...ranges.entries()].sort((a, b)=>a[1].start - b[1].start);
    /** @type {number[][]} The instruction until which each component is taken. */
    const busy = [];
    /** @type {Map<VReg, Home>} */
    const homes = new Map();
    /** @param {number} reg */
    const row = reg=>{
        while (busy.length <= reg)
        {
            busy.push([-1, -1, -1, -1]);
        }
        return busy[reg];
    };
    /** @param {VReg} v @returns {number[][]} */
    const candidates = v=>{
        if (v.fixed)
        {
            return [Array.from({ length: v.fixed }, (_, i)=>i)];
        }
        switch (v.width)
        {
            case 1: return [[0], [1], [2], [3]];
            case 2: return [[0, 1], [2, 3]];
            case 3: return [[0, 1, 2], [1, 2, 3]];
            default: return [[0, 1, 2, 3]];
        }
    };
    let temps = 0;
    for (const [v, range] of order)
    {
        let chosen = null;
        for (let r = 0; chosen === null; r++)
        {
            const slots = row(r);
            for (const comps of candidates(v))
            {
                if (comps.every(k=>slots[k] <= range.start))
                {
                    chosen = { reg: r, comps };
                    break;
                }
            }
        }
        for (const k of chosen.comps)
        {
            row(chosen.reg)[k] = range.end;
        }
        homes.set(v, chosen);
        temps = Math.max(temps, chosen.reg + 1);
    }
    return { homes, temps };
}

/**
 * Where an output goes in the register file of the target.
 *
 * @param {Profile} profile @param {Output} out @param {number} position   Among the outputs.
 * @returns {{ type: number, index: number } | null}
 */
function outputRegister(profile, out, position){
    if (profile.kind === 'ps')
    {
        if (out.usage === USAGE.COLOR && out.index < 4)
        {
            return { type: REG.COLOROUT, index: out.index };
        }
        if (out.usage === USAGE.DEPTH)
        {
            return { type: REG.DEPTHOUT, index: 0 };
        }
        return null;
    }
    if (profile.major >= 3)
    {
        return position < profile.maxOutputs ? { type: REG.OUTPUT, index: position } : null;
    }
    switch (out.usage)
    {
        case USAGE.POSITION:
        case USAGE.POSITIONT:
            return { type: REG.RASTOUT, index: 0 };
        case USAGE.FOG:
            return { type: REG.RASTOUT, index: 1 };
        case USAGE.PSIZE:
            return { type: REG.RASTOUT, index: 2 };
        case USAGE.COLOR:
            return out.index < 2 ? { type: REG.ATTROUT, index: out.index } : null;
        case USAGE.TEXCOORD:
            return out.index < 8 ? { type: REG.TEXCRDOUT, index: out.index } : null;
        default:
            return null;
    }
}

/**
 * Where an input arrives in the register file of the target.
 *
 * @param {Profile} profile @param {Input} input @param {number} position
 * @returns {{ type: number, index: number } | null}
 */
function inputRegister(profile, input, position){
    if (profile.kind === 'vs' || profile.major >= 3)
    {
        return position < profile.maxInputs ? { type: REG.INPUT, index: position } : null;
    }
    if (input.usage === USAGE.COLOR && input.index < 2)
    {
        return { type: REG.INPUT, index: input.index };
    }
    if (input.usage === USAGE.TEXCOORD && input.index < 8)
    {
        return { type: REG.TEXTURE, index: input.index };
    }
    return null;
}

export const USAGE_NAMES = Object.fromEntries(Object.entries(USAGE).map(([k, v])=>[v, k]));

/**
 * The shader, as tokens.
 *
 * @param {IrProgram} ir
 * @param {{ creator?: string, flags?: number, debug?: boolean }} [options]
 * @returns {AssembleResult}
 */
export function assemble(ir, options = {}){
    const { profile } = ir;
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const stats = { arith: 0, texture: 0, slots: 0, temps: 0, constants: 0, defs: 0 };
    let counter = ir.vregCount;
    /** @returns {VReg} */
    const newReg = ()=>({ id: counter++, width: 4 });

    let instrs = prune(ir.instrs.map(i=>({ ...i, srcs: i.srcs.slice() })));
    instrs = prune(numberValues(instrs, profile));
    instrs = forwardOutputs(coalesceMoves(fuseMultiplyAdd(instrs, profile)));
    for (const instr of instrs)
    {
        if (instr.op === 'sincos' && profile.sincosConstants)
        {
            instr.srcs = [instr.srcs[0], ...SINCOS_TAYLOR.map(values=>
                /** @type {Src} */ ({ kind: 'imm', values }))];
        }
    }
    // An input nothing reads is not declared: a structure that carries more than the
    // shader uses is the usual case.
    const read = new Set();
    for (const instr of instrs)
    {
        for (const src of instr.srcs)
        {
            if (src.kind === 'input')
            {
                read.add(src.input);
            }
        }
    }
    ir.inputs = ir.inputs.filter(input=>read.has(input));
    const reserved = assignConstants(ir.constants, diagnostics);
    const defs = packLiterals(instrs, reserved);
    instrs = legalize(instrs, profile, newReg);
    const { homes, temps } = allocate(instrs);

    // Registers of inputs and outputs, and what each is read or written through.
    /** @type {Map<Input, { type: number, index: number }>} */
    const inputRegs = new Map();
    ir.inputs.forEach((input, position)=>{
        const home = inputRegister(profile, input, position);
        if (!home)
        {
            diagnostics.push({ code: 'X4502', message: `invalid ${profile.name} input semantic '${
                USAGE_NAMES[input.usage] ?? input.usage}${input.index}'` });
            return;
        }
        inputRegs.set(input, home);
        input.reg = home.index;
        input.file = home.type === REG.TEXTURE ? 't' : 'v';
    });
    /** @type {Map<Output, { type: number, index: number }>} */
    const outputRegs = new Map();
    ir.outputs.forEach((out, position)=>{
        const home = outputRegister(profile, out, position);
        if (!home)
        {
            diagnostics.push({ code: 'X4503', message: `invalid ${profile.name} output semantic '${
                USAGE_NAMES[out.usage] ?? out.usage}${out.index}'` });
            return;
        }
        outputRegs.set(out, home);
        out.reg = home.index;
    });
    let vposUsed = 0;
    let vfaceUsed = false;

    /** @param {Src} src @param {number} lane @returns {number} */
    const sourceComponent = (src, lane)=>{
        switch (src.kind)
        {
            case 'reg': {
                const home = /** @type {Home} */ (homes.get(src.reg));
                return home.comps[src.swz[Math.min(lane, src.swz.length - 1)]];
            }
            case 'creg':
            case 'const':
            case 'input':
            case 'misc':
                return src.swz[Math.min(lane, src.swz.length - 1)];
            default:
                return 0;
        }
    };

    /**
     * @param {Src} src
     * @param {number[]} slots   For each of the four swizzle slots, the lane it reads.
     * @returns {PhysOperand}
     */
    const physicalSource = (src, slots)=>{
        const swz = slots.map(lane=>(src.kind === 'sampler' ? lane : sourceComponent(src, lane)));
        /** @type {PhysOperand} */
        let operand;
        switch (src.kind)
        {
            case 'reg':
                operand = { type: REG.TEMP, index: /** @type {Home} */ (homes.get(src.reg)).reg };
                break;
            case 'creg':
                operand = { type: src.file === 'f' ? REG.CONST : src.file === 'i' ? REG.CONSTINT
                    : REG.CONSTBOOL, index: src.index, relative: src.relative };
                break;
            case 'const':
                operand = { type: src.cst.set === 'f' ? REG.CONST : src.cst.set === 'i'
                    ? REG.CONSTINT : REG.CONSTBOOL, index: (src.cst.index ?? 0) + src.offset,
                relative: src.relative };
                break;
            case 'input': {
                const home = /** @type {{ type: number, index: number }} */ (
                    inputRegs.get(src.input));
                operand = { type: home.type, index: home.index };
                break;
            }
            case 'misc':
                operand = { type: REG.MISC, index: src.which === 'vpos' ? 0 : 1 };
                break;
            case 'sampler':
                operand = { type: REG.SAMPLER, index: src.cst.index ?? 0 };
                break;
            default:
                throw new Error(`internal: unresolved ${src.kind} operand`);
        }
        operand.swz = swz;
        const abs = 'abs' in src && src.abs;
        const neg = 'neg' in src && src.neg;
        operand.mod = abs ? (neg ? MOD.ABSNEG : MOD.ABS) : neg ? MOD.NEG : MOD.NONE;
        return operand;
    };

    /** @type {PhysInstr[]} */
    const physical = [];
    for (const instr of instrs)
    {
        const info = /** @type {Record<string, { cls: string }>} */ (OPCODES)[instr.op];
        if (!info)
        {
            throw new Error(`internal: no opcode '${instr.op}'`);
        }
        /** @type {PhysOperand | null} */
        let dest = null;
        /** @type {number[]} physical component of each destination component */
        let placeOf = [0, 1, 2, 3];
        switch (instr.dest.kind)
        {
            case 'reg': {
                const home = /** @type {Home} */ (homes.get(instr.dest.reg));
                placeOf = home.comps;
                let mask = 0;
                for (let c = 0; c < 4; c++)
                {
                    if ((instr.dest.mask & 1 << c) !== 0)
                    {
                        mask |= 1 << home.comps[c];
                    }
                }
                dest = { type: REG.TEMP, index: home.reg, mask };
                break;
            }
            case 'out': {
                const home = outputRegs.get(instr.dest.out);
                if (!home)
                {
                    continue;
                }
                instr.dest.out.written = (instr.dest.out.written ?? 0) | instr.dest.mask;
                dest = { type: home.type, index: home.index, mask: instr.dest.mask };
                break;
            }
            case 'addr':
                dest = { type: REG.ADDR, index: 0, mask: 1 };
                break;
            default:
                break;
        }
        if (dest && instr.sat)
        {
            dest.sat = true;
        }
        if (dest && instr.pp)
        {
            dest.pp = true;
        }

        if (instr.op === 'texkill')
        {
            // The register itself is named; its x, y and z decide.
            const src = instr.srcs[0];
            if (src.kind !== 'reg')
            {
                throw new Error('internal: texkill needs a temporary');
            }
            const home = /** @type {Home} */ (homes.get(src.reg));
            physical.push({ op: 'texkill', dest: { type: REG.TEMP, index: home.reg, mask: 0xf },
                srcs: [] });
            continue;
        }

        /** @type {number[]} */
        const destComps = [];
        const destMask = dest?.mask ?? 0;
        for (let p = 0; p < 4; p++)
        {
            if ((destMask & 1 << p) !== 0)
            {
                destComps.push(p);
            }
        }
        /** The vreg component behind each physical destination component. */
        const lanesOfDest = destComps.map(p=>placeOf.indexOf(p));
        /** @type {PhysOperand[]} */
        const srcs = instr.srcs.map((src, k)=>{
            for (const lane of lanesRead(instr, k))
            {
                if (src.kind === 'input')
                {
                    src.input.used = (src.input.used ?? 0) | 1 << sourceComponent(src, lane);
                }
                else if (src.kind === 'misc')
                {
                    if (src.which === 'vpos')
                    {
                        vposUsed |= 1 << sourceComponent(src, lane);
                    }
                    else
                    {
                        vfaceUsed = true;
                    }
                }
            }
            /** @type {number[]} */
            let slots;
            const count = Math.max(laneCount(src), 1);
            if (src.kind === 'sampler')
            {
                slots = [0, 1, 2, 3];
            }
            else if (info.cls === 'scalar' || (instr.op === 'dp2add' && k === 2))
            {
                slots = [0, 0, 0, 0];
            }
            else if (info.cls === 'comp')
            {
                // Slot p carries the lane of the destination component placed at p.
                const fallback = lanesOfDest.length > 0 ? lanesOfDest[0] : 0;
                slots = [0, 1, 2, 3].map(p=>{
                    const at = destComps.indexOf(p);
                    return at >= 0 ? lanesOfDest[at] : fallback;
                });
            }
            else
            {
                slots = [0, 1, 2, 3].map(j=>Math.min(j, count - 1));
            }
            // A taylor constant of sincos reads all four of its lanes.
            if (instr.op === 'sincos' && k > 0)
            {
                slots = [0, 1, 2, 3];
            }
            return physicalSource(src, slots);
        });
        let control = 0;
        if (instr.op === 'texld' || instr.op === 'texldd' || instr.op === 'texldl')
        {
            control = instr.texMode === 'project' ? 1 : instr.texMode === 'bias' ? 2 : 0;
        }
        const opName = instr.op === 'mova' && !profile.mova ? 'mov' : instr.op;
        physical.push({ op: opName, dest, srcs, control });
    }

    // Declarations.
    /** @type {import('./hlsl-encode.js').PhysDcl[]} */
    const decls = [];
    ir.inputs.forEach(input=>{
        const home = inputRegs.get(input);
        if (!home)
        {
            return;
        }
        const used = input.used ?? 0;
        if (profile.kind === 'vs' || profile.major >= 3)
        {
            decls.push({ usage: input.usage, usageIndex: input.index,
                dest: { type: home.type, index: home.index,
                    mask: profile.kind === 'vs' ? 0xf : used || 0xf } });
        }
        else
        {
            decls.push({ dest: { type: home.type, index: home.index, mask: used || 0xf } });
        }
    });
    if (vposUsed !== 0)
    {
        decls.push({ dest: { type: REG.MISC, index: 0, mask: vposUsed } });
    }
    if (vfaceUsed)
    {
        decls.push({ dest: { type: REG.MISC, index: 1, mask: 0xf } });
    }
    if (profile.kind === 'vs' && profile.major >= 3)
    {
        ir.outputs.forEach(out=>{
            const home = outputRegs.get(out);
            if (home)
            {
                decls.push({ usage: out.usage, usageIndex: out.index,
                    dest: { type: home.type, index: home.index, mask: out.written || 0xf } });
            }
        });
    }
    for (const cst of ir.constants)
    {
        if (cst.set === 's')
        {
            decls.push({ samplerType: (cst.dim ?? 2) << 27,
                dest: { type: REG.SAMPLER, index: cst.index ?? 0, mask: 0xf } });
        }
    }

    // The program is checked against what the target holds.
    for (const instr of instrs)
    {
        if (TEXTURE_OPS.has(instr.op))
        {
            stats.texture++;
        }
        else
        {
            stats.arith++;
            stats.slots += SLOT_COST[instr.op] ?? 1;
        }
    }
    stats.temps = temps;
    stats.constants = ir.constants.reduce((n, c)=>n + (c.set === 'f' ? registersOf(c.type) : 0), 0);
    stats.defs = defs.length;
    const total = stats.slots + stats.texture;
    if (profile.maxTex > 0)
    {
        if (stats.slots > profile.maxArith)
        {
            diagnostics.push({ code: 'X5608', message: 'Compiled shader code uses too many '
                + `arithmetic instruction slots (${stats.slots}). Max. allowed by the target `
                + `(${profile.name}) is ${profile.maxArith}.` });
        }
        if (stats.texture > profile.maxTex)
        {
            diagnostics.push({ code: 'X5609', message: 'Compiled shader code uses too many '
                + `texture instruction slots (${stats.texture}). Max. allowed by the target `
                + `(${profile.name}) is ${profile.maxTex}.` });
        }
    }
    else if (total > profile.maxArith)
    {
        diagnostics.push({ code: 'X5608', message: 'Compiled shader code uses too many '
            + `instruction slots (${total}). Max. allowed by the target (${profile.name}) is `
            + `${profile.maxArith}.` });
    }
    if (temps > profile.maxTemps)
    {
        diagnostics.push({ code: 'X4505',
            message: `Temporary register limit of ${profile.maxTemps} exceeded; `
            + `${temps} registers needed to compile program` });
    }
    const samplerCount = ir.constants.filter(c=>c.set === 's').length;
    if (profile.maxSamplers > 0 && samplerCount > profile.maxSamplers)
    {
        diagnostics.push({ code: 'X4510',
            message: `Sampler register limit of ${profile.maxSamplers} exceeded; `
            + `${samplerCount} registers needed to compile program` });
    }
    const constantRegisters = reserved.size > 0 ? Math.max(...reserved) + 1 : 0;
    if (constantRegisters > profile.maxConsts)
    {
        diagnostics.push({ code: 'X4507',
            message: `Constant register limit of ${profile.maxConsts} exceeded; `
            + `${constantRegisters} registers needed to compile program` });
    }
    if (diagnostics.length > 0)
    {
        return { tokens: null, diagnostics, stats };
    }

    const comment = constantTableComment({
        constants: ir.constants,
        creator: options.creator ?? 'Bottlify HLSL compiler', target: profile.name,
        version: ((profile.kind === 'vs' ? 0xfffe0000 : 0xffff0000) | profile.major << 8
            | profile.tokenMinor) >>> 0,
        flags: options.flags ?? 0,
    });
    const tokens = encodeProgram({ profile, decls, defs, instrs: physical, comment });
    return { tokens, diagnostics, stats };
}
