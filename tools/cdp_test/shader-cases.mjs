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
import {
    D3DFMT, FORMAT_INFO, sampledOnes,
} from '../../modules/core/src/layers/graphics/d3d9/constants.js';
import { fromHalf, toHalf } from '../../modules/core/src/layers/graphics/d3d9/half.js';
import {
    D3DTADDRESS, D3DTEXF, D3DTSS,
} from '../../modules/core/src/layers/graphics/d3d8/constants.js';
import {
    addressVariantOf, lodBiasOf, samplerDescriptorOf,
} from '../../modules/core/src/layers/graphics/d3d8/render.js';

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
 * The format each sampler's texture may be: four channels of bytes, or a wide
 * format of one or two channels, kept as the engine keeps it (r16float,
 * rg16float), whose missing channels the translation fills with one
 * (`sampledOnes`) and the machine reads as one.
 */
const SAMPLER_FORMATS = [null, D3DFMT.R16F, D3DFMT.G16R16F];
/** @type {Record<number, string>} */
const KEPT_AS = { 1: 'r16float', 2: 'rg16float' };

/**
 * @typedef {Object} SamplerTexel
 * @property {string} format     The WebGPU format of the 1x1 texture.
 * @property {number[]} bytes    Its one texel as uploaded.
 * @property {number[]} values   What Direct3D samples from it, the filled channels one.
 * @property {number} ones       The channels the read fills (`sampledOnes`).
 * @property {number} [size]     A sampling profile's: the texture's width and height.
 * @property {number[][]} [levels]  A sampling profile's: each level's one colour, as bytes.
 * @property {number[]} [image]  An address profile's: its one level, texel by texel, as bytes.
 * @property {number[]} [modes]  An address profile's: D3DTADDRESS of u and v.
 * @property {number} [border]   An address profile's: D3DSAMP_BORDERCOLOR, a D3DCOLOR.
 * @property {any} [sampler]     A sampling profile's: the GPU sampler the engine makes for
 *     the sampler's state (`samplerDescriptorOf`); absent, linear and repeating.
 * @property {import('../../modules/core/src/layers/graphics/d3d9/wgsl.js').SamplerVariant}
 *     [variant]  What the state asks of the reads beyond that sampler.
 */

/**
 * Each sampler's texture for a case, by sampler number. Drawn from a generator
 * of its own, so a seed's program is the one it always was.
 *
 * @param {number} seed
 * @returns {SamplerTexel[]}
 */
export function samplerTexels(seed){
    const next = generator(seed ^ 0x2f6b9c4d);
    return Array.from({ length: SAMPLER_BYTES.length }, (_, sampler)=>{
        const bytes = SAMPLER_BYTES[sampler];
        const format = pick(next, SAMPLER_FORMATS);
        const channels = format === null ? 4 : FORMAT_INFO[format].wide?.channels ?? 4;
        if (format === null || channels === 4)
        {
            return { format: 'rgba8unorm', bytes, values: bytes.map(byte=>Math.fround(byte / 255)),
                ones: 0 };
        }
        const halves = bytes.slice(0, channels).map(byte=>toHalf(byte / 255));
        return {
            format: KEPT_AS[channels],
            bytes: [...new Uint8Array(Uint16Array.from(halves).buffer)],
            values: [0, 1, 2, 3].map(at=>(at < channels ? fromHalf(halves[at]) : 1)),
            ones: sampledOnes(format),
        };
    });
}

/** The colour of each level of a sampling profile's textures, distinct from level to level. */
const LEVEL_BYTES = [[250, 20, 40, 255], [30, 240, 60, 200], [10, 50, 230, 120],
    [200, 200, 20, 60]];
/** The level-of-detail biases a sampling profile's samplers are given. */
const LOD_BIASES = [-1.5, -0.75, 0.25, 1.25, 2.5];
/** How near a level of detail may come to the half between two levels and be compared. */
const LEVEL_MARGIN = 0.02;

/** The address modes an address profile's samplers are given, the two WebGPU lacks twice. */
const ADDRESS_MODES = [D3DTADDRESS.WRAP, D3DTADDRESS.MIRROR, D3DTADDRESS.CLAMP,
    D3DTADDRESS.BORDER, D3DTADDRESS.BORDER, D3DTADDRESS.MIRRORONCE, D3DTADDRESS.MIRRORONCE];
/** An address profile's textures: four texels by four. */
const ADDRESS_SIZE = 4;
/** How near a texel's edge, in texels, a point read may come and be compared. */
const TEXEL_MARGIN = 0.02;

/**
 * Each sampler's texture and state for a profile that samples under a state
 * the GPU sampler alone cannot express: 'lod', a level-of-detail bias, over a
 * texture of three levels of one colour each, read through a point mip filter
 * -- the GPU's nearest level -- so a level is told by its colour exactly; or
 * 'address', each axis's address mode with border and mirror-once among them,
 * over a texture of sixteen texels of their own read through point filters.
 *
 * @param {number} seed @param {'lod' | 'address'} kind
 * @returns {SamplerTexel[]}
 */
export function samplingTexels(seed, kind){
    const next = generator(seed ^ 0x51ed270b);
    if (kind === 'address')
    {
        return Array.from({ length: SAMPLER_BYTES.length }, (_, sampler)=>{
            const image = Array.from({ length: ADDRESS_SIZE * ADDRESS_SIZE * 4 },
                (__, at)=>(37 * at + 61 * sampler + 11) & 0xff);
            const modes = [pick(next, ADDRESS_MODES), pick(next, ADDRESS_MODES)];
            const border = Math.floor(next() * 0x100000000) >>> 0;
            const states = new Map([[D3DTSS.MAGFILTER, D3DTEXF.POINT],
                [D3DTSS.MINFILTER, D3DTEXF.POINT], [D3DTSS.MIPFILTER, D3DTEXF.NONE],
                [D3DTSS.ADDRESSU, modes[0]], [D3DTSS.ADDRESSV, modes[1]],
                [D3DTSS.BORDERCOLOR, border]]);
            return {
                format: 'rgba8unorm', bytes: image.slice(0, 4), values: [], ones: 0,
                size: ADDRESS_SIZE, image, modes, border, sampler: samplerDescriptorOf(states),
                variant: addressVariantOf(state=>states.get(state) ?? 0, '2d'),
            };
        });
    }
    return Array.from({ length: SAMPLER_BYTES.length }, (_, sampler)=>{
        const levels = [0, 1, 2].map(level=>LEVEL_BYTES[(level + sampler) % LEVEL_BYTES.length]);
        const lodBias = kind === 'lod' ? pick(next, LOD_BIASES) : 0;
        const states = new Map([[D3DTSS.MAGFILTER, D3DTEXF.LINEAR],
            [D3DTSS.MINFILTER, D3DTEXF.LINEAR], [D3DTSS.MIPFILTER, D3DTEXF.POINT],
            [D3DTSS.MIPMAPLODBIAS, new Uint32Array(Float32Array.of(lodBias).buffer)[0]]]);
        return {
            format: 'rgba8unorm', bytes: levels[0], values: levels[0].map(byte=>byte / 255),
            ones: 0, size: 4, levels, sampler: samplerDescriptorOf(states),
            variant: { lodBias: lodBiasOf(states.get(D3DTSS.MIPMAPLODBIAS) ?? 0) },
        };
    });
}

/**
 * What a sampling profile's texture answers a read, as Direct3D reads it: the
 * level the read's level of detail names with the sampler's bias added, the
 * nearest of the three, the top one at or below zero. A derived level is none
 * here -- every varying is the same at the three corners, so every derivative
 * is zero -- and its read is the top level whatever the bias. Null where the
 * level lies too near the half between two for the GPU's rounding to be known.
 *
 * @param {SamplerTexel} texel @param {{ kind: string, value?: number }} mode
 * @returns {number[] | null}
 */
function sampledLevel(texel, mode){
    const levels = /** @type {number[][]} */ (texel.levels);
    if (mode.kind !== 'lod')
    {
        return levels[0].map(byte=>byte / 255);
    }
    const lod = Math.fround(/** @type {number} */ (mode.value) + (texel.variant?.lodBias ?? 0));
    if (lod > 0 && lod < levels.length - 0.5
        && Math.abs(lod - Math.floor(lod) - 0.5) < LEVEL_MARGIN)
    {
        return null;
    }
    const level = lod <= 0 ? 0 : Math.min(levels.length - 1, Math.floor(lod + 0.5));
    return levels[level].map(byte=>byte / 255);
}

/**
 * One coordinate as a point read of an address profile's texture takes it:
 * the texel it falls in on that axis, 'border' outside [0, 1] under the
 * border mode, or null where it lies too near an edge -- of a texel, or of
 * the border -- for the GPU's rounding to be known.
 *
 * @param {number} coordinate @param {number} mode  D3DTADDRESS
 * @returns {number | 'border' | null}
 */
function addressedTexel(coordinate, mode){
    const near = (/** @type {number} */ value, /** @type {number} */ edge)=>
        Math.abs(value - edge) < TEXEL_MARGIN / ADDRESS_SIZE;
    if (mode === D3DTADDRESS.BORDER && (near(coordinate, 0) || near(coordinate, 1)))
    {
        return null;
    }
    if (mode === D3DTADDRESS.BORDER && (coordinate < 0 || coordinate > 1))
    {
        return 'border';
    }
    let at;
    switch (mode)
    {
        case D3DTADDRESS.WRAP:
            at = coordinate - Math.floor(coordinate);
            break;
        case D3DTADDRESS.MIRROR: {
            const folded = coordinate - 2 * Math.floor(coordinate / 2);
            at = folded <= 1 ? folded : 2 - folded;
            break;
        }
        case D3DTADDRESS.MIRRORONCE:
            at = Math.min(1, Math.abs(coordinate));
            break;
        default:
            at = Math.min(1, Math.max(0, coordinate));
    }
    const texels = at * ADDRESS_SIZE;
    const edge = Math.round(texels);
    // A clamped or mirrored end is the same texel from either side; a wrapped
    // one is the first or the last.
    const settled = (edge === 0 || edge === ADDRESS_SIZE) && mode !== D3DTADDRESS.WRAP;
    if (!settled && Math.abs(texels - edge) < TEXEL_MARGIN)
    {
        return null;
    }
    return Math.min(ADDRESS_SIZE - 1, Math.max(0, Math.floor(texels)));
}

/**
 * What an address profile's texture answers a read at `coord`, as Direct3D
 * addresses it: the border colour if either axis is outside under the border
 * mode, else the texel both axes name; null where either is unsettled.
 *
 * @param {SamplerTexel} texel @param {number[]} coord
 * @returns {number[] | null}
 */
function addressedRead(texel, coord){
    const modes = /** @type {number[]} */ (texel.modes);
    const u = addressedTexel(Math.fround(coord[0]), modes[0]);
    const v = addressedTexel(Math.fround(coord[1]), modes[1]);
    if (u === null || v === null)
    {
        return null;
    }
    if (u === 'border' || v === 'border')
    {
        const colour = /** @type {number} */ (texel.border);
        return [16, 8, 0, 24].map(shift=>((colour >>> shift) & 0xff) / 255);
    }
    const at = (v * ADDRESS_SIZE + u) * 4;
    return /** @type {number[]} */ (texel.image).slice(at, at + 4).map(byte=>byte / 255);
}

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
 * @property {'lod' | 'address'} [sampling]  The samplers' state the GPU sampler
 *     cannot hold (`samplingTexels`).
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
        special: ['pow', 'lit', 'm4x4', 'm3x3', 'sincos3', 'texldl'],
        head: ['dcl_position v0', 'dcl_texcoord0 v1', 'dcl_color v2', 'dcl_position o0',
            'dcl_texcoord0 o1', 'dcl_color o2', 'dcl_2d s0', 'dcl_2d s1'],
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

// The level-of-detail bias, through texldl, whose level the bias moves where
// every derivative is zero, in each stage that has it.
PROFILES.ps_3_0_lod = { ...PROFILES.ps_3_0, name: 'ps_3_0', sampling: 'lod',
    special: ['texldl', 'texldl', 'pow'], flow: false, predicated: false };
PROFILES.vs_3_0_lod = { ...PROFILES.vs_3_0, name: 'vs_3_0', sampling: 'lod',
    special: ['texldl', 'texldl', 'm4x4'], flow: false, predicated: false };
// Border and mirror-once beside the modes WebGPU has, at coordinates in and
// out of [0, 1]: a pixel shader's second coordinate set and a vertex's inputs
// range over [-3, 3].
PROFILES.ps_3_0_address = { ...PROFILES.ps_3_0, name: 'ps_3_0', sampling: 'address',
    special: ['texldl', 'pow'], flow: false, predicated: false };
PROFILES.vs_3_0_address = { ...PROFILES.vs_3_0, name: 'vs_3_0', sampling: 'address',
    special: ['texldl', 'texldl', 'm4x4'], flow: false, predicated: false };

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
        case 'texldl': return [`texldl ${dest()}, ${source(false)}, s${Math.floor(next() * 2)}`];
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
 * @property {SamplerTexel[]} texels  Each sampler's texture, by sampler number.
 * @property {number[]} constants      The float constants as the GPU reads them, flat.
 * @property {number[]} ints
 * @property {number[]} bools
 * @property {Record<string, number[]>} inputs   By register name: v0, t1 ...
 * @property {Record<string, number[]>} expected  By output name, unwritten components NaN.
 * @property {Record<string, number>} written
 * @property {number | undefined} viewportRegister
 * @property {boolean} killed
 * @property {boolean} [unsettled]  A read lay where the GPU's rounding decides it
 *     (`sampledLevel`): not compared.
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
    const texels = p.sampling ? samplingTexels(seed, p.sampling) : samplerTexels(seed);
    let unsettled = false;
    const result = execute(tokens, {
        constants: { f: constants, i: ints, b: bools },
        inputs: { v: [inputs.v0, inputs.v1, inputs.v2], t: [inputs.t0, inputs.t1] },
        position: [0, 0],
        frontFacing: true,
        sample: (sampler, dimension, coord, mode)=>{
            const texel = texels[sampler % texels.length];
            if (!texel.levels && !texel.image)
            {
                return texel.values;
            }
            const read = texel.image ? addressedRead(texel, coord) : sampledLevel(texel, mode);
            unsettled ||= read === null;
            return read ?? [0, 0, 0, 0];
        },
        derivative: ()=>[0, 0, 0, 0],
    });
    const translated = translateShader(parseShader(tokens), {
        ones: texels.map(texel=>texel.ones),
        ...(p.sampling ? { sampling: texels.map(texel=>texel.variant) } : {}),
    });
    return {
        profile, seed, text, vertex: p.vertex,
        wgsl: translated.wgsl, entry: translated.entry, samplers: translated.samplers, texels,
        constants, ints, bools, inputs,
        expected: Object.fromEntries(Object.entries(result.outputs)
            .map(([name, values])=>[name, Array.from(values, Number)])),
        written: result.written, viewportRegister: translated.viewportRegister,
        killed: result.killed, unsettled,
        error: translated.error,
    };
}
