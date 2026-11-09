/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader Model 4 to WGSL.
 *
 * The translation keeps the shader's own register model rather than inventing
 * a nicer one: every register is a `vec4<u32>` of bit patterns, and each
 * instruction reinterprets what it reads as the type the instruction is
 * defined over. That is not a stylistic choice. A Shader Model 4 register is
 * untyped by definition -- a program moves an integer comparison result into a
 * register and multiplies it as a float three instructions later -- and a
 * translator that assigns registers a type has to guess, and guesses wrong on
 * exactly the shaders that do interesting things. Bit patterns are kept in an
 * unsigned register because a float register can lose them: a comparison
 * result is all ones, all ones is a NaN when read as a float, and a NaN
 * stored in a float is not required to keep its payload.
 *
 * The other decision worth stating is how a vertex shader meets a pixel
 * shader. Direct3D 10 and 11 hand register n of one to register n of the
 * other: the signatures name the registers, and a pair whose names disagree
 * at a register reads what the register carries, not the name
 * (test_shader_stage_input_output_matching). So a shader is translated to a
 * body that reads and writes numbered registers, and the entry point around
 * it -- the struct with the `@location` attributes -- is written when a pair
 * is linked, giving both halves the same numbering. The body is the shader's;
 * the interface is the pair's.
 *
 * What a first cut does not carry is listed rather than approximated: an
 * instruction this file has no translation for makes the whole shader
 * untranslatable, and the draw that would have used it is refused by name. A
 * plausible substitute would render a picture that is wrong in a way nothing
 * reports, which is the most expensive kind of wrong there is.
 */

import { DXGI_FORMAT } from './constants.js';
import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE, patchConstantsOf } from './dxbc.js';
import {
    CUSTOMDATA, MODIFIER, OPCODE, OPERAND, RESOURCE_DIMENSION, RETURN_TYPE, SAMPLER_MODE,
    SYNC_FLAG, decodeSm4,
} from './sm4.js';
import { DOUBLE_HELPERS } from './wgsl-doubles.js';

/** Every register file is thirty-two bit patterns, four to a register. */
const REG = 'vec4<u32>';

const COMPONENT = ['x', 'y', 'z', 'w'];

/** Where each kind of resource is bound within a stage's group. */
export const BINDING = Object.freeze({
    CONSTANT_BUFFER: 0,
    TEXTURE: 16,
    SAMPLER: 144,
    // A buffer bound as a shader resource is storage at its texture binding,
    // and the view over it -- format, first element, element count, element
    // size -- a uniform here.
    BUFFER_VIEW: 160,
    // What a shader writes through (Shader Model 5): a buffer or a storage
    // texture, the view over a buffer as above, and an append counter.
    UAV: 288,
    UAV_VIEW: 352,
    UAV_COUNTER: 416,
    // A vertex stream the vertex stage reads as words itself (`VertexPull`):
    // its buffer, and where each stream starts, its stride and its length.
    VERTEX_PULL: 480,
    VERTEX_PULL_PARAMS: 512,
    // The depth buffer a pixel shader that asks for early depth tests itself
    // against (`earlyDepth` in `linkProgram`).
    EARLY_DEPTH: 544,
});

/** The global flags a shader declares, in its declaration's control bits. */
const GLOBAL_FLAG = Object.freeze({ FORCE_EARLY_DEPTH_STENCIL: 0x4 });

/** WebGPU's `GPUShaderStage` bits, spelled out so nothing here reads a global. */
export const STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });

/** The texel formats a storage texture is written in, by DXGI format; the 32-bit
 *  single-channel ones are also read. */
export const STORAGE_TEXTURE_FORMAT = Object.freeze({
    [DXGI_FORMAT.R32_FLOAT]: 'r32float',
    [DXGI_FORMAT.R32_UINT]: 'r32uint',
    [DXGI_FORMAT.R32_SINT]: 'r32sint',
    [DXGI_FORMAT.R32G32_FLOAT]: 'rg32float',
    [DXGI_FORMAT.R32G32_UINT]: 'rg32uint',
    [DXGI_FORMAT.R32G32_SINT]: 'rg32sint',
    [DXGI_FORMAT.R32G32B32A32_FLOAT]: 'rgba32float',
    [DXGI_FORMAT.R32G32B32A32_UINT]: 'rgba32uint',
    [DXGI_FORMAT.R32G32B32A32_SINT]: 'rgba32sint',
    [DXGI_FORMAT.R16G16B16A16_FLOAT]: 'rgba16float',
    [DXGI_FORMAT.R16G16B16A16_UINT]: 'rgba16uint',
    [DXGI_FORMAT.R16G16B16A16_SINT]: 'rgba16sint',
    [DXGI_FORMAT.R8G8B8A8_UNORM]: 'rgba8unorm',
    [DXGI_FORMAT.R8G8B8A8_SNORM]: 'rgba8snorm',
    [DXGI_FORMAT.R8G8B8A8_UINT]: 'rgba8uint',
    [DXGI_FORMAT.R8G8B8A8_SINT]: 'rgba8sint',
    [DXGI_FORMAT.B8G8R8A8_UNORM]: 'bgra8unorm',
});

/**
 * The texture formats a shader writes through a typed view as packed words,
 * where WebGPU stores into none of them (or only with texture-formats-tier1):
 * the view is held as its texels' bytes in a buffer (`words`), each store
 * packs its value as the format keeps it, and a texel narrower than a word
 * is written in its part of one with two atomics, so neighbours stored at
 * once are kept. By the texture's WebGPU format: how many bytes a texel,
 * and the WGSL that packs a register's four components' bits (`v`, a
 * vec4<u32>) and unpacks a texel's bits (`b`) back into four, the
 * components a format lacks read as 0 and its alpha as 1, as Direct3D reads
 * them. Unsigned 11- and 10-bit floats round to nearest even, keep NaN and
 * infinity, and make zero of what is negative (Direct3D's 11.1 functional
 * specification, 3.2.4); unorm and snorm round to nearest; integers clamp.
 *
 * @type {Readonly<Record<string, { bytes: number, pack: string, unpack: string }>>}
 */
export const PACKED_TEXELS = (()=>{
    const f = 'bitcast<vec4<f32>>(v)';
    const one = '0x3f800000u';
    /** Floats' bits of four f32 expressions. @param {string[]} parts */
    const floats = parts=>`bitcast<vec4<u32>>(vec4<f32>(${parts.join(', ')}))`;
    /** @param {number} max @param {number} bits @param {number} count */
    const uints = (max, bits, count)=>[
        Array.from({ length: count }, (_, k)=>`(min(v.${'xyzw'[k]}, ${max}u) << ${k * bits}u)`)
            .join(' | '),
        `vec4<u32>(${Array.from({ length: 4 }, (_, k)=>(k < count
            ? `(b >> ${k * bits}u) & ${max}u` : k === 3 ? '1u' : '0u')).join(', ')})`];
    /** @param {number} bits @param {number} count */
    const sints = (bits, count)=>{
        const high = (1 << (bits - 1)) - 1;
        const mask = (1 << bits) - 1;
        const iv = 'bitcast<vec4<i32>>(v)';
        return [
            Array.from({ length: count }, (_, k)=>`((bitcast<u32>(clamp(${iv}.${'xyzw'[k]}, `
                + `${-high - 1}, ${high})) & ${mask}u) << ${k * bits}u)`).join(' | '),
            `bitcast<vec4<u32>>(vec4<i32>(${Array.from({ length: 4 }, (_, k)=>(k < count
                ? `extractBits(bitcast<i32>(b), ${k * bits}u, ${bits}u)` : k === 3 ? '1' : '0'))
                .join(', ')}))`];
    };
    /** @param {number} bytes @param {string[]} code  the packing and the unpacking */
    const entry = (bytes, [pack, unpack])=>({ bytes, pack, unpack });
    return Object.freeze({
        rg11b10ufloat: entry(4, [
            `packedUf(bitcast<u32>(${f}.x), 6u) | (packedUf(bitcast<u32>(${f}.y), 6u) << 11u)`
                + ` | (packedUf(bitcast<u32>(${f}.z), 5u) << 22u)`,
            `vec4<u32>(unpackedUf(b & 0x7ffu, 6u), unpackedUf((b >> 11u) & 0x7ffu, 6u),`
                + ` unpackedUf(b >> 22u, 5u), ${one})`]),
        rgb10a2unorm: entry(4, [
            `dot(vec4<u32>(round(clamp(select(${f}, vec4<f32>(0.0), ${f} != ${f}),`
                + ' vec4<f32>(0.0), vec4<f32>(1.0)) * vec4<f32>(1023.0, 1023.0, 1023.0, 3.0))),'
                + ' vec4<u32>(1u, 1024u, 1048576u, 1073741824u))',
            floats(['f32(b & 1023u) / 1023.0', 'f32((b >> 10u) & 1023u) / 1023.0',
                'f32((b >> 20u) & 1023u) / 1023.0', 'f32(b >> 30u) / 3.0'])]),
        rgb10a2uint: entry(4, [
            '(min(v.x, 1023u) | (min(v.y, 1023u) << 10u) | (min(v.z, 1023u) << 20u)'
                + ' | (min(v.w, 3u) << 30u))',
            'vec4<u32>(b & 1023u, (b >> 10u) & 1023u, (b >> 20u) & 1023u, b >> 30u)']),
        rg16float: entry(4, [`pack2x16float(${f}.xy)`,
            `vec4<u32>(bitcast<vec2<u32>>(unpack2x16float(b)), 0u, ${one})`]),
        rg16unorm: entry(4, [`pack2x16unorm(${f}.xy)`,
            `vec4<u32>(bitcast<vec2<u32>>(unpack2x16unorm(b)), 0u, ${one})`]),
        rg16snorm: entry(4, [`pack2x16snorm(${f}.xy)`,
            `vec4<u32>(bitcast<vec2<u32>>(unpack2x16snorm(b)), 0u, ${one})`]),
        rg16uint: entry(4, uints(0xffff, 16, 2)),
        rg16sint: entry(4, sints(16, 2)),
        r16float: entry(2, [`(pack2x16float(vec2<f32>(${f}.x, 0.0)) & 0xffffu)`,
            `vec4<u32>(bitcast<u32>(unpack2x16float(b).x), 0u, 0u, ${one})`]),
        r16unorm: entry(2, [`(pack2x16unorm(vec2<f32>(${f}.x, 0.0)) & 0xffffu)`,
            `vec4<u32>(bitcast<u32>(unpack2x16unorm(b).x), 0u, 0u, ${one})`]),
        r16snorm: entry(2, [`(pack2x16snorm(vec2<f32>(${f}.x, 0.0)) & 0xffffu)`,
            `vec4<u32>(bitcast<u32>(unpack2x16snorm(b).x), 0u, 0u, ${one})`]),
        r16uint: entry(2, uints(0xffff, 16, 1)),
        r16sint: entry(2, sints(16, 1)),
        rg8unorm: entry(2, [`(pack4x8unorm(vec4<f32>(${f}.xy, 0.0, 0.0)) & 0xffffu)`,
            `vec4<u32>(bitcast<vec2<u32>>(unpack4x8unorm(b).xy), 0u, ${one})`]),
        rg8snorm: entry(2, [`(pack4x8snorm(vec4<f32>(${f}.xy, 0.0, 0.0)) & 0xffffu)`,
            `vec4<u32>(bitcast<vec2<u32>>(unpack4x8snorm(b).xy), 0u, ${one})`]),
        rg8uint: entry(2, uints(0xff, 8, 2)),
        rg8sint: entry(2, sints(8, 2)),
        r8unorm: entry(1, [`(pack4x8unorm(vec4<f32>(${f}.x, 0.0, 0.0, 0.0)) & 0xffu)`,
            `vec4<u32>(bitcast<u32>(unpack4x8unorm(b).x), 0u, 0u, ${one})`]),
        r8snorm: entry(1, [`(pack4x8snorm(vec4<f32>(${f}.x, 0.0, 0.0, 0.0)) & 0xffu)`,
            `vec4<u32>(bitcast<u32>(unpack4x8snorm(b).x), 0u, 0u, ${one})`]),
        r8uint: entry(1, uints(0xff, 8, 1)),
        r8sint: entry(1, sints(8, 1)),
    });
})();

/**
 * An unsigned float of 5 exponent bits and `m` mantissa bits from a 32-bit
 * float's bits, and back (`PACKED_TEXELS`).
 */
const UNSIGNED_FLOAT_WGSL = [
    'fn packedUf(x: u32, m: u32) -> u32 {',
    '    let a: u32 = x & 0x7fffffffu;',
    '    let top: u32 = 31u << m;',
    '    if (a > 0x7f800000u) { return top | 1u; }',
    '    if ((x >> 31u) != 0u) { return 0u; }',
    '    if (a == 0x7f800000u) { return top; }',
    '    let drop: u32 = 23u - m;',
    '    let e: i32 = i32(a >> 23u) - 112i;',
    '    var v: u32 = 0u;',
    '    var r: u32 = 0u;',
    '    var half: u32 = 0u;',
    '    if (e >= 1i) {',
    '        v = (u32(min(e, 63i)) << m) | ((a & 0x7fffffu) >> drop);',
    '        r = a & ((1u << drop) - 1u);',
    '        half = 1u << (drop - 1u);',
    '    } else {',
    '        let shift: u32 = drop + u32(1i - e);',
    '        if (shift > 24u) { return 0u; }',
    '        let mm: u32 = (a & 0x7fffffu) | 0x800000u;',
    '        v = mm >> shift;',
    '        r = mm & ((1u << shift) - 1u);',
    '        half = 1u << (shift - 1u);',
    '    }',
    '    if (r > half || (r == half && (v & 1u) == 1u)) { v = v + 1u; }',
    '    return min(v, top);',
    '}',
    'fn unpackedUf(b: u32, m: u32) -> u32 {',
    '    let e: u32 = (b >> m) & 31u;',
    '    let f: u32 = b & ((1u << m) - 1u);',
    '    if (e == 31u) { return select(0x7f800000u, 0x7fc00000u, f != 0u); }',
    '    if (e != 0u) { return ((e + 112u) << 23u) | (f << (23u - m)); }',
    '    if (f == 0u) { return 0u; }',
    // A denormal, f * 2^(-14 - m), normalised by its top bit.
    '    let top: u32 = 31u - countLeadingZeros(f);',
    '    return ((top + 113u - m) << 23u) | ((f << (23u - top)) & 0x7fffffu);',
    '}',
].join('\n');

/**
 * A typed buffer element written from register bits, by the view's format:
 * the 32-bit-per-channel formats and the packed four-channel ones. The
 * dwords to write and how many; a format this cannot pack writes none.
 */
const STORE_ELEMENT = (()=>{
    const F = DXGI_FORMAT;
    /** @type {[number[], string, number][]} */
    const cases = [
        [[F.R32G32B32A32_FLOAT, F.R32G32B32A32_UINT, F.R32G32B32A32_SINT], 'v', 4],
        [[F.R32G32B32_FLOAT, F.R32G32B32_UINT, F.R32G32B32_SINT], 'v', 3],
        [[F.R32G32_FLOAT, F.R32G32_UINT, F.R32G32_SINT], 'v', 2],
        [[F.R32_FLOAT, F.R32_UINT, F.R32_SINT], 'v', 1],
        [[F.R8G8B8A8_UNORM], `${REG}(pack4x8unorm(bitcast<vec4<f32>>(v)), 0u, 0u, 0u)`, 1],
        [[F.R8G8B8A8_SNORM], `${REG}(pack4x8snorm(bitcast<vec4<f32>>(v)), 0u, 0u, 0u)`, 1],
        [[F.R8G8B8A8_UINT, F.R8G8B8A8_SINT], `${REG}(dot(v & ${REG}(0xffu), `
            + `${REG}(1u, 256u, 65536u, 16777216u)), 0u, 0u, 0u)`, 1],
        [[F.R16G16B16A16_FLOAT], `${REG}(pack2x16float(bitcast<vec4<f32>>(v).xy), `
            + 'pack2x16float(bitcast<vec4<f32>>(v).zw), 0u, 0u)', 2],
        [[F.R16G16B16A16_UINT, F.R16G16B16A16_SINT], `${REG}((v.x & 0xffffu) | (v.y << 16u), `
            + '(v.z & 0xffffu) | (v.w << 16u), 0u, 0u)', 2],
        [[F.R16G16_FLOAT], `${REG}(pack2x16float(bitcast<vec4<f32>>(v).xy), 0u, 0u, 0u)`, 1],
        [[F.R16G16_UINT, F.R16G16_SINT], `${REG}((v.x & 0xffffu) | (v.y << 16u), 0u, 0u, 0u)`,
            1],
    ];
    return [
        `fn storeElement(format: u32, v: ${REG}) -> vec4<u32> {`,
        '    switch (format) {',
        ...cases.map(([formats, value, count])=>`        case ${
            formats.map(format=>`${format}u`).join(', ')}: { let w = ${value}; `
            + `return vec4<u32>(w.x, w.y, w.z, ${count}u); }`),
        '        default: { return vec4<u32>(0u); }',
        '    }',
        '}',
        // The count rides in the fourth word where an element has fewer than
        // four; one of four words is told apart by its format.
        `fn storeElementCount(format: u32) -> u32 {`,
        '    switch (format) {',
        `        case ${[F.R32G32B32A32_FLOAT, F.R32G32B32A32_UINT, F.R32G32B32A32_SINT]
            .map(format=>`${format}u`).join(', ')}: { return 4u; }`,
        '        default: { return storeElement(format, vec4<u32>(0u)).w; }',
        '    }',
        '}',
    ];
})();

/**
 * How a buffer view's element of each format becomes register bits, given
 * the four dwords from the one it starts in (`w`) and, for an element
 * narrower than a dword, the bit it starts at (`s`). A float format answers
 * float bits and an integer one integers; components the format lacks read
 * as zero, and its alpha as one.
 */
function bufferElement(){
    const F = DXGI_FORMAT;
    const ONE = '0x3f800000u';
    /** @param {string} value a vec4<f32> */
    const floats = value=>`bitcast<${REG}>(${value})`;
    /** @param {string} value an i32 */
    const bits = value=>`bitcast<u32>(${value})`;
    /** @param {string} value a u32 holding a 16-bit integer */
    const signed16 = value=>bits(`bitcast<i32>(${value} << 16u) >> 16u`);
    /** @param {string} value a u32 holding an 8-bit integer */
    const signed8 = value=>bits(`bitcast<i32>(${value} << 24u) >> 24u`);
    const half = '((w.x >> s) & 0xffffu)';
    const pair = half;
    const byte = '((w.x >> s) & 0xffu)';
    /** @type {[number[], string][]} */
    const cases = [
        [[F.R32G32B32A32_FLOAT, F.R32G32B32A32_UINT, F.R32G32B32A32_SINT], 'w'],
        [[F.R32G32B32_FLOAT], `${REG}(w.xyz, ${ONE})`],
        [[F.R32G32B32_UINT, F.R32G32B32_SINT], `${REG}(w.xyz, 1u)`],
        [[F.R32G32_FLOAT], `${REG}(w.xy, 0u, ${ONE})`],
        [[F.R32G32_UINT, F.R32G32_SINT], `${REG}(w.xy, 0u, 1u)`],
        [[F.R32_FLOAT], `${REG}(w.x, 0u, 0u, ${ONE})`],
        [[F.R32_UINT, F.R32_SINT], `${REG}(w.x, 0u, 0u, 1u)`],
        [[F.R16G16B16A16_FLOAT],
            floats('vec4<f32>(unpack2x16float(w.x), unpack2x16float(w.y))')],
        [[F.R16G16B16A16_UNORM], floats('vec4<f32>(unpack2x16unorm(w.x), unpack2x16unorm(w.y))')],
        [[F.R16G16B16A16_SNORM], floats('vec4<f32>(unpack2x16snorm(w.x), unpack2x16snorm(w.y))')],
        [[F.R16G16B16A16_UINT], `${REG}(w.x & 0xffffu, w.x >> 16u, w.y & 0xffffu, w.y >> 16u)`],
        [[F.R16G16B16A16_SINT], `${REG}(${signed16('w.x')}, ${bits('bitcast<i32>(w.x) >> 16u')},`
            + ` ${signed16('w.y')}, ${bits('bitcast<i32>(w.y) >> 16u')})`],
        [[F.R16G16_FLOAT], floats('vec4<f32>(unpack2x16float(w.x), 0.0, 1.0)')],
        [[F.R16G16_UNORM], floats('vec4<f32>(unpack2x16unorm(w.x), 0.0, 1.0)')],
        [[F.R16G16_SNORM], floats('vec4<f32>(unpack2x16snorm(w.x), 0.0, 1.0)')],
        [[F.R16G16_UINT], `${REG}(w.x & 0xffffu, w.x >> 16u, 0u, 1u)`],
        [[F.R16G16_SINT],
            `${REG}(${signed16('w.x')}, ${bits('bitcast<i32>(w.x) >> 16u')}, 0u, 1u)`],
        [[F.R16_FLOAT], floats(`vec4<f32>(unpack2x16float(${half}).x, 0.0, 0.0, 1.0)`)],
        [[F.R16_UNORM], floats(`vec4<f32>(unpack2x16unorm(${half}).x, 0.0, 0.0, 1.0)`)],
        [[F.R16_SNORM], floats(`vec4<f32>(unpack2x16snorm(${half}).x, 0.0, 0.0, 1.0)`)],
        [[F.R16_UINT], `${REG}(${half}, 0u, 0u, 1u)`],
        [[F.R16_SINT], `${REG}(${signed16(half)}, 0u, 0u, 1u)`],
        [[F.R8G8B8A8_UNORM], floats('unpack4x8unorm(w.x)')],
        [[F.B8G8R8A8_UNORM], floats('unpack4x8unorm(w.x).zyxw')],
        [[F.R8G8B8A8_SNORM], floats('unpack4x8snorm(w.x)')],
        [[F.R8G8B8A8_UINT],
            `(${REG}(w.x) >> ${REG}(0u, 8u, 16u, 24u)) & ${REG}(0xffu)`],
        [[F.R8G8B8A8_SINT], `bitcast<${REG}>(bitcast<vec4<i32>>(${REG}(w.x)`
            + ` << ${REG}(24u, 16u, 8u, 0u)) >> ${REG}(24u))`],
        [[F.R8G8_UNORM], floats(`vec4<f32>(unpack4x8unorm(${pair}).xy, 0.0, 1.0)`)],
        [[F.R8G8_SNORM], floats(`vec4<f32>(unpack4x8snorm(${pair}).xy, 0.0, 1.0)`)],
        [[F.R8G8_UINT], `${REG}(${pair} & 0xffu, ${pair} >> 8u, 0u, 1u)`],
        [[F.R8G8_SINT], `${REG}(${signed8(`(${pair} & 0xffu)`)}, ${signed8(`(${pair} >> 8u)`)},`
            + ' 0u, 1u)'],
        [[F.R8_UNORM], floats(`vec4<f32>(unpack4x8unorm(${byte}).x, 0.0, 0.0, 1.0)`)],
        [[F.R8_SNORM], floats(`vec4<f32>(unpack4x8snorm(${byte}).x, 0.0, 0.0, 1.0)`)],
        [[F.R8_UINT], `${REG}(${byte}, 0u, 0u, 1u)`],
        [[F.R8_SINT], `${REG}(${signed8(byte)}, 0u, 0u, 1u)`],
        [[F.R10G10B10A2_UNORM], floats(`vec4<f32>((${REG}(w.x) >> ${REG}(0u, 10u, 20u, 30u))`
            + ` & ${REG}(0x3ffu, 0x3ffu, 0x3ffu, 3u)) / vec4<f32>(1023.0, 1023.0, 1023.0, 3.0)`)],
        [[F.R10G10B10A2_UINT], `(${REG}(w.x) >> ${REG}(0u, 10u, 20u, 30u))`
            + ` & ${REG}(0x3ffu, 0x3ffu, 0x3ffu, 3u)`],
    ];
    return {
        formats: new Set(cases.flatMap(([formats])=>formats)),
        text: [
            `fn bufferElement(format: u32, w: ${REG}, s: u32) -> ${REG} {`,
            '    switch (format) {',
            ...cases.map(([formats, value])=>`        case ${
                formats.map(format=>`${format}u`).join(', ')}: { return ${value}; }`),
            `        default: { return ${REG}(0u); }`,
            '    }',
            '}',
        ],
    };
}

const BUFFER_ELEMENT = bufferElement();

/**
 * The formats a buffer view can be read in.
 *
 * @type {ReadonlySet<number>}
 */
export const BUFFER_VIEW_FORMATS = BUFFER_ELEMENT.formats;

/**
 * Functions a translation may call, written into the module of a stage that
 * uses one, after the ones it calls. WGSL has no high half of a 32x32
 * multiply, so it is assembled from sixteen-bit halves, whose products and
 * partial sums all fit in 32 bits; the signed high half is the unsigned one
 * less each operand wherever the other is negative, modulo 2^32.
 *
 * @type {Readonly<Record<string, { needs: string[], text: string[] }>>}
 */
export const HELPERS = Object.freeze({
    ...DOUBLE_HELPERS,
    unsignedFloat: { needs: [], text: UNSIGNED_FLOAT_WGSL.split('\n') },
    // How fast a cube's face coordinates move, d(minor / major), for a
    // coordinate c moving by d; the major axis is the longest, x before y
    // before z on a tie, as the face selection takes it.
    cubeFaceSlope: {
        needs: [],
        text: [
            'fn cubeFaceSlope(c: vec3<f32>, d: vec3<f32>) -> vec2<f32> {',
            '    let a = abs(c);',
            '    var major = c.z; var moved = d.z; var minor = c.xy; var slid = d.xy;',
            '    if (a.x >= a.y && a.x >= a.z) {'
                + ' major = c.x; moved = d.x; minor = c.yz; slid = d.yz; }',
            '    else if (a.y >= a.z) { major = c.y; moved = d.y; minor = c.xz; slid = d.xz; }',
            '    return (slid * major - minor * moved) / (major * major);',
            '}',
        ],
    },
    // Direct3D's standard sample positions, in sixteenths of a pixel from
    // its centre; an index past the count is at the centre.
    samplePosition: {
        needs: [],
        text: [
            'fn samplePosition(count: u32, index: u32) -> vec2<f32> {',
            '    if (index >= count) { return vec2<f32>(0.0); }',
            '    var two = array<vec2<i32>, 2>(vec2<i32>(4, 4), vec2<i32>(-4, -4));',
            '    var four = array<vec2<i32>, 4>(vec2<i32>(-2, -6), vec2<i32>(6, -2),'
                + ' vec2<i32>(-6, 2), vec2<i32>(2, 6));',
            '    var eight = array<vec2<i32>, 8>(vec2<i32>(1, -3), vec2<i32>(-1, 3),'
                + ' vec2<i32>(5, 1), vec2<i32>(-3, -5), vec2<i32>(-5, 5), vec2<i32>(-7, -1),'
                + ' vec2<i32>(3, 7), vec2<i32>(7, -7));',
            '    var sixteen = array<vec2<i32>, 16>(vec2<i32>(1, 1), vec2<i32>(-1, -3),'
                + ' vec2<i32>(-3, 2), vec2<i32>(4, -1), vec2<i32>(-5, -2), vec2<i32>(2, 5),'
                + ' vec2<i32>(5, 3), vec2<i32>(3, -5), vec2<i32>(-2, 6), vec2<i32>(0, -7),'
                + ' vec2<i32>(-4, -6), vec2<i32>(-6, 4), vec2<i32>(-8, 0), vec2<i32>(7, -4),'
                + ' vec2<i32>(6, 7), vec2<i32>(-7, -8));',
            '    var at = vec2<i32>(0, 0);',
            '    if (count == 2u) { at = two[index]; }',
            '    else if (count == 4u) { at = four[index]; }',
            '    else if (count == 8u) { at = eight[index]; }',
            '    else if (count == 16u) { at = sixteen[index]; }',
            '    return vec2<f32>(at) / 16.0;',
            '}',
        ],
    },
    umulhi: {
        needs: [],
        text: [
            `fn umulhi(a: ${REG}, b: ${REG}) -> ${REG} {`,
            `    let al = a & ${REG}(0xffffu);`,
            `    let ah = a >> ${REG}(16u);`,
            `    let bl = b & ${REG}(0xffffu);`,
            `    let bh = b >> ${REG}(16u);`,
            '    let middle1 = ah * bl;',
            '    let middle2 = al * bh;',
            `    let carry = (((al * bl) >> ${REG}(16u)) + (middle1 & ${REG}(0xffffu))`
                + ` + (middle2 & ${REG}(0xffffu))) >> ${REG}(16u);`,
            `    return ah * bh + (middle1 >> ${REG}(16u)) + (middle2 >> ${REG}(16u)) + carry;`,
            '}',
        ],
    },
    bufferElement: { needs: [], text: BUFFER_ELEMENT.text },
    storeElement: { needs: [], text: STORE_ELEMENT },

    imulhi: {
        needs: ['umulhi'],
        text: [
            `fn imulhi(a: ${REG}, b: ${REG}) -> ${REG} {`,
            `    let aNegative = (a >> ${REG}(31u)) != ${REG}(0u);`,
            `    let bNegative = (b >> ${REG}(31u)) != ${REG}(0u);`,
            `    return umulhi(a, b) - select(${REG}(0u), b, aNegative)`
                + ` - select(${REG}(0u), a, bNegative);`,
            '}',
        ],
    },
});

/**
 * @typedef {Object} ConstantBufferDecl
 * @property {number} slot
 * @property {number} size   In vec4 registers.
 * @property {boolean} [indexed]  Read at a register the shader computes: such a
 *     read reaches as far as the bound buffer, past the declared size.
 */

/**
 * @typedef {Object} TextureDecl
 * @property {number} slot
 * @property {number} dimension    A RESOURCE_DIMENSION.
 * @property {number} returnType   A RETURN_TYPE.
 * @property {boolean} comparison  Read by a compare-sample, so declared as depth.
 * @property {boolean} [multisampled]  A TEXTURE2DMS bound to a texture of several samples.
 * @property {boolean} [depth]  A float texture bound to a depth buffer: declared as a depth
 *     texture, each read of it one float, made (d, 0, 0, 1) as Direct3D reads such a view.
 * @property {boolean} [stencil]  An integer texture bound to a depth buffer's stencil, which
 *     WebGPU reads in red and Direct3D's X24_TYPELESS_G8_UINT and X32_TYPELESS_G8X24_UINT in
 *     green: each read made (0, s, 0, 1).
 * @property {'raw' | 'structured'} [structure]  A buffer read by bytes or by structures.
 * @property {number} [stride]    Bytes a structure.
 */

/**
 * @typedef {Object} SamplerDecl
 * @property {number} slot
 * @property {boolean} comparison
 * @property {boolean} [nonFiltering]  Read with a depth texture, which WebGPU filters only
 *     when it compares it: declared non-filtering and bound as a point sampler.
 */

/**
 * @typedef {Object} TranslatedShader
 * @property {number} kind                       A SHADER_KIND.
 * @property {import('./dxbc.js').SignatureElement[]} inputs
 * @property {import('./dxbc.js').SignatureElement[]} outputs
 * @property {ConstantBufferDecl[]} constantBuffers
 * @property {TextureDecl[]} textures
 * @property {SamplerDecl[]} samplers
 * @property {number} temps
 * @property {{ index: number, size: number }[]} indexableTemps
 * @property {number[][]} immediateConstants       The icb, one vec4 per row.
 * @property {(string | { ret: true })[]} body     Statements; `ret` is filled at link.
 * @property {number} inputRegisters               How many `v` registers the body reads.
 * @property {number} outputRegisters              How many `o` registers the body writes.
 * @property {boolean} writesDepth
 * @property {boolean} [writesMask]   A pixel shader writes its coverage (`oMask`).
 * @property {boolean} [readsMask]    A pixel shader reads its coverage (`vCoverage`).
 * @property {boolean} [earlyDepth]  The shader asks for the depth and stencil
 *     tests before it runs (`[earlydepthstencil]`), so that what it writes
 *     through views is not written by a fragment the tests reject.
 * @property {Record<number, number>} [interpolation]  A pixel shader's interpolation mode
 *     by input register, as its declarations give it (D3D10_SB_INTERPOLATION_MODE).
 * @property {boolean} [rasterizerSamples]  Whether the body reads the rasterizer's sample
 *     count (`sampleinfo`, `samplepos` of the rasterizer), `rasterSamples` at link.
 * @property {number[]} [unboundInterfaces]  Interface slots a call reached with no class
 *     instance bound: the call does nothing, which the caller says.
 * @property {string[]} unsupported                Opcode names with no translation.
 * @property {string[]} helpers                    HELPERS the body calls, callees first.
 * @property {number[]} threadGroup                A compute shader's group, x by y by z.
 * @property {UavDecl[]} uavs                      What the shader writes through.
 * @property {SharedDecl[]} sharedMemory           Its thread-group shared memory.
 */

/**
 * @typedef {Object} UavDecl
 * @property {number} slot
 * @property {'typed' | 'raw' | 'structured'} structure
 * @property {number} dimension   A RESOURCE_DIMENSION, for a typed view.
 * @property {number} returnType  A RETURN_TYPE, for a typed view.
 * @property {number} stride      Bytes a structure, for a structured view.
 * @property {boolean} counter    Whether it has an append counter.
 * @property {boolean} atomic     Whether the shader adds, swaps or compares in it.
 * @property {boolean} loaded     Whether the shader reads it as well as writes it.
 * @property {string} [format]    A typed texture's storage format (`uavFormats`).
 * @property {boolean} [words]    A typed texture view held as its texels' words
 *     in a buffer, for the atomics made on it or a format packed there.
 * @property {string} [packed]    The format its texels are packed in (`PACKED_TEXELS`).
 * @property {Set<string>} [atomicOps]  The atomic operations made on it.
 * @property {boolean} [counted]  Whether its append counter is used.
 */

/**
 * @typedef {Object} SharedDecl
 * @property {number} slot
 * @property {number} words       Its size, in dwords.
 * @property {number} stride      Bytes a structure, or 0 for raw memory.
 * @property {boolean} atomic
 * @property {Set<string>} [atomicOps]
 */

/**
 * The pixel stage of a draw with no pixel shader bound. Direct3D still
 * rasterises such a draw -- a depth pre-pass or a shadow map is drawn this way
 * -- and writes depth and stencil, but no render target; this stage reads
 * nothing and writes nothing, so linked with any vertex shader its fragment
 * entry point returns at once (with the depth when the link applies a bias)
 * and every target's write mask is zero.
 *
 * @type {Readonly<TranslatedShader>}
 */
export const NO_PIXEL_SHADER = Object.freeze({
    kind: SHADER_KIND.PIXEL,
    inputs: [],
    outputs: [],
    constantBuffers: [],
    textures: [],
    samplers: [],
    temps: 0,
    indexableTemps: [],
    immediateConstants: [],
    // A pixel stage the link may still give outputs (a depth bias it applies).
    body: [Object.freeze({ ret: /** @type {true} */ (true) })],
    inputRegisters: 0,
    outputRegisters: 0,
    writesDepth: false,
    unsupported: [],
    helpers: [],
    threadGroup: [1, 1, 1],
    uavs: [],
    sharedMemory: [],
});

/** @param {number} mask @returns {string} the components a mask names */
function maskComponents(mask){
    return COMPONENT.filter((_, index)=>(mask & (1 << index)) !== 0).join('');
}

/** @param {readonly number[]} swizzle */
function swizzleText(swizzle){
    return swizzle.map(index=>COMPONENT[index]).join('');
}

/** @param {number} dword @returns {string} a WGSL u32 literal */
const u32Literal = dword=>`${dword >>> 0}u`;
/** A float exactly, as WGSL spells one: its bits. @param {number} value */
const floatLiteral = value=>
    `bitcast<f32>(${new Uint32Array(new Float32Array([value]).buffer)[0]}u)`;

/**
 * Translates one shader's instruction stream. The entry point is not written
 * here -- see `linkProgram` -- because its `@location` numbering belongs to the
 * pair, not to the shader.
 *
 * A texture the shader declares as two-dimensional and multisampled is read
 * as a one-sample texture -- its sample 0 -- unless `multisampled` names its
 * slot: the view bound there is of a texture with more samples than one, and
 * WebGPU binds that only as a multisampled texture, read by sample.
 *
 * A float texture whose slot `depth` names is bound to a depth buffer -- a
 * shadow map read as R32_FLOAT, a depth read back as R24_UNORM_X8 -- which
 * WebGPU binds only as a depth texture: it is declared as one, and each read
 * of it answers (d, 0, 0, 1), as Direct3D answers a view of one channel. A
 * depth texture has no sample with a bias or gradients: those read at the
 * level the plain sample would, or the top one.
 *
 * A typed view a shader writes a texture through is a storage texture of
 * the bound view's format, which `uavFormats` names by slot.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * A hull shader is translated a phase at a time (`hull.js`): `tokens` is the
 * stream of one phase, its declarations before it, and `outputName` the array
 * its outputs are written into.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * `interfaces` is the class instance bound at each interface slot: the
 * function table (ft#) of its class for that pointer, and the four words its
 * `this` reads. A slot with none makes a call through it do nothing, and is
 * listed in `unboundInterfaces`.
 *
 * `samplerBias` is the MipLODBias of the sampler bound at each slot that has
 * one: WebGPU's samplers have none, so the shader adds it to every level it
 * samples by. `constantSizes`: the registers a constant buffer read at a
 * computed register has bound at its slot, where more than it declares.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * @param {{ multisampled?: readonly number[], depth?: readonly number[],
 *     stencil?: readonly number[], uavFormats?: Readonly<Record<number, string>>,
 *     tokens?: Uint32Array,
 *     outputName?: string, samplerBias?: Readonly<Record<number, number>>,
 *     constantSizes?: Readonly<Record<number, number>>,
 *     interfaces?: readonly ({ table: number, data: readonly number[] } | null)[] }} [options]
 * @returns {TranslatedShader}
 */
export function translateShader(container, options = {}){
    const program = /** @type {import('./dxbc.js').ShaderProgram} */ (container.shader);
    const instructions = decodeSm4(options.tokens ?? program.tokens);
    const isPixel = program.kind === SHADER_KIND.PIXEL;
    const isCompute = program.kind === SHADER_KIND.COMPUTE;
    // A hull shader's phases write their outputs as an array a register may
    // be indexed into (a fork phase's instances write o[vForkInstanceID + n]),
    // the one its linker names (`hull.js`).
    const isHull = program.kind === SHADER_KIND.HULL;
    const outputArray = options.outputName ?? 'o';
    // A geometry shader reads its inputs a vertex at a time, v[vertex][register],
    // out of the primitive its linker assembles (`vgs`, `linkGeometry`).
    const isGeometry = program.kind === SHADER_KIND.GEOMETRY;

    /** @type {TranslatedShader} */
    const result = {
        kind: program.kind,
        inputs: container.inputs,
        outputs: container.outputs,
        constantBuffers: [],
        textures: [],
        samplers: [],
        temps: 0,
        indexableTemps: [],
        immediateConstants: [],
        body: [],
        inputRegisters: 0,
        outputRegisters: 0,
        writesDepth: false,
        unsupported: [],
        helpers: [],
        threadGroup: [1, 1, 1],
        uavs: [],
        sharedMemory: [],
    };
    // WebGPU has no atomics on a storage texture: a typed texture view an
    // atomic touches is bound as the words of its texels in a buffer, rows
    // padded as a copy lays them out, and every access to it, plain loads
    // and stores too, goes through them (`words`, the device's word mirror).
    const atomicViews = new Set(instructions.filter(instruction=>
        instruction.opcode >= OPCODE.ATOMIC_AND && instruction.opcode <= OPCODE.IMM_ATOMIC_UMIN
        && instruction.opcode !== OPCODE.IMM_ATOMIC_ALLOC
        && instruction.opcode !== OPCODE.IMM_ATOMIC_CONSUME)
        .map(instruction=>instruction.operands[instruction.opcode >= OPCODE.IMM_ATOMIC_IADD
            ? 1 : 0])
        .filter(operand=>operand?.type === OPERAND.UNORDERED_ACCESS_VIEW)
        .map(operand=>operand.indices[0]?.value));
    let nextTemp = 0;
    let depth = 1;
    // Not `t`: that is a texture's name, and a `let` of the same name would
    // hide the texture from every instruction after it in the block.
    const held = ()=>`held${nextTemp++}`;

    /** @param {string} line */
    const emit = line=>{
        result.body.push(`${'    '.repeat(depth)}${line}`);
    };

    /** @param {number} slot */
    const textureOf = slot=>result.textures.find(texture=>texture.slot === slot) ?? null;

    /**
     * The input and output registers a shader indexes into, by range
     * (`dcl_index_range`): an input range is read out of an array of its
     * registers, `vr<first>`, an output range written through a switch.
     *
     * @type {{ type: number, first: number, count: number }[]}
     */
    const indexRanges = [];
    /** @param {number} type @param {number} register */
    const rangeOf = (type, register)=>indexRanges.find(range=>range.type === type
        && register >= range.first && register < range.first + range.count) ?? null;
    /**
     * A relative register's place in the range it falls in.
     *
     * @param {import('./sm4.js').Operand} operand @param {{ first: number }} range
     */
    const placeIn = (operand, range)=>{
        const index = operand.indices[0];
        const relative = `${untyped(/** @type {any} */ (index.relative))}`
            + `.${COMPONENT[/** @type {any} */ (index.relative).swizzle[0]]}`;
        return index.value === range.first ? relative
            : `(${u32Literal(index.value - range.first)} + ${relative})`;
    };

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {number} at  Which of the operand's indices.
     * @returns {string} an index expression, resolving a relative part
     */
    const indexExpression = (operand, at)=>{
        const index = operand.indices[at];
        if (!index)
        {
            return '0u';
        }
        if (!index.relative)
        {
            return u32Literal(index.value);
        }
        const relative = `${untyped(index.relative)}.${COMPONENT[index.relative.swizzle[0]]}`;
        return index.value === 0 ? relative : `(${u32Literal(index.value)} + ${relative})`;
    };

    /**
     * The bit patterns an operand names, swizzled, before any type is put on
     * them.
     *
     * @param {import('./sm4.js').Operand} operand
     * @returns {string}
     */
    const untyped = operand=>{
        const swizzle = swizzleText(operand.swizzle);
        switch (operand.type)
        {
            case OPERAND.TEMP:
                return `r${operand.indices[0].value}.${swizzle}`;
            case OPERAND.INPUT:
                if (isGeometry && operand.indices.length > 1)
                {
                    return `vgs[${indexExpression(operand, 0)}][${indexExpression(operand, 1)}]`
                        + `.${swizzle}`;
                }
                // A hull shader's control point phase names its input points
                // as v[point][register] (test_clip_distance).
                if (isHull && operand.indices.length > 1)
                {
                    return `vicp[${indexExpression(operand, 0)}][${indexExpression(operand, 1)}]`
                        + `.${swizzle}`;
                }
                if (operand.indices[0].relative)
                {
                    const range = rangeOf(OPERAND.INPUT, operand.indices[0].value);
                    if (range)
                    {
                        return `vr${range.first}[${placeIn(operand, range)}].${swizzle}`;
                    }
                    result.unsupported.push('an input register indexed outside a declared range');
                }
                return `v${operand.indices[0].value}.${swizzle}`;
            case OPERAND.OUTPUT:
                return isHull ? `${outputArray}[${indexExpression(operand, 0)}].${swizzle}`
                    : `o${operand.indices[0].value}.${swizzle}`;
            case OPERAND.INPUT_CONTROL_POINT:
                return `vicp[${indexExpression(operand, 0)}][${indexExpression(operand, 1)}]`
                    + `.${swizzle}`;
            case OPERAND.OUTPUT_CONTROL_POINT:
                return `vocp[${indexExpression(operand, 0)}][${indexExpression(operand, 1)}]`
                    + `.${swizzle}`;
            case OPERAND.INPUT_PATCH_CONSTANT:
                return `vpc[${indexExpression(operand, 0)}].${swizzle}`;
            case OPERAND.OUTPUT_CONTROL_POINT_ID:
                return `${REG}(hsControlPoint).${swizzle}`;
            case OPERAND.INPUT_FORK_INSTANCE_ID:
            case OPERAND.INPUT_JOIN_INSTANCE_ID:
                return `${REG}(hsInstance).${swizzle}`;
            case OPERAND.INPUT_PRIMITIVE_ID:
                if (isHull || isGeometry || program.kind === SHADER_KIND.DOMAIN)
                {
                    return `${REG}(primitiveId).${swizzle}`;
                }
                result.unsupported.push(`operand type ${operand.type}`);
                return `${REG}(0u)`;
            case OPERAND.INPUT_DOMAIN_POINT:
                return `dsDomain.${swizzle}`;
            case OPERAND.INPUT_COVERAGE_MASK:
                result.readsMask = true;
                return `${REG}(vCoverage).${swizzle}`;
            case OPERAND.INPUT_GS_INSTANCE_ID:
                return `${REG}(gsInstance).${swizzle}`;
            case OPERAND.INDEXABLE_TEMP:
                return `x${operand.indices[0].value}[${indexExpression(operand, 1)}].${swizzle}`;
            case OPERAND.THIS_POINTER:
                return `${thisPointer(operand)}.${swizzle}`;
            case OPERAND.CONSTANT_BUFFER:
                if (operand.indices[1]?.relative)
                {
                    const declared = result.constantBuffers.find(buffer=>
                        buffer.slot === operand.indices[0].value);
                    if (declared)
                    {
                        declared.indexed = true;
                    }
                }
                return `cb${operand.indices[0].value}[${indexExpression(operand, 1)}].${swizzle}`;
            case OPERAND.IMMEDIATE_CONSTANT_BUFFER:
                return `icb[${indexExpression(operand, 0)}].${swizzle}`;
            case OPERAND.INPUT_THREAD_ID:
                return `csThread.${swizzle}`;
            case OPERAND.INPUT_THREAD_GROUP_ID:
                return `csGroup.${swizzle}`;
            case OPERAND.INPUT_THREAD_ID_IN_GROUP:
                return `csLocal.${swizzle}`;
            case OPERAND.INPUT_THREAD_ID_IN_GROUP_FLATTENED:
                return `${REG}(csFlat).${swizzle}`;
            case OPERAND.IMMEDIATE64:
                // A double's dwords, low first; one double is both halves.
                return `${REG}(${(operand.immediate.length === 2
                    ? [...operand.immediate, ...operand.immediate] : operand.immediate)
                    .map(u32Literal).join(', ')})`;
            case OPERAND.IMMEDIATE32:
                if (operand.immediate.length === 1)
                {
                    return `${REG}(${u32Literal(operand.immediate[0])})`;
                }
                return `${REG}(${operand.immediate.map(u32Literal).join(', ')})`;
            default:
                result.unsupported.push(`operand type ${operand.type}`);
                return `${REG}(0u)`;
        }
    };

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {'f' | 'i' | 'u'} type
     * @returns {string} the operand read as that type, with its modifier applied
     */
    const typed = (operand, type)=>{
        const bits = untyped(operand);
        let value = type === 'u' ? bits : `bitcast<vec4<${type}32>>(${bits})`;
        if (operand.modifier === MODIFIER.ABS || operand.modifier === MODIFIER.ABSNEG)
        {
            value = `abs(${value})`;
        }
        if (operand.modifier === MODIFIER.NEG || operand.modifier === MODIFIER.ABSNEG)
        {
            // WGSL negates no unsigned value: an unsigned read negated is
            // its two's complement, zero less it.
            value = type === 'u' ? `(${REG}(0u) - ${value})` : `(-${value})`;
        }
        return value;
    };

    /** @param {import('./sm4.js').Operand} operand */
    const modifiedRead = operand=>(operand.modifier ?? MODIFIER.NONE) !== MODIFIER.NONE;
    /** @param {import('./sm4.js').Operand} operand */
    const f = operand=>typed(operand, 'f');
    /**
     * A source a move copies: its bits, or the float it is with its modifier.
     *
     * @param {import('./sm4.js').Operand} operand
     */
    const moved = operand=>(modifiedRead(operand) ? fromFloat(f(operand), false) : u(operand));
    /** @param {import('./sm4.js').Operand} operand */
    const i = operand=>typed(operand, 'i');
    /** @param {import('./sm4.js').Operand} operand */
    const u = operand=>typed(operand, 'u');

    /**
     * Stores four bit patterns into a destination through its write mask. The
     * value is evaluated once into a `let`, because a swap like
     * `mov r0.xy, r0.yx` reads what it is about to overwrite.
     *
     * @param {import('./sm4.js').Operand} dest
     * @param {string} value  A `vec4<u32>` expression.
     */
    const store = (dest, value)=>{
        if (dest.type === OPERAND.NULL)
        {
            return;
        }
        // A depth written with a promise of its direction is a depth written.
        if (dest.type === OPERAND.OUTPUT_DEPTH || dest.type === OPERAND.OUTPUT_DEPTH_GREATER_EQUAL
            || dest.type === OPERAND.OUTPUT_DEPTH_LESS_EQUAL)
        {
            result.writesDepth = true;
            emit(`oDepth = bitcast<f32>((${value}).x);`);
            return;
        }
        if (dest.type === OPERAND.OUTPUT_COVERAGE_MASK)
        {
            result.writesMask = true;
            emit(`oMask = (${value}).x;`);
            return;
        }
        const range = dest.type === OPERAND.OUTPUT && !isHull && dest.indices[0]?.relative
            ? rangeOf(OPERAND.OUTPUT, dest.indices[0].value) : null;
        if (range)
        {
            // Each register of the range a switch case of its own: WGSL
            // names the outputs one by one.
            const written = held();
            emit(`let ${written} = ${value};`);
            emit(`switch (${placeIn(dest, range)}) {`);
            depth++;
            for (let place = 0; place < range.count; place++)
            {
                emit(`case ${place}u: {`);
                depth++;
                store({ ...dest, indices: [{ value: range.first + place, relative: null }] },
                    written);
                depth--;
                emit('}');
            }
            emit('default: {}');
            depth--;
            emit('}');
            return;
        }
        const target = untyped({ ...dest, swizzle: [0, 1, 2, 3] }).replace(/\.xyzw$/, '');
        if (dest.type === OPERAND.OUTPUT)
        {
            result.outputRegisters = Math.max(result.outputRegisters, dest.indices[0].value + 1);
        }
        if (dest.mask === 0xf)
        {
            emit(`${target} = ${value};`);
            return;
        }
        const temp = held();
        emit(`let ${temp} = ${value};`);
        for (const component of maskComponents(dest.mask))
        {
            emit(`${target}.${component} = ${temp}.${component};`);
        }
    };

    /** @param {string} value a `vec4<f32>` expression @param {boolean} saturate */
    const fromFloat = (value, saturate)=>`bitcast<${REG}>(${saturate
        ? `clamp(${value}, vec4<f32>(0.0), vec4<f32>(1.0))`
        : value})`;
    /** @param {string} value a `vec4<i32>` expression */
    const fromInt = value=>`bitcast<${REG}>(${value})`;
    /** @param {string} condition a `vec4<bool>` expression */
    const fromBool = condition=>`select(${REG}(0u), ${REG}(0xffffffffu), ${condition})`;
    /** @param {string} scalar an `f32` expression */
    const splat = scalar=>`vec4<f32>(${scalar})`;

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {number} count
     * @returns {string} the first `count` components of a float read
     */
    const floats = (operand, count)=>`${f(operand)}.${'xyzw'.slice(0, count)}`;

    /**
     * The coordinate a texture instruction samples at, sized to the texture,
     * and the array index when it has one. A one-dimensional texture is kept
     * as a two-dimensional one a row high (see `textureType`), and read at the
     * middle of that row, or at row zero by an integer address.
     *
     * @param {TextureDecl} texture
     * @param {string} coordinate a vec4<f32> or vec4<i32> expression
     * @param {boolean} [integer]  An address rather than a coordinate.
     * @returns {{ coordinate: string, layer: string | null, width: number,
     *             row: boolean } | null}
     */
    const coordinateFor = (texture, coordinate, integer = false)=>{
        const row = integer ? `vec2<i32>(${coordinate}.x, 0)` : `vec2<f32>(${coordinate}.x, 0.5)`;
        switch (texture.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { coordinate: row, layer: null, width: 2, row: true };
            case RESOURCE_DIMENSION.TEXTURE2D:
            case RESOURCE_DIMENSION.TEXTURE2DMS:
                return { coordinate: `${coordinate}.xy`, layer: null, width: 2, row: false };
            case RESOURCE_DIMENSION.TEXTURE3D:
            case RESOURCE_DIMENSION.TEXTURECUBE:
                return { coordinate: `${coordinate}.xyz`, layer: null, width: 3, row: false };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { coordinate: row, layer: `${coordinate}.y`, width: 2, row: true };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
            case RESOURCE_DIMENSION.TEXTURE2DMSARRAY:
                return {
                    coordinate: `${coordinate}.xy`, layer: `${coordinate}.z`, width: 2, row: false,
                };
            case RESOURCE_DIMENSION.TEXTURECUBEARRAY:
                return {
                    coordinate: `${coordinate}.xyz`, layer: `${coordinate}.w`, width: 3, row: false,
                };
            default:
                return null;
        }
    };

    /**
     * What `resinfo` answers for each shape, before its level is checked:
     * the sizes a level has, then what the third component is when it is
     * not a size.
     *
     * @param {TextureDecl} texture
     * @param {string} size  The level's `textureDimensions`.
     * @param {string} name  The texture.
     * @returns {{ sizes: string[], layers: string | null } | null}
     */
    const extentFor = (texture, size, name)=>{
        switch (texture.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { sizes: [`${size}.x`], layers: null };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { sizes: [`${size}.x`], layers: `textureNumLayers(${name})` };
            case RESOURCE_DIMENSION.TEXTURE2D:
            case RESOURCE_DIMENSION.TEXTURE2DMS:
            case RESOURCE_DIMENSION.TEXTURECUBE:
                return { sizes: [`${size}.x`, `${size}.y`], layers: null };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
            case RESOURCE_DIMENSION.TEXTURE2DMSARRAY:
            case RESOURCE_DIMENSION.TEXTURECUBEARRAY:
                return { sizes: [`${size}.x`, `${size}.y`], layers: `textureNumLayers(${name})` };
            case RESOURCE_DIMENSION.TEXTURE3D:
                return { sizes: [`${size}.x`, `${size}.y`, `${size}.z`], layers: null };
            default:
                return null;
        }
    };

    /**
     * A read of a depth texture, one float, as the four Direct3D answers of a
     * view of one channel; any other read as it is.
     *
     * @param {TextureDecl} texture @param {string} read
     */
    const depthRead = (texture, read)=>(texture.depth
        ? `vec4<f32>(${read}, 0.0, 0.0, 1.0)` : read);

    /**
     * A sampled result, as the register file holds it: the texture's swizzle
     * applied, then the bits kept as they are for an integer texture and
     * reinterpreted for a float one.
     *
     * @param {TextureDecl} texture
     * @param {import('./sm4.js').Operand} operand  The `t#` operand, for its swizzle.
     * @param {string} sampled
     */
    const sampledBits = (texture, operand, sampled)=>{
        const read = texture.stencil ? `vec4<u32>(0u, (${sampled}).x, 0u, 1u)` : sampled;
        const swizzled = `(${read}).${swizzleText(operand.swizzle)}`;
        if (texture.returnType === RETURN_TYPE.UINT)
        {
            return swizzled;
        }
        return `bitcast<${REG}>(${swizzled})`;
    };

    /**
     * A texture read through a sampler. `shaped.offset` is the instruction's
     * immediate texel offset as the last argument WGSL takes it (a cube has
     * none), or nothing.
     *
     * @param {import('./sm4.js').Instruction} instruction
     * @param {(texture: TextureDecl, coordinate: { coordinate: string, layer: string | null,
     *          width: number, row: boolean, offset: string }, sampler: string,
     *          bias: string | null) => string} call  `bias` the sampler's MipLODBias as a
     *     WGSL float, null for none
     * @param {{ resource: number, sampler: number }} [at]  where the resource and
     *     sampler operands are
     */
    const sampleWith = (instruction, call, at = { resource: 2, sampler: 3 })=>{
        const [dest, coordinate] = instruction.operands;
        const resource = instruction.operands[at.resource];
        const sampler = instruction.operands[at.sampler];
        const bias = sampler ? options.samplerBias?.[sampler.indices[0].value] ?? 0 : 0;
        const texture = textureOf(resource.indices[0].value);
        const found = texture ? coordinateFor(texture, f(coordinate)) : null;
        if (!texture || !found)
        {
            result.unsupported.push(`${instruction.name} on an undeclared or unsupported texture`);
            return;
        }
        const offset = instruction.offset;
        const cube = texture.dimension === RESOURCE_DIMENSION.TEXTURECUBE
            || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBEARRAY;
        const shaped = { ...found, offset: !offset || cube ? ''
            : found.width === 3 ? `, vec3<i32>(${offset[0]}, ${offset[1]}, ${offset[2]})`
                : `, vec2<i32>(${offset[0]}, ${found.row ? 0 : offset[1]})` };
        if (shaped.layer !== null)
        {
            shaped.layer = `i32(${shaped.layer})`;
        }
        const samplerName = sampler ? `s${sampler.indices[0].value}` : '';
        // WebGPU reads a depth texture through no filtering sampler but a
        // comparing one: a plain one used with it is declared non-filtering.
        const declared = sampler ? result.samplers.find(one=>one.slot
            === sampler.indices[0].value) : null;
        if (declared && texture.depth && !declared.comparison)
        {
            declared.nonFiltering = true;
        }
        const read = call(texture, shaped, samplerName, bias ? floatLiteral(bias) : null);
        store(dest, sampledBits(texture, resource, read));
    };

    /** @param {string} name */
    const unsupported = name=>{
        result.unsupported.push(name);
    };

    /** @param {string} name  A HELPERS entry the body is about to call. */
    const need = name=>{
        if (result.helpers.includes(name))
        {
            return;
        }
        HELPERS[name].needs.forEach(need);
        result.helpers.push(name);
    };

    /**
     * A double source's four dwords, two doubles, its modifier applied to
     * each one's sign bit.
     *
     * @param {import('./sm4.js').Operand} operand
     */
    const doubleSource = operand=>{
        const bits = untyped(operand);
        const signs = `${REG}(0u, 0x80000000u, 0u, 0x80000000u)`;
        switch (operand.modifier)
        {
            case MODIFIER.NEG:
                return `(${bits} ^ ${signs})`;
            case MODIFIER.ABS:
                return `(${bits} & ~${signs})`;
            case MODIFIER.ABSNEG:
                return `(${bits} | ${signs})`;
            default:
                return bits;
        }
    };

    /** @param {import('./sm4.js').Operand} operand  Each held once, as doubles. */
    const heldDouble = operand=>{
        const name = held();
        emit(`let ${name} = ${doubleSource(operand)};`);
        return name;
    };

    /** @param {number} half  0 for the double in .xy, 1 for the one in .zw */
    const halfOf = half=>(half === 0 ? 'xy' : 'zw');

    /**
     * An instruction whose result is doubles: .xy, .zw or both, each the
     * double in the same place of the swizzled sources. `dmovc`'s condition
     * is a dword a double: x for the first, y for the second.
     *
     * @param {import('./sm4.js').Instruction} instruction
     */
    const doubleResult = instruction=>{
        const [target, ...sources] = instruction.operands;
        const opcode = instruction.opcode;
        const condition = opcode === OPCODE.DMOVC ? held() : null;
        if (condition)
        {
            emit(`let ${condition} = ${u(sources[0])};`);
        }
        const [a, b, c] = (condition ? sources.slice(1) : sources).map(heldDouble);
        const entry = { [OPCODE.DADD]: 'dblAdd', [OPCODE.DMUL]: 'dblMul', [OPCODE.DDIV]: 'dblDiv',
            [OPCODE.DRCP]: 'dblDiv', [OPCODE.DFMA]: 'dblFma', [OPCODE.DMIN]: 'dblCompare',
            [OPCODE.DMAX]: 'dblCompare' }[opcode];
        if (entry)
        {
            need(entry);
        }
        if (instruction.saturate)
        {
            need('dblCompare');
        }
        /** @param {number} half */
        const one = half=>{
            const at = halfOf(half);
            /** @type {Record<number, () => string>} */
            const ways = {
                [OPCODE.DADD]: ()=>`dblAdd(${a}.${at}, ${b}.${at})`,
                [OPCODE.DMUL]: ()=>`dblMul(${a}.${at}, ${b}.${at})`,
                [OPCODE.DDIV]: ()=>`dblDiv(${a}.${at}, ${b}.${at})`,
                [OPCODE.DRCP]: ()=>`dblDiv(vec2<u32>(0u, 0x3ff00000u), ${a}.${at})`,
                [OPCODE.DFMA]: ()=>`dblFma(${a}.${at}, ${b}.${at}, ${c}.${at})`,
                [OPCODE.DMIN]: ()=>`dblMin(${a}.${at}, ${b}.${at})`,
                [OPCODE.DMAX]: ()=>`dblMax(${a}.${at}, ${b}.${at})`,
                [OPCODE.DMOV]: ()=>`${a}.${at}`,
                [OPCODE.DMOVC]: ()=>`select(${b}.${at}, ${a}.${at},`
                    + ` ${condition}.${COMPONENT[half]} != 0u)`,
            };
            const value = ways[opcode]();
            return instruction.saturate ? `dblSaturate(${value})` : value;
        };
        const halves = [(target.mask & 0x3) !== 0, (target.mask & 0xc) !== 0];
        store(target, `${REG}(${halves.map((wanted, half)=>(wanted ? one(half)
            : 'vec2<u32>(0u)')).join(', ')})`);
    };

    /**
     * An instruction of doubles whose result is a dword each: the first
     * component the mask writes takes the first double, the second the
     * second.
     *
     * @param {import('./sm4.js').Instruction} instruction
     */
    const wordsOfDoubles = instruction=>{
        const [target, ...sources] = instruction.operands;
        const opcode = instruction.opcode;
        const [a, b] = sources.map(heldDouble);
        need(opcode === OPCODE.DTOF || opcode === OPCODE.DTOI || opcode === OPCODE.DTOU
            ? 'dblConvert' : 'dblCompare');
        /** @param {string} test */
        const all = test=>`select(0u, 0xffffffffu, ${test})`;
        /** @param {number} half */
        const one = half=>{
            const at = halfOf(half);
            switch (opcode)
            {
                case OPCODE.DEQ:
                    return all(`dblEqual(${a}.${at}, ${b}.${at})`);
                case OPCODE.DNE:
                    return all(`!dblEqual(${a}.${at}, ${b}.${at})`);
                case OPCODE.DLT:
                    return all(`dblLess(${a}.${at}, ${b}.${at})`);
                case OPCODE.DGE:
                    return all(`!(dblNan(${a}.${at}) || dblNan(${b}.${at})`
                        + ` || dblLess(${a}.${at}, ${b}.${at}))`);
                case OPCODE.DTOF:
                    return instruction.saturate
                        ? `bitcast<u32>(clamp(bitcast<f32>(dblToFloat(${a}.${at})), 0.0, 1.0))`
                        : `dblToFloat(${a}.${at})`;
                case OPCODE.DTOI:
                    return `dblToInt(${a}.${at})`;
                default:
                    return `dblToUint(${a}.${at})`;
            }
        };
        let written = 0;
        store(target, `${REG}(${COMPONENT.map((_, place)=>((target.mask & (1 << place)) === 0
            ? '0u' : one(written++))).join(', ')})`);
    };

    /**
     * A double from a dword: x makes the double in .xy, y the one in .zw.
     *
     * @param {import('./sm4.js').Instruction} instruction
     */
    const doublesOfWords = instruction=>{
        const [target, source] = instruction.operands;
        need('dblConvert');
        const words = held();
        const opcode = instruction.opcode;
        emit(`let ${words} = ${opcode === OPCODE.FTOD ? (modifiedRead(source)
            ? `bitcast<${REG}>(${f(source)})` : u(source))
            : opcode === OPCODE.ITOD ? `bitcast<${REG}>(${i(source)})` : u(source)};`);
        const convert = { [OPCODE.FTOD]: 'dblFromFloat', [OPCODE.ITOD]: 'dblFromInt',
            [OPCODE.UTOD]: 'dblFromUint' }[opcode];
        const halves = [(target.mask & 0x3) !== 0, (target.mask & 0xc) !== 0];
        store(target, `${REG}(${halves.map((wanted, half)=>(wanted
            ? `${convert}(${words}.${COMPONENT[half]})` : 'vec2<u32>(0u)')).join(', ')})`);
    };

    /**
     * Two-destination integer multiplies and divides: the destination that is
     * `null` is simply not stored.
     *
     * @param {import('./sm4.js').Instruction} instruction
     * @param {string} high
     * @param {string} low
     */
    const storePair = (instruction, high, low)=>{
        const pair = instruction.operands;
        const first = pair[0];
        if (first.type === OPERAND.NULL || pair[1].type === OPERAND.NULL)
        {
            store(first, high);
            store(pair[1], low);
            return;
        }
        // Both results are read before either is written: `udiv r0, r1, r0,
        // r2` divides the r0 it is about to replace.
        const second = held();
        emit(`let ${second} = ${low};`);
        store(first, high);
        store(pair[1], second);
    };

    /**
     * The subroutines after the main program, by label (`l3`) or function
     * body (`fb3`). A call is translated by writing the subroutine's body
     * where the call is: Shader Model 4 and 5 forbid recursion, so every call
     * graph unrolls, and the body then works on the caller's registers as the
     * hardware's does.
     *
     * @type {Map<string, import('./sm4.js').Instruction[]>}
     */
    const subroutines = new Map();
    const firstLabel = instructions.findIndex(entry=>entry.opcode === OPCODE.LABEL);
    /** @type {import('./sm4.js').Instruction[]} */
    let subroutine = [];
    for (const entry of firstLabel < 0 ? [] : instructions.slice(firstLabel))
    {
        if (entry.opcode === OPCODE.LABEL)
        {
            subroutine = [];
            const named = entry.operands[0];
            subroutines.set(`${named?.type === OPERAND.FUNCTION_BODY ? 'fb' : 'l'}`
                + `${named?.indices[0]?.value ?? -1}`, subroutine);
            continue;
        }
        subroutine.push(entry);
    }
    /** @type {Set<string>} */
    const calling = new Set();

    /**
     * Class linkage. A function table lists one body for each call site; an
     * interface pointer (fp#, an array of them) lists the tables of the
     * classes it may hold; `fcall fp#[i][site]` calls the bound instance's
     * table's body for that site. Which class each pointer holds, and the
     * four words of its `this`, are known only when the shader is bound, so
     * the shader is translated for them (`options.interfaces`, by slot) and
     * each call is the one body written in place. The slots follow the
     * pointers in the order they are declared, an array taking one each.
     *
     * @type {Map<number, number[]>}
     */
    const functionTables = new Map();
    /** @type {Map<number, { slot: number, size: number, sites: number, tables: number[] }>} */
    const interfacePointers = new Map();
    let interfaceSlots = 0;

    /** @param {import('./sm4.js').Operand} operand  this[#], as four words. */
    const thisPointer = operand=>{
        const instances = options.interfaces;
        if (!instances)
        {
            result.unsupported.push('a this pointer, with no class instances given');
            return `${REG}(0u)`;
        }
        /** @param {number} slot */
        const words = slot=>`${REG}(${(instances[slot]?.data ?? [0, 0, 0, 0])
            .map(u32Literal).join(', ')})`;
        const index = operand.indices[0];
        if (!index?.relative)
        {
            return words(index?.value ?? 0);
        }
        const count = Math.max(instances.length, 1);
        return `array<${REG}, ${count}>(${Array.from({ length: count }, (_, slot)=>words(slot))
            .join(', ')})[min(${indexExpression(operand, 0)}, ${count - 1}u)]`;
    };

    /**
     * `fcall`: the body the instance bound at each slot the call may reach
     * selects, a switch on the array index where it is computed.
     *
     * @param {import('./sm4.js').Instruction} instruction
     */
    const interfaceCall = instruction=>{
        const [pointer] = instruction.operands;
        const declared = interfacePointers.get(pointer?.indices[0]?.value ?? -1);
        const site = instruction.callSite ?? 0;
        if (!declared)
        {
            unsupported('an interface call through an undeclared pointer');
            return;
        }
        if (!options.interfaces)
        {
            unsupported('an interface call, with no class instances given');
            return;
        }
        /** @param {number} element */
        const callAt = element=>{
            const slot = declared.slot + element;
            const instance = options.interfaces?.[slot];
            if (!instance)
            {
                result.unboundInterfaces = [...new Set([...result.unboundInterfaces ?? [], slot])];
                return;
            }
            const table = functionTables.get(instance.table);
            if (!declared.tables.includes(instance.table) || !table)
            {
                unsupported(`class instance table ${instance.table} at slot ${slot}, which its`
                    + ' interface does not take');
                return;
            }
            callSubroutine(`fb${table[site] ?? -1}`);
        };
        const index = pointer.indices[1];
        if (!index?.relative)
        {
            callAt(index?.value ?? 0);
            return;
        }
        emit(`switch (${indexExpression(pointer, 1)}) {`);
        depth++;
        for (let element = 0; element < declared.size; element++)
        {
            emit(`case ${element}u: {`);
            depth++;
            callAt(element);
            depth--;
            emit('}');
        }
        emit('default: {}');
        depth--;
        emit('}');
    };

    /**
     * The switches being written. A run of `case`s with nothing between them
     * shares one body, so a clause is opened only when its first statement
     * arrives, with every selector gathered by then.
     *
     * @type {{ selectors: string[], open: boolean, hasDefault: boolean }[]}
     */
    const switches = [];

    const openClause = ()=>{
        const current = switches.at(-1);
        if (!current || current.selectors.length === 0)
        {
            return;
        }
        emit(current.selectors.length === 1 && current.selectors[0] === 'default'
            ? 'default: {'
            : `case ${current.selectors.join(', ')}: {`);
        depth++;
        current.selectors = [];
        current.open = true;
    };

    const closeClause = ()=>{
        const current = switches.at(-1);
        if (current?.open)
        {
            depth--;
            emit('}');
            current.open = false;
        }
    };

    /**
     * Where a `ret` goes. The main program's returns from the entry point; a
     * subroutine written in place whose only `ret` is its last needs nothing;
     * one that returns early runs inside a loop of one pass, and its `ret`
     * sets a flag and breaks, the flag carried out through every loop and
     * switch of the subroutine that the break leaves it inside.
     *
     * @typedef {{ returned: string | null, main: boolean }} Frame
     */

    /**
     * @param {import('./sm4.js').Instruction[]} list
     * @param {Frame} frame
     */
    const translateBlock = (list, frame)=>{
        for (const instruction of list)
        {
            translateOne(instruction, frame);
        }
    };

    /** @param {string} index  `l<n>` or `fb<n>` */
    const callSubroutine = index=>{
        const body = subroutines.get(index);
        if (!body)
        {
            unsupported(`a call to ${index}, which the program does not have`);
            return;
        }
        if (calling.has(index))
        {
            unsupported('a recursive call');
            return;
        }
        calling.add(index);
        const block = body.at(-1)?.opcode === OPCODE.RET ? body.slice(0, -1) : body;
        const early = block.some(entry=>entry.opcode === OPCODE.RET
            || entry.opcode === OPCODE.RETC);
        if (!early)
        {
            translateBlock(block, { returned: null, main: false });
        }
        else
        {
            const returned = `returned${nextTemp++}`;
            emit(`var ${returned} = false;`);
            emit('loop {');
            depth++;
            translateBlock(block, { returned, main: false });
            emit('break;');
            depth--;
            emit('}');
        }
        calling.delete(index);
    };

    /**
     * After a loop or a switch closes inside a subroutine that returns early:
     * a `ret` inside it broke out of it and no further.
     *
     * @param {Frame} frame
     */
    const carryReturn = frame=>{
        if (frame.returned)
        {
            emit(`if (${frame.returned}) { break; }`);
        }
    };

    /**
     * @param {string} test  The condition, as WGSL.
     * @param {Frame} frame
     */
    const conditionalReturn = (test, frame)=>{
        emit(`if (${test}) {`);
        depth++;
        if (frame.main)
        {
            result.body.push({ ret: true });
        }
        else
        {
            emit(`${frame.returned} = true;`);
            emit('break;');
        }
        depth--;
        emit('}');
    };

    /**
     * Memory a Shader Model 5 instruction reads or writes by the dword: a
     * view written through, thread-group shared memory, or a buffer read by
     * bytes or structures. Its accessors (`<name>_word`, `<name>_put`,
     * `<name>_atomic_<op>`) are declared once the whole shader is known, so
     * that memory an atomic touches is declared atomic and read through it.
     *
     * @param {import('./sm4.js').Operand} operand
     * @returns {{ name: string, stride: number, uav: UavDecl | null,
     *     shared: SharedDecl | null, texture: TextureDecl | null } | null}
     */
    const memoryOf = operand=>{
        const slot = operand.indices[0]?.value ?? -1;
        if (operand.type === OPERAND.UNORDERED_ACCESS_VIEW)
        {
            const uav = result.uavs.find(entry=>entry.slot === slot) ?? null;
            return uav ? { name: `u${slot}`, stride: uav.stride, uav, shared: null,
                texture: null } : null;
        }
        if (operand.type === OPERAND.THREAD_GROUP_SHARED_MEMORY)
        {
            const shared = result.sharedMemory.find(entry=>entry.slot === slot) ?? null;
            return shared ? { name: `g${slot}`, stride: shared.stride, uav: null, shared,
                texture: null } : null;
        }
        if (operand.type === OPERAND.RESOURCE)
        {
            const texture = textureOf(slot);
            return texture?.structure ? { name: `t${slot}`, stride: texture.stride ?? 0,
                uav: null, shared: null, texture } : null;
        }
        return null;
    };

    /**
     * The dword an access starts at: a byte address for raw memory, or a
     * structure's index and the byte within it.
     *
     * @param {{ stride: number }} memory @param {string} first @param {string | null} within
     */
    const wordOf = (memory, first, within)=>{
        const at = held();
        emit(`let ${at} = (${within === null ? first
            : `${first} * ${memory.stride}u + ${within}`}) / 4u;`);
        return at;
    };

    /**
     * An atomic operation on a dword of memory, which then is atomic: the
     * value it held before.
     *
     * @param {NonNullable<ReturnType<typeof memoryOf>>} memory
     * @param {string} op @param {string} word @param {string} value @param {string} compare
     */
    const atomicOn = (memory, op, word, value, compare)=>{
        const declared = memory.uav ?? memory.shared;
        if (!declared || memory.texture)
        {
            unsupported(`an atomic ${op} on a read-only resource`);
            return '0u';
        }
        declared.atomic = true;
        (declared.atomicOps ??= new Set()).add(op);
        return `${memory.name}_atomic_${op}(${word}, ${value}, ${compare})`;
    };

    /** The storage-texture coordinate of a typed view's address. @param {UavDecl} uav @param {string} address */
    const storageCoordinate = (uav, address)=>{
        switch (uav.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { coordinate: `vec2<i32>(i32(${address}.x), 0)`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE2D:
                return { coordinate: `vec2<i32>(${address}.xy)`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { coordinate: `vec2<i32>(i32(${address}.x), 0)`,
                    layer: `i32(${address}.y)` };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
                return { coordinate: `vec2<i32>(${address}.xy)`, layer: `i32(${address}.z)` };
            case RESOURCE_DIMENSION.TEXTURE3D:
                return { coordinate: `vec3<i32>(${address}.xyz)`, layer: null };
            default:
                return null;
        }
    };

    /**
     * The word of a typed texture view held as words (`words`) an address
     * names: its texel, layer or slice; out of the view, an index past them.
     *
     * @param {string} name @param {UavDecl} uav @param {string} address
     */
    const wordIndex = (name, uav, address)=>{
        const at = /** @type {Record<number, string>} */ ({
            [RESOURCE_DIMENSION.TEXTURE1D]: `${address}.x, 0u, 0u`,
            [RESOURCE_DIMENSION.TEXTURE1DARRAY]: `${address}.x, 0u, ${address}.y`,
            [RESOURCE_DIMENSION.TEXTURE2D]: `${address}.xy, 0u`,
        })[uav.dimension] ?? `${address}.xyz`;
        return `${name}_index(${REG}(${at}, 0u))`;
    };

    /** The scalar a storage format's texels are. @param {string} format */
    const storageScalar = format=>(/uint$/.test(format) ? 'u32'
        : /sint$/.test(format) ? 'i32' : 'f32');

    /**
     * Each component of four through a scalar function of each operand's.
     *
     * @param {(...parts: string[]) => string} each @param {string[]} values
     */
    const perComponent = (each, values)=>{
        const named = values.map(value=>{
            const name = held();
            emit(`let ${name} = ${value};`);
            return name;
        });
        return `${REG}(${COMPONENT.map(component=>each(...named.map(name=>
            `${name}.${component}`))).join(', ')})`;
    };

    /**
     * @param {import('./sm4.js').Instruction} instruction
     * @param {Frame} frame
     */
    const translateOne = (instruction, frame)=>{
        const [dest, a, b, c] = instruction.operands;
        const sat = instruction.saturate;
        if (instruction.opcode !== OPCODE.CASE && instruction.opcode !== OPCODE.DEFAULT
            && instruction.opcode !== OPCODE.ENDSWITCH)
        {
            openClause();
        }
        switch (instruction.opcode)
        {
            // --- declarations ---
            // The tessellation stages' declarations (what the stage is, which
            // the hull linker reads from the stream itself) and the global flags.
            case OPCODE.DCL_GLOBAL_FLAGS:
                if ((instruction.control & GLOBAL_FLAG.FORCE_EARLY_DEPTH_STENCIL) !== 0)
                {
                    result.earlyDepth = true;
                }
                break;
            case OPCODE.HS_DECLS:
            case OPCODE.HS_CONTROL_POINT_PHASE:
            case OPCODE.HS_FORK_PHASE:
            case OPCODE.HS_JOIN_PHASE:
            case OPCODE.DCL_INPUT_CONTROL_POINT_COUNT:
            case OPCODE.DCL_OUTPUT_CONTROL_POINT_COUNT:
            case OPCODE.DCL_TESS_DOMAIN:
            case OPCODE.DCL_TESS_PARTITIONING:
            case OPCODE.DCL_TESS_OUTPUT_PRIMITIVE:
            case OPCODE.DCL_HS_MAX_TESSFACTOR:
            case OPCODE.DCL_HS_FORK_PHASE_INSTANCE_COUNT:
            case OPCODE.DCL_HS_JOIN_PHASE_INSTANCE_COUNT:
            case OPCODE.DCL_OUTPUT_SGV:
            case OPCODE.DCL_GS_INPUT_PRIMITIVE:
            case OPCODE.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY:
            case OPCODE.DCL_MAX_OUTPUT_VERTEX_COUNT:
            case OPCODE.DCL_GS_INSTANCE_COUNT:
            case OPCODE.DCL_STREAM:
            case OPCODE.NOP:
                break;
            case OPCODE.DCL_TEMPS:
                result.temps = instruction.extra[0] ?? 0;
                break;
            case OPCODE.DCL_INDEXABLE_TEMP:
                result.indexableTemps.push({
                    index: instruction.extra[0], size: instruction.extra[1],
                });
                break;
            case OPCODE.DCL_CONSTANT_BUFFER:
                result.constantBuffers.push({
                    slot: dest.indices[0].value,
                    size: Math.max(dest.indices[1] ? dest.indices[1].value : 0,
                        options.constantSizes?.[dest.indices[0].value] ?? 0),
                });
                break;
            case OPCODE.DCL_SAMPLER:
                result.samplers.push({
                    slot: dest.indices[0].value,
                    comparison: (instruction.control & 0xf) === SAMPLER_MODE.COMPARISON,
                });
                break;
            case OPCODE.DCL_RESOURCE:
                result.textures.push({
                    slot: dest.indices[0].value,
                    dimension: instruction.control & 0x1f,
                    returnType: (instruction.extra[0] ?? 0) & 0xf,
                    comparison: false,
                    ...((instruction.control & 0x1f) === RESOURCE_DIMENSION.TEXTURE2DMS
                        && (options.multisampled ?? []).includes(dest.indices[0].value)
                        ? { multisampled: true }
                        : {}),
                    ...((options.depth ?? []).includes(dest.indices[0].value)
                        ? { depth: true } : {}),
                    ...((options.stencil ?? []).includes(dest.indices[0].value)
                        ? { stencil: true } : {}),
                });
                if ((instruction.control & 0x1f) === RESOURCE_DIMENSION.BUFFER)
                {
                    need('bufferElement');
                }
                break;
            case OPCODE.DCL_INPUT:
            case OPCODE.DCL_INPUT_SIV:
            case OPCODE.DCL_INPUT_SGV:
            case OPCODE.DCL_INPUT_PS:
            case OPCODE.DCL_INPUT_PS_SIV:
            case OPCODE.DCL_INPUT_PS_SGV:
                if (dest.type === OPERAND.INPUT)
                {
                    result.inputRegisters = Math.max(result.inputRegisters,
                        dest.indices[isGeometry && dest.indices.length > 1 ? 1 : 0].value + 1);
                    if (instruction.opcode !== OPCODE.DCL_INPUT_PS_SGV)
                    {
                        result.interpolation = { ...result.interpolation,
                            [dest.indices[0].value]: instruction.control & 0xf };
                    }
                }
                break;
            case OPCODE.DCL_OUTPUT:
            case OPCODE.DCL_OUTPUT_SIV:
                if (dest.type === OPERAND.OUTPUT)
                {
                    result.outputRegisters = Math.max(result.outputRegisters,
                        dest.indices[0].value + 1);
                }
                break;
            case OPCODE.DCL_THREAD_GROUP:
                result.threadGroup = instruction.extra.slice(0, 3);
                break;
            case OPCODE.DCL_UAV_TYPED:
            case OPCODE.DCL_UAV_RAW:
            case OPCODE.DCL_UAV_STRUCTURED: {
                const slot = dest.indices[0].value;
                const isTyped = instruction.opcode === OPCODE.DCL_UAV_TYPED;
                const format = isTyped ? options.uavFormats?.[slot] : undefined;
                const texture = isTyped
                    && (instruction.control & 0x1f) !== RESOURCE_DIMENSION.BUFFER;
                const packed = texture && format && PACKED_TEXELS[format] ? format : null;
                const words = texture && (atomicViews.has(slot) || packed !== null);
                if (packed === 'rg11b10ufloat')
                {
                    need('unsignedFloat');
                }
                result.uavs.push({
                    slot,
                    structure: isTyped ? 'typed'
                        : instruction.opcode === OPCODE.DCL_UAV_RAW ? 'raw' : 'structured',
                    dimension: isTyped ? instruction.control & 0x1f : RESOURCE_DIMENSION.BUFFER,
                    returnType: isTyped ? (instruction.extra[0] ?? 0) & 0xf : RETURN_TYPE.UINT,
                    stride: instruction.opcode === OPCODE.DCL_UAV_STRUCTURED
                        ? instruction.extra[0] ?? 0 : 0,
                    counter: instruction.opcode === OPCODE.DCL_UAV_STRUCTURED
                        && ((instruction.control >>> 12) & 1) === 1,
                    atomic: false,
                    loaded: false,
                    ...(format && !packed ? { format } : {}),
                    ...(words ? { words } : {}),
                    ...(packed ? { packed } : {}),
                });
                if (isTyped && (instruction.control & 0x1f) === RESOURCE_DIMENSION.BUFFER)
                {
                    need('bufferElement');
                    need('storeElement');
                }
                break;
            }
            case OPCODE.DCL_TGSM_RAW:
                result.sharedMemory.push({ slot: dest.indices[0].value,
                    words: Math.ceil((instruction.extra[0] ?? 0) / 4), stride: 0, atomic: false });
                break;
            case OPCODE.DCL_TGSM_STRUCTURED:
                result.sharedMemory.push({ slot: dest.indices[0].value,
                    words: Math.ceil((instruction.extra[0] ?? 0) * (instruction.extra[1] ?? 0) / 4),
                    stride: instruction.extra[0] ?? 0, atomic: false });
                break;
            case OPCODE.DCL_RESOURCE_RAW:
            case OPCODE.DCL_RESOURCE_STRUCTURED:
                result.textures.push({
                    slot: dest.indices[0].value,
                    dimension: RESOURCE_DIMENSION.BUFFER,
                    returnType: RETURN_TYPE.UINT,
                    comparison: false,
                    structure: instruction.opcode === OPCODE.DCL_RESOURCE_RAW ? 'raw'
                        : 'structured',
                    stride: instruction.opcode === OPCODE.DCL_RESOURCE_STRUCTURED
                        ? instruction.extra[0] ?? 0 : 0,
                });
                break;
            case OPCODE.CUSTOMDATA:
                if (instruction.control === CUSTOMDATA.IMMEDIATE_CONSTANT_BUFFER)
                {
                    const data = instruction.customData ?? [];
                    for (let row = 0; row + 4 <= data.length; row += 4)
                    {
                        result.immediateConstants.push(data.slice(row, row + 4));
                    }
                }
                break;

            // --- doubles (wgsl-doubles.js) ---
            case OPCODE.DADD:
            case OPCODE.DMUL:
            case OPCODE.DDIV:
            case OPCODE.DRCP:
            case OPCODE.DFMA:
            case OPCODE.DMIN:
            case OPCODE.DMAX:
            case OPCODE.DMOV:
            case OPCODE.DMOVC:
                doubleResult(instruction);
                break;
            case OPCODE.DEQ:
            case OPCODE.DNE:
            case OPCODE.DLT:
            case OPCODE.DGE:
            case OPCODE.DTOF:
            case OPCODE.DTOI:
            case OPCODE.DTOU:
                wordsOfDoubles(instruction);
                break;
            case OPCODE.FTOD:
            case OPCODE.ITOD:
            case OPCODE.UTOD:
                doublesOfWords(instruction);
                break;

            // --- moves ---
            // A move copies bits; a source modifier makes it a float's move.
            case OPCODE.MOV:
                store(dest, sat || modifiedRead(a) ? fromFloat(f(a), sat) : u(a));
                break;
            case OPCODE.MOVC:
                store(dest, `select(${moved(c)}, ${moved(b)}, ${u(a)} != ${REG}(0u))`);
                break;

            // --- float arithmetic ---
            case OPCODE.ADD:
                store(dest, fromFloat(`(${f(a)} + ${f(b)})`, sat));
                break;
            case OPCODE.MUL:
                store(dest, fromFloat(`(${f(a)} * ${f(b)})`, sat));
                break;
            case OPCODE.DIV:
                store(dest, fromFloat(`(${f(a)} / ${f(b)})`, sat));
                break;
            case OPCODE.MAD:
                store(dest, fromFloat(`(${f(a)} * ${f(b)} + ${f(c)})`, sat));
                break;
            case OPCODE.MIN:
                store(dest, fromFloat(`min(${f(a)}, ${f(b)})`, sat));
                break;
            case OPCODE.MAX:
                store(dest, fromFloat(`max(${f(a)}, ${f(b)})`, sat));
                break;
            case OPCODE.DP2:
                store(dest, fromFloat(splat(`dot(${floats(a, 2)}, ${floats(b, 2)})`), sat));
                break;
            case OPCODE.DP3:
                store(dest, fromFloat(splat(`dot(${floats(a, 3)}, ${floats(b, 3)})`), sat));
                break;
            case OPCODE.DP4:
                store(dest, fromFloat(splat(`dot(${f(a)}, ${f(b)})`), sat));
                break;
            case OPCODE.EXP:
                store(dest, fromFloat(`exp2(${f(a)})`, sat));
                break;
            case OPCODE.LOG:
                store(dest, fromFloat(`log2(${f(a)})`, sat));
                break;
            case OPCODE.RSQ:
                store(dest, fromFloat(`inverseSqrt(${f(a)})`, sat));
                break;
            case OPCODE.SQRT:
                store(dest, fromFloat(`sqrt(${f(a)})`, sat));
                break;
            case OPCODE.FRC:
                store(dest, fromFloat(`fract(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_NE:
                store(dest, fromFloat(`round(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_NI:
                store(dest, fromFloat(`floor(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_PI:
                store(dest, fromFloat(`ceil(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_Z:
                store(dest, fromFloat(`trunc(${f(a)})`, sat));
                break;
            case OPCODE.SINCOS:
                storePair(instruction, fromFloat(`sin(${f(b)})`, sat),
                    fromFloat(`cos(${f(b)})`, sat));
                break;
            case OPCODE.DERIV_RTX:
                store(dest, fromFloat(`dpdx(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY:
                store(dest, fromFloat(`dpdy(${f(a)})`, sat));
                break;

            // --- float comparisons: all ones or all zeros, per component ---
            case OPCODE.LT:
                store(dest, fromBool(`(${f(a)} < ${f(b)})`));
                break;
            case OPCODE.GE:
                store(dest, fromBool(`(${f(a)} >= ${f(b)})`));
                break;
            case OPCODE.EQ:
                store(dest, fromBool(`(${f(a)} == ${f(b)})`));
                break;
            case OPCODE.NE:
                store(dest, fromBool(`(${f(a)} != ${f(b)})`));
                break;

            // --- integer arithmetic ---
            case OPCODE.IADD:
                store(dest, fromInt(`(${i(a)} + ${i(b)})`));
                break;
            case OPCODE.IMAD:
                store(dest, fromInt(`(${i(a)} * ${i(b)} + ${i(c)})`));
                break;
            case OPCODE.UMAD:
                store(dest, `(${u(a)} * ${u(b)} + ${u(c)})`);
                break;
            case OPCODE.IMUL:
                if (dest.type !== OPERAND.NULL)
                {
                    need('imulhi');
                }
                storePair(instruction, `imulhi(${fromInt(i(b))}, ${fromInt(i(c))})`,
                    fromInt(`(${i(b)} * ${i(c)})`));
                break;
            case OPCODE.UMUL:
                if (dest.type !== OPERAND.NULL)
                {
                    need('umulhi');
                }
                storePair(instruction, `umulhi(${u(b)}, ${u(c)})`, `(${u(b)} * ${u(c)})`);
                break;
            case OPCODE.UDIV: {
                // Division by zero answers all ones in both halves; WGSL's
                // answers the dividend and zero.
                const byZero = `${u(c)} == ${REG}(0u)`;
                storePair(instruction,
                    `select((${u(b)} / ${u(c)}), ${REG}(0xffffffffu), ${byZero})`,
                    `select((${u(b)} % ${u(c)}), ${REG}(0xffffffffu), ${byZero})`);
                break;
            }
            case OPCODE.IMAX:
                store(dest, fromInt(`max(${i(a)}, ${i(b)})`));
                break;
            case OPCODE.IMIN:
                store(dest, fromInt(`min(${i(a)}, ${i(b)})`));
                break;
            case OPCODE.UMAX:
                store(dest, `max(${u(a)}, ${u(b)})`);
                break;
            case OPCODE.UMIN:
                store(dest, `min(${u(a)}, ${u(b)})`);
                break;
            case OPCODE.INEG:
                store(dest, fromInt(`(-${i(a)})`));
                break;
            case OPCODE.ISHL:
                store(dest, `(${u(a)} << (${u(b)} & ${REG}(31u)))`);
                break;
            case OPCODE.ISHR:
                store(dest, fromInt(`(${i(a)} >> (${u(b)} & ${REG}(31u)))`));
                break;
            case OPCODE.USHR:
                store(dest, `(${u(a)} >> (${u(b)} & ${REG}(31u)))`);
                break;
            case OPCODE.AND:
                store(dest, `(${u(a)} & ${u(b)})`);
                break;
            case OPCODE.OR:
                store(dest, `(${u(a)} | ${u(b)})`);
                break;
            case OPCODE.XOR:
                store(dest, `(${u(a)} ^ ${u(b)})`);
                break;
            case OPCODE.NOT:
                store(dest, `(~${u(a)})`);
                break;
            case OPCODE.IEQ:
                store(dest, fromBool(`(${i(a)} == ${i(b)})`));
                break;
            case OPCODE.INE:
                store(dest, fromBool(`(${i(a)} != ${i(b)})`));
                break;
            case OPCODE.IGE:
                store(dest, fromBool(`(${i(a)} >= ${i(b)})`));
                break;
            case OPCODE.ILT:
                store(dest, fromBool(`(${i(a)} < ${i(b)})`));
                break;
            case OPCODE.UGE:
                store(dest, fromBool(`(${u(a)} >= ${u(b)})`));
                break;
            case OPCODE.ULT:
                store(dest, fromBool(`(${u(a)} < ${u(b)})`));
                break;

            // --- conversions ---
            case OPCODE.ITOF:
                store(dest, fromFloat(`vec4<f32>(${i(a)})`, sat));
                break;
            case OPCODE.UTOF:
                store(dest, fromFloat(`vec4<f32>(${u(a)})`, sat));
                break;
            // WGSL saturates to the largest integer a float holds below the
            // type's top (0xffffff00 unsigned, 0x7fffff80 signed); Direct3D
            // to the top itself (test_uint_shader_instructions).
            case OPCODE.FTOI: {
                const value = held();
                emit(`let ${value} = ${f(a)};`);
                store(dest, fromInt(`select(vec4<i32>(${value}), vec4<i32>(2147483647),`
                    + ` ${value} >= vec4<f32>(2147483648.0))`));
                break;
            }
            case OPCODE.FTOU: {
                const value = held();
                emit(`let ${value} = ${f(a)};`);
                store(dest, `select(${REG}(${value}), ${REG}(0xffffffffu),`
                    + ` ${value} >= vec4<f32>(4294967296.0))`);
                break;
            }

            // --- flow control ---
            case OPCODE.IF:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) {`);
                depth++;
                break;
            case OPCODE.ELSE:
                depth--;
                emit('} else {');
                depth++;
                break;
            case OPCODE.ENDIF:
                depth--;
                emit('}');
                break;
            case OPCODE.LOOP:
                emit('loop {');
                depth++;
                break;
            case OPCODE.ENDLOOP:
                depth--;
                emit('}');
                carryReturn(frame);
                break;
            case OPCODE.SWITCH:
                emit(`switch (${u(dest)}.x) {`);
                depth++;
                switches.push({ selectors: [], open: false, hasDefault: false });
                break;
            case OPCODE.CASE:
            case OPCODE.DEFAULT: {
                const current = switches.at(-1);
                if (!current)
                {
                    unsupported(`${instruction.name} outside a switch`);
                    break;
                }
                closeClause();
                if (instruction.opcode === OPCODE.DEFAULT)
                {
                    current.selectors.push('default');
                    current.hasDefault = true;
                }
                else
                {
                    current.selectors.push(u32Literal(dest.immediate[0] ?? 0));
                }
                break;
            }
            case OPCODE.ENDSWITCH: {
                const current = switches.at(-1);
                if (!current)
                {
                    unsupported('endswitch outside a switch');
                    break;
                }
                // Trailing cases with no body of their own do nothing.
                openClause();
                closeClause();
                if (!current.hasDefault)
                {
                    emit('default: {}');
                }
                switches.pop();
                depth--;
                emit('}');
                carryReturn(frame);
                break;
            }
            case OPCODE.CALL:
                callSubroutine(`l${dest.indices[0]?.value ?? -1}`);
                break;
            case OPCODE.DCL_FUNCTION_BODY:
                break;
            case OPCODE.DCL_FUNCTION_TABLE: {
                const [index, count] = instruction.extra;
                functionTables.set(index, instruction.extra.slice(2, 2 + count));
                break;
            }
            case OPCODE.DCL_INTERFACE: {
                // fp#, the call sites, the array's size over the count of
                // tables, then the tables.
                const [index, sites, shape] = instruction.extra;
                const size = Math.max(shape >>> 16, 1);
                interfacePointers.set(index, { slot: interfaceSlots, size, sites,
                    tables: instruction.extra.slice(3, 3 + (shape & 0xffff)) });
                interfaceSlots += size;
                break;
            }
            case OPCODE.INTERFACE_CALL:
                interfaceCall(instruction);
                break;
            case OPCODE.CALLC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) {`);
                depth++;
                callSubroutine(`l${a.indices[0]?.value ?? -1}`);
                depth--;
                emit('}');
                break;
            case OPCODE.BREAK:
                emit('break;');
                break;
            case OPCODE.BREAKC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { break; }`);
                break;
            case OPCODE.CONTINUE:
                emit('continue;');
                break;
            case OPCODE.CONTINUEC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { continue; }`);
                break;
            case OPCODE.DISCARD:
                if (!isPixel)
                {
                    unsupported('discard outside a pixel shader');
                    break;
                }
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { discard; }`);
                break;
            case OPCODE.RET:
                if (frame.main)
                {
                    result.body.push({ ret: true });
                }
                else
                {
                    emit(`${frame.returned} = true;`);
                    emit('break;');
                }
                break;
            case OPCODE.RETC:
                conditionalReturn(`${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u`,
                    frame);
                break;

            // --- textures ---
            case OPCODE.SAMPLE:
                if (!isPixel)
                {
                    unsupported('sample outside a pixel shader');
                    break;
                }
                sampleWith(instruction, (texture, shaped, sampler, bias)=>depthRead(texture,
                    `${bias && !texture.depth ? 'textureSampleBias' : 'textureSample'}`
                    + `(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `${bias && !texture.depth ? `, ${bias}` : ''}${shaped.offset})`));
                break;
            case OPCODE.SAMPLE_L:
                // A depth texture's level is a whole number.
                sampleWith(instruction, (texture, shaped, sampler, bias)=>{
                    const lod = `${f(instruction.operands[4])}.x${bias ? ` + ${bias}` : ''}`;
                    return depthRead(texture,
                        `textureSampleLevel(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                        + `, ${texture.depth ? `i32(round(${lod}))` : lod}${shaped.offset})`);
                });
                break;
            case OPCODE.SAMPLE_B:
                if (!isPixel)
                {
                    unsupported('sample_b outside a pixel shader');
                    break;
                }
                sampleWith(instruction, (texture, shaped, sampler, bias)=>(texture.depth
                    ? depthRead(texture, `textureSample(t${texture.slot}, ${sampler}`
                        + `, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`}${shaped.offset})`)
                    : `textureSampleBias(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x${bias ? ` + ${bias}` : ''}`
                    + `${shaped.offset})`));
                break;
            case OPCODE.SAMPLE_D:
                sampleWith(instruction, (texture, shaped, sampler, bias)=>{
                    if (texture.depth)
                    {
                        return depthRead(texture, `textureSampleLevel(t${texture.slot}`
                            + `, ${sampler}, ${shaped.coordinate}`
                            + `${shaped.layer === null ? '' : `, ${shaped.layer}`}, 0`
                            + `${shaped.offset})`);
                    }
                    /** @param {import('./sm4.js').Operand} operand */
                    // A bias of b is gradients 2^b as long.
                    const gradient = operand=>`${shaped.row
                        ? `vec2<f32>(${f(operand)}.x, 0.0)`
                        : floats(operand, shaped.width)}${bias ? ` * exp2(${bias})` : ''}`;
                    return `textureSampleGrad(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                        + `, ${gradient(instruction.operands[4])}`
                        + `, ${gradient(instruction.operands[5])}${shaped.offset})`;
                });
                break;
            case OPCODE.SAMPLE_C:
            case OPCODE.SAMPLE_C_LZ: {
                const compareTexture = textureOf(instruction.operands[2].indices[0].value);
                if (compareTexture)
                {
                    compareTexture.comparison = true;
                }
                const level = instruction.opcode === OPCODE.SAMPLE_C_LZ;
                if (!level && !isPixel)
                {
                    unsupported('sample_c outside a pixel shader');
                    break;
                }
                // A compare-sample answers one float; the register file wants
                // four, and the texture's swizzle picks among them.
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `vec4<f32>(${level ? 'textureSampleCompareLevel' : 'textureSampleCompare'}`
                    + `(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x${shaped.offset}))`);
                break;
            }
            case OPCODE.LD:
            case OPCODE.LD_MS: {
                const [target, address, resource, sampleIndex] = instruction.operands;
                const texture = textureOf(resource.indices[0].value);
                if (texture?.dimension === RESOURCE_DIMENSION.BUFFER
                    && instruction.opcode === OPCODE.LD)
                {
                    store(target, `(loadt${texture.slot}(${u(address)}.x))`
                        + `.${swizzleText(resource.swizzle)}`);
                    break;
                }
                const shaped = texture ? coordinateFor(texture, i(address), true) : null;
                if (!texture || !shaped
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBE
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBEARRAY)
                {
                    unsupported(`${instruction.name} on an undeclared or unsupported texture`);
                    break;
                }
                if (texture.multisampled)
                {
                    const sample = instruction.opcode === OPCODE.LD_MS && sampleIndex
                        ? `${i(sampleIndex)}.x`
                        : '0';
                    store(target, sampledBits(texture, resource,
                        `textureLoad(t${texture.slot}, ${shaped.coordinate}, ${sample})`));
                    break;
                }
                // A multisample view here is of a one-sample texture, whose
                // one level is its only level and whose sample 0 is its only
                // sample; any other sample reads as zero, as one out of
                // range does.
                const multisample = texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMS
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMSARRAY;
                const level = multisample ? '0' : `${i(address)}.w`;
                // An address past the level, the layers or the levels reads
                // zero in Direct3D; WebGPU answers any texel or zero.
                const name = `t${texture.slot}`;
                const at = held();
                const mip = held();
                // An immediate offset moves the texel read, before the range test.
                const offset = instruction.offset;
                const stepped = !offset ? '' : shaped.width === 3
                    ? ` + vec3<i32>(${offset[0]}, ${offset[1]}, ${offset[2]})`
                    : ` + vec2<i32>(${offset[0]}, ${shaped.row ? 0 : offset[1]})`;
                emit(`let ${at} = ${shaped.coordinate}${stepped};`);
                emit(`let ${mip} = ${level};`);
                const layer = shaped.layer === null ? null : held();
                if (layer)
                {
                    emit(`let ${layer} = ${shaped.layer};`);
                }
                const inside = [`u32(${mip}) < textureNumLevels(${name})`,
                    `all(vec${shaped.width}<u32>(${at}) < textureDimensions(${name}, u32(${mip})))`,
                    ...(layer ? [`u32(${layer}) < textureNumLayers(${name})`] : [])].join(' && ');
                const loaded = sampledBits(texture, resource, depthRead(texture,
                    `textureLoad(${name}, ${at}${layer === null ? '' : `, ${layer}`}, ${mip})`));
                const kept = `select(${REG}(0u), ${loaded}, ${inside})`;
                store(target, instruction.opcode === OPCODE.LD_MS && sampleIndex
                    ? `select(${kept}, ${REG}(0u), ${u(sampleIndex)}.x != 0u)`
                    : kept);
                break;
            }
            case OPCODE.LOD: {
                // WGSL has no query of the level of detail, so it is reckoned
                // as the specification defines it: the longer of the two
                // screen-space footprints in texels of level 0, its log2,
                // plus the sampler's bias; x held to the texture's levels,
                // y not. The sampler's MinLOD and MaxLOD are not seen here,
                // so x is held to the levels alone.
                const [target, coordinate, resource, sampler] = instruction.operands;
                if (!isPixel)
                {
                    unsupported('lod outside a pixel shader');
                    break;
                }
                const texture = textureOf(resource.indices[0].value);
                if (!texture || texture.multisampled
                    || texture.dimension === RESOURCE_DIMENSION.BUFFER
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMS
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMSARRAY)
                {
                    unsupported('lod on an undeclared or unsupported texture');
                    break;
                }
                const name = `t${texture.slot}`;
                const at = held();
                emit(`let ${at} = ${f(coordinate)};`);
                const size = `textureDimensions(${name}, 0)`;
                const dimension = texture.dimension;
                // The footprint along each axis, in texels, for a derivative.
                const footprint = dimension === RESOURCE_DIMENSION.TEXTURE1D
                    || dimension === RESOURCE_DIMENSION.TEXTURE1DARRAY
                    ? (/** @type {string} */ slope)=>
                        `vec2<f32>(${slope}(${at}.x) * f32(${size}.x), 0.0)`
                    : dimension === RESOURCE_DIMENSION.TEXTURE2D
                    || dimension === RESOURCE_DIMENSION.TEXTURE2DARRAY
                        ? (/** @type {string} */ slope)=>
                            `${slope}(${at}.xy) * vec2<f32>(${size})`
                        : dimension === RESOURCE_DIMENSION.TEXTURE3D
                            ? (/** @type {string} */ slope)=>
                                `${slope}(${at}.xyz) * vec3<f32>(${size})`
                            // A cube's face spans [-1, 1] of the minor axes
                            // over the major one: half the face's size a unit.
                            : (/** @type {string} */ slope)=>(need('cubeFaceSlope'),
                            `cubeFaceSlope(${at}.xyz, ${slope}(${at}.xyz))`
                                + ` * (0.5 * f32(${size}.x))`);
                const dx = held();
                const dy = held();
                emit(`let ${dx} = ${footprint('dpdx')};`);
                emit(`let ${dy} = ${footprint('dpdy')};`);
                const bias = options.samplerBias?.[sampler.indices[0].value] ?? 0;
                const raw = held();
                emit(`let ${raw} = 0.5 * log2(max(dot(${dx}, ${dx}), dot(${dy}, ${dy})))`
                    + `${bias ? ` + ${floatLiteral(bias)}` : ''};`);
                store(target, `bitcast<vec4<u32>>(vec4<f32>(clamp(${raw}, 0.0,`
                    + ` f32(textureNumLevels(${name}) - 1u)), ${raw}, 0.0, 0.0))`
                    + `.${swizzleText(resource.swizzle)}`);
                break;
            }
            case OPCODE.EVAL_CENTROID:
            case OPCODE.EVAL_SAMPLE_INDEX:
            case OPCODE.EVAL_SNAPPED: {
                // WGSL interpolates an input only where it is declared, so an
                // input is carried to another point of the pixel along its
                // screen-space slopes: v + dpdx(v) * dx + dpdy(v) * dy, from
                // where the input was interpolated. A pixel drawn whole has
                // its centroid at its centre, which is where it is taken.
                const [target, input, where] = instruction.operands;
                if (!isPixel)
                {
                    unsupported(`${instruction.name} outside a pixel shader`);
                    break;
                }
                if (instruction.opcode === OPCODE.EVAL_CENTROID)
                {
                    store(target, sat ? fromFloat(f(input), true) : moved(input));
                    break;
                }
                const value = held();
                const offset = held();
                emit(`let ${value} = ${f(input)};`);
                if (instruction.opcode === OPCODE.EVAL_SAMPLE_INDEX)
                {
                    result.rasterizerSamples = true;
                    need('samplePosition');
                    emit(`let ${offset} = samplePosition(rasterSamples, ${u(where)}.x);`);
                }
                else
                {
                    // Two signed four-bit sixteenths of a pixel, in the low
                    // bits of x and y.
                    emit(`let ${offset} = vec2<f32>((${i(where)}.xy << vec2<u32>(28u))`
                        + ' >> vec2<u32>(28u)) / 16.0;');
                }
                store(target, fromFloat(`${value} + dpdx(${value}) * ${offset}.x`
                    + ` + dpdy(${value}) * ${offset}.y`, sat));
                break;
            }
            case OPCODE.SAMPLE_INFO:
            case OPCODE.SAMPLE_POS: {
                const [target, resource, index] = instruction.operands;
                // The rasterizer's sample count, or the texture's: one for a
                // texture of one sample, none where none is declared.
                const rasterizer = resource.type === OPERAND.RASTERIZER;
                const texture = rasterizer ? null : textureOf(resource.indices[0].value);
                const count = rasterizer ? 'rasterSamples' : !texture ? '0u'
                    : texture.multisampled ? `textureNumSamples(t${texture.slot})` : '1u';
                result.rasterizerSamples ||= rasterizer;
                if (instruction.opcode === OPCODE.SAMPLE_INFO)
                {
                    // The count as a float, or as an integer with _uint.
                    const value = (instruction.control & 1) !== 0 ? count
                        : `bitcast<u32>(f32(${count}))`;
                    store(target,
                        `vec4<u32>(${value}, 0u, 0u, 0u).${swizzleText(resource.swizzle)}`);
                    break;
                }
                need('samplePosition');
                store(target, `bitcast<vec4<u32>>(vec4<f32>(samplePosition(${count},`
                    + ` ${u(index)}.x), 0.0, 0.0)).${swizzleText(resource.swizzle)}`);
                break;
            }
            case OPCODE.RESINFO: {
                const [target, level, resource] = instruction.operands;
                // A view written through is one level, measured without naming it.
                const written = resource.type === OPERAND.UNORDERED_ACCESS_VIEW
                    ? memoryOf(resource) : null;
                const view = written?.uav && written.uav.dimension !== RESOURCE_DIMENSION.BUFFER
                    ? written : null;
                const texture = view
                    ? /** @type {TextureDecl} */ ({ slot: resource.indices[0].value,
                        dimension: view.uav?.dimension ?? 0, returnType: RETURN_TYPE.FLOAT,
                        comparison: false, multisampled: true })
                    : resource.type === OPERAND.UNORDERED_ACCESS_VIEW ? null
                        : textureOf(resource.indices[0].value);
                const name = view ? view.name : texture ? `t${texture.slot}` : '';
                // A multisampled texture has one level and is measured without
                // naming it.
                const levels = texture?.multisampled ? '1u' : `textureNumLevels(${name})`;
                const wanted = `${u(level)}.x`;
                const size = held();
                const extent = texture ? extentFor(texture, size, name) : null;
                if (!texture || !extent)
                {
                    unsupported('resinfo on an undeclared or unsupported texture');
                    break;
                }
                // A level past the last answers zero for its sizes; the
                // array size and the level count are still the texture's.
                emit(texture.multisampled
                    ? `let ${size} = textureDimensions(${name});`
                    : `let ${size} = textureDimensions(${name}, min(${wanted}, ${levels} - 1u));`);
                const sizes = extent.sizes.map(component=>
                    `select(0u, ${component}, ${wanted} < ${levels})`);
                const mode = instruction.control & 0x3;
                /** @type {string[]} */
                const components = [...sizes];
                if (extent.layers)
                {
                    components.push(extent.layers);
                }
                while (components.length < 3)
                {
                    components.push('0u');
                }
                components.push(levels);
                let value;
                if (mode === 2)
                {
                    value = `${REG}(${components.join(', ')})`;
                }
                else
                {
                    // resinfo_rcpFloat answers the reciprocal of each size,
                    // and zero where there is no size to take it of.
                    const floated = components.map((component, index)=>(mode === 1
                        && index < sizes.length
                        ? `select(0.0, 1.0 / f32(${component}), ${component} != 0u)`
                        : `f32(${component})`));
                    value = `bitcast<${REG}>(vec4<f32>(${floated.join(', ')}))`;
                }
                store(target, `(${value}).${swizzleText(resource.swizzle)}`);
                break;
            }
            case OPCODE.GATHER4:
            case OPCODE.GATHER4_C:
            case OPCODE.GATHER4_PO:
            case OPCODE.GATHER4_PO_C: {
                // gather4_po and gather4_po_c take a register's offset after the
                // address; the _c forms a reference after the sampler.
                const programmed = instruction.opcode === OPCODE.GATHER4_PO
                    || instruction.opcode === OPCODE.GATHER4_PO_C;
                const compared = instruction.opcode === OPCODE.GATHER4_C
                    || instruction.opcode === OPCODE.GATHER4_PO_C;
                const at = { resource: programmed ? 3 : 2, sampler: programmed ? 4 : 3 };
                const resource = instruction.operands[at.resource];
                const gathered = textureOf(resource.indices[0].value);
                if (gathered && (gathered.returnType === RETURN_TYPE.UINT
                    || gathered.returnType === RETURN_TYPE.SINT
                    || gathered.dimension === RESOURCE_DIMENSION.TEXTURE1D
                    || gathered.dimension === RESOURCE_DIMENSION.TEXTURE1DARRAY
                    || gathered.dimension === RESOURCE_DIMENSION.TEXTURE3D))
                {
                    unsupported(`${instruction.name} on an integer, one- or three-dimensional`
                        + ' texture');
                    break;
                }
                if (compared && gathered)
                {
                    gathered.comparison = true;
                }
                // WGSL's offset is a constant: a register's moves the address
                // by that many texels of level 0, which a gather reads.
                const shift = programmed ? held() : null;
                if (shift && gathered)
                {
                    emit(`let ${shift} = vec2<f32>(${i(instruction.operands[2])}.xy)`
                        + ` / vec2<f32>(textureDimensions(t${gathered.slot}, 0).xy);`);
                }
                // The sampler's selected component is the channel gathered; the
                // resource's swizzle orders the four texels, as for any read.
                const channel = instruction.operands[at.sampler].swizzle?.[0] ?? 0;
                const reference = compared ? f(instruction.operands[at.sampler + 1]) : null;
                // The four texels in the order WGSL and Direct3D agree on; a
                // depth texture gathers its one channel, named by no component.
                sampleWith(instruction, (texture, shaped, sampler)=>{
                    const coordinate = shift ? `(${shaped.coordinate} + ${shift})`
                        : shaped.coordinate;
                    const layer = shaped.layer === null ? '' : `, ${shaped.layer}`;
                    if (reference)
                    {
                        return `textureGatherCompare(t${texture.slot}, ${sampler}, ${coordinate}`
                            + `${layer}, ${reference}.x${shaped.offset})`;
                    }
                    return `textureGather(${texture.depth ? '' : `${channel}, `}t${texture.slot}`
                        + `, ${sampler}, ${coordinate}${layer}${shaped.offset})`;
                }, at);
                break;
            }

            // --- Shader Model 5: memory read and written by the dword ---
            case OPCODE.LD_RAW:
            case OPCODE.LD_STRUCTURED: {
                const structured = instruction.opcode === OPCODE.LD_STRUCTURED;
                const source = structured ? c : b;
                const memory = memoryOf(source);
                if (!memory)
                {
                    unsupported(`${instruction.name} from undeclared memory`);
                    break;
                }
                if (memory.uav)
                {
                    memory.uav.loaded = true;
                }
                const word = wordOf(memory, `${u(a)}.x`, structured ? `${u(b)}.x` : null);
                const words = [0, 1, 2, 3].map(k=>`${memory.name}_word(${word}`
                    + `${k === 0 ? '' : ` + ${k}u`})`).join(', ');
                store(dest, `${REG}(${words}).${swizzleText(source.swizzle)}`);
                break;
            }
            case OPCODE.STORE_RAW:
            case OPCODE.STORE_STRUCTURED: {
                const structured = instruction.opcode === OPCODE.STORE_STRUCTURED;
                const memory = memoryOf(dest);
                if (!memory || memory.texture)
                {
                    unsupported(`${instruction.name} into undeclared memory`);
                    break;
                }
                const word = wordOf(memory, `${u(a)}.x`, structured ? `${u(b)}.x` : null);
                const value = held();
                emit(`let ${value} = ${u(structured ? c : b)};`);
                // The mask's components go to consecutive dwords.
                [...maskComponents(dest.mask)].forEach((component, k)=>{
                    emit(`${memory.name}_put(${word}${k === 0 ? '' : ` + ${k}u`},`
                        + ` ${value}.${COMPONENT[k]});`);
                });
                break;
            }
            case OPCODE.LD_UAV_TYPED: {
                const memory = memoryOf(b);
                const uav = memory?.uav;
                if (!memory || !uav)
                {
                    unsupported('ld_uav_typed from an undeclared view');
                    break;
                }
                uav.loaded = true;
                if (uav.dimension === RESOURCE_DIMENSION.BUFFER)
                {
                    store(dest, `${memory.name}_element(${u(a)}.x).${swizzleText(b.swizzle)}`);
                    break;
                }
                if (uav.words)
                {
                    const index = wordIndex(memory.name, uav, u(a));
                    store(dest, `${uav.packed ? `${memory.name}_unpack(${index})`
                        : `${REG}(${memory.name}_load(${index}), 0u, 0u, 1u)`}`
                        + `.${swizzleText(b.swizzle)}`);
                    break;
                }
                const at = storageCoordinate(uav, u(a));
                if (!at || !uav.format || !/^r32/.test(uav.format))
                {
                    unsupported('ld_uav_typed from a texture not of one 32-bit channel');
                    break;
                }
                const loaded = `textureLoad(${memory.name}, ${at.coordinate}`
                    + `${at.layer === null ? '' : `, ${at.layer}`})`;
                store(dest, `(${storageScalar(uav.format) === 'u32' ? loaded
                    : `bitcast<${REG}>(${loaded})`}).${swizzleText(b.swizzle)}`);
                break;
            }
            case OPCODE.STORE_UAV_TYPED: {
                const memory = memoryOf(dest);
                const uav = memory?.uav;
                if (!memory || !uav)
                {
                    unsupported('store_uav_typed into an undeclared view');
                    break;
                }
                if (uav.dimension === RESOURCE_DIMENSION.BUFFER)
                {
                    emit(`${memory.name}_storeElement(${u(a)}.x, ${u(b)});`);
                    break;
                }
                if (uav.words)
                {
                    const index = wordIndex(memory.name, uav, u(a));
                    emit(uav.packed ? `${memory.name}_pack(${index}, ${u(b)});`
                        : `${memory.name}_store(${index}, ${u(b)}.x);`);
                    break;
                }
                const at = storageCoordinate(uav, u(a));
                if (!at || !uav.format)
                {
                    unsupported('store_uav_typed into a texture of a format with no storage');
                    break;
                }
                const scalar = storageScalar(uav.format);
                const texel = scalar === 'u32' ? u(b) : `bitcast<vec4<${scalar}>>(${u(b)})`;
                emit(`textureStore(${memory.name}, ${at.coordinate}`
                    + `${at.layer === null ? '' : `, ${at.layer}`}, ${texel});`);
                break;
            }
            case OPCODE.ATOMIC_AND:
            case OPCODE.ATOMIC_OR:
            case OPCODE.ATOMIC_XOR:
            case OPCODE.ATOMIC_CMP_STORE:
            case OPCODE.ATOMIC_IADD:
            case OPCODE.ATOMIC_IMAX:
            case OPCODE.ATOMIC_IMIN:
            case OPCODE.ATOMIC_UMAX:
            case OPCODE.ATOMIC_UMIN:
            case OPCODE.IMM_ATOMIC_IADD:
            case OPCODE.IMM_ATOMIC_AND:
            case OPCODE.IMM_ATOMIC_OR:
            case OPCODE.IMM_ATOMIC_XOR:
            case OPCODE.IMM_ATOMIC_EXCH:
            case OPCODE.IMM_ATOMIC_CMP_EXCH:
            case OPCODE.IMM_ATOMIC_IMAX:
            case OPCODE.IMM_ATOMIC_IMIN:
            case OPCODE.IMM_ATOMIC_UMAX:
            case OPCODE.IMM_ATOMIC_UMIN: {
                const immediate = instruction.opcode >= OPCODE.IMM_ATOMIC_IADD;
                const [target, ...rest] = immediate ? instruction.operands.slice(1)
                    : instruction.operands;
                const op = instruction.name.replace(/^(imm_)?atomic_/, '').replace('cmp_store',
                    'cmp_exch');
                const memory = memoryOf(target);
                if (!memory)
                {
                    unsupported(`${instruction.name} on undeclared memory`);
                    break;
                }
                const address = rest[0];
                const structured = memory.stride > 0;
                const typedView = memory.uav?.structure === 'typed';
                // A typed buffer view's address is an element: a dword, its
                // format one channel of 32 bits; a typed texture's, a texel.
                const element = typedView ? `${u(address)}.x` : null;
                const word = memory.uav?.words ? wordIndex(memory.name, memory.uav, u(address))
                    : element ?? wordOf(memory, `${u(address)}.x`,
                        structured ? `${u(address)}.y` : null);
                const compare = op === 'cmp_exch' ? `${u(rest[1])}.x` : '0u';
                const value = `${u(rest[op === 'cmp_exch' ? 2 : 1])}.x`;
                const old = atomicOn(memory, op, word, value, compare);
                if (immediate)
                {
                    store(dest, `${REG}(${old})`);
                }
                else
                {
                    emit(`_ = ${old};`);
                }
                break;
            }
            case OPCODE.IMM_ATOMIC_ALLOC:
            case OPCODE.IMM_ATOMIC_CONSUME: {
                // An append or consume buffer's declaration carries no flag
                // (fxc sets one only for an order-preserving counter): any
                // structured view counts through the view's hidden counter.
                const memory = memoryOf(a);
                if (!memory?.uav || memory.uav.structure !== 'structured')
                {
                    unsupported(`${instruction.name} on a view with no counter`);
                    break;
                }
                memory.uav.counted = true;
                store(dest, instruction.opcode === OPCODE.IMM_ATOMIC_ALLOC
                    ? `${REG}(atomicAdd(&${memory.name}count, 1u))`
                    : `${REG}(atomicSub(&${memory.name}count, 1u) - 1u)`);
                break;
            }
            case OPCODE.SYNC: {
                const flags = instruction.control & 0xf;
                if (!isCompute)
                {
                    // A pixel shader fences its own writes, which WGSL's
                    // fragment stage keeps in order already.
                    break;
                }
                if ((flags & (SYNC_FLAG.UAV_MEMORY_GROUP | SYNC_FLAG.UAV_MEMORY_GLOBAL)) !== 0)
                {
                    emit('storageBarrier();');
                }
                if ((flags & (SYNC_FLAG.THREADS_IN_GROUP | SYNC_FLAG.THREAD_GROUP_SHARED_MEMORY))
                    !== 0)
                {
                    emit('workgroupBarrier();');
                }
                break;
            }
            case OPCODE.BUFINFO: {
                // A typed buffer view answers its element count, which its
                // view uniform holds.
                const viewed = a.type === OPERAND.RESOURCE ? textureOf(a.indices[0]?.value ?? -1)
                    : null;
                if (viewed && !viewed.structure && viewed.dimension === RESOURCE_DIMENSION.BUFFER)
                {
                    store(dest, `${REG}(t${viewed.slot}view.z)`);
                    break;
                }
                const memory = memoryOf(a);
                const uav = memory?.uav;
                if (!memory || (uav && uav.dimension !== RESOURCE_DIMENSION.BUFFER))
                {
                    unsupported('bufinfo on what is not a buffer');
                    break;
                }
                const count = memory.stride > 0 ? `(${memory.name}view.z)`
                    : memory.uav?.structure === 'typed' ? `${memory.name}view.z`
                        : `(${memory.name}view.z * ${memory.name}view.w)`;
                store(dest, `${REG}(${count})`);
                break;
            }

            // --- Shader Model 5: bits and halves ---
            case OPCODE.COUNTBITS:
                store(dest, `countOneBits(${u(a)})`);
                break;
            case OPCODE.FIRSTBIT_HI:
                // Counted from the high bit, as the instruction does; none set is ~0.
                store(dest, `select(countLeadingZeros(${u(a)}), ${REG}(0xffffffffu),`
                    + ` ${u(a)} == ${REG}(0u))`);
                break;
            case OPCODE.FIRSTBIT_SHI: {
                const value = held();
                emit(`let ${value} = ${u(a)};`);
                const flipped = `(${value} ^ bitcast<${REG}>(bitcast<vec4<i32>>(${value})`
                    + ` >> ${REG}(31u)))`;
                store(dest, `select(countLeadingZeros(${flipped}), ${REG}(0xffffffffu),`
                    + ` ${flipped} == ${REG}(0u))`);
                break;
            }
            case OPCODE.FIRSTBIT_LO:
                store(dest, `firstTrailingBit(${u(a)})`);
                break;
            case OPCODE.UBFE:
                store(dest, perComponent((width, offset, value)=>
                    `extractBits(${value}, ${offset} & 31u, ${width} & 31u)`, [u(a), u(b), u(c)]));
                break;
            case OPCODE.IBFE:
                store(dest, perComponent((width, offset, value)=>`bitcast<u32>(extractBits(`
                    + `bitcast<i32>(${value}), ${offset} & 31u, ${width} & 31u))`,
                [u(a), u(b), u(c)]));
                break;
            case OPCODE.BFI:
                store(dest, perComponent((width, offset, insert, base)=>
                    `insertBits(${base}, ${insert}, ${offset} & 31u, ${width} & 31u)`,
                [u(a), u(b), u(c), u(instruction.operands[4])]));
                break;
            case OPCODE.BFREV:
                store(dest, `reverseBits(${u(a)})`);
                break;
            case OPCODE.UADDC:
            case OPCODE.USUBB: {
                const [sum, carry, left, right] = instruction.operands;
                const x = held();
                const y = held();
                emit(`let ${x} = ${u(left)};`);
                emit(`let ${y} = ${u(right)};`);
                const add = instruction.opcode === OPCODE.UADDC;
                const result2 = held();
                emit(`let ${result2} = ${add ? `${x} + ${y}` : `${x} - ${y}`};`);
                store(sum, result2);
                store(carry, `select(${REG}(0u), ${REG}(1u), ${add ? `${result2} < ${x}`
                    : `${x} < ${y}`})`);
                break;
            }
            case OPCODE.F32TOF16:
                store(dest, perComponent(value=>
                    `(pack2x16float(vec2<f32>(bitcast<f32>(${value}), 0.0)) & 0xffffu)`, [u(a)]));
                break;
            case OPCODE.F16TOF32:
                store(dest, perComponent(value=>
                    `bitcast<u32>(unpack2x16float(${value} & 0xffffu).x)`, [u(a)]));
                break;
            case OPCODE.RCP:
                store(dest, fromFloat(`(vec4<f32>(1.0) / ${f(a)})`, sat));
                break;
            case OPCODE.SWAPC: {
                const [first, second, condition, left, right] = instruction.operands;
                const test = held();
                const x = held();
                const y = held();
                emit(`let ${test} = ${u(condition)} != ${REG}(0u);`);
                emit(`let ${x} = ${moved(left)};`);
                emit(`let ${y} = ${moved(right)};`);
                store(first, `select(${x}, ${y}, ${test})`);
                store(second, `select(${y}, ${x}, ${test})`);
                break;
            }
            case OPCODE.DERIV_RTX_COARSE:
                store(dest, fromFloat(`dpdxCoarse(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTX_FINE:
                store(dest, fromFloat(`dpdxFine(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY_COARSE:
                store(dest, fromFloat(`dpdyCoarse(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY_FINE:
                store(dest, fromFloat(`dpdyFine(${f(a)})`, sat));
                break;

            // A geometry shader's vertices: what its outputs hold is a vertex of
            // the stream (`gsEmit`), and a cut ends the strip it is building.
            case OPCODE.EMIT:
            case OPCODE.EMITTHENCUT:
            case OPCODE.CUT:
            case OPCODE.EMIT_STREAM:
            case OPCODE.EMITTHENCUT_STREAM:
            case OPCODE.CUT_STREAM: {
                if (!isGeometry)
                {
                    unsupported(instruction.name);
                    break;
                }
                const streamed = instruction.opcode >= OPCODE.EMIT_STREAM;
                const stream = streamed ? dest.indices[0].value : 0;
                if (instruction.opcode !== OPCODE.CUT && instruction.opcode !== OPCODE.CUT_STREAM)
                {
                    emit(`gsEmit(${stream}u);`);
                }
                if (instruction.opcode !== OPCODE.EMIT && instruction.opcode !== OPCODE.EMIT_STREAM)
                {
                    emit(`gsCut(${stream}u);`);
                }
                break;
            }

            // A range of registers indexed into: a hull shader's outputs and a
            // geometry shader's vertices are arrays already; another stage's
            // inputs are copied into one once they are loaded, its outputs
            // written through a switch (`indexRanges`).
            case OPCODE.DCL_INDEX_RANGE: {
                const count = instruction.extra[0] ?? 0;
                if (isHull || (isGeometry && dest.type === OPERAND.INPUT
                    && dest.indices.length > 1))
                {
                    break;
                }
                if (dest.type === OPERAND.INPUT && dest.indices.length === 1)
                {
                    const first = dest.indices[0].value;
                    indexRanges.push({ type: OPERAND.INPUT, first, count });
                    result.inputRegisters = Math.max(result.inputRegisters, first + count);
                    emit(`var vr${first} = array<${REG}, ${count}>(${Array.from({ length: count },
                        (_, place)=>`v${first + place}`).join(', ')});`);
                    break;
                }
                if (dest.type === OPERAND.OUTPUT && dest.indices.length === 1)
                {
                    const first = dest.indices[0].value;
                    indexRanges.push({ type: OPERAND.OUTPUT, first, count });
                    result.outputRegisters = Math.max(result.outputRegisters, first + count);
                    break;
                }
                unsupported(instruction.name);
                break;
            }

            default:
                unsupported(instruction.name);
                break;
        }
    };

    translateBlock(firstLabel < 0 ? instructions : instructions.slice(0, firstLabel),
        { returned: null, main: true });
    return result;
}

/**
 * @param {TextureDecl} texture
 * @returns {{ type: string, sampleType: string, viewDimension: string,
 *             multisampled?: boolean } | null}
 */
function textureType(texture){
    const sampled = texture.returnType === RETURN_TYPE.UINT
        ? { scalar: 'u32', sampleType: 'uint' }
        : texture.returnType === RETURN_TYPE.SINT
            ? { scalar: 'i32', sampleType: 'sint' }
            : { scalar: 'f32', sampleType: 'float' };
    // WebGPU's one-dimensional texture has one level and no layers, so a
    // Direct3D one, which may have both, is kept as a two-dimensional texture
    // one row high; and every texture here has one sample, so a multisample
    // view of one is a plain view of it.
    /** @type {Record<number, [string, string]>} */
    const shapes = {
        [RESOURCE_DIMENSION.TEXTURE1D]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE1DARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURE2D]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE2DMS]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE3D]: ['3d', '3d'],
        [RESOURCE_DIMENSION.TEXTURECUBE]: ['cube', 'cube'],
        [RESOURCE_DIMENSION.TEXTURE2DARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURE2DMSARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURECUBEARRAY]: ['cube_array', 'cube-array'],
    };
    const shape = shapes[texture.dimension];
    if (!shape)
    {
        return null;
    }
    if (texture.multisampled)
    {
        // A multisampled float texture is never filtered, and WebGPU binds it
        // only as unfilterable.
        return texture.comparison ? null : {
            type: `texture_multisampled_2d<${sampled.scalar}>`,
            sampleType: sampled.sampleType === 'float' ? 'unfilterable-float' : sampled.sampleType,
            viewDimension: '2d',
            multisampled: true,
        };
    }
    if (texture.comparison || texture.depth)
    {
        return {
            type: `texture_depth_${shape[0]}`, sampleType: 'depth', viewDimension: shape[1],
        };
    }
    return {
        type: `texture_${shape[0]}<${sampled.scalar}>`,
        sampleType: sampled.sampleType,
        viewDimension: shape[1],
    };
}

/**
 * @typedef {Object} BindGroupLayoutEntry
 * @property {number} binding
 * @property {number} visibility
 * @property {{ type: string, minBindingSize?: number }} [buffer]
 * @property {{ access: string, format: string, viewDimension: string }} [storageTexture]
 * @property {{ sampleType: string, viewDimension: string, multisampled?: boolean }} [texture]
 * @property {{ type: string }} [sampler]
 */

/**
 * The store and load of a view whose texels are packed in its words
 * (`PACKED_TEXELS`), by texel index (`_index`, all ones past the view): a
 * texel narrower than a word is cleared and set in its part of one, each an
 * atomic, so the other texels of the word, stored at once, are kept. A load
 * past the view reads zeros.
 *
 * @param {string} name @param {string | undefined} packed
 * @returns {string[]}
 */
function packedAccessors(name, packed){
    const texel = packed ? PACKED_TEXELS[packed] : null;
    if (!texel)
    {
        return [];
    }
    const lanes = 4 / texel.bytes;
    const mask = texel.bytes === 4 ? '0xffffffffu' : `${(1 << (texel.bytes * 8)) - 1}u`;
    const part = lanes === 1 ? ['let w = i;', 'let shift = 0u;']
        : [`let w = i / ${lanes}u;`, `let shift = (i % ${lanes}u) * ${texel.bytes * 8}u;`];
    return [
        `fn ${name}_pack(i: u32, v: vec4<u32>) {`,
        '    if (i == 0xffffffffu) { return; }',
        ...part.map(line=>`    ${line}`),
        `    if (w >= arrayLength(&${name})) { return; }`,
        `    let bits = (${texel.pack}) & ${mask};`,
        ...(lanes === 1 ? [`    atomicStore(&${name}[w], bits);`] : [
            `    atomicAnd(&${name}[w], ~(${mask} << shift));`,
            `    atomicOr(&${name}[w], bits << shift);`]),
        '}',
        `fn ${name}_unpack(i: u32) -> vec4<u32> {`,
        '    if (i == 0xffffffffu) { return vec4<u32>(0u); }',
        ...part.map(line=>`    ${line}`),
        `    if (w >= arrayLength(&${name})) { return vec4<u32>(0u); }`,
        `    let b = (atomicLoad(&${name}[w]) >> shift) & ${mask};`,
        `    return ${texel.unpack};`,
        '}',
    ];
}

/**
 * The module-scope declarations of one stage: its bindings and its immediate
 * constants.
 *
 * @param {TranslatedShader} shader
 * @param {number} group
 * @param {number} visibility
 * @returns {{ text: string[], entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
function declarations(shader, group, visibility){
    /** @type {string[]} */
    const text = [];
    /** @type {BindGroupLayoutEntry[]} */
    const entries = [];
    /** @type {string[]} */
    const problems = [];
    for (const buffer of shader.constantBuffers)
    {
        const binding = BINDING.CONSTANT_BUFFER + buffer.slot;
        text.push(`@group(${group}) @binding(${binding}) var<uniform> cb${buffer.slot}: `
            + `array<${REG}, ${Math.max(1, buffer.size)}>;`);
        // The bytes the declaration reads: what a binding must have at least,
        // which the renderer holds a smaller buffer to (`render.js`).
        entries.push({ binding, visibility,
            buffer: { type: 'uniform', minBindingSize: Math.max(1, buffer.size) * 16 } });
    }
    for (const texture of shader.textures)
    {
        if (texture.structure)
        {
            const name = `t${texture.slot}`;
            text.push(
                `@group(${group}) @binding(${BINDING.TEXTURE + texture.slot})`
                    + ` var<storage, read> ${name}: array<u32>;`,
                `@group(${group}) @binding(${BINDING.BUFFER_VIEW + texture.slot})`
                    + ` var<uniform> ${name}view: ${REG};`,
                ...wordAccessors(name, false, `${name}view`));
            entries.push({ binding: BINDING.TEXTURE + texture.slot, visibility,
                buffer: { type: 'read-only-storage' } });
            entries.push({ binding: BINDING.BUFFER_VIEW + texture.slot, visibility,
                buffer: { type: 'uniform' } });
            continue;
        }
        if (texture.dimension === RESOURCE_DIMENSION.BUFFER)
        {
            // The element is found and bounds-checked here, where the
            // binding's name is known, and decoded by the shared helper. An
            // index past the view reads zero, as Direct3D defines it.
            const binding = BINDING.TEXTURE + texture.slot;
            const view = BINDING.BUFFER_VIEW + texture.slot;
            const name = `t${texture.slot}`;
            text.push(
                `@group(${group}) @binding(${binding}) var<storage, read> ${name}: array<u32>;`,
                `@group(${group}) @binding(${view}) var<uniform> ${name}view: ${REG};`,
                `fn load${name}(index: u32) -> ${REG} {`,
                `    if (index >= ${name}view.z) { return ${REG}(0u); }`,
                `    let byte = (${name}view.y + index) * ${name}view.w;`,
                '    let at = byte / 4u;',
                `    let last = arrayLength(&${name}) - 1u;`,
                `    let words = ${REG}(${name}[min(at, last)], ${name}[min(at + 1u, last)],`
                    + ` ${name}[min(at + 2u, last)], ${name}[min(at + 3u, last)]);`,
                `    return bufferElement(${name}view.x, words, (byte % 4u) * 8u);`,
                '}');
            entries.push({ binding, visibility, buffer: { type: 'read-only-storage' } });
            entries.push({ binding: view, visibility, buffer: { type: 'uniform' } });
            continue;
        }
        const type = textureType(texture);
        if (!type)
        {
            problems.push(`texture dimension ${texture.dimension}`);
            continue;
        }
        const binding = BINDING.TEXTURE + texture.slot;
        text.push(`@group(${group}) @binding(${binding}) var t${texture.slot}: ${type.type};`);
        entries.push({
            binding,
            visibility,
            texture: type.multisampled
                ? { sampleType: type.sampleType, viewDimension: type.viewDimension,
                    multisampled: true }
                : { sampleType: type.sampleType, viewDimension: type.viewDimension },
        });
    }
    for (const sampler of shader.samplers)
    {
        const binding = BINDING.SAMPLER + sampler.slot;
        text.push(`@group(${group}) @binding(${binding}) var s${sampler.slot}: `
            + `${sampler.comparison ? 'sampler_comparison' : 'sampler'};`);
        entries.push({
            binding, visibility, sampler: { type: sampler.comparison ? 'comparison'
                : sampler.nonFiltering ? 'non-filtering' : 'filtering' },
        });
    }
    for (const uav of shader.uavs ?? [])
    {
        const name = `u${uav.slot}`;
        const binding = BINDING.UAV + uav.slot;
        if (uav.words)
        {
            // Its view uniform: texels a row, rows a layer, width, layers.
            text.push(`@group(${group}) @binding(${binding}) var<storage, read_write> ${name}: `
                + 'array<atomic<u32>>;',
            `@group(${group}) @binding(${BINDING.UAV_VIEW + uav.slot}) var<uniform> ${name}view:`
                + ` ${REG};`,
            `fn ${name}_index(c: ${REG}) -> u32 {`,
            `    if (c.x >= ${name}view.z || c.y >= ${name}view.y || c.z >= ${name}view.w)`
                + ' { return 0xffffffffu; }',
            `    return (c.z * ${name}view.y + c.y) * ${name}view.x + c.x;`,
            '}',
            `fn ${name}_load(i: u32) -> u32 {`,
            `    if (i >= arrayLength(&${name})) { return 0u; }`,
            `    return atomicLoad(&${name}[i]);`,
            '}',
            `fn ${name}_store(i: u32, value: u32) {`,
            `    if (i < arrayLength(&${name})) { atomicStore(&${name}[i], value); }`,
            '}',
            ...packedAccessors(name, uav.packed),
            ...[...uav.atomicOps ?? []].flatMap(op=>atomicAccessor(name, op, true, null, -1)));
            entries.push({ binding, visibility, buffer: { type: 'storage' } });
            entries.push({ binding: BINDING.UAV_VIEW + uav.slot, visibility,
                buffer: { type: 'uniform' } });
            continue;
        }
        if (uav.dimension !== RESOURCE_DIMENSION.BUFFER)
        {
            const shape = /** @type {Record<number, string[]>} */ (STORAGE_SHAPE)[uav.dimension];
            if (!uav.format || !shape)
            {
                problems.push(`a typed view of dimension ${uav.dimension} in no storage format`);
                continue;
            }
            const access = uav.loaded ? 'read_write' : 'write';
            text.push(`@group(${group}) @binding(${binding}) var ${name}: `
                + `texture_storage_${shape[0]}<${uav.format}, ${access}>;`);
            entries.push({ binding, visibility, storageTexture: {
                access: uav.loaded ? 'read-write' : 'write-only', format: uav.format,
                viewDimension: shape[1] } });
            continue;
        }
        text.push(`@group(${group}) @binding(${binding}) var<storage, read_write> ${name}: `
            + `array<${uav.atomic ? 'atomic<u32>' : 'u32'}>;`,
        `@group(${group}) @binding(${BINDING.UAV_VIEW + uav.slot}) var<uniform> ${name}view:`
            + ` ${REG};`,
        ...wordAccessors(name, uav.atomic, `${name}view`),
        ...[...uav.atomicOps ?? []].flatMap(op=>atomicAccessor(name, op, uav.atomic,
            `${name}view`)));
        entries.push({ binding, visibility, buffer: { type: 'storage' } });
        entries.push({ binding: BINDING.UAV_VIEW + uav.slot, visibility,
            buffer: { type: 'uniform' } });
        if (uav.structure === 'typed')
        {
            text.push(
                `fn ${name}_element(index: u32) -> ${REG} {`,
                `    let byte = index * ${name}view.w;`,
                '    let w = byte / 4u;',
                `    if (index >= ${name}view.z) { return ${REG}(0u); }`,
                `    return bufferElement(${name}view.x, ${REG}(${name}_word(w), `
                    + `${name}_word(w + 1u), ${name}_word(w + 2u), ${name}_word(w + 3u)),`
                    + ' (byte % 4u) * 8u);',
                '}',
                `fn ${name}_storeElement(index: u32, value: ${REG}) {`,
                `    if (index >= ${name}view.z) { return; }`,
                `    let e = storeElement(${name}view.x, value);`,
                `    let n = storeElementCount(${name}view.x);`,
                `    let w = (index * ${name}view.w) / 4u;`,
                `    if (n > 0u) { ${name}_put(w, e.x); }`,
                `    if (n > 1u) { ${name}_put(w + 1u, e.y); }`,
                `    if (n > 2u) { ${name}_put(w + 2u, e.z); }`,
                `    if (n > 3u) { ${name}_put(w + 3u, e.w); }`,
                '}');
        }
        if (uav.counted)
        {
            text.push(`@group(${group}) @binding(${BINDING.UAV_COUNTER + uav.slot})`
                + ` var<storage, read_write> ${name}count: atomic<u32>;`);
            entries.push({ binding: BINDING.UAV_COUNTER + uav.slot, visibility,
                buffer: { type: 'storage' } });
        }
    }
    for (const shared of shader.sharedMemory ?? [])
    {
        const name = `g${shared.slot}`;
        text.push(`var<workgroup> ${name}: array<${shared.atomic ? 'atomic<u32>' : 'u32'}, `
            + `${Math.max(1, shared.words)}>;`,
        ...wordAccessors(name, shared.atomic, null, shared.words),
        ...[...shared.atomicOps ?? []].flatMap(op=>atomicAccessor(name, op, shared.atomic,
            null, shared.words)));
    }
    if (shader.immediateConstants.length > 0)
    {
        const rows = shader.immediateConstants
            .map(row=>`${REG}(${row.map(u32Literal).join(', ')})`);
        text.push(`const icb = array<${REG}, ${rows.length}>(${rows.join(', ')});`);
    }
    for (const helper of shader.helpers)
    {
        text.push(...HELPERS[helper].text);
    }
    return { text, entries, unsupported: problems };
}

/** A typed view's WGSL storage shape, by its RESOURCE_DIMENSION; one dimension is a row. */
const STORAGE_SHAPE = Object.freeze({
    [RESOURCE_DIMENSION.TEXTURE1D]: ['2d', '2d'],
    [RESOURCE_DIMENSION.TEXTURE2D]: ['2d', '2d'],
    [RESOURCE_DIMENSION.TEXTURE1DARRAY]: ['2d_array', '2d-array'],
    [RESOURCE_DIMENSION.TEXTURE2DARRAY]: ['2d_array', '2d-array'],
    [RESOURCE_DIMENSION.TEXTURE3D]: ['3d', '3d'],
});

/**
 * A memory's dword accessors: a read past its end answers zero and a write
 * past it is dropped, as Direct3D defines an access out of bounds. A view
 * reaches from its first element for its count of them; shared memory is
 * all of itself.
 *
 * @param {string} name @param {boolean} atomic
 * @param {string | null} view  the uniform of the view's first element, count and size
 * @param {number} [words]  shared memory's size
 * @returns {string[]}
 */
function wordAccessors(name, atomic, view, words = 0){
    const bounds = view === null
        ? [`    if (i >= ${words}u) { return 0u; }`, '    let at = i;']
        : [`    if (i >= (${view}.z * ${view}.w) / 4u) { return 0u; }`,
            `    let at = (${view}.y * ${view}.w) / 4u + i;`,
            `    if (at >= arrayLength(&${name})) { return 0u; }`];
    const read = atomic ? `atomicLoad(&${name}[at])` : `${name}[at]`;
    const lines = [
        `fn ${name}_word(i: u32) -> u32 {`,
        ...bounds,
        `    return ${read};`,
        '}',
    ];
    if (view === null || !name.startsWith('t'))
    {
        lines.push(`fn ${name}_put(i: u32, value: u32) {`,
            ...bounds.map(line=>line.replace('return 0u;', 'return;')),
            atomic ? `    atomicStore(&${name}[at], value);` : `    ${name}[at] = value;`,
            '}');
    }
    return lines;
}

/**
 * One atomic operation on a memory's dword: the value it held before. A
 * signed minimum or maximum is a compare-and-swap loop over the unsigned
 * dword, and a compare-exchange retries the weak exchange WGSL has until it
 * either swapped or found another value.
 *
 * @param {string} name @param {string} op @param {boolean} atomic
 * @param {string | null} view @param {number} [words]  negative: the array's length
 * @returns {string[]}
 */
function atomicAccessor(name, op, atomic, view, words = 0){
    void atomic;
    const bounds = view === null
        ? [`    if (i >= ${words < 0 ? `arrayLength(&${name})` : `${words}u`}) { return 0u; }`,
            '    let at = i;']
        : [`    if (i >= (${view}.z * ${view}.w) / 4u) { return 0u; }`,
            `    let at = (${view}.y * ${view}.w) / 4u + i;`,
            `    if (at >= arrayLength(&${name})) { return 0u; }`];
    const pointer = `&${name}[at]`;
    /** @type {Record<string, string[]>} */
    const bodies = {
        iadd: [`    return atomicAdd(${pointer}, value);`],
        and: [`    return atomicAnd(${pointer}, value);`],
        or: [`    return atomicOr(${pointer}, value);`],
        xor: [`    return atomicXor(${pointer}, value);`],
        umax: [`    return atomicMax(${pointer}, value);`],
        umin: [`    return atomicMin(${pointer}, value);`],
        exch: [`    return atomicExchange(${pointer}, value);`],
        cmp_exch: [
            '    loop {',
            `        let r = atomicCompareExchangeWeak(${pointer}, compare, value);`,
            '        if (r.exchanged || r.old_value != compare) { return r.old_value; }',
            '    }',
        ],
        imax: signedLoop(pointer, 'max'),
        imin: signedLoop(pointer, 'min'),
    };
    return [
        `fn ${name}_atomic_${op}(i: u32, value: u32, compare: u32) -> u32 {`,
        ...bounds,
        ...bodies[op],
        '}',
    ];
}

/** @param {string} pointer @param {'max' | 'min'} which @returns {string[]} */
function signedLoop(pointer, which){
    return [
        '    loop {',
        `        let old = atomicLoad(${pointer});`,
        `        let next = bitcast<u32>(${which}(bitcast<i32>(old), bitcast<i32>(value)));`,
        `        let r = atomicCompareExchangeWeak(${pointer}, old, next);`,
        '        if (r.exchanged) { return old; }',
        '    }',
    ];
}

/**
 * A compute shader's module: its declarations, all in group 0, and the
 * entry point at its thread group's size, its thread ids the registers the
 * body reads them as.
 *
 * @param {TranslatedShader} cs
 * @returns {{ code: string, entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
export function linkCompute(cs){
    const declared = declarations(cs, 0, STAGE.COMPUTE);
    const [x, y, z] = cs.threadGroup.map(size=>Math.max(1, size >>> 0));
    const code = [
        ...declared.text,
        `@compute @workgroup_size(${x}, ${y}, ${z})`,
        'fn computeMain(@builtin(global_invocation_id) csThreadId: vec3<u32>,',
        '    @builtin(workgroup_id) csGroupId: vec3<u32>,',
        '    @builtin(local_invocation_id) csLocalId: vec3<u32>,',
        '    @builtin(local_invocation_index) csFlat: u32) {',
        `    let csThread = ${REG}(csThreadId, 0u);`,
        `    let csGroup = ${REG}(csGroupId, 0u);`,
        `    let csLocal = ${REG}(csLocalId, 0u);`,
        ...registerDeclarations(cs),
        ...bodyText(cs, null),
        '}',
    ].join('\n');
    return { code, entries: declared.entries,
        unsupported: [...cs.unsupported, ...declared.unsupported] };
}

/** @param {number} componentType @returns {string} */
function scalarOf(componentType){
    return componentType === COMPONENT_TYPE.UINT
        ? 'u32'
        : componentType === COMPONENT_TYPE.SINT ? 'i32' : 'f32';
}

/**
 * The registers a body declares and the `let`s that fill them, shared by both
 * entry points.
 *
 * @param {TranslatedShader} shader
 * @returns {string[]}
 */
function registerDeclarations(shader){
    /** @type {string[]} */
    const lines = [];
    for (let index = 0; index < shader.temps; index++)
    {
        lines.push(`    var r${index}: ${REG};`);
    }
    for (const temp of shader.indexableTemps)
    {
        lines.push(`    var x${temp.index}: array<${REG}, ${temp.size}>;`);
    }
    for (let index = 0; index < shader.outputRegisters; index++)
    {
        lines.push(`    var o${index}: ${REG};`);
    }
    return lines;
}

/**
 * @param {TranslatedShader} shader
 * @param {string | null} returnExpression  Null for an entry point that returns nothing.
 * @param {string} [beforeReturn]  A statement made at each return, before it.
 * @returns {string[]}
 */
function bodyText(shader, returnExpression, beforeReturn = ''){
    return shader.body.map(line=>(typeof line === 'string'
        ? line
        : `    ${beforeReturn ? `{ ${beforeReturn} ` : ''}return${returnExpression === null ? ''
            : ` ${returnExpression}`};${beforeReturn ? ' }' : ''}`));
}

/** @param {import('./dxbc.js').SignatureElement} element */
const semanticKey = element=>`${element.name.toUpperCase()}${element.index}`;

/**
 * @typedef {Object} LinkedProgram
 * @property {string} vertex        WGSL, entry point `vertexMain`.
 * @property {string} fragment      WGSL, entry point `fragmentMain`.
 * @property {BindGroupLayoutEntry[][]} groups  One entry list per stage: vertex, then fragment.
 * @property {{ location: number, semantic: string, index: number, componentType: number }[]}
 *           attributes  The vertex inputs, for the input layout to match against.
 * @property {number[]} targets     The render targets the pixel shader writes.
 * @property {string[]} unsupported Why the pair cannot be built, if it cannot.
 */

/**
 * WGSL's interpolation of a float varying, by Direct3D's interpolation mode:
 * constant, linear, its centroid, without perspective, its centroid, at each
 * sample, without perspective at each sample.
 */
const INTERPOLATION = Object.freeze(/** @type {Record<number, string>} */ ({
    1: ' @interpolate(flat)',
    3: ' @interpolate(perspective, centroid)',
    4: ' @interpolate(linear)',
    5: ' @interpolate(linear, centroid)',
    6: ' @interpolate(perspective, sample)',
    7: ' @interpolate(linear, sample)',
}));

/** The members a primitive's render target array index and viewport index travel as. */
const ROUTES = Object.freeze(/** @type {Record<number, string>} */ ({
    [SYSTEM_VALUE.RENDER_TARGET_ARRAY_INDEX]: 'rtLayer',
    [SYSTEM_VALUE.VIEWPORT_ARRAY_INDEX]: 'rtViewport',
}));

/**
 * Vertex streams the vertex stage reads from storage as words, where WebGPU
 * cannot fetch them as vertex buffers: a stride or element offset it does
 * not align, or per-instance data stepping once every several instances.
 * Each stream is bound at `BINDING.VERTEX_PULL` + its index, and
 * `BINDING.VERTEX_PULL_PARAMS` holds a vec4 a stream: the byte where element
 * zero starts, the stride, the bytes the buffer holds, and the draw's first
 * instance.
 *
 * @typedef {Object} VertexPull
 * @property {{ stepMode: 'vertex' | 'instance', rate: number }[]} streams
 *     `rate`: the instances each per-instance element serves; 0 serves them all.
 * @property {{ semantic: string, index: number, stream: number, offset: number,
 *     format: string }[]} attributes
 * @property {boolean} [vertexBase]  The vertex ID is the vertex index less the vec4 past
 *     the streams' x: the draw's first vertex, or its base vertex where it has indices -
 *     Direct3D's ID counts neither, WebGPU's index both.
 */

/**
 * The declarations, loads and layout entries of the streams a vertex stage
 * reads itself, filling the registers of the inputs they carry.
 *
 * @param {VertexPull} pull
 * @param {import('./dxbc.js').SignatureElement[]} inputs
 * @param {number} registers  the vertex shader's input registers
 * @returns {{ text: string[], load: string[], entries: BindGroupLayoutEntry[],
 *     pulled: Set<number>, unsupported: string[] }}
 */
function vertexPullOf(pull, inputs, registers){
    /** @type {string[]} */
    const unsupported = [];
    const count = Math.max(1, pull.streams.length + (pull.vertexBase ? 1 : 0));
    const text = [
        `@group(0) @binding(${BINDING.VERTEX_PULL_PARAMS}) var<uniform> vsPulls:`
            + ` array<${REG}, ${count}>;`,
    ];
    /** @type {BindGroupLayoutEntry[]} */
    const entries = [{ binding: BINDING.VERTEX_PULL_PARAMS, visibility: STAGE.VERTEX,
        buffer: { type: 'uniform' } }];
    /** @type {string[]} */
    const load = [];
    pull.streams.forEach((stream, k)=>{
        text.push(`@group(0) @binding(${BINDING.VERTEX_PULL + k}) var<storage, read> vsPull${k}:`
            + ' array<u32>;',
        `fn vsPullWord${k}(b: u32) -> u32 {`,
        `    let w = b >> 2u;`,
        `    let n = arrayLength(&vsPull${k});`,
        '    if (w >= n) { return 0u; }',
        '    let s = (b & 3u) * 8u;',
        `    let lo = vsPull${k}[w];`,
        '    if (s == 0u) { return lo; }',
        `    let hi = select(0u, vsPull${k}[min(w + 1u, n - 1u)], w + 1u < n);`,
        '    return (lo >> s) | (hi << (32u - s));',
        '}');
        entries.push({ binding: BINDING.VERTEX_PULL + k, visibility: STAGE.VERTEX,
            buffer: { type: 'read-only-storage' } });
        // Direct3D counts per-instance elements from the first instance
        // (.w), which the instance index does not count.
        const element = stream.stepMode === 'vertex' ? 'in.vsVertexIndex'
            : stream.rate === 0 ? `vsPulls[${k}].w`
                : `(vsPulls[${k}].w + in.vsInstanceIndex / ${stream.rate}u)`;
        load.push(`    let vsPullAt${k} = vsPulls[${k}].x + ${element} * vsPulls[${k}].y;`);
    });
    /** @type {Set<number>} */
    const pulled = new Set();
    for (const element of inputs)
    {
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED || element.register >= registers)
        {
            continue;
        }
        const attribute = pull.attributes.find(candidate=>
            candidate.semantic.toUpperCase() === element.name.toUpperCase()
            && candidate.index === element.index);
        if (!attribute)
        {
            continue;
        }
        pulled.add(element.register);
        const decoder = vertexFetch(attribute.format);
        if (!decoder)
        {
            unsupported.push(`vertex format ${attribute.format}`);
            continue;
        }
        const k = attribute.stream;
        const at = `vsPullAt${k} + ${attribute.offset}u`;
        const words = Array.from({ length: Math.ceil(decoder.bytes / 4) },
            (_, index)=>`vsPullWord${k}(${at} + ${index * 4}u)`);
        // Past the buffer's end an element reads zeros, as Direct3D's does.
        load.push(`    if (${at} + ${decoder.bytes}u <= vsPulls[${k}].z) {`,
            `        v${element.register} = ${decoder.register(words)};`, '    }');
    }
    return { text, load, entries, pulled, unsupported };
}

/**
 * Writes the two entry points around a vertex and a pixel shader body, with the
 * interface between them numbered once for both.
 *
 * A render target the shader writes with nothing bound there is left out of
 * the fragment's outputs, so that a pipeline can be built for exactly the
 * targets a draw has -- none at all, for a pass that draws depth alone.
 *
 * @param {TranslatedShader} vs
 * @param {TranslatedShader} ps
 * @param {{ targets?: readonly number[], vertexLoad?: VertexLoad, clipDistances?: boolean,
 *     depthBias?: { units: number, slope: number, clamp: number },
 *     vertexPull?: VertexPull, layerPass?: { index: number, count: number },
 *     alphaCoverage?: boolean, sampleCount?: number,
 *     earlyDepth?: { compare: string, multisampled: boolean }, dualSource?: boolean,
 *     viewportPass?: { index: number, count: number },
 *     targetScalars?: Readonly<Record<number, string>> }} [options]  `targetScalars`:
 *     each bound target's scalar (f32, u32 or i32) by location, which its output is
 *     whatever the shader's signature says: Direct3D writes an output's bits to the
 *     target as they are (d3d10core.c test_layered_rtv_mismatch). `dualSource`:
 *     the first target is blended by the second output as well (D3D11_BLEND_SRC1_*):
 *     both go to location 0, the second as its second blend source. `earlyDepth`: the
 *     fragment tests itself against the depth buffer, bound read-only at
 *     `BINDING.EARLY_DEPTH`, before the shader runs (`compare` the operator a
 *     fragment's depth passes by, against what the buffer holds), so a rejected
 *     one writes nothing through views. `layerPass`,
 *     `viewportPass`: the one of `count` layers or viewports this drawing of a draw
 *     whose primitives say which goes to; their other fragments are discarded.
 *     `vertexPull`: the streams the vertex stage
 *     reads itself, their inputs taken from no vertex buffer. `targets`:
 *     the locations with a target bound; every location the shader writes when
 *     absent. `vertexLoad`: how the vertex stage fills its registers when they do not
 *     come from vertex buffers (a domain shader's, `linkDomain`). `depthBias`: a
 *     rasterizer's depth bias the fragment stage applies itself, writing the
 *     fragment's depth (`units` the constant bias already in depth, `slope` the
 *     slope scale, `clamp` the clamp, as Direct3D adds them); not where the pixel
 *     shader writes its depth, which no bias touches. `clipDistances`: the device clips
 *     by the distances a vertex writes (WebGPU's `clip-distances`).
 * @returns {LinkedProgram}
 */
export function linkProgram(vs, ps, options = {}){
    /** @type {string[]} */
    const unsupported = [...vs.unsupported, ...ps.unsupported];
    const vsDecl = declarations(vs, 0, STAGE.VERTEX);
    const psDecl = declarations(ps, 1, STAGE.FRAGMENT);
    unsupported.push(...vsDecl.unsupported, ...psDecl.unsupported);

    // --- the vertex stage's inputs ---
    /** @type {string[]} */
    const vsIn = [];
    /** @type {string[]} */
    const vsLoad = [];
    /** @type {LinkedProgram['attributes']} */
    const attributes = [];
    for (let index = 0; index < vs.inputRegisters; index++)
    {
        vsLoad.push(`    var v${index}: ${REG} = ${REG}(0u);`);
    }
    vsLoad.push(...options.vertexLoad?.load ?? []);
    const pull = options.vertexPull && (options.vertexPull.streams.length > 0
        || options.vertexPull.vertexBase) && !options.vertexLoad
        ? vertexPullOf(options.vertexPull, vs.inputs, vs.inputRegisters) : null;
    if (pull)
    {
        // The streams read here find their element by the vertex and
        // instance indices, which a struct may name once each.
        vsIn.push('    @builtin(vertex_index) vsVertexIndex: u32,',
            '    @builtin(instance_index) vsInstanceIndex: u32,');
        vsLoad.push(...pull.load);
        unsupported.push(...pull.unsupported);
    }
    for (const element of options.vertexLoad ? [] : vs.inputs)
    {
        if (element.register >= vs.inputRegisters || pull?.pulled.has(element.register))
        {
            continue;
        }
        const scalar = scalarOf(element.componentType);
        if (element.systemValue === SYSTEM_VALUE.VERTEX_ID)
        {
            if (!pull)
            {
                vsIn.push(`    @builtin(vertex_index) v${element.register}: u32,`);
            }
            vsLoad.push(`    v${element.register}.x = ${pull ? `in.vsVertexIndex${
                options.vertexPull?.vertexBase
                    ? ` - vsPulls[${options.vertexPull.streams.length}].x` : ''}`
                : `in.v${element.register}`};`);
        }
        else if (element.systemValue === SYSTEM_VALUE.INSTANCE_ID)
        {
            if (!pull)
            {
                vsIn.push(`    @builtin(instance_index) v${element.register}: u32,`);
            }
            vsLoad.push(`    v${element.register}.x = in.${pull ? 'vsInstanceIndex'
                : `v${element.register}`};`);
        }
        else if (element.systemValue === SYSTEM_VALUE.UNDEFINED)
        {
            vsIn.push(`    @location(${element.register}) v${element.register}: vec4<${scalar}>,`);
            vsLoad.push(`    v${element.register} = ${scalar === 'u32'
                ? `in.v${element.register}`
                : `bitcast<${REG}>(in.v${element.register})`};`);
            attributes.push({
                location: element.register,
                semantic: element.name,
                index: element.index,
                componentType: element.componentType,
            });
        }
        else
        {
            unsupported.push(`vertex input system value ${element.systemValue}`);
        }
    }

    // --- the interface between the stages, numbered by the vertex outputs ---
    /** @type {Map<string, { location: number, scalar: string, interpolate: string }>} */
    const varyings = new Map();
    /** The pixel shader's interpolation mode of each input, by register. */
    const psModes = new Map(ps.inputs.map(element=>[element.register,
        ps.interpolation?.[element.register] ?? 0]));
    /**
     * The varying each output register is passed as: two semantics packed
     * into one register (TEXCOORD0 in .xy, TEXCOORD1 in .zw) are one varying.
     *
     * @type {Map<number, { location: number, scalar: string, interpolate: string }>}
     */
    const byRegister = new Map();
    /** @type {string[]} */
    const vsOut = [];
    /** @type {string[]} */
    const vsReturn = [];
    let position = false;
    /**
     * The render target array index and viewport index the vertices carry,
     * by the member they travel as. @type {Map<string, string>}
     */
    const routes = new Map();
    /** Each clip and cull distance a vertex writes, a component each. @type {string[]} */
    const clips = [];
    /** @type {string[]} */
    const culls = [];
    for (const element of vs.outputs)
    {
        const register = `o${element.register}`;
        const value = element.register < vs.outputRegisters ? register : `${REG}(0u)`;
        if (element.systemValue === SYSTEM_VALUE.CLIP_DISTANCE
            || element.systemValue === SYSTEM_VALUE.CULL_DISTANCE)
        {
            const into = element.systemValue === SYSTEM_VALUE.CLIP_DISTANCE ? clips : culls;
            for (let c = 0; c < 4; c++)
            {
                if ((element.mask & (1 << c)) !== 0)
                {
                    into.push(`bitcast<f32>(${value}.${COMPONENT[c]})`);
                }
            }
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.POSITION)
        {
            position = true;
            vsOut.push('    @builtin(position) position: vec4<f32>,');
            vsReturn.push(`bitcast<vec4<f32>>(${value})`);
            continue;
        }
        const route = ROUTES[element.systemValue];
        if (route)
        {
            routes.set(route, `${value}.${COMPONENT[firstComponent(element.mask)]}`);
            continue;
        }
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`vertex output system value ${element.systemValue}`);
            continue;
        }
        const key = semanticKey(element);
        if (varyings.has(key))
        {
            continue;
        }
        const packed = byRegister.get(element.register);
        if (packed)
        {
            varyings.set(key, packed);
            continue;
        }
        const scalar = scalarOf(element.componentType);
        const location = byRegister.size;
        // An integer varying cannot be interpolated and WGSL says so; a
        // float one is interpolated as the pixel shader declares the input
        // it arrives as, both stages saying it alike as WebGPU requires.
        const interpolate = scalar === 'f32'
            ? INTERPOLATION[psModes.get(element.register) ?? 0] ?? ''
            : ' @interpolate(flat)';
        const varying = { location, scalar, interpolate };
        varyings.set(key, varying);
        byRegister.set(element.register, varying);
        vsOut.push(`    @location(${location})${interpolate} ${register}: vec4<${scalar}>,`);
        vsReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
    }
    if (!position)
    {
        unsupported.push('a vertex shader that writes no SV_Position');
    }
    // Clip distances clip where the device does (clip-distances); elsewhere
    // they travel, interpolated, and the fragment stage discards where one
    // is negative: the same cut, the distance being linear across a
    // primitive. A cull distance travels as whether each vertex is on the
    // kept side, and a primitive all of whose vertices are not is a primitive
    // whose fragments read zero there: those are discarded.
    /** @type {string[]} */
    const cutLoad = [];
    /** @type {string[]} */
    const cutIn = [];
    /** @param {string[]} values @param {string} name @param {string} test */
    const travelling = (values, name, test)=>{
        for (let group = 0; group * 4 < values.length; group++)
        {
            const location = byRegister.size + cutIn.length;
            const four = [0, 1, 2, 3].map(c=>values[group * 4 + c] ?? '1.0');
            vsOut.push(`    @location(${location}) ${name}${group}: vec4<f32>,`);
            vsReturn.push(`vec4<f32>(${four.join(', ')})`);
            cutIn.push(`    @location(${location}) ${name}${group}: vec4<f32>,`);
            cutLoad.push(`    if (any(${test.replace('$', `in.${name}${group}`)})) { discard; }`);
        }
    };
    const deviceClips = clips.length > 0 && options.clipDistances === true;
    if (deviceClips)
    {
        vsOut.push(`    @builtin(clip_distances) clipDistances: array<f32, ${clips.length}>,`);
        vsReturn.push(`array<f32, ${clips.length}>(${clips.join(', ')})`);
    }
    else
    {
        travelling(clips, 'clipDistance', '$ < vec4<f32>(0.0)');
    }
    travelling(culls.map(value=>`select(0.0, 1.0, ${value} >= 0.0)`), 'cullKept',
        '$ == vec4<f32>(0.0)');
    // The layer and viewport a primitive goes to, from its first vertex as
    // Direct3D takes them from its leading one. WebGPU draws a pass into one
    // layer through one viewport, so a draw that routes primitives is drawn
    // once a layer or viewport (`layerPass`, `viewportPass`), keeping the
    // fragments routed there.
    for (const [name, value] of routes)
    {
        const location = byRegister.size + cutIn.length;
        vsOut.push(`    @location(${location}) @interpolate(flat) ${name}: u32,`);
        vsReturn.push(value);
        cutIn.push(`    @location(${location}) @interpolate(flat) ${name}: u32,`);
    }
    /** @type {[string, { index: number, count: number } | undefined][]} */
    const passes = [['rtLayer', options.layerPass], ['rtViewport', options.viewportPass]];
    for (const [name, pass] of passes)
    {
        if (pass && routes.has(name))
        {
            // A layer past the views' goes to the first; a viewport past the
            // viewports set to none (test_multiple_viewports).
            cutLoad.push(name === 'rtLayer'
                ? `    if (in.${name} != ${pass.index}u && (${pass.index}u != 0u`
                    + ` || in.${name} < ${pass.count}u)) { discard; }`
                : `    if (in.${name} != ${pass.index}u) { discard; }`);
        }
    }

    // --- the pixel stage's inputs, found by register among the vertex outputs ---
    /** @type {string[]} */
    const psIn = [];
    /** @type {string[]} */
    const psLoad = [];
    for (let index = 0; index < ps.inputRegisters; index++)
    {
        psLoad.push(`    var v${index}: ${REG} = ${REG}(0u);`);
    }
    /** The pixel stage's member each location arrives as. @type {Map<number, string>} */
    const arrived = new Map();
    for (const element of ps.inputs)
    {
        if (element.register >= ps.inputRegisters)
        {
            continue;
        }
        const name = `v${element.register}`;
        if (element.systemValue === SYSTEM_VALUE.POSITION)
        {
            psIn.push(`    @builtin(position) ${name}: vec4<f32>,`);
            psLoad.push(`    ${name} = bitcast<${REG}>(in.${name});`);
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.IS_FRONT_FACE)
        {
            psIn.push(`    @builtin(front_facing) ${name}: bool,`);
            psLoad.push(`    ${name}.x = select(0u, 0xffffffffu, in.${name});`);
            continue;
        }
        // Reading it runs the shader once a sample, in WebGPU as in Direct3D.
        if (element.systemValue === SYSTEM_VALUE.SAMPLE_INDEX)
        {
            psIn.push(`    @builtin(sample_index) ${name}: u32,`);
            psLoad.push(`    ${name}.${COMPONENT[firstComponent(element.mask)]} = in.${name};`);
            continue;
        }
        const route = ROUTES[element.systemValue];
        if (route)
        {
            // What the vertices did not write reads zero.
            psLoad.push(`    ${name}.${COMPONENT[firstComponent(element.mask)]} = ${
                routes.has(route) ? `in.${route}` : '0u'};`);
            continue;
        }
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`pixel input system value ${element.systemValue}`);
            continue;
        }
        // Register n of the vertex outputs, as the hardware passes it; a
        // register the vertex shader did not write is looked for by name.
        const varying = byRegister.get(element.register) ?? varyings.get(semanticKey(element));
        if (!varying)
        {
            // An input the shader never reads (its signature's read mask
            // empty) needs no output; one it reads where the vertex shader
            // wrote nothing reads as zero, and the pair says why.
            if (element.readWriteMask !== 0)
            {
                unsupported.push(`pixel input ${semanticKey(element)} has no vertex output`);
            }
            continue;
        }
        // A register two semantics share comes in once, as the first named it.
        const member = arrived.get(varying.location) ?? name;
        if (!arrived.has(varying.location))
        {
            arrived.set(varying.location, name);
            const interpolate = varying.interpolate;
            psIn.push(`    @location(${varying.location})${interpolate} ${name}: `
                + `vec4<${varying.scalar}>,`);
        }
        psLoad.push(`    ${name} = ${varying.scalar === 'u32'
            ? `in.${member}`
            : `bitcast<${REG}>(in.${member})`};`);
    }

    // --- the pixel stage's outputs ---
    /** @type {string[]} */
    const psOut = [];
    /** @type {string[]} */
    const psReturn = [];
    /** @type {number[]} */
    const targets = [];
    // A compiler writes the depth outputs' signature with no system value,
    // only their names and no register: they are named here.
    const DEPTH_NAMES = /** @type {Record<string, number>} */ ({ SV_DEPTH: SYSTEM_VALUE.DEPTH,
        SV_DEPTHGREATEREQUAL: SYSTEM_VALUE.DEPTH_GREATER_EQUAL,
        SV_DEPTHLESSEQUAL: SYSTEM_VALUE.DEPTH_LESS_EQUAL, SV_COVERAGE: SYSTEM_VALUE.COVERAGE });
    for (const output of ps.outputs)
    {
        const element = output.systemValue === SYSTEM_VALUE.UNDEFINED
            && DEPTH_NAMES[output.name.toUpperCase()] !== undefined
            ? { ...output, systemValue: DEPTH_NAMES[output.name.toUpperCase()] } : output;
        const value = element.register < ps.outputRegisters
            ? `o${element.register}`
            : `${REG}(0u)`;
        // An output with no system value is the target its register names --
        // COLOR0 from a shader compiled for backwards compatibility (fxc
        // /Gec), and SV_Target as fxc writes it -- unless its name says depth:
        // fxc writes SV_Depth with no system value too, and the program
        // writes oDepth.
        const name = element.name.toUpperCase();
        if (element.systemValue === SYSTEM_VALUE.TARGET
            || (element.systemValue === SYSTEM_VALUE.UNDEFINED && !name.startsWith('SV_DEPTH')))
        {
            const slot = element.systemValue === SYSTEM_VALUE.TARGET
                ? element.index : element.register;
            targets.push(slot);
            const scalar = options.targetScalars?.[slot] ?? scalarOf(element.componentType);
            // The second output is the first target's second blend source,
            // whatever is bound at the second.
            if (options.dualSource && slot <= 1)
            {
                psOut.push(`    @location(0) @blend_src(${slot}) target${slot}: vec4<${scalar}>,`);
                psReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
                continue;
            }
            if (options.targets && !options.targets.includes(slot))
            {
                continue;
            }
            psOut.push(`    @location(${slot}) target${slot}: vec4<${scalar}>,`);
            psReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.DEPTH
            || (element.systemValue === SYSTEM_VALUE.UNDEFINED && name === 'SV_DEPTH'))
        {
            psOut.push('    @builtin(frag_depth) depth: f32,');
            psReturn.push('oDepth');
            continue;
        }
        // The samples the fragment covers, and'ed with the rasterizer's.
        if (element.systemValue === SYSTEM_VALUE.COVERAGE)
        {
            psOut.push('    @builtin(sample_mask) mask: u32,');
            psReturn.push(ps.writesMask ? 'oMask' : '0xffffffffu');
            continue;
        }
        // A depth written with a promise of its direction keeps it: the
        // hardware takes the nearer of it and the rasterized depth.
        if (element.systemValue === SYSTEM_VALUE.DEPTH_GREATER_EQUAL
            || element.systemValue === SYSTEM_VALUE.DEPTH_LESS_EQUAL)
        {
            const named = psIn.find(line=>line.includes('@builtin(position)'));
            const member = named ? /\) (\w+):/.exec(named)?.[1] : 'depthPosition';
            if (!named)
            {
                psIn.push('    @builtin(position) depthPosition: vec4<f32>,');
            }
            psOut.push('    @builtin(frag_depth) depth: f32,');
            psReturn.push(`${element.systemValue === SYSTEM_VALUE.DEPTH_GREATER_EQUAL ? 'max'
                : 'min'}(oDepth, in.${member}.z)`);
            continue;
        }
        unsupported.push(`pixel output system value ${element.systemValue}`);
    }

    // A bias the fragment stage applies: Direct3D's, on the rasterized depth,
    // from the depth's slope across the primitive.
    const biased = options.depthBias && !ps.writesDepth ? options.depthBias : null;
    /** @type {string[]} */
    const biasLoad = [];
    if (biased)
    {
        const named = psIn.find(line=>line.includes('@builtin(position)'));
        const member = named ? /\) (\w+):/.exec(named)?.[1] : 'biasPosition';
        if (!named)
        {
            psIn.push('    @builtin(position) biasPosition: vec4<f32>,');
        }
        const bound = biased.clamp > 0 ? `min(biasRaw, ${floatLiteral(biased.clamp)})`
            : biased.clamp < 0 ? `max(biasRaw, ${floatLiteral(biased.clamp)})` : 'biasRaw';
        biasLoad.push(`    let biasZ = in.${member}.z;`,
            `    let biasRaw = ${floatLiteral(biased.units)} + ${floatLiteral(biased.slope)}`
                + ' * max(abs(dpdx(biasZ)), abs(dpdy(biasZ)));',
            `    let biasedDepth = biasZ + ${bound};`);
        psOut.push('    @builtin(frag_depth) depth: f32,');
        psReturn.push('biasedDepth');
    }

    psIn.push(...cutIn);
    // WGSL has no empty struct, so a stage that reads nothing takes nothing.
    const vertex = [
        ...(deviceClips ? ['enable clip_distances;'] : []),
        ...vsDecl.text,
        ...options.vertexLoad?.text ?? [],
        ...pull?.text ?? [],
        ...(vsIn.length > 0 ? ['struct VertexIn {', ...vsIn, '};'] : []),
        'struct VertexOut {',
        ...vsOut,
        '};',
        `@vertex fn vertexMain(${options.vertexLoad?.params
            ?? (vsIn.length > 0 ? 'in: VertexIn' : '')}) -> VertexOut {`,
        ...vsLoad,
        ...registerDeclarations(vs),
        ...bodyText(vs, `VertexOut(${vsReturn.join(', ')})`),
        '}',
    ].join('\n');

    // Alpha to coverage on one sample: Direct3D covers the pixel by the
    // first target's alpha, WebGPU only with several samples; the fragment
    // is kept where that alpha reaches half (`alphaCoverage`).
    const first = ps.outputs.find(element=>element.register < ps.outputRegisters
        && (element.systemValue === SYSTEM_VALUE.TARGET ? element.index === 0
            : element.systemValue === SYSTEM_VALUE.UNDEFINED && element.register === 0));
    const coverage = options.alphaCoverage && first
        ? `if (bitcast<f32>(o${first.register}.w) < 0.5) { discard; }` : '';

    // Direct3D leaves a derivative taken in divergent flow undefined rather
    // than refusing the shader, and compilers emit sample instructions inside
    // branches and loops that WGSL's uniformity analysis would reject.
    // A fragment stage with nothing to write -- depth alone, no target bound
    // -- still runs, for what it discards, and returns nothing.
    const writes = psOut.length > 0;
    // The samples the fragment covers, as the shader reads them (vCoverage).
    if (ps.readsMask)
    {
        psIn.push('    @builtin(sample_mask) coverage: u32,');
        psLoad.push('    let vCoverage = in.coverage;');
    }
    /** @type {string[]} */
    const early = [];
    if (options.earlyDepth)
    {
        const named = psIn.find(line=>line.includes('@builtin(position)'));
        const member = named ? /\) (\w+):/.exec(named)?.[1] : 'earlyPosition';
        if (!named)
        {
            psIn.push('    @builtin(position) earlyPosition: vec4<f32>,');
        }
        const { compare, multisampled } = options.earlyDepth;
        psDecl.text.push(`@group(1) @binding(${BINDING.EARLY_DEPTH}) var earlyDepth: `
            + `texture_depth${multisampled ? '_multisampled' : ''}_2d;`);
        psDecl.entries.push({ binding: BINDING.EARLY_DEPTH, visibility: STAGE.FRAGMENT,
            texture: { sampleType: 'depth', viewDimension: '2d',
                ...(multisampled ? { multisampled: true } : {}) } });
        early.push(`    if (!(in.${member}.z ${compare} textureLoad(earlyDepth,`
            + ` vec2<i32>(in.${member}.xy), 0))) { discard; }`);
    }
    const fragment = [
        ...(options.dualSource ? ['enable dual_source_blending;'] : []),
        'diagnostic(off, derivative_uniformity);',
        ...(ps.rasterizerSamples ? [`const rasterSamples: u32 = ${options.sampleCount ?? 1}u;`]
            : []),
        ...psDecl.text,
        ...(psIn.length > 0 ? ['struct FragmentIn {', ...psIn, '};'] : []),
        ...(writes ? ['struct FragmentOut {', ...psOut, '};'] : []),
        `@fragment fn fragmentMain(${psIn.length > 0 ? 'in: FragmentIn' : ''})`
            + `${writes ? ' -> FragmentOut' : ''} {`,
        ...early,
        ...cutLoad,
        ...biasLoad,
        ...psLoad,
        ...registerDeclarations(ps),
        ...(ps.writesDepth ? ['    var oDepth: f32 = 0.0;'] : []),
        ...(ps.writesMask ? ['    var oMask: u32 = 0xffffffffu;'] : []),
        ...bodyText(ps, writes ? `FragmentOut(${psReturn.join(', ')})` : null, coverage),
        '}',
    ].join('\n');

    return {
        vertex,
        fragment,
        groups: [pull ? [...vsDecl.entries, ...pull.entries] : vsDecl.entries, psDecl.entries],
        attributes,
        targets,
        unsupported,
    };
}

/** The tessellator's domains, partitionings and outputs as a hull shader declares them. */
const HULL_DOMAIN = Object.freeze({ 1: 'isoline', 2: 'tri', 3: 'quad' });

/**
 * @typedef {Object} LinkedHull
 * @property {string} code           WGSL, entry point `hullMain`: one invocation a patch,
 *     `hsParams` x the patches, y the patches an instance draws.
 * @property {BindGroupLayoutEntry[]} entries  Group 0, the shader's own resources; group 1
 *     is the stage's (`HULL_BINDING`).
 * @property {{ domain: 'isoline' | 'tri' | 'quad', partitioning: number, output: number,
 *     inputPoints: number, outputPoints: number, inputRegisters: number,
 *     outputRegisters: number, constantRegisters: number }} stage
 *     What the tessellator is told and how big each record is: partitioning and
 *     output as `tessellator.js` numbers them.
 * @property {string[]} unsupported
 */

/** Group 1 of a hull program: what it reads and writes per patch. */
export const HULL_BINDING = Object.freeze({
    inputs: 0, points: 1, constants: 2, patches: 3, params: 4,
});

/**
 * A hull shader as one compute program, one invocation a patch: the patch's
 * input control points (`inputs`, the vertex stage's outputs by the hull's
 * input registers), the control point phase run once for each output control
 * point (or, without one, the input points passed through), every fork phase
 * and then every join phase run once for each of its instances, and then the
 * output control points, the patch constants and the tessellator's record of
 * the patch (`tessellator-wgsl.js`'s `Patch`: the declared domain,
 * partitioning and output, the tess factors from the patch constants the PCSG
 * signature names) written out.
 *
 * Each phase is translated as a shader of its own, the declarations before
 * the first phase in front of it, into a function over the stage's private
 * registers: `vicp`, `vocp`, `vpc`, and the outputs it writes, an output
 * control point's (`cpo`) or the patch constants (`pc`).
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * @returns {LinkedHull}
 */
export function linkHull(container){
    const program = /** @type {import('./dxbc.js').ShaderProgram} */ (container.shader);
    const instructions = decodeSm4(program.tokens);
    /** @type {string[]} */
    const unsupported = [];
    /** @type {{ kind: number, from: number, to: number }[]} */
    const phases = [];
    let globalsEnd = program.tokens.length;
    let at = 0;
    const stage = { domain: /** @type {'isoline' | 'tri' | 'quad'} */ ('tri'), partitioning: 0,
        output: 0, inputPoints: 0, outputPoints: 0 };
    for (const instruction of instructions)
    {
        const control = instruction.control;
        switch (instruction.opcode)
        {
            case OPCODE.HS_CONTROL_POINT_PHASE:
            case OPCODE.HS_FORK_PHASE:
            case OPCODE.HS_JOIN_PHASE:
                if (phases.length === 0)
                {
                    globalsEnd = at;
                }
                else
                {
                    phases[phases.length - 1].to = at;
                }
                phases.push({ kind: instruction.opcode, from: at + instruction.length,
                    to: program.tokens.length });
                break;
            case OPCODE.DCL_INPUT_CONTROL_POINT_COUNT:
                stage.inputPoints = control & 0x3f;
                break;
            case OPCODE.DCL_OUTPUT_CONTROL_POINT_COUNT:
                stage.outputPoints = control & 0x3f;
                break;
            case OPCODE.DCL_TESS_DOMAIN:
                stage.domain = HULL_DOMAIN[/** @type {1 | 2 | 3} */ (control & 3)] ?? 'tri';
                break;
            case OPCODE.DCL_TESS_PARTITIONING:
                // The token's are one past Direct3D's (0 is "undefined").
                stage.partitioning = Math.max(0, (control & 7) - 1);
                break;
            case OPCODE.DCL_TESS_OUTPUT_PRIMITIVE:
                stage.output = Math.max(0, (control & 7) - 1);
                break;
            default:
                break;
        }
        at += instruction.length;
    }
    const globals = program.tokens.subarray(0, globalsEnd);
    /** @param {import('./dxbc.js').SignatureElement[]} elements */
    const registersOf = elements=>Math.max(1, ...elements.map(element=>element.register + 1));
    const patchConstants = patchConstantsOf(container.chunks);
    const inputRegisters = registersOf(container.inputs);
    const outputRegisters = registersOf(container.outputs);
    // The registers the patch constant phases write, which the signature
    // may name fewer of: an output declared but left out of it is still
    // written, and the domain shader reads the constants at this stride.
    let constantRegisters = registersOf(patchConstants);
    const inputPoints = Math.max(1, stage.inputPoints);
    const outputPoints = Math.max(1, stage.outputPoints);

    /** @type {string[]} */
    const functions = [];
    /** @type {string[]} */
    const calls = [];
    /** @type {TranslatedShader[]} */
    const translated = [];
    let hasControlPointPhase = false;
    let joinStarted = false;
    phases.forEach((phase, index)=>{
        const tokens = new Uint32Array(globals.length + phase.to - phase.from);
        tokens.set(globals);
        tokens.set(program.tokens.subarray(phase.from, phase.to), globals.length);
        const isControlPoint = phase.kind === OPCODE.HS_CONTROL_POINT_PHASE;
        const shader = translateShader(container, { tokens,
            outputName: isControlPoint ? 'cpo' : 'pc' });
        translated.push(shader);
        if (!isControlPoint)
        {
            constantRegisters = Math.max(constantRegisters, shader.outputRegisters);
        }
        unsupported.push(...shader.unsupported);
        const icb = `icb_p${index}`;
        const lines = [`fn hsPhase${index}() {`];
        if (shader.immediateConstants.length > 0)
        {
            const rows = shader.immediateConstants
                .map(row=>`${REG}(${row.map(u32Literal).join(', ')})`);
            functions.push(`const ${icb} = array<${REG}, ${rows.length}>(${rows.join(', ')});`);
        }
        for (let temp = 0; temp < shader.temps; temp++)
        {
            lines.push(`    var r${temp}: ${REG};`);
        }
        for (const temp of shader.indexableTemps)
        {
            lines.push(`    var x${temp.index}: array<${REG}, ${temp.size}>;`);
        }
        lines.push(...bodyText(shader, null).map(line=>line.replace(/\bicb\[/g, `${icb}[`)));
        lines.push('}');
        functions.push(lines.join('\n'));
        const instances = decodeSm4(program.tokens.subarray(phase.from, phase.to))
            .find(one=>one.opcode === OPCODE.DCL_HS_FORK_PHASE_INSTANCE_COUNT
                || one.opcode === OPCODE.DCL_HS_JOIN_PHASE_INSTANCE_COUNT)?.extra[0] ?? 1;
        if (isControlPoint)
        {
            hasControlPointPhase = true;
            calls.push(`    for (var cp = 0u; cp < ${outputPoints}u; cp++) {`,
                `        hsControlPoint = cp;`,
                `        cpo = array<${REG}, ${outputRegisters}>();`,
                `        hsPhase${index}();`,
                `        vocp[cp] = cpo;`,
                '    }');
            return;
        }
        if (phase.kind === OPCODE.HS_JOIN_PHASE && !joinStarted)
        {
            joinStarted = true;
            calls.push('    vpc = pc;');
        }
        calls.push(`    for (var i = 0u; i < ${instances}u; i++) {`,
            '        hsInstance = i;', `        hsPhase${index}();`, '    }');
    });
    if (!hasControlPointPhase)
    {
        // Without a control point phase the input points go on as they came.
        calls.unshift(`    for (var cp = 0u; cp < ${Math.min(inputPoints, outputPoints)}u; cp++) {`,
            `        for (var reg = 0u; reg < ${Math.min(inputRegisters, outputRegisters)}u;`
                + ' reg++) {',
            '            vocp[cp][reg] = vicp[cp][reg];', '        }', '    }');
    }

    // The tess factors, in the order the tessellator takes them.
    /** @type {string[]} */
    const factors = ['0.0', '0.0', '0.0', '0.0', '0.0', '0.0'];
    for (const element of patchConstants)
    {
        const component = [0, 1, 2, 3].find(c=>(element.mask & (1 << c)) !== 0) ?? 0;
        const value = `bitcast<f32>(pc[${element.register}].${COMPONENT[component]})`;
        const slot = {
            [SYSTEM_VALUE.QUAD_EDGE_TESSFACTOR]: element.index,
            [SYSTEM_VALUE.QUAD_INSIDE_TESSFACTOR]: 4 + element.index,
            [SYSTEM_VALUE.TRI_EDGE_TESSFACTOR]: element.index,
            [SYSTEM_VALUE.TRI_INSIDE_TESSFACTOR]: 3,
            [SYSTEM_VALUE.LINE_DENSITY_TESSFACTOR]: 0,
            [SYSTEM_VALUE.LINE_DETAIL_TESSFACTOR]: 1,
        }[element.systemValue];
        if (slot !== undefined && slot < 6)
        {
            factors[slot] = value;
        }
    }

    // Every phase's resources, declared once.
    /** @type {TranslatedShader} */
    const merged = { ...translated[0] ?? translateShader(container, { tokens: globals,
        outputName: 'pc' }), immediateConstants: [], body: [] };
    for (const shader of translated.slice(1))
    {
        for (const key of /** @type {const} */ (['constantBuffers', 'textures', 'samplers',
            'uavs']))
        {
            for (const item of shader[key])
            {
                if (!merged[key].some((/** @type {any} */ other)=>other.slot === item.slot))
                {
                    /** @type {any[]} */ (merged[key]).push(item);
                }
            }
        }
        merged.helpers = [...new Set([...merged.helpers, ...shader.helpers])];
    }
    const declared = declarations(merged, 0, STAGE.COMPUTE);
    unsupported.push(...declared.unsupported);
    const domainNumber = { isoline: 0, tri: 1, quad: 2 }[stage.domain];
    const code = [
        ...declared.text,
        'struct TessPatch { kind: vec4<u32>, f0: vec4<f32>, f1: vec4<f32>, }',
        `@group(1) @binding(${HULL_BINDING.inputs}) var<storage, read> hsIn: array<${REG}>;`,
        `@group(1) @binding(${HULL_BINDING.points}) var<storage, read_write> hsOutPoints: `
            + `array<${REG}>;`,
        `@group(1) @binding(${HULL_BINDING.constants}) var<storage, read_write> hsOutConstants: `
            + `array<${REG}>;`,
        `@group(1) @binding(${HULL_BINDING.patches}) var<storage, read_write> hsPatches: `
            + 'array<TessPatch>;',
        `@group(1) @binding(${HULL_BINDING.params}) var<uniform> hsParams: vec4<u32>;`,
        `var<private> vicp: array<array<${REG}, ${inputRegisters}>, ${inputPoints}>;`,
        `var<private> vocp: array<array<${REG}, ${outputRegisters}>, ${outputPoints}>;`,
        `var<private> cpo: array<${REG}, ${outputRegisters}>;`,
        `var<private> pc: array<${REG}, ${constantRegisters}>;`,
        `var<private> vpc: array<${REG}, ${constantRegisters}>;`,
        'var<private> hsControlPoint: u32;',
        'var<private> hsInstance: u32;',
        'var<private> primitiveId: u32;',
        ...functions,
        '@compute @workgroup_size(64)',
        'fn hullMain(@builtin(global_invocation_id) id: vec3<u32>) {',
        '    if (id.x >= hsParams.x) { return; }',
        '    let hsPatch = id.x;',
        // Patches of every instance in a row: SV_PrimitiveID counts each
        // instance's from zero.
        '    primitiveId = hsPatch % max(1u, hsParams.y);',
        `    for (var cp = 0u; cp < ${inputPoints}u; cp++) {`,
        `        for (var reg = 0u; reg < ${inputRegisters}u; reg++) {`,
        `            vicp[cp][reg] = hsIn[(hsPatch * ${inputPoints}u + cp) * ${inputRegisters}u`
            + ' + reg];',
        '        }',
        '    }',
        ...calls,
        `    for (var cp = 0u; cp < ${outputPoints}u; cp++) {`,
        `        for (var reg = 0u; reg < ${outputRegisters}u; reg++) {`,
        `            hsOutPoints[(hsPatch * ${outputPoints}u + cp) * ${outputRegisters}u + reg] `
            + '= vocp[cp][reg];',
        '        }',
        '    }',
        `    for (var reg = 0u; reg < ${constantRegisters}u; reg++) {`,
        `        hsOutConstants[hsPatch * ${constantRegisters}u + reg] = pc[reg];`,
        '    }',
        `    hsPatches[hsPatch] = TessPatch(vec4<u32>(${domainNumber}u, ${stage.partitioning}u, `
            + `${stage.output}u, 0u),`,
        `        vec4<f32>(${factors.slice(0, 4).join(', ')}), `
            + `vec4<f32>(${factors[4]}, ${factors[5]}, 0.0, 0.0));`,
        '}',
    ].join('\n');
    return {
        code,
        entries: declared.entries,
        stage: { ...stage, inputPoints, outputPoints, inputRegisters, outputRegisters,
            constantRegisters },
        unsupported: [...new Set(unsupported)],
    };
}

/** D3D10_SB_PRIMITIVE: the vertices a geometry shader's input primitive has. */
const GS_INPUT_VERTICES = Object.freeze(/** @type {Record<number, number>} */ ({
    1: 1, 2: 2, 3: 3, 6: 4, 7: 6,
}));

/**
 * @typedef {Object} GeometryStage
 * @property {number} inputVertices  The vertices of each primitive it takes.
 * @property {number} outputVertices The vertices of each primitive it makes:
 *     1 points, 2 lines, 3 triangles (a strip it builds is made a list).
 * @property {number} maxOut         The vertices it may emit, a stream.
 * @property {number} instances      Its invocations a primitive.
 * @property {number[]} streams      The streams it emits to, in order.
 * @property {number} inputRegisters
 * @property {number} outputRegisters
 */

/**
 * What a geometry shader's declarations say of it.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * @param {TranslatedShader} gs  Its translation.
 * @returns {GeometryStage}
 */
export function geometryStage(container, gs){
    const program = /** @type {import('./dxbc.js').ShaderProgram} */ (container.shader);
    const stage = { inputVertices: 1, outputVertices: 1, maxOut: 1, instances: 1,
        streams: /** @type {number[]} */ ([]), inputRegisters: Math.max(1, gs.inputRegisters),
        outputRegisters: Math.max(1, gs.outputRegisters) };
    for (const instruction of decodeSm4(program.tokens))
    {
        switch (instruction.opcode)
        {
            case OPCODE.DCL_GS_INPUT_PRIMITIVE: {
                const primitive = instruction.control & 0x3f;
                // A patch of n control points is primitive 7 + n.
                stage.inputVertices = GS_INPUT_VERTICES[primitive]
                    ?? (primitive >= 8 ? primitive - 7 : 1);
                break;
            }
            case OPCODE.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY: {
                const topology = instruction.control & 0x7f;
                stage.outputVertices = topology === 1 ? 1 : topology <= 3 ? 2 : 3;
                break;
            }
            case OPCODE.DCL_MAX_OUTPUT_VERTEX_COUNT:
                stage.maxOut = Math.max(1, instruction.extra[0] ?? 1);
                break;
            case OPCODE.DCL_GS_INSTANCE_COUNT:
                stage.instances = Math.max(1, instruction.extra[0] ?? 1);
                break;
            case OPCODE.DCL_STREAM:
                stage.streams.push(instruction.operands[0].indices[0].value);
                break;
            default:
                break;
        }
    }
    if (stage.streams.length === 0)
    {
        stage.streams.push(0);
    }
    return stage;
}

/**
 * A vertex shader's bytecode made a geometry shader to stream its vertices
 * out: the stage that passes each primitive the input assembler made on as it
 * came, its vertices in order.
 *
 * @param {TranslatedShader} vs
 * @param {number} vertices  The input assembler's primitive: 1, 2 or 3.
 * @returns {{ shader: TranslatedShader, stage: GeometryStage }}
 */
export function passThroughGeometry(vs, vertices){
    const registers = Math.max(1, vs.outputRegisters);
    /** @type {TranslatedShader['body']} */
    const body = [];
    for (let vertex = 0; vertex < vertices; vertex++)
    {
        for (let register = 0; register < registers; register++)
        {
            body.push(`    o${register} = vgs[${vertex}][${register}];`);
        }
        body.push('    gsEmit(0u);');
    }
    body.push({ ret: true });
    return {
        shader: { ...NO_PIXEL_SHADER, kind: SHADER_KIND.GEOMETRY, inputs: vs.outputs,
            outputs: vs.outputs, body, inputRegisters: registers, outputRegisters: registers },
        stage: { inputVertices: vertices, outputVertices: vertices, maxOut: vertices,
            instances: 1, streams: [0], inputRegisters: registers, outputRegisters: registers },
    };
}

/**
 * Group 1 of a geometry shader run as compute (`linkGeometry`); `limit` only
 * for one fed by the tessellator, whose positions are counted on the GPU.
 */
export const GEOMETRY_BINDING = Object.freeze({
    inputs: 0, indices: 1, vertices: 2, starts: 3, counts: 4, params: 5, limit: 6,
});

/** The topologies whose primitives share vertices, as Direct3D numbers them. */
const STRIP_TOPOLOGIES = Object.freeze([3, 5, 11, 13]);

/**
 * A geometry shader as one compute program, one invocation a primitive and
 * instance of the shader: the primitive's vertices found as the input
 * assembler finds them (a strip's from its position, an odd triangle's first
 * two swapped so that every triangle keeps the strip's winding; a strip's
 * primitive that holds a cut index is none), each read out of what the vertex
 * shader wrote for its position (`gsIn`) into `vgs`, the body run, and each
 * vertex it emits stored at the next of its stream's places (`gsVertices`,
 * `maxOut` a stream an invocation), with whether it starts a strip
 * (`gsStarts`); `gsCounts` takes each stream's primitives and vertices.
 *
 * `gsParams`: the invocations, the primitives an instance of the draw, its
 * topology, the positions an instance, the index size in bytes (0 for none),
 * the index buffer's byte offset and the first index.
 *
 * `limited`: the positions are what the tessellator wrote, or an indirect
 * draw's, a list whose length the GPU holds (`gsLimit`, its first word): the
 * invocations are sized by the most it may write, and one past the
 * primitives it did write runs no body and counts nothing. `instanced`: the
 * instances drawn are the GPU's too, `gsLimit`'s second word.
 *
 * @param {TranslatedShader} gs
 * @param {GeometryStage} stage
 * @param {{ limited?: boolean, instanced?: boolean }} [options]
 * @returns {{ code: string, entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
export function linkGeometry(gs, stage, options = {}){
    const declared = declarations(gs, 0, STAGE.COMPUTE);
    const unsupported = [...gs.unsupported, ...declared.unsupported];
    const vertices = stage.inputVertices;
    const inputs = stage.inputRegisters;
    const outputs = stage.outputRegisters;
    const streams = stage.streams.length;
    const most = stage.maxOut;
    const code = [
        ...declared.text,
        'struct GsParams { invocations: u32, prims: u32, topology: u32, points: u32,',
        '    indexBytes: u32, indexOffset: u32, first: u32, pad: u32, }',
        `@group(1) @binding(${GEOMETRY_BINDING.inputs}) var<storage, read> gsIn: array<${REG}>;`,
        `@group(1) @binding(${GEOMETRY_BINDING.indices}) var<storage, read> gsIndices: `
            + 'array<u32>;',
        `@group(1) @binding(${GEOMETRY_BINDING.vertices}) var<storage, read_write> gsVertices: `
            + `array<${REG}>;`,
        `@group(1) @binding(${GEOMETRY_BINDING.starts}) var<storage, read_write> gsStarts: `
            + 'array<u32>;',
        `@group(1) @binding(${GEOMETRY_BINDING.counts}) var<storage, read_write> gsCounts: `
            + 'array<vec4<u32>>;',
        `@group(1) @binding(${GEOMETRY_BINDING.params}) var<uniform> gsParams: GsParams;`,
        ...(options.limited ? [`@group(1) @binding(${GEOMETRY_BINDING.limit}) var<storage, read>`
            + ' gsLimit: array<u32>;'] : []),
        `var<private> vgs: array<array<${REG}, ${inputs}>, ${vertices}>;`,
        ...Array.from({ length: outputs }, (_, index)=>`var<private> o${index}: ${REG};`),
        'var<private> primitiveId: u32;',
        'var<private> gsInstance: u32;',
        'var<private> gsInvocation: u32;',
        'var<private> gsEmitted: vec4<u32>;',
        'var<private> gsMade: vec4<u32>;',
        'var<private> gsStrip: vec4<u32>;',
        // The place a stream's vertices take among the shader's streams.
        'fn gsSlot(stream: u32) -> u32 {',
        '    switch (stream) {',
        ...stage.streams.map((stream, slot)=>`        case ${stream}u: { return ${slot}u; }`),
        `        default: { return ${streams}u; }`,
        '    }',
        '}',
        'fn gsEmit(stream: u32) {',
        '    let s = gsSlot(stream);',
        `    if (s >= ${streams}u || gsEmitted[s] >= ${most}u) { return; }`,
        `    let at = (gsInvocation * ${streams}u + s) * ${most}u + gsEmitted[s];`,
        ...Array.from({ length: outputs }, (_, index)=>
            `    gsVertices[at * ${outputs}u + ${index}u] = o${index};`),
        '    gsStarts[at] = select(0u, 1u, gsStrip[s] == 0u);',
        '    gsEmitted[s] += 1u;',
        '    gsStrip[s] += 1u;',
        `    if (gsStrip[s] >= ${stage.outputVertices}u) { gsMade[s] += 1u; }`,
        '}',
        'fn gsCut(stream: u32) {',
        '    let s = gsSlot(stream);',
        `    if (s < ${streams}u) { gsStrip[s] = 0u; }`,
        '}',
        // The index at a position of the draw, for a strip's cuts.
        'fn gsCutAt(position: u32) -> bool {',
        '    if (gsParams.indexBytes == 0u) { return false; }',
        '    let b = gsParams.indexOffset + (gsParams.first + position) * gsParams.indexBytes;',
        '    if ((b >> 2u) >= arrayLength(&gsIndices)) { return false; }',
        '    let word = gsIndices[b >> 2u];',
        '    if (gsParams.indexBytes == 2u) {',
        '        return extractBits(word, (b & 2u) * 8u, 16u) == 0xffffu;',
        '    }',
        '    return word == 0xffffffffu;',
        '}',
        'fn gsBody() {',
        ...Array.from({ length: gs.temps }, (_, index)=>`    var r${index}: ${REG};`),
        ...gs.indexableTemps.map(temp=>`    var x${temp.index}: array<${REG}, ${temp.size}>;`),
        ...bodyText(gs, null),
        '}',
        '@compute @workgroup_size(64)',
        'fn geometryMain(@builtin(global_invocation_id) id: vec3<u32>) {',
        '    if (id.x >= gsParams.invocations) { return; }',
        '    gsInvocation = id.x;',
        `    gsInstance = id.x % ${stage.instances}u;`,
        `    let gsFlat = id.x / ${stage.instances}u;`,
        '    let gsDrawn = gsFlat / max(1u, gsParams.prims);',
        '    let gsPrim = gsFlat % max(1u, gsParams.prims);',
        '    primitiveId = gsPrim;',
        `    var gsAt: array<u32, ${vertices}>;`,
        '    var gsWhole = true;',
        `    let gsStripped = ${STRIP_TOPOLOGIES.map(t=>`gsParams.topology == ${t}u`)
            .join(' || ')};`,
        `    for (var j = 0u; j < ${vertices}u; j++) {`,
        `        gsAt[j] = select(gsPrim * ${vertices}u + j, gsPrim + j, gsStripped);`,
        '        if (gsStripped && gsCutAt(gsAt[j])) { gsWhole = false; }',
        '    }',
        // The primitives the positions the GPU holds make, a strip's as
        // overlapping as its own; with `instanced`, the instances too.
        ...(options.limited ? [
            `    let gsHeld = select(gsLimit[0] / ${vertices}u, max(gsLimit[0], ${vertices - 1}u)`
                + ` - ${vertices - 1}u, gsStripped);`,
            '    if (gsPrim >= gsHeld) { gsWhole = false; }',
        ] : []),
        ...(options.instanced ? ['    if (gsDrawn >= gsLimit[1]) { gsWhole = false; }'] : []),
        ...(vertices === 3 ? [
            '    if (gsWhole && gsParams.topology == 5u) {',
            // The strip's first triangle: after the last cut index, or the first.
            '        var gsFrom = 0u;',
            '        if (gsParams.indexBytes != 0u) {',
            '            gsFrom = gsPrim;',
            '            loop {',
            '                if (gsFrom == 0u || gsCutAt(gsFrom - 1u)) { break; }',
            '                gsFrom -= 1u;',
            '            }',
            '        }',
            '        if (((gsPrim - gsFrom) & 1u) == 1u) {',
            '            let gsFirst = gsAt[0];',
            '            gsAt[0] = gsAt[1];',
            '            gsAt[1] = gsFirst;',
            '        }',
            '    }',
        ] : []),
        '    if (gsWhole) {',
        `        for (var j = 0u; j < ${vertices}u; j++) {`,
        `            for (var reg = 0u; reg < ${inputs}u; reg++) {`,
        `                vgs[j][reg] = gsIn[(gsDrawn * gsParams.points + gsAt[j]) * ${inputs}u`
            + ' + reg];',
        '            }',
        '        }',
        '        gsBody();',
        '    }',
        `    gsCounts[id.x * 2u] = gsMade;`,
        `    gsCounts[id.x * 2u + 1u] = gsEmitted;`,
        '}',
    ].join('\n');
    return { code, entries: declared.entries, unsupported: [...new Set(unsupported)] };
}

/** Group 2 of a draw of what a geometry shader made (`linkGeometryDraw`). */
export const GEOMETRY_DRAW_BINDING = Object.freeze({ vertices: 0 });

/**
 * What a geometry shader made, drawn: the vertex stage reads each vertex the
 * index list names out of the shader's places (`gsVertices`) into the
 * registers its outputs are, and the pixel shader reads those by semantic as
 * from a vertex shader. Only the rasterized stream's outputs are drawn.
 *
 * @param {TranslatedShader} gs
 * @param {GeometryStage} stage
 * @param {number} stream  The rasterized stream.
 * @param {TranslatedShader} ps
 * @param {{ targets?: readonly number[], clipDistances?: boolean,
 *     depthBias?: { units: number, slope: number, clamp: number } }} [options]
 * @returns {LinkedProgram}
 */
export function linkGeometryDraw(gs, stage, stream, ps, options = {}){
    const outputs = stage.outputRegisters;
    /** @type {TranslatedShader} */
    const drawn = {
        ...NO_PIXEL_SHADER,
        kind: SHADER_KIND.VERTEX,
        inputs: [],
        outputs: gs.outputs.filter(element=>(element.stream ?? 0) === stream),
        outputRegisters: outputs,
        body: [
            ...Array.from({ length: outputs }, (_, index)=>
                `    o${index} = gsVertices[gsVertex * ${outputs}u + ${index}u];`),
            { ret: true },
        ],
    };
    return linkProgram(drawn, ps, { ...options, vertexLoad: {
        text: [`@group(2) @binding(${GEOMETRY_DRAW_BINDING.vertices}) var<storage, read> `
            + `gsVertices: array<${REG}>;`],
        params: '@builtin(vertex_index) gsVertex: u32',
        load: [],
    } });
}

/**
 * @typedef {Object} VertexLoad
 * @property {string[]} text    Module-scope declarations the load reads.
 * @property {string} params    The vertex entry point's parameters.
 * @property {string[]} load    Statements filling the stage's registers.
 */

/** @param {number} mask @returns {number} */
const firstComponent = mask=>[0, 1, 2, 3].find(c=>(mask & (1 << c)) !== 0) ?? 0;

/**
 * Statements copying what one stage wrote into the registers the next reads,
 * element by element as their signatures name them: the same semantic may sit
 * in another register, or at other components of it, on either side. An
 * element the writer has no counterpart for is left as it was (zero).
 *
 * @param {import('./dxbc.js').SignatureElement[]} from
 * @param {import('./dxbc.js').SignatureElement[]} to
 * @param {(register: number) => string} read
 * @param {(register: number) => string} write
 * @returns {string[]}
 */
function copyBySemantic(from, to, read, write){
    /** @type {string[]} */
    const lines = [];
    for (const element of to)
    {
        const source = from.find(candidate=>semanticKey(candidate) === semanticKey(element));
        if (!source)
        {
            continue;
        }
        const toFirst = firstComponent(element.mask);
        const fromFirst = firstComponent(source.mask);
        for (let c = toFirst; c < 4; c++)
        {
            const fc = fromFirst + c - toFirst;
            if ((element.mask & (1 << c)) !== 0 && fc < 4)
            {
                lines.push(`${write(element.register)}.${COMPONENT[c]} = `
                    + `${read(source.register)}.${COMPONENT[fc]};`);
            }
        }
    }
    return lines;
}

/** A float's bits, as a register keeps them. @param {string} value */
const floatBits = value=>`bitcast<u32>(${value})`;

/**
 * How a vertex format is read out of a buffer's words: how many bytes an
 * element takes and the register it makes of the words that hold it, the
 * components it lacks filled as a vertex fetch fills them (0, 0, 0, 1).
 *
 * @param {string} format  A WebGPU vertex format (`gpuformats.js`'s `VERTEX_FORMAT`).
 * @returns {{ bytes: number, register: (words: string[]) => string } | null}
 */
export function vertexFetch(format){
    if (format === 'rg11b10ufloat')
    {
        // Floats with no sign: five bits of exponent biased by 15 over six
        // mantissa bits (red, green) or five (blue); exponent 31 is infinity
        // or NaN, exponent 0 a denormal.
        /** @param {string} word @param {number} shift @param {number} mantissa */
        const small = (word, shift, mantissa)=>{
            const e = `extractBits(${word}, ${shift + mantissa}u, 5u)`;
            const m = `extractBits(${word}, ${shift}u, ${mantissa}u)`;
            const placed = `(${m} << ${23 - mantissa}u)`;
            return `select(select(((${e} + 112u) << 23u) | ${placed}, 0x7f800000u | ${placed}, `
                + `${e} == 31u), bitcast<u32>(f32(${m}) * ${2 ** -(14 + mantissa)}), ${e} == 0u)`;
        };
        return {
            bytes: 4,
            register: ([word])=>`${REG}(${small(word, 0, 6)}, ${small(word, 11, 6)}, `
                + `${small(word, 22, 5)}, 0x3f800000u)`,
        };
    }
    if (format === 'unorm10-10-10-2')
    {
        return {
            bytes: 4,
            register: ([word])=>`${REG}(${[0, 10, 20].map(shift=>
                floatBits(`f32(extractBits(${word}, ${shift}u, 10u)) / 1023.0`)).join(', ')}, `
                + `${floatBits(`f32(extractBits(${word}, 30u, 2u)) / 3.0`)})`,
        };
    }
    const bgra = format === 'unorm8x4-bgra';
    const match = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x(\d))?$/
        .exec(bgra ? 'unorm8x4' : format);
    if (!match)
    {
        return null;
    }
    const kind = match[1];
    const bits = Number(match[2]);
    const count = Number(match[3] ?? 1);
    const integer = kind === 'uint' || kind === 'sint';
    const one = integer ? '1u' : '0x3f800000u';
    return {
        bytes: (bits * count) / 8,
        register: words=>{
            /** @type {string[]} */
            const components = [];
            for (let c = 0; c < 4; c++)
            {
                if (c >= count)
                {
                    components.push(c === 3 ? one : '0u');
                    continue;
                }
                const word = words[Math.floor((c * bits) / 32)];
                const shift = (c * bits) % 32;
                const raw = bits === 32 ? word : `extractBits(${word}, ${shift}u, ${bits}u)`;
                const signed = bits === 32 ? `bitcast<i32>(${word})`
                    : `extractBits(bitcast<i32>(${word}), ${shift}u, ${bits}u)`;
                const max = 2 ** (bits - 1) - 1;
                components.push({
                    float: bits === 16 ? floatBits(`unpack2x16float(${raw}).x`) : raw,
                    uint: raw,
                    sint: `bitcast<u32>(${signed})`,
                    unorm: floatBits(`f32(${raw}) / ${2 ** bits - 1}.0`),
                    snorm: floatBits(`max(f32(${signed}) / ${max}.0, -1.0)`),
                }[kind] ?? raw);
            }
            if (bgra)
            {
                [components[0], components[2]] = [components[2], components[0]];
            }
            return `${REG}(${components.join(', ')})`;
        },
    };
}

/** Group 1 of a vertex shader run as compute (`linkVertexPatches`): what it reads and writes. */
export const VERTEX_PATCH_BINDING = Object.freeze({
    indices: 0, out: 1, params: 2, streams: 3,
});

/**
 * A vertex shader as one compute program, one invocation a control point of
 * a draw through the tessellator: the point's vertex found as the draw finds
 * it (`vsIndices`, the index buffer's words, or the first vertex counted on),
 * its elements read out of the vertex buffers' words (`vsStream<n>`, one a
 * buffer the input layout reads, `streams` as `render.js`'s `vertexLayouts`
 * gives them) and decoded as a vertex fetch decodes them, the shader's body
 * run, and what it wrote stored (`vsOut`) at the registers the hull shader
 * reads it from, matched by semantic. An element past the end of its buffer
 * reads zero.
 *
 * `vsParams`: the points, the points an instance draws, the index size in
 * bytes (0 for a draw without indices), the index buffer's byte offset, the
 * first index or vertex, the base vertex, the first instance; then, a buffer
 * each, its byte offset and stride.
 *
 * @param {TranslatedShader} vs
 * @param {import('./dxbc.js').SignatureElement[]} inputs  The hull shader's control point inputs.
 * @param {number} registers  The hull shader's input registers a point (`LinkedHull.stage`).
 * @param {{ stepMode: string, attributes: { shaderLocation: number, offset: number,
 *     format: string }[] }[]} streams
 * @returns {{ code: string, entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
export function linkVertexPatches(vs, inputs, registers, streams){
    const declared = declarations(vs, 0, STAGE.COMPUTE);
    /** @type {string[]} */
    const unsupported = [...vs.unsupported, ...declared.unsupported];
    /** @type {string[]} */
    const fetch = [];
    streams.forEach((stream, k)=>{
        const element = stream.stepMode === 'instance'
            ? 'vsParams.startInstance + vsInstance' : 'vsVertex';
        // An element far past the buffer's end (an index plus a negative base
        // vertex wraps to one) reads zero, its address never wrapped back in.
        fetch.push(`    let vsIn${k} = vsParams.streams[${k}].y == 0u || (${element})`
            + ` <= arrayLength(&vsStream${k}) * 4u / vsParams.streams[${k}].y;`);
        fetch.push(`    let vsAt${k} = vsParams.streams[${k}].x + (${element})`
            + ` * vsParams.streams[${k}].y;`);
        for (const attribute of stream.attributes)
        {
            const decoder = vertexFetch(attribute.format);
            if (!decoder)
            {
                unsupported.push(`vertex format ${attribute.format}`);
                continue;
            }
            const at = `vsAt${k} + ${attribute.offset}u`;
            const words = Array.from({ length: Math.ceil(decoder.bytes / 4) },
                (_, index)=>`vsWord${k}(${at} + ${index * 4}u)`);
            const within = `vsIn${k} && ${at} + ${decoder.bytes}u`
                + ` <= arrayLength(&vsStream${k}) * 4u`;
            fetch.push(`    if (${within}) {`,
                `        v${attribute.shaderLocation} = ${decoder.register(words)};`, '    }');
        }
    });
    for (const element of vs.inputs)
    {
        if (element.systemValue === SYSTEM_VALUE.VERTEX_ID)
        {
            fetch.push(`    v${element.register}.x = vsVertexId;`);
        }
        else if (element.systemValue === SYSTEM_VALUE.INSTANCE_ID)
        {
            fetch.push(`    v${element.register}.x = vsInstance;`);
        }
        else if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`vertex input system value ${element.systemValue}`);
        }
    }
    const out = Math.max(1, registers);
    const code = [
        ...declared.text,
        'struct VsParams { count: u32, perInstance: u32, indexBytes: u32, indexOffset: u32,',
        '    first: u32, baseVertex: i32, startInstance: u32, pad: u32,',
        `    streams: array<${REG}, ${Math.max(1, streams.length)}>, }`,
        `@group(1) @binding(${VERTEX_PATCH_BINDING.indices}) var<storage, read> vsIndices: `
            + 'array<u32>;',
        `@group(1) @binding(${VERTEX_PATCH_BINDING.out}) var<storage, read_write> vsOut: `
            + `array<${REG}>;`,
        `@group(1) @binding(${VERTEX_PATCH_BINDING.params}) var<uniform> vsParams: VsParams;`,
        ...streams.map((_, k)=>`@group(1) @binding(${VERTEX_PATCH_BINDING.streams + k})`
            + ` var<storage, read> vsStream${k}: array<u32>;`),
        ...Array.from({ length: vs.inputRegisters }, (_, index)=>
            `var<private> v${index}: ${REG};`),
        ...Array.from({ length: vs.outputRegisters }, (_, index)=>
            `var<private> o${index}: ${REG};`),
        ...streams.map((_, k)=>[
            `fn vsWord${k}(b: u32) -> u32 {`,
            `    let w = b >> 2u;`,
            `    let n = arrayLength(&vsStream${k});`,
            '    if (w >= n) { return 0u; }',
            '    let s = (b & 3u) * 8u;',
            `    let lo = vsStream${k}[w];`,
            '    if (s == 0u) { return lo; }',
            `    let hi = select(0u, vsStream${k}[min(w + 1u, n - 1u)], w + 1u < n);`,
            '    return (lo >> s) | (hi << (32u - s));',
            '}'].join('\n')),
        'fn vsIndex(i: u32) -> u32 {',
        '    let b = vsParams.indexOffset + i * vsParams.indexBytes;',
        '    if ((b >> 2u) >= arrayLength(&vsIndices)) { return 0u; }',
        '    let word = vsIndices[b >> 2u];',
        '    if (vsParams.indexBytes == 2u) { return extractBits(word, (b & 2u) * 8u, 16u); }',
        '    return word;',
        '}',
        'fn vsBody() {',
        ...Array.from({ length: vs.temps }, (_, index)=>`    var r${index}: ${REG};`),
        ...vs.indexableTemps.map(temp=>`    var x${temp.index}: array<${REG}, ${temp.size}>;`),
        ...bodyText(vs, null),
        '}',
        '@compute @workgroup_size(64)',
        'fn vertexPatches(@builtin(global_invocation_id) id: vec3<u32>) {',
        '    if (id.x >= vsParams.count) { return; }',
        '    let vsInstance = id.x / max(1u, vsParams.perInstance);',
        '    let vsPoint = id.x % max(1u, vsParams.perInstance);',
        '    var vsVertex = vsParams.first + vsPoint;',
        // Direct3D's vertex ID counts from zero in a draw without indices
        // and is the index itself in one with them: neither the first
        // vertex nor the base vertex is in it (test_vertex_id).
        '    var vsVertexId = vsPoint;',
        '    if (vsParams.indexBytes != 0u) {',
        '        vsVertexId = vsIndex(vsParams.first + vsPoint);',
        '        vsVertex = bitcast<u32>(bitcast<i32>(vsVertexId) + vsParams.baseVertex);',
        '    }',
        ...fetch,
        '    vsBody();',
        `    var hs: array<${REG}, ${out}>;`,
        ...copyBySemantic(vs.outputs.filter(element=>element.register < vs.outputRegisters),
            inputs, register=>`o${register}`, register=>`    hs[${register}]`),
        `    for (var reg = 0u; reg < ${out}u; reg++) {`,
        `        vsOut[id.x * ${out}u + reg] = hs[reg];`,
        '    }',
        '}',
    ].join('\n');
    return { code, entries: declared.entries, unsupported: [...new Set(unsupported)] };
}

/** Group 2 of a domain shader drawn as the vertex stage (`linkDomain`). */
export const DOMAIN_BINDING = Object.freeze({
    points: 0, constants: 1, domain: 2, indices: 3, offsets: 4, params: 5,
});

/**
 * A domain shader and a pixel shader as the two stages of a draw over what the
 * tessellator made, the domain shader as the vertex stage: a vertex is an
 * index the tessellator wrote (`dsIndices`), drawn in order without an index
 * buffer; its patch is found among the patches' first indices (`dsOffsets`,
 * the tessellator's offsets), its domain point (`dsDomain`) where the patch's
 * points start, and its control points and patch constants are what the hull
 * program wrote for that patch (`dsPoints`, `dsConstants`), read into the
 * registers the domain shader names for each semantic. `dsParams`: x the
 * patches, y the patches an instance draws.
 *
 * @param {TranslatedShader} ds
 * @param {import('./dxbc.js').DxbcContainer} dsContainer
 * @param {TranslatedShader} ps
 * @param {import('./dxbc.js').DxbcContainer} hull
 * @param {LinkedHull['stage']} stage
 * @param {{ targets?: readonly number[], clipDistances?: boolean,
 *     depthBias?: { units: number, slope: number, clamp: number } }} [options]
 * @returns {LinkedProgram}
 */
export function linkDomain(ds, dsContainer, ps, hull, stage, options = {}){
    const load = domainLoad(ds, dsContainer, hull, stage, 2);
    return linkProgram(ds, ps, { ...options, vertexLoad: {
        text: load.text,
        params: '@builtin(vertex_index) dsVertex: u32',
        load: load.load,
    } });
}

/**
 * What a domain shader reads for the tessellator's index `dsVertex`: its
 * patch, domain point, control points and patch constants (`linkDomain`),
 * the declarations in group `group`.
 *
 * @param {TranslatedShader} ds
 * @param {import('./dxbc.js').DxbcContainer} dsContainer
 * @param {import('./dxbc.js').DxbcContainer} hull
 * @param {LinkedHull['stage']} stage
 * @param {number} group
 * @returns {{ text: string[], load: string[] }}
 */
function domainLoad(ds, dsContainer, hull, stage, group){
    /** @param {import('./dxbc.js').DxbcContainer} container */
    const constantsOf = container=>patchConstantsOf(container.chunks);
    /** @param {import('./dxbc.js').SignatureElement[]} elements */
    const registersOf = elements=>Math.max(1, ...elements.map(element=>element.register + 1));
    const inputs = registersOf(ds.inputs);
    const constants = constantsOf(dsContainer);
    const points = stage.outputPoints;
    const third = stage.domain === 'tri' ? '1.0 - dsAt.x - dsAt.y' : '0.0';
    return {
        text: [
            `@group(${group}) @binding(${DOMAIN_BINDING.points}) var<storage, read> dsPoints: `
                + `array<${REG}>;`,
            `@group(${group}) @binding(${DOMAIN_BINDING.constants}) var<storage, read>`
                + ` dsConstants: array<${REG}>;`,
            `@group(${group}) @binding(${DOMAIN_BINDING.domain}) var<storage, read> dsUv: `
                + 'array<vec2<f32>>;',
            `@group(${group}) @binding(${DOMAIN_BINDING.indices}) var<storage, read> dsIndices: `
                + 'array<u32>;',
            `@group(${group}) @binding(${DOMAIN_BINDING.offsets}) var<storage, read> dsOffsets: `
                + 'array<vec2<u32>>;',
            `@group(${group}) @binding(${DOMAIN_BINDING.params}) var<uniform> dsParams:`
                + ' vec4<u32>;',
            `var<private> vicp: array<array<${REG}, ${inputs}>, ${points}>;`,
            `var<private> vpc: array<${REG}, ${registersOf(constants)}>;`,
            `var<private> dsDomain: ${REG};`,
            'var<private> primitiveId: u32;',
        ],
        load: [
            // The last patch whose indices start at or before this one: a
            // patch that made none starts where the next one does.
            '    var dsLow = 0u;',
            '    var dsHigh = max(dsParams.x, 1u) - 1u;',
            '    loop {',
            '        if (dsLow >= dsHigh) { break; }',
            '        let dsMid = (dsLow + dsHigh + 1u) / 2u;',
            '        if (dsOffsets[dsMid].y <= dsVertex) { dsLow = dsMid; }'
                + ' else { dsHigh = dsMid - 1u; }',
            '    }',
            '    let dsPatch = dsLow;',
            '    let dsAt = dsUv[dsOffsets[dsPatch].x + dsIndices[dsVertex]];',
            `    dsDomain = bitcast<${REG}>(vec4<f32>(dsAt.x, dsAt.y, ${third}, 0.0));`,
            '    primitiveId = dsPatch % max(1u, dsParams.y);',
            `    for (var cp = 0u; cp < ${points}u; cp++) {`,
            ...copyBySemantic(hull.outputs, ds.inputs,
                register=>`dsPoints[(dsPatch * ${points}u + cp) * ${stage.outputRegisters}u`
                    + ` + ${register}u]`,
                register=>`        vicp[cp][${register}]`),
            '    }',
            ...copyBySemantic(constantsOf(hull), constants,
                register=>`dsConstants[dsPatch * ${stage.constantRegisters}u + ${register}u]`,
                register=>`    vpc[${register}]`),
        ],
    };
}

/**
 * Group 1 of a domain shader run as compute over the tessellator's indices
 * (`linkDomainPositions`): what the draw would read, where the registers go,
 * and the tessellator's arguments, whose first word is how many indices it
 * wrote.
 */
export const DOMAIN_POSITION_BINDING = Object.freeze({ ...DOMAIN_BINDING, out: 6, count: 7 });

/**
 * A domain shader as one compute program, one invocation an index the
 * tessellator wrote, for a geometry shader or stream output after it: the
 * index read as the draw of the domain shader reads it (`linkDomain`), the
 * body run, and what it wrote stored (`dsOut`) at the registers the next
 * stage reads it from, matched by semantic, at the index's position. Past
 * the indices written (`dsCount`) nothing is.
 *
 * @param {TranslatedShader} ds
 * @param {import('./dxbc.js').DxbcContainer} dsContainer
 * @param {import('./dxbc.js').DxbcContainer} hull
 * @param {LinkedHull['stage']} stage
 * @param {import('./dxbc.js').SignatureElement[]} inputs  The next stage's inputs.
 * @param {number} registers  Its input registers a vertex.
 * @returns {{ code: string, entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
export function linkDomainPositions(ds, dsContainer, hull, stage, inputs, registers){
    const declared = declarations(ds, 0, STAGE.COMPUTE);
    const load = domainLoad(ds, dsContainer, hull, stage, 1);
    const out = Math.max(1, registers);
    const code = [
        ...declared.text,
        ...load.text,
        `@group(1) @binding(${DOMAIN_POSITION_BINDING.out}) var<storage, read_write> dsOut: `
            + `array<${REG}>;`,
        `@group(1) @binding(${DOMAIN_POSITION_BINDING.count}) var<storage, read> dsCount: `
            + 'array<u32>;',
        ...Array.from({ length: ds.outputRegisters }, (_, index)=>
            `var<private> o${index}: ${REG};`),
        'fn dsBody() {',
        ...Array.from({ length: ds.temps }, (_, index)=>`    var r${index}: ${REG};`),
        ...ds.indexableTemps.map(temp=>`    var x${temp.index}: array<${REG}, ${temp.size}>;`),
        ...bodyText(ds, null),
        '}',
        '@compute @workgroup_size(64)',
        'fn domainPositions(@builtin(global_invocation_id) id: vec3<u32>) {',
        '    if (id.x >= dsCount[0]) { return; }',
        '    let dsVertex = id.x;',
        ...load.load,
        '    dsBody();',
        `    var next: array<${REG}, ${out}>;`,
        ...copyBySemantic(ds.outputs.filter(element=>element.register < ds.outputRegisters),
            inputs, register=>`o${register}`, register=>`    next[${register}]`),
        `    for (var reg = 0u; reg < ${out}u; reg++) {`,
        `        dsOut[id.x * ${out}u + reg] = next[reg];`,
        '    }',
        '}',
    ].join('\n');
    return { code, entries: declared.entries,
        unsupported: [...new Set([...ds.unsupported, ...declared.unsupported])] };
}
