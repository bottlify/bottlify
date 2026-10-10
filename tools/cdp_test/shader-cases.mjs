/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Seeded random Direct3D 9 shaders, each with what the reference machine says
 * it computes and the WGSL the translator makes of it -- the two sides of the
 * shader gate (`shader-gate.mjs`), which runs the WGSL on a real GPU and
 * compares.
 *
 * A program is grown an instruction at a time and every candidate is put
 * through the assembler's validation, so what comes out is a shader the
 * version allows; one the version refuses is simply not taken. Every
 * temporary is written in full before anything reads it, because the
 * reference machine refuses an unwritten read rather than guessing.
 */

import { assemble, execute } from '../../modules/core/src/layers/win32/d3dx9/d3d9-machine.fixture.js';
import { parseShader } from '../../modules/core/src/layers/graphics/d3d9/shader.js';
import { translateShader } from '../../modules/core/src/layers/graphics/d3d9/wgsl.js';

/** @param {number} seed */
export function generator(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** @template T @param {() => number} next @param {readonly T[]} list @returns {T} */
const pick = (next, list)=>list[Math.floor(next() * list.length)];

/** @param {() => number} next @param {number} low @param {number} high */
const between = (next, low, high)=>Math.fround(low + next() * (high - low));

/** What a sampler's 1x1 texture holds: bytes, so the GPU and the machine read the same number. */
export const SAMPLER_BYTES = [[64, 128, 192, 255], [255, 32, 96, 160], [16, 240, 128, 8],
    [200, 100, 50, 25]];

/**
 * @typedef {Object} Profile
 * @property {string} name
 * @property {boolean} vertex
 * @property {string[]} head         dcl lines.
 * @property {string[]} init         Writes every temporary in full.
 * @property {string[]} temps
 * @property {string[]} reads        Sources besides the temporaries.
 * @property {string[]} masks
 * @property {string[]} swizzles
 * @property {string[]} scalars      Replicate swizzles for the scalar instructions.
 * @property {string[]} unary
 * @property {string[]} scalar
 * @property {string[]} binary
 * @property {string[]} ternary
 * @property {string[]} dmods        Destination modifiers.
 * @property {((next: () => number, r: string, s: string) => string)[]} sourceForms
 * @property {string[]} tail         Writes the outputs.
 * @property {number} [samplers]
 * @property {string[]} [special]    Instructions with forms of their own, by name.
 * @property {boolean} [flow]        Whether to try if, rep and loop blocks.
 * @property {boolean} [predicated]  Whether p0 exists: setp, predicated writes, if p0, breakp.
 */

/** @param {() => number} next @param {string} r @param {string} s */
const plain = (next, r, s)=>`${r}${s}`;
/** @param {() => number} next @param {string} r @param {string} s */
const negated = (next, r, s)=>`-${r}${s}`;
/** @param {() => number} next @param {string} r @param {string} s */
const absolute = (next, r, s)=>`|${r}${s}|`;

const SWIZZLES = ['', '.x', '.y', '.z', '.w', '.yzxw', '.wzyx', '.xxyy', '.zwxy'];
const SCALARS = ['.x', '.y', '.z', '.w'];
const MASKS = ['', '.x', '.y', '.xy', '.xz', '.yzw', '.w', '.xyz'];

/** The documented D3DSINCOSCONST1 and 2 a 2.x sincos names as its extra operands. */
const SINCOS_DEFS = ['def c20, -1.5500992e-006, -2.1701389e-005, 0.0026041667, 0.00026041668',
    'def c21, -0.020833334, -0.125, 1.0, 0.5'];

/** @type {Record<string, Profile>} */
export const PROFILES = {
    vs_1_1: {
        name: 'vs_1_1', vertex: true, special: ['lit', 'm4x4', 'm3x3'],
        head: ['dcl_position v0', 'dcl_texcoord0 v1', 'dcl_color v2'],
        init: ['mov r0, v0', 'mov r1, v1', 'mov r2, c0', 'mov r3, v2'],
        temps: ['r0', 'r1', 'r2', 'r3'], reads: ['v0', 'v1', 'v2', 'c1', 'c2', 'c3', 'c9'],
        masks: MASKS, swizzles: SWIZZLES, scalars: SCALARS,
        unary: ['mov', 'frc'], scalar: ['rcp', 'rsq', 'exp', 'log', 'expp', 'logp'],
        binary: ['add', 'sub', 'mul', 'min', 'max', 'dp3', 'dp4', 'slt', 'sge', 'dst'],
        ternary: ['mad'], dmods: [''], sourceForms: [plain, plain, negated],
        tail: ['mov oPos, r0', 'mov oT0, r1', 'mov oD0, r3'],
    },
    vs_2_0: {
        name: 'vs_2_0', vertex: true, flow: true,
        special: ['pow', 'lit', 'm4x4', 'm3x3', 'sincos2'],
        head: [...SINCOS_DEFS, 'dcl_position v0', 'dcl_texcoord0 v1', 'dcl_color v2'],
        init: ['mov r0, v0', 'mov r1, v1', 'mov r2, c0', 'mov r3, v2'],
        temps: ['r0', 'r1', 'r2', 'r3'], reads: ['v0', 'v1', 'v2', 'c1', 'c2', 'c3', 'c9'],
        masks: MASKS, swizzles: SWIZZLES, scalars: SCALARS,
        unary: ['mov', 'frc', 'abs', 'nrm'], scalar: ['rcp', 'rsq', 'exp', 'log', 'expp', 'logp'],
        binary: ['add', 'sub', 'mul', 'min', 'max', 'dp3', 'dp4', 'slt', 'sge', 'dst', 'crs'],
        ternary: ['mad', 'lrp'], dmods: [''], sourceForms: [plain, plain, negated],
        tail: ['mov oPos, r0', 'mov oT0, r1', 'mov oD0, r3'],
    },
    vs_3_0: {
        name: 'vs_3_0', vertex: true, flow: true, predicated: true,
        special: ['pow', 'lit', 'm4x4', 'm3x3', 'sincos3'],
        head: ['dcl_position v0', 'dcl_texcoord0 v1', 'dcl_color v2', 'dcl_position o0',
            'dcl_texcoord0 o1', 'dcl_color o2'],
        init: ['mov r0, v0', 'mov r1, v1', 'mov r2, c0', 'mov r3, v2'],
        temps: ['r0', 'r1', 'r2', 'r3'], reads: ['v0', 'v1', 'v2', 'c1', 'c2', 'c3', 'c9'],
        masks: MASKS, swizzles: SWIZZLES, scalars: SCALARS,
        unary: ['mov', 'frc', 'abs', 'nrm'], scalar: ['rcp', 'rsq', 'exp', 'log'],
        binary: ['add', 'sub', 'mul', 'min', 'max', 'dp3', 'dp4', 'slt', 'sge', 'crs'],
        ternary: ['mad', 'lrp'], dmods: ['', '_sat'],
        sourceForms: [plain, plain, negated, absolute],
        tail: ['mov o0, r0', 'mov o1, r1', 'mov o2, r3'],
    },
    ps_2_0: {
        name: 'ps_2_0', vertex: false, samplers: 2, special: ['pow', 'sincos2', 'texkill'],
        head: [...SINCOS_DEFS, 'dcl t0', 'dcl t1', 'dcl v0', 'dcl_2d s0', 'dcl_2d s1'],
        init: ['texld r0, t0, s0', 'mov r1, t1', 'mov r2, c0', 'texld r3, t1, s1',
            'add r3, r3, v0'],
        temps: ['r0', 'r1', 'r2', 'r3'], reads: ['t0', 't1', 'v0', 'c1', 'c2', 'c3', 'c9'],
        masks: MASKS, swizzles: ['', '.x', '.y', '.z', '.w', '.yzxw', '.wzyx'], scalars: SCALARS,
        unary: ['mov', 'frc', 'abs', 'nrm'], scalar: ['rcp', 'rsq', 'exp', 'log'],
        binary: ['add', 'sub', 'mul', 'min', 'max', 'dp3', 'dp4', 'crs'],
        ternary: ['mad', 'lrp', 'cmp', 'dp2add'], dmods: ['', '_sat'],
        sourceForms: [plain, plain, negated], tail: ['mov oC0, r0'],
    },
    ps_3_0: {
        name: 'ps_3_0', vertex: false, samplers: 2, flow: true, predicated: true,
        special: ['pow', 'sincos3', 'texkill', 'dsx', 'dsy', 'vpos', 'vface'],
        head: ['dcl_texcoord0 v0', 'dcl_texcoord1 v1', 'dcl_color0 v2', 'dcl vPos.xy', 'dcl vFace',
            'dcl_2d s0', 'dcl_2d s1'],
        init: ['texld r0, v0, s0', 'mov r1, v1', 'mov r2, c0', 'texld r3, v1, s1',
            'add r3, r3, v2'],
        temps: ['r0', 'r1', 'r2', 'r3'], reads: ['v0', 'v1', 'v2', 'c1', 'c2', 'c3', 'c9'],
        masks: MASKS, swizzles: SWIZZLES, scalars: SCALARS,
        unary: ['mov', 'frc', 'abs', 'nrm'], scalar: ['rcp', 'rsq', 'exp', 'log'],
        binary: ['add', 'sub', 'mul', 'min', 'max', 'dp3', 'dp4', 'crs'],
        ternary: ['mad', 'lrp', 'cmp', 'dp2add'], dmods: ['', '_sat'],
        sourceForms: [plain, plain, negated, absolute], tail: ['mov oC0, r0'],
    },
};

/** The ps_1_x source modifiers, written between the register and its selector. */
const PS1_FORMS = [
    /** @type {(next: () => number, r: string, s: string) => string} */ ((next, r, s)=>`${r}${s}`),
    (next, r, s)=>`-${r}${s}`, (next, r, s)=>`1-${r}${s}`, (next, r, s)=>`${r}_bias${s}`,
    (next, r, s)=>`${r}_bx2${s}`, (next, r, s)=>`-${r}_bx2${s}`,
];

for (const minor of [1, 2, 3])
{
    PROFILES[`ps_1_${minor}`] = {
        name: `ps_1_${minor}`, vertex: false, samplers: 2,
        head: ['tex t0', 'tex t1'],
        init: ['mov r0, v0', 'mov r1, t1'],
        temps: ['r0', 'r1'], reads: ['t0', 't1', 'v0', 'v1', 'c0', 'c1', 'c2', 'c7'],
        masks: ['', '.rgb', '.a'], swizzles: ['', '.a', '.b'], scalars: [],
        unary: ['mov'], scalar: [],
        binary: ['add', 'sub', 'mul', 'dp3', ...(minor >= 2 ? ['dp4'] : [])],
        ternary: ['mad', 'lrp', 'cnd', ...(minor >= 2 ? ['cmp'] : [])],
        dmods: ['', '_sat', '_x2', '_x4', '_d2'], sourceForms: PS1_FORMS, tail: [],
    };
}
PROFILES.ps_1_4 = {
    name: 'ps_1_4', vertex: false, samplers: 2,
    head: ['texld r0, t0', 'texld r1, t1', 'texcrd r2.rgb, t1'],
    init: ['mov r2.a, c0', 'mov r3, v0', 'mov r4, c1', 'mov r5, r1', 'mov r0, r0'],
    temps: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], reads: ['v0', 'v1', 'c0', 'c1', 'c2', 'c7'],
    masks: ['', '.rgb', '.a', '.r', '.g', '.rg'], swizzles: ['', '.a', '.b', '.r', '.g'],
    scalars: [], unary: ['mov'], scalar: [],
    binary: ['add', 'sub', 'mul', 'dp3', 'dp4'], ternary: ['mad', 'lrp', 'cnd', 'cmp'],
    dmods: ['', '_sat', '_x2', '_x4', '_d2'], sourceForms: PS1_FORMS, tail: [],
};

/**
 * One instruction, at random from what the profile names.
 *
 * @param {Profile} p @param {() => number} next
 */
function instruction(p, next){
    const source = (/** @type {boolean} */ scalar)=>{
        const r = pick(next, next() < 0.6 ? p.temps : p.reads);
        const s = scalar ? pick(next, p.scalars.length ? p.scalars : p.swizzles)
            : pick(next, p.swizzles);
        return pick(next, p.sourceForms)(next, r, s);
    };
    const dest = ()=>`${pick(next, p.temps)}${pick(next, p.masks)}`;
    const kinds = [
        ...(p.unary.length ? ['unary'] : []), ...(p.scalar.length ? ['scalar'] : []),
        'binary', 'binary', 'ternary',
    ];
    if (p.special && next() < 0.2)
    {
        return special(p, next, pick(next, p.special), source, dest);
    }
    if (p.flow && next() < 0.12)
    {
        return block(p, next);
    }
    if (p.predicated && next() < 0.15)
    {
        // Under the predicate, or a fresh comparison into some of it.
        if (next() < 0.3)
        {
            return [`setp_${pick(next, ['gt', 'lt', 'ge', 'le', 'eq', 'ne'])}`
                + ` p0${pick(next, MASKS)}, ${source(false)}, ${source(false)}`];
        }
        const guard = `(${next() < 0.4 ? '!' : ''}p0${pick(next, ['', '.x', '.y', '.z', '.w',
            '.wzyx', '.xxyy'])})`;
        return instruction({ ...p, predicated: false, flow: false, special: [] }, next)
            .filter(line=>!line.startsWith('+')).map(line=>`${guard} ${line}`);
    }
    const kind = pick(next, kinds);
    const op = pick(next, /** @type {any} */ (p)[kind]);
    const mod = pick(next, p.dmods);
    const count = kind === 'ternary' ? 3 : kind === 'binary' ? 2 : 1;
    const sources = Array.from({ length: count }, ()=>source(kind === 'scalar'));
    const coissue = p.name.startsWith('ps_1_') && next() < 0.15;
    const line = `${op}${mod} ${dest()}, ${sources.join(', ')}`;
    const paired = `+${pick(next, ['mov', 'add', 'mul'])} r0.a, ${source(false)}`;
    return coissue ? [line, paired] : [line];
}

/**
 * An instruction with a form of its own.
 *
 * @param {Profile} p @param {() => number} next @param {string} name
 * @param {(scalar: boolean) => string} source @param {() => string} dest
 * @returns {string[]}
 */
function special(p, next, name, source, dest){
    const temp = ()=>pick(next, p.temps);
    switch (name)
    {
        case 'pow':
            return [`pow ${temp()}${pick(next, ['.x', '.y', ''])}, ${source(true)},`
                + ` ${source(true)}`];
        case 'lit': return [`lit ${dest()}, ${source(false)}`];
        case 'm4x4': return [`m4x4 ${temp()}, ${source(false)}, c${pick(next, [4, 8])}`];
        case 'm3x3': return [`m3x3 ${temp()}.xyz, ${source(false)}, c${pick(next, [4, 8])}`];
        case 'sincos2':
            return [`sincos ${temp()}${pick(next, ['.x', '.y', '.xy'])}, ${source(true)},`
                + ' c20, c21'];
        case 'sincos3':
            return [`sincos ${temp()}${pick(next, ['.x', '.y', '.xy'])}, ${source(true)}`];
        case 'texkill': return [`texkill ${pick(next, p.temps)}`];
        case 'dsx': return [`dsx ${dest()}, ${source(false)}`];
        case 'dsy': return [`dsy ${dest()}, ${source(false)}`];
        case 'vpos': return [`add ${dest()}, vPos.xyxy, ${source(false)}`];
        case 'vface': return [`mul ${dest()}, vFace, ${source(false)}`];
        default: return [];
    }
}

/**
 * A block of flow control around a few ordinary instructions: a branch on a
 * boolean or on a comparison, a counted repeat, or a loop whose counter
 * addresses the constants.
 *
 * @param {Profile} p @param {() => number} next
 * @returns {string[]}
 */
function block(p, next){
    const inner = ()=>{
        const lines = [];
        const count = 1 + Math.floor(next() * 3);
        for (let k = 0; k < count; k++)
        {
            const one = instruction({ ...p, flow: false, special: [] }, next);
            lines.push(...one.filter(line=>!line.startsWith('+')));
        }
        return lines;
    };
    const temp = pick(next, p.temps);
    switch (Math.floor(next() * 7))
    {
        case 5:
            if (p.predicated && next() < 0.5)
            {
                const component = pick(next, ['.x', '.y', '.z', '.w']);
                return next() < 0.5
                    ? [`if ${next() < 0.5 ? '!' : ''}p0${component}`, ...inner(), 'endif']
                    : ['rep i0', ...inner(), `breakp ${next() < 0.5 ? '!' : ''}p0${component}`,
                        ...inner(), 'endrep'];
            }
            return [`call l${Math.floor(next() * SUBROUTINES)}`];
        case 6: return [`callnz l${Math.floor(next() * SUBROUTINES)}, ${next() < 0.5 ? '!' : ''}`
            + `b${Math.floor(next() * 4)}`];
        case 0: return [`if b${Math.floor(next() * 4)}`, ...inner(), 'endif'];
        case 1: return [`if b${Math.floor(next() * 4)}`, ...inner(), 'else', ...inner(), 'endif'];
        case 2:
            return [`if_${pick(next, ['gt', 'lt', 'ge', 'le', 'eq', 'ne'])} ${temp}.x, c1.y`,
                ...inner(), 'endif'];
        case 3: return ['rep i0', ...inner(), 'endrep'];
        default:
            return ['loop aL, i1', `add ${temp}, ${temp}, c[aL + 10]`, ...inner(), 'endloop'];
    }
}

/** The subroutines a profile with flow control has, l0 and l1. */
const SUBROUTINES = 2;

/**
 * The bodies of the subroutines: a few instructions, a ret from inside a
 * branch or a loop now and then, and l1 calling l0.
 *
 * @param {Profile} p @param {() => number} next
 * @returns {string[][]}
 */
function subroutines(p, next){
    const plainOne = ()=>instruction({ ...p, flow: false, special: [] }, next)
        .filter(line=>!line.startsWith('+'));
    return Array.from({ length: SUBROUTINES }, (_, k)=>{
        const lines = [...plainOne(), ...plainOne()];
        const temp = pick(next, p.temps);
        const roll = next();
        if (roll < 0.3)
        {
            lines.splice(1, 0, `if b${Math.floor(next() * 4)}`, ...plainOne(), 'ret', 'endif');
        }
        else if (roll < 0.6)
        {
            lines.push('rep i0', ...plainOne(), `if_gt ${temp}.x, c1.y`, 'ret', 'endif',
                ...plainOne(), 'endrep');
        }
        if (k > 0 && next() < 0.5)
        {
            lines.push('call l0');
        }
        return lines;
    });
}

/**
 * @param {Profile} p @param {string[]} body @param {string[][]} [subs]
 */
const programText = (p, body, subs = [])=>[p.name, ...p.head, ...p.init, ...body, ...p.tail,
    ...(subs.length > 0
        ? ['ret', ...subs.flatMap((lines, k)=>[`label l${k}`, ...lines, 'ret'])]
        : []),
].join('\n');

/**
 * @typedef {Object} GateCase
 * @property {string} profile
 * @property {number} seed
 * @property {string} text
 * @property {boolean} vertex
 * @property {string} wgsl
 * @property {string} entry
 * @property {{ index: number, type: string }[]} samplers
 * @property {number[]} constants      The float constants as the GPU reads them, flat.
 * @property {number[]} ints
 * @property {number[]} bools
 * @property {Record<string, number[]>} inputs   By register name: v0, t1 ...
 * @property {Record<string, number[]>} expected  By output name, unwritten components NaN.
 * @property {Record<string, number>} written
 * @property {number | undefined} viewportRegister
 * @property {boolean} killed
 * @property {string | null} error
 */

/**
 * A random shader of the profile and both sides of the gate for it.
 *
 * @param {string} profile @param {number} seed @param {number} [length]
 * @returns {GateCase}
 */
export function buildCase(profile, seed, length = 10){
    const p = PROFILES[profile];
    const next = generator(seed);
    // Subroutines only where the version has them and the bodies assemble.
    let subs = p.flow ? subroutines(p, next) : [];
    try
    {
        assemble(programText(p, [], subs));
    }
    catch {
        subs = [];
    }
    /** @type {string[]} */
    const body = p.predicated ? [`setp_${pick(next, ['gt', 'lt', 'ge'])} p0, r0, c1`] : [];
    for (let tries = 0; body.length < length && tries < length * 20; tries++)
    {
        const candidate = instruction(p, next);
        // Every varying is the same at the three corners, so the machine
        // takes each derivative as zero; vPos is the one input that moves.
        const lines = [...body, ...candidate, ...subs.flat()].join('\n');
        if (/\bds[xy]\b/.test(lines) && /vPos/.test(lines))
        {
            continue;
        }
        try
        {
            assemble(programText(p, [...body, ...candidate], subs));
            body.push(...candidate);
        }
        catch {
            // Not a shader this version allows: not taken.
        }
    }
    const text = programText(p, body, subs);
    const tokens = assemble(text);

    const ps1 = profile.startsWith('ps_1_');
    const reach = ps1 ? 1.5 : 2;
    const constants = Array.from({ length: 64 * 4 }, ()=>between(next, -reach, reach));
    // Counts up to 7, starts and steps up to 3: a loop's c[aL + 10] stays below c32.
    const ints = Array.from({ length: 16 * 4 },
        (_, at)=>Math.floor(next() * (at % 4 === 0 ? 8 : 4)));
    const bools = Array.from({ length: 16 }, ()=>(next() < 0.5 ? 1 : 0));
    /** @type {Record<string, number[]>} */
    const inputs = {};
    for (const name of ['v0', 'v1', 'v2', 't0', 't1'])
    {
        const unit = ps1 || name.startsWith('t') || (!p.vertex && name === 'v0');
        inputs[name] = Array.from({ length: 4 }, ()=>between(next, unit ? 0 : -3, unit ? 1 : 3));
    }
    const result = execute(tokens, {
        constants: { f: constants, i: ints, b: bools },
        inputs: { v: [inputs.v0, inputs.v1, inputs.v2], t: [inputs.t0, inputs.t1] },
        position: [0, 0],
        frontFacing: true,
        sample: sampler=>SAMPLER_BYTES[sampler % SAMPLER_BYTES.length]
            .map(byte=>Math.fround(byte / 255)),
        derivative: ()=>[0, 0, 0, 0],
    });
    const translated = translateShader(parseShader(tokens));
    return {
        profile, seed, text, vertex: p.vertex,
        wgsl: translated.wgsl, entry: translated.entry, samplers: translated.samplers,
        constants, ints, bools, inputs,
        expected: Object.fromEntries(Object.entries(result.outputs)
            .map(([name, values])=>[name, Array.from(values, Number)])),
        written: result.written, viewportRegister: translated.viewportRegister,
        killed: result.killed,
        error: translated.error,
    };
}
