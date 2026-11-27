/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A depth texture's depths and stencil brought out as numbers, and put back
 * from them: what a program that locks its depth buffer, or blits into one,
 * reads and writes. WebGPU copies no depth24plus out of a texture and none
 * into one, and no depth with a stencil either way, so both go through a
 * shader: a compute pass that loads each texel into a storage buffer, and a
 * pass over the depth alone in which a triangle over the whole texture
 * writes each texel's depth (and then, a bit at a time, its stencil).
 *
 * The words, both ways, are the depths as 32-bit floats, one a texel by
 * rows, then for a format with a stencil the stencils, one word a texel. The
 * write takes two words in front of them: the texture's width and its texel
 * count.
 */

/** Threads a workgroup of the read; a grid is at most this many a row of groups. */
export const DEPTH_READ_GROUP = 64;
/** The most workgroups a grid's dimension takes (WebGPU's default limit). */
export const MAX_GROUPS = 65535;

/**
 * The compute pass that loads every texel of a depth texture (and its
 * stencil) into words.
 *
 * @param {boolean} stencil
 * @returns {string}
 */
export function depthReadShader(stencil){
    return [
        '@group(0) @binding(0) var depthTexture: texture_depth_2d;',
        ...(stencil ? ['@group(0) @binding(1) var stencilTexture: texture_2d<u32>;'] : []),
        '@group(0) @binding(2) var<storage, read_write> words: array<u32>;',
        `@compute @workgroup_size(${DEPTH_READ_GROUP})`,
        'fn computeMain(@builtin(global_invocation_id) id: vec3u) {',
        '    let size = textureDimensions(depthTexture);',
        '    let count = size.x * size.y;',
        `    let i = id.y * ${MAX_GROUPS * DEPTH_READ_GROUP}u + id.x;`,
        '    if (i >= count) { return; }',
        '    let at = vec2u(i % size.x, i / size.x);',
        '    words[i] = bitcast<u32>(textureLoad(depthTexture, at, 0));',
        ...(stencil ? ['    words[count + i] = textureLoad(stencilTexture, at, 0).r;'] : []),
        '}',
    ].join('\n');
}

/**
 * The draw that writes a depth texture from words: `depthMain` each texel's
 * depth, `stencilMain` (with the override `bit`) kept where that bit of the
 * texel's stencil is set.
 */
export const DEPTH_WRITE_SHADER = [
    '@group(0) @binding(0) var<storage, read> words: array<u32>;',
    'override bit: u32 = 0u;',
    '@vertex fn vertexMain(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {',
    '    let xy = vec2<f32>(f32((v << 1u) & 2u), f32(v & 2u));',
    '    return vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);',
    '}',
    'fn texelOf(position: vec4<f32>) -> u32 {',
    '    return u32(position.y) * words[0] + u32(position.x);',
    '}',
    '@fragment fn depthMain(@builtin(position) position: vec4<f32>)'
        + ' -> @builtin(frag_depth) f32 {',
    '    return clamp(bitcast<f32>(words[2u + texelOf(position)]), 0.0, 1.0);',
    '}',
    '@fragment fn stencilMain(@builtin(position) position: vec4<f32>) {',
    '    if ((words[2u + words[1] + texelOf(position)] & (1u << bit)) == 0u) { discard; }',
    '}',
].join('\n');

/** @param {string} format a WebGPU depth format */
export const depthHasStencil = format=>format.endsWith('stencil8');

/**
 * The grid a read of `count` texels dispatches: rows of at most
 * `MAX_GROUPS` workgroups.
 *
 * @param {number} count
 * @returns {number[]}
 */
export function depthReadGrid(count){
    const groups = Math.max(1, Math.ceil(count / DEPTH_READ_GROUP));
    return [Math.min(groups, MAX_GROUPS), Math.ceil(groups / MAX_GROUPS), 1];
}

/**
 * The words a write of these depths (and stencils) takes.
 *
 * @param {number} width
 * @param {Float32Array} depths  one a texel, by rows
 * @param {Uint8Array | null} [stencils]
 * @returns {Uint32Array}
 */
export function depthWriteWords(width, depths, stencils = null){
    const count = depths.length;
    const words = new Uint32Array(2 + count * (stencils ? 2 : 1));
    words[0] = width;
    words[1] = count;
    words.set(new Uint32Array(depths.buffer, depths.byteOffset, count), 2);
    if (stencils)
    {
        words.set(stencils, 2 + count);
    }
    return words;
}

/**
 * The depths and stencils a read brought back.
 *
 * @param {Uint8Array} bytes  the words, as `depthReadShader` writes them
 * @param {number} count
 * @param {boolean} stencil
 * @returns {{ depths: Float32Array, stencils: Uint8Array | null }}
 */
export function depthReadValues(bytes, count, stencil){
    const copy = bytes.slice(0, count * 4 * (stencil ? 2 : 1));
    return {
        depths: new Float32Array(copy.buffer, 0, count),
        stencils: stencil ? Uint8Array.from(new Uint32Array(copy.buffer, count * 4, count)) : null,
    };
}
