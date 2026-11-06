/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The back half of the Shader Model 4 and 5 compiler: registers for the virtual ones, slots
 * for the buffers, textures and samplers, the token stream with its declarations, and the
 * container around it.
 *
 * Each virtual register gets a temporary of its own from the instruction that first writes it
 * to the last that reads it; one that lives into a loop lives to the loop's end, since the
 * next iteration reads it again. Temporaries are reused as soon as they are free, whole: a
 * value of one lane takes a register of four. The program reads its operands before it writes
 * its result, so a register freed by an instruction's last read may be its result.
 *
 * The signatures give each element a register of its own in the order the program met them,
 * a pixel shader's targets the register of their index; Direct3D links the stages by name.
 */

import { OPCODE, OPERAND, SELECTION } from '../d3d10/sm4.js';
import { laneBits } from './sm4-build.js';
import { writeContainer, writeResourceDefinitions, writeSignature } from './dxbc-write.js';

/** @typedef {import('./sm4-ir.js').Program4} Program4 */
/** @typedef {import('./sm4-ir.js').Instr} Instr */
/** @typedef {import('./sm4-ir.js').Src} Src */
/** @typedef {import('./sm4-ir.js').Dest} Dest */
/** @typedef {import('./sm4-ir.js').VReg} VReg */

/** The opcodes of model 5 that this compiler writes, by the numbers that model gives them. */
const OPCODE5 = Object.freeze({ F32TOF16: 130, F16TOF32: 131, COUNTBITS: 134, FIRSTBIT_HI: 135,
    FIRSTBIT_LO: 136, FIRSTBIT_SHI: 137, BFREV: 141 });

/** Opcode numbers by the spelling the build uses. */
const OPCODES = /** @type {Record<string, number>} */ ({
    add: OPCODE.ADD, and: OPCODE.AND, break: OPCODE.BREAK, breakc_nz: OPCODE.BREAKC,
    deriv_rtx: OPCODE.DERIV_RTX, deriv_rty: OPCODE.DERIV_RTY, discard_nz: OPCODE.DISCARD,
    div: OPCODE.DIV, dp2: OPCODE.DP2, dp3: OPCODE.DP3, dp4: OPCODE.DP4, else: OPCODE.ELSE,
    endif: OPCODE.ENDIF, endloop: OPCODE.ENDLOOP, eq: OPCODE.EQ, exp: OPCODE.EXP,
    frc: OPCODE.FRC, ftoi: OPCODE.FTOI, ftou: OPCODE.FTOU, ge: OPCODE.GE, iadd: OPCODE.IADD,
    if_nz: OPCODE.IF, ieq: OPCODE.IEQ, ige: OPCODE.IGE, ilt: OPCODE.ILT, imad: OPCODE.IMAD,
    imax: OPCODE.IMAX, imin: OPCODE.IMIN, imul: OPCODE.IMUL, ine: OPCODE.INE, ineg: OPCODE.INEG,
    ishl: OPCODE.ISHL, ishr: OPCODE.ISHR, itof: OPCODE.ITOF, ld: OPCODE.LD, ld_ms: OPCODE.LD_MS,
    log: OPCODE.LOG, loop: OPCODE.LOOP, lt: OPCODE.LT, mad: OPCODE.MAD, min: OPCODE.MIN,
    max: OPCODE.MAX, mov: OPCODE.MOV, movc: OPCODE.MOVC, mul: OPCODE.MUL, ne: OPCODE.NE,
    not: OPCODE.NOT, or: OPCODE.OR, resinfo: OPCODE.RESINFO, ret: OPCODE.RET,
    round_ne: OPCODE.ROUND_NE, round_ni: OPCODE.ROUND_NI, round_pi: OPCODE.ROUND_PI,
    round_z: OPCODE.ROUND_Z, rsq: OPCODE.RSQ, sample: OPCODE.SAMPLE, sample_c: OPCODE.SAMPLE_C,
    sample_c_lz: OPCODE.SAMPLE_C_LZ, sample_l: OPCODE.SAMPLE_L, sample_d: OPCODE.SAMPLE_D,
    sample_b: OPCODE.SAMPLE_B, sqrt: OPCODE.SQRT, sincos: OPCODE.SINCOS, udiv: OPCODE.UDIV,
    ult: OPCODE.ULT, uge: OPCODE.UGE, umul: OPCODE.UMUL, umad: OPCODE.UMAD, umax: OPCODE.UMAX,
    umin: OPCODE.UMIN, ushr: OPCODE.USHR, utof: OPCODE.UTOF, xor: OPCODE.XOR,
    gather4: OPCODE.GATHER4, f32tof16: OPCODE5.F32TOF16, f16tof32: OPCODE5.F16TOF32,
    countbits: OPCODE5.COUNTBITS, firstbit_hi: OPCODE5.FIRSTBIT_HI,
    firstbit_lo: OPCODE5.FIRSTBIT_LO, firstbit_shi: OPCODE5.FIRSTBIT_SHI, bfrev: OPCODE5.BFREV,
});

/** What a statistic counts each opcode as. */
const FLOAT_OPS = new Set(['add', 'mul', 'mad', 'div', 'dp2', 'dp3', 'dp4', 'min', 'max', 'frc',
    'exp', 'log', 'rsq', 'sqrt', 'sincos', 'lt', 'ge', 'eq', 'ne', 'round_ne', 'round_ni',
    'round_pi', 'round_z', 'deriv_rtx', 'deriv_rty']);
const INT_OPS = new Set(['iadd', 'imul', 'imad', 'imin', 'imax', 'ineg', 'ishl', 'ishr', 'ieq',
    'ine', 'ilt', 'ige', 'and', 'or', 'xor', 'not']);
const UINT_OPS = new Set(['udiv', 'ult', 'uge', 'umul', 'umad', 'umin', 'umax', 'ushr']);
const CONVERSIONS = new Set(['ftoi', 'ftou', 'itof', 'utof', 'f32tof16', 'f16tof32']);

/** D3D10_SB_RESOURCE_DIMENSION, and the SRV dimension reflection reports, by the checker's. */
const DIMENSIONS = /** @type {Record<string, [number, number]>} */ ({
    buffer: [1, 1], '1d': [2, 2], '2d': [3, 4], '2dms': [4, 6], '3d': [5, 8], cube: [6, 9],
    '1darray': [7, 3], '2darray': [8, 5], '2dmsarray': [9, 7], cubearray: [10, 10],
});

/** The interpolation modes of dcl_input_ps. */
const INTERPOLATION = { constant: 1, linear: 2, noperspective: 4 };

/** The shader kind of a version token, and the program type RDEF names. */
const KINDS = /** @type {Record<string, [number, number]>} */ ({ ps: [0, 0xffff],
    vs: [1, 0xfffe], gs: [2, 0x4753], cs: [5, 0x4353] });

/** Who wrote the program, as RDEF says. */
export const CREATOR = 'Bottlify HLSL Shader Compiler';

/** A failure to fit the target: too many registers, slots past the end. */
export class BackendError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message){
        super(message);
        this.name = 'BackendError';
        this.code = code;
    }
}

/**
 * Lifetimes of the virtual registers, as instruction indices, stretched over loops.
 *
 * @param {Instr[]} instrs
 * @returns {Map<VReg, { first: number, last: number }>}
 */
function lifetimes(instrs){
    /** @type {Map<VReg, { first: number, last: number }>} */
    const life = new Map();
    /** @param {VReg} reg @param {number} at */
    const touch = (reg, at)=>{
        const span = life.get(reg);
        if (!span)
        {
            life.set(reg, { first: at, last: at });
        }
        else
        {
            span.first = Math.min(span.first, at);
            span.last = Math.max(span.last, at);
        }
    };
    /** @param {Src} src @param {number} at */
    const read = (src, at)=>{
        if (src.kind === 'reg')
        {
            touch(src.reg, at);
        }
        else if (src.kind === 'cb' && src.rel)
        {
            read(src.rel, at);
        }
    };
    /** @type {[number, number][]} */
    const loops = [];
    /** @type {number[]} */
    const open = [];
    instrs.forEach((instr, at)=>{
        instr.srcs.forEach(src=>read(src, at));
        for (const dest of instr.dests)
        {
            if (dest.kind === 'reg')
            {
                touch(dest.reg, at);
            }
        }
        if (instr.op === 'loop')
        {
            open.push(at);
        }
        else if (instr.op === 'endloop')
        {
            loops.push([Number(open.pop()), at]);
        }
    });
    // A register used in a loop and alive outside it, or carried by it, lives through it.
    for (let changed = true; changed;)
    {
        changed = false;
        for (const [start, end] of loops)
        {
            for (const [reg, span] of life)
            {
                const inside = span.last > start && span.first < end;
                if (inside && (span.first < start || span.last > end || reg.carried)
                    && (span.first > start || span.last < end))
                {
                    span.first = Math.min(span.first, start);
                    span.last = Math.max(span.last, end);
                    changed = true;
                }
            }
        }
    }
    return life;
}

/** Instructions that do something besides writing their registers. */
const EFFECTS = new Set(['discard_nz', 'loop', 'endloop', 'break', 'breakc_nz', 'if_nz', 'else',
    'endif', 'ret']);

/**
 * The instructions whose results something reads: an instruction that writes only registers
 * nothing reads goes, and so, in turn, may what only it read. A loop's variable counts as read.
 *
 * @param {Instr[]} instrs
 * @returns {Instr[]}
 */
export function liveInstructions(instrs){
    let kept = instrs;
    for (;;)
    {
        /** @type {Set<VReg>} */
        const read = new Set();
        /** @param {Src} src */
        const mark = src=>{
            if (src.kind === 'reg')
            {
                read.add(src.reg);
            }
            else if (src.kind === 'cb' && src.rel)
            {
                mark(src.rel);
            }
        };
        for (const instr of kept)
        {
            instr.srcs.forEach(mark);
        }
        const next = kept.filter(instr=>EFFECTS.has(instr.op) || instr.dests.length === 0
            || instr.dests.some(d=>d.kind === 'out' || (d.kind === 'reg'
                && (read.has(d.reg) || d.reg.carried))));
        if (next.length === kept.length)
        {
            return next;
        }
        kept = next;
    }
}

/**
 * Gives every virtual register a temporary.
 *
 * @param {Instr[]} instrs
 * @returns {{ home: Map<VReg, number>, count: number }}
 */
function allocate(instrs){
    const life = lifetimes(instrs);
    const order = [...life.entries()].sort((a, b)=>a[1].first - b[1].first || a[0].id - b[0].id);
    /** @type {Map<VReg, number>} */
    const home = new Map();
    /** @type {{ reg: number, last: number }[]} */
    let active = [];
    /** @type {number[]} */
    const free = [];
    let count = 0;
    for (const [reg, span] of order)
    {
        active = active.filter(one=>{
            if (one.last <= span.first)
            {
                free.push(one.reg);
                return false;
            }
            return true;
        });
        free.sort((a, b)=>a - b);
        const taken = free.length > 0 ? /** @type {number} */ (free.shift()) : count++;
        home.set(reg, taken);
        active.push({ reg: taken, last: span.last });
    }
    return { home, count };
}

/** @param {number[]} swz @returns {number} the swizzle field, the last lane repeated */
function swizzleField(swz){
    const four = [0, 1, 2, 3].map(i=>swz[Math.min(i, swz.length - 1)] ?? 0);
    return four[0] | (four[1] << 2) | (four[2] << 4) | (four[3] << 6);
}

/**
 * Compiles the build of an entry point into a container.
 *
 * @param {Program4} program
 * @param {{ flags: number, entry: string }} options
 * @returns {Uint8Array}
 */
export function writeProgram(program, options){
    const { profile } = program;
    const instrs = liveInstructions(program.instrs);
    const model5 = profile.major >= 5;
    const { home, count: temps } = allocate(instrs);
    if (temps > 4096)
    {
        throw new BackendError('X4567', `maximum temp register index exceeded (${temps} of 4096)`);
    }

    // ---- what the code uses --------------------------------------------------------
    for (const input of program.inputs)
    {
        input.used = 0;
    }
    for (const output of program.outputs)
    {
        output.written = 0;
    }
    /** @param {Src} src */
    const note = src=>{
        if (src.kind === 'cb')
        {
            src.buffer.used = true;
            if (src.variable)
            {
                src.variable.used = true;
            }
            if (src.rel)
            {
                note(src.rel);
            }
        }
        else if (src.kind === 'input')
        {
            for (const c of src.swz)
            {
                src.input.used = (src.input.used ?? 0) | (1 << c);
            }
        }
        else if (src.kind === 'resource')
        {
            src.resource.used = true;
        }
        else if (src.kind === 'sampler')
        {
            src.sampler.used = true;
        }
    };
    for (const instr of instrs)
    {
        instr.srcs.forEach(note);
        for (const dest of instr.dests)
        {
            if (dest.kind === 'out')
            {
                dest.out.written = (dest.out.written ?? 0) | dest.mask;
            }
        }
    }
    // A cbuffer is bound when anything in it is read; a variable read through a relative
    // index of its array counts as used, as a whole.
    const buffers = program.buffers.filter(b=>b.used).sort((a, b)=>a.order - b.order);
    const resources = program.resources.filter(r=>r.used);
    const samplers = program.samplers.filter(s=>s.used);
    /**
     * Slots: those named first, then the lowest free in declaration order.
     * @param {{ explicit: number | null, slot: number, count?: number, name: string }[]} list
     * @param {number} limit @param {string} file
     */
    const bind = (list, limit, file)=>{
        /** @type {Set<number>} */
        const taken = new Set();
        for (const one of list)
        {
            if (one.explicit !== null)
            {
                one.slot = one.explicit;
                for (let i = 0; i < (one.count ?? 1); i++)
                {
                    taken.add(one.slot + i);
                }
            }
        }
        for (const one of list)
        {
            if (one.explicit !== null)
            {
                continue;
            }
            let slot = 0;
            const n = one.count ?? 1;
            while (Array.from({ length: n }, (_, i)=>slot + i).some(s=>taken.has(s)))
            {
                slot++;
            }
            one.slot = slot;
            for (let i = 0; i < n; i++)
            {
                taken.add(slot + i);
            }
            if (slot + n > limit)
            {
                throw new BackendError('X4509', `'${one.name}': ${file} registers past ${file}${
                    limit - 1} are not available`);
            }
        }
    };
    bind(buffers, 14, 'b');
    bind(resources, 128, 't');
    bind(samplers, 16, 's');

    // ---- signatures ------------------------------------------------------------------
    program.inputs.forEach((input, i)=>{
        input.reg = i;
    });
    let nextOut = 0;
    for (const output of program.outputs)
    {
        if (output.depth)
        {
            output.reg = 0xffffffff;
        }
        else if (output.target !== undefined)
        {
            output.reg = output.target;
        }
        else
        {
            output.reg = nextOut++;
        }
    }
    const widthMask = (/** @type {number} */ w)=>(1 << w) - 1;
    const componentType = (/** @type {'f' | 'i' | 'u'} */ kind)=>(kind === 'f' ? 3 : kind === 'i'
        ? 2 : 1);
    const isgn = writeSignature(program.inputs.map(input=>({ name: input.name,
        index: input.index, sv: input.sv, componentType: componentType(input.kind),
        register: /** @type {number} */ (input.reg), mask: widthMask(input.width),
        rwMask: (input.used ?? 0) & widthMask(input.width) })));
    const sortedOutputs = program.outputs.slice().sort((a, b)=>(a.reg ?? 0) - (b.reg ?? 0));
    // An output's read-write mask is the components never written: of the whole register
    // where the output has it alone (Wine's reflection tests: a depth or a primitive id, mask
    // 0x1, says 0xe), of its own components where it shares the register with another.
    const osgn = writeSignature(sortedOutputs.map(output=>{
        const mask = widthMask(output.width) << output.first;
        const alone = output.depth || !program.outputs.some(other=>other !== output
            && !other.depth && other.reg === output.reg);
        return { name: output.name, index: output.index, sv: output.sv,
            componentType: componentType(output.kind), register: /** @type {number} */ (output.reg),
            mask, rwMask: (alone ? 0xf : mask) & ~(output.written ?? 0) };
    }));

    // ---- the token stream --------------------------------------------------------------
    /** @type {number[]} */
    const words = [];
    const stats = { instructions: 0, float: 0, int: 0, uint: 0, staticFlow: 0, dynamicFlow: 0,
        dcl: 0, textureNormal: 0, textureLoad: 0, textureComp: 0, textureBias: 0,
        textureGradient: 0, mov: 0, movc: 0, conversion: 0 };

    /**
     * An operand token and what follows it.
     * @param {number} type @param {number[]} indices
     * @param {{ comps?: 0 | 1 | 4, selection?: number, field?: number, modifier?: number,
     *     relative?: number[] | null }} [form]
     */
    const operand = (type, indices, form = {})=>{
        const comps = form.comps ?? 4;
        let token = comps === 0 ? 0 : comps === 1 ? 1 : 2;
        if (comps === 4)
        {
            token |= ((form.selection ?? SELECTION.MASK) << 2) | ((form.field ?? 0xf) << 4);
        }
        token |= type << 12;
        token |= indices.length << 20;
        const relative = form.relative ?? null;
        indices.forEach((_, d)=>{
            const last = d === indices.length - 1;
            token |= (last && relative ? 3 : 0) << (22 + d * 3);
        });
        const modifier = form.modifier ?? 0;
        /** @type {number[]} */
        const out = [];
        if (modifier)
        {
            token |= 0x80000000;
        }
        out.push(token >>> 0);
        if (modifier)
        {
            out.push(1 | (modifier << 6));
        }
        indices.forEach((index, d)=>{
            out.push(index >>> 0);
            if (d === indices.length - 1 && relative)
            {
                out.push(...relative);
            }
        });
        return out;
    };

    /** @param {Dest} dest @returns {number[]} */
    const destTokens = dest=>{
        switch (dest.kind)
        {
            case 'reg': {
                const at = /** @type {number} */ (home.get(dest.reg));
                return operand(OPERAND.TEMP, [at], { field: dest.mask });
            }
            case 'out':
                if (dest.out.depth)
                {
                    return operand(OPERAND.OUTPUT_DEPTH, [], { comps: 1 });
                }
                return operand(OPERAND.OUTPUT, [Number(dest.out.reg)],
                    { field: dest.mask });
            default:
                return operand(OPERAND.NULL, [], { comps: 0 });
        }
    };

    /**
     * @param {Src} src @param {{ select1?: boolean }} [how]
     * @returns {number[]}
     */
    const srcTokens = (src, how = {})=>{
        const modifier = /** @type {any} */ (src).neg && /** @type {any} */ (src).abs ? 3
            : /** @type {any} */ (src).neg ? 1 : /** @type {any} */ (src).abs ? 2 : 0;
        /** @param {number[]} swz */
        const lanes = swz=>(how.select1 && swz.length === 1
            ? { selection: SELECTION.SELECT1, field: swz[0] & 3 }
            : { selection: SELECTION.SWIZZLE, field: swizzleField(swz) });
        switch (src.kind)
        {
            case 'reg':
                return operand(OPERAND.TEMP, [Number(home.get(src.reg))],
                    { ...lanes(src.swz), modifier });
            case 'input':
                return operand(OPERAND.INPUT, [Number(src.input.reg)],
                    { ...lanes(src.swz), modifier });
            case 'cb': {
                const relative = src.rel ? srcTokens(src.rel, { select1: true }) : null;
                return operand(OPERAND.CONSTANT_BUFFER, [src.buffer.slot, src.row],
                    { ...lanes(src.swz), modifier, relative });
            }
            case 'resource':
                return operand(OPERAND.RESOURCE, [src.resource.slot + src.element],
                    { selection: SELECTION.SWIZZLE, field: 0xe4 });
            case 'sampler':
                return operand(OPERAND.SAMPLER, [src.sampler.slot + src.element], { comps: 0 });
            case 'imm': {
                const bits = src.values.map(x=>laneBits(x, src.t));
                if (bits.length === 1)
                {
                    return [(1 | (OPERAND.IMMEDIATE32 << 12)) >>> 0, bits[0]];
                }
                const four = [0, 1, 2, 3].map(i=>bits[Math.min(i, bits.length - 1)]);
                return [(2 | (OPERAND.IMMEDIATE32 << 12)) >>> 0, ...four];
            }
            default:
                throw new Error('internal: an operand the encoder does not know');
        }
    };

    /**
     * @param {number} opcode @param {number[][]} operands
     * @param {{ control?: number, extended?: number[], extra?: number[] }} [more]
     */
    const put = (opcode, operands, more = {})=>{
        const body = operands.flat();
        const extended = more.extended ?? [];
        const extra = more.extra ?? [];
        const length = 1 + extended.length + body.length + extra.length;
        if (length > 127)
        {
            throw new BackendError('X0000', 'an instruction too long to encode');
        }
        words.push((opcode | ((more.control ?? 0) << 11) | (length << 24)
            | (extended.length > 0 ? 0x80000000 : 0)) >>> 0, ...extended, ...body, ...extra);
    };

    // Declarations.
    if (profile.major >= 5 || instrs.some(i=>i.op === 'dp2'))
    {
        // fxc lets the driver reorder floating point unless told otherwise.
        put(OPCODE.DCL_GLOBAL_FLAGS, [], { control: 1 });
        stats.dcl++;
    }
    for (const buffer of buffers)
    {
        const dynamic = instrs.some(i=>i.srcs.some(s=>s.kind === 'cb' && s.buffer === buffer
            && s.rel));
        put(OPCODE.DCL_CONSTANT_BUFFER, [operand(OPERAND.CONSTANT_BUFFER,
            [buffer.slot, Math.max(1, buffer.size / 16)], { selection: SELECTION.SWIZZLE,
                field: 0xe4 })], { control: dynamic ? 1 : 0 });
        stats.dcl++;
    }
    for (const sampler of samplers)
    {
        for (let i = 0; i < sampler.count; i++)
        {
            put(OPCODE.DCL_SAMPLER, [operand(OPERAND.SAMPLER, [sampler.slot + i], { comps: 0 })],
                { control: sampler.comparison ? 1 : 0 });
            stats.dcl++;
        }
    }
    for (const resource of resources)
    {
        const [dimension] = DIMENSIONS[resource.dim] ?? [3, 4];
        const returnType = resource.kind === 'f' ? 5 : resource.kind === 'i' ? 3 : 4;
        for (let i = 0; i < resource.count; i++)
        {
            put(OPCODE.DCL_RESOURCE, [operand(OPERAND.RESOURCE, [resource.slot + i],
                { selection: SELECTION.MASK, field: 0 })], {
                control: dimension | ((resource.samples & 0x7f) << 5),
                extra: [returnType | (returnType << 4) | (returnType << 8) | (returnType << 12)],
            });
            stats.dcl++;
        }
    }
    const ps = profile.kind === 'ps';
    for (const input of program.inputs)
    {
        const mask = input.used || 0;
        if (mask === 0)
        {
            continue;
        }
        const dest = operand(OPERAND.INPUT, [Number(input.reg)], { field: mask });
        if (!ps)
        {
            if (input.sv)
            {
                put(OPCODE.DCL_INPUT_SGV, [dest], { extra: [input.sv] });
            }
            else
            {
                put(OPCODE.DCL_INPUT, [dest]);
            }
        }
        else if (input.sv === 1 || input.sv === 2 || input.sv === 3)
        {
            put(OPCODE.DCL_INPUT_PS_SIV, [dest], { control: INTERPOLATION[input.interpolation],
                extra: [input.sv] });
        }
        else if (input.sv)
        {
            put(OPCODE.DCL_INPUT_PS_SGV, [dest], { control: INTERPOLATION.constant,
                extra: [input.sv] });
        }
        else
        {
            put(OPCODE.DCL_INPUT_PS, [dest], { control: INTERPOLATION[input.interpolation] });
        }
        stats.dcl++;
    }
    for (const output of sortedOutputs)
    {
        if (output.depth)
        {
            put(OPCODE.DCL_OUTPUT, [operand(OPERAND.OUTPUT_DEPTH, [], { comps: 1 })]);
        }
        else
        {
            const dest = operand(OPERAND.OUTPUT, [Number(output.reg)],
                { field: widthMask(output.width) << output.first });
            if (output.sv)
            {
                put(OPCODE.DCL_OUTPUT_SIV, [dest], { extra: [output.sv] });
            }
            else
            {
                put(OPCODE.DCL_OUTPUT, [dest]);
            }
        }
        stats.dcl++;
    }
    if (temps > 0)
    {
        put(OPCODE.DCL_TEMPS, [], { extra: [temps] });
        stats.dcl++;
    }

    // The code.
    const TEST_NONZERO = 1 << 7;
    for (const instr of instrs)
    {
        const opcode = OPCODES[instr.op];
        if (opcode === undefined)
        {
            throw new Error(`internal: no opcode for ${instr.op}`);
        }
        const [first] = instr.dests;
        const [only] = instr.srcs;
        if (instr.op === 'mov' && !instr.sat && first?.kind === 'reg' && only?.kind === 'reg'
            && !only.neg && !only.abs && home.get(first.reg) === home.get(only.reg)
            && [0, 1, 2, 3].every(c=>(first.mask & (1 << c)) === 0 || only.swz[c] === c))
        {
            // A register moved onto itself, where a loop's variable took its value's place.
            continue;
        }
        stats.instructions++;
        if (FLOAT_OPS.has(instr.op))
        {
            stats.float++;
        }
        else if (INT_OPS.has(instr.op))
        {
            stats.int++;
        }
        else if (UINT_OPS.has(instr.op))
        {
            stats.uint++;
        }
        else if (CONVERSIONS.has(instr.op))
        {
            stats.conversion++;
        }
        else if (instr.op === 'mov')
        {
            stats.mov++;
        }
        else if (instr.op === 'movc')
        {
            stats.movc++;
        }
        if (instr.op === 'sample' || instr.op === 'gather4')
        {
            stats.textureNormal++;
        }
        else if (instr.op === 'ld' || instr.op === 'ld_ms' || instr.op === 'resinfo')
        {
            stats.textureLoad++;
        }
        else if (instr.op === 'sample_c' || instr.op === 'sample_c_lz')
        {
            stats.textureComp++;
        }
        else if (instr.op === 'sample_b' || instr.op === 'sample_l')
        {
            stats.textureBias++;
        }
        else if (instr.op === 'sample_d')
        {
            stats.textureGradient++;
        }
        if (['loop', 'endloop', 'break', 'breakc_nz', 'if_nz', 'else', 'endif'].includes(instr.op))
        {
            stats.dynamicFlow++;
        }
        /** @type {number[][]} */
        const dests = instr.dests.map(destTokens);
        // imul and umul give the high half first, which nothing here wants.
        if ((instr.op === 'imul' || instr.op === 'umul') && dests.length === 1)
        {
            dests.unshift(operand(OPERAND.NULL, [], { comps: 0 }));
        }
        const flow = ['breakc_nz', 'if_nz', 'discard_nz'].includes(instr.op);
        const srcs = instr.srcs.map(src=>srcTokens(src, { select1: flow }));
        /** @type {number[]} */
        const extended = [];
        if (instr.offset)
        {
            const [u = 0, v = 0, w = 0] = instr.offset;
            extended.push((1 | ((u & 0xf) << 9) | ((v & 0xf) << 13) | ((w & 0xf) << 17)) >>> 0);
        }
        let control = 0;
        if (instr.sat)
        {
            control |= 1 << 2;
        }
        if (flow)
        {
            control |= TEST_NONZERO;
        }
        if (instr.op === 'resinfo')
        {
            control |= instr.uint ? 2 : 0;
        }
        put(opcode, [...dests, ...srcs], { control, extended });
    }
    put(OPCODE.RET, []);
    stats.instructions++;
    stats.staticFlow++;

    const [kind, rdefKind] = KINDS[profile.kind];
    const version = (kind << 16) | (profile.major << 4) | profile.minor;
    const shdr = new Uint8Array((words.length + 2) * 4);
    const view = new DataView(shdr.buffer);
    view.setUint32(0, version, true);
    view.setUint32(4, words.length + 2, true);
    words.forEach((word, i)=>view.setUint32(8 + i * 4, word, true));

    // ---- reflection ---------------------------------------------------------------------
    const bindings = [
        ...samplers.map(s=>({ name: s.name, type: 3, returnType: 0, dimension: 0, samples: 0,
            bindPoint: s.slot, bindCount: s.count, flags: (s.explicit !== null ? 1 : 0)
                | (s.comparison ? 2 : 0) })),
        ...resources.map(r=>({ name: r.name, type: 2,
            returnType: r.kind === 'f' ? 5 : r.kind === 'i' ? 3 : 4,
            dimension: (DIMENSIONS[r.dim] ?? [3, 4])[1],
            samples: r.dim === '2dms' || r.dim === '2dmsarray' ? r.samples : 0xffffffff,
            bindPoint: r.slot, bindCount: r.count,
            flags: (r.explicit !== null ? 1 : 0) | ((r.components - 1) << 2) })),
        ...buffers.map(b=>({ name: b.name, type: b.kind, returnType: 0, dimension: 0, samples: 0,
            bindPoint: b.slot, bindCount: 1, flags: b.explicit !== null ? 1 : 0 })),
    ];
    const rdef = writeResourceDefinitions({
        buffers: buffers.map(b=>({ name: b.name, size: b.size, flags: 0, type: b.kind,
            variables: b.variables.map(v=>({ name: v.name, offset: v.offset, size: v.size,
                flags: v.used ? 2 : 0, type: v.type, defaults: v.defaults })) })),
        bindings,
        version: ((rdefKind << 16) | (profile.major << 8) | profile.minor) >>> 0,
        // fxc says no preshader for every model 4 program: there is none.
        flags: (options.flags | 0x100) >>> 0,
        creator: CREATOR,
        model5,
    });

    const stat = new Uint8Array(model5 ? 148 : 116);
    const statView = new DataView(stat.buffer);
    [stats.instructions, temps, 0, stats.dcl, stats.float, stats.int, stats.uint,
        stats.staticFlow, stats.dynamicFlow, 0, 0, 0, 0, 0, stats.textureNormal,
        stats.textureLoad, stats.textureComp, stats.textureBias, stats.textureGradient,
        stats.mov, stats.movc, stats.conversion].forEach((value, i)=>{
        statView.setUint32(i * 4, value, true);
    });

    return writeContainer([
        { name: 'RDEF', bytes: rdef },
        { name: 'ISGN', bytes: isgn },
        { name: 'OSGN', bytes: osgn },
        { name: model5 ? 'SHEX' : 'SHDR', bytes: shdr },
        { name: 'STAT', bytes: stat },
    ]);
}
