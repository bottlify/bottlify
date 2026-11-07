/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program's stages write to memory at link (OpenGL 4.3 sections
 * 7.8 and 7.7): its shader storage blocks and its atomic counters.
 *
 * - **A storage block is laid out once for every stage** that names it,
 *   std430 or std140 as it says, and std140 where it says `shared` or
 *   `packed`, whose places the implementation picks - the uniform blocks'
 *   choice (`glsl-link.js`). A last member sized at run time takes what the
 *   buffer bound to it holds past the rest.
 * - **The fragment and compute stages have storage**; WebGPU writes no
 *   storage from a vertex stage, and the geometry stage, a compute pass here,
 *   is not given any: GL_MAX_VERTEX_SHADER_STORAGE_BLOCKS and the geometry
 *   stage's are 0, which the specification allows (decision A172).
 * - **An atomic counter lies at its binding's offset**: the one `layout`
 *   gives it, or the next past the counter before it on that binding.
 */

import { blockLayout } from './glsl-layout.js';
import { glslName } from './glsl-types.js';

/** The storage blocks a stage and a program may have, and their bindings (4.3 table 23.64). */
export const STORAGE_LIMITS = Object.freeze({
    perStage: 8, combined: 8, bindings: 8, size: 1 << 27,
});

/**
 * SHADER_STORAGE_BUFFER_OFFSET_ALIGNMENT: WebGPU's alignment of a storage
 * binding's offset, which an atomic counter buffer's range is held to as well.
 */
export const STORAGE_BUFFER_OFFSET_ALIGNMENT = 256;

/**
 * The image limits (4.2 table 23.62): GL's 8 units, and WebGPU's 4 storage
 * textures a stage where GL asks for 8 (decision A173).
 */
export const IMAGE_LIMITS = Object.freeze({ units: 8, perStage: 4 });

/**
 * The image formats GLSL names (4.20 section 4.4.6.2) that WebGPU stores
 * into, with the internal format glBindImageTexture names them by and
 * WGSL's texel format; the others of GL's table 8.33 bind and are refused
 * when a shader reaches them (decision A174).
 *
 * @type {readonly [string, number, string][]}
 */
export const IMAGE_FORMATS = Object.freeze([
    ['rgba32f', 0x8814, 'rgba32float'], ['rgba16f', 0x881a, 'rgba16float'],
    ['rg32f', 0x8230, 'rg32float'], ['r32f', 0x822e, 'r32float'],
    ['rgba8', 0x8058, 'rgba8unorm'], ['rgba8_snorm', 0x8f97, 'rgba8snorm'],
    ['rgba32i', 0x8d82, 'rgba32sint'], ['rgba16i', 0x8d88, 'rgba16sint'],
    ['rgba8i', 0x8d8e, 'rgba8sint'], ['rg32i', 0x823b, 'rg32sint'], ['r32i', 0x8235, 'r32sint'],
    ['rgba32ui', 0x8d70, 'rgba32uint'], ['rgba16ui', 0x8d76, 'rgba16uint'],
    ['rgba8ui', 0x8d7c, 'rgba8uint'], ['rg32ui', 0x823c, 'rg32uint'],
    ['r32ui', 0x8236, 'r32uint'],
]);

/**
 * Every internal format glBindImageTexture takes (4.2 table 8.33), WebGPU's
 * or not.
 *
 * @type {ReadonlySet<number>}
 */
export const IMAGE_UNIT_FORMATS = new Set([...IMAGE_FORMATS.map(([, gl])=>gl),
    // rg16f, r11f_g11f_b10f, r16f, rgba16, rgb10_a2, rg16, rg8, r16, r8,
    0x822f, 0x8c3a, 0x822d, 0x805b, 0x8059, 0x822c, 0x822b, 0x822a, 0x8229,
    // rgba16_snorm, rg16_snorm, rg8_snorm, r16_snorm, r8_snorm,
    0x8f9b, 0x8f99, 0x8f95, 0x8f98, 0x8f94,
    // rg16i, rg8i, r16i, r8i, rgb10_a2ui, rg16ui, rg8ui, r16ui, r8ui.
    0x8239, 0x8237, 0x8233, 0x8231, 0x906f, 0x823a, 0x8238, 0x8234, 0x8232]);

/** The atomic counter buffers (4.2 table 23.61): one binding, 8 counters a stage. */
export const COUNTER_LIMITS = Object.freeze({
    bindings: 1, perStage: 8, buffersPerStage: 1, bufferBytes: 32,
});

/**
 * A shader storage block a program's stages read or write, by element of
 * an array of blocks.
 *
 * @typedef {Object} StorageBlock
 * @property {string} name  as glGetProgramResourceIndex takes it: `B`, or `B[2]`
 * @property {string} blockName
 * @property {number} element
 * @property {string | null} instance
 * @property {number} size  the bytes of its members before one sized at run time
 * @property {number} runtimeStride  that member's array stride, 0 for none
 * @property {'std140' | 'std430'} packing
 * @property {import('./glsl-layout.js').MemberLayout[]} members
 * @property {{ vertex: boolean, geometry: boolean, fragment: boolean, compute: boolean }} stages
 * @property {number} binding  `layout(binding)`, else 0
 */

/**
 * An atomic counter (`atomic_uint`), or an array of them.
 *
 * @typedef {Object} AtomicCounter
 * @property {string} name
 * @property {number} binding
 * @property {number} offset  in bytes
 * @property {number} count  1, or the array's length
 * @property {{ vertex: boolean, geometry: boolean, fragment: boolean, compute: boolean }} stages
 */

/**
 * A linked stage, as much of it as these read (`glsl-link.js` LinkedStage).
 *
 * @typedef {{ stage: 'vertex' | 'geometry' | 'fragment' | 'compute',
 *     globals: import('./glsl-check.js').VariableSymbol[], uses: Set<string> }} LinkedStage
 * @typedef {{ vertex: LinkedStage | null, geometry: LinkedStage | null,
 *     fragment: LinkedStage | null, compute: LinkedStage | null }} Stages
 */

/** @param {import('./glsl-check.js').InterfaceBlock} info */
const shapeOf = info=>`${info.arrays.join(',')}|${Object.keys(info.layout).sort().join(',')}|`
    + info.members.map(m=>`${glslName(m.type)} ${m.name}${m.layout.row_major ? ' r' : ''}`)
        .join(';');

/** @param {LinkedStage} stage */
const stagesOf = stage=>({ vertex: stage.stage === 'vertex', geometry: stage.stage === 'geometry',
    fragment: stage.stage === 'fragment', compute: stage.stage === 'compute' });

/**
 * @param {Stages} stages @param {(message: string) => void} error
 * @returns {StorageBlock[]}
 */
export function storageBlocksOf(stages, error){
    /** @type {StorageBlock[]} */
    const blocks = [];
    /** @type {Map<string, { info: import('./glsl-check.js').InterfaceBlock, first: number }>} */
    const byName = new Map();
    for (const stage of [stages.vertex, stages.geometry, stages.fragment, stages.compute])
    {
        if (!stage)
        {
            continue;
        }
        /** @type {import('./glsl-check.js').InterfaceBlock[]} */
        const read = [];
        for (const symbol of stage.globals)
        {
            const info = symbol.block;
            if (symbol.storage === 'buffer' && info && stage.uses.has(symbol.name)
                && !read.includes(info))
            {
                read.push(info);
            }
        }
        if (read.length === 0)
        {
            continue;
        }
        if (stage.stage !== 'fragment' && stage.stage !== 'compute')
        {
            error(`${stage.stage} shader: a shader storage block is used where this`
                + ' implementation has none (GL_MAX_*_SHADER_STORAGE_BLOCKS is 0 there)');
            continue;
        }
        if (read.reduce((n, info)=>n + (info.arrays[0] ?? 1), 0) > STORAGE_LIMITS.perStage)
        {
            error(`${stage.stage} shader: more than ${STORAGE_LIMITS.perStage} shader storage`
                + ' blocks');
        }
        for (const info of read)
        {
            const known = byName.get(info.name);
            if (known)
            {
                if (shapeOf(known.info) !== shapeOf(info))
                {
                    error(`shader storage block '${info.name}' is declared differently in two`
                        + ' shaders');
                    continue;
                }
                for (let k = 0; k < (known.info.arrays[0] ?? 1); k++)
                {
                    Object.assign(blocks[known.first + k].stages,
                        { [stage.stage]: true });
                }
                continue;
            }
            /** @type {'std140' | 'std430'} */
            const packing = info.layout.std430 ? 'std430' : 'std140';
            const laid = info.laid ?? blockLayout(info.members.map(m=>({ name: m.name,
                type: m.type, rowMajor: !!m.layout.row_major })), 'std140');
            const last = laid.members[laid.members.length - 1];
            const runtime = last && last.type.kind === 'array' && last.type.length === 0;
            const first = blocks.length;
            byName.set(info.name, { info, first });
            const count = info.arrays[0] ?? 1;
            const binding = typeof info.layout.binding === 'number' ? info.layout.binding : 0;
            for (let k = 0; k < count; k++)
            {
                blocks.push({
                    name: info.arrays.length > 0 ? `${info.name}[${k}]` : info.name,
                    blockName: info.name, element: k, instance: info.instance,
                    size: runtime ? last.offset : laid.size,
                    runtimeStride: runtime ? last.arrayStride ?? 0 : 0,
                    packing, members: laid.members, stages: stagesOf(stage),
                    binding: typeof info.layout.binding === 'number' ? binding + k : 0,
                });
            }
        }
    }
    if (blocks.length > STORAGE_LIMITS.combined)
    {
        error(`more than ${STORAGE_LIMITS.combined} shader storage blocks in a program`);
    }
    return blocks;
}

/**
 * An image uniform's element (4.2 section 8.27 of the language's 4.4.6).
 *
 * @typedef {Object} ImageUniform
 * @property {any} leaf  its uniform's leaf, whose store word is the unit
 * @property {number} element
 * @property {import('./glsl-types.js').ImageType} type
 * @property {string} format  the format qualifier, '' for none
 * @property {number} binding  the unit `layout(binding)` gives it
 * @property {boolean} readonly
 * @property {boolean} writeonly
 */

/**
 * What WebGPU lets a stage bind of what it writes: images in the fragment
 * and compute stages alone, at most IMAGE_LIMITS.perStage, and storage
 * buffers and counter buffers together at most 8 (maxStorageBuffersPerShaderStage).
 *
 * @param {Stages} stages @param {ImageUniform[]} images
 * @param {(message: string) => void} error
 */
export function checkImageStages(stages, images, error){
    for (const stage of [stages.vertex, stages.geometry, stages.fragment, stages.compute])
    {
        if (!stage)
        {
            continue;
        }
        const named = images.filter(image=>stage.uses.has(image.leaf.root));
        if (named.length > 0 && stage.stage !== 'fragment' && stage.stage !== 'compute')
        {
            error(`${stage.stage} shader: an image is used where this implementation has none`
                + ' (GL_MAX_*_IMAGE_UNIFORMS is 0 there)');
        }
        if (named.length > IMAGE_LIMITS.perStage)
        {
            error(`${stage.stage} shader: more than ${IMAGE_LIMITS.perStage} image uniforms`);
        }
    }
}

/**
 * @param {Stages} stages @param {(message: string) => void} error
 * @returns {AtomicCounter[]}
 */
export function atomicCountersOf(stages, error){
    /** @type {AtomicCounter[]} */
    const counters = [];
    for (const stage of [stages.vertex, stages.geometry, stages.fragment, stages.compute])
    {
        if (!stage)
        {
            continue;
        }
        /** The next free offset of each binding, in this stage's declaration order. */
        /** @type {Map<number, number>} */
        const next = new Map();
        let here = 0;
        for (const symbol of stage.globals)
        {
            const type = symbol.type;
            const element = type.kind === 'array' ? type.element : type;
            if (symbol.storage !== 'uniform' || element.kind !== 'atomic')
            {
                continue;
            }
            const layout = /** @type {Record<string, any>} */ (symbol.qualifiers?.layout ?? {});
            const binding = typeof layout.binding === 'number' ? layout.binding : 0;
            const offset = typeof layout.offset === 'number' ? layout.offset
                : next.get(binding) ?? 0;
            const count = type.kind === 'array' ? type.length : 1;
            next.set(binding, offset + 4 * count);
            if (!stage.uses.has(symbol.name))
            {
                continue;
            }
            if (stage.stage !== 'fragment' && stage.stage !== 'compute')
            {
                error(`${stage.stage} shader: an atomic counter is used where this`
                    + ' implementation has none (GL_MAX_*_ATOMIC_COUNTERS is 0 there)');
                continue;
            }
            if (binding >= COUNTER_LIMITS.bindings || offset % 4 !== 0)
            {
                error(`atomic counter '${symbol.name}': binding ${binding} offset ${offset} is`
                    + ' past GL_MAX_ATOMIC_COUNTER_BUFFER_BINDINGS or not a multiple of 4');
                continue;
            }
            here += count;
            const known = counters.find(c=>c.name === symbol.name);
            if (known)
            {
                if (known.binding !== binding || known.offset !== offset || known.count !== count)
                {
                    error(`atomic counter '${symbol.name}' is declared differently in two`
                        + ' shaders');
                }
                Object.assign(known.stages, { [stage.stage]: true });
                continue;
            }
            if (counters.some(c=>c.binding === binding && c.offset < offset + 4 * count
                && offset < c.offset + 4 * c.count))
            {
                error(`atomic counter '${symbol.name}' overlaps another on binding ${binding}`);
            }
            counters.push({ name: symbol.name, binding, offset, count,
                stages: stagesOf(stage) });
        }
        if (here > COUNTER_LIMITS.perStage)
        {
            error(`${stage.stage} shader: more than ${COUNTER_LIMITS.perStage} atomic counters`);
        }
    }
    return counters;
}
