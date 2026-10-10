/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The back half for pixel shader model 1 (ps_1_1 to ps_1_4).
 *
 * That model is not a smaller version of the others. A texture read leaves
 * its texel in the texture register of its own stage, and reads the coordinate
 * set of the same number; the colour is computed in two temporaries (six from
 * 1.4) and ends in r0; a source can be swizzled only by replicating its blue or
 * alpha, a result written only as red-green-blue, alpha, or both; constants are
 * held to [-1, 1]; a program may be eight arithmetic instructions long, and a
 * pair of an rgb and an alpha instruction counts as one. 1.4 adds a second phase
 * so that a texture can be read at coordinates the first phase computed.
 *
 * What this module does with the straight-line code of the front half is
 * therefore mostly to check that it fits, and to arrange it so that it does:
 * a value of one lane lives in the alpha component, where a replicated source
 * can reach it; the texture reads are hoisted ahead of the arithmetic, and
 * split into phases where one depends on another; a product by a power of
 * two becomes the destination's scale, `1 - x`, `x - 0.5` and `2x - 1` become
 * modifiers of the source; and what cannot be written in the model is reported
 * rather than written wrong.
 */

import { TargetError, USAGE } from './hlsl-ir.js';
import { OPCODES, REG, MOD, encodeProgram } from './hlsl-encode.js';
import { constantTableComment } from './hlsl-ctab.js';
import {
    assignConstants, coalesceMoves, forwardOutputs, fuseMultiplyAdd, lanesRead, numberValues,
    prune, reselect, usage, USAGE_NAMES,
} from './hlsl-backend.js';

/** @typedef {import('./hlsl-ir.js').IrProgram} IrProgram */
/** @typedef {import('./hlsl-ir.js').Instr} Instr */
/** @typedef {import('./hlsl-ir.js').Src} Src */
/** @typedef {import('./hlsl-ir.js').VReg} VReg */
/** @typedef {import('./hlsl-ir.js').Profile} Profile */
/** @typedef {import('./hlsl-backend.js').AssembleResult} AssembleResult */
/** @typedef {import('./hlsl-encode.js').PhysOperand} PhysOperand */
/** @typedef {import('./hlsl-encode.js').PhysInstr} PhysInstr */

/** A source's modifier by name, to the token. */
const MODIFIER = { comp: MOD.COMP, bias: MOD.BIAS, bx2: MOD.SIGN, x2: MOD.X2, dw: MOD.DW };

/** The scale a destination can take, by the factor, as the token holds it. */
const SHIFT = new Map([[2, 1], [4, 2], [8, 3], [0.125, 13], [0.25, 14], [0.5, 15]]);

/** A product by these is a scale of the destination: x2 and x4, d2 and d4 before 1.4. */
const EASY_SCALES = new Set([2, 4, 0.5, 0.25]);

/** @param {Src} src @returns {boolean} */
const isTexcoord = src=>src.kind === 'input' && src.input.usage === USAGE.TEXCOORD;

/**
 * `mul d, x, 2` and the like: a scale of the destination.
 *
 * @param {Instr[]} instrs @param {Profile} profile
 * @returns {Instr[]}
 */
function foldScales(instrs, profile){
    return instrs.map(instr=>{
        if (instr.op !== 'mul' || instr.dest.kind === 'none' || instr.dest.kind === 'addr'
            || instr.shift !== undefined)
        {
            return instr;
        }
        for (let k = 0; k < 2; k++)
        {
            const factor = instr.srcs[k];
            const other = instr.srcs[1 - k];
            if (factor.kind === 'imm' && factor.values.every(v=>v === factor.values[0])
                && (EASY_SCALES.has(factor.values[0])
                    || (profile.minor >= 4 && SHIFT.has(factor.values[0])))
                && other.kind !== 'imm')
            {
                return { ...instr, op: 'mov', srcs: [other],
                    shift: /** @type {number} */ (SHIFT.get(factor.values[0])) };
            }
        }
        return instr;
    });
}

/**
 * Source modifiers for the arithmetic that spells them: `1 - x`, `x - 0.5` and
 * `2x - 1`.
 *
 * @param {Instr[]} instrs
 * @returns {Instr[]}
 */
function foldModifiers(instrs){
    return instrs.map(instr=>{
        if (instr.dest.kind === 'none' || instr.dest.kind === 'addr' || instr.sat
            || instr.shift !== undefined)
        {
            return instr;
        }
        const [a, b, c] = instr.srcs;
        /** @param {Src} x @param {string} mod @returns {Instr} */
        const as = (x, mod)=>{
            const carried = /** @type {Src} */ ({ ...x, mod });
            return { ...instr, op: 'mov', srcs: [carried] };
        };
        const plain = (/** @type {Src} */ x)=>x.kind !== 'imm' && x.kind !== 'sampler'
            && !(/** @type {any} */ (x).neg) && !(/** @type {any} */ (x).abs)
            && !(/** @type {any} */ (x).mod);
        if (instr.op === 'sub' && a.kind === 'imm' && a.values.every(v=>v === 1) && plain(b))
        {
            return as(b, 'comp');
        }
        if (instr.op === 'add' && plain(a) && b.kind === 'imm' && b.values.every(v=>v === -0.5))
        {
            return as(a, 'bias');
        }
        if (instr.op === 'mad' && plain(a) && b.kind === 'imm' && b.values.every(v=>v === 2)
            && c.kind === 'imm' && c.values.every(v=>v === -1))
        {
            return as(a, 'bx2');
        }
        return instr;
    });
}

/**
 * A move that only carries a modifier is the modifier on whoever reads it.
 *
 * @param {Instr[]} instrs
 * @returns {Instr[]}
 */
function propagateModifiers(instrs){
    const { writers, reads } = usage(instrs);
    /** @type {Set<number>} */
    const dropped = new Set();
    const result = instrs.map(instr=>({ ...instr, srcs: instr.srcs.slice() }));
    result.forEach((move, i)=>{
        if (move.op !== 'mov' || move.dest.kind !== 'reg' || move.sat || move.shift !== undefined)
        {
            return;
        }
        const from = move.srcs[0];
        if (!(/** @type {any} */ (from).mod) || from.kind === 'imm' || from.kind === 'sampler')
        {
            return;
        }
        const { reg, mask } = move.dest;
        if (reads.get(reg) !== 1 || writers.get(reg)?.length !== 1
            || mask !== (1 << reg.width) - 1)
        {
            return;
        }
        for (let j = i + 1; j < result.length; j++)
        {
            const reader = result[j];
            const at = reader.srcs.findIndex(s=>s.kind === 'reg' && s.reg === reg);
            if (at < 0)
            {
                continue;
            }
            const use = /** @type {import('./hlsl-ir.js').SrcReg} */ (reader.srcs[at]);
            // A reader with a modifier of its own keeps it: 1 - (1 - x) is not 1 - x.
            if (use.neg || use.abs || use.mod || reader.op === 'texkill'
                || (reader.dest.kind === 'reg' && reader.dest.reg === reg))
            {
                return;
            }
            if (reader.srcs.some((s, k)=>k !== at && (/** @type {any} */ (s)).mod === from.mod
                && s.kind !== 'imm'))
            {
                return;
            }
            if (!('swz' in from))
            {
                return;
            }
            reader.srcs[at] = /** @type {Src} */ ({ ...from,
                swz: use.swz.map(l=>from.swz[Math.min(l, from.swz.length - 1)]) });
            dropped.add(i);
            return;
        }
    });
    return result.filter((_, i)=>!dropped.has(i));
}

/**
 * Where a lane of a source is, in the register file of the model: a value of
 * one lane lives in alpha.
 *
 * @param {Src} src @param {number} lane @param {Map<VReg, Home>} homes
 * @returns {number}
 */
function component(src, lane, homes){
    switch (src.kind)
    {
        case 'reg': {
            const home = /** @type {Home} */ (homes.get(src.reg));
            return home.comps[src.swz[Math.min(lane, src.swz.length - 1)]];
        }
        case 'creg': case 'const': case 'input': case 'misc':
            return src.swz[Math.min(lane, src.swz.length - 1)];
        default:
            return lane;
    }
}

/** @typedef {{ file: 'r' | 't', reg: number, comps: number[] }} Home */

/**
 * Compiles a program for a pixel shader model 1 target.
 *
 * @param {IrProgram} ir
 * @param {{ creator?: string, flags?: number }} [options]
 * @returns {AssembleResult}
 */
export function assembleLegacy(ir, options = {}){
    // Computing a value once keeps it alive until its last reader, and two temporaries
    // may not hold it: what does not fit is built again computing it where it is read.
    // Past the model's limits is a warning -- the program runs in WGSL, which has none --
    // so the build that fits is preferred, and one that does not is still given.
    /** @param {AssembleResult} r */
    const fits = r=>Boolean(r.tokens) && !r.diagnostics.some(d=>LIMITS.has(d.code));
    const numbered = assembleWith(ir, options, true);
    if (fits(numbered))
    {
        return numbered;
    }
    const plain = assembleWith(ir, options, false);
    return fits(plain) || !numbered.tokens ? plain : numbered;
}

/** The diagnostics of a program longer or wider than the model holds. */
const LIMITS = new Set(['X5608', 'X5609', 'X4505', 'X4507', 'X4510']);

/**
 * @param {IrProgram} ir @param {{ creator?: string, flags?: number }} options
 * @param {boolean} numbered   Whether each value is computed once (numberValues).
 * @returns {AssembleResult}
 */
function assembleWith(ir, options, numbered){
    /** @type {Rewrites} */
    const rewrites = { spread: new Set(), split: new Set(), merge: new Set(), numbered,
        keepMoves: false };
    // A source the model cannot read as it stands, or an instruction it cannot
    // write in one, is rewritten and the program built again from the start:
    // where a value lives is only known once it is placed.
    for (let attempt = 0; ; attempt++)
    {
        /** @type {import('./hlsl-backend.js').Diagnostic[]} */
        const diagnostics = [];
        const stats = { arith: 0, texture: 0, slots: 0, temps: 0, constants: 0, defs: 0 };
        try
        {
            return build(ir, options, diagnostics, stats, rewrites);
        }
        catch (e){
            if (e instanceof RewriteNeeded && attempt < 8)
            {
                const before = rewrites.spread.size + rewrites.split.size + rewrites.merge.size;
                e.spread.forEach(key=>rewrites.spread.add(key));
                e.split.forEach(key=>rewrites.split.add(key));
                e.merge.forEach(key=>rewrites.merge.add(key));
                const keepMoves = e.keepMoves && !rewrites.keepMoves;
                rewrites.keepMoves ||= e.keepMoves;
                if (rewrites.spread.size + rewrites.split.size + rewrites.merge.size > before
                    || keepMoves)
                {
                    continue;
                }
            }
            const failure = e instanceof RewriteNeeded ? e.failure : e;
            if (!(failure instanceof TargetError))
            {
                throw failure;
            }
            diagnostics.push({ code: failure.code, message: failure.message });
            return { tokens: null, diagnostics, stats };
        }
    }
}

/**
 * @typedef {{ spread: Set<string>, split: Set<string>, merge: Set<string>,
 *     numbered: boolean, keepMoves: boolean }} Rewrites
 * `spread`: the sources -- a value and the one component it is read as -- to
 * read through a dot product that puts that component in every lane;
 * `split`: the instructions to write one component at a time; `numbered`: whether each
 * value is computed once; `keepMoves`: the result moved into r0 at the end, not written
 * there earlier by what makes it; `merge`: the instructions that write components a model
 * before 1.4 cannot write alone, computed into a temporary and merged in.
 */

/** Where the numbers of the registers a spread reads start. */
const SPREAD_IDS = 1 << 24;

/** What a build found it has to rewrite, and the refusal it stands for if it cannot. */
class RewriteNeeded extends Error {
    /**
     * @param {string[]} spread @param {string[]} split @param {TargetError} failure
     * @param {boolean} [keepMoves]  The result is to be moved into r0 at the end rather
     *     than written there by what makes it.
     * @param {string[]} [merge]  Instructions writing components a model before 1.4 cannot
     *     write alone, to compute into a temporary and merge in.
     */
    constructor(spread, split, failure, keepMoves = false, merge = []){
        super(failure.message);
        this.spread = spread;
        this.split = split;
        this.failure = failure;
        this.keepMoves = keepMoves;
        this.merge = merge;
    }
}

/**
 * The key a source is rewritten by: the value it reads and the component it
 * replicates, or null for a source no rewrite applies to.
 *
 * @param {Src} src
 * @returns {string | null}
 */
function spreadKey(src){
    const swz = /** @type {number[] | undefined} */ (/** @type {any} */ (src).swz);
    if (!swz || !swz.every(c=>c === swz[0]))
    {
        return null;
    }
    const how = `${swz[0]}${/** @type {any} */ (src).neg ? '-' : ''}${
        /** @type {any} */ (src).mod ?? ''}`;
    switch (src.kind)
    {
        case 'reg':
            return `r${src.reg.id}.${how}`;
        case 'input':
            return `i${src.input.usage}:${src.input.index}.${how}`;
        case 'const':
            return `c${src.cst.name}+${src.offset}.${how}`;
        default:
            return null;
    }
}

/** The key an instruction is split by. @param {Instr} instr */
function splitKey(instr){
    const dest = instr.dest.kind === 'reg' ? `r${instr.dest.reg.id}`
        : instr.dest.kind === 'out' ? `o${instr.dest.out.usage}:${instr.dest.out.index}` : '-';
    return `${instr.op}>${dest}:${instr.dest.kind === 'reg' || instr.dest.kind === 'out'
        ? instr.dest.mask : 0}`;
}

/**
 * The rewrites applied: a split instruction becomes one for each component it
 * writes; a spread source reads a register that holds the component it wants
 * in all four lanes, from a dot product with a selector, which writes alpha as
 * well as the colour (fxc's dp3 r0, c1, t0).
 *
 * @param {Instr[]} instrs @param {Rewrites} rewrites
 * @returns {Instr[]}
 */
function applyRewrites(instrs, rewrites){
    if (rewrites.spread.size === 0 && rewrites.split.size === 0 && rewrites.merge.size === 0)
    {
        return instrs;
    }
    /** @type {Instr[]} */
    const out = [];
    let made = 0;
    /** The components of each register written so far. @type {Map<VReg, number>} */
    const written = new Map();
    /** @param {Instr} one */
    const push = one=>{
        if (one.dest.kind === 'reg')
        {
            written.set(one.dest.reg, (written.get(one.dest.reg) ?? 0) | one.dest.mask);
        }
        out.push(one);
    };
    /** @param {Src} src @returns {Src} */
    const spreadOf = src=>{
        const key = spreadKey(src);
        if (key === null || !rewrites.spread.has(key))
        {
            return src;
        }
        // The same value in all four lanes: read through any swizzle, as it stands.
        // Numbered apart from the registers the passes make, so that theirs -- which
        // a later rewrite may name -- are the same in every build.
        /** @type {VReg} */
        const spread = { id: SPREAD_IDS + made++, width: 4, uniform: true };
        const wanted = /** @type {number[]} */ (/** @type {any} */ (src).swz)[0];
        const selector = [0, 1, 2, 3].map(c=>(c === wanted ? 1 : 0));
        /** @type {Src} */
        const whole = /** @type {any} */ ({ ...src, swz: [0, 1, 2, 3] });
        push({ op: 'dp3', dest: { kind: 'reg', reg: spread, mask: 15 },
            srcs: [whole, { kind: 'imm', values: selector }] });
        return /** @type {Src} */ ({ kind: 'reg', reg: spread, swz: [0, 1, 2, 3] });
    };
    for (const instr of instrs)
    {
        const merged = rewrites.merge.has(splitKey(instr)) && instr.dest.kind === 'reg';
        const srcs = merged ? instr.srcs : instr.srcs.map(spreadOf);
        const mask = instr.dest.kind === 'reg' || instr.dest.kind === 'out' ? instr.dest.mask : 0;
        if (rewrites.split.has(splitKey(instr)) && (mask & (mask - 1)) !== 0)
        {
            for (let c = 0; c < 4; c++)
            {
                if ((mask & 1 << c) !== 0)
                {
                    push({ ...instr, srcs, dest: /** @type {any} */ ({ ...instr.dest,
                        mask: 1 << c }) });
                }
            }
            continue;
        }
        if (merged && instr.dest.kind === 'reg')
        {
            // fxc's way: each component computed into a temporary in every lane -- a source
            // read as one component, which a spread makes readable -- and laid over what the
            // register holds by a lrp with a selector; alpha by a move of its own.
            const target = instr.dest.reg;
            const lanewise = /** @type {Record<string, { cls: string }>} */ (OPCODES)[instr.op]
                ?.cls === 'comp';
            for (let c = 0; c < 4; c++)
            {
                if ((mask & 1 << c) === 0 || (!lanewise && c < 3 && (mask & ((1 << c) - 1)) !== 0))
                {
                    continue;
                }
                /** @type {VReg} */
                const temp = { id: SPREAD_IDS + made++, width: 4 };
                // A replicated result is one instruction for every component it fills.
                const fills = lanewise ? 1 << c : c === 3 ? 8 : mask & 7;
                push({ ...instr, dest: { kind: 'reg', reg: temp, mask: c === 3 ? 8 : 7 },
                    srcs: srcs.map(src=>spreadOf(lanewise ? reselect(src, [c, c, c, c], false)
                        : src)) });
                /** @type {Src} */
                const whole = { kind: 'reg', reg: temp, swz: [0, 1, 2, 3] };
                if (c === 3)
                {
                    push({ op: 'mov', dest: { kind: 'reg', reg: target, mask: 8 }, srcs: [whole] });
                    continue;
                }
                const held = written.get(target) ?? 0;
                if ((held & 7 & ~fills) === 0)
                {
                    push({ op: 'mov', dest: { kind: 'reg', reg: target, mask: 7 }, srcs: [whole] });
                    continue;
                }
                const selector = [0, 1, 2, 3].map(l=>((fills & 1 << l) !== 0 ? 1 : 0));
                push({ op: 'lrp', dest: { kind: 'reg', reg: target, mask: 7 },
                    srcs: [{ kind: 'imm', values: selector }, whole,
                        { kind: 'reg', reg: target, swz: [0, 1, 2, 3] }] });
            }
            continue;
        }
        push({ ...instr, srcs });
    }
    return out;
}

/**
 * @param {IrProgram} ir @param {{ creator?: string, flags?: number }} options
 * @param {import('./hlsl-backend.js').Diagnostic[]} diagnostics
 * @param {AssembleResult['stats']} stats
 * @param {Rewrites} rewrites
 * @returns {AssembleResult}
 */
function build(ir, options, diagnostics, stats, rewrites){
    const { profile } = ir;
    const fourth = profile.minor >= 4;
    let counter = ir.vregCount;
    /** @param {number} width @returns {VReg} */
    const newReg = width=>({ id: counter++, width });

    let instrs = prune(ir.instrs.map(i=>({ ...i, srcs: i.srcs.slice() })));
    if (rewrites.numbered)
    {
        instrs = prune(numberValues(instrs, profile));
    }
    instrs = fuseMultiplyAdd(instrs, profile);
    instrs = foldScales(instrs, profile);
    instrs = foldModifiers(instrs);
    instrs = propagateModifiers(prune(instrs));
    instrs = coalesceMoves(instrs);
    if (!rewrites.keepMoves)
    {
        // Before 1.4 a part of the result is written as rgb, alpha or all of it.
        instrs = forwardOutputs(instrs, mask=>fourth || mask === 7 || mask === 8 || mask === 15);
    }
    else
    {
        // Every write of the result goes to a temporary, moved into r0 at the end.
        /** @type {Map<import('./hlsl-ir.js').Output, { reg: VReg, mask: number }>} */
        const held = new Map();
        instrs = instrs.map(instr=>{
            if (instr.dest.kind !== 'out')
            {
                return instr;
            }
            const one = held.get(instr.dest.out) ?? { reg: newReg(4), mask: 0 };
            one.mask |= instr.dest.mask;
            held.set(instr.dest.out, one);
            return { ...instr, dest: { kind: 'reg', reg: one.reg, mask: instr.dest.mask } };
        });
        for (const [out, { reg, mask }] of held)
        {
            instrs.push({ op: 'mov', dest: { kind: 'out', out, mask },
                srcs: [{ kind: 'reg', reg, swz: [0, 1, 2, 3] }] });
        }
    }

    // An input nothing reads is not declared, and not judged: a pixel shader that
    // takes the vertex shader's output structure carries its POSITION, which no
    // model 1 shader can read and fxc accepts as long as it is not read.
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

    // The inputs the model has: the two colours, and the texture coordinate sets.
    for (const input of ir.inputs)
    {
        const colour = input.usage === USAGE.COLOR && input.index < 2;
        const texture = input.usage === USAGE.TEXCOORD && input.index < (fourth ? 6 : 4);
        if (!colour && !texture)
        {
            throw new TargetError('X4502', `invalid ${profile.name} input semantic '${
                USAGE_NAMES[input.usage] ?? input.usage}${input.index}'`);
        }
    }

    // A coordinate set read as a number is `texcoord`, which fills the texture register of
    // its number with the set clamped to [0, 1]; in 1.4 it is `texcrd`, which copies the set
    // into a temporary, because a texture register is not an operand of arithmetic there.
    {
        const asTexture = new Set();
        for (const instr of instrs)
        {
            if (instr.op === 'tex' && instr.srcs[0].kind === 'input')
            {
                asTexture.add(instr.srcs[0].input);
            }
        }
        /** @type {Map<import('./hlsl-ir.js').Input, VReg>} */
        const filled = new Map();
        /** @type {Instr[]} */
        const prefix = [];
        instrs = instrs.map(instr=>{
            if (instr.op === 'tex' || instr.op === 'texld')
            {
                return instr;
            }
            return { ...instr, srcs: instr.srcs.map(src=>{
                if (!isTexcoord(src))
                {
                    return src;
                }
                const input = /** @type {import('./hlsl-ir.js').SrcInput} */ (src).input;
                if (!fourth && asTexture.has(input))
                {
                    throw new TargetError('X4520', `${profile.name}: TEXCOORD${input.index} is `
                        + 'both a texture\'s coordinates and a number');
                }
                let reg = filled.get(input);
                if (!reg)
                {
                    reg = newReg(4);
                    if (!fourth)
                    {
                        reg.pin = { file: 't', index: input.index };
                    }
                    filled.set(input, reg);
                    prefix.push({ op: fourth ? 'texcrd' : 'texcoord',
                        dest: { kind: 'reg', reg, mask: 15 },
                        srcs: [{ kind: 'input', input, swz: [0, 1, 2, 3] }] });
                }
                return /** @type {Src} */ ({ kind: 'reg', reg, swz: /** @type {any} */ (src).swz,
                    ...((/** @type {any} */ (src)).neg ? { neg: true } : {}) });
            }) };
        });
        instrs = [...prefix, ...instrs];
    }

    // What the last build could not read, read another way: after the passes, which make
    // the registers a texture read fills, so the program is the one that build placed.
    instrs = applyRewrites(instrs, rewrites);

    // The order of the program: the texture reads that need only inputs first; in 1.4,
    // those that need a result of the arithmetic after a phase marker.
    /** @type {Set<VReg>} */
    const late = new Set();
    /** @type {Instr[]} */
    const first = [];
    /** @type {Instr[]} */
    const second = [];
    for (const instr of instrs)
    {
        const dependent = instr.srcs.some(s=>s.kind === 'reg' && late.has(s.reg));
        const needsArithmetic = instr.op === 'texld' && instr.srcs[0].kind === 'reg';
        if (dependent || needsArithmetic)
        {
            if (!fourth)
            {
                throw new TargetError('X4523', `${profile.name} cannot read a texture at `
                    + 'coordinates it computed');
            }
            if (instr.dest.kind === 'reg')
            {
                late.add(instr.dest.reg);
            }
            second.push(instr);
        }
        else
        {
            first.push(instr);
        }
    }
    const isTextureOp = (/** @type {Instr} */ i)=>i.op === 'tex' || i.op === 'texcoord'
        || i.op === 'texld' || i.op === 'texcrd';
    // Eight arithmetic instructions a phase: in 1.4 a program longer than that runs its
    // tail in phase two, as fxc does, keeping in phase one what the reads of phase two
    // need; the texture reads only phase two uses are made there too.
    if (fourth && first.filter(i=>!isTextureOp(i)).length > profile.maxArith)
    {
        /** @type {Set<Instr>} */
        const needed = new Set();
        /** @type {Set<VReg>} */
        const wanted = new Set();
        for (const instr of second)
        {
            if (isTextureOp(instr))
            {
                instr.srcs.forEach(src=>src.kind === 'reg' && wanted.add(src.reg));
            }
        }
        for (let i = first.length - 1; i >= 0; i--)
        {
            const instr = first[i];
            if (instr.dest.kind === 'reg' && wanted.has(instr.dest.reg))
            {
                needed.add(instr);
                instr.srcs.forEach(src=>src.kind === 'reg' && wanted.add(src.reg));
            }
        }
        let count = first.filter(i=>!isTextureOp(i)).length;
        /** @type {Instr[]} */
        const moved = [];
        for (let i = first.length - 1; i >= 0 && count > profile.maxArith; i--)
        {
            const instr = first[i];
            if (isTextureOp(instr) || needed.has(instr))
            {
                continue;
            }
            moved.unshift(instr);
            first.splice(i, 1);
            count--;
        }
        /** @type {Set<VReg>} */
        const readFirst = new Set();
        first.forEach(instr=>instr.srcs.forEach(src=>src.kind === 'reg' && readFirst.add(src.reg)));
        const stay = first.filter(i=>!isTextureOp(i) || (i.dest.kind === 'reg'
            && readFirst.has(i.dest.reg)));
        const later = first.filter(i=>!stay.includes(i));
        first.splice(0, first.length, ...stay);
        second.unshift(...later, ...moved);
    }
    /** @param {Instr[]} list */
    const textureFirst = list=>[...list.filter(isTextureOp), ...list.filter(i=>!isTextureOp(i))];
    /** @type {Instr[]} */
    let ordered;
    const phased = second.length > 0;
    if (phased)
    {
        // A phase-two read comes after the arithmetic that feeds it but before what reads it;
        // the arithmetic of phase one that does not depend on it stays in phase one.
        ordered = [...textureFirst(first), { op: 'phase', dest: { kind: 'none' }, srcs: [] },
            ...textureFirst(second)];
    }
    else
    {
        ordered = textureFirst(first);
    }

    // Constants and literals.
    const reserved = assignConstants(ir.constants, diagnostics);
    for (const cst of ir.constants)
    {
        if (cst.set === 's' && cst.explicit !== undefined)
        {
            cst.index = cst.explicit;
        }
    }
    /** @type {{ index: number, values: number[] }[]} */
    const defs = [];
    /** @type {Map<string, number>} */
    const defAt = new Map();
    let nextConstant = 0;
    let clamped = false;
    ordered = ordered.map(instr=>({ ...instr, srcs: instr.srcs.map((src, k)=>{
        if (src.kind !== 'imm')
        {
            return src;
        }
        // A literal of which one lane is read is that one value, held in every component
        // and read through alpha -- as fxc places it -- since before 1.4 no other single
        // component can be read replicated.
        const lanes = lanesRead(instr, k);
        if (lanes.length === 1 && src.values.length > 1)
        {
            src = { ...src, values: [src.values[Math.min(lanes[0], src.values.length - 1)]] };
        }
        // A model 1 constant register holds -1 to 1 and the hardware clamps to
        // it; fxc clamps a literal outside it and says so once, as a warning.
        if (src.values.some(v=>!(v >= -1 && v <= 1)))
        {
            if (!clamped)
            {
                clamped = true;
                diagnostics.push({ code: 'X4704', severity: 'warning', message: 'literal values '
                    + 'outside range -1 to 1 are clamped on all ps_1_x shading models' });
            }
            src = { ...src, values: src.values.map(v=>Math.max(-1, Math.min(1, v))) };
        }
        const key = src.values.map(v=>(Object.is(v, -0) ? '-0' : String(Math.fround(v)))).join();
        let index = defAt.get(key);
        if (index === undefined)
        {
            while (reserved.has(nextConstant))
            {
                nextConstant++;
            }
            index = nextConstant++;
            defAt.set(key, index);
            const values = src.values.length === 1 ? [0, 0, 0, 0].map(()=>src.values[0])
                : [0, 1, 2, 3].map(i=>src.values[Math.min(i, src.values.length - 1)]);
            defs.push({ index, values });
            reserved.add(index);
        }
        return /** @type {Src} */ ({ kind: 'creg', file: 'f', index,
            swz: src.values.length === 1 ? [3] : src.values.map((_, i)=>i),
            ...(src.neg ? { neg: true } : {}) });
    }) }));
    const constantRegisters = reserved.size > 0 ? Math.max(...reserved) + 1 : 0;
    if (constantRegisters > profile.maxConsts)
    {
        diagnostics.push({ code: 'X4507', severity: 'warning',
            message: `Constant register limit of ${profile.maxConsts} `
            + `exceeded; ${constantRegisters} registers needed to compile program` });
    }

    // Homes.
    /** @type {Map<VReg, { start: number, end: number }>} */
    const ranges = new Map();
    ordered.forEach((instr, i)=>{
        for (const src of instr.srcs)
        {
            if (src.kind === 'reg')
            {
                const range = ranges.get(src.reg);
                if (!range)
                {
                    throw new Error(`internal: v${src.reg.id} read before it is written`);
                }
                range.end = Math.max(range.end, i);
            }
        }
        if (instr.dest.kind === 'reg')
        {
            const range = ranges.get(instr.dest.reg);
            if (range)
            {
                range.end = Math.max(range.end, i);
            }
            else
            {
                ranges.set(instr.dest.reg, { start: i, end: i });
            }
        }
    });
    /** @type {Map<string, [number, number][]>} */
    const taken = new Map();
    /** @param {string} slot @param {number} start @param {number} end */
    const free = (slot, start, end)=>!(taken.get(slot) ?? []).some(([a, b])=>
        !(b <= start || end <= a));
    /** @param {string} slot @param {number} start @param {number} end */
    const take = (slot, start, end)=>{
        taken.set(slot, [...(taken.get(slot) ?? []), [start, end]]);
    };
    // r0 belongs to the result from the first instruction that writes it.
    let firstOut = Infinity;
    ordered.forEach((instr, i)=>{
        if (instr.dest.kind === 'out')
        {
            firstOut = Math.min(firstOut, i);
        }
    });
    for (let c = 0; c < 4; c++)
    {
        take(`r0.${c}`, firstOut, Infinity);
    }
    /** @type {Map<VReg, Home>} */
    const homes = new Map();
    const placement = (/** @type {VReg} */ v)=>(v.width === 1 ? [3] : v.width <= 3 ? [0, 1, 2]
        : [0, 1, 2, 3]);
    const entries = [...ranges.entries()];
    for (const [v, range] of entries.filter(([one])=>one.pin))
    {
        const pin = /** @type {NonNullable<VReg['pin']>} */ (v.pin);
        const reg = pin.index ?? /** @type {number} */ (pin.sampler?.index);
        if (pin.comp !== undefined)
        {
            if (pin.file === 'r' && reg === 0 && range.end > firstOut)
            {
                throw new RewriteNeeded([], [], new TargetError('X4505', `${profile.name}: `
                    + 'a test in r0.a is read after the result is written there'), true);
            }
            take(`${pin.file}${reg}.${pin.comp}`, range.start, range.end);
            homes.set(v, { file: pin.file, reg, comps: [pin.comp] });
            continue;
        }
        for (let c = 0; c < 4; c++)
        {
            // A texel 1.4 leaves in r0 still read after the result is written there: the
            // result waits, moved into r0 at the end.
            if (pin.file === 'r' && reg === 0 && range.end > firstOut)
            {
                throw new RewriteNeeded([], [], new TargetError('X4505', `${profile.name}: `
                    + `the texel in ${pin.file}${reg} is read after the result is written there`),
                true);
            }
            take(`${pin.file}${reg}.${c}`, range.start, range.end);
        }
        homes.set(v, { file: pin.file, reg, comps: [0, 1, 2, 3].slice(0, v.width) });
    }
    let temps = 0;
    const unpinned = entries.filter(([one])=>!one.pin);
    for (const [v, range] of unpinned.sort((a, b)=>a[1].start - b[1].start))
    {
        const comps = placement(v);
        let reg = 0;
        while (!comps.every(c=>free(`r${reg}.${c}`, range.start, range.end)))
        {
            reg++;
        }
        if (reg >= profile.maxTemps && !fourth)
        {
            // Before 1.4 a texture register is a temporary once its stage has run, and
            // fxc keeps a value there when the two r# are taken (mov_sat t0.w, v0.w).
            const spare = [0, 1, 2, 3].find(t=>comps.every(c=>
                free(`t${t}.${c}`, range.start, range.end)));
            if (spare !== undefined)
            {
                for (const c of comps)
                {
                    take(`t${spare}.${c}`, range.start, range.end);
                }
                homes.set(v, { file: 't', reg: spare, comps });
                continue;
            }
        }
        for (const c of comps)
        {
            take(`r${reg}.${c}`, range.start, range.end);
        }
        homes.set(v, { file: 'r', reg, comps });
        temps = Math.max(temps, reg + 1);
    }
    stats.temps = temps;
    if (temps > profile.maxTemps)
    {
        diagnostics.push({ code: 'X4505', severity: 'warning',
            message: `Temporary register limit of ${profile.maxTemps} `
            + `exceeded; ${temps} registers needed to compile program` });
    }

    // Registers of the inputs.
    for (const input of ir.inputs)
    {
        input.reg = input.index;
        input.file = input.usage === USAGE.COLOR ? 'v' : 't';
    }
    for (const out of ir.outputs)
    {
        if (out.usage !== USAGE.COLOR || out.index !== 0)
        {
            throw new TargetError('X4503', `invalid ${profile.name} output semantic '${
                USAGE_NAMES[out.usage] ?? out.usage}${out.index}': the colour is the only result`);
        }
        out.reg = 0;
    }

    const allowedMask = (/** @type {number} */ m)=>fourth || m === 7 || m === 8 || m === 15;
    /** @param {number} mask The result's components, as physical ones. */
    const widen = mask=>(!fourth && mask !== 8 && mask !== 15 && (mask & 8) === 0 ? 7 : mask);

    /** @type {PhysInstr[]} */
    const physical = [];
    /** @type {string[]} */
    const spread = [];
    /** @type {string[]} */
    const split = [];
    /** @type {TargetError | null} */
    let unreadable = null;
    for (const instr of ordered)
    {
        if (instr.op === 'phase')
        {
            physical.push({ op: 'phase', dest: null, srcs: [] });
            continue;
        }
        /** @type {PhysOperand | null} */
        let dest = null;
        /** @type {number[]} */
        let place = [0, 1, 2, 3];
        if (instr.dest.kind === 'reg')
        {
            const home = /** @type {Home} */ (homes.get(instr.dest.reg));
            place = home.comps;
            let mask = 0;
            for (let c = 0; c < 4; c++)
            {
                if ((instr.dest.mask & 1 << c) !== 0)
                {
                    mask |= 1 << home.comps[c];
                }
            }
            if (instr.dest.reg.width <= 3)
            {
                mask = widen(mask);
            }
            dest = { type: home.file === 't' ? REG.TEXTURE : REG.TEMP, index: home.reg, mask };
        }
        else if (instr.dest.kind === 'out')
        {
            instr.dest.out.written = (instr.dest.out.written ?? 0) | instr.dest.mask;
            dest = { type: REG.TEMP, index: 0, mask: widen(instr.dest.mask) };
        }
        if (dest && !allowedMask(dest.mask ?? 15) && !isTextureOp(instr))
        {
            if (instr.dest.kind === 'reg' && !rewrites.merge.has(splitKey(instr)))
            {
                throw new RewriteNeeded([], [], new TargetError('X4537', `${profile.name} `
                    + 'cannot write these components of a result alone'), false,
                [splitKey(instr)]);
            }
            throw new TargetError('X4537', `${profile.name} cannot write only the components `
                + `${'rgba'.split('').filter((_, c)=>((dest?.mask ?? 0) & 1 << c) !== 0).join('')}`
                + ' of a result');
        }
        if (dest && instr.sat)
        {
            dest.sat = true;
        }
        if (dest && instr.shift !== undefined)
        {
            dest.shift = instr.shift;
        }
        if (isTextureOp(instr) && dest)
        {
            // texcrd copies the three coordinates a set has; the others fill all four.
            dest.mask = instr.op === 'texcrd' ? 7 : 15;
        }
        const info = /** @type {Record<string, { cls: string }>} */ (OPCODES)[instr.op];
        if (!info)
        {
            throw new Error(`internal: no opcode '${instr.op}'`);
        }
        const destLanes = [0, 1, 2, 3].filter(c=>(((instr.dest.kind === 'reg'
            || instr.dest.kind === 'out') ? instr.dest.mask : 0) & 1 << c) !== 0);
        /** @type {PhysOperand[]} */
        const srcs = [];
        instr.srcs.forEach((src, k)=>{
            if (src.kind === 'sampler' || instr.op === 'tex' || instr.op === 'texcoord')
            {
                return;
            }
            /** @type {PhysOperand} */
            let operand;
            switch (src.kind)
            {
                case 'reg': {
                    const home = /** @type {Home} */ (homes.get(src.reg));
                    operand = { type: home.file === 't' ? REG.TEXTURE : REG.TEMP,
                        index: home.reg };
                    break;
                }
                case 'creg':
                    operand = { type: REG.CONST, index: src.index };
                    break;
                case 'const':
                    operand = { type: REG.CONST, index: (src.cst.index ?? 0) + src.offset };
                    break;
                case 'input':
                    operand = src.input.usage === USAGE.COLOR
                        ? { type: REG.INPUT, index: src.input.index }
                        : { type: REG.TEXTURE, index: src.input.index };
                    if (src.input.usage === USAGE.COLOR)
                    {
                        src.input.used = (src.input.used ?? 0) | 15;
                    }
                    break;
                default:
                    throw new TargetError('X4532', `${profile.name} has no such source`);
            }
            if (/** @type {any} */ (src).abs)
            {
                throw new TargetError('X4532', `${profile.name} has no absolute value`);
            }
            // The component each lane the instruction reads is in.
            const lanes = info.cls === 'comp' ? destLanes : lanesRead(instr, k);
            const wanted = (info.cls === 'comp' ? lanes : Array.from({
                length: instr.op === 'dp4' ? 4 : lanes.length }, (_, i)=>i))
                .map(l=>component(src, l, homes));
            try
            {
                // Not the instruction that makes it so: that one reads its blue.
                const uniform = src.kind === 'reg' && src.reg.uniform
                    && !(instr.dest.kind === 'reg' && instr.dest.reg === src.reg);
                // cnd tests r0.a, named as such however many components it writes.
                const test = instr.op === 'cnd' && k === 0 && !fourth
                    && wanted.every(w=>w === 3);
                operand.swz = uniform ? [0, 1, 2, 3] : test ? [3, 3, 3, 3]
                    : swizzleOf(wanted, info.cls === 'comp'
                        ? destLanes.map(c=>place[c]) : null, profile, instr.op, dest?.mask === 8);
            }
            catch (e){
                if (!(e instanceof TargetError) || e.code !== 'X4533')
                {
                    throw e;
                }
                // Read another way, the next build: through a dot product before
                // 1.4, one component at a time in it.
                const key = spreadKey(src);
                if (!fourth && key !== null && wanted.every(w=>w === wanted[0]))
                {
                    spread.push(key);
                }
                else if (fourth && info.cls === 'comp')
                {
                    split.push(splitKey(instr));
                }
                unreadable ??= e;
                operand.swz = [0, 1, 2, 3];
            }
            const modifier = /** @type {any} */ (src).mod;
            operand.mod = modifier ? MODIFIER[/** @type {keyof typeof MODIFIER} */ (modifier)]
                : /** @type {any} */ (src).neg ? MOD.NEG : MOD.NONE;
            srcs.push(operand);
        });
        const op = instr.op === 'texld' && !fourth ? 'tex' : instr.op;
        physical.push({ op, dest, srcs });
    }

    if (unreadable)
    {
        throw new RewriteNeeded(spread, split, unreadable);
    }

    // A register moved into itself -- a result the allocator already left where the
    // colour is read from -- is no instruction.
    for (let i = physical.length - 1; i >= 0; i--)
    {
        const one = physical[i];
        const from = one.srcs[0];
        if (one.op === 'mov' && one.dest && !one.dest.sat && !one.dest.shift && from
            && from.type === one.dest.type && from.index === one.dest.index
            && (from.mod ?? MOD.NONE) === MOD.NONE
            && [0, 1, 2, 3].every(c=>((one.dest?.mask ?? 15) & 1 << c) === 0
                || (from.swz ?? [0, 1, 2, 3])[c] === c))
        {
            physical.splice(i, 1);
        }
    }

    // Instructions paired: an rgb instruction and an alpha one that does not read what the
    // first wrote.
    for (let i = 1; i < physical.length; i++)
    {
        const a = physical[i - 1];
        const b = physical[i];
        if (a.dest && b.dest && a.dest.mask === 7 && b.dest.mask === 8 && !a.coissue
            && (OPCODES[/** @type {keyof typeof OPCODES} */ (a.op)]?.cls === 'comp')
            && (OPCODES[/** @type {keyof typeof OPCODES} */ (b.op)]?.cls === 'comp')
            && !b.srcs.some(s=>s.type === a.dest?.type && s.index === a.dest?.index))
        {
            b.coissue = true;
        }
    }

    // Counts.
    let phase = 0;
    const perPhase = [{ arith: 0, tex: 0 }, { arith: 0, tex: 0 }];
    for (const one of physical)
    {
        if (one.op === 'phase')
        {
            phase = 1;
        }
        else if (one.op === 'tex' || one.op === 'texcoord' || one.op === 'texld'
            || one.op === 'texcrd')
        {
            perPhase[phase].tex++;
        }
        else if (!one.coissue)
        {
            perPhase[phase].arith++;
        }
    }
    stats.arith = perPhase[0].arith + perPhase[1].arith;
    stats.texture = perPhase[0].tex + perPhase[1].tex;
    stats.slots = stats.arith;
    stats.defs = defs.length;
    for (const counts of perPhase)
    {
        if (counts.arith > profile.maxArith)
        {
            diagnostics.push({ code: 'X5608', severity: 'warning',
                message: 'Compiled shader code uses too many '
                + `arithmetic instruction slots (${counts.arith}). Max. allowed by the target `
                + `(${profile.name}) is ${profile.maxArith}.` });
        }
        if (counts.tex > profile.maxTex)
        {
            diagnostics.push({ code: 'X5609', severity: 'warning',
                message: 'Compiled shader code uses too many '
                + `texture instruction slots (${counts.tex}). Max. allowed by the target `
                + `(${profile.name}) is ${profile.maxTex}.` });
        }
    }
    if (diagnostics.some(d=>d.severity !== 'warning'))
    {
        return { tokens: null, diagnostics, stats };
    }
    const comment = constantTableComment({ constants: ir.constants,
        creator: options.creator ?? 'Bottlify HLSL compiler', target: profile.name,
        version: ((0xffff0000) | profile.major << 8 | profile.tokenMinor) >>> 0,
        flags: options.flags ?? 0 });
    const tokens = encodeProgram({ profile, decls: [], defs, instrs: physical, comment });
    return { tokens, diagnostics, stats };
}

/**
 * The swizzle that reads `wanted` components into a destination, or an error. A
 * source is read as it is in the components written, or with one component
 * replicated: in 1.4 any, before it alpha, and blue only by an instruction that
 * writes alpha alone (the Direct3D 9 table of source swizzles).
 *
 * @param {number[]} wanted   For each destination component the source one.
 * @param {number[] | null} destLanes   The components the destination takes, as physical ones.
 * @param {Profile} profile @param {string} op
 * @param {boolean} alphaAlone  The instruction writes alpha and nothing else.
 * @returns {number[]}
 */
function swizzleOf(wanted, destLanes, profile, op, alphaAlone){
    const into = destLanes ?? wanted.map((_, i)=>i);
    if (wanted.every((w, i)=>w === into[i]))
    {
        return [0, 1, 2, 3];
    }
    const c = wanted[0];
    if (wanted.every(w=>w === c) && (profile.minor >= 4 || c === 3 || (c === 2 && alphaAlone)))
    {
        return [c, c, c, c];
    }
    throw new TargetError('X4533', `${profile.name} ${op}: a source is read as it is or with `
        + `one component replicated${profile.minor >= 4 ? ''
            : ' -- alpha, or blue into alpha alone'}; this one is read as `
        + `.${wanted.map(w=>'rgba'[w]).join('')}`);
}
