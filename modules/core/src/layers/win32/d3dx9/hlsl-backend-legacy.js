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
    assignConstants, forwardOutputs, fuseMultiplyAdd, lanesRead, prune, usage, USAGE_NAMES,
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
const MODIFIER = { comp: MOD.COMP, bias: MOD.BIAS, bx2: MOD.SIGN, x2: MOD.X2 };

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
            if (use.neg || use.abs || reader.op === 'texkill' || (reader.dest.kind === 'reg'
                && reader.dest.reg === reg))
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
    /** @type {import('./hlsl-backend.js').Diagnostic[]} */
    const diagnostics = [];
    const stats = { arith: 0, texture: 0, slots: 0, temps: 0, constants: 0, defs: 0 };
    try
    {
        return build(ir, options, diagnostics, stats);
    }
    catch (e){
        if (!(e instanceof TargetError))
        {
            throw e;
        }
        diagnostics.push({ code: e.code, message: e.message });
        return { tokens: null, diagnostics, stats };
    }
}

/**
 * @param {IrProgram} ir @param {{ creator?: string, flags?: number }} options
 * @param {import('./hlsl-backend.js').Diagnostic[]} diagnostics
 * @param {AssembleResult['stats']} stats
 * @returns {AssembleResult}
 */
function build(ir, options, diagnostics, stats){
    const { profile } = ir;
    const fourth = profile.minor >= 4;
    let counter = ir.vregCount;
    /** @param {number} width @returns {VReg} */
    const newReg = width=>({ id: counter++, width });

    let instrs = prune(ir.instrs.map(i=>({ ...i, srcs: i.srcs.slice() })));
    instrs = fuseMultiplyAdd(instrs, profile);
    instrs = foldScales(instrs, profile);
    instrs = foldModifiers(instrs);
    instrs = propagateModifiers(prune(instrs));
    instrs = forwardOutputs(instrs);

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
                    throw new TargetError('X4532', `${profile.name}: TEXCOORD${input.index} is `
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
                throw new TargetError('X4532', `${profile.name} cannot read a texture at `
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
    ordered = ordered.map(instr=>({ ...instr, srcs: instr.srcs.map(src=>{
        if (src.kind !== 'imm')
        {
            return src;
        }
        for (const v of src.values)
        {
            if (!(v >= -1 && v <= 1))
            {
                throw new TargetError('X4533', `the constant ${v} is outside the range -1 to 1 `
                    + `that ${profile.name} holds`);
            }
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
        diagnostics.push({ code: 'X5629', message: 'Compiled shader code uses too many constant '
            + `registers (${constantRegisters}). Max. allowed by the target (${profile.name}) is `
            + `${profile.maxConsts}.` });
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
        for (let c = 0; c < 4; c++)
        {
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
        diagnostics.push({ code: 'X5610', message: 'Compiled shader code uses too many temporary '
            + `registers (${temps}). Max. allowed by the target (${profile.name}) is `
            + `${profile.maxTemps}.` });
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
            throw new TargetError('X4502', `invalid ${profile.name} output semantic '${
                USAGE_NAMES[out.usage] ?? out.usage}${out.index}': the colour is the only result`);
        }
        out.reg = 0;
    }

    const allowedMask = (/** @type {number} */ m)=>fourth || m === 7 || m === 8 || m === 15;
    /** @param {number} mask The result's components, as physical ones. */
    const widen = mask=>(!fourth && mask !== 8 && mask !== 15 && (mask & 8) === 0 ? 7 : mask);

    /** @type {PhysInstr[]} */
    const physical = [];
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
            throw new TargetError('X4534', `${profile.name} cannot write only the components `
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
                    throw new TargetError('X4531', `${profile.name} has no such source`);
            }
            if (/** @type {any} */ (src).abs)
            {
                throw new TargetError('X4531', `${profile.name} has no absolute value`);
            }
            // The component each lane the instruction reads is in.
            const lanes = info.cls === 'comp' ? destLanes : lanesRead(instr, k);
            const wanted = (info.cls === 'comp' ? lanes : Array.from({
                length: instr.op === 'dp4' ? 4 : lanes.length }, (_, i)=>i))
                .map(l=>component(src, l, homes));
            operand.swz = swizzleOf(wanted, info.cls === 'comp'
                ? destLanes.map(c=>place[c]) : null, profile, instr.op);
            const modifier = /** @type {any} */ (src).mod;
            operand.mod = modifier ? MODIFIER[/** @type {keyof typeof MODIFIER} */ (modifier)]
                : /** @type {any} */ (src).neg ? MOD.NEG : MOD.NONE;
            srcs.push(operand);
        });
        const op = instr.op === 'texld' && !fourth ? 'tex' : instr.op;
        physical.push({ op, dest, srcs });
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
            diagnostics.push({ code: 'X5608', message: 'Compiled shader code uses too many '
                + `arithmetic instruction slots (${counts.arith}). Max. allowed by the target `
                + `(${profile.name}) is ${profile.maxArith}.` });
        }
        if (counts.tex > profile.maxTex)
        {
            diagnostics.push({ code: 'X5609', message: 'Compiled shader code uses too many '
                + `texture instruction slots (${counts.tex}). Max. allowed by the target `
                + `(${profile.name}) is ${profile.maxTex}.` });
        }
    }
    if (diagnostics.length > 0)
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
 * The swizzle that reads `wanted` components into a destination, or an error: the
 * model reads a register as it is, or replicates its blue or alpha.
 *
 * @param {number[]} wanted   For each destination component the source one.
 * @param {number[] | null} destLanes   The components the destination takes, as physical ones.
 * @param {Profile} profile @param {string} op
 * @returns {number[]}
 */
function swizzleOf(wanted, destLanes, profile, op){
    const same = wanted.every(w=>w === wanted[0]);
    const into = destLanes ?? wanted.map((_, i)=>i);
    if (profile.minor >= 4)
    {
        // 1.4 reads any rearrangement of the colour components the destination takes.
        const full = [0, 1, 2, 3];
        into.forEach((d, i)=>{
            full[d] = wanted[i];
        });
        return full;
    }
    if (wanted.every((w, i)=>w === into[i]))
    {
        return [0, 1, 2, 3];
    }
    if (same && (wanted[0] === 3 || wanted[0] === 2))
    {
        return [wanted[0], wanted[0], wanted[0], wanted[0]];
    }
    throw new TargetError('X4535', `${profile.name} ${op}: a source can be read as it is or `
        + 'with its blue or alpha replicated; this one is read as '
        + `.${wanted.map(w=>'rgba'[w]).join('')}`);
}
